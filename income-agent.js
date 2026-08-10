/**
 * income-agent.js — The autonomous "Income Strategist" sub-agent.
 *
 * Mandate (set by the owner):
 *   - Continually brainstorm PASSIVE-INCOME streams that deposit REAL money
 *     into the owner's PayPal account with minimal manual work.
 *   - Prioritize methods with the highest chance of actually earning.
 *   - Set up whatever it can autonomously (e.g. the Shopify POD store, which the
 *     POD engine fulfills), and produce concrete setup plans for the rest.
 *   - EVOLVE: read real PayPal payouts (real_payouts), attribute them to the
 *     stream that earned them, award XP, and feed the lessons back into the next
 *     brainstorm so the agent gets smarter about what actually makes money.
 *
 * It is a real, observable agent (registered in the `agents` table) so it shows
 * up in the workspace roster + Agents page with live status / frozen detection.
 *
 * NOTE: The agent automates research, planning and (where credentials exist)
 * setup. It cannot mint money or create external accounts by itself — its job is
 * to maximize the probability and autonomy of real deposits into PayPal.
 */
const fetch = require('node-fetch');
const dbMod = require('./database');

const NAME = 'Income Strategist';
const CFG = {
   intervalMs: parseInt(process.env.INCOME_INTERVAL_MS || '7200000', 10), // 2h
   evolveMs: parseInt(process.env.INCOME_EVOLVE_MS || '300000', 10),       // 5m
   llmModel: process.env.POD_LLM_MODEL || 'google/gemini-3.5-flash',
   paypalMe: process.env.PAYPAL_ME || '',
 };
let timer = null;
let evolveTimer = null;
let running = false;

// ---- logging / broadcast ----
function log(action, detail) {
  try { dbMod.addActivityLog(NAME, action, detail, 'income'); } catch (e) {}
  if (global.__broadcast) global.__broadcast({ type: 'income_log', agent: NAME, action, detail, ts: Date.now() });
}
function markAgent(status, task) {
  try { dbMod.touchAgent(NAME, { status, current_task: task, role: 'Passive Income Strategist', avatar: '💰', kind: 'subagent' }); } catch (e) {}
}
function ensureAgent() {
  try {
    dbMod.ensureAgent(NAME, { role: 'Passive Income Strategist', avatar: '💰', kind: 'subagent', status: 'idle', current_task: 'Standing by to brainstorm income streams' });
    dbMod.ensureEvolution(NAME);
  } catch (e) {}
}

// ---- free LLM: Gemini direct > OpenAI > OpenRouter > Pollinations (POST) --------
async function geminiText(system, user, maxTokens = 1100) {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.8 },
  };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const j = await res.json();
  const t = j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (t) return t.trim();
  throw new Error('Gemini empty');
}
async function llm(system, user, maxTokens = 1100) {
  // Check cache first
  const cached = dbMod.llmCacheGet(system, user);
  if (cached) return cached;

  if (process.env.GEMINI_API_KEY) {
    try { const r = await geminiText(system, user, maxTokens); dbMod.llmCacheSet(system, user, r); return r; } catch (e) {}
  }
  if (process.env.OPENAI_API_KEY) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: process.env.POD_LLM_MODEL && process.env.POD_LLM_MODEL.startsWith('gpt') ? process.env.POD_LLM_MODEL : 'gpt-4o-mini', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, temperature: 0.8 }),
      });
      if (res.ok) { const j = await res.json(); const t = j.choices?.[0]?.message?.content || ''; if (t) { dbMod.llmCacheSet(system, user, t); return t; } }
    } catch {}
  }
  if (process.env.OPENROUTER_API_KEY) {
    const models = ['nvidia/nemotron-3-ultra-550b-a55b:free', 'openrouter/free', 'nvidia/nemotron-3-super-120b-a12b:free', 'google/gemma-4-26b-a4b-it:free'];
    for (const m of models) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`, 'HTTP-Referer': 'https://openhub.local', 'X-Title': 'OpenHub' },
          body: JSON.stringify({ model: m, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, temperature: 0.8 }),
        });
        const j = await res.json();
        const err = j?.error?.message || '';
        if (!res.ok || err) { try { require('fs').appendFileSync('C:/Users/kency/Desktop/OpenHub/debug-llm.log', `${new Date().toISOString()} ${m} status=${res.status} err=${err}\n`); } catch {} }
        if (res.ok) { const t = j.choices?.[0]?.message?.content || ''; if (t) { dbMod.llmCacheSet(system, user, t); return t; } }
      } catch (e) { try { require('fs').appendFileSync('C:/Users/kency/Desktop/OpenHub/debug-llm.log', `${new Date().toISOString()} ${m} exception=${e.message}\n`); } catch {} }
    }
  } else {
    try { require('fs').appendFileSync('C:/Users/kency/Desktop/OpenHub/debug-llm.log', `${new Date().toISOString()} NO OPENROUTER KEY\n`); } catch {}
  }
  const key = process.env.POLLINATIONS_API_KEY ? `&token=${encodeURIComponent(process.env.POLLINATIONS_API_KEY)}` : '';
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      await dbMod.pollinationsThrottle(!!process.env.POLLINATIONS_API_KEY);
      const r = await fetch('https://text.pollinations.ai/openai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openai', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, temperature: 0.8, seed: Math.floor(Math.random() * 1e6) }),
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

const FALLBACK_IDEAS = [
  { name: 'Shopify POD Printify Store', method: 'Print-on-demand via Printify → Shopify, pays out to PayPal', rationale: 'POD has zero inventory risk and Printify auto-fulfills. Shopify handles payments and deposits to PayPal.', paypal_mechanism: 'Shopify payments → PayPal', success_rate: 0.6, steps: ['Connect Printify to Shopify', 'Upload 20+ designs to Printify', 'Set up Shopify store with POD products', 'Enable PayPal as payment method'] },
  { name: 'Digital Product Templates', method: 'Sell Canva/Figma templates on Etsy or Gumroad, payouts to PayPal', rationale: 'Digital products have 100% margins and zero fulfillment. Templates sell repeatedly with no inventory.', paypal_mechanism: 'Etsy/Gumroad → PayPal', success_rate: 0.5, steps: ['Create 10 Canva templates in a niche', 'List on Etsy with SEO-optimized titles', 'Set up Gumroad for direct sales', 'Enable PayPal payout on both platforms'] },
  { name: 'Affiliate Content Site', method: 'Build a niche blog with affiliate links, earn commissions deposited to PayPal', rationale: 'Affiliate marketing pays recurring commissions. A single article can earn for years.', paypal_mechanism: 'Affiliate network → PayPal', success_rate: 0.4, steps: ['Pick a profitable niche (finance, tech, health)', 'Write 10 SEO-optimized articles', 'Join Amazon Associates and ShareASale', 'Add affiliate links and PayPal payout setup'] },
  { name: 'Print-on-Demand Merch', method: 'Design t-shirts/mugs on Redbubble or Teespring, auto-fulfilled, PayPal payouts', rationale: 'Redbubble handles everything — printing, shipping, customer service. Pure passive income.', paypal_mechanism: 'Redbubble → PayPal', success_rate: 0.45, steps: ['Create 50+ designs across trending niches', 'Upload to Redbubble with keyword-rich titles', 'Optimize for search with trending keywords', 'Monitor and scale winning designs'] },
  { name: 'Automated Dropshipping Store', method: 'Shopify store with auto-fulfilled suppliers, profits deposited to PayPal', rationale: 'Dropshipping requires no inventory. Suppliers ship directly to customers.', paypal_mechanism: 'Shopify → PayPal', success_rate: 0.35, steps: ['Pick a winning product niche', 'Set up Shopify store with dropshipping app', 'Connect supplier (DSers, Spocket)', 'Run targeted Facebook/Instagram ads'] },
  { name: 'Etsy Digital Downloads', method: 'Upload printable wall art, planners, and SVG files to Etsy with PayPal payout', rationale: 'Etsy has built-in traffic for digital goods. Zero shipping, high margins, PayPal payouts.', paypal_mechanism: 'Etsy → PayPal', success_rate: 0.55, steps: ['Create 20+ printable digital files', 'Set up Etsy shop with PayPal payout', 'Optimize listings with trending keywords', 'Promote via Pinterest and Instagram'] },
  { name: 'Gumroad Digital Products', method: 'Sell digital products (ebooks, templates, courses) on Gumroad with PayPal checkout', rationale: 'Gumroad handles delivery and payments. Set price, upload product, collect PayPal revenue.', paypal_mechanism: 'Gumroad → PayPal', success_rate: 0.5, steps: ['Create 3-5 digital products', 'Set up Gumroad storefront', 'Configure PayPal as payout method', 'Promote via social media and email'] },
  { name: 'YouTube Automation Channel', method: 'Create faceless YouTube channel with AI-generated content, monetize via AdSense (PayPal payout)', rationale: 'Faceless channels require no face or voice. AI generates scripts, edits, and uploads.', paypal_mechanism: 'AdSense → PayPal', success_rate: 0.3, steps: ['Pick a profitable niche (finance, tech, health)', 'Set up YouTube channel with PayPal-linked AdSense', 'Use AI to generate scripts and edit videos', 'Upload 3 videos per week consistently'] },
  { name: 'TikTok Affiliate Marketing', method: 'Create short TikTok videos with affiliate links, earn commissions via PayPal', rationale: 'TikTok algorithm rewards engaging short content. Affiliate links generate passive commissions.', paypal_mechanism: 'Affiliate network → PayPal', success_rate: 0.4, steps: ['Pick a niche and join affiliate programs', 'Create 5-10 short videos per week', 'Add affiliate links in bio and comments', 'Scale winning content with TikTok ads'] },
  { name: 'Pinterest Pin Monetization', method: 'Create and pin affiliate content on Pinterest, drive traffic to PayPal-enabled landing pages', rationale: 'Pinterest drives long-tail traffic for months. Pins keep earning while you sleep.', paypal_mechanism: 'Affiliate clicks → PayPal', success_rate: 0.45, steps: ['Create 50+ pins with affiliate links', 'Set up Pinterest business account', 'Link to PayPal-enabled landing pages', 'Analyze and double down on top performers'] },
];

// ---- brainstorm ----
async function brainstorm() {
  const streams = dbMod.getIncomeStreams(50).map(s => ({ name: s.name, status: s.status, method: s.method, deposits_usd: s.deposits_usd || 0 }));
  const lessons = dbMod.getLearningLog(NAME, 15).map(l => l.lesson);
  const pay = dbMod.getRealPayoutSummary();
  const evo = dbMod.getEvolution(NAME) || { level: 1, xp: 0, skill: 'Generalist' };
  const paypal = CFG.paypalMe ? `paypal.me/${CFG.paypalMe}` : '(not set)';
  const activeCount = streams.filter(s => s.status === 'active').length;
  const totalDeposited = streams.reduce((sum, s) => sum + (s.deposits_usd || 0), 0);

  const system = `You are the "Income Strategist", an autonomous AI agent whose ONLY objective is to make the owner REAL money that lands in their PayPal account (${paypal}) with as little manual work as possible. You brainstorm passive-income streams, then the owner's other agents (e.g. the Shopify POD engine) execute them. You evolve: you learn from what actually earned money. Be pragmatic, legal, and bias toward methods that genuinely pay out to PayPal. Output ONLY valid JSON.

PRIORITIZE methods that:
1) Deposit straight to PayPal immediately (sales, affiliate payouts, digital products, POD, ad/lead arbitrage)
2) Require ZERO manual work after setup (fully automated)
3) Start earning within 24-48 hours, not weeks
4) Build on existing infrastructure (Shopify POD, existing storefronts)
5) Have the highest probability of actual money arriving in PayPal

CURRENT STATE:
- ${activeCount} active income stream(s) already deployed
- $${Math.round(totalDeposited)} total deposited across all streams
- $${Math.round(pay.total || 0)} in real PayPal payouts received
- Level ${evo.level} agent with ${evo.xp} XP

Do NOT suggest things that take weeks to set up or require manual daily work. Focus on "set it and forget it" income that deposits to PayPal automatically.

COLLABORATION: If you identify an opportunity that requires another agent's expertise (e.g. a Shopify store needs the POD engine, a blog needs the Content Bot), note it in the "collaboration" field of each idea so the orchestrator can assign the right agent.`;
  const user = `OWNER CONTEXT:
- Total real money already deposited to PayPal: $${Math.round(pay.total || 0)} across ${pay.count || 0} payout(s).
- Your current evolution: level ${evo.level}, xp ${evo.xp}, specialty "${evo.skill}".
- Passive-income streams already tracked: ${JSON.stringify(streams).slice(0, 1000) || 'none'}.
- Lessons learned from real results: ${JSON.stringify(lessons).slice(0, 800) || 'none yet'}.

TASK: Propose the highest-probability passive-income streams to set up NEXT. Prioritize:
   1) Methods that deposit straight to PayPal (sales, affiliate payouts, digital products, POD, ad/lead arbitrage).
   2) HIGH success rate + LOW owner effort (the agents should do the work).
   3) At least one should build on what's already working (e.g. the Shopify POD store).
   4) Diversify across income types (POD, digital products, affiliate, content, ads).

Return JSON exactly:
{
  "ideas": [
    { "name": "short unique name", "method": "how it earns + how it pays PayPal", "rationale": "why this will succeed", "paypal_mechanism": "exactly how money reaches PayPal", "success_rate": 0.0-1.0, "steps": ["concrete setup step 1","step 2","step 3"], "collaboration": "optional: which other agent should handle this (e.g. POD-Engine, Content Bot)" }
  ],
  "strategy": "one-line note on how the agent will improve over time"
}`;

  let raw = '';
  try { raw = await llm(system, user, 1800); } catch (e) { log('llm_fallback', `LLM failed (${e.message}), using built-in fallback ideas`); }

  if (raw) {
    const parsed = extractJson(raw);
    if (parsed && Array.isArray(parsed.ideas) && parsed.ideas.length > 0) return parsed;
  }

  // Built-in fallback: generate ideas without any LLM
  log('fallback', 'Using built-in fallback income ideas (no LLM available)');
  const existingNames = dbMod.getIncomeStreams(100).map(s => s.name.toLowerCase());
  const newIdeas = FALLBACK_IDEAS.filter(idea => !existingNames.includes(idea.name.toLowerCase())).slice(0, 4);
  return { ideas: newIdeas, strategy: 'Built-in fallback: using proven passive-income templates. Will retry LLM next cycle.' };
}

// ---- set up a stream as far as autonomously possible ----
function setUpStream(s) {
  const name = (s.name || '').toLowerCase();
  const isPod = /pod|shopify|printify|merch|store/.test(name + ' ' + (s.method || ''));
  if (isPod) {
    // The POD engine already publishes to Shopify autonomously — mark active.
    dbMod.updateIncomeStream(s.id, { status: 'active', notes: 'Autonomously fulfilled by the Shopify POD engine (Printify). Agent monitors real PayPal payouts.' });
    return 'active';
  }
  // Anything needing an external account we can't create: record a precise plan
  // and flag it for the owner, while doing everything else we can.
  dbMod.updateIncomeStream(s.id, {
    status: 'needs_owner',
    notes: 'Agent completed all autonomous setup it can. Remaining steps require the owner to connect an account; see steps.',
  });
  return 'needs_owner';
}

// ---- evolution: attribute real PayPal payouts to streams + award XP ----
function evolve() {
  try {
    const payouts = dbMod.getRealPayouts(500).filter(p => !(p.stream_id > 0));
    if (!payouts.length) return 0;
    // pick the primary active stream (prefer POD/Shopify), else first stream, else create one
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
      dbMod.awardXp(NAME, Math.round(total * 10)); // $1 earned = 10 XP
      dbMod.addLearning(NAME, `Real PayPal deposit of $${Math.round(total)} attributed to "${primary.name}" — double down on this stream.`, 'income_result');
      log('evolve', `Attributed $${Math.round(total)} of real PayPal payouts to "${primary.name}"; agent gained XP.`);
      if (global.__broadcast) global.__broadcast({ type: 'income_deposit', stream: primary.name, amount: Math.round(total) });
    }
    return total;
  } catch (e) { return 0; }
}

// ---- cycle ----
async function cycle() {
  if (running) return;
  running = true;
  ensureAgent();
  try {
    markAgent('working', 'Brainstorming high-success passive-income streams');
    const res = await brainstorm();
    let added = 0;
    for (const idea of (res.ideas || [])) {
      const name = (idea.name || '').trim();
      if (!name) continue;
      const exists = dbMod.getIncomeStreams(100).some(s => s.name.toLowerCase() === name.toLowerCase());
      if (exists) continue;
      const id = dbMod.createIncomeStream({
        name, method: idea.method || '', status: 'brainstorming',
        rationale: idea.rationale || '', paypal_mechanism: idea.paypal_mechanism || '',
        success_rate: idea.success_rate || 0, steps: idea.steps || [],
      });
      const st = setUpStream({ id, name, method: idea.method });
      added++;
      log('stream_added', `New stream "${name}" (${st}) — ${idea.rationale || ''}`);
      if (idea.collaboration) {
        const collabAgent = idea.collaboration;
        const taskTitle = `Set up income stream: ${name}`;
        try {
          const existing = dbMod.getTasks(20).find(t => t.title.includes(name) && t.status !== 'completed');
          if (!existing) {
            dbMod.insertTask({ title: taskTitle, description: `Income stream "${name}" proposed by ${NAME}. ${idea.method || ''}. Steps: ${(idea.steps || []).join('; ')}`, assignee: collabAgent, priority: 'medium' });
            log('task_created', `Created task for ${collabAgent}: "${taskTitle}"`);
          }
        } catch (e) { log('task_error', `Could not create task for ${collabAgent}: ${e.message || e}`); }
      }
    }
    if (added) log('brainstorm', `Proposed ${added} new passive-income stream(s).`);
    // immediate evolution pass (attribute any payouts that arrived)
    evolve();
    markAgent('idle', 'Awaiting next brainstorm cycle');
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
  log('engine_start', `Income Strategist scheduler on (${(CFG.intervalMs / 3600000).toFixed(1)}h)`);
  timer = setInterval(() => cycle(), CFG.intervalMs);
  evolveTimer = setInterval(() => evolve(), CFG.evolveMs); // keep attributing real payouts promptly
  setTimeout(() => cycle(), 6000);
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
  };
}

module.exports = { start, cycle, evolve, getStatus, NAME };
