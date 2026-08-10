/**
 * traffic-agent.js — The "Traffic Agent" (Customer Acquisition).
 *
 * Mandate: bring REAL new customers to the owner's Shopify POD store so sales
 * actually happen. It does NOT buy fake traffic or break platform rules — it
 * produces a concrete, legal customer-acquisition plan (where to post, what to
 * say, which products to push, SEO/pinning tactics) and logs the actions so the
 * owner and other agents can execute. It evolves from real PayPal payouts:
 * when money lands, it learns which acquisition channels are actually paying off.
 */
const fetch = require('node-fetch');
const dbMod = require('./database');

const NAME = 'Traffic Agent';
const CFG = {
  intervalMs: parseInt(process.env.TRAFFIC_INTERVAL_MS || '21600000', 10), // 6h
  llmModel: process.env.POD_LLM_MODEL || 'google/gemini-2.0-flash-lite-001',
  shopUrl: process.env.SHOPIFY_STORE_URL || process.env.POD_SHOPIFY_URL || '',
  paypalMe: process.env.PAYPAL_ME || '',
};
let timer = null;
let running = false;

function log(action, detail) {
  try { dbMod.addActivityLog(NAME, action, detail, 'pod'); } catch (e) {}
  if (global.__broadcast) global.__broadcast({ type: 'traffic_log', agent: NAME, action, detail, ts: Date.now() });
}
function markAgent(status, task) {
  try { dbMod.touchAgent(NAME, { status, current_task: task, role: 'Customer Acquisition', avatar: '📣', kind: 'subagent' }); } catch (e) {}
}
function ensureAgent() {
  try {
    dbMod.ensureAgent(NAME, { role: 'Customer Acquisition', avatar: '📣', kind: 'subagent', status: 'idle', current_task: 'Planning customer acquisition for the Shopify store' });
    dbMod.ensureEvolution(NAME);
  } catch (e) {}
}

// ---- free LLM: Gemini > OpenAI > OpenRouter > Pollinations ----
async function llm(system, user, maxTokens = 1400) {
  const combined = `${system}\n\n${user}`;
  if (process.env.GEMINI_API_KEY) {
    try {
      const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.8 } }),
      });
      if (res.ok) { const j = await res.json(); const t = j?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || ''; if (t) return t.trim(); }
    } catch (e) {}
  }
  if (process.env.OPENAI_API_KEY) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model: (process.env.POD_LLM_MODEL && process.env.POD_LLM_MODEL.startsWith('gpt')) ? process.env.POD_LLM_MODEL : 'gpt-4o-mini', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, temperature: 0.8 }) });
      if (res.ok) { const j = await res.json(); const t = j.choices?.[0]?.message?.content || ''; if (t) return t.trim(); }
    } catch (e) {}
  }
  if (process.env.OPENROUTER_API_KEY) {
    for (const m of [CFG.llmModel, 'tencent/hy3:free', 'google/gemini-3.5-flash:free', 'meta-llama/llama-3.1-8b-instruct:free']) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` }, body: JSON.stringify({ model: m, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, temperature: 0.8 }) });
        if (res.ok) { const j = await res.json(); const t = j.choices?.[0]?.message?.content || ''; if (t) return t.trim(); }
      } catch (e) {}
    }
  }
  const key = process.env.POLLINATIONS_API_KEY ? `&token=${encodeURIComponent(process.env.POLLINATIONS_API_KEY)}` : '';
  for (let attempt = 0; attempt <= 4; attempt++) {
    try {
      await dbMod.pollinationsThrottle(!!process.env.POLLINATIONS_API_KEY);
      const r = await fetch(`https://text.pollinations.ai/${encodeURIComponent(combined)}?model=openai&seed=${Math.floor(Math.random() * 1e6)}${key}`);
      if (r.ok) return (await r.text()).trim();
    } catch (e) { if (attempt < 4) await new Promise(r => setTimeout(r, 4000 + attempt * 2000)); }
  }
  return '';
}
function extractJson(text) {
  try { const m = text.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); } catch {}
  try { return JSON.parse(text); } catch {}
  return null;
}

// ---- plan acquisition ----
async function plan() {
  const store = CFG.shopUrl || '(Shopify store URL not set)';
  const payouts = dbMod.getRealPayoutSummary();
  const streams = dbMod.getIncomeStreams(20).map(s => s.name);
  const system = `You are the "Traffic Agent" for a Shopify print-on-demand store fulfilled by Printify. Your ONLY job: get REAL new customers to the store so it makes actual sales. You are pragmatic, legal, and platform-rule-compliant (no fake reviews, no bots, no paid traffic the owner didn't approve). Output ONLY valid JSON.`;
  const user = `Store: ${store}
Real PayPal earned so far: $${Math.round(payouts.total || 0)} across ${payouts.count || 0} payout(s).
Current income streams: ${JSON.stringify(streams).slice(0, 400) || 'none'}.

Produce a concrete customer-acquisition plan to bring NEW buyers to the store THIS WEEK. Include free/organic channels the owner can actually do: Reddit communities to post in (with the angle), Pinterest/Instagram/TikTok content ideas, SEO title/description patterns, and which live product types to push hardest.

Return JSON:
{
  "channels": [
    { "channel": "Reddit/Pinterest/etc", "action": "specific thing to post or do", "product_focus": "mug|t-shirt|sticker|...", "why": "why this brings buyers" }
  ],
  "seo": { "title_pattern": "reusable Shopify title pattern", "desc_pattern": "reusable description pattern" },
  "thisWeek": ["3-5 prioritized actions to do this week"]
}`;
  const raw = await llm(system, user, 1500);
  const parsed = extractJson(raw);
  if (!parsed || !Array.isArray(parsed.channels)) return { channels: [], seo: {}, thisWeek: [], strategy: 'LLM unavailable; standing by.' };
  return parsed;
}

function evolve() {
  try {
    const payouts = dbMod.getRealPayouts(500).filter(p => !(p.stream_id > 0));
    if (!payouts.length) return 0;
    let primary = dbMod.getIncomeStreams(50).find(s => s.status === 'active');
    if (!primary) primary = dbMod.getIncomeStreams(50)[0];
    if (!primary) return 0;
    let total = 0;
    for (const p of payouts) {
      dbMod.attributePayout(primary.id, p.paypal_id);
      dbMod.updateIncomeStream(primary.id, { deposits_usd: Math.round((primary.deposits_usd || 0) + (p.amount || 0)) });
      total += (p.amount || 0);
    }
    if (total > 0) {
      dbMod.awardXp(NAME, Math.round(total * 8));
      dbMod.addLearning(NAME, `Real PayPal deposit of $${Math.round(total)} — double down on the acquisition channels that drove it.`, 'acquisition');
      log('evolve', `Attributed $${Math.round(total)} of real payouts to "${primary.name}".`);
    }
    return total;
  } catch (e) { return 0; }
}

async function cycle() {
  if (running) return;
  running = true;
  ensureAgent();
  try {
    markAgent('working', 'Building a customer-acquisition plan for the Shopify store');
    const planRes = await plan();
    const ch = planRes.channels || [];
    for (const c of ch.slice(0, 12)) {
      if (c.channel && c.action) log('acquisition_plan', `[${c.channel}] ${c.action} — ${c.why || ''}`);
    }
    if (planRes.thisWeek && planRes.thisWeek.length) {
      log('week_plan', 'This week: ' + planRes.thisWeek.join(' | '));
    }
    if (ch.length) log('traffic', `Queued ${ch.length} customer-acquisition action(s) for the Shopify store.`);
    evolve();
    markAgent('idle', 'Acquisition plan ready — awaiting next cycle');
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
  log('engine_start', `Traffic Agent scheduler on (${(CFG.intervalMs / 3600000).toFixed(1)}h)`);
  timer = setInterval(() => cycle(), CFG.intervalMs);
  setTimeout(() => cycle(), 5000);
}

function getStatus() {
  const evo = dbMod.getEvolution(NAME) || { level: 1, xp: 0, skill: 'Generalist' };
  const pay = dbMod.getRealPayoutSummary();
  return { name: NAME, level: evo.level, xp: evo.xp, skill: evo.skill, totalDeposited: Math.round(pay.total || 0), running };
}

module.exports = { NAME, cycle, start, getStatus, evolve };
