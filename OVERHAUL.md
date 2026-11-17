# OpenHub Overhaul — 2026-11-17

Complete overhaul of the OpenHub dashboard (frontend rebuilt, backend audited with
surgical bug fixes). All existing API routes and response shapes preserved; backend
changes are additive or proven-bug fixes only. `dashboard.db` was never modified
during development or testing (verified byte-identical, md5
`6f88b38b55e274077082fdd298124fe7`, 3,391,488 bytes, before and after).

---

## 1. Bugs found and fixed

### Backend — server.js

1. **`createTask is not defined` crashed BooBot's research intent** (server.js:1044)
   The local AI engine's research branch called `createTask(...)`, which did not exist
   anywhere in the codebase. With no LLM key configured, `POST /api/chat/ai` with
   "research quantum computing trends" returned
   `{"success":false,"error":"Error: createTask is not defined"}` and no task was made.
   **Fix:** implemented `createTask(title, description, assignee, priority)` with the
   same bookkeeping `processTaskIntent` does (task row, task logs, pipeline
   Source/Build stages, BooBot→assignee communication, agent status/current_task,
   `task_created`/`agent_updated`/`agent_communication` broadcasts, System chat
   confirmation). Verified: research chat now creates the task end-to-end.

2. **Documented chat trigger "create task: …" never matched** (server.js:1740)
   `processTaskIntent`'s detection regexes used `\s+a?\s+task`, which requires two
   whitespace characters in "create task:" — so the exact phrasing listed in the
   function's own header comment silently did nothing (proven by live test before the
   fix). **Fix:** patterns now use `\s+(a\s+)?task`, accepting both "create task:" and
   "create a task:" (same for "make task:").

3. **Chat-created tasks were titled with BooBot's canned reply, not Jeff's words**
   (processTaskIntent, ~server.js:1790)
   The title was taken from the first sentence of the AI reply, so tasks ended up
   titled things like "Interesting... Interesting, Ghost". **Fix:** the title is now
   extracted from the user's own message (text after "task:" / "create task:" /
   "i need you to" / "i want you to"), falling back to the old reply-sentence behavior
   only if that yields nothing usable. Verified: "create task: overhaul test" → task
   titled `overhaul test`; "i need you to check the trending page" → task titled
   `check the trending page`; plain chat ("how are you doing today") creates **no**
   task.
   *Caution recorded in code:* `db.getChatMessages()` reverses to chronological order
   before returning, so the latest user message is the **last** array element. This
   was verified empirically — an attempted "fix" to index `[0]` made every chat
   request re-create a task from a stale message, and was reverted.

4. **Double-completing a task double-counted everything** (server.js:~730)
   `POST /api/tasks/:id/complete` had no state guard: completing the same task twice
   incremented the agent's `tasks_completed` twice (proven: 50 → 52) and duplicated
   deliverable/pipeline rows. **Fix:** completing a nonexistent task now returns
   `{success:false, error:"Task not found"}`; completing an already-completed task
   returns `{success:true, alreadyCompleted:true}` with no side effects. Verified:
   two completes → counter moves exactly +1 (50 → 51).

5. **Task executor never credited completions** (task executor completion path)
   Tasks finished by the background executor did not increment the assignee's
   `tasks_completed` or clear `current_task` (the `/complete` route did), so agent
   trackers under-counted executor-finished work. **Fix:** executor completion now
   does the same accounting.

6. **Duplicate route registrations (dead code)** — removed:
   - `GET /api/activity` was registered twice (~old lines 510 and 1786) with
     different response shapes (`{logs}` vs `{activities}`). Express always served
     the first; the second was unreachable. The first (which the mobile app also
     tolerates) was kept; the dead second handler was removed with an explanatory
     comment.
   - File-based `POST /api/deliverables` and `GET /api/deliverables` (~old lines
     2146/2168) were shadowed by the DB-backed pair and unreachable; removed.
     The file-based `GET /api/deliverables/:id` **is** reachable and was kept.

7. **`/api/analytics` agent XP/level were always 0** (server.js, /api/analytics)
   It read `a.xp` / `a.level` from agent rows, but those columns live in
   `agent_evolution`. **Fix:** performance/XP aggregates now read from
   `agent_evolution`. Total XP / avg level in the Analytics section are real now.

8. **WebSocket broadcast could throw on a dead socket** (server.js:373, 402)
   `broadcast()` sent to every client with no per-client error handling; one stale
   socket could break delivery to the rest. **Fix:** per-client try/catch in both the
   dashboard socket set and the Claw3D socket set.

### Backend — database.js

9. **Duplicate pins inflated the pinned count** (database.js:660)
   `pinned_tasks` has no UNIQUE(task_id) and `pinTask` used INSERT OR REPLACE, which
   never replaced — pinning one task twice created two rows (proven). **Fix:**
   delete-then-insert makes pinning idempotent. Verified: two pins → one row.

10. **`/api/memory/chat` pagination ignored `offset`** (database.js:549)
    `getChatMessages(limit)` dropped the offset argument, so every page returned the
    same first page (proven: offset=0 and offset=2 returned identical ids).
    **Fix:** `getChatMessages(limit, offset = 0)` with `LIMIT ? OFFSET ?`.

11. **SQL injection via PATCH body keys + crash on empty patch** (database.js:299,
    630, 820) — `updateAgent` / `updateProject` / `updateBusiness` interpolated
    request-body keys directly into `UPDATE … SET <key> = ?`, allowing arbitrary
    column names, and an empty patch produced invalid SQL. **Fix:** column
    whitelists (`AGENT_ALLOWED`, `PROJECT_ALLOWED`, `BUSINESS_ALLOWED`); unknown
    keys are ignored and an empty patch is a no-op.

12. **Unstable ordering on same-second timestamps** (database.js:435, 769)
    `getTasks` / `getNotifications` ordered by timestamp only; rows created in the
    same second could shuffle between loads. **Fix:** `id DESC` tiebreak added.

### Checked and found NOT to be bugs
- sql.js `exec` returns `[]` for zero-row SELECTs (verified with a direct node test),
  so the `!rows.length` guards in database.js are correct as written.
- The server boots and serves normally with the OpenClaw gateway and Claw3D absent;
  `/claw3d-proxy` returns a graceful 502 and the dashboard shows a degraded note.
  No crash loop. (Verified live.)

---

## 2. Frontend — public/index.html rebuilt (301 lines → 1,807)

Single-file SPA, zero external/CDN dependencies (works offline on Jeff's LAN).
Dark gaming theme: glass cards, cyan `#00d4ff` / purple `#a855f7` accents, animated
aurora background (transform-only), hover lift/glow, click ripple + press scale,
skeleton loaders, toast notifications, smooth section transitions.

**All 21 sections** (sidebar, grouped Main / Work / Output / Insight / System,
number-key shortcuts 1–9): 3D Office (Claw3D iframe via `/claw3d-proxy` with a
graceful "not running" state), Overview, BooBot Chat, Agents, Tasks, Taskboard
(kanban with HTML5 drag-and-drop), Pipeline, Projects, Comms, Deliverables,
Task History, Learning, Analytics, Trending, Memory & History, Twitch, Skills,
Sub-Agents, Businesses & Payouts, Automation, R1 Apps (QR grid preserved verbatim
from the old dashboard).

Key behaviors:
- **Keep-alive sections**: instant switching, no reloads; per-section cache with TTL
  background refresh, so trackers never show stale zeros.
- **WebSocket live updates** wired to the existing broadcast events
  (`task_created`, `task_updated`, `task_completed`, `task_log`, `pipeline_update`,
  `agent_added/updated`, `subagent_spawned/activity/updated`, `notification_new`,
  `activity_new`, `deliverable_added`, `agent_communication`, `project_*`,
  `skill_*`, `chat_message`, …): toasts, badge counters, and soft-refresh of the
  visible section — trackers update in real time. Keepalive ping/pong with
  exponential-backoff reconnect; header shows live CPU/RAM and connection state.
- **BooBot Prime chat**: history from `/api/chat`, send via `/api/chat/ai`, typing
  indicator; when BooBot creates a task the reply shows a "Task #N created" chip
  with a **View task** jump to the task drawer. WS echo de-duplication so messages
  never double-render.
- **Sub-Agents**: spawn form (agent name + task + optional model/thinking) →
  `POST /api/subagents/spawn`, live activity feed with mark-done.
- **Accurate trackers**: counters animated from `/api/stats`; task counts computed
  from `/api/tasks` data; agent cards show live state (working/frozen by
  `seconds_since_activity`), XP/level from evolution, and `tasks_completed` from
  `/api/agents`.
- **Task drawer**: full detail, description, result, live task logs, pipeline
  stages, and actions (start / complete / back to pending / pin).
- **Command palette (Ctrl+K)**: jump to any section or action, plus live search
  across tasks, agents, and projects. Keyboard shortcuts: 1–9 sections, `N` new
  task, `S` sub-agents, `R` refresh, `Esc` closes overlays.
- **Notifications panel**: unread badge, mark-read / read-all.
- **Automation section**: POD / Income / Money Hustler / Traffic / R1 Builder /
  Auto-Improver status + run buttons, full-automation run, income streams, and the
  one-click Auto-Improve list for Jeff's R1 games (repos preserved from the old
  frontend) with custom repo input.
- **Businesses**: venture cards with pause/resume/shutdown, launch-by-prompt, and
  the **real** PayPal payout ledger (`/api/payouts/real`) kept clearly separate
  from simulated numbers.
- **Memory & History**: MEMORY.md viewer, daily notes browser, chat history with
  working offset pagination (bug #10), global chat search.
- Responsive: sidebar collapses to an off-canvas drawer on small screens (the R1 /
  phone use case), and `/m` mobile dashboard is linked from the R1 section.

### Deliberately not given a section
The Creator endpoints (`/api/creator/*`: script pipeline, voiceover, thumbnail,
captions, upload) have no UI in this build — they were not in the README's section
list and are driven by agents, not the dashboard. The routes are untouched.

---

## 3. Deliberately left alone

- **All API routes and response shapes** — no route removed or reshaped (the two
  removed handlers in bug #6 were unreachable dead code; the reachable behavior is
  unchanged).
- **DB schema** — no migrations; the existing `dashboard.db` works as-is and was
  never written to during testing (all tests ran against copies in /tmp).
- **Agent engine files** (`business-engine.js`, `pod-engine.js`, `income-agent.js`,
  `money-hustler.js`, `traffic-agent.js`, `auto-improve-agent.js`,
  `r1-builder-agent.js`), cert files, `.bat`/`.ps1` launchers, `pod_assets`, and
  `public/mobile/` — untouched.
- **BooBot Prime's embedded system prompt and persona** in server.js — Jeff's own
  content; not part of this overhaul's scope.
- ⚠️ **Flagged, not changed — hardcoded credentials in a public repo:** server.js
  contains hardcoded API-key material (a fallback key string in the task-executor
  provider chain and inline key assignments inside the `/api/chat/ai` handler), and
  the repo also contains `cert.pem` / `cert.pfx` and `dashboard.db`. Removing the
  fallback key could break Jeff's task executor, so it was left in place — but
  these should be rotated and moved to environment variables, and the cert/DB files
  considered for removal from git history.
- **Known inconsistency kept:** `GET /api/deliverables/:id` reads from the
  deliverables *directory* while the list endpoint reads from the DB. It is the
  live behavior other callers may rely on; changing it was out of scope.
- `/api/tasks` returns the full task list (~1.3 MB with results) — existing API
  behavior; the SPA slices client-side. Worth a future server-side pagination pass.

---

## 4. Test results (all run against a scratch copy in /tmp with a copied DB)

- `node --check` — server.js ✓, database.js ✓; the SPA's six inline `<script>`
  blocks extracted and parsed with `node --check` ✓ (105,810 bytes of JS).
- **Boot**: server starts clean on a test port with OpenClaw gateway + Claw3D
  absent; `/claw3d-proxy` → 502 (graceful); 0 fatal/uncaught entries in the log.
- **GET endpoints** — all returned sane JSON with `success:true`: health, stats,
  agents, tasks, system, activity, chat, subagents, projects, deliverables,
  communications, learning, notifications, skills, evolution, analytics, logs,
  pinned, businesses, payouts, payouts/real, memory, memory/daily, memory/tasks,
  config, settings, task-executor/status, monetize/status, autoimprove/status,
  pod/status, discord/status, creator/profile, trending (live GitHub data).
- **Write flows**:
  - `POST /api/tasks` → created task #118 ✓
  - `POST /api/tasks/:id/complete` twice → `tasks_completed` 50 → **51** (not 52);
    second response `alreadyCompleted:true`; nonexistent task → clean
    `{"success":false,"error":"Task not found"}` ✓
  - `POST /api/pinned` twice for one task → exactly **1** pin row ✓
  - `POST /api/chat` → success ✓
  - `POST /api/subagents/spawn` → success, activity recorded and listed ✓
  - `/api/memory/chat?limit=2&offset=0` → ids [666, 667]; `offset=2` → [664, 665]
    (distinct pages) ✓
- **BooBot Prime chat (`POST /api/chat/ai`, local engine, no LLM key)**:
  - "create task: overhaul test" → `taskCreated:true`, task titled `overhaul test` ✓
  - "i need you to check the trending page" → task titled `check the trending page` ✓
  - "how are you doing today" → **no** task created ✓
  - "research quantum computing trends" → success, research task created via the new
    `createTask` (previously crashed with `createTask is not defined`) ✓
- **WebSocket**: client received `connected`, `pong` (reply to ping), and a live
  `task_created` broadcast when a task was created over HTTP ✓
- **Frontend serving + DOM smoke test** (jsdom against the live test server):
  `GET /` serves the new index.html (136,781 bytes); all 21 `sec-*` section ids and
  WS wiring present; sidebar renders 21 items / 5 groups; Overview renders with a
  live task counter (121 = 117 real + 4 test tasks); Tasks renders 121 rows;
  Sub-Agents spawn form present; WS label shows "Live — WebSocket connected";
  **zero page errors** ✓
- **Repo integrity**: `dashboard.db` md5 identical before/after
  (`6f88b38b55e274077082fdd298124fe7`); `git status` shows only `server.js`,
  `database.js`, `public/index.html` modified (plus this file added). Nothing
  pushed.

## 5. Not verifiable in this sandbox
- Real Claw3D / OpenClaw gateway behavior (neither was running; degraded paths
  verified instead).
- LLM-key chat path (Anthropic/provider chain) — the local-engine path was
  verified end-to-end; with a valid key configured, replies come from the provider
  and task creation still flows through the same fixed `processTaskIntent`.
- Physical-device feel of the dashboard on the R1 itself (layout is responsive and
  the `/m` mobile app is untouched and still served).
