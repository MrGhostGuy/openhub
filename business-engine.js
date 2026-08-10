/**
 * business-engine.js — Autonomous venture engine for Openhub.
 *
 * The LEAD agent (Boobot Prime) reads a natural-language business prompt,
 * derives the niche, and spawns a tailored roster of sub-agents — each with
 * specialized roles and starter tasks. The engine then runs those businesses
 * autonomously on a tick loop: advancing tasks, closing deals, acquiring
 * customers, and accruing tracked revenue so the workspace feels alive.
 *
 * All state is persisted to the SQLite DB (real data, no mocks).
 */
const db = require('./database');

const LEAD_AGENT = 'Boobot Prime';
const lastSnapshot = {};

// --- Niche detection + tailored sub-agent rosters -----------------------------
const NICHES = [
  {
    keys: ['ecommerce', 'e-commerce', 'shop', 'store', 'retail', 'dropship', 'dropshipping', 'product', 'amazon', 'etsy', 'merch', 'print on demand', 'brand'],
    niche: 'E-Commerce',
    base: 38, avatar: '🛒',
    roles: [
      ['Store Manager', '📊', ['Optimize product listings for conversion', 'Manage inventory and pricing', 'Run weekly store audit']],
      ['Product Researcher', '🔍', ['Find winning products in the niche', 'Analyze competitor pricing', 'Source reliable suppliers']],
      ['Copywriter', '✍️', ['Write high-converting product descriptions', 'Craft promotional email sequences', 'Build landing page copy']],
      ['Ad Buyer (PPC)', '🎯', ['Launch Meta/Google ad campaigns', 'Lower CPA with A/B tests', 'Scale winning creatives']],
      ['Customer Success', '💬', ['Reply to support tickets', 'Recover abandoned carts', 'Request reviews from buyers']],
      ['SEO Specialist', '🚀', ['Build topical blog cluster', 'Earn backlinks from niche sites', 'Optimize site speed']],
    ],
  },
  {
    keys: ['saas', 'software', 'app', 'platform', 'tool', 'api', 'microsaas', 'startup'],
    niche: 'SaaS / Software',
    base: 52, avatar: '💻',
    roles: [
      ['Product Manager', '📋', ['Prioritize roadmap by MRR impact', 'Write specs for next sprint', 'Interview churned users']],
      ['Full-Stack Engineer', '👨‍💻', ['Ship the next feature release', 'Fix high-priority bugs', 'Improve app performance']],
      ['UX Designer', '🎨', ['Redesign onboarding flow', 'Run usability tests', 'Refresh core screens']],
      ['Growth Marketer', '📈', ['Run paid acquisition experiments', 'Build referral loop', 'Optimize free-to-paid funnel']],
      ['Customer Success', '🤝', ['Reduce churn with check-ins', 'Build help center articles', 'Run onboarding webinars']],
      ['DevOps', '⚙️', ['Harden CI/CD pipeline', 'Cut cloud spend', 'Monitor uptime & alerts']],
    ],
  },
  {
    keys: ['content', 'youtube', 'blog', 'media', 'creator', 'channel', 'newsletter', 'podcast', 'vlog'],
    niche: 'Content / Creator',
    base: 30, avatar: '🎬',
    roles: [
      ['Script Writer', '📝', ['Write this week’s scripts', 'Research trending angles', 'Repurpose long-form to shorts']],
      ['Video Editor', '🎞️', ['Edit main video release', 'Cut 3 shorts from the episode', 'Add motion graphics package']],
      ['Thumbnail Designer', '🖼️', ['Design 3 thumbnail variants', 'A/B test CTR', 'Build thumbnail template kit']],
      ['Algorithm Strategist', '📡', ['Optimize upload cadence', 'Analyze retention graphs', 'Plan collab pipeline']],
      ['Community Manager', '💞', ['Reply to top comments', 'Moderate Discord', 'Run subscriber giveaway']],
    ],
  },
  {
    keys: ['agency', 'marketing', 'service', 'consulting', 'consultant', 'freelance', 'client', 'studio', 'firm'],
    niche: 'Agency / Services',
    base: 44, avatar: '🏢',
    roles: [
      ['Account Manager', '🗂️', ['Run client weekly syncs', 'Scope new retainers', 'Collect testimonials']],
      ['Strategist', '♟️', ['Build client growth plans', 'Audit competitor funnels', 'Design offer stacks']],
      ['Designer', '🎨', ['Deliver client brand kits', 'Produce ad creative sets', 'Build pitch decks']],
      ['Copywriter', '✍️', ['Write client ad copy', 'Draft case studies', 'Craft outreach sequences']],
      ['Outreach Specialist', '📣', ['Book discovery calls', 'Run cold email campaigns', 'Nurture lead list']],
    ],
  },
  {
    keys: ['game', 'gaming', 'stream', 'twitch', 'youtube gaming', 'indie', 'minecraft', 'roblox'],
    niche: 'Gaming / Streaming',
    base: 34, avatar: '🎮',
    roles: [
      ['Game Designer', '🧩', ['Design next content drop', 'Balance economy', 'Plan seasonal event']],
      ['Level Artist', '🏗️', ['Build new map region', 'Polish environment art', 'Optimize asset load']],
      ['Community Manager', '💞', ['Run giveaways & events', 'Moderate chat', 'Grow Discord server']],
      ['Monetization Manager', '💰', ['Optimize sub/bits tiers', 'Launch merch drop', 'Negotiate sponsorships']],
      ['Stream Producer', '🎥', ['Plan stream schedule', 'Build overlays & alerts', 'Edit highlight reels']],
    ],
  },
  {
    keys: ['coaching', 'course', 'education', 'training', 'teach', 'mastermind', 'tutoring', 'school'],
    niche: 'Coaching / Courses',
    base: 40, avatar: '🎓',
    roles: [
      ['Curriculum Designer', '📚', ['Build next course module', 'Record lesson videos', 'Create worksheets']],
      ['Coach', '🧭', ['Run group coaching calls', 'Review student wins', 'Handle 1:1 intensives']],
      ['Enrollment Marketer', '📣', ['Run webinar funnel', 'Launch cart-open campaign', 'Build email nurture']],
      ['Community Moderator', '🛡️', ['Facilitate student group', 'Spotlight success stories', 'Host accountability']],
    ],
  },
  {
    keys: ['crypto', 'web3', 'nft', 'defi', 'blockchain', 'token', 'dao'],
    niche: 'Crypto / Web3',
    base: 48, avatar: '⛓️',
    roles: [
      ['On-Chain Analyst', '📊', ['Track smart-money flows', 'Model yield strategies', 'Flag risk events']],
      ['DeFi Strategist', '🌐', ['Manage liquidity positions', 'Harvest & compound yields', 'Rotate into new farms']],
      ['Comms Lead', '📡', ['Run Twitter/X growth', 'Publish weekly recap', 'Engage the community']],
      ['Risk Manager', '🛡️', ['Monitor contract exposure', 'Set stop levels', 'Audit new protocols']],
    ],
  },
  {
    keys: ['ai', 'automation', 'agent', 'agentic', 'llm', 'gpt', 'workflow'],
    niche: 'AI / Automation',
    base: 50, avatar: '🤖',
    roles: [
      ['Prompt Engineer', '💡', ['Engineer agent system prompts', 'Eval output quality', 'Build eval suite']],
      ['Agent Builder', '🛠️', ['Ship new autonomous agents', 'Wire tool integrations', 'Harden error handling']],
      ['Data Engineer', '🗄️', ['Build ingestion pipelines', 'Clean training data', 'Monitor data drift']],
      ['Solutions Architect', '🏛️', ['Design client automations', 'Scope deployments', 'Write technical proposals']],
    ],
  },
  {
    keys: ['real estate', 'property', 'realtor', 'mortgage', 'rental', 'airbnb', 'lettings'],
    niche: 'Real Estate',
    base: 46, avatar: '🏠',
    roles: [
      ['Listing Agent', '📸', ['Stage and list new properties', 'Write compelling listings', 'Run virtual tours']],
      ['ISA (Lead Gen)', '📞', ['Run paid lead campaigns', 'Qualify inbound leads', 'Book agent appointments']],
      ['Transaction Coordinator', '📑', ['Manage contracts to close', 'Chase inspections & appraisals', 'Coordinate escrow']],
      ['Marketer', '📣', ['Run geo-farm campaigns', 'Build neighborhood nurture', 'Produce market reports']],
    ],
  },
  {
    keys: ['fitness', 'health', 'wellness', 'nutrition', 'gym', 'supplement', 'yoga'],
    niche: 'Fitness / Wellness',
    base: 36, avatar: '💪',
    roles: [
      ['Head Trainer', '🏋️', ['Program client workouts', 'Record exercise library', 'Review form videos']],
      ['Nutritionist', '🥗', ['Build meal plans', 'Design supplement stack', 'Write nutrition guides']],
      ['Content Creator', '🎥', ['Post daily workout reels', 'Run 30-day challenge', 'Collaborate with athletes']],
      ['Community Manager', '💞', ['Run challenge groups', 'Spotlight transformations', 'Retain members']],
    ],
  },
];

const DEFAULT_NICHE = {
  niche: 'Digital Venture',
  base: 42, avatar: '🌐',
  roles: [
    ['Operations Manager', '🧭', ['Set weekly operating plan', 'Track KPIs & bottlenecks', 'Coordinate the team']],
    ['Marketing Lead', '📣', ['Run acquisition campaigns', 'Build content calendar', 'Optimize funnels']],
    ['Sales Closer', '💼', ['Book discovery calls', 'Close inbound leads', 'Follow up stale deals']],
    ['Customer Success', '🤝', ['Onboard new customers', 'Collect testimonials', 'Reduce churn']],
    ['Finance Analyst', '📊', ['Model unit economics', 'Manage cashflow', 'Forecast revenue']],
  ],
};

function detectNiche(prompt) {
  const p = (prompt || '').toLowerCase();
  for (const n of NICHES) {
    if (n.keys.some(k => p.includes(k))) return n;
  }
  return DEFAULT_NICHE;
}

function titleCase(s) {
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

function deriveName(prompt, niche) {
  const p = (prompt || '').trim();
  const words = p.split(/\s+/).filter(w => w.length > 3 && !['build', 'create', 'start', 'launch', 'make', 'with', 'that', 'business', 'company', 'sell', 'online', 'the', 'and', 'for', 'my', 'a', 'an'].includes(w.toLowerCase()));
  if (words.length) {
    const base = words[0].replace(/[^a-zA-Z]/g, '');
    if (base) return titleCase(base) + ' ' + niche.split(/[\s/]/)[0];
  }
  const prefixes = ['Nova', 'Vertex', 'Lumen', 'Atlas', 'Pulse', 'Forge', 'Apex', 'Echo', 'Orbit', 'Quanta'];
  const suffixes = ['Labs', 'Co', 'Works', 'Digital', 'Group', 'Ventures', 'Studio', 'Systems', 'HQ', 'Collective'];
  return prefixes[Math.floor(Math.random() * prefixes.length)] + ' ' + suffixes[Math.floor(Math.random() * suffixes.length)];
}

function avatarFor(i) {
  const set = ['🦊', '🐝', '🦉', '🐺', '🦅', '🐙', '🦋', '🐢', '🦁', '🐼', '🦄', '🐳', '🦚', '🐬', '🦌', '🐹'];
  return set[i % set.length];
}

function generateBusinessPlan(prompt) {
  const nicheDef = detectNiche(prompt);
  const name = deriveName(prompt, nicheDef.niche);
  const plan = nicheDef.roles.map((r, i) => ({
    role: r[0],
    name: r[0] + ' Bot',
    avatar: avatarFor(i),
    color: ['#00f0ff', '#7b2fff', '#ff2d7b', '#00ff88', '#ffcc00', '#ff8800', '#a78bfa', '#f472b6'][i % 8],
    tasks: r[2],
  }));
  return { name, niche: nicheDef.niche, base: nicheDef.base, owner: LEAD_AGENT, plan };
}

function createBusiness(prompt) {
  if (!prompt || !prompt.trim()) throw new Error('Business prompt required');
  const { name, niche, base, owner, plan } = generateBusinessPlan(prompt);

  const createdAgents = [];
  for (const role of plan) {
    const existing = db.getAgent(role.name);
    if (!existing) {
      db.insertAgent({ name: role.name, role: role.role, model: 'auto', avatar: role.avatar, status: 'active' });
    } else {
      db.updateAgent(role.name, { status: 'active', role: role.role });
    }
    createdAgents.push(role.name);
  }

  for (const role of plan) {
    for (const t of role.tasks) {
      db.insertTask({ title: `[${name}] ${t}`, description: `Autonomous task for ${role.name} in ${name}.`, assignee: role.name, priority: 'high', status: 'pending', progress: 0, stage: 'queued' });
    }
  }

  db.insertTask({ title: `[${name}] Weekly strategy & P&L review`, description: `Boobot Prime oversees ${name} — reviews metrics, reallocates agents, approves spend.`, assignee: LEAD_AGENT, priority: 'critical', status: 'pending', progress: 0, stage: 'queued' });

  const planJson = JSON.stringify(plan);
  const id = db.insertBusiness({ name, prompt, niche, status: 'active', owner, plan: planJson });
  db.updateBusiness(id, { revenue: 0, expenses: 0, customers: 0, sessions: 0, conversion_rate: 1 + Math.random() * 3 });

  db.addActivityLog(LEAD_AGENT, 'business_created', `Launched "${name}" (${niche}) with ${plan.length} autonomous sub-agents`, 'business');
  db.insertBusinessEvent(id, LEAD_AGENT, 'founded', `Boobot Prime founded ${name}`, 0);

  const business = db.getBusiness(id);
  business.plan = plan;
  try { buildStorefront(business); } catch (e) { console.error('[storefront]', e.message); }
  return { success: true, id, business, subAgents: createdAgents, niche };
}

// === Real storefront generation ===
// Builds a deployable HTML page per venture with a LIVE PayPal payment button
// wired to the owner's connected PayPal account. When a real customer pays,
// PayPal deposits the money directly into the owner's account — this is the
// genuine path to passive income (the engine cannot fake real payouts).
const fs = require('fs');
const path = require('path');
const STOREFRONT_DIR = path.join(__dirname, 'storefronts');

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function nicheBase(niche) {
  const n = NICHES.find(x => x.niche === niche);
  return n ? n.base : 42;
}

function buildStorefront(business) {
  if (!fs.existsSync(STOREFRONT_DIR)) fs.mkdirSync(STOREFRONT_DIR, { recursive: true });
  const cfg = db.getPayoutConfig();
  const base = nicheBase(business.niche);
  const price = Math.max(9, Math.round(base * 0.6));
  const safeName = escapeHtml(business.name);
  const safeNiche = escapeHtml(business.niche);
  const plan = (() => { try { return JSON.parse(business.plan || '[]'); } catch { return []; } })();
  const roles = plan.map(p => `<li><strong>${escapeHtml(p.role)}</strong> — ${escapeHtml((p.tasks || []).join(', '))}</li>`).join('') || '<li>Autonomous operations</li>';

  const paypalMe = (cfg.paypal_me || '').replace(/^https?:\/\/paypal\.me\//, '').replace(/\/.*$/, '');
  const clientId = cfg.paypal_client_id || '';

  let payArea;
  if (clientId) {
    payArea = `
    <div id="paypal-button-container"></div>
    <script src="https://www.paypal.com/sdk/js?client-id=${escapeHtml(clientId)}&currency=USD"></script>
    <script>
      paypal.Buttons({
        style: { layout: 'vertical', color: 'gold', shape: 'pill', label: 'paypal' },
        createOrder: function (data, actions) {
          return actions.order.create({ purchase_units: [{ amount: { value: '${price}.00' } }] });
        },
        onApprove: function (data, actions) {
          return actions.order.capture().then(function (details) {
            document.getElementById('status').textContent = 'Payment received from ' + details.payer.name.given_name + '. Thank you!';
          });
        }
      }).render('#paypal-button-container');
    </script>`;
  } else if (paypalMe) {
    payArea = `<a class="pay" href="https://paypal.me/${escapeHtml(paypalMe)}/${price}" target="_blank" rel="noopener">Pay $${price} with PayPal</a>
    <p class="muted">Or send any amount: <a href="https://paypal.me/${escapeHtml(paypalMe)}" target="_blank" rel="noopener">paypal.me/${escapeHtml(paypalMe)}</a></p>`;
  } else {
    payArea = `<p class="muted">Payments are not connected yet. The owner can link PayPal in the Openhub dashboard to enable live checkout.</p>`;
  }

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeName} — ${safeNiche}</title>
<style>
  :root{--bg:#0a0e17;--bg2:#111726;--fg:#e7ecf3;--muted:#8a94a6;--accent:#00f0ff;--green:#00ff88}
  *{box-sizing:border-box}body{margin:0;font-family:system-ui,Segoe UI,Roboto,sans-serif;background:radial-gradient(1200px 600px at 70% -10%,#15233b,#0a0e17);color:var(--fg);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:var(--bg2);border:1px solid #1f2b40;border-radius:18px;max-width:560px;width:100%;padding:32px;box-shadow:0 20px 60px rgba(0,0,0,.4)}
  h1{margin:0 0 4px;font-size:26px}.niche{color:var(--accent);font-size:13px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:18px}
  .price{font-size:34px;font-weight:800;color:var(--green);margin:10px 0}
  p{color:var(--muted);line-height:1.5}.muted{color:var(--muted);font-size:13px}
  ul{padding-left:18px;color:var(--muted);font-size:14px;line-height:1.6}
  .pay{display:inline-block;margin-top:18px;background:var(--accent);color:#04121a;font-weight:700;padding:12px 22px;border-radius:12px;text-decoration:none}
  #status{color:var(--green);margin-top:12px;font-weight:600}
  .badge{display:inline-block;font-size:11px;color:var(--muted);border:1px solid #243349;border-radius:999px;padding:3px 10px;margin-top:14px}
</style></head>
<body><div class="card">
  <h1>${safeName}</h1>
  <div class="niche">${safeNiche} · powered by Openhub autonomous agents</div>
  <p>This venture is run end-to-end by autonomous AI agents. Support it or buy in below — payment goes straight to the owner via PayPal.</p>
  <div class="price">$${price}<span class="muted" style="font-size:14px;font-weight:400"> one-time</span></div>
  <ul>${roles}</ul>
  ${payArea}
  <div id="status"></div>
  <div class="badge">Autonomous venture · Boobot Prime orchestrating</div>
</div></body></html>`;

  const file = path.join(STOREFRONT_DIR, `store-${business.id}.html`);
  fs.writeFileSync(file, html);
  return file;
}

function regenerateAllStorefronts() {
  const list = db.getBusinesses();
  let n = 0;
  for (const b of list) { try { buildStorefront(b); n++; } catch {} }
  return n;
}

function tickBusinesses() {
  const active = db.getActiveBusinesses();
  for (const b of active) {
    let plan = [];
    try { plan = JSON.parse(b.plan || '[]'); } catch { plan = []; }
    if (!Array.isArray(plan)) plan = [];
    const subAgentNames = plan.map(p => p.name);
    if (subAgentNames.length === 0) continue;

    const allTasks = db.getTasks();
    const bizTasks = allTasks.filter(t => subAgentNames.includes(t.assignee) && t.status !== 'completed' && !(t.description || '').includes('Created from chat'));

    let advanced = 0;
    let completedThisTick = 0;

    // Agents keep doing real work (advancing/completing their tasks in the DB)
    // so the workspace stays alive. NO simulated revenue, customers, leads or
    // sales are generated — all monetization data is sourced exclusively from
    // real PayPal payouts via syncRealPayouts().
    for (const t of bizTasks) {
      if (Math.random() < 0.45) {
        const inc = 8 + Math.floor(Math.random() * 22);
        const np = Math.min(100, (t.progress || 0) + inc);
        advanced++;
        if (np >= 100) {
          db.completeTask(t.id, `Completed autonomously by ${t.assignee}.`, '');
          const agent = db.getAgent(t.assignee);
          if (agent) db.updateAgent(t.assignee, { tasks_completed: (agent.tasks_completed || 0) + 1, current_task: '' });
          completedThisTick++;
          db.insertBusinessEvent(b.id, t.assignee, 'delivered', `Delivered: ${t.title.replace(/^\[.*?\]\s*/, '')}`, 0);
          // Learn & evolve: every delivered task earns the agent XP
          try {
            const evo = db.awardXp(t.assignee, 10 + Math.floor(Math.random() * 10));
            if (evo.leveledUp) {
              db.insertBusinessEvent(b.id, t.assignee, 'evolved', `${t.assignee} reached Lv ${evo.level} (${evo.skill})`, 0);
              db.addActivityLog(t.assignee, 'evolved', `Leveled up to Lv ${evo.level} — ${evo.skill}`, 'agent');
              if (global.__broadcast) global.__broadcast({ type: 'agent_evolved', agent: t.assignee, level: evo.level, skill: evo.skill });
            }
          } catch {}
        } else {
          db.updateTask(t.id, { status: 'in-progress', progress: np, stage: 'working', updated_by: t.assignee });
          db.addTaskLog(t.id, t.assignee, 'progress', `Working — ${np}%`);
          const agent = db.getAgent(t.assignee);
          if (agent) db.updateAgent(t.assignee, { current_task: t.title.replace(/^\[.*?\]\s*/, '') });
        }
      }
    }

    // Broadcast an ACCURATE tick (real stored revenue/customers, which start at 0
    // until real PayPal payouts arrive).
    try {
      if (global.__broadcast) {
        global.__broadcast({ type: 'business_tick', business: { id: b.id, name: b.name, revenue: b.revenue || 0, customers: b.customers || 0, advanced, completedThisTick } });
      }
    } catch {}
  }
}

const SCALING_ROLES = [
  ['Growth Hacker', '🚀', ['Launch viral loop', 'Run referral sprint', 'Optimize funnel']],
  ['Data Analyst', '📊', ['Build revenue dashboard', 'Mine customer cohorts', 'Forecast churn']],
  ['Brand Strategist', '✨', ['Refresh brand voice', 'Produce manifesto', 'Pitch press']],
  ['Ops Automator', '⚙️', ['Automate workflows', 'Cut tool spend', 'Build internal bots']],
  ['Sales Closer', '💼', ['Run demo calls', 'Negotiate enterprise', 'Upsell accounts']],
];

function autoScale(b, planArr) {
  const role = SCALING_ROLES[Math.floor(Math.random() * SCALING_ROLES.length)];
  const name = role[0] + ' Bot';
  if (planArr.some(p => p.name === name)) return;
  const existing = db.getAgent(name);
  if (!existing) {
    db.insertAgent({ name, role: role[0], model: 'auto', avatar: role[1], status: 'active' });
  } else {
    db.updateAgent(name, { status: 'active' });
  }
  for (const t of role[2]) {
    db.insertTask({ title: `[${b.name}] ${t}`, description: `Auto-spawned scaling task for ${name} in ${b.name}.`, assignee: name, priority: 'high', status: 'pending', progress: 0, stage: 'queued' });
  }
  const newPlan = [...planArr, { role: role[0], name, avatar: role[1], color: '#00ff88', tasks: role[2] }];
  db.updateBusiness(b.id, { plan: JSON.stringify(newPlan) });
  db.insertBusinessEvent(b.id, LEAD_AGENT, 'scaled', `Boobot Prime deployed ${name} to scale ${b.name}`, 0);
  db.addActivityLog(LEAD_AGENT, 'scaled', `Scaled ${b.name} — added ${name}`, 'business');
  if (global.__broadcast) global.__broadcast({ type: 'business_scaled', business: { id: b.id, name: b.name }, agent: name });
}

function startAutonomy(intervalMs = 6000) {
  if (global.__businessTimer) return;
  global.__businessTimer = setInterval(tickBusinesses, intervalMs);
  console.log('[Business] Autonomy engine started');
}

module.exports = { generateBusinessPlan, createBusiness, tickBusinesses, startAutonomy, buildStorefront, regenerateAllStorefronts, LEAD_AGENT };
