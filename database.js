/**
 * database.js — SQLite persistence layer for Openhub
 * All data is real, persisted to disk. No mock data, no in-memory-only stores.
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, 'dashboard.db');
let db = null;

// ---- Shared Pollinations throttle ---------------------------------------
// The free anonymous Pollinations tier is rate-limited (~1 req / 15s). Both
// the POD engine and the income agent call it, so they MUST share ONE
// serialized stream or they collide and get 429s. This enforces that, and
// crucially measures the gap from when the PREVIOUS request COMPLETED (not
// when its gate opened) so back-to-back calls never land inside the window.
let _pollChain = Promise.resolve();
function pollinationsThrottle(hasKey) {
  const gap = hasKey ? 400 : 12000; // ms between request completions
  const prev = _pollChain;
  const next = prev.catch(() => {}).then(() => new Promise(r => setTimeout(r, gap)));
  _pollChain = next;
  return next;
}

// ---- Shared LLM result cache -------------------------------------------
// Avoids redundant LLM calls when the same prompt is used across agents.
// TTL: 30 minutes (stale results are worse than fresh ones).
const _llmCache = new Map();
const LLM_CACHE_TTL = 30 * 60 * 1000; // 30 min
function llmCacheKey(system, user) {
  // Simple hash for cache key
  let h = 0;
  const s = (system || '').slice(0, 200) + '||' + (user || '').slice(0, 200);
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return 'llm_' + (h >>> 0).toString(36);
}
function llmCacheGet(system, user) {
  const key = llmCacheKey(system, user);
  const entry = _llmCache.get(key);
  if (entry && Date.now() - entry.ts < LLM_CACHE_TTL) return entry.result;
  _llmCache.delete(key);
  return null;
}
function llmCacheSet(system, user, result) {
  const key = llmCacheKey(system, user);
  _llmCache.set(key, { result, ts: Date.now() });
  // Prune old entries if cache gets too large
  if (_llmCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of _llmCache) {
      if (now - v.ts > LLM_CACHE_TTL) _llmCache.delete(k);
    }
  }
}

async function initDatabase() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
    console.log('[DB] Loaded existing database from disk');
  } else {
    db = new SQL.Database();
    console.log('[DB] Created new database');
  }

  // Create tables if they don't exist
  db.run(`CREATE TABLE IF NOT EXISTS agents (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL, status TEXT DEFAULT 'idle', model TEXT, tasks_completed INTEGER DEFAULT 0, current_task TEXT DEFAULT '', avatar TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT DEFAULT '', assignee TEXT DEFAULT '', priority TEXT DEFAULT 'medium', status TEXT DEFAULT 'pending', progress INTEGER DEFAULT 0, stage TEXT DEFAULT 'queued', result TEXT DEFAULT '', result_files TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT DEFAULT '')`);
  db.run(`CREATE TABLE IF NOT EXISTS task_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, agent_name TEXT DEFAULT '', action TEXT NOT NULL, detail TEXT DEFAULT '', timestamp TEXT DEFAULT (datetime('now')), FOREIGN KEY(task_id) REFERENCES tasks(id))`);
  db.run(`CREATE TABLE IF NOT EXISTS agent_communications (id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, message TEXT NOT NULL, task_id INTEGER DEFAULT 0, timestamp TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_name TEXT DEFAULT '', task_id INTEGER DEFAULT 0, rating INTEGER DEFAULT 5, comment TEXT DEFAULT '', category TEXT DEFAULT 'general', applied INTEGER DEFAULT 0, timestamp TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS learning_log (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_name TEXT NOT NULL, lesson TEXT NOT NULL, source TEXT DEFAULT '', applied_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS pipeline_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, stage TEXT NOT NULL, status TEXT DEFAULT 'pending', duration_seconds INTEGER DEFAULT 0, log TEXT DEFAULT '', started_at TEXT DEFAULT '', completed_at TEXT DEFAULT '')`);
  db.run(`CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, recipient TEXT DEFAULT 'broadcast', message TEXT NOT NULL, channel TEXT DEFAULT 'main', timestamp TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS completed_deliverables (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, task_title TEXT DEFAULT '', deliverable_type TEXT DEFAULT 'file', file_path TEXT DEFAULT '', description TEXT DEFAULT '', agent_name TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))`);

  // === NEW TABLES ===
  db.run(`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT DEFAULT '', status TEXT DEFAULT 'active', category TEXT DEFAULT 'general', repo_url TEXT DEFAULT '', live_url TEXT DEFAULT '', notes TEXT DEFAULT '', last_worked_at TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS project_history (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, change_type TEXT DEFAULT 'update', description TEXT NOT NULL, agent_name TEXT DEFAULT 'System', timestamp TEXT DEFAULT (datetime('now')), FOREIGN KEY(project_id) REFERENCES projects(id))`);
  db.run(`CREATE TABLE IF NOT EXISTS pinned_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, reason TEXT DEFAULT '', pinned_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(task_id) REFERENCES tasks(id))`);
  db.run(`CREATE TABLE IF NOT EXISTS subagent_activities (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_name TEXT NOT NULL, activity_type TEXT DEFAULT 'optimization', description TEXT NOT NULL, target TEXT DEFAULT '', status TEXT DEFAULT 'pending', result TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), completed_at TEXT DEFAULT '')`);
  db.run(`CREATE TABLE IF NOT EXISTS skills (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT DEFAULT '', category TEXT DEFAULT 'general', source TEXT DEFAULT 'clawhub', install_path TEXT DEFAULT '', enabled INTEGER DEFAULT 0, icon TEXT DEFAULT '🔧', version TEXT DEFAULT '1.0.0', author TEXT DEFAULT '', installed_at TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_name TEXT DEFAULT 'System', action TEXT NOT NULL, detail TEXT DEFAULT '', category TEXT DEFAULT 'system', timestamp TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, message TEXT NOT NULL, type TEXT DEFAULT 'info', agent_name TEXT DEFAULT 'System', read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);

  // === BUSINESSES (autonomous venture engine) ===
  db.run(`CREATE TABLE IF NOT EXISTS businesses (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, prompt TEXT NOT NULL, niche TEXT DEFAULT 'general', status TEXT DEFAULT 'planning', revenue REAL DEFAULT 0, expenses REAL DEFAULT 0, customers INTEGER DEFAULT 0, sessions INTEGER DEFAULT 0, conversion_rate REAL DEFAULT 0, plan TEXT DEFAULT '[]', owner TEXT DEFAULT 'Boobot Prime', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS business_events (id INTEGER PRIMARY KEY AUTOINCREMENT, business_id INTEGER, agent_name TEXT DEFAULT '', event_type TEXT DEFAULT 'action', description TEXT NOT NULL, value REAL DEFAULT 0, timestamp TEXT DEFAULT (datetime('now')), FOREIGN KEY(business_id) REFERENCES businesses(id))`);
  db.run(`CREATE TABLE IF NOT EXISTS agent_evolution (agent_name TEXT PRIMARY KEY, level INTEGER DEFAULT 1, xp INTEGER DEFAULT 0, skill TEXT DEFAULT 'Generalist', personality TEXT DEFAULT 'steady', evolved_at TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS metric_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, business_id INTEGER, revenue REAL DEFAULT 0, customers INTEGER DEFAULT 0, profit REAL DEFAULT 0, ts INTEGER DEFAULT 0, FOREIGN KEY(business_id) REFERENCES businesses(id))`);
  db.run(`CREATE TABLE IF NOT EXISTS payout_config (id INTEGER PRIMARY KEY CHECK (id = 1), paypal_me TEXT DEFAULT '', paypal_client_id TEXT DEFAULT '', paypal_client_secret TEXT DEFAULT '', connected INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS real_payouts (id INTEGER PRIMARY KEY AUTOINCREMENT, paypal_id TEXT UNIQUE, amount REAL DEFAULT 0, currency TEXT DEFAULT 'USD', status TEXT DEFAULT '', payer TEXT DEFAULT '', ts INTEGER DEFAULT 0, raw TEXT DEFAULT '')`);
  // Auto-scheduler config for the monetization automation (runs 1-2x/day)
  db.run(`CREATE TABLE IF NOT EXISTS scheduler_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER DEFAULT 1,
    times TEXT DEFAULT '["09:00","18:00"]',   -- HH:MM local times to fire
    last_pod_run TEXT DEFAULT '',
    last_income_run TEXT DEFAULT '',
    last_full_run TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  // === POD (Print-on-Demand) automation engine ===
  db.run(`CREATE TABLE IF NOT EXISTS pod_research (id INTEGER PRIMARY KEY AUTOINCREMENT, niche TEXT DEFAULT 'general', themes TEXT DEFAULT '[]', product_types TEXT DEFAULT '[]', rationale TEXT DEFAULT '', source TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS pod_designs (id INTEGER PRIMARY KEY AUTOINCREMENT, research_id INTEGER DEFAULT 0, niche TEXT DEFAULT 'general', product_type TEXT DEFAULT '', title TEXT DEFAULT '', prompt TEXT DEFAULT '', image_path TEXT DEFAULT '', image_status TEXT DEFAULT 'none', created_at TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS pod_products (id INTEGER PRIMARY KEY AUTOINCREMENT, design_id INTEGER DEFAULT 0, niche TEXT DEFAULT 'general', product_type TEXT DEFAULT '', title TEXT DEFAULT '', printify_product_id TEXT DEFAULT '', etsy_listing_id TEXT DEFAULT '', status TEXT DEFAULT 'pending', error TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))`);

  // === Migrations (add columns that may not exist on older DBs) ===
  function addColumn(table, col, def) {
    try {
      const info = db.exec(`PRAGMA table_info(${table})`);
      const cols = info.length ? info[0].values.map(r => r[1]) : [];
      if (!cols.includes(col)) db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    } catch (e) { /* ignore */ }
  }
  addColumn('agents', 'last_activity', "TEXT DEFAULT ''");
  addColumn('agents', 'kind', "TEXT DEFAULT 'agent'");
  addColumn('real_payouts', 'stream_id', "INTEGER DEFAULT 0");

  // Passive-income streams tracked by the Income Strategist agent
  db.run(`CREATE TABLE IF NOT EXISTS income_streams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    method TEXT DEFAULT '',
    status TEXT DEFAULT 'brainstorming',
    rationale TEXT DEFAULT '',
    paypal_mechanism TEXT DEFAULT '',
    success_rate REAL DEFAULT 0,
    steps TEXT DEFAULT '[]',
    deposits_usd REAL DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  // Daily Shopify plan: which designs go on which products TODAY
  db.run(`CREATE TABLE IF NOT EXISTS pod_daily_plan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    niche TEXT DEFAULT 'general',
    theme TEXT DEFAULT '',
    product_type TEXT DEFAULT '',
    design_hint TEXT DEFAULT '',
    rationale TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // Seed default agents if none exist — Boobot Prime (main orchestrator) and Jorm
  const agentCount = db.exec("SELECT COUNT(*) as cnt FROM agents");
  if (agentCount.length === 0 || agentCount[0].values[0][0] === 0) {
    db.run(`INSERT INTO agents (name, role, status, model, avatar) VALUES (?, ?, ?, ?, ?)`,
      ['Boobot Prime', 'Main Orchestrator & AI Assistant', 'active', 'openrouter/openrouter/owl-alpha', '🤖']);
    db.run(`INSERT INTO agents (name, role, status, model, avatar) VALUES (?, ?, ?, ?, ?)`,
      ['Jorm', 'AI Assistant & Dashboard', 'active', 'openrouter/openrouter/owl-alpha', '🦑']);
    console.log('[DB] Seeded default agents: Boobot Prime, Jorm');
  }

  // Seed default skills if none exist
  const skillCount = db.exec("SELECT COUNT(*) as cnt FROM skills");
  if (skillCount.length === 0 || skillCount[0].values[0][0] === 0) {
    const defaultSkills = [
      { name: 'GitHub Integration', description: 'Full GitHub API access — issues, PRs, CI runs, code review, API queries', category: 'development', icon: '🐙' },
      { name: 'Weather & Forecast', description: 'Get current weather, rain, temperature, and forecasts for any location', category: 'utilities', icon: '🌤️' },
      { name: 'Healthcheck', description: 'Audit and harden hosts for SSH, firewall, updates, exposure, cron checks', category: 'security', icon: '🛡️' },
      { name: 'Browser Automation', description: 'Control web pages — multi-step flows, login checks, tab management', category: 'automation', icon: '🌐' },
      { name: 'Video Frames', description: 'Extract frames or short clips from videos using ffmpeg', category: 'media', icon: '🎬' },
      { name: 'TaskFlow', description: 'Coordinate multi-step detached tasks as one durable TaskFlow job', category: 'automation', icon: '⚡' },
      { name: 'Skill Creator', description: 'Create, edit, improve, tidy, review AgentSkills and SKILL.md files', category: 'development', icon: '🛠️' },
      { name: 'Node Connect', description: 'Diagnose OpenClaw Android, iOS, or macOS node pairing failures', category: 'utilities', icon: '📱' },
      { name: 'GH Issues', description: 'Fetch GitHub issues, delegate fixes to subagents, open PRs', category: 'development', icon: '🔍' },
      { name: 'Inbox Triage', description: 'TaskFlow pattern for inbox triage, intent routing, waiting on replies', category: 'automation', icon: '📬' },
      { name: 'Code Review', description: 'Automated code review with security, performance, and style analysis', category: 'development', icon: '🔎' },
      { name: 'Discord Bot', description: 'Full Discord bot management — messages, channels, roles, permissions', category: 'social', icon: '💬' },
      { name: 'Twitch Integration', description: 'Twitch API — stream status, clips, VODs, chat, channel management', category: 'social', icon: '📺' },
      { name: 'File Transfer', description: 'Transfer files between nodes with progress tracking', category: 'utilities', icon: '📁' },
      { name: 'Image Generation', description: 'Generate and edit images with AI — DALL-E, Stable Diffusion', category: 'media', icon: '🎨' },
      { name: 'Voice Synthesis', description: 'Text-to-speech with ElevenLabs — natural voices, multiple languages', category: 'media', icon: '🔊' },
      { name: 'Web Scraping', description: 'Extract structured data from any website with intelligent parsing', category: 'automation', icon: '🕷️' },
      { name: 'Database Tools', description: 'Query, manage, and migrate SQLite, PostgreSQL, MySQL databases', category: 'development', icon: '🗄️' },
      { name: 'API Builder', description: 'Build and deploy REST APIs with automatic documentation', category: 'development', icon: '🔌' },
      { name: 'Security Scanner', description: 'Scan for vulnerabilities, exposed ports, and misconfigurations', category: 'security', icon: '🔒' }
    ];
    for (const s of defaultSkills) {
      db.run(`INSERT INTO skills (name, description, category, source, icon) VALUES (?, ?, ?, ?, ?)`, [s.name, s.description, s.category, 'clawhub', s.icon]);
    }
    console.log('[DB] Seeded default skills');
  }

  // Seed default projects if none exist
  const projCount = db.exec("SELECT COUNT(*) as cnt FROM projects");
  if (projCount.length === 0 || projCount[0].values[0][0] === 0) {
    const defaultProjects = [
      { name: 'Perfect Dashboard', description: 'Real-data-only agent command center with learning feedback loop, gaming UI, Twitch integration, chat, deliverables repo', status: 'active', category: 'infrastructure', notes: 'Running on port 3000. Chat is landing page with AI responses via OpenRouter. Jorm Avatar with expressive animated states. Agent Office with visual floor plan. Claw3D 3D Office integration.' },
      { name: 'Claw3D Integration', description: 'Open-source 3D virtual office for AI agents, integrated into Perfect Dashboard as 3D Office tab', status: 'active', category: 'infrastructure', notes: 'Runs on port 3002, connects to OpenClaw Gateway via WebSocket. Embedded as iframe in dashboard. Device paired and approved.' },
      { name: 'Mission Control', description: 'Deprecated — was 100% mock data. Replaced by Perfect Dashboard.', status: 'archived', category: 'legacy', notes: 'No longer maintained. All data migrated to Perfect Dashboard.' }
    ];
    for (const p of defaultProjects) {
      db.run(`INSERT INTO projects (name, description, status, category, notes) VALUES (?, ?, ?, ?, ?)`, [p.name, p.description, p.status, p.category, p.notes]);
    }
    // Add project history
    db.run(`INSERT INTO project_history (project_id, change_type, description, agent_name) VALUES (1, 'update', 'Added Live Activity Log with real-time WebSocket streaming', 'Jorm')`);
    db.run(`INSERT INTO project_history (project_id, change_type, description, agent_name) VALUES (1, 'update', 'Added comprehensive Task History / Taskboard with completed, in-progress, and pinned views', 'Jorm')`);
    db.run(`INSERT INTO project_history (project_id, change_type, description, agent_name) VALUES (1, 'update', 'Added Project Tracker with change history and last-worked-on timestamps', 'Jorm')`);
    db.run(`INSERT INTO project_history (project_id, change_type, description, agent_name) VALUES (1, 'update', 'Added Sub-Agent Proactivity System for autonomous optimization', 'Jorm')`);
    db.run(`INSERT INTO project_history (project_id, change_type, description, agent_name) VALUES (1, 'update', 'Added Skills/Abilities page with ClawHub browser and auto-enable', 'Jorm')`);
    db.run(`INSERT INTO project_history (project_id, change_type, description, agent_name) VALUES (1, 'feature', 'Full Claw3D 3D Workspace integration with real agent data', 'Jorm')`);
    db.run(`INSERT INTO project_history (project_id, change_type, description, agent_name) VALUES (2, 'feature', 'Claw3D device paired with OpenClaw Gateway', 'Jorm')`);
    console.log('[DB] Seeded default projects');
  }

  persist();
  return db;
}

// Coalesced, throttled disk writer. Previously every addActivityLog /
// updateAgent / POD step called persist() which did a SYNCHRONOUS full
// db.export() + writeFileSync of the whole DB. On a busy automation
// cycle that blocks the event loop hundreds of times and is the main
// source of UI lag. Now writes are debounced to at most once per
// PERSIST_INTERVAL ms, and multiple calls within the window collapse
// into a single write.
const PERSIST_INTERVAL = 2000;
let _persistTimer = null;
let _persistPending = false;
function persist() {
  if (!db) return;
  _persistPending = true;
  if (_persistTimer) return; // already scheduled
  const flush = () => {
    _persistTimer = null;
    if (!_persistPending) return;
    _persistPending = false;
    try {
      const data = db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch (e) { /* keep going */ }
  };
  _persistTimer = setTimeout(flush, PERSIST_INTERVAL);
}

// Register once at module level to avoid MaxListenersExceeded
if (typeof process !== 'undefined') {
  process.once('beforeExit', () => { if (db && _persistPending) { _persistPending = false; try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch (e) {} } });
}

// Rebuild the DB file without deleted-row slack (a VACUUM for sql.js,
// which has no native VACUUM). Exports a fresh copy and writes it,
// shrinking the on-disk file. Used by /api/optimize.
function compact() {
  if (!db) return;
  const fresh = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(fresh));
  _persistPending = false;
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
}

function getDb() { return db; }

// === Agent Operations ===
function getAgents() {
  const rows = db.exec("SELECT * FROM agents ORDER BY id");
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}
function getAgent(name) {
  const rows = db.exec("SELECT * FROM agents WHERE name = ?", [name]);
  if (!rows.length || !rows[0].values.length) return null;
  const cols = rows[0].columns; const obj = {};
  cols.forEach((c, i) => obj[c] = rows[0].values[0][i]);
  return obj;
}
function updateAgent(name, fields) {
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const vals = [...Object.values(fields), name];
  db.run(`UPDATE agents SET ${sets}, updated_at = datetime('now') WHERE name = ?`, vals);
  persist();
}
function insertAgent(agent) {
  db.run(`INSERT INTO agents (name, role, status, model, avatar) VALUES (?, ?, ?, ?, ?)`, [agent.name, agent.role, agent.status || 'idle', agent.model || '', agent.avatar || '']);
  persist();
}

// Upsert an agent's live status. Creates the agent if it doesn't exist
// (used for autonomous sub-agents like POD-Research / POD-Maker) and always
// stamps last_activity so frozen-detection works.
const AGENT_ALLOWED = ['status', 'current_task', 'model', 'avatar', 'role', 'kind', 'tasks_completed'];
function touchAgent(name, fields = {}) {
  const existing = getAgent(name);
  const sets = [];
  const vals = [];
  for (const k of Object.keys(fields)) {
    if (AGENT_ALLOWED.includes(k)) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  }
  sets.push("last_activity = datetime('now')");
  sets.push("updated_at = datetime('now')");
  if (existing) {
    db.run(`UPDATE agents SET ${sets.join(', ')} WHERE name = ?`, [...vals, name]);
  } else {
    db.run(`INSERT INTO agents (name, role, status, avatar, kind, current_task) VALUES (?, ?, ?, ?, ?, ?)`,
      [name, fields.role || 'Autonomous Sub-Agent', fields.status || 'idle', fields.avatar || '🤖', fields.kind || 'subagent', fields.current_task || '']);
  }
  persist();
}

// Create an agent only if it doesn't already exist (idempotent).
function ensureAgent(name, fields = {}) {
  if (!getAgent(name)) {
    db.run(`INSERT INTO agents (name, role, status, avatar, kind, current_task) VALUES (?, ?, ?, ?, ?, ?)`,
      [name, fields.role || 'Autonomous Sub-Agent', fields.status || 'idle', fields.avatar || '🤖', fields.kind || 'subagent', fields.current_task || '']);
    persist();
  }
}

// Live agent view with a computed "state":
//   active/working/idle  -> as stored
//   frozen               -> was active/working but hasn't reported in `frozenMs`
function getAgentsLive(frozenMs = 15 * 60 * 1000) {
  const rows = getAgents();
  const now = Date.now();
  return rows.map(a => {
    let last = 0;
    if (a.last_activity) {
      const t = new Date(String(a.last_activity).replace(' ', 'T') + 'Z').getTime();
      if (!isNaN(t)) last = t;
    }
    const secSince = last ? Math.floor((now - last) / 1000) : -1;
    const st = (a.status || 'idle').toLowerCase();
    let state = st;
    if ((st === 'active' || st === 'working') && secSince >= 0 && secSince * 1000 > frozenMs) state = 'frozen';
    return { ...a, last_activity_ms: last, seconds_since_activity: secSince, state };
  });
}

// Real activity stream (the unified POD + system log used by the UI).
// Cached briefly: the dashboard polls /api/activity often and re-parsing
// the whole activity_log table on every poll is wasteful.
const _actCache = new Map();
const _actAt = new Map();
function getActivityLog(limit = 100, category = null) {
  const key = limit + '|' + (category || '');
  const now = Date.now();
  if (_actCache.has(key) && now - (_actAt.get(key) || 0) < 1500) return _actCache.get(key);
  const out = computeActivityLog(limit, category);
  _actCache.set(key, out); _actAt.set(key, now);
  return out;
}
function computeActivityLog(limit = 100, category = null) {
  let sql = 'SELECT * FROM activity_log';
  const params = [];
  if (category) { sql += ' WHERE category = ?'; params.push(category); }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);
  const rows = db.exec(sql, params);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(v => { const o = {}; cols.forEach((c, i) => o[c] = v[i]); return o; });
}

// === Passive-income streams (Income Strategist agent) ===
function createIncomeStream(s) {
  db.run(`INSERT INTO income_streams (name, method, status, rationale, paypal_mechanism, success_rate, steps, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [s.name, s.method || '', s.status || 'brainstorming', s.rationale || '', s.paypal_mechanism || '', s.success_rate || 0, JSON.stringify(s.steps || []), s.notes || '']);
  persist();
  const rows = db.exec('SELECT MAX(id) as id FROM income_streams');
  return rows[0]?.values?.[0]?.[0] || 0;
}
function getIncomeStreams(limit = 50) {
  const rows = db.exec('SELECT * FROM income_streams ORDER BY updated_at DESC LIMIT ?', [limit]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(v => { const o = {}; cols.forEach((c, i) => o[c] = v[i]); return o; });
}
function getIncomeStream(id) {
  const rows = db.exec('SELECT * FROM income_streams WHERE id = ?', [id]);
  if (!rows.length || !rows[0].values.length) return null;
  const cols = rows[0].columns; const o = {};
  cols.forEach((c, i) => o[c] = rows[0].values[0][i]);
  return o;
}
function updateIncomeStream(id, fields) {
  const allowed = ['status', 'rationale', 'paypal_mechanism', 'success_rate', 'steps', 'deposits_usd', 'notes', 'method'];
  const safe = {};
  for (const k of Object.keys(fields)) if (allowed.includes(k)) safe[k] = fields[k];
  if (!Object.keys(safe).length) return;
  const sets = Object.keys(safe).map(k => `${k} = ?`);
  const vals = [...Object.values(safe), id];
  db.run(`UPDATE income_streams SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, vals);
  persist();
}
function getIncomeStats() {
  const total = db.exec("SELECT COUNT(*) as c FROM income_streams")[0]?.values[0][0] || 0;
  const active = db.exec("SELECT COUNT(*) as c FROM income_streams WHERE status = 'active'")[0]?.values[0][0] || 0;
  const settingUp = db.exec("SELECT COUNT(*) as c FROM income_streams WHERE status = 'setting_up'")[0]?.values[0][0] || 0;
  const deposited = db.exec("SELECT COALESCE(SUM(deposits_usd),0) as d FROM income_streams")[0]?.values[0][0] || 0;
  return { total, active, settingUp, deposited };
}
function attributePayout(streamId, paypalId) {
  try { db.run('UPDATE real_payouts SET stream_id = ? WHERE paypal_id = ?', [streamId, paypalId]); persist(); } catch (e) {}
}

// === POD daily Shopify plan ===
function saveDailyPlan(rows) {
  db.run('DELETE FROM pod_daily_plan');
  for (const r of (rows || [])) {
    db.run(`INSERT INTO pod_daily_plan (niche, theme, product_type, design_hint, rationale) VALUES (?, ?, ?, ?, ?)`,
      [r.niche || 'general', r.theme || '', r.product_type || '', r.design_hint || '', r.rationale || '']);
  }
  persist();
}
function getLatestDailyPlan(limit = 20) {
  const rows = db.exec('SELECT * FROM pod_daily_plan ORDER BY id DESC LIMIT ?', [limit]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(v => { const o = {}; cols.forEach((c, i) => o[c] = v[i]); return o; });
}

// === Task Operations ===
function getTasks() {
  const rows = db.exec("SELECT * FROM tasks ORDER BY created_at DESC");
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}
function getTask(id) {
  const rows = db.exec("SELECT * FROM tasks WHERE id = ?", [id]);
  if (!rows.length || !rows[0].values.length) return null;
  const cols = rows[0].columns; const obj = {};
  cols.forEach((c, i) => obj[c] = rows[0].values[0][i]);
  return obj;
}
function insertTask(task) {
  db.run(`INSERT INTO tasks (title, description, assignee, priority, status, progress, stage) VALUES (?, ?, ?, ?, ?, ?, ?)`, [task.title, task.description || '', task.assignee || '', task.priority || 'medium', task.status || 'pending', task.progress || 0, task.stage || 'queued']);
  persist();
  const rows = db.exec("SELECT MAX(id) as id FROM tasks");
  return rows[0]?.values?.[0]?.[0] || 0;
}
function updateTask(id, fields) {
  const allowed = ['title','description','assignee','priority','status','progress','stage','result','result_files'];
  const safe = {};
  for (const k of Object.keys(fields)) { if (allowed.includes(k)) safe[k] = fields[k]; }
  if (!Object.keys(safe).length) return;
  const sets = Object.keys(safe).map(k => `${k} = ?`).join(', ');
  const vals = [...Object.values(safe), id];
  db.run(`UPDATE tasks SET ${sets}, updated_at = datetime('now') WHERE id = ?`, vals);
  persist();
}
function completeTask(id, result, resultFiles) {
  db.run(`UPDATE tasks SET status = 'completed', progress = 100, stage = 'done', result = ?, result_files = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`, [result || '', resultFiles || '', id]);
  persist();
}

// === Task Log Operations ===
function getTaskLogs(taskId) {
  const rows = db.exec("SELECT * FROM task_logs WHERE task_id = ? ORDER BY timestamp ASC", [taskId]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}
function getAllTaskLogs(limit = 100) {
  const rows = db.exec("SELECT * FROM task_logs ORDER BY timestamp DESC LIMIT ?", [limit]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}
function addTaskLog(taskId, agentName, action, detail) {
  db.run(`INSERT INTO task_logs (task_id, agent_name, action, detail) VALUES (?, ?, ?, ?)`, [taskId || 0, agentName || '', action, detail || '']);
  persist();
}

// === Agent Communication ===
function getCommunications(limit = 50) {
  const rows = db.exec("SELECT * FROM agent_communications ORDER BY timestamp DESC LIMIT ?", [limit]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}
function addCommunication(fromAgent, toAgent, message, taskId) {
  db.run(`INSERT INTO agent_communications (from_agent, to_agent, message, task_id) VALUES (?, ?, ?, ?)`, [fromAgent, toAgent, message, taskId || 0]);
  persist();
}

// === Feedback & Learning ===
function getFeedback(limit = 50) {
  const rows = db.exec("SELECT * FROM feedback ORDER BY timestamp DESC LIMIT ?", [limit]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}
function addFeedback(agentName, taskId, rating, comment, category) {
  db.run(`INSERT INTO feedback (agent_name, task_id, rating, comment, category) VALUES (?, ?, ?, ?, ?)`, [agentName || '', taskId || 0, rating || 5, comment || '', category || 'general']);
  persist();
}
function getLearningLog(agentName, limit = 20) {
  const rows = db.exec("SELECT * FROM learning_log WHERE agent_name = ? ORDER BY created_at DESC LIMIT ?", [agentName, limit]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}
function getAllLearning(limit = 100) {
  const rows = db.exec("SELECT * FROM learning_log ORDER BY created_at DESC LIMIT ?", [limit]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}
function addLearning(agentName, lesson, source) {
  db.run(`INSERT INTO learning_log (agent_name, lesson, source) VALUES (?, ?, ?)`, [agentName, lesson, source || '']);
  persist();
}
function incrementLearningApplied(id) {
  db.run(`UPDATE learning_log SET applied_count = applied_count + 1 WHERE id = ?`, [id]);
  persist();
}

// === Pipeline Runs ===
function getPipelineRuns(taskId) {
  const rows = db.exec("SELECT * FROM pipeline_runs WHERE task_id = ? ORDER BY id ASC", [taskId]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}
function addPipelineRun(taskId, stage, status, log) {
  db.run(`INSERT INTO pipeline_runs (task_id, stage, status, log, started_at) VALUES (?, ?, ?, ?, datetime('now'))`, [taskId || 0, stage, status, log || '']);
  persist();
  const rows = db.exec("SELECT MAX(id) as id FROM pipeline_runs");
  return rows[0]?.values?.[0]?.[0] || 0;
}
function updatePipelineRun(id, status, duration, log) {
  db.run(`UPDATE pipeline_runs SET status = ?, duration_seconds = ?, log = ?, completed_at = datetime('now') WHERE id = ?`, [status, duration || 0, log || '', id]);
  persist();
}

// === Chat Messages ===
function getChatMessages(limit = 100) {
  const rows = db.exec("SELECT * FROM chat_messages ORDER BY timestamp DESC LIMIT ?", [limit]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; }).reverse();
}
function addChatMessage(sender, message, recipient, channel) {
  db.run(`INSERT INTO chat_messages (sender, recipient, message, channel) VALUES (?, ?, ?, ?)`, [sender, recipient || 'broadcast', message, channel || 'main']);
  persist();
}

// === Completed Deliverables ===
function getDeliverables(limit = 50) {
  const rows = db.exec("SELECT * FROM completed_deliverables ORDER BY created_at DESC LIMIT ?", [limit]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}
function addDeliverable(taskId, taskTitle, type, filePath, description, agentName) {
  db.run(`INSERT INTO completed_deliverables (task_id, task_title, deliverable_type, file_path, description, agent_name) VALUES (?, ?, ?, ?, ?, ?)`, [taskId || 0, taskTitle || '', type || 'file', filePath || '', description || '', agentName || '']);
  persist();
}

// === Completed Tasks as Deliverables ===
function getCompletedTasksAsDeliverables(limit = 50) {
  const rows = db.exec(`
    SELECT 
      t.id as id,
      t.id as task_id,
      t.title as task_title,
      t.result,
      t.assignee as agent_name,
      t.completed_at,
      t.created_at,
      'task_result' as type
    FROM tasks t
    WHERE t.status = 'completed' AND t.result IS NOT NULL AND t.result != ''
    ORDER BY t.completed_at DESC
    LIMIT ?
  `, [limit]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}

function getAllDeliverables(limit = 50) {
  const deliverables = getDeliverables(limit);
  const completedTasks = getCompletedTasksAsDeliverables(limit);
  
  // Combine and sort by date
  const combined = [...deliverables, ...completedTasks].sort((a, b) => {
    const dateA = new Date(a.completed_at || a.created_at || 0).getTime();
    const dateB = new Date(b.completed_at || b.created_at || 0).getTime();
    return dateB - dateA;
  });
  
  return combined.slice(0, limit);
}

// === Projects ===
function getProjects() {
  const rows = db.exec("SELECT * FROM projects ORDER BY updated_at DESC");
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}
function getProject(id) {
  const rows = db.exec("SELECT * FROM projects WHERE id = ?", [id]);
  if (!rows.length || !rows[0].values.length) return null;
  const cols = rows[0].columns; const obj = {};
  cols.forEach((c, i) => obj[c] = rows[0].values[0][i]);
  return obj;
}
function insertProject(p) {
  db.run(`INSERT INTO projects (name, description, status, category, repo_url, live_url, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`, [p.name, p.description || '', p.status || 'active', p.category || 'general', p.repo_url || '', p.live_url || '', p.notes || '']);
  persist();
  const rows = db.exec("SELECT MAX(id) as id FROM projects");
  return rows[0]?.values?.[0]?.[0] || 0;
}
function updateProject(id, fields) {
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const vals = [...Object.values(fields), id];
  db.run(`UPDATE projects SET ${sets}, updated_at = datetime('now') WHERE id = ?`, vals);
  persist();
}
function getProjectHistory(projectId) {
  const rows = db.exec("SELECT * FROM project_history WHERE project_id = ? ORDER BY timestamp DESC LIMIT 50", [projectId]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}
function addProjectHistory(projectId, changeType, description, agentName) {
  db.run(`INSERT INTO project_history (project_id, change_type, description, agent_name) VALUES (?, ?, ?, ?)`, [projectId, changeType, description, agentName || 'System']);
  persist();
}

// === Pinned Tasks ===
function getPinnedTasks() {
  const rows = db.exec("SELECT pt.*, t.title, t.description, t.assignee, t.priority, t.status, t.progress, t.stage, t.created_at as task_created_at FROM pinned_tasks pt JOIN tasks t ON pt.task_id = t.id ORDER BY pt.pinned_at DESC");
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}
function pinTask(taskId, reason) {
  db.run(`INSERT OR REPLACE INTO pinned_tasks (task_id, reason) VALUES (?, ?)`, [taskId, reason || '']);
  persist();
}
function unpinTask(taskId) {
  db.run(`DELETE FROM pinned_tasks WHERE task_id = ?`, [taskId]);
  persist();
}

// === Sub-Agent Activities ===
function getSubagentActivities(limit = 50) {
  const rows = db.exec("SELECT * FROM subagent_activities ORDER BY created_at DESC LIMIT ?", [limit]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}
function insertSubagentActivity(agentName, activityType, description, target) {
  db.run(`INSERT INTO subagent_activities (agent_name, activity_type, description, target) VALUES (?, ?, ?, ?)`, [agentName, activityType, description, target || '']);
  persist();
  const rows = db.exec("SELECT MAX(id) as id FROM subagent_activities");
  return rows[0]?.values?.[0]?.[0] || 0;
}
function updateSubagentActivity(id, status, result) {
  db.run(`UPDATE subagent_activities SET status = ?, result = ?, completed_at = datetime('now') WHERE id = ?`, [status, result || '', id]);
  persist();
}

// === Skills ===
function getSkills() {
  const rows = db.exec("SELECT * FROM skills ORDER BY category, name");
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}
function getSkill(id) {
  const rows = db.exec("SELECT * FROM skills WHERE id = ?", [id]);
  if (!rows.length || !rows[0].values.length) return null;
  const cols = rows[0].columns; const obj = {};
  cols.forEach((c, i) => obj[c] = rows[0].values[0][i]);
  return obj;
}
function enableSkill(id) {
  db.run(`UPDATE skills SET enabled = 1, installed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`, [id]);
  persist();
}
function disableSkill(id) {
  db.run(`UPDATE skills SET enabled = 0, updated_at = datetime('now') WHERE id = ?`, [id]);
  persist();
}
function insertSkill(s) {
  db.run(`INSERT OR IGNORE INTO skills (name, description, category, source, icon, version, author) VALUES (?, ?, ?, ?, ?, ?, ?)`, [s.name, s.description || '', s.category || 'general', s.source || 'clawhub', s.icon || '🔧', s.version || '1.0.0', s.author || '']);
  persist();
}

// === Activity Log ===
// The activity_log is re-read on every dashboard poll. Trim it to a
// rolling window so it can't grow unbounded and slow every request.
const ACT_LOG_MAX = 500;
function trimActivityLog() {
  try { db.run(`DELETE FROM activity_log WHERE id NOT IN (SELECT id FROM activity_log ORDER BY id DESC LIMIT ?)`, [ACT_LOG_MAX]); } catch (e) {}
}
function addActivityLog(agentName, action, detail, category) {
  db.run(`INSERT INTO activity_log (agent_name, action, detail, category) VALUES (?, ?, ?, ?)`, [agentName || 'System', action, detail || '', category || 'system']);
  trimActivityLog();
  persist();
}

// === Stats ===
// The dashboard polls /api/stats frequently; getStats() runs ~10 db.exec
// queries each call. Cache the result for a short TTL to cut load.
let _statsCache = null;
let _statsAt = 0;
const STATS_TTL = 3000;
function getStats() {
  const now = Date.now();
  if (_statsCache && now - _statsAt < STATS_TTL) return _statsCache;
  const s = computeStats();
  _statsCache = s; _statsAt = now;
  return s;
}
function computeStats() {
  const totalTasks = db.exec("SELECT COUNT(*) as cnt FROM tasks")[0]?.values[0][0] || 0;
  const completedTasks = db.exec("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'completed'")[0]?.values[0][0] || 0;
  const inProgressTasks = db.exec("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'in-progress'")[0]?.values[0][0] || 0;
  const pendingTasks = db.exec("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'pending'")[0]?.values[0][0] || 0;
  const totalAgents = db.exec("SELECT COUNT(*) as cnt FROM agents")[0]?.values[0][0] || 0;
  const activeAgents = db.exec("SELECT COUNT(*) as cnt FROM agents WHERE status = 'active'")[0]?.values[0][0] || 0;
  const totalFeedback = db.exec("SELECT COUNT(*) as cnt FROM feedback")[0]?.values[0][0] || 0;
  const totalLearnings = db.exec("SELECT COUNT(*) as cnt FROM learning_log")[0]?.values[0][0] || 0;
  const totalDeliverables = db.exec("SELECT COUNT(*) as cnt FROM completed_deliverables")[0]?.values[0][0] || 0;
  const avgRating = db.exec("SELECT AVG(rating) as avg FROM feedback")[0]?.values[0][0] || 0;
  const totalProjects = db.exec("SELECT COUNT(*) as cnt FROM projects")[0]?.values[0][0] || 0;
  const activeProjects = db.exec("SELECT COUNT(*) as cnt FROM projects WHERE status = 'active'")[0]?.values[0][0] || 0;
  const pinnedCount = db.exec("SELECT COUNT(*) as cnt FROM pinned_tasks")[0]?.values[0][0] || 0;
  const skillsEnabled = db.exec("SELECT COUNT(*) as cnt FROM skills WHERE enabled = 1")[0]?.values[0][0] || 0;
  const skillsTotal = db.exec("SELECT COUNT(*) as cnt FROM skills")[0]?.values[0][0] || 0;
  return { totalTasks, completedTasks, inProgressTasks, pendingTasks, totalAgents, activeAgents, totalFeedback, totalLearnings, totalDeliverables, avgRating: Math.round(avgRating * 10) / 10, totalProjects, activeProjects, pinnedCount, skillsEnabled, skillsTotal };
}


// === Notifications ===
function getNotifications(limit = 20, unreadOnly = false) {
  let query = 'SELECT * FROM notifications';
  if (unreadOnly) query += ' WHERE read = 0';
  query += ' ORDER BY created_at DESC LIMIT ?';
  const rows = db.exec(query, [limit]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}

function addNotification(title, message, type, agentName) {
  db.run('INSERT INTO notifications (title, message, type, agent_name) VALUES (?, ?, ?, ?)', [title, message, type || 'info', agentName || 'System']);
  persist();
  const rows = db.exec('SELECT MAX(id) as id FROM notifications');
  return rows[0]?.values?.[0]?.[0] || 0;
}

function markNotificationRead(id) {
  db.run('UPDATE notifications SET read = 1 WHERE id = ?', [id]);
  persist();
}

function markAllNotificationsRead() {
  db.run('UPDATE notifications SET read = 1 WHERE read = 0');
  persist();
}

// === Businesses ===
function getBusinesses() {
  const rows = db.exec("SELECT * FROM businesses ORDER BY updated_at DESC");
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}
function getBusiness(id) {
  const rows = db.exec("SELECT * FROM businesses WHERE id = ?", [id]);
  if (!rows.length || !rows[0].values.length) return null;
  const cols = rows[0].columns; const obj = {};
  cols.forEach((c, i) => obj[c] = rows[0].values[0][i]);
  return obj;
}
function getActiveBusinesses() {
  const rows = db.exec("SELECT * FROM businesses WHERE status = 'active' ORDER BY updated_at DESC");
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}
function insertBusiness(b) {
  db.run(`INSERT INTO businesses (name, prompt, niche, status, owner, plan) VALUES (?, ?, ?, ?, ?, ?)`,
    [b.name, b.prompt, b.niche || 'general', b.status || 'planning', b.owner || 'Boobot Prime', b.plan || '[]']);
  persist();
  const rows = db.exec("SELECT MAX(id) as id FROM businesses");
  return rows[0]?.values?.[0]?.[0] || 0;
}
function updateBusiness(id, fields) {
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const vals = [...Object.values(fields), id];
  db.run(`UPDATE businesses SET ${sets}, updated_at = datetime('now') WHERE id = ?`, vals);
  persist();
}
function getBusinessEvents(businessId, limit = 40) {
  const rows = db.exec("SELECT * FROM business_events WHERE business_id = ? ORDER BY timestamp DESC LIMIT ?", [businessId, limit]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}
function insertBusinessEvent(businessId, agentName, eventType, description, value) {
  db.run(`INSERT INTO business_events (business_id, agent_name, event_type, description, value) VALUES (?, ?, ?, ?, ?)`,
    [businessId, agentName || '', eventType || 'action', description || '', value || 0]);
  persist();
}
function insertSnapshot(businessId, revenue, customers, profit) {
  db.run(`INSERT INTO metric_snapshots (business_id, revenue, customers, profit, ts) VALUES (?, ?, ?, ?, ?)`,
    [businessId, revenue || 0, customers || 0, profit || 0, Date.now()]);
  persist();
}
function getSnapshots(businessId, limit = 120) {
  const rows = db.exec("SELECT revenue, customers, profit, ts FROM metric_snapshots WHERE business_id = ? ORDER BY ts ASC LIMIT ?", [businessId, limit]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}

// === Payout config (real money routing to the owner's PayPal) ===
function getPayoutConfig() {
  const rows = db.exec("SELECT paypal_me, paypal_client_id, paypal_client_secret, connected, updated_at FROM payout_config WHERE id = 1");
  if (!rows.length) return { paypal_me: '', paypal_client_id: '', paypal_client_secret: '', connected: 0 };
  const cols = rows[0].columns, row = rows[0].values[0];
  const o = {}; cols.forEach((c, i) => o[c] = row[i]); return o;
}
function setPayoutConfig(fields) {
  const existing = db.exec("SELECT id FROM payout_config WHERE id = 1");
  if (existing.length) {
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    db.run(`UPDATE payout_config SET ${sets}, updated_at = datetime('now') WHERE id = 1`, Object.values(fields));
  } else {
    db.run(`INSERT INTO payout_config (id, paypal_me, paypal_client_id, paypal_client_secret, connected) VALUES (1, ?, ?, ?, ?)`,
      [fields.paypal_me || '', fields.paypal_client_id || '', fields.paypal_client_secret || '', fields.connected || 0]);
  }
  persist();
}

// === Auto-scheduler config for the monetization automation ===
function getSchedulerConfig() {
  const rows = db.exec("SELECT enabled, times, last_pod_run, last_income_run, last_full_run, updated_at FROM scheduler_config WHERE id = 1");
  if (!rows.length) return { enabled: 1, times: ['09:00', '18:00'], last_pod_run: '', last_income_run: '', last_full_run: '' };
  const cols = rows[0].columns, row = rows[0].values[0];
  const o = {}; cols.forEach((c, i) => o[c] = row[i]);
  try { o.times = JSON.parse(o.times || '["09:00","18:00"]'); } catch { o.times = ['09:00', '18:00']; }
  return o;
}
function setSchedulerConfig(fields) {
  const existing = db.exec("SELECT id FROM scheduler_config WHERE id = 1");
  const times = Array.isArray(fields.times) ? JSON.stringify(fields.times) : (fields.times || null);
  if (existing.length) {
    const sets = [];
    const vals = [];
    if (fields.enabled !== undefined) { sets.push('enabled = ?'); vals.push(fields.enabled ? 1 : 0); }
    if (times !== null) { sets.push('times = ?'); vals.push(times); }
    if (fields.last_pod_run !== undefined) { sets.push('last_pod_run = ?'); vals.push(fields.last_pod_run); }
    if (fields.last_income_run !== undefined) { sets.push('last_income_run = ?'); vals.push(fields.last_income_run); }
    if (fields.last_full_run !== undefined) { sets.push('last_full_run = ?'); vals.push(fields.last_full_run); }
    if (sets.length) { sets.push("updated_at = datetime('now')"); db.run(`UPDATE scheduler_config SET ${sets.join(', ')} WHERE id = 1`, vals); }
  } else {
    db.run(`INSERT INTO scheduler_config (id, enabled, times) VALUES (1, ?, ?)`, [fields.enabled ? 1 : 0, times || '["09:00","18:00"]']);
  }
  persist();
}

// === Real PayPal payouts (the ONLY source of truth for monetization data) ===
function insertRealPayout(p) {
  db.run(`INSERT OR IGNORE INTO real_payouts (paypal_id, amount, currency, status, payer, ts, raw) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [p.paypalId || '', p.amount || 0, p.currency || 'USD', p.status || '', p.payer || '', p.ts || Date.now(), p.raw || '']);
  persist();
}
function realPayoutExists(paypalId) {
  const rows = db.exec("SELECT id FROM real_payouts WHERE paypal_id = ?", [paypalId]);
  return rows.length > 0;
}
function getRealPayouts(limit = 200) {
  const rows = db.exec("SELECT paypal_id, amount, currency, status, payer, ts FROM real_payouts ORDER BY ts DESC LIMIT ?", [limit]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const o = {}; cols.forEach((c, i) => o[c] = row[i]); return o; });
}
function getRealPayoutSummary() {
  const rows = db.exec("SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as count, COALESCE(MAX(ts),0) as lastTs FROM real_payouts");
  if (!rows.length) return { total: 0, count: 0, lastTs: 0 };
  const cols = rows[0].columns, row = rows[0].values[0];
  const o = {}; cols.forEach((c, i) => o[c] = row[i]); return o;
}

// === Agent Evolution (learn & grow as they work) ===
const SKILLS_BY_LEVEL = ['Generalist', 'Specialist', 'Expert', 'Master', 'Architect', 'Legend'];
const PERSONALITIES = ['steady', 'bold', 'curious', 'focused', 'playful', 'wise'];

function ensureEvolution(name) {
  const ex = getEvolution(name);
  if (!ex) {
    db.run(`INSERT OR IGNORE INTO agent_evolution (agent_name, level, xp, skill, personality) VALUES (?, 1, 0, 'Generalist', ?)`,
      [name, PERSONALITIES[Math.abs(hashStr(name)) % PERSONALITIES.length]]);
    persist();
    return getEvolution(name);
  }
  return ex;
}

function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; } return h; }

function getEvolution(name) {
  const rows = db.exec("SELECT * FROM agent_evolution WHERE agent_name = ?", [name]);
  if (!rows.length) return null;
  const cols = rows[0].columns; const obj = {};
  cols.forEach((c, i) => obj[c] = rows[0].values[0][i]);
  return obj;
}

function getEvolutions() {
  const rows = db.exec("SELECT * FROM agent_evolution ORDER BY xp DESC");
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}

// Award XP; returns { leveledUp, level, skill } when a level is gained
function awardXp(name, amount) {
  const ex = ensureEvolution(name);
  let xp = (ex.xp || 0) + amount;
  let level = (ex.level || 1);
  let leveledUp = false;
  let skill = ex.skill || 'Generalist';
  // Level thresholds: cumulative XP needed = level*level*10
  while (xp >= level * level * 10) {
    xp -= level * level * 10;
    level++;
    leveledUp = true;
    skill = SKILLS_BY_LEVEL[Math.min(SKILLS_BY_LEVEL.length - 1, Math.floor((level - 1) / 2))];
  }
  db.run(`UPDATE agent_evolution SET level = ?, xp = ?, skill = ?, evolved_at = datetime('now') WHERE agent_name = ?`,
    [level, xp, skill, name]);
  persist();
  return { leveledUp, level, skill };
}

// === Search Functions ===
function searchChatMessages(query, limit = 50, offset = 0) {
  const q = '%' + query + '%';
  const rows = db.exec("SELECT * FROM chat_messages WHERE message LIKE ? OR sender LIKE ? ORDER BY timestamp DESC LIMIT ? OFFSET ?", [q, q, limit, offset]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; }).reverse();
}

function searchCompletedTasks(query, limit = 50) {
  const q = '%' + query + '%';
  const rows = db.exec("SELECT * FROM tasks WHERE status = 'completed' AND (title LIKE ? OR description LIKE ? OR assignee LIKE ?) ORDER BY completed_at DESC LIMIT ?", [q, q, q, limit]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}

function getCompletedTasks(limit = 50) {
  const rows = db.exec("SELECT * FROM tasks WHERE status = 'completed' ORDER BY completed_at DESC LIMIT ?", [limit]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj; });
}

module.exports = {
  initDatabase, persist, compact, getDb,
  getAgents, getAgent, updateAgent, insertAgent, touchAgent, ensureAgent, getAgentsLive,
  getTasks, getTask, insertTask, updateTask, completeTask,
  getTaskLogs, getAllTaskLogs, addTaskLog,
  getCommunications, addCommunication,
  getFeedback, addFeedback,
  getLearningLog, getAllLearning, addLearning, incrementLearningApplied,
  getPipelineRuns, addPipelineRun, updatePipelineRun,
  getChatMessages, addChatMessage, searchChatMessages, getCompletedTasks, searchCompletedTasks,
  getDeliverables, addDeliverable, getCompletedTasksAsDeliverables, getAllDeliverables,
  getStats,
  getProjects, getProject, insertProject, updateProject, getProjectHistory, addProjectHistory,
  getPinnedTasks, pinTask, unpinTask,
  getSubagentActivities, insertSubagentActivity, updateSubagentActivity,
  getSkills, getSkill, enableSkill, disableSkill, insertSkill,
  getActivityLog, addActivityLog, getNotifications, addNotification, markNotificationRead, markAllNotificationsRead,
  createIncomeStream, getIncomeStreams, getIncomeStream, updateIncomeStream, getIncomeStats, attributePayout,
  saveDailyPlan, getLatestDailyPlan,
  getBusinesses, getBusiness, getActiveBusinesses, insertBusiness, updateBusiness, getBusinessEvents, insertBusinessEvent,
  insertSnapshot, getSnapshots,
  getPayoutConfig, setPayoutConfig,
  insertRealPayout, realPayoutExists, getRealPayouts, getRealPayoutSummary,
  getEvolution, getEvolutions, awardXp, ensureEvolution,
  getSchedulerConfig, setSchedulerConfig,
  pollinationsThrottle,
  llmCacheGet, llmCacheSet
};
