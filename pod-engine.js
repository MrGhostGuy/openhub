/**
 * pod-engine.js — Autonomous Print-on-Demand venture engine for Openhub.
 *
 * Two real sub-agents cooperate on a scheduled loop (multiple times per day):
 *
 *   1. RESEARCH agent
 *      - Pulls live trend signals from Reddit POD / Etsy-seller communities
 *        (real, reachable data) plus any configured trend source.
 *      - Synthesizes, via LLM (OpenRouter), the top-selling design themes and
 *        the easiest/highest-demand product types per niche.
 *
 *   2. MAKER agent
 *      - Turns each researched theme into a concrete design: title + a detailed
 *        image-generation prompt + target product type (LLM).
 *      - Generates the actual artwork via an image API (OpenAI DALL·E or
 *        Stability) when a key is present, saving a real PNG.
 *      - Pushes the product to Printify (real API) and publishes it to the
 *        connected Etsy shop when a Printify token is present.
 *
 * Everything degrades gracefully: missing keys simply skip the steps that need
 * them (e.g. research still runs, designs are still specced, but products are
 * only created once Printify + an image key exist). Nothing crashes the server.
 *
 * All data is persisted to the SQLite DB (pod_research / pod_designs /
 * pod_products). No mock revenue is ever generated.
 */
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const dbMod = require('./database');

const POD_DIR = path.join(__dirname, 'pod_assets');
const RESEARCH_SUB = 'POD-Research';
const MAKER_SUB = 'POD-Maker';

const CFG = {
  niches: (process.env.POD_NICHES || 'mug,t-shirt,sticker,tote bag,cat,funny,sarcastic').split(',').map(s => s.trim()).filter(Boolean),
  intervalMs: parseInt(process.env.POD_INTERVAL_MS || '10800000', 10), // 3h default
  llmModel: process.env.POD_LLM_MODEL || 'google/gemini-2.0-flash-lite-001',
  storePlatform: (process.env.POD_STORE_PLATFORM || 'shopify').toLowerCase(), // 'shopify' | 'etsy'
  printifyToken: process.env.PRINTIFY_API_TOKEN || '',
  printifyShopId: process.env.PRINTIFY_SHOP_ID || '',
  openaiKey: process.env.OPENAI_API_KEY || '',
  stabilityKey: process.env.STABILITY_API_KEY || '',
  etsyToken: process.env.ETSY_API_KEY || '',
  // Ideogram 4 — best-in-class text rendering (the fix for unreadable designs).
  ideogramKey: process.env.IDEOGRAM_API_KEY || '',
  // Google Gemini direct API (free tier, no credit card) — primary LLM when set.
  geminiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite',
  // Optional Pollinations API key: raises rate limits + removes watermark.
  pollinationsKey: process.env.POLLINATIONS_API_KEY || '',
  // Force a specific free Pollinations model (e.g. 'gptimage','flux','turbo').
  // Empty = default chain [gptimage, flux].
  imageModel: process.env.POD_IMAGE_MODEL || '',
  maxDesignsPerCycle: Math.max(1, parseInt(process.env.POD_MAX_DESIGNS || '7', 10)),
  // Hard cap on NEW products pushed to Shopify per calendar day.
  dailyCap: Math.max(1, parseInt(process.env.POD_DAILY_CAP || '7', 10)),
  redditSubs: (process.env.POD_REDDIT_SUBS || 'shopify,ecommerce,printondemand,EtsySellers,redbubble,POD,dropship').split(',').map(s => s.trim()).filter(Boolean),
};

let timer = null;
let running = false;

// ---- DB helpers -----------------------------------------------------------
function getDb() { return dbMod.getDb(); }
function persist() { try { dbMod.persist(); } catch (e) {} }

function q(sql, params = []) {
  const d = getDb();
  const rows = d.exec(sql, params);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(v => { const o = {}; cols.forEach((c, i) => o[c] = v[i]); return o; });
}

// Network helper with a hard timeout so a slow/free API can never hang the cycle.
// Optional retries with exponential backoff + jitter — used to survive free-tier
// 429 rate limits (e.g. Pollinations anonymous tier ~1 req / 15s).
async function fetchWithTimeout(url, opts = {}, ms = 30000, retries = 0) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      // Retry on rate-limit / transient server errors
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const wait = Math.min(30000, (500 * Math.pow(2, attempt)) + Math.random() * 400);
        await new Promise(r => setTimeout(r, wait));
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        const wait = Math.min(30000, (500 * Math.pow(2, attempt)) + Math.random() * 400);
        await new Promise(r => setTimeout(r, wait));
      }
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr || new Error('request failed');
}
function run(sql, params = []) { getDb().run(sql, params); persist(); }

// Shared Pollinations throttle (defined in database.js so both engines
// serialize through one stream and never collide on the free rate limit).
function pollQueue() {
  return dbMod.pollinationsThrottle(!!CFG.pollinationsKey);
}

// ---- Logging / broadcast --------------------------------------------------
function log(agent, action, detail, category = 'pod') {
  try { dbMod.addActivityLog(agent, action, detail, category); } catch (e) {}
  if (global.__broadcast) {
    global.__broadcast({ type: 'pod_log', agent, action, detail, category, ts: Date.now() });
  }
}
function note(title, message, type = 'info') {
  try { dbMod.addNotification(title, message, type, 'POD'); } catch (e) {}
  if (global.__broadcast) global.__broadcast({ type: 'notification_new', notification: { title, message, type, agent_name: 'POD', timestamp: new Date().toISOString() } });
}

// --- Register + track the two POD sub-agents as real, observable agents ---
function ensurePodAgents() {
  try {
    dbMod.ensureAgent(RESEARCH_SUB, { role: 'POD Research Analyst', avatar: '🔬', kind: 'subagent', status: 'idle', current_task: 'Standing by for next research cycle' });
    dbMod.ensureAgent(MAKER_SUB, { role: 'POD Design & Publishing', avatar: '🎨', kind: 'subagent', status: 'idle', current_task: 'Standing by for next maker cycle' });
  } catch (e) {}
}
function markAgent(name, status, task) {
  try { dbMod.touchAgent(name, { status, current_task: task || '' }); } catch (e) {}
}

// ---- Free LLM (Pollinations text API — no key required) ------------------
async function pollinationsText(prompt) {
  await pollQueue();
  const key = CFG.pollinationsKey ? `&token=${encodeURIComponent(CFG.pollinationsKey)}` : '';
  const url = `https://text.pollinations.ai/${encodeURIComponent(prompt)}?model=openai&seed=${Math.floor(Math.random() * 1e6)}${key}`;
  const r = await fetchWithTimeout(url, {}, 60000, 4);
  if (!r.ok) throw new Error(`Pollinations text ${r.status}`);
  return (await r.text()).trim();
}

// ---- Google Gemini direct API (free tier, no credit card) -----------------
async function geminiText(system, user, maxTokens = 900) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CFG.geminiModel}:generateContent?key=${CFG.geminiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
  };
  const res = await fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 45000, 2);
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const j = await res.json();
  const t = j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (t) return t.trim();
  throw new Error('Gemini empty');
}

// ---- LLM (Gemini > OpenAI > OpenRouter > FREE Pollinations) ---------------
async function llm(system, user, maxTokens = 900) {
  const combined = `${system}\n\n${user}`;
  if (CFG.geminiKey) {
    try { return await geminiText(system, user, maxTokens); } catch (e) { /* fall through */ }
  }
  if (process.env.OPENAI_API_KEY) {
    try {
      const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: process.env.POD_LLM_MODEL && process.env.POD_LLM_MODEL.startsWith('gpt') ? process.env.POD_LLM_MODEL : 'gpt-4o-mini',
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          max_tokens: maxTokens, temperature: 0.7,
        }),
      }, 45000);
      if (!res.ok) throw new Error(`OpenAI ${res.status}`);
      const j = await res.json();
      const t = j.choices?.[0]?.message?.content || '';
      if (t) return t;
    } catch (e) { /* fall through */ }
  }
  if (process.env.OPENROUTER_API_KEY) {
    // Try the configured model, then a couple of reliable free models.
    const models = [CFG.llmModel, 'tencent/hy3:free', 'google/gemini-3.5-flash:free', 'meta-llama/llama-3.1-8b-instruct:free'];
    for (const m of models) {
      try {
        const res = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
          body: JSON.stringify({ model: m, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, temperature: 0.7 }),
        }, 30000);
        if (!res.ok) continue;
        const j = await res.json();
        const t = j.choices?.[0]?.message?.content || '';
        if (t) return t;
      } catch (e) { /* try next model */ }
    }
  }
  // Free fallback — no key needed (also catches dead paid keys above)
  return pollinationsText(combined);
}
function extractJson(text) {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  } catch {}
  try { return JSON.parse(text); } catch {}
  return null;
}

// ---- RESEARCH agent -------------------------------------------------------
async function gatherRedditSignals() {
  const out = [];
  for (const sub of CFG.redditSubs) {
    for (const niche of CFG.niches) {
      try {
        const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(niche)}&restrict_sr=1&sort=top&t=month&limit=15`;
        const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'OpenhubPOD/1.0' } }, 15000);
        if (!r.ok) continue;
        const j = await r.json();
        for (const c of (j.data?.children || [])) {
          const d = c.data || {};
          const txt = `${d.title || ''} ${d.selftext ? d.selftext.slice(0, 200) : ''}`.trim();
          if (txt) out.push({ sub, niche, text: txt });
        }
      } catch (e) { /* skip unreachable sub */ }
    }
  }
  return out;
}

async function researchOnce(seedText = '') {
  markAgent(RESEARCH_SUB, 'working', 'Scanning Reddit + trend communities for winning themes');
  log(RESEARCH_SUB, 'research_start', `Scanning ${CFG.niches.length} niches across ${CFG.redditSubs.length} communities`, 'pod');
  const signals = await gatherRedditSignals();
  const corpus = signals.map(s => `[${s.sub}|${s.niche}] ${s.text}`).join('\n').slice(0, 6000);
  const extra = seedText ? `\n\nSEED INTEL (curated by operator):\n${seedText.slice(0, 3000)}` : '';

  const system = `You are the lead research analyst for a print-on-demand storefront on SHOPIFY, fulfilled by Printify. Your job is to find Shopify stores and sellers that are doing exceptionally well RIGHT NOW (today) and figure out exactly which products and designs are driving their sales. You are commercial, specific, and biased toward action. Output ONLY valid JSON.`;
  const user = `Here is real community chatter from Shopify / e-commerce / POD seller communities (niche + post):

${corpus || '(no live signals available)'}${extra}

Context: I run a Shopify POD store (mugs, t-shirts, stickers, tote bags) fulfilled by Printify, and I want to win NEW customers and generate real SALES today.

For each of these niches — ${CFG.niches.join(', ')} — determine:
 1) The TOP-SELLING design themes among successful Shopify POD sellers TODAY
 2) The product types (mug, t-shirt, sticker, tote bag, etc.) those sellers are having the most success with
 3) EXACTLY which design should go on which product TODAY to maximize my store's chance of making sales

Return JSON exactly in this shape:
{
  "analyses": [
    { "niche": "mug", "themes": ["theme1","theme2","theme3"], "productTypes": ["mug","sticker"], "examples": ["example design idea 1","example design idea 2"], "rationale": "why these sell on Shopify now" }
  ],
  "dailyPlan": [
    { "niche": "mug", "theme": "one specific winning theme", "product_type": "mug", "design_hint": "concrete description of the artwork to generate (style, colors, text, composition)", "rationale": "why this specific design on this specific product will sell today" }
  ],
  "overallTop": ["most promising theme/angle across all niches today"],
  "notes": "brief Shopify growth strategy note (how to attract new customers)"
}`;

  let analysis = { analyses: CFG.niches.map(n => ({ niche: n, themes: [n + ' quote designs'], productTypes: [n], examples: [], rationale: '' })), dailyPlan: [], overallTop: [], notes: 'LLM unavailable; used fallback.' };
  try {
    const raw = await llm(system, user, 1600);
    const parsed = extractJson(raw);
    if (parsed && Array.isArray(parsed.analyses)) analysis = { ...analysis, ...parsed };
    log(RESEARCH_SUB, 'research_done', `Shopify research: ${analysis.analyses.length} niches, ${(analysis.dailyPlan || []).length} daily-plan items (${signals.length} live signals)`, 'pod');
  } catch (e) {
    log(RESEARCH_SUB, 'research_warn', `LLM synthesis failed (${e.message}); using fallback analysis`, 'pod');
    markAgent(RESEARCH_SUB, 'idle', 'Research done (fallback) — awaiting next cycle');
  }

  // Persist a research row per niche
  for (const a of analysis.analyses) {
    run(`INSERT INTO pod_research (niche, themes, product_types, rationale, source) VALUES (?,?,?,?,?)`,
      [a.niche || 'general', JSON.stringify(a.themes || []), JSON.stringify(a.productTypes || []), a.rationale || '', `reddit:${signals.length}`]);
  }
  // Persist the day's Shopify plan so the maker agent acts on it
  const plan = (analysis.dailyPlan || []).map(p => ({
    niche: p.niche || 'general',
    theme: p.theme || '',
    product_type: p.product_type || '',
    design_hint: p.design_hint || '',
    rationale: p.rationale || '',
  }));
  if (plan.length) { dbMod.saveDailyPlan(plan); log(RESEARCH_SUB, 'daily_plan', `Saved ${plan.length} Shopify design→product assignments for today`, 'pod'); }

  note('POD Research Complete', `Researched Shopify sellers across ${analysis.analyses.length} niches from ${signals.length} live signals.`, 'success');
  markAgent(RESEARCH_SUB, 'idle', 'Research complete — awaiting next cycle');
  if (global.__broadcast) global.__broadcast({ type: 'pod_research', analyses: analysis.analyses, ts: Date.now() });
  return analysis;
}

// ---- Top-seller intelligence (variations on what's already selling) ------
// Pulls the operator's REAL published products from Printify so the research
// agent can spin design VARIATIONS of proven winners (the fastest path to
// more sales on Shopify).
async function getLiveProducts() {
  if (!CFG.printifyToken) return [];
  try {
    const shopId = await resolveShopId();
    if (!shopId) return [];
    const res = await printifyReq('GET', `/v1/shops/${shopId}/products.json?limit=50`);
    const list = (res && res.data) || [];
    return list.map(p => ({
      id: p.id,
      title: p.title || '',
      // Printify stores a "total_sales"/"sales" hint on some shops; default 0
      sales: Number(p.total_sales || p.sales || 0) || 0,
      images: (p.images || []).map(i => i.src || '').filter(Boolean),
    }));
  } catch (e) {
    log(RESEARCH_SUB, 'live_products_error', `Could not read Printify products: ${e.message}`, 'pod');
    return [];
  }
}

// Spin new design variations based on the operator's currently top-selling products.
async function researchVariationsOnTopSellers() {
  const live = await getLiveProducts();
  // Best sellers first (those with reported sales); fall back to all live products
  const top = live.filter(p => p.sales > 0).sort((a, b) => b.sales - a.sales).slice(0, 8);
  const pool = (top.length ? top : live).slice(0, 12);
  if (!pool.length) {
    log(RESEARCH_SUB, 'variation_skip', 'No live products yet — publish a few first, then I can spin variations.', 'pod');
    return [];
  }
  markAgent(RESEARCH_SUB, 'working', `Studying ${pool.length} live product(s) to spin winning variations`);
  const catalog = pool.map(p => `- "${p.title}" (sales: ${p.sales})`).join('\n');
  const system = `You are the lead growth designer for a Shopify POD store fulfilled by Printify. The operator already has products live. Your ONLY job: invent NEW design variations that riff on the TOP-SELLING products so the store captures more of the same demand. Original concepts only (no copyrighted text/logos). Output ONLY valid JSON.`;
  const user = `These are the operator's live Shopify products (best sellers first):\n${catalog}\n\nFor the 3-5 strongest sellers, propose design VARIATIONS that would appeal to the same buyers — different colors, slogans, angles, occasions, or sub-niches. Each variation becomes a new product.\n\nReturn JSON:\n{\n  "variations": [\n    { "based_on": "title of the source product", "niche": "mug", "theme": "winning variation angle", "product_type": "mug", "design_hint": "concrete artwork description to generate", "rationale": "why this variation will sell to the same audience" }\n  ]\n}`;
  let variations = [];
  try {
    const raw = await llm(system, user, 1600);
    let parsed = extractJson(raw);
    // Tolerant fallback: if the model returned a bare array or prose, repair it
    if (!parsed || !Array.isArray(parsed.variations)) {
      try {
        const arrMatch = raw.match(/\[[\s\S]*\]/);
        if (arrMatch) parsed = { variations: JSON.parse(arrMatch[0]) };
      } catch {}
      if (!parsed || !Array.isArray(parsed.variations)) {
        // Last resort: pull any "title"/"theme" lines into a single variation set
        parsed = { variations: pool.slice(0, 3).map(p => ({ based_on: p.title, niche: 'general', theme: 'popular variation', product_type: '', design_hint: `new colorway / slogan variation of "${p.title}"`, rationale: 'repeat proven demand with a fresh angle' })) };
      }
    }
    variations = (parsed && Array.isArray(parsed.variations)) ? parsed.variations : [];
    log(RESEARCH_SUB, 'variation_plan', `Generated ${variations.length} variation design(s) from top sellers`, 'pod');
  } catch (e) {
    log(RESEARCH_SUB, 'variation_warn', `Variation synthesis failed: ${e.message}`, 'pod');
  }
  const plan = variations.map(v => ({
    niche: v.niche || 'general',
    theme: v.theme || '',
    product_type: v.product_type || '',
    design_hint: v.design_hint || '',
    rationale: `Variation of "${v.based_on || ''}": ${v.rationale || ''}`,
  }));
  if (plan.length) { dbMod.saveDailyPlan(plan); log(RESEARCH_SUB, 'daily_plan', `Saved ${plan.length} top-seller variation design(s) for today`, 'pod'); }
  return plan;
}

// ---- Top-trending product research (past couple days) ----------------------
// Asks the research agent for ~10 concrete, currently-trending best-sellers that
// real customers are buying RIGHT NOW, then the maker turns them into products.
async function researchTopSellers() {
  const signals = await gatherRedditSignals();
  const corpus = signals.map(s => `[${s.sub}|${s.niche}] ${s.text}`).join('\n').slice(0, 5000);
  markAgent(RESEARCH_SUB, 'working', 'Researching top-selling products trending over the past couple days');
  const system = `You are the lead trend buyer-intelligence analyst for a Shopify print-on-demand store fulfilled by Printify. Your job is to identify the products that REAL customers have been buying most over the PAST COUPLE OF DAYS (recent, hot demand) so the store can publish exactly what is selling. You are commercial, specific, and biased toward action. Output ONLY valid JSON.`;
  const user = `Real community chatter from Shopify / e-commerce / POD seller communities (niche + post):
${corpus || '(no live signals available)'}

I run a Shopify POD store (mugs, t-shirts, stickers, tote bags, hoodies) fulfilled by Printify. I want to publish 12 NEW products that customers actually want to BUY right now, based on what has been trending/selling best over the past 48-72 hours.

  Return JSON exactly:
  {
    "products": [
      { "niche": "mug", "theme": "specific winning theme trending now", "product_type": "mug", "design_hint": "concrete artwork description — clean graphic, MINIMAL OR NO TEXT (avoid quotes/slogans/captions; if any text, at most 1 short word), style/colors/composition", "rationale": "why this is selling well right now" }
    ]
  }
  Provide exactly 12 products. Vary the product types. Focus on proven demand, not guesses.`;
  let products = [];
  try {
    const raw = await llm(system, user, 1800);
    const parsed = extractJson(raw);
    products = (parsed && Array.isArray(parsed.products)) ? parsed.products : [];
    log(RESEARCH_SUB, 'topseller_research', `Identified ${products.length} trending products from the past couple days`, 'pod');
  } catch (e) {
    log(RESEARCH_SUB, 'topseller_warn', `Top-seller synthesis failed: ${e.message}`, 'pod');
  }
  // Persist as today's plan so the maker acts on exactly these.
  const plan = products.map(p => ({
    niche: p.niche || 'general',
    theme: p.theme || '',
    product_type: p.product_type || '',
    design_hint: p.design_hint || '',
    rationale: p.rationale || '',
  }));
  if (plan.length) { dbMod.saveDailyPlan(plan); log(RESEARCH_SUB, 'daily_plan', `Saved ${plan.length} trending products to make today`, 'pod'); }
  markAgent(RESEARCH_SUB, 'idle', 'Top-seller research complete — awaiting next cycle');
  return plan;
}

// Generate ~10 new trending products end-to-end (research → design → publish).
async function cycleTopProducts() {
  if (running) return;
  running = true;
  ensurePodAgents();
  try {
    await researchTopSellers();
    await makeDesigns(12, true); // makeDesigns pulls the freshly saved daily plan; produce all 12
    if (CFG.printifyToken) await publishPendingDesigns();
    note('POD Trend Drop', 'Researched top-selling products from the past couple days and pushed new designs to Printify → Shopify.', 'success');
    if (global.__broadcast) global.__broadcast({ type: 'pod_update', ts: Date.now() });
  } catch (e) {
    log('POD', 'top_products_error', e.message, 'pod');
  } finally {
    running = false;
  }
}

// ---- MAKER agent ----------------------------------------------------------
function latestResearch() {
  // one row per niche, most recent
  return q(`SELECT r.* FROM pod_research r
    WHERE r.id = (SELECT MAX(r2.id) FROM pod_research r2 WHERE r2.niche = r.niche)
    ORDER BY r.id DESC LIMIT 50`);
}

async function designSpec(themeEntry) {
  const system = `You are a senior print-on-demand designer for a SHOPIFY store fulfilled by Printify. Given a niche, winning themes, and product types, you output ONE concrete, sellable design as strict JSON. Keep concepts original (no copyrighted text/logos).

CRITICAL QUALITY RULES for the artwork:
- AVOID putting text on the design. No quotes, no slogans, no long phrases, no fine print. If any text is used it must be at most 1-2 SHORT words (e.g. a single word), large and legible.
- Prefer clean, graphic, illustrative artwork with little or no wording — this reads better at small sizes and keeps quality high.
- No quotation marks, apostrophes, or special characters in the artwork concept.`;
  const user = `Niche: ${themeEntry.niche}
Themes: ${(themeEntry.themes || []).join(', ')}
Product types: ${(themeEntry.productTypes || []).join(', ')}
Examples: ${(themeEntry.examples || []).join(' | ')}

Create ONE design. Keep the artwork mostly text-free and high quality.
Return JSON exactly:
{
  "title": "SEO-friendly Shopify listing title (<= 120 chars, no quotation marks)",
  "productType": "single best product type from the list (e.g. mug, t-shirt, sticker, tote bag)",
  "prompt": "detailed, comma-separated image-generation prompt for the artwork. Describe a clean graphic/illustrative design with NO or minimal text (max 1-2 short words if any). No quotes or slogans. Style, colors, composition.",
  "tags": ["shopify","tag1","tag2"],
  "description": "short product description for the Shopify listing"
}`;
  const raw = await llm(system, user, 600);
  const p = extractJson(raw);
  if (!p || !p.title) {
    // Tolerant fallback: still produce a valid design from the theme
    const theme = (themeEntry.themes && themeEntry.themes[0]) || themeEntry.niche;
    return sanitizeSpec({
      title: `${theme} ${themeEntry.niche}`.trim().slice(0, 118),
      productType: (themeEntry.productTypes && themeEntry.productTypes[0]) || themeEntry.niche,
      prompt: `${theme}, ${themeEntry.niche} design, clean graphic illustration, minimal text, centered, high contrast, bold, suitable for print on demand`,
      tags: [themeEntry.niche, theme],
      description: `A ${theme} themed ${themeEntry.niche} product.`,
    });
  }
  return sanitizeSpec(p);
}

// Strip quotes / limit wording from generated design copy so artwork stays clean & high-quality.
function sanitizeSpec(p) {
  if (!p) return p;
  const strip = (s) => String(s || '').replace(/[""'′`]/g, '').replace(/\s+/g, ' ').trim();
  if (p.title) p.title = strip(p.title).slice(0, 120);
  if (p.description) p.description = strip(p.description).slice(0, 240);
  if (p.prompt) {
    // Remove any quoted phrases from the image prompt and discourage long text.
    p.prompt = strip(p.prompt).replace(/\bquote[s]?\b/gi, '').replace(/\bwith text\b/gi, 'clean graphic').slice(0, 600);
  }
  if (Array.isArray(p.tags)) p.tags = p.tags.map(t => strip(t)).filter(Boolean).slice(0, 8);
  return p;
}

async function generateImage(prompt, outPath) {
  // 0) Ideogram 4 — best-in-class text rendering (fixes unreadable designs).
  //    Uses the free hosted API when IDEOGRAM_API_KEY is set.
  if (CFG.ideogramKey) {
    try {
      const res = await fetchWithTimeout('https://api.ideogram.ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Api-Key': CFG.ideogramKey },
        body: JSON.stringify({
          image_request: {
            prompt: prompt.slice(0, 4000),
            model: 'V_2',
            aspect_ratio: 'ASPECT_1_1',
            magic_prompt_option: 'AUTO',
          },
        }),
      }, 60000);
      if (res.ok) {
        const j = await res.json();
        const url = j?.data?.[0]?.url;
        if (url) {
          const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
          if (buf && buf.length > 2000) { fs.writeFileSync(outPath, buf); return { ok: true, path: outPath, contentType: 'image/png' }; }
        }
      }
    } catch (e) { /* fall through to next provider */ }
  }
  // 1) OpenAI DALL·E (paid, best quality)
  if (CFG.openaiKey) {
    try {
      const res = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CFG.openaiKey}` },
        body: JSON.stringify({ model: 'dall-e-3', prompt: prompt.slice(0, 4000), n: 1, size: '1024x1024', quality: 'standard' }),
      });
      if (res.ok) {
        const j = await res.json();
        const url = j.data?.[0]?.url || j.data?.[0]?.b64_json;
        let buf;
        if (url && url.startsWith('http')) buf = Buffer.from(await (await fetch(url)).arrayBuffer());
        else if (j.data?.[0]?.b64_json) buf = Buffer.from(j.data[0].b64_json, 'base64');
        if (buf) { fs.writeFileSync(outPath, buf); return { ok: true, path: outPath, contentType: 'image/png' }; }
      }
    } catch (e) { /* fall through to next provider */ }
  }
  // 2) Stability AI (paid)
  if (CFG.stabilityKey) {
    try {
      const res = await fetch('https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CFG.stabilityKey}`, 'Accept': 'application/json' },
        body: JSON.stringify({ text_prompts: [{ text: prompt.slice(0, 4000), weight: 1 }], cfg_scale: 7, height: 1024, width: 1024, samples: 1, steps: 30 }),
      });
      if (res.ok) {
        const j = await res.json();
        const b64 = j.artifacts?.[0]?.base64;
        if (b64) { fs.writeFileSync(outPath, Buffer.from(b64, 'base64')); return { ok: true, path: outPath, contentType: 'image/png' }; }
      }
    } catch (e) { /* fall through */ }
  }
  // 3) Pollinations — FREE, no key required. Primary free model is `gptimage`
  //    (GPT-Image class): far better prompt fidelity + readable text than FLUX,
  //    which matters for merch with slogans. FLUX is kept as a fast fallback.
  const pollinationsModels = CFG.imageModel ? [CFG.imageModel, 'gptimage', 'flux'] : ['gptimage', 'flux'];
  const key = CFG.pollinationsKey ? `&token=${encodeURIComponent(CFG.pollinationsKey)}` : '';
  for (const model of pollinationsModels) {
    try {
      await pollQueue(); // space out free-tier calls to avoid 429
      const p = encodeURIComponent(`${prompt.slice(0, 1500)}, clean centered composition, high contrast, suitable for printing on merchandise`);
      const url = `https://image.pollinations.ai/prompt/${p}?width=1024&height=1024&nologo=true&model=${model}&seed=${Math.floor(Math.random() * 1e6)}${key}`;
      const res = await fetchWithTimeout(url, {}, 90000, 4); // retry on 429/5xx
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf && buf.length > 2000) {
          fs.writeFileSync(outPath, buf);
          return { ok: true, path: outPath, contentType: res.headers.get('content-type') || 'image/jpeg' };
        }
      }
    } catch (e) { /* try next model */ }
  }
  return { ok: false };
}

// ---- Printify client (real, gated on token) -------------------------------
async function printifyReq(method, urlPath, body) {
  const res = await fetchWithTimeout(`https://api.printify.com${urlPath}`, {
    method,
    headers: { 'Authorization': `Bearer ${CFG.printifyToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }, 30000);
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`Printify ${res.status}: ${text.slice(0, 160)}`);
  return j;
}

async function resolveShopId() {
  if (CFG.printifyShopId) return CFG.printifyShopId;
  const shops = await printifyReq('GET', '/v1/shops.json');
  const id = shops?.[0]?.id;
  if (id) CFG.printifyShopId = String(id);
  return CFG.printifyShopId;
}

async function uploadPrintifyImage(filePath, contentType = 'image/png') {
  // Printify image upload: JSON body with base64 `contents` + `file_name`.
  const b64 = fs.readFileSync(filePath).toString('base64');
  const ext = (contentType.includes('jpeg') || contentType.includes('jpg')) ? 'jpg' : 'png';
  const fname = `design.${ext}`;
  const res = await fetchWithTimeout('https://api.printify.com/v1/uploads/images.json', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${CFG.printifyToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_name: fname, contents: b64 }),
  }, 30000);
  const j = await res.json();
  if (!res.ok || !j.id) throw new Error(`upload ${res.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return j.id;
}

const BLUEPRINT_ALIASES = {
  't-shirt': 'tee', 'tshirt': 'tee', 'shirt': 'tee', 'tee': 'tee',
  'mug': 'mug', 'coffee mug': 'mug', 'sticker': 'sticker', 'decal': 'sticker',
  'tote bag': 'tote', 'tote': 'tote', 'bag': 'tote',
  'hoodie': 'hoodie', 'sweatshirt': 'hoodie',
  'phone case': 'phone', 'phone': 'phone', 'pillow': 'pillow',
  'poster': 'poster', 'canvas': 'canvas', 'hat': 'hat', 'cap': 'hat',
  'cat': 'tshirt', 'funny': 'tshirt', 'sarcastic': 'mug', 'quote': 'mug',
  'cute': 'sticker', 'gift': 'mug', 'coffee': 'mug', 'pet': 'tshirt',
};
// Map any research niche / loose product_type onto a real, printable blueprint.
// Unmapped values default to a safe, always-valid product (t-shirt).
function normalizeProductType(pt) {
  if (!pt) return 'tshirt';
  const k = String(pt).toLowerCase().trim();
  if (BLUEPRINT_ALIASES[k]) return BLUEPRINT_ALIASES[k];
  // partial match against known types
  for (const key of Object.keys(BLUEPRINT_ALIASES)) {
    if (k.includes(key) || key.includes(k)) return BLUEPRINT_ALIASES[key];
  }
  return 'tshirt';
}
// Competitive, margin-aware pricing per product type (cents).
// Base = realistic Printify production cost; we keystone ~2.2x and cap the
// ceiling so the listing undercuts typical Etsy/Shopify POD competitors while
// staying profitable. Prices chosen from common buyer-friendly price points.
const BASE_COST = { // approx Printify production cost in cents
  mug: 850, tshirt: 1050, sticker: 200, tote: 900, hoodie: 2200,
  phone: 1400, pillow: 1300, poster: 700, canvas: 1500, hat: 1300,
};
const PRICE_CEIL = { // buyer-friendly ceiling (cents)
  mug: 1899, tshirt: 2499, sticker: 599, tote: 1999, hoodie: 4499,
  phone: 3499, pillow: 2999, poster: 1999, canvas: 3999, hat: 2999,
};
function competitivePrice(productType) {
  const pt = (productType || '').toLowerCase();
  const cost = BASE_COST[pt] || 1000;
  const ceil = PRICE_CEIL[pt] || 2499;
  const keystone = Math.round(cost * 2.2 / 100) * 100; // round to nearest $1
  return Math.min(ceil, Math.max(keystone, cost + 500)); // never sell at a loss
}

// --- Daily publishing cap (6-7 high-demand products/day) -------------------
function todayKey() {
  // Match SQLite datetime('now') which is UTC: YYYY-MM-DD HH:MM:SS
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
// Returns how many NEW products have been pushed (published/created) today.
function publishedTodayCount() {
  const key = todayKey();
  const rows = q(`SELECT COUNT(*) AS c FROM pod_products WHERE created_at LIKE '${key}%'`);
  return rows[0]?.c || 0;
}
function dailyCapReached() {
  return publishedTodayCount() >= CFG.dailyCap;
}

async function findBlueprint(productType) {  const bps = await printifyReq('GET', '/v1/catalog/blueprints.json');
  const list = bps || [];
  const kw = (BLUEPRINT_ALIASES[(productType || '').toLowerCase()] || (productType || '')).toLowerCase();
  const words = kw.split(/[\s-]+/).filter(w => w.length > 2);
  let match = list.find(b => (b.title || '').toLowerCase().includes(kw));
  if (!match && words.length) match = list.find(b => words.some(w => (b.title || '').toLowerCase().includes(w)));
  if (!match) match = list[0];
  // print providers for this blueprint
  const provs = await printifyReq('GET', `/v1/catalog/blueprints/${match.id}/print_providers.json`);
  const providerId = (provs && provs[0] && provs[0].id) || (provs && provs.id);
  return { blueprintId: match.id, providerId, title: match.title };
}

async function createPrintifyProduct(spec, imagePath, contentType = 'image/png') {
  const shopId = await resolveShopId();
  if (!shopId) throw new Error('no Printify shop');
  const imageId = await uploadPrintifyImage(imagePath, contentType);
  const bp = await findBlueprint(spec.productType);
  // Real variants for this blueprint + print provider
  const varRes = await printifyReq('GET', `/v1/catalog/blueprints/${bp.blueprintId}/print_providers/${bp.providerId}/variants.json`);
  const allVariants = (varRes && varRes.variants) || [];
  const variantIds = allVariants.map(v => v.id);
  // Competitive pricing: keystone over a realistic POD base cost, capped to a
  // buyer-friendly ceiling so the listing wins the "Add to cart" vs competitors.
  const price = competitivePrice(spec.productType);
  const variants = allVariants.map(v => ({ id: v.id, price, is_enabled: true }));
  // Printify accepts a couple of valid print_area shapes depending on the
  // blueprint; try each until one is accepted so no design is lost to a 422.
  const printAreaShapes = [
    [{ variant_ids: variantIds, placeholders: [{ position: 'front', background: imageId, images: [{ id: imageId, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }] }],
    [{ variant_ids: variantIds, background: imageId, images: [{ position: 'front', id: imageId, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }],
    [{ variant_ids: variantIds, background: imageId, placeholders: [{ position: 'front', images: [{ id: imageId, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }] }],
  ];
  let created = null, lastErr = null;
  for (const pa of printAreaShapes) {
    try {
      const product = {
        blueprint_id: bp.blueprintId,
        print_provider_id: bp.providerId,
        title: spec.title.slice(0, 120),
        description: spec.description || spec.title,
        variants,
        print_areas: pa,
        tags: spec.tags || [],
      };
      created = await printifyReq('POST', `/v1/shops/${shopId}/products.json`, product);
      break;
    } catch (e) { lastErr = e; /* try next shape */ }
  }
  if (!created) throw lastErr || new Error('all print_area shapes rejected');
  const pid = created.id;
  markAgent(MAKER_SUB, 'working', `Publishing "${spec.title}" to Printify → ${CFG.storePlatform}`);
  // Publish to whichever store is connected inside Printify (Shopify, Etsy, Woo, etc.)
  let pubStatus = 'created';
  try {
    const publishBody = {
      title: true, description: true, images: true, variants: true, tags: true, shipping_template_id: true,
    };
    // When selling through Shopify, explicitly enable the Shopify sales channel so the
    // product actually appears in the connected Shopify store (not just inside Printify).
    if (CFG.storePlatform === 'shopify') publishBody.sales_channels = [{ id: 'shopify' }];
    await printifyReq('POST', `/v1/shops/${shopId}/products/${pid}/publish.json`, publishBody);
    pubStatus = 'published';
  } catch (e) { pubStatus = 'publish_failed: ' + e.message; }
  return { pid, pubStatus };
}

async function makeDesigns(limitOverride, ignoreCap) {
  const plan = dbMod.getLatestDailyPlan();
  const research = latestResearch();
  const items = plan.length ? plan : research;
  if (!items.length) { log(MAKER_SUB, 'maker_skip', 'No research / daily plan yet — run research first', 'pod'); return; }
  const maxThisCycle = limitOverride || CFG.maxDesignsPerCycle;
  markAgent(MAKER_SUB, 'working', `Generating designs from today's Shopify plan (${items.length} items)`);
  let made = 0;
  for (const row of items) {
    if (made >= maxThisCycle) break;
    // Respect the hard daily cap on NEW Shopify products (focus on winners).
    if (!ignoreCap && dailyCapReached()) {
      log(MAKER_SUB, 'daily_cap', `Daily cap of ${CFG.dailyCap} reached — pausing uploads until tomorrow.`, 'pod');
      note('POD Daily Cap', `Reached the ${CFG.dailyCap}-product daily limit. Resuming tomorrow.`, 'info');
      break;
    }
    const niche = row.niche || 'general';
    let themes = [];
    try { themes = JSON.parse(row.themes || '[]'); } catch {}
    if (!themes.length) themes = row.theme ? [row.theme] : [niche];
    const productType = normalizeProductType(row.product_type || (() => { try { return JSON.parse(row.product_types || '[]')[0]; } catch { return niche; } })());
    const designHint = row.design_hint || '';
    const entry = { niche, themes: themes.slice(0, 3), productTypes: productType ? [productType] : [niche], examples: designHint ? [designHint] : [] };
    try {
      const spec = await designSpec(entry);
      if (productType && productType !== spec.productType) spec.productType = productType;       // honor the day's plan
      if (designHint) spec.prompt = `${designHint}, ${spec.prompt}`;                            // steer artwork toward the winning design
      if (!fs.existsSync(POD_DIR)) fs.mkdirSync(POD_DIR, { recursive: true });
      const imgName = `design-${Date.now()}-${made}.png`;
      const imgPath = path.join(POD_DIR, imgName);
      let imageStatus = 'none';
      let savedPath = '';
      let contentType = 'image/png';
      const img = await generateImage(spec.prompt, imgPath);
      if (img && img.ok) { imageStatus = 'generated'; savedPath = img.path; contentType = img.contentType || 'image/png'; }
      else { imageStatus = 'failed'; }
      run(`INSERT INTO pod_designs (research_id, niche, product_type, title, prompt, image_path, image_status) VALUES (?,?,?,?,?,?,?)`,
        [row.id || 0, niche, spec.productType || niche, spec.title, spec.prompt, savedPath, imageStatus]);
      const did = getDb().exec('SELECT MAX(id) as id FROM pod_designs')[0].values[0][0];
      log(MAKER_SUB, 'design_made', `Designed "${spec.title}" (${spec.productType}) from plan`, 'pod');
      markAgent(MAKER_SUB, 'working', `Designed "${spec.title}" — pushing to Printify → ${CFG.storePlatform}`);

      // Push to Printify if configured (publishes to whatever store is connected: Shopify or Etsy)
      if (CFG.printifyToken && savedPath) {
        try {
          const r = await createPrintifyProduct(spec, savedPath, contentType);
          const target = CFG.storePlatform === 'shopify' ? 'Shopify' : 'Etsy';
          run(`INSERT INTO pod_products (design_id, niche, product_type, title, printify_product_id, status) VALUES (?,?,?,?,?,?)`,
            [did, niche, spec.productType, spec.title, r.pid, r.pubStatus]);
          note('POD Product Live', `"${spec.title}" pushed to Printify → ${target} (${r.pubStatus}).`, 'success');
          log(MAKER_SUB, 'product_pushed', `Published "${spec.title}" -> Printify #${r.pid} (${r.pubStatus})`, 'pod');
        } catch (e) {
          run(`INSERT INTO pod_products (design_id, niche, product_type, title, status, error) VALUES (?,?,?,?,?,?)`,
            [did, niche, spec.productType, spec.title, 'error', e.message]);
          log(MAKER_SUB, 'product_error', `Printify push failed for "${spec.title}": ${e.message}`, 'pod');
        }
      } else if (CFG.printifyToken && !savedPath) {
        log(MAKER_SUB, 'product_skip', `Image missing for "${spec.title}" — cannot push without artwork`, 'pod');
      }
      made++;
    } catch (e) {
      log(MAKER_SUB, 'design_error', `Failed to make design for ${niche}: ${e.message}`, 'pod');
    }
  }
  if (made) note('POD Maker Cycle', `Produced ${made} new design(s) for your Shopify store.`, 'info');
  markAgent(MAKER_SUB, 'idle', 'Maker cycle complete — awaiting next cycle');
}

// Push any generated designs that haven't been sent to Printify yet
async function publishPendingDesigns() {
  // Clean up past errors so retries don't create duplicate Printify products
  run(`DELETE FROM pod_products WHERE status = 'error'`);
  const pending = q(`SELECT d.* FROM pod_designs d
    WHERE d.image_status = 'generated' AND d.image_path <> ''
    AND NOT EXISTS (SELECT 1 FROM pod_products p WHERE p.design_id = d.id AND p.status IN ('published','created'))`);
  let n = 0;
  for (const d of pending) {
    if (!CFG.printifyToken || !d.image_path) continue;
    const spec = { title: d.title, productType: normalizeProductType(d.product_type), prompt: d.prompt, tags: [] };
    try {
      const r = await createPrintifyProduct(spec, d.image_path);
      run(`INSERT INTO pod_products (design_id, niche, product_type, title, printify_product_id, status) VALUES (?,?,?,?,?,?)`,
        [d.id, d.niche, d.product_type, d.title, r.pid, r.pubStatus]);
      log(MAKER_SUB, 'product_pushed', `"${d.title}" -> Printify #${r.pid} (${r.pubStatus})`, 'pod');
      n++;
    } catch (e) {
      run(`INSERT INTO pod_products (design_id, niche, product_type, title, status, error) VALUES (?,?,?,?,?,?)`,
        [d.id, d.niche, d.product_type, d.title, 'error', e.message]);
      log(MAKER_SUB, 'product_error', `"${d.title}": ${e.message}`, 'pod');
    }
  }
  if (n) note('POD Publish', `Pushed ${n} design(s) to Printify.`, 'success');
  return n;
}

// ---- Cycle + scheduler ----------------------------------------------------
async function cycle(seedText) {
  if (running) return;
  running = true;
  ensurePodAgents();
  try {
    await researchOnce(seedText);
    await makeDesigns();
    if (CFG.printifyToken) await publishPendingDesigns();
    if (global.__broadcast) global.__broadcast({ type: 'pod_update', ts: Date.now() });
  } catch (e) {
    log('POD', 'cycle_error', e.message, 'pod');
    markAgent(RESEARCH_SUB, 'idle', 'Cycle error — awaiting next cycle');
    markAgent(MAKER_SUB, 'idle', 'Cycle error — awaiting next cycle');
  } finally {
    running = false;
  }
}

// Dedicated cycle that spins design VARIATIONS of the operator's top-selling
// products — the highest-conversion way to grow a Shopify POD store.
async function cycleVariations() {
  if (running) return;
  running = true;
  ensurePodAgents();
  try {
    await researchVariationsOnTopSellers();
    await makeDesigns();
    if (CFG.printifyToken) await publishPendingDesigns();
    note('POD Variations', 'Spun new designs from your top sellers and pushed them to Printify → Shopify.', 'success');
    if (global.__broadcast) global.__broadcast({ type: 'pod_update', ts: Date.now() });
  } catch (e) {
    log('POD', 'variation_cycle_error', e.message, 'pod');
  } finally {
    running = false;
  }
}

function startPOD() {
  if (timer) return;
  ensurePodAgents();
  log('POD', 'engine_start', `Scheduler on (${(CFG.intervalMs / 3600000).toFixed(1)}h interval)`, 'pod');
  timer = setInterval(() => cycle(), CFG.intervalMs);
  setTimeout(() => cycle(), 8000); // first pass shortly after boot
}

function getStatus() {
  const counts = q(`SELECT
    (SELECT COUNT(*) FROM pod_research) as research,
    (SELECT COUNT(*) FROM pod_designs) as designs,
    (SELECT COUNT(*) FROM pod_products) as products,
    (SELECT COUNT(*) FROM pod_products WHERE status = 'published') as published`);
  const c = counts[0] || { research: 0, designs: 0, products: 0, published: 0 };
  let planCount = 0;
  try { planCount = dbMod.getLatestDailyPlan().length; } catch {}
  return {
    running,
    niches: CFG.niches,
    storePlatform: CFG.storePlatform,
    hasPrintify: !!CFG.printifyToken,
    printifyShopId: CFG.printifyShopId || '',
    shopifyConnected: !!CFG.printifyShopId || CFG.storePlatform === 'shopify',
    etsyConnected: !!CFG.etsyToken,
    hasImageKey: true, // free via Pollinations, or paid via OpenAI/Stability
    hasLLM: true,      // free via Pollinations, or paid via OpenRouter
    llmMode: process.env.OPENAI_API_KEY ? 'openai' : process.env.OPENROUTER_API_KEY ? 'openrouter' : 'free',
    imageMode: CFG.openaiKey ? 'openai' : CFG.stabilityKey ? 'stability' : 'free',
    intervalHours: +(CFG.intervalMs / 3600000).toFixed(1),
    dailyPlanCount: planCount,
    counts: c,
  };
}

module.exports = { startPOD, cycle, cycleVariations, researchTopSellers, cycleTopProducts, researchVariationsOnTopSellers, getLiveProducts, publishPendingDesigns, getStatus, latestResearch, createPrintifyProduct, generateImage, getDb: q, CFG, RESEARCH_SUB, MAKER_SUB };
