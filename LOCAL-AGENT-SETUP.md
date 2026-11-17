# LOCAL AGENT SETUP — OpenHub (overhauled build) → OpenClaw hookup

**Audience:** an AI agent (or human) running locally on Jeff's PC.
**Mission:** install the overhauled OpenHub dashboard from this repo and hook it up to
Jeff's local OpenClaw so BooBot Prime chat tasking, sub-agent spawning, and all
trackers work against his live setup.

The overhaul is already committed on `main`:
- `fb4932a` — server.js (12 backend bug fixes)
- `608469a` — database.js (pin duplication + pagination fixes)
- `89ac4da` — public/index.html (full dashboard rebuild, ~1,800 lines, 21 sections)
- `d24c9e5` — OVERHAUL.md (what changed and why — read it first)

## Hard rules

1. **Do NOT overwrite Jeff's existing `dashboard.db` on the PC.** It holds his live
   tasks/agents/history. Only three files change: `server.js`, `database.js`,
   `public/index.html`. The `dashboard.db` in this repo is a snapshot, not an update.
2. Back up the PC's current `server.js`, `database.js`, and `public/index.html`
   before replacing them (e.g. copy to a `backup-before-overhaul/` folder).
3. Do not delete anything else in the OpenHub folder. Ignore the various `.log`,
   `.bat`, and `server.js.bak` files — they are Jeff's local artifacts.

## Install steps (on Jeff's PC, in his existing OpenHub folder)

1. Pull or download this repo's `main` branch.
2. Copy the three files over the PC copies:
   - `server.js` → OpenHub folder root
   - `database.js` → OpenHub folder root
   - `public/index.html` → `public/` folder
3. From the OpenHub folder: `npm install` (safe to re-run; adds nothing new if
   dependencies are already installed).
4. Start it the way Jeff normally does (his desktop shortcut / `Openhub.bat`),
   or directly: `node server.js`
5. Open the dashboard: **http://localhost:3001**

## How OpenHub connects to OpenClaw (what to verify / wire up)

- **OpenClaw Gateway:** the dashboard expects the gateway WebSocket at
  **`ws://localhost:18789`**. Make sure OpenClaw's gateway is running on that port
  before judging the dashboard broken — without it, the dashboard still loads and
  works, but gateway-dependent features degrade gracefully.
- **OpenClaw workspace memory:** `/api/memory` reads from
  `OPENCLAW_WORKSPACE` (env var) or, by default,
  **`~/.openclaw/workspace`** (memory files under its `memory/` subfolder).
  If Jeff's OpenClaw workspace lives somewhere else, set `OPENCLAW_WORKSPACE`
  to that path before starting the server.
- **Claw3D (Office view):** expected at **http://localhost:3002**; the dashboard
  proxies it at `/claw3d-proxy`. If Claw3D isn't running, the Office section shows
  a graceful "not reachable" state — that's expected, not a bug.
- **HTTPS (optional, for mobile mic):** port **3443**, using `cert.pem`/`cert.pfx`
  already in the repo.
- **Ports summary:** dashboard HTTP `3001` (override with `PORT`), HTTPS `3443`,
  Claw3D `3002`, OpenClaw gateway `18789`.

## Optional configuration (environment variables)

The dashboard runs fine with none of these (BooBot's local engine handles chat),
but LLM-backed chat and integrations use whichever are set:
`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`,
`SAMBANOVA_API_KEY`, `MISTRAL_API_KEY`, `TOGETHER_API_KEY`, `NVIDIA_API_KEY`,
`GEMINI_API_KEY`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`,
`DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DEFAULT_AGENT_MODEL`.

## Verification checklist (run all of these)

1. `GET http://localhost:3001/api/health` → `{"status":"ok", ...}`
2. `GET http://localhost:3001/api/stats` → real counts from Jeff's `dashboard.db`
   (tasks, agents, deliverables). If counts are 0/empty, the wrong `dashboard.db`
   is in place — restore Jeff's original (see Hard rules).
3. Dashboard loads at http://localhost:3001 with 21 sidebar sections and a green
   **Live** WebSocket indicator.
4. **BooBot chat test:** in the Chat section, send exactly:
   `create task: test the new dashboard`
   → a task titled **"test the new dashboard"** must appear in Tasks (a
   "task created" chip shows in chat). Delete the test task afterwards.
5. **Sub-agent test:** in the Sub-Agents section, spawn a sub-agent with a trivial
   job (e.g. name `SmokeTest`, task `reply with the word ready`) and confirm it is
   accepted and listed. Remove it afterwards if there's a remove option.
6. Press **Ctrl+K** → command palette opens; search "tasks" and jump.

## Known notes

- `server.js` still contains a hardcoded fallback API key in the task-executor
  provider chain (left in place deliberately so the executor keeps working).
  Recommended follow-up, with Jeff's OK: rotate that key, move keys to env vars,
  and make this repo private — it also contains `cert.pem`/`cert.pfx` and the
  snapshot `dashboard.db`.
- This build was verified headlessly against a copy of the database (boot,
  ~33 endpoints, chat tasking end-to-end, sub-agent spawn, jsdom render with zero
  page errors). First contact with Jeff's live gateway/Claw3D happens on his PC —
  if something gateway-specific misbehaves, check the gateway on port 18789 first.

*Prepared by Meta (Muse) for Jeff / GhostLegacyX, 2026-11-17.*
