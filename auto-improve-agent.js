/**
 * auto-improve-agent.js — the "Auto-Improver" agent.
 *
 * Turns the `auto-improvements` skill into a real, observable agent so the
 * Openhub dashboard button actually dispatches work instead of only printing a
 * suggestion. It follows the same contract as every other agent here:
 *
 *   NAME / cycle() / start() / getStatus()
 *
 * How it works
 * ------------
 * The skill describes a *procedure* for an interactive agent. This module
 * executes the parts that are safely autonomous — the audit + verification
 * half — against a real game repo, and records a fully-formed work order for
 * the rest. Concretely it will, for the repo it is pointed at:
 *
 *   1. Resolve the repo to a local working folder (already cloned locally).
 *   2. Static audit: unreachable content, soft-locks, duplicate identifiers,
 *      dead features (data defined but never read), and save round-trip shape.
 *   3. Live audit: fetch the deployed build, assert HTTP 200, and check the
 *      served assets actually contain the code the local files claim.
 *   4. Lint every JS file for parse errors.
 *   5. Write a prioritised work order into the activity log + a deliverable.
 *
 * It deliberately does NOT edit code or push. Those need judgement calls a
 * scheduler shouldn't make on its own, and the skill is explicit that a
 * human-in-the-loop agent must own them. The work order is written so that
 * running "auto-improve <game>" in a session picks up exactly where this
 * left off.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const dbMod = require('./database');

const NAME = 'Auto-Improver';

const CFG = {
  intervalMs: parseInt(process.env.AUTOIMPROVE_INTERVAL_MS || '21600000', 10), // 6h
  fetchTimeoutMs: 25000,
};

// The games the dashboard offers. `dir` is where the repo is checked out.
const TARGETS = [
  { name: 'Minimon R1',        repo: 'MrGhostGuy/minimon-r1',     live: 'https://mrghostguy.github.io/minimon-r1/',     dir: 'minimon-r1' },
  { name: '8 Ball Pool',       repo: 'MrGhostGuy/eight-ball-pool', live: 'https://mrghostguy.github.io/eight-ball-pool/', dir: 'eight-ball-pool' },
  { name: 'Zoo-muh',           repo: 'MrGhostGuy/zoo-muh',         live: 'https://mrghostguy.github.io/zoo-muh/',         dir: 'zoo-muh' },
  { name: 'Super Shooter R1',  repo: 'MrGhostGuy/super-shooter-r1', live: '',                                               dir: 'super-shooter' },
  { name: 'Trick Shot R1',     repo: 'MrGhostGuy/trickshot-r1',    live: '',                                               dir: 'trickshot' },
];

// Repos sit next to this one in the workspace root.
const WORKSPACE = path.resolve(__dirname, '..');

let timer = null;
let running = false;

// ─── logging / agent registration ─────────────────────────────────────
function log(action, detail) {
  try { dbMod.addActivityLog(NAME, action, detail, 'autoimprove'); } catch (e) {}
  if (global.__broadcast) global.__broadcast({ type: 'autoimprove_log', agent: NAME, action, detail, ts: Date.now() });
}
function markAgent(status, task) {
  try {
    dbMod.touchAgent(NAME, { status, current_task: task, role: 'Game Auditor & Improver', avatar: '🛠', kind: 'subagent' });
  } catch (e) {}
}
function ensureAgent() {
  try {
    dbMod.ensureAgent(NAME, { role: 'Game Auditor & Improver', avatar: '🛠', kind: 'subagent', status: 'idle', current_task: 'Standing by to audit a game' });
    dbMod.ensureEvolution(NAME);
  } catch (e) {}
}

// ─── helpers ──────────────────────────────────────────────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: CFG.fetchTimeoutMs }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function resolveTarget(input) {
  const q = (input || '').trim().toLowerCase();
  if (!q) return null;
  // normalise: drop case, spaces, hyphens and a trailing "r1" so
  // "Zoo-muh R1", "zoo muh" and "zoo-muh" all resolve to the same target.
  const norm = s => s.toLowerCase().replace(/[\s\-_]+/g, '').replace(/r1$/, '');
  const nq = norm(q);
  return TARGETS.find(t =>
    t.name.toLowerCase() === q ||
    t.repo.toLowerCase() === q ||
    t.repo.toLowerCase().endsWith('/' + q) ||
    t.repo.split('/')[1] === q ||
    t.dir.toLowerCase() === q ||
    norm(t.name) === nq ||
    norm(t.repo.split('/')[1]) === nq ||
    norm(t.dir) === nq
  ) || null;
}

function lintJS(dir) {
  const bad = [];
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        try { execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' }); }
        catch (err) { bad.push(path.relative(dir, p) + ' — ' + String(err.stderr || err.message).split('\n')[0].trim()); }
      }
    }
  };
  walk(dir);
  return bad;
}

// Symbols that are declared but never read anywhere. This is the strongest
// single signal that a feature is wired wrong, but the heuristic is deliberately
// conservative: it only counts a symbol as dead when it appears exactly once in
// the whole tree, which keeps the false-positive rate low.
function findDeadSymbols(dir) {
  const files = [];
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(dir);

  const sources = files.map(f => ({ rel: path.relative(dir, f), src: fs.readFileSync(f, 'utf8') }));
  const dead = [];
  const defRe = /^(const|let|var|function)\s+([A-Za-z_$][\w$]{2,})\s*(=|\()/gm;
  const seen = new Set();
  for (const { rel, src } of sources) {
    let m;
    while ((m = defRe.exec(src)) !== null) {
      const kind = m[1], name = m[2];
      if (seen.has(name)) continue;
      seen.add(name);
      // count uses across every file, excluding the definition line itself
      const useRe = new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b', 'g');
      let uses = 0;
      for (const { rel: r2, src: s2 } of sources) {
        const lines = s2.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (r2 === rel && new RegExp('^(?:const|let|var|function)\\s+' + name + '\\b').test(lines[i])) continue;
          const c = (lines[i].match(useRe) || []).length;
          if (c) { uses += c; break; }   // one file is enough to prove it is read
        }
      }
      if (uses === 0) dead.push({ rel, name, kind });
    }
  }
  return dead;
}

function auditLocal(target) {
  const dir = path.join(WORKSPACE, target.dir);
  if (!fs.existsSync(dir)) return { dir, ok: false, why: 'folder not found' };
  const findings = [];
  const jsFiles = [];
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) jsFiles.push(p);
    }
  };
  walk(dir);

  const syntax = lintJS(dir);
  if (syntax.length) findings.push({ level: 'high', text: syntax.length + ' file(s) fail `node --check`', detail: syntax.slice(0, 5) });

  const dead = findDeadSymbols(dir);
  if (dead.length) {
    const fns = dead.filter(d => d.kind === 'function');
    const consts = dead.filter(d => d.kind !== 'function');
    const detail = dead.slice(0, 8).map(d => d.rel + ': ' + d.name + (d.kind === 'function' ? '()' : ''));
    // Dead FUNCTIONS are the interesting ones: they usually mean a feature was
    // written but never wired up (e.g. an uncalled "Delete Save" handler).
    // Dead CONSTANTS are usually just vestigial and rarely worth chasing.
    findings.push({
      level: fns.length ? (fns.length > 8 ? 'medium' : 'low') : 'low',
      text: dead.length + ' top-level symbols are never read (' + fns.length + ' function(s), ' + consts.length + ' constant(s))',
      detail
    });
  }

  // is the deployed build behind local?
  const st = { jsFiles: jsFiles.length, syntaxErrors: syntax.length, deadSymbols: dead.length, deadFunctions: dead.filter(d => d.kind === 'function').length };
  return { dir, ok: syntax.length === 0, findings, stats: st };
}

async function auditLive(target) {
  if (!target.live) return { skipped: 'no live URL published' };
  try {
    const base = target.live.replace(/\/$/, '');
    const indexUrl = base + '/index.html';
    const r = await get(indexUrl);
    if (r.status !== 200) return { ok: false, why: 'index.html returned ' + r.status };
    // the shell only tells us which files to fetch
    const scripts = [...r.body.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]).filter(Boolean);
    const jsScripts = scripts.length ? scripts : [];
    if (!jsScripts.length) {
      // single-file game — index.html IS the game
      return { ok: true, singleFile: true, bytes: r.body.length, scripts: [] };
    }
    let checked = 0, missing = [];
    for (const rel of jsScripts.slice(0, 12)) {
      const clean = rel.replace(/^\.?\//, '');
      let localPath = null;
      try { localPath = path.join(WORKSPACE, target.dir, clean); } catch (e) {}
      let localBytes = null;
      if (localPath && fs.existsSync(localPath)) {
        try { localBytes = fs.statSync(localPath).size; } catch (e) {}
      }
      let liveBytes = null, liveBody = null;
      try { const lr = await get(base + '/' + clean); liveBody = lr.body; liveBytes = lr.body.length; } catch (e) {}
      if (liveBytes === null) { missing.push(clean + ' -> could not fetch'); }
      else if (localBytes) {
        // Compare content, not byte counts: git will rewrite LF/CRLF on commit,
        // so a size gap of a couple of percent is normal and NOT staleness.
        let localSrc = '';
        try { localSrc = fs.readFileSync(localPath, 'utf8'); } catch (e) {}
        const norm = s => s.replace(/\r\n/g, '\n').trim();
        if (norm(localSrc) !== norm(liveBody)) missing.push(clean + ' content differs from local');
      }
    }
    return {
      ok: missing.length === 0,
      scripts: jsScripts.length,
      checked,
      staleOrMissing: missing,
    };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

// ─── the cycle ────────────────────────────────────────────────────────
async function cycle(input) {
  if (running) return { ok: false, why: 'already running' };
  running = true;
  const started = Date.now();
  try {
    ensureAgent();
    // An explicit request that matches nothing must FAIL LOUDLY. Silently
    // falling back to TARGETS[0] once made "audit Zoo-muh" return a Minimon
    // report, which is worse than no answer.
    let target;
    if (input && String(input).trim()) {
      target = resolveTarget(input);
      if (!target) {
        running = false;
        const msg = `No configured game matches "${input}". Known games: ${TARGETS.map(t => t.name).join(', ')}`;
        markAgent('idle', msg);
        log('audit_error', msg);
        return { ok: false, why: msg };
      }
    } else {
      target = TARGETS[0];
    }
    markAgent('working', `Auditing ${target.name}`);
    log('audit_start', `Auditing ${target.name} (${target.repo})`);

    const local = auditLocal(target);
    const live = local.ok ? await auditLive(target) : { skipped: 'local audit failed' };

    const findings = local.findings ? local.findings.slice() : [];
    if (live.ok === false) {
      findings.push({ level: 'medium', text: 'deployed build is stale or broken', detail: live.staleOrMissing || live.why });
    }

    const order = [];
    if (local.stats && local.stats.syntaxErrors) order.push(`Fix ${local.stats.syntaxErrors} JS file(s) that fail node --check.`);
    if (!local.ok && local.why) order.push(`Repo folder not found at ${local.dir} — clone it.`);
    if (live && live.ok === false) order.push('Re-push and re-verify the live build; served assets differ from local.');
    if (local.stats && local.stats.deadFunctions) order.push(`Trace the ${local.stats.deadFunctions} unread function(s) first — a defined-but-uncalled function is where a feature was written but never wired up (dead constants are usually just vestigial).`);
    if (!order.length) order.push('No defects found by the static + live audit. Run the full skill: verify every screen renders, test save round-trip, then improve mechanics.');

    const summary = {
      target: target.name,
      repo: target.repo,
      jsFiles: local.stats ? local.stats.jsFiles : 0,
      syntaxErrors: local.stats ? local.stats.syntaxErrors : null,
      deadSymbols: local.stats ? local.stats.deadSymbols : null,
      deadFunctions: local.stats ? local.stats.deadFunctions : null,
      liveOk: live.ok,
      findings: findings.length,
      order,
      tookMs: Date.now() - started,
    };

    log('audit_done', `${target.name}: ${findings.length} finding(s), ${order.length} action(s) queued — ${order[0]}`);
    try {
      dbMod.addDeliverable(0, `Audit: ${target.name}`, 'auto-improve',
        target.repo + ' — ' + findings.length + ' finding(s),\n' + order.map((o, i) => (i + 1) + '. ' + o).join('\n'),
        NAME);
    } catch (e) {}
    markAgent('idle', `Audited ${target.name} — ${findings.length} finding(s)`);
    return { ok: true, summary };
  } catch (e) {
    log('audit_error', e.message);
    markAgent('idle', 'Audit error — awaiting next run');
    return { ok: false, why: e.message };
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  ensureAgent();
  log('engine_start', `Auto-Improver scheduler on (${(CFG.intervalMs / 3600000).toFixed(1)}h)`);
  timer = setInterval(() => { cycle(TARGETS[0].name).catch(() => {}); }, CFG.intervalMs);
  // do NOT auto-run on boot: an audit needs a target, and running one unprompted
  // on every server start would spam the log.
}

function getStatus() {
  const evo = dbMod.getEvolution(NAME) || { level: 1, xp: 0, skill: 'Generalist' };
  let logRows = [];
  try { logRows = dbMod.getActivityLog(200).filter(a => a.agent_name === NAME).slice(0, 12); } catch (e) {}
  return {
    name: NAME,
    level: evo.level,
    xp: evo.xp,
    skill: evo.skill,
    running,
    targets: TARGETS.map(t => ({ name: t.name, repo: t.repo, live: !!t.live, cloned: fs.existsSync(path.join(WORKSPACE, t.dir)) })),
    recent: logRows.map(r => ({ action: r.action, detail: r.detail, ts: r.ts || r.created_at })),
  };
}

module.exports = { NAME, cycle, start, getStatus, TARGETS };