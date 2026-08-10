# Openhub - AI Agent Control Center

**Created by:** GhostLegacyX (Jeff)  
**Version:** 2.0  
**Name:** Openhub

## What is Openhub?

Openhub is a premium AI agent command center dashboard built on OpenClaw. It provides a real-time visualization of all AI agents, tasks, communications, and deliverables in a beautiful gaming-inspired interface with Claw3D 3D office integration.

## Features

### 17 Sections:
1. **3D Office** (Landing) - Claw3D Virtual Office with real-time agent visualization
2. **Overview** - Dashboard with stats, agents, tasks, and activity feed
3. **Chat** - AI chat with Boobot Prime (main orchestrator) - assign tasks via chat
4. **Agents** - All agents management
5. **Tasks** - Full task management
6. **Taskboard** - Kanban-style task board
7. **Projects** - Project tracking
8. **Pipeline** - Task pipeline stages
9. **Comms** - Agent-to-agent communications
10. **Deliverables** - Completed work products
11. **Task History** - Completed tasks with results
12. **Learning** - AI learnings and user feedback
13. **Trending** - GitHub/Reddit trending topics
14. **Memory & History** - 6 sub-tabs for memory, logs, chat history, etc.
15. **Twitch** - Twitch integration
16. **Skills** - Skills and abilities management
17. **Sub-Agents** - Sub-agent management

### Key Features:
- Real-time WebSocket connection
- Claw3D 3D office integration with live agent visualization
- Chat-based task assignment (type "create task:" or "assign" to create tasks)
- Boobot Prime as main orchestrator agent
- Agent meeting system (auto-triggers when no tasks active)
- System stats (CPU, RAM)
- Create tasks, agents, projects via modals
- Responsive gaming-inspired UI
- Dark theme with cyan/purple accents
- Zero fake data - all real API integrations

## How to Use

1. Double-click **Openhub** on your desktop
2. The server starts automatically
3. Your browser opens to http://localhost:3000
4. Click any tab to navigate between sections
5. Use Chat tab to assign tasks to agents via natural language

## Requirements

- Node.js v18+
- OpenClaw Gateway running
- Claw3D server (optional, for 3D Office view)

## Files

- `Start-JormUI.ps1` - PowerShell launcher for all services
- `server.js` - Backend server with WebSocket support
- `public/index.html` - Frontend dashboard
- `public/app.js` - Frontend JavaScript
- `database.js` - SQLite database layer
- `claw3d-proxy.js` - Claw3D embedding proxy
