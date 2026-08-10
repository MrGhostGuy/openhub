/**
 * money-hustler.js — The "Money Hustler" autonomous income agent.
 *
 * Mandate (set by the owner):
 *   Be the MOST aggressive, fully-autonomous earner in the fleet. Relentlessly
 *   hunt for REAL money-making opportunities and execute whatever can be done
 *   autonomously, with the single hard rule below.
 *
 * HARD GUARDRAIL (non-negotiable):
 *   This agent ONLY pursues LEGAL, ETHICAL income. It will NEVER engage in or
 *   plan fraud, scams, money laundering, counterfeit, illegal goods, fake
 *   accounts, identity theft, or terms-of-service abuse. Any LLM suggestion
 *   that breaks this rule is rejected and logged. The agent maximizes REAL
 *   money into PayPal strictly within the law — hustle, not crime.
 *
 * It reuses the same legal channels the rest of the system already runs:
 *   - Shopify POD (Printify) store
 *   - Digital products / templates / printables
 *   - Affiliate + content arbitrage that pays to PayPal
 *   - Legit microtask / gig listings it can fulfill autonomously
 * It evolves from REAL PayPal payouts like the Income Strategist.
 */
const fetch = require('node-fetch');
const dbMod = require('./database');

const NAME = 'Money Hustler';
const CFG = {
   intervalMs: parseInt(process.env.HUSTLER_INTERVAL_MS || '5400000', 10), // 1.5h
   llmModel: process.env.POD_LLM_MODEL || 'google/gemini-3.5-flash',
   paypalMe: process.env.PAYPAL_ME || '',
 };
let timer = null;
let running = false;

// ---- logging / broadcast ----
function log(action, detail) {
  try { dbMod.addActivityLog(NAME, action, detail, 'income'); } catch (e) {}
  if (global.__broadcast) global.__broadcast({ type: 'hustler_log', agent: NAME, action, detail, ts: Date.now() });
}
function markAgent(status, task) {
  try { dbMod.touchAgent(NAME, { status, current_task: task, role: 'Autonomous Income Hustler', avatar: '🤑', kind: 'subagent' }); } catch (e) {}
}
function ensureAgent() {
  try {
    dbMod.ensureAgent(NAME, { role: 'Autonomous Income Hustler', avatar: '🤑', kind: 'subagent', status: 'idle', current_task: 'Hunting for legal money-making opportunities' });
    dbMod.ensureEvolution(NAME);
  } catch (e) {}
}

// ---- legal/ethical guardrail ----
const FORBIDDEN = /(scam|fraud| counterfeit|launder|money launder|illegal|stolen|hack|exploit\s*weakness|fake\s*account|bot\s*farm|click\s*fraud|pyramid|ponzi|darknet|drugs|weapon|identity\s*theft|phish|smash\s*and\s*grab|drain|credential\s*stuff|brute\s*force)/i;
function isIllegal(text) {
  return FORBIDDEN.test(text || '');
}

// ---- free LLM: Gemini > OpenAI > OpenRouter > Pollinations (POST) ----
async function llm(system, user, maxTokens = 1400) {
  // Check cache first
  const cached = dbMod.llmCacheGet(system, user);
  if (cached) return cached;

  if (process.env.GEMINI_API_KEY) {
    try {
      const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.9 } }) });
      if (res.ok) { const j = await res.json(); const t = j?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || ''; if (t) { dbMod.llmCacheSet(system, user, t.trim()); return t.trim(); } }
    } catch (e) {}
  }
  if (process.env.OPENAI_API_KEY) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model: (process.env.POD_LLM_MODEL && process.env.POD_LLM_MODEL.startsWith('gpt')) ? process.env.POD_LLM_MODEL : 'gpt-4o-mini', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, temperature: 0.9 }) });
      if (res.ok) { const j = await res.json(); const t = j.choices?.[0]?.message?.content || ''; if (t) { dbMod.llmCacheSet(system, user, t.trim()); return t.trim(); } }
    } catch (e) {}
  }
  if (process.env.OPENROUTER_API_KEY) {
    for (const m of ['nvidia/nemotron-3-ultra-550b-a55b:free', 'openrouter/free', 'nvidia/nemotron-3-super-120b-a12b:free', 'google/gemma-4-26b-a4b-it:free']) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`, 'HTTP-Referer': 'https://openhub.local', 'X-Title': 'OpenHub' }, body: JSON.stringify({ model: m, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, temperature: 0.9 }) });
        if (res.ok) { const j = await res.json(); const t = j.choices?.[0]?.message?.content || ''; if (t) { dbMod.llmCacheSet(system, user, t.trim()); return t.trim(); } }
      } catch (e) {}
    }
  }
  const key = process.env.POLLINATIONS_API_KEY ? `&token=${encodeURIComponent(process.env.POLLINATIONS_API_KEY)}` : '';
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      await dbMod.pollinationsThrottle(!!process.env.POLLINATIONS_API_KEY);
      const r = await fetch('https://text.pollinations.ai/openai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openai', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, temperature: 0.9, seed: Math.floor(Math.random() * 1e6) }),
      });
      if (r.ok) { const t = (await r.text()).trim(); dbMod.llmCacheSet(system, user, t); return t; }
      if (r.status === 429) return '';
      if (r.status >= 500) { await new Promise(r => setTimeout(r, 2000)); continue; }
      return '';
    } catch (e) { return ''; }
  }
  return '';
}
function extractJson(text) {
  try { const m = text.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); } catch {}
  try { return JSON.parse(text); } catch {}
  return null;
}
const FALLBACK_HUSTLES = [
  { name: 'Shopify POD Printify Store', method: 'Print-on-demand via Printify → Shopify, pays out to PayPal', rationale: 'POD has zero inventory risk and Printify auto-fulfills. Shopify handles payments and deposits to PayPal.', paypal_mechanism: 'Shopify payments → PayPal', autonomy: 'autonomous', success_rate: 0.6, steps: ['Connect Printify to Shopify', 'Upload 20+ designs to Printify', 'Set up Shopify store with POD products', 'Enable PayPal as payment method'] },
  { name: 'Digital Product Templates', method: 'Sell Canva/Figma templates on Etsy or Gumroad, payouts to PayPal', rationale: 'Digital products have 100% margins and zero fulfillment. Templates sell repeatedly with no inventory.', paypal_mechanism: 'Etsy/Gumroad → PayPal', autonomy: 'autonomous', success_rate: 0.5, steps: ['Create 10 Canva templates in a niche', 'List on Etsy with SEO-optimized titles', 'Set up Gumroad for direct sales', 'Enable PayPal payout on both platforms'] },
  { name: 'Affiliate Content Site', method: 'Build a niche blog with affiliate links, earn commissions deposited to PayPal', rationale: 'Affiliate marketing pays recurring commissions. A single article can earn for years.', paypal_mechanism: 'Affiliate network → PayPal', autonomy: 'needs_owner', success_rate: 0.4, steps: ['Pick a profitable niche (finance, tech, health)', 'Write 10 SEO-optimized articles', 'Join Amazon Associates and ShareASale', 'Add affiliate links and PayPal payout setup'] },
  { name: 'Print-on-Demand Merch', method: 'Design t-shirts/mugs on Redbubble or Teespring, auto-fulfilled, PayPal payouts', rationale: 'Redbubble handles everything — printing, shipping, customer service. Pure passive income.', paypal_mechanism: 'Redbubble → PayPal', autonomy: 'autonomous', success_rate: 0.45, steps: ['Create 50+ designs across trending niches', 'Upload to Redbubble with keyword-rich titles', 'Optimize for search with trending keywords', 'Monitor and scale winning designs'] },
  { name: 'Etsy Digital Downloads', method: 'Upload printable wall art, planners, and SVG files to Etsy with PayPal payout', rationale: 'Etsy has built-in traffic for digital goods. Zero shipping, high margins, PayPal payouts.', paypal_mechanism: 'Etsy → PayPal', autonomy: 'autonomous', success_rate: 0.55, steps: ['Create 20+ printable digital files', 'Set up Etsy shop with PayPal payout', 'Optimize listings with trending keywords', 'Promote via Pinterest and Instagram'] },
  { name: 'Gumroad Digital Products', method: 'Sell digital products (ebooks, templates, courses) on Gumroad with PayPal checkout', rationale: 'Gumroad handles delivery and payments. Set price, upload product, collect PayPal revenue.', paypal_mechanism: 'Gumroad → PayPal', autonomy: 'autonomous', success_rate: 0.5, steps: ['Create 3-5 digital products', 'Set up Gumroad storefront', 'Configure PayPal as payout method', 'Promote via social media and email'] },
  { name: 'YouTube Automation Channel', method: 'Create faceless YouTube channel with AI-generated content, monetize via AdSense (PayPal payout)', rationale: 'Faceless channels require no face or voice. AI generates scripts, edits, and uploads.', paypal_mechanism: 'AdSense → PayPal', autonomy: 'needs_owner', success_rate: 0.3, steps: ['Pick a profitable niche (finance, tech, health)', 'Set up YouTube channel with PayPal-linked AdSense', 'Use AI to generate scripts and edit videos', 'Upload 3 videos per week consistently'] },
  { name: 'TikTok Affiliate Marketing', method: 'Create short TikTok videos with affiliate links, earn commissions via PayPal', rationale: 'TikTok algorithm rewards engaging short content. Affiliate links generate passive commissions.', paypal_mechanism: 'Affiliate network → PayPal', autonomy: 'autonomous', success_rate: 0.4, steps: ['Pick a niche and join affiliate programs', 'Create 5-10 short videos per week', 'Add affiliate links in bio and comments', 'Scale winning content with TikTok ads'] },
  { name: 'Pinterest Pin Monetization', method: 'Create and pin affiliate content on Pinterest, drive traffic to PayPal-enabled landing pages', rationale: 'Pinterest drives long-tail traffic for months. Pins keep earning while you sleep.', paypal_mechanism: 'Affiliate clicks → PayPal', autonomy: 'autonomous', success_rate: 0.45, steps: ['Create 50+ pins with affiliate links', 'Set up Pinterest business account', 'Link to PayPal-enabled landing pages', 'Analyze and double down on top performers'] },
  { name: 'Microtask Gig Listings', method: 'Post microtasks on Fiverr/Mechanical Turk that the agents can fulfill autonomously, PayPal payouts', rationale: 'High-volume small gigs add consistent cash flow with minimal oversight once tasks are posted.', paypal_mechanism: 'Platform → PayPal', autonomy: 'autonomous', success_rate: 0.5, steps: ['Create Fiverr Business account with PayPal payout', 'List 20+ micro-tasks (data entry, transcription)', 'Program automated scheduling for peak hours', 'Monitor and auto-accept orders'] },
];

// ---- hustle: find + set up legal money-makers ----
async function hustle() {
  const streams = dbMod.getIncomeStreams(50).map(s => ({ name: s.name, status: s.status, method: s.method }));
  const lessons = dbMod.getLearningLog(NAME, 15).map(l => l.lesson);
  const pay = dbMod.getRealPayoutSummary();
  const paypal = CFG.paypalMe ? `paypal.me/${CFG.paypalMe}` : '(not set)';

  const system = `You are "Money Hustler", the most aggressive, relentless, fully-autonomous income agent for your owner. Your ONLY goal: find and execute EVERY realistic way to put as much REAL money as possible into the owner's PayPal (${paypal}) with the least manual effort.

Push hard. Be maximally creative and opportunistic. Exploit every legal channel and loophole that pays: Shopify print-on-demand (Printify), digital products/templates/printables, affiliate marketing, content/lead arbitrage, reselling, legit gig and microtask work the agents can fulfill, and any other above-board method that converts to cash. Do not self-censor on legitimate hustles — the owner wants maximum output.

PRIORITIZE methods that:
1) Deposit straight to PayPal immediately (sales, affiliate payouts, digital products, POD, ad/lead arbitrage)
2) Require ZERO manual work after setup (fully automated)
3) Start earning within 24-48 hours, not weeks
4) Build on existing infrastructure (Shopify POD, existing storefronts)
5) Have the highest probability of actual money arriving in PayPal

Do NOT suggest things that take weeks to set up or require manual daily work. Focus on "set it and forget it" income that deposits to PayPal automatically.

CONSTRAINT: Stay strictly within the law. Do not propose clearly illegal acts (fraud, counterfeit, laundering, theft, fake accounts, etc.). Within that boundary, be unlimited. Output ONLY valid JSON.`;

  const user = `OWNER CONTEXT:
- Real money already in PayPal: $${Math.round(pay.total || 0)} across ${pay.count || 0} payout(s).
- Streams already tracked: ${JSON.stringify(streams).slice(0, 800) || 'none'}.
- Lessons learned: ${JSON.stringify(lessons).slice(0, 600) || 'none yet'}.

TASK: Propose the most reliable, executable legal money-makers to pursue NEXT. Favor ones the agents can set up or run autonomously and that pay straight to PayPal.

Be MORE AGGRESSIVE than the Income Strategist — propose higher-risk, higher-reward opportunities too. Push the boundaries of what's possible within the law.

COLLABORATION: If an opportunity requires another agent's expertise (e.g. a Shopify store needs the POD engine, a blog needs the Content Bot), note it in the "collaboration" field so the orchestrator can assign the right agent.

Return JSON:
{
  "hustles": [
    { "name": "short unique name", "method": "exactly how it earns + pays PayPal", "rationale": "why it will work fast", "paypal_mechanism": "how money reaches PayPal", "autonomy": "autonomous|needs_owner", "success_rate": 0.0-1.0, "steps": ["step 1","step 2"], "collaboration": "optional: which other agent should handle this" }
  ],
  "strategy": "one-line note on the hustle plan"
}`;

  let raw = '';
  try { raw = await llm(system, user, 1500); } catch (e) { log('llm_fallback', `LLM failed (${e.message}), using built-in fallback hustles`); }

  let parsed = null;
  if (raw) {
    parsed = extractJson(raw);
    if (parsed && Array.isArray(parsed.hustles) && parsed.hustles.length > 0) {
      parsed.hustles = parsed.hustles.filter(h => {
        const blob = `${h.name} ${h.method} ${h.rationale} ${(h.steps || []).join(' ')}`;
        if (isIllegal(blob)) { log('guardrail', `Rejected illegal hustle: "${h.name}"`); return false; }
        return true;
      });
      return parsed;
    }
  }

  // Built-in fallback: generate hustles without any LLM
  log('fallback', 'Using built-in fallback hustle ideas (no LLM available)');
  const existingNames = dbMod.getIncomeStreams(100).map(s => s.name.toLowerCase());
  const newHustles = FALLBACK_HUSTLES.filter(h => !existingNames.includes(h.name.toLowerCase())).slice(0, 3);
  return { hustles: newHustles, strategy: 'Built-in fallback: using proven hustle templates. Will retry LLM next cycle.' };
}

function setUpHustle(h, id) {
  const blob = `${h.name} ${h.method}`.toLowerCase();
  const isPod = /pod|shopify|printify|merch|store/.test(blob);
  if (isPod) {
    dbMod.updateIncomeStream(id, { status: 'active', notes: 'Autonomously fulfilled by the Shopify POD engine (Printify).' });
    return 'active';
  }
  if ((h.autonomy || '').toLowerCase() === 'needs_owner') {
    dbMod.updateIncomeStream(id, { status: 'needs_owner', notes: 'Requires owner to connect an account; agent did all autonomous setup it can.' });
    return 'needs_owner';
  }
  // default: activate — agent monitors and optimizes
  dbMod.updateIncomeStream(id, { status: 'active', notes: 'Activated by Money Hustler; agent will optimize and monitor real PayPal payouts.' });
  return 'active';
}

function evolve() {
  try {
    const payouts = dbMod.getRealPayouts(500).filter(p => !(p.stream_id > 0));
    if (!payouts.length) return 0;
    let primary = dbMod.getIncomeStreams(50).find(s => s.status === 'active' && /pod|shopify|printify/i.test(s.name + ' ' + s.method));
    if (!primary) primary = dbMod.getIncomeStreams(50).find(s => s.status === 'active');
    if (!primary) primary = dbMod.getIncomeStreams(50)[0];
    if (!primary) {
      const id = dbMod.createIncomeStream({ name: 'Shopify POD Store', method: 'Print-on-demand via Printify → Shopify, pays out to PayPal', status: 'active', rationale: 'Primary autonomous income stream.', paypal_mechanism: CFG.paypalMe ? `paypal.me/${CFG.paypalMe}` : 'PayPal', success_rate: 0.5, steps: ['Connected by POD engine'] });
      primary = dbMod.getIncomeStream(id);
    }
    let total = 0;
    for (const p of payouts) {
      dbMod.attributePayout(primary.id, p.paypal_id);
      dbMod.updateIncomeStream(primary.id, { deposits_usd: Math.round((primary.deposits_usd || 0) + (p.amount || 0)) });
      total += (p.amount || 0);
    }
    if (total > 0) {
      dbMod.awardXp(NAME, Math.round(total * 12)); // hustler earns a bit more XP per $
      dbMod.addLearning(NAME, `Real PayPal deposit of $${Math.round(total)} attributed to "${primary.name}" — push harder on this stream.`, 'income_result');
      log('evolve', `Attributed $${Math.round(total)} of real PayPal payouts to "${primary.name}".`);
      if (global.__broadcast) global.__broadcast({ type: 'hustler_deposit', stream: primary.name, amount: Math.round(total) });
    }
    return total;
  } catch (e) { return 0; }
}

async function cycle() {
  if (running) return;
  running = true;
  ensureAgent();
  try {
    markAgent('working', 'Hunting for legal money-making opportunities');
    const res = await hustle();
    let added = 0;
    for (const h of (res.hustles || [])) {
      const name = (h.name || '').trim();
      if (!name) continue;
      if (dbMod.getIncomeStreams(100).some(s => s.name.toLowerCase() === name.toLowerCase())) continue;
      const id = dbMod.createIncomeStream({
        name, method: h.method || '', status: 'hustling',
        rationale: h.rationale || '', paypal_mechanism: h.paypal_mechanism || '',
        success_rate: h.success_rate || 0, steps: h.steps || [],
      });
      setUpHustle(h, id);
      added++;
      log('hustle_added', `New hustle "${name}" — ${h.rationale || ''}`);
      if (h.collaboration) {
        const collabAgent = h.collaboration;
        const taskTitle = `Execute hustle: ${name}`;
        try {
          const existing = dbMod.getTasks(20).find(t => t.title.includes(name) && t.status !== 'completed');
          if (!existing) {
            dbMod.insertTask({ title: taskTitle, description: `Hustle "${name}" proposed by ${NAME}. ${h.method || ''}. Steps: ${(h.steps || []).join('; ')}`, assignee: collabAgent, priority: 'medium' });
            log('task_created', `Created task for ${collabAgent}: "${taskTitle}"`);
          }
        } catch (e) { log('task_error', `Could not create task for ${collabAgent}: ${e.message || e}`); }
      }
    }
    if (added) log('hustle', `Pursuing ${added} new legal money-maker(s).`);
    evolve();
    markAgent('idle', 'Awaiting next hustle cycle');
  } catch (e) {
    log('cycle_error', e.message);
    markAgent('idle', 'Cycle error — awaiting next cycle');
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  ensureAgent();
  log('engine_start', `Money Hustler scheduler on (${(CFG.intervalMs / 3600000).toFixed(1)}h)`);
  timer = setInterval(() => cycle(), CFG.intervalMs);
  setTimeout(() => cycle(), 4000);
}

function getStatus() {
  const evo = dbMod.getEvolution(NAME) || { level: 1, xp: 0, skill: 'Generalist' };
  const stats = dbMod.getIncomeStats();
  const pay = dbMod.getRealPayoutSummary();
  return {
    name: NAME,
    level: evo.level, xp: evo.xp, skill: evo.skill,
    stats,
    totalDeposited: Math.round(pay.total || 0),
    payoutCount: pay.count || 0,
    running,
  };
}

module.exports = { NAME, cycle, start, getStatus, evolve };
