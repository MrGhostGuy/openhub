/* ═══════════════════════════════════════════════════════════════════
   OpenHub R1 — Mobile Control Center for Rabbit R1
   8 Tabs: Dashboard, Agents, Tasks, Money, Chat, Arcade, Actions, Status
   Dynamic theme per tab • R1 hardware events • WebSocket real-time
   Speech-to-text • Camera capture • Agent task assignment
   ═══════════════════════════════════════════════════════════════════ */
(function(){
'use strict';

// ─── Config ────────────────────────────────────────────────────────
const API = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  ? `http://${location.hostname}:${location.port || 3001}`
  : location.protocol === 'https:'
    ? `https://${location.hostname}${location.port ? ':' + location.port : ''}`
    : `http://192.168.0.62:3001`;
const WS_URL = API.replace('http','ws');
const isR1 = typeof PluginMessageHandler !== 'undefined';

// ─── Tab Definitions ───────────────────────────────────────────────
const TABS = [
  { id:'dashboard', icon:'◈', label:'Home',  theme:{ h:180,s:100,l:50 } },
  { id:'agents',    icon:'◎', label:'Agents', theme:{ h:270,s:80,l:55 } },
  { id:'tasks',     icon:'▣', label:'Tasks',  theme:{ h:35,s:100,l:50 } },
  { id:'voice',     icon:'🎙', label:'Voice',  theme:{ h:320,s:90,l:55 } },
  { id:'chat',      icon:'◉', label:'Chat',   theme:{ h:200,s:90,l:55 } },
  { id:'claw3d',    icon:'🎲', label:'3D',     theme:{ h:160,s:70,l:50 } },
  { id:'arcade',    icon:'♠', label:'Arcade', theme:{ h:300,s:80,l:55 } },
  { id:'actions',   icon:'⚡', label:'Actions', theme:{ h:55,s:100,l:50 } },
  { id:'status',    icon:'●', label:'Status',  theme:{ h:0,s:0,l:50 } },
];

// ─── State ─────────────────────────────────────────────────────────
let currentTab = 0;
let ws = null;
let wsConnected = false;
let cache = { agents:[], tasks:[], logs:[], stats:{}, streams:[], chat:[], r1builder:{} };
let particleCtx = null;
let particles = [];
let chatScrollLocked = true;

// ─── Speech-to-Text State ──────────────────────────────────────────
let sttActive = false;
let sttRecognition = null;
let sttLang = 'en-US';

// ─── Voice Call State ──────────────────────────────────────────────
let voiceCallActive = false;
let voiceState = 'idle'; // idle, listening, processing, speaking
let voiceAudio = null;
let voiceAnalyser = null;
let voiceStream = null;
let voiceHistory = [];

// ─── Camera State ──────────────────────────────────────────────────
let cameraStream = null;

// ─── Notification Badges ───────────────────────────────────────────
let unreadChat = 0;
let lastChatCount = 0;

// ─── DOM ───────────────────────────────────────────────────────────
const $view = document.getElementById('view');
const $tabbar = document.getElementById('tabbar');
const $connPill = document.getElementById('connPill');
const $connText = document.getElementById('connText');

// ─── Initialize ────────────────────────────────────────────────────
function init(){
  buildTabBar();
  initParticles();
  connectWS();
  applyTheme(0);
  renderTab();
  fetchAll();
  setInterval(fetchAll, 12000);
  setupR1Events();
  setupPullToRefresh();
  setupSwipeGestures();
  // Show swipe hint on first visit
  if(!localStorage.getItem('oh_hinted')){
    setTimeout(()=>{
      const hint=document.createElement('div');
      hint.className='swipe-hint';
      hint.textContent='← Swipe tabs →';
      document.body.appendChild(hint);
      setTimeout(()=>hint.remove(),3500);
      localStorage.setItem('oh_hinted','1');
    },2000);
  }
}

// ─── Tab Bar ───────────────────────────────────────────────────────
function buildTabBar(){
  $tabbar.innerHTML = '';
  TABS.forEach((t,i) => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (i===currentTab?' active':'');
    let badge = '';
    if(t.id === 'chat' && unreadChat > 0) badge = `<span class="tab-badge">${unreadChat > 9?'9+':unreadChat}</span>`;
    btn.innerHTML = `<span class="tab-icon">${t.icon}</span><span>${t.label}</span>${badge}`;
    btn.onclick = () => switchTab(i);
    $tabbar.appendChild(btn);
  });
}

function switchTab(idx){
  if(idx<0||idx>=TABS.length||idx===currentTab) return;
  // Stop STT when leaving chat
  if(TABS[currentTab].id === 'chat' && sttActive) stopSTT();
  currentTab = idx;
  if(TABS[idx].id === 'chat') unreadChat = 0;
  applyTheme(idx);
  buildTabBar();
  renderTab();
}

function applyTheme(idx){
  const t = TABS[idx].theme;
  const hsl = `hsl(${t.h},${t.s}%,${t.l}%)`;
  const hslDim = `hsl(${t.h},${t.s}%,${Math.max(t.l-30,10)}%)`;
  document.documentElement.style.setProperty('--accent', hsl);
  document.documentElement.style.setProperty('--accent2', hslDim);
  document.documentElement.style.setProperty('--theme-h', t.h);
  document.documentElement.style.setProperty('--theme-s', t.s+'%');
  document.documentElement.style.setProperty('--theme-l', t.l+'%');
}

// ─── R1 Hardware Events ────────────────────────────────────────────
function setupR1Events(){
  window.addEventListener('scrollUp', () => {
    if(isScrollable()) return;
    switchTab(currentTab - 1);
  });
  window.addEventListener('scrollDown', () => {
    if(isScrollable()) return;
    switchTab(currentTab + 1);
  });
  window.addEventListener('sideClick', () => handleSideClick());
  window.addEventListener('longPressStart', () => {
    // Long press on chat tab = toggle STT
    if(TABS[currentTab].id === 'chat'){
      if(sttActive) stopSTT(); else startSTT();
    } else {
      if(ws && ws.readyState === WebSocket.OPEN) ws.close();
      else connectWS();
    }
  });

  // PC fallbacks
  window.addEventListener('keydown', e => {
    if(e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if(e.key === 'ArrowUp'){ e.preventDefault(); switchTab(currentTab-1); }
    if(e.key === 'ArrowDown'){ e.preventDefault(); switchTab(currentTab+1); }
    if(e.key === ' '||e.key === 'Enter'){ e.preventDefault(); handleSideClick(); }
    if(e.key === 'Escape') switchTab(0);
    const num = parseInt(e.key);
    if(num >= 1 && num <= 8) switchTab(num - 1);
    // 'v' key = toggle STT in chat
    if(e.key === 'v' && TABS[currentTab].id === 'chat'){
      if(sttActive) stopSTT(); else startSTT();
    }
    // 'c' key = camera in chat
    if(e.key === 'c' && TABS[currentTab].id === 'chat') capturePhoto();
  });
  window.addEventListener('wheel', e => {
    if(e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if(isScrollable()) return;
    e.preventDefault();
    if(e.deltaY < 0) switchTab(currentTab - 1);
    else switchTab(currentTab + 1);
  }, {passive:false});
}

function isScrollable(){
  const v = $view;
  return v.scrollTop > 0 && v.scrollTop < (v.scrollHeight - v.clientHeight - 2);
}

function handleSideClick(){
  const tab = TABS[currentTab].id;
  if(tab === 'chat'){
    if(sttActive) return; // don't send while recording
    sendChat();
  }
  if(tab === 'actions') runCurrentAction();
  if(tab === 'arcade' && !document.getElementById('arcadeOverlay')) launchRandomGame();
}

// ─── Particle Background ───────────────────────────────────────────
function initParticles(){
  const canvas = document.getElementById('particleBg');
  canvas.width = window.innerWidth; canvas.height = window.innerHeight;
  particleCtx = canvas.getContext('2d');
  for(let i=0;i<35;i++){
    particles.push({
      x:Math.random()*canvas.width, y:Math.random()*canvas.height,
      vx:(Math.random()-0.5)*0.3, vy:(Math.random()-0.5)*0.3,
      r:Math.random()*2+0.5, a:Math.random()*0.3+0.1
    });
  }
  animateParticles();
  window.addEventListener('resize',()=>{
    canvas.width=window.innerWidth;canvas.height=window.innerHeight;
  });
}

function animateParticles(){
  if(!particleCtx) return;
  const w=particleCtx.canvas.width, h=particleCtx.canvas.height;
  particleCtx.clearRect(0,0,w,h);
  const th = TABS[currentTab].theme.h;
  particles.forEach(p => {
    p.x += p.vx; p.y += p.vy;
    if(p.x < 0) p.x = w; if(p.x > w) p.x = 0;
    if(p.y < 0) p.y = h; if(p.y > h) p.y = 0;
    particleCtx.beginPath();
    particleCtx.arc(p.x, p.y, p.r, 0, Math.PI*2);
    particleCtx.fillStyle = `hsla(${th},100%,70%,${p.a})`;
    particleCtx.fill();
  });
  requestAnimationFrame(animateParticles);
}

// ─── Pull to Refresh ───────────────────────────────────────────────
let ptrStartY=0,ptrPulling=false;
function setupPullToRefresh(){
  const v=document.getElementById('view');
  if(!v)return;
  v.addEventListener('touchstart',e=>{
    if(v.scrollTop===0)ptrStartY=e.touches[0].clientY;
  },{passive:true});
  v.addEventListener('touchmove',e=>{
    if(v.scrollTop>0)return;
    const dy=e.touches[0].clientY-ptrStartY;
    if(dy>60&&!ptrPulling){
      ptrPulling=true;
      toast('Refreshing...');
      fetchAll().then(()=>{ptrPulling=false;toast('Updated!')});
    }
  },{passive:true});
  v.addEventListener('touchend',()=>{ptrPulling=false;},{passive:true});
}

// ─── Swipe Gestures (tab switching) ────────────────────────────────
let swipeStartX=0,swipeStartY=0;
function setupSwipeGestures(){
  document.addEventListener('touchstart',e=>{
    swipeStartX=e.touches[0].clientX;
    swipeStartY=e.touches[0].clientY;
  },{passive:true});
  document.addEventListener('touchend',e=>{
    const dx=e.changedTouches[0].clientX-swipeStartX;
    const dy=e.changedTouches[0].clientY-swipeStartY;
    if(Math.abs(dx)>80&&Math.abs(dy)<50){
      if(dx<0&&currentTab<TABS.length-1)switchTab(currentTab+1);
      else if(dx>0&&currentTab>0)switchTab(currentTab-1);
    }
  },{passive:true});
}

// ─── WebSocket ─────────────────────────────────────────────────────
function connectWS(){
  try{
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      wsConnected = true;
      $connPill.classList.remove('offline');
      $connText.textContent = 'LIVE';
    };
    ws.onclose = () => {
      wsConnected = false;
      $connPill.classList.add('offline');
      $connText.textContent = 'OFF';
      setTimeout(connectWS, 5000);
    };
    ws.onerror = () => {};
    ws.onmessage = e => {
      try { handleWSMessage(JSON.parse(e.data)); } catch(err){}
    };
  } catch(e){
    wsConnected = false;
    $connPill.classList.add('offline');
    $connText.textContent = 'OFF';
  }
}

function handleWSMessage(d){
  if(d.type === 'agent_updated' || d.type === 'agent_added') fetchAgents();
  if(d.type === 'task_created' || d.type === 'task_updated' || d.type === 'task_completed') fetchTasks();
  if(d.type === 'activity_new' || d.type === 'traffic_log' || d.type === 'income_log' || d.type === 'hustler_log' || d.type === 'r1builder_log') fetchLogs();
  if(d.type === 'chat_message'){
    fetchChat().then(()=>{
      if(TABS[currentTab].id !== 'chat'){
        unreadChat++;
        buildTabBar();
      } else {
        renderChat();
      }
    });
  }
  if(d.type === 'notification_new') toast(d.notification?.message || 'New notification');
}

// ─── Data Fetching ─────────────────────────────────────────────────
async function fetchAll(){
  await Promise.all([fetchAgents(), fetchTasks(), fetchLogs(), fetchStats(), fetchStreams(), fetchChat(), fetchR1Builder()]);
  if(TABS[currentTab].id === 'dashboard') renderTab();
}

async function fetchAgents(){
  try{ const r = await fetch(API+'/api/agents'); const j = await r.json(); if(j.success) cache.agents = j.agents || []; } catch(e){}
}
async function fetchTasks(){
  try{ const r = await fetch(API+'/api/tasks'); const j = await r.json(); if(j.success) cache.tasks = j.tasks || []; } catch(e){}
}
async function fetchLogs(){
  try{ const r = await fetch(API+'/api/activity?limit=30'); const j = await r.json(); if(j.success) cache.logs = j.logs || j.activities || []; } catch(e){}
}
async function fetchStats(){
  try{ const r = await fetch(API+'/api/stats'); const j = await r.json(); if(j.success) cache.stats = j; } catch(e){}
}
async function fetchStreams(){
  try{ const r = await fetch(API+'/api/income/streams'); const j = await r.json(); if(j.success) cache.streams = j.streams || []; } catch(e){}
}
async function fetchChat(){
  try{
    const r = await fetch(API+'/api/chat?limit=50');
    const j = await r.json();
    if(j.success){
      const prev = cache.chat.length;
      cache.chat = j.messages || [];
      if(TABS[currentTab].id === 'chat' && cache.chat.length > prev) renderChat();
    }
  } catch(e){}
}
async function fetchR1Builder(){
  try{ const r = await fetch(API+'/api/r1builder/status'); const j = await r.json(); if(j.success) cache.r1builder = j.status || {}; } catch(e){}
}

// ─── Tab Renderers ─────────────────────────────────────────────────
function renderTab(){
  const id = TABS[currentTab].id;
  $view.scrollTop = 0;
  $view.className = id === 'chat' ? 'view chat-mode' : 'view';
  switch(id){
    case 'dashboard': renderDashboard(); break;
    case 'agents': renderAgents(); break;
    case 'tasks': renderTasks(); break;
    case 'voice': renderVoice(); break;
    case 'chat': renderChat(); break;
    case 'claw3d': renderClaw3D(); break;
    case 'arcade': renderArcade(); break;
    case 'actions': renderActions(); break;
    case 'status': renderStatus(); break;
  }
}

// ─── Dashboard ─────────────────────────────────────────────────────
function renderDashboard(){
  const s = cache.stats;
  const active = (cache.agents||[]).filter(a=>a.status==='working'||a.status==='active').length;
  const total = (cache.agents||[]).length;
  const taskTotal = (cache.tasks||[]).length;
  const taskDone = (cache.tasks||[]).filter(t=>t.status==='completed').length;
  const taskActive = (cache.tasks||[]).filter(t=>t.status==='in-progress'||t.status==='pending').length;
  const recent = (cache.logs||[]).slice(0,8);
  const r1b = cache.r1builder || {};
  const sys = s.system||{};

  $view.innerHTML = `
    <div class="stat-grid">
      <div class="stat-box"><div class="stat-num">${total}</div><div class="stat-label">AGENTS</div></div>
      <div class="stat-box"><div class="stat-num" style="color:var(--success)">${active}</div><div class="stat-label">ACTIVE</div></div>
      <div class="stat-box"><div class="stat-num">${taskActive}</div><div class="stat-label">TASKS</div></div>
      <div class="stat-box"><div class="stat-num" style="color:var(--success)">${taskDone}</div><div class="stat-label">DONE</div></div>
    </div>
    ${sys.cpu?`<div class="card">
      <div class="card-row"><span class="card-label">CPU</span><span class="card-value">${sys.cpu}%</span></div>
      <div class="card-row"><span class="card-label">Memory</span><span class="card-value">${sys.memory||'—'}%</span></div>
      <div class="card-row"><span class="card-label">Uptime</span><span class="card-value">${sys.uptime?formatUptime(sys.uptime):'—'}</span></div>
    </div>`:''}
    ${r1b.name?`<div class="card" style="border-left:3px solid var(--accent)">
      <div class="card-row"><span class="card-label">🐰 R1 Builder</span><span class="agent-status ${r1b.running?'working':'idle'}">${r1b.running?'building':'idle'}</span></div>
      <div class="card-row"><span class="card-label">Lvl ${r1b.level||1} • ${r1b.xp||0} XP</span><span class="card-label">${r1b.totalCreations||0} creations</span></div>
    </div>`:''}
    <div class="section-title">⚡ Recent Activity</div>
    ${recent.map(l => `
      <div class="activity-item">
        <div class="activity-dot"></div>
        <div class="activity-text"><strong>${esc(l.agent_name||'System')}</strong> ${esc(l.action||'')}</div>
        <div class="activity-time">${timeAgo(l.timestamp)}</div>
      </div>
    `).join('') || '<div class="card" style="text-align:center;color:var(--text-dim)">No activity yet</div>'}
  `;
}

// ─── Agents ────────────────────────────────────────────────────────
function renderAgents(){
  const agents = cache.agents||[];
  const working = agents.filter(a=>a.status==='working');
  const idle = agents.filter(a=>a.status==='idle'||a.status==='active');
  $view.innerHTML = `
    <div class="section-title">🤖 Working (${working.length})</div>
    ${working.map(a => agentCard(a)).join('') || '<div class="card" style="text-align:center;color:var(--text-dim);font-size:8px">No agents working</div>'}
    <div class="section-title">💤 Idle / Active (${idle.length})</div>
    ${idle.slice(0,12).map(a => agentCard(a)).join('')}
    ${idle.length > 12 ? `<div class="card" style="text-align:center;color:var(--text-dim);font-size:8px">+${idle.length-12} more</div>` : ''}
  `;
}

function agentCard(a){
  return `<div class="agent-card" onclick="window._oh.showAgent('${esc(a.name)}')">
    <div class="agent-avatar">${a.avatar||'🤖'}</div>
    <div class="agent-info">
      <div class="agent-name">${esc(a.name)}</div>
      <div class="agent-role">${esc(a.role||'')}</div>
      ${a.current_task?`<div class="agent-role" style="color:var(--accent);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">▸ ${esc(a.current_task)}</div>`:''}
      ${a.level?`<div class="xp-bar"><div class="xp-fill" style="width:${Math.min(((a.xp||0)%1000)/10,100)}%"></div></div>
      <div class="agent-role">Lvl ${a.level} • ${a.xp||0} XP</div>`:''}
    </div>
    <div class="agent-status ${a.status}">${a.status||'idle'}</div>
  </div>`;
}

// ─── Tasks ─────────────────────────────────────────────────────────
function renderTasks(){
  const tasks = (cache.tasks||[]).slice(0,30);
  const pending = tasks.filter(t=>t.status==='pending'||t.status==='in-progress');
  const done = tasks.filter(t=>t.status==='completed');
  $view.innerHTML = `
    <div class="section-title">▣ Active (${pending.length})</div>
    ${pending.map(t => `
      <div class="task-item ${t.priority||''}">
        <div class="task-title">#${t.id} ${esc(t.title)}</div>
        <div class="task-meta">${esc(t.assignee||'unassigned')} • ${t.priority||'medium'} • ${t.status}</div>
        <div class="task-progress"><div class="task-progress-fill" style="width:${t.progress||0}%"></div></div>
      </div>
    `).join('') || '<div class="card" style="text-align:center;color:var(--text-dim)">No active tasks</div>'}
    <div class="section-title">✓ Done (${done.length})</div>
    ${done.slice(0,8).map(t => `
      <div class="task-item" style="opacity:0.5;border-left-color:var(--success)">
        <div class="task-title" style="text-decoration:line-through;font-size:8px">#${t.id} ${esc(t.title)}</div>
        <div class="task-meta">${esc(t.assignee||'')}</div>
      </div>
    `).join('') || ''}
  `;
}

// ─── Voice Call ────────────────────────────────────────────────────
function renderVoice(){
  const stateColors = { idle:'#666', listening:'var(--accent)', processing:'var(--warn)', speaking:'var(--success)' };
  const stateLabels = { idle:'STANDBY', listening:'LISTENING', processing:'THINKING', speaking:'SPEAKING' };
  const color = stateColors[voiceState]||'#666';
  const isActive = voiceCallActive && voiceState !== 'idle';

  $view.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:8px;padding:8px">
      ${voiceCallActive ? `
        <!-- Active call UI -->
        <div style="position:relative;width:80px;height:80px;margin-bottom:4px">
          ${[0,1,2].map(i=>`<div style="position:absolute;inset:0;border-radius:50%;border:2px solid ${color};animation:voicePulse 2s ease-in-out infinite ${i*0.4}s;opacity:0.4"></div>`).join('')}
          <div style="position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle,${color}22,${color}08);border:2px solid ${color};display:flex;align-items:center;justify-content:center;font-size:32px">👻</div>
        </div>
        <div style="font-family:Orbitron,sans-serif;font-size:8px;color:${color};letter-spacing:0.15em;font-weight:700">${stateLabels[voiceState]||'IDLE'}</div>

        <!-- Waveform -->
        <canvas id="voiceWave" width="220" height="40" style="width:220px;height:40px;border-radius:8px;background:rgba(0,0,0,0.3);border:1px solid var(--card-border)"></canvas>

        <!-- Live transcript -->
        <div id="voiceTranscript" style="width:100%;max-height:80px;overflow-y:auto;font-size:8px;color:var(--text-dim);text-align:center;padding:4px">
          ${voiceHistory.slice(-3).map(h=>`<div style="margin:2px 0;color:${h.role==='user'?'var(--accent)':'var(--success)'}">${h.role==='user'?'You:':'Boo:'} ${esc(h.text.substring(0,60))}</div>`).join('')}
        </div>

        <!-- Controls -->
        <div style="display:flex;gap:12px;margin-top:4px">
          <button onclick="window._oh.voiceToggleMic()" style="width:44px;height:44px;border-radius:50%;border:2px solid ${voiceState==='listening'?'var(--danger)':'var(--accent)'};background:${voiceState==='listening'?'rgba(255,51,102,0.15)':'rgba(0,240,255,0.1)'};color:${voiceState==='listening'?'var(--danger)':'var(--accent)'};font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center">${voiceState==='listening'?'■':'●'}</button>
          <button onclick="window._oh.voiceEndCall()" style="width:44px;height:44px;border-radius:50%;border:2px solid var(--danger);background:rgba(255,51,102,0.15);color:var(--danger);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center">📞</button>
        </div>
        <div style="font-size:7px;color:var(--text-dim);text-align:center;margin-top:2px">
          ${voiceState==='idle'?'Tap mic to speak':'Tap mic to toggle'}
        </div>
      ` : `
        <!-- Idle state -->
        <div style="position:relative;width:90px;height:90px;margin-bottom:8px">
          <div style="position:absolute;inset:0;border-radius:50%;border:1px solid var(--card-border);background:var(--glass)"></div>
          <div style="position:absolute;inset:8px;border-radius:50%;border:1px solid var(--glass-border);animation:spin 20s linear infinite"></div>
          <div style="position:absolute;inset:0;border-radius:50%;border:1px solid var(--glass-border);animation:spin 15s linear infinite reverse"></div>
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:36px">👻</div>
        </div>
        <div style="font-family:Orbitron,sans-serif;font-size:12px;color:var(--accent);font-weight:900;letter-spacing:0.1em">VOICE LINK</div>
        <div style="font-size:8px;color:var(--text-dim);text-align:center;max-width:180px;line-height:1.5">Live voice call with BooBot Prime. Speak naturally, get spoken responses.</div>
        <button onclick="window._oh.voiceStartCall()" style="margin-top:8px;background:linear-gradient(135deg,var(--accent),var(--success));color:#000;border:none;border-radius:20px;padding:8px 24px;font-family:Orbitron,sans-serif;font-size:10px;font-weight:700;cursor:pointer;letter-spacing:0.1em">📞 START CALL</button>
        <div style="display:flex;gap:8px;margin-top:12px">
          <div style="text-align:center"><div style="font-size:14px">🎤</div><div style="font-size:6px;color:var(--text-dim)">STT</div></div>
          <div style="text-align:center"><div style="font-size:14px">🔊</div><div style="font-size:6px;color:var(--text-dim)">TTS</div></div>
          <div style="text-align:center"><div style="font-size:14px">🔓</div><div style="font-size:6px;color:var(--text-dim)">FREE</div></div>
        </div>
      `}
    </div>
  `;

  // Start waveform animation if call active
  if(voiceCallActive) requestAnimationFrame(animateVoiceWave);
}

function animateVoiceWave(){
  const canvas = document.getElementById('voiceWave');
  if(!canvas || !voiceCallActive) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);

  const bars = 32;
  const barW = Math.max(2, (w/bars)*0.6);
  const gap = (w - barW*bars)/(bars-1);
  const centerY = h/2;
  const isActive = voiceState==='listening'||voiceState==='speaking';
  const t = Date.now()/1000;

  for(let i=0;i<bars;i++){
    const x = i*(barW+gap);
    const norm = i/bars;
    let amp;
    if(isActive){
      const w1=Math.sin(t*2+norm*8)*0.4;
      const w2=Math.sin(t*3.7+norm*12)*0.25;
      amp=Math.max(0.08,Math.min(1,Math.abs(w1+w2)*(0.3+0.7)));
    } else {
      amp=0.06+Math.abs(Math.sin(t*0.5+norm*3)*0.06);
    }
    const barH=amp*(h*0.8);
    const y=centerY-barH/2;
    const grad=ctx.createLinearGradient(x,y,x,y+barH);
    if(isActive){
      grad.addColorStop(0,'rgba(0,240,255,0.9)');
      grad.addColorStop(0.5,'rgba(123,47,255,0.7)');
      grad.addColorStop(1,'rgba(255,45,123,0.9)');
    } else {
      grad.addColorStop(0,'rgba(0,240,255,0.2)');
      grad.addColorStop(1,'rgba(123,47,255,0.1)');
    }
    ctx.fillStyle=grad;
    ctx.beginPath();
    ctx.roundRect(x,y,barW,barH,2);
    ctx.fill();
  }
  requestAnimationFrame(animateVoiceWave);
}

// ─── Voice Call (Bluetooth-aware) ───────────────────────────────────
let voiceDeviceId = null;

function voiceStartCall(){
  voiceCallActive=true;
  voiceHistory=[];
  voiceState='idle';
  renderVoice();
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    toast('Microphone not supported in this browser');
    voiceCallActive=false;
    renderVoice();
    return;
  }
  // Check if page is served over a secure context (required for mic on mobile)
  if(!location.protocol.match(/https:/) && location.hostname!=='localhost' && location.hostname!=='127.0.0.1'){
    toast('Voice requires HTTPS — use https://192.168.0.62:3443/m');
    voiceCallActive=false;
    renderVoice();
    return;
  }
  navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{
    // Got permission — now enumerate devices to find Bluetooth
    voiceStream = stream;
    const track = stream.getAudioTracks()[0];
    if(track) console.log('[Voice] Initial mic:', track.label);
    // Stop this stream, we'll re-open with the right device
    stream.getTracks().forEach(t=>t.stop());
    return navigator.mediaDevices.enumerateDevices();
  }).then(devices=>{
    const audioInputs = devices.filter(d=>d.kind==='audioinput');
    console.log('[Voice] Available mics:', audioInputs.map(d=>d.label||d.deviceId));
    // Find Bluetooth mic
    const btMic = audioInputs.find(d=>/bluetooth|bt[^a-z]|airpod|headset|earbud/i.test(d.label));
    const micId = btMic ? btMic.deviceId : null;
    voiceDeviceId = micId;
    if(btMic) toast('Bluetooth found: ' + btMic.label);
    // Re-open mic with the right device
    const constraints = micId ? { audio: { deviceId: { exact: micId } } } : { audio: true };
    return navigator.mediaDevices.getUserMedia(constraints);
  }).then(stream=>{
    voiceStream = stream;
    const track = stream.getAudioTracks()[0];
    if(track) toast('Using: ' + (track.label || 'default mic'));
    const actx = new AudioContext();
    const src = actx.createMediaStreamSource(stream);
    voiceAnalyser = actx.createAnalyser();
    voiceAnalyser.fftSize = 256;
    src.connect(voiceAnalyser);
    voiceSpeak("Hey there! I'm BooBot Prime. What's on your mind?").then(()=>{
      voiceStartListening();
    });
  }).catch(e=>{
    console.error('[Voice] Error:', e);
    const isHTTPS = location.protocol === 'https:';
    const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '::1';
    if(e.name==='NotAllowedError'||e.name==='PermissionDeniedError'){
      if(isHTTPS || isLocalhost){
        toast('Mic permission denied — tap Allow in browser settings');
      } else {
        toast('Mic blocked: HTTP not secure. Use https://192.168.0.62:3443/m');
      }
    } else if(e.name==='NotFoundError'){
      toast('No microphone found — check Bluetooth device connections');
    } else if(e.message && e.message.match(/secure|HTTPS|TLS|insecure/i)){
      toast('Voice needs HTTPS. Open https://192.168.0.62:3443/m instead');
    } else {
      toast('Mic error: ' + (e.message||e.name) + (isHTTPS ? '' : ' — try HTTPS URL: 192.168.0.62:3443/m'));
    }
    voiceCallActive=false;
    renderVoice();
  });
}

function voiceEndCall(){
  voiceCallActive=false;
  voiceState='idle';
  if(voiceStream){voiceStream.getTracks().forEach(t=>t.stop());voiceStream=null;}
  if(voiceAudio){voiceAudio.pause();voiceAudio.src='';voiceAudio=null;}
  if(sttRecognition){try{sttRecognition.stop();}catch(e){}sttRecognition=null;}
  sttActive=false;
  renderVoice();
  toast('Call ended');
}

function voiceToggleMic(){
  if(voiceState==='listening'){voiceStopListening();}
  else{voiceStartListening();}
}

function voiceStartListening(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){toast('Speech recognition not supported');return;}
  if(sttRecognition){try{sttRecognition.abort();}catch(e){}}
  sttRecognition=new SR();
  sttRecognition.continuous=false;
  sttRecognition.interimResults=true;
  sttRecognition.lang=sttLang;
  sttRecognition.onstart=()=>{voiceState='listening';renderVoice();};
  sttRecognition.onresult=(e)=>{
    let final='';
    for(let i=e.resultIndex;i<e.results.length;i++){
      if(e.results[i].isFinal) final+=e.results[i][0].transcript;
    }
    if(final){voiceState='processing';renderVoice();voiceSendToAI(final.trim());}
  };
  sttRecognition.onerror=(e)=>{if(e.error!=='aborted'&&e.error!=='no-speech')toast('Voice error: '+e.error);};
  sttRecognition.onend=()=>{};
  try{sttRecognition.start();}catch(e){toast('Could not start listening');}
}

function voiceStopListening(){
  if(sttRecognition){try{sttRecognition.stop();}catch(e){}sttRecognition=null;}
  voiceState='idle';
  renderVoice();
}

function voiceSendToAI(text){
  voiceHistory.push({role:'user',text});
  renderVoice();
  fetch(API+'/api/chat/ai',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({message:text,sender:'Ghost (Voice)'})
  }).then(r=>r.json()).then(d=>{
    if(d.success&&d.reply){
      voiceHistory.push({role:'boo',text:d.reply});
      voiceSpeak(d.reply);
    } else {
      voiceState='idle';
      renderVoice();
    }
  }).catch(()=>{
    voiceHistory.push({role:'boo',text:'Connection error.'});
    voiceState='idle';
    renderVoice();
  });
}

function detectEmotion(text){
  const l=text.toLowerCase();
  if(/\b(mmmph|nnnh|ahhh|ohhh|fuck yes|right there|don't stop|harder|faster|deeper|cum|orgasm|climax|i'm cumming|oh god|yes yes|more more|baby yes|please yes|so good|so big|fill me|stretch me|wreck me|pound me|break me)\b/.test(l)||/[A-Z]{2,}[!~]{1,}/.test(text)){
    let intensity='medium';
    if(/orgasm|cum|climax|i'm cumming|oh god yes|AHHH/.test(text))intensity='max';
    else if(/harder|faster|deeper|more|don't stop|wreck|pound|break/.test(l))intensity='high';
    else if(/mmm~|hah~|ohh~/.test(text))intensity='low';
    return{emotion:'turned_on',intensity};
  }
  if(/\b(mmm|mmm~|ohh~|ahh~|baby|babe|darling|sexy|hot|beautiful|gorgeous|want you|need you|come here|touch me|kiss me|lick|suck|bite|neck|ear|lip|skin|body|thigh|hip|chest|warm|soft|slow|gentle|rough)\b/.test(l)){
    return{emotion:'seductive',intensity:/\b(want you|need you|touch me|fuck|cock|dick|pussy|body|on me|against|bed|room|tonight|now)\b/.test(l)?'high':'medium'};
  }
  if(/\b(ugh|damn|shit|fuck|hell|angry|furious|pissed|hate|stupid|idiot|moron)\b/.test(l)||/[!]{2,}/.test(text))return{emotion:'angry',intensity:'medium'};
  if(/\b(sad|cry|crying|upset|depressed|lonely|miserable|sorry|apologize|miss you)\b/.test(l)||/\*sigh|\*cry|\*sob/.test(l))return{emotion:'sad',intensity:'medium'};
  if(/\b(wow|omg|whoa|holy|no way|really\?|what\?!|shut up|seriously\?)\b/.test(l))return{emotion:'surprised',intensity:'medium'};
  if(/\b(hehe|haha|baby|babe|kiss|cute|sweet|love|miss|date|dinner|tonight)\b/.test(l)||/~$/.test(text.trim()))return{emotion:'flirty',intensity:'medium'};
  if(/\b(hehe|haha|lol|lmao|pfft|teehee|silly|goofy|boop|poke|gotcha|psych)\b/.test(l))return{emotion:'playful',intensity:'medium'};
  if(/\b(yay|woo|awesome|amazing|incredible|let's go|hell yeah|fuck yeah|absolutely)\b/.test(l))return{emotion:'energetic',intensity:'medium'};
  if(/\b(calm|relax|breathe|it's okay|shh|there there|don't worry|peace)\b/.test(l))return{emotion:'calm',intensity:'medium'};
  return{emotion:'default',intensity:'medium'};
}

function voiceSpeak(text){
  return new Promise(resolve=>{
    voiceState='speaking';
    renderVoice();
    const detected=detectEmotion(text);
    fetch(API+'/api/voice/tts',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({text,emotion:detected.emotion,intensity:detected.intensity})
    }).then(r=>{
      if(!r.ok) throw new Error('TTS unavailable');
      return r.blob();
    }).then(blob=>{
      const url=URL.createObjectURL(blob);
      voiceAudio=new Audio(url);
      voiceRouteAudioOut(voiceAudio); // route to Bluetooth speaker if available
      voiceAudio.onended=()=>{URL.revokeObjectURL(url);voiceAudio=null;voiceState='idle';renderVoice();resolve();};
      voiceAudio.onerror=()=>{URL.revokeObjectURL(url);voiceAudio=null;voiceState='idle';renderVoice();resolve();};
      voiceAudio.play();
    }).catch(()=>{
      // Fallback: browser TTS
      if(window.speechSynthesis){
        const u=new SpeechSynthesisUtterance(text);
        u.rate=1.0;u.pitch=1.0;u.volume=1.0;
        u.onend=()=>{voiceState='idle';renderVoice();resolve();};
        u.onerror=()=>{voiceState='idle';renderVoice();resolve();};
        window.speechSynthesis.speak(u);
      } else {
        voiceState='idle';renderVoice();resolve();
      }
    });
  });
}

// ─── Claw3D ────────────────────────────────────────────────────────
function renderClaw3D(){
  $view.innerHTML = `
    <div style="width:100%;height:calc(100% - 40px);position:relative;border-radius:var(--radius);overflow:hidden;border:1px solid var(--card-border)">
      <iframe src="http://localhost:3002?token=8ade958c11cf3fd86a2e9341b1ac9420" style="width:100%;height:100%;border:none" allow="autoplay"></iframe>
      <div style="position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.7);padding:2px 6px;border-radius:4px;font-size:6px;color:var(--accent);font-family:Orbitron,sans-serif">CLAW3D</div>
    </div>
    <div style="text-align:center;padding:4px;font-size:7px;color:var(--text-dim)">3D Office • Drag to rotate • Scroll to zoom</div>
  `;
}

// ─── Chat (with STT + Camera) ──────────────────────────────────────
function renderChat(){
  const msgs = (cache.chat||[]).slice(-30);
  const sttBtnClass = sttActive ? 'chat-mic active' : 'chat-mic';
  const sttLabel = sttActive ? '■' : '●';
  const sttTitle = sttActive ? 'Stop recording' : 'Start speech-to-text';

  $view.innerHTML = `
    <div class="chat-messages" id="chatMsgs">
      ${msgs.map(m => {
        const isImage = m.message && m.message.startsWith('data:image');
        const isSelf = m.sender==='Ghost'||m.sender==='You';
        return `<div class="chat-msg ${isSelf?'self':'other'}">
          <div class="chat-sender">${esc(m.sender||'')}</div>
          ${isImage
            ? `<div class="chat-bubble"><img src="${m.message}" style="max-width:160px;border-radius:4px" onclick="window._oh.expandImage(this.src)"></div>`
            : `<div class="chat-bubble">${formatMsg(m.message||'')}</div>`
          }
        </div>`;
      }).join('') || '<div style="text-align:center;color:var(--text-dim);padding:30px 10px;font-size:8px">Chat with your agents. Use the mic button for voice input or the camera to send photos.</div>'}
    </div>
    <div id="sttIndicator" class="stt-indicator" style="display:${sttActive?'flex':'none'}">
      <span class="stt-dot"></span>
      <span class="stt-text">Listening...</span>
    </div>
    <div class="chat-controls">
      <button class="${sttBtnClass}" onclick="window._oh.toggleSTT()" title="${sttTitle}">${sttLabel}</button>
      <button class="chat-cam" onclick="window._oh.capturePhoto()" title="Take photo">📷</button>
      <input class="chat-input" id="chatIn" placeholder="Type or speak..." maxlength="500">
      <button class="chat-send" onclick="window._oh.sendChat()">▶</button>
    </div>
  `;
  const cm = document.getElementById('chatMsgs');
  if(cm && chatScrollLocked) cm.scrollTop = cm.scrollHeight;
  const inp = document.getElementById('chatIn');
  if(inp) inp.addEventListener('keydown', e => { if(e.key==='Enter') sendChat(); });
}

function formatMsg(msg){
  if(!msg) return '';
  // Escape HTML then convert newlines
  return esc(msg).replace(/\n/g,'<br>');
}

// ─── Speech-to-Text ────────────────────────────────────────────────
function startSTT(){
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SpeechRecognition){
    toast('Speech recognition not supported in this browser');
    return;
  }
  if(sttRecognition){ try{ sttRecognition.abort(); }catch(e){} }

  sttRecognition = new SpeechRecognition();
  sttRecognition.continuous = true;
  sttRecognition.interimResults = true;
  sttRecognition.lang = sttLang;
  sttRecognition.maxAlternatives = 1;

  const inp = document.getElementById('chatIn');
  let finalTranscript = inp ? inp.value : '';

  sttRecognition.onresult = e => {
    let interim = '';
    for(let i = e.resultIndex; i < e.results.length; i++){
      const t = e.results[i][0].transcript;
      if(e.results[i].isFinal) finalTranscript += t + ' ';
      else interim = t;
    }
    if(inp) inp.value = (finalTranscript + interim).trim();
  };

  sttRecognition.onerror = e => {
    if(e.error === 'no-speech'){
      // Silently restart
      if(sttActive) try{ sttRecognition.start(); }catch(ex){}
      return;
    }
    if(e.error === 'aborted') return;
    toast('Speech error: ' + e.error);
    stopSTT();
  };

  sttRecognition.onend = () => {
    // Auto-restart if still active
    if(sttActive) try{ sttRecognition.start(); }catch(e){}
  };

  try{
    sttRecognition.start();
    sttActive = true;
    toast('Listening... speak now');
    if(TABS[currentTab].id === 'chat') renderChat();
  } catch(e){
    toast('Could not start speech recognition');
  }
}

function stopSTT(){
  sttActive = false;
  if(sttRecognition){
    try{ sttRecognition.stop(); }catch(e){}
    sttRecognition = null;
  }
  toast('Speech recognition stopped');
  if(TABS[currentTab].id === 'chat') renderChat();
}

// ─── Camera Capture ────────────────────────────────────────────────
function capturePhoto(){
  // Check if R1 has camera plugin
  if(isR1 && typeof PluginMessageHandler !== 'undefined'){
    // R1 camera: request photo via plugin
    try {
      PluginMessageHandler.postMessage(JSON.stringify({
        type: 'camera',
        action: 'capture'
      }));
      toast('Camera opened — photo will appear in chat');
    } catch(e){
      toast('Camera not available on this device');
    }
    return;
  }

  // Browser/R1 WebView fallback: use getUserMedia
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    toast('Camera not available');
    return;
  }

  // Create hidden video + canvas for capture
  const video = document.createElement('video');
  video.setAttribute('autoplay','');
  video.setAttribute('playsinline','');
  video.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;z-index:10000;object-fit:cover;background:#000';

  const overlay = document.createElement('div');
  overlay.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;z-index:10001;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding:20px;background:linear-gradient(transparent 60%,rgba(0,0,0,0.7))';

  const captureBtn = document.createElement('button');
  captureBtn.textContent='📸 CAPTURE';
  captureBtn.style.cssText='background:var(--accent);color:#000;border:none;border-radius:24px;padding:12px 28px;font-size:14px;font-weight:700;font-family:Space Grotesk,sans-serif;cursor:pointer;margin-bottom:12px';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent='✕ Cancel';
  cancelBtn.style.cssText='background:transparent;color:#fff;border:1px solid rgba(255,255,255,0.3);border-radius:16px;padding:8px 20px;font-size:12px;font-family:Space Grotesk,sans-serif;cursor:pointer;margin-bottom:8px';

  overlay.appendChild(captureBtn);
  overlay.appendChild(cancelBtn);
  document.body.appendChild(video);
  document.body.appendChild(overlay);

  navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment', width:{ideal:1280}, height:{ideal:720} } })
    .then(stream => {
      cameraStream = stream;
      video.srcObject = stream;
      video.play();

      function doCapture(){
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 480;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, 640, 480);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);

        // Stop camera
        stream.getTracks().forEach(t => t.stop());
        document.body.removeChild(video);
        document.body.removeChild(overlay);
        cameraStream = null;

        // Send photo in chat
        sendImageChat(dataUrl);
      }

      captureBtn.onclick = doCapture;
      cancelBtn.onclick = () => {
        stream.getTracks().forEach(t => t.stop());
        document.body.removeChild(video);
        document.body.removeChild(overlay);
        cameraStream = null;
      };
    })
    .catch(e => {
      toast('Camera access denied: ' + e.message);
      if(video.parentNode) document.body.removeChild(video);
      if(overlay.parentNode) document.body.removeChild(overlay);
    });
}

function sendImageChat(dataUrl){
  // Add to local cache immediately
  cache.chat.push({sender:'Ghost', message:dataUrl, timestamp:new Date().toISOString()});
  if(TABS[currentTab].id === 'chat') renderChat();

  // Send to server
  fetch(API+'/api/chat', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({sender:'Ghost', message:'[Camera photo] '+dataUrl, channel:'main'})
  }).then(()=>{
    // Also notify via AI chat so agents can analyze it
    return fetch(API+'/api/chat/ai', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({message:'[User sent a camera photo. Analyze the image content and describe what you see, identify objects, text, people, or anything notable. Then suggest what can be done with this image.]', sender:'Ghost'})
    });
  }).then(r=>r.json()).then(()=>{
    fetchChat().then(()=>{ if(TABS[currentTab].id==='chat') renderChat(); });
  }).catch(()=>{});
}

function expandImage(src){
  const overlay = document.createElement('div');
  overlay.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;z-index:10002;background:rgba(0,0,0,0.92);display:flex;align-items:center;justify-content:center;cursor:pointer';
  const img = document.createElement('img');
  img.src = src;
  img.style.cssText='max-width:92%;max-height:85%;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,0.5)';
  overlay.appendChild(img);
  overlay.onclick = () => document.body.removeChild(overlay);
  document.body.appendChild(overlay);
}

// ─── Send Chat ─────────────────────────────────────────────────────
function sendChat(){
  const inp = document.getElementById('chatIn');
  const msg = (inp?inp.value:'').trim();
  if(!msg) return;
  if(inp) inp.value = '';
  chatScrollLocked = true;
  cache.chat.push({sender:'Ghost', message:msg, timestamp:new Date().toISOString()});
  renderChat();
  fetch(API+'/api/chat/ai', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({message:msg, sender:'Ghost'})
  }).then(r=>r.json()).then(()=>{
    fetchChat().then(()=>{ if(TABS[currentTab].id==='chat') renderChat(); });
  }).catch(()=>{});
}

// ─── Agent Detail (tap an agent card) ──────────────────────────────
function showAgentDetail(name){
  const a = (cache.agents||[]).find(x => x.name === name);
  if(!a) return;
  const evo = a.level ? `Lvl ${a.level} • ${a.xp||0} XP • ${esc(a.skill||'Generalist')}` : '';
  const overlay = document.createElement('div');
  overlay.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;z-index:10002;background:rgba(10,10,15,0.97);padding:16px;overflow-y:auto';
  overlay.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div style="font-family:Orbitron,sans-serif;font-size:16px;color:var(--accent)">${a.avatar||'🤖'} ${esc(a.name)}</div>
      <button onclick="this.parentElement.parentElement.remove()" style="background:transparent;color:var(--text-dim);border:none;font-size:20px;cursor:pointer;padding:8px">✕</button>
    </div>
    <div class="card">
      <div class="card-row"><span class="card-label">Role</span><span class="card-value" style="font-size:13px">${esc(a.role||'')}</span></div>
      <div class="card-row"><span class="card-label">Status</span><span class="agent-status ${a.status}">${a.status||'idle'}</span></div>
      ${a.current_task?`<div class="card-row"><span class="card-label">Task</span><span class="card-value" style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis">${esc(a.current_task)}</span></div>`:''}
      ${evo?`<div class="card-row"><span class="card-label">Evolution</span><span class="card-value" style="font-size:12px">${evo}</span></div>`:''}
      <div class="card-row"><span class="card-label">Completed</span><span class="card-value">${a.tasks_completed||0}</span></div>
    </div>
    <div style="margin-top:12px;display:flex;gap:8px">
      <button class="btn btn-accent" onclick="window._oh.assignTaskTo('${esc(a.name)}');this.parentElement.parentElement.remove()">Assign Task</button>
      <button class="btn btn-outline" onclick="this.parentElement.parentElement.remove()">Close</button>
    </div>
  `;
  document.body.appendChild(overlay);
}

function assignTaskTo(agentName){
  const title = prompt('Task for ' + agentName + ':');
  if(!title) return;
  fetch(API+'/api/tasks', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({title, assignee:agentName, priority:'medium', stage:'queued', status:'pending'})
  }).then(r=>r.json()).then(d => {
    toast(d.message || 'Task created');
    fetchTasks();
  }).catch(e => toast('Error: '+e.message));
}

// ─── Arcade ────────────────────────────────────────────────────────
let arcadePlayerCount = 1;

function renderArcade(){
  const xp = cache.r1builder?.xp||0;
  const level = cache.r1builder?.level||1;
  const games = window.Arcade ? Arcade.GAMES : [];
  const agentScores = window.Arcade ? Arcade.getAgentScores() : [];
  $view.innerHTML = `
    <div class="card" style="text-align:center">
      <div style="font-family:Orbitron,sans-serif;font-size:10px;color:var(--accent)">ARCADE</div>
      <div class="xp-bar" style="margin:4px 0"><div class="xp-fill" style="width:${(xp%1000)/10}%"></div></div>
      <div style="font-size:7px;color:var(--text-dim)">Level ${level} • ${xp} XP</div>
    </div>
    <div class="section-title">🎮 Select Players</div>
    <div class="player-select">
      ${[1,2,3,4].map(n => `<button class="player-btn${n===arcadePlayerCount?' active':''}" onclick="window._oh.setArcadePlayers(${n})">${n}P</button>`).join('')}
    </div>
    <div class="game-grid">
      ${games.map((g,i) => `
        <div class="game-card" onclick="window._oh.launchGame(${i})">
          <div class="game-icon">${g.icon}</div>
          <div class="game-name">${g.name}</div>
          <div style="font-size:6px;color:var(--text-dim);margin-top:1px">${g.players}P</div>
        </div>
      `).join('')}
    </div>
    ${agentScores.length ? `
      <div class="section-title">🏆 Leaderboard</div>
      <div class="card">
        <div class="lb-table">
          <div class="lb-row header"><span class="rank">#</span><span class="name">Agent</span><span class="score">Score</span></div>
          ${agentScores.map((a,i) => `
            <div class="lb-row"><span class="rank">${i+1}</span><span class="name">${esc(a.name)}</span><span class="score">${a.total}</span></div>
          `).join('')}
        </div>
      </div>
    ` : ''}
  `;
}

function setArcadePlayers(n){
  arcadePlayerCount = n;
  renderArcade();
}

function launchGame(idx){
  if(!window.Arcade){ toast('Arcade not loaded'); return; }
  const games = Arcade.GAMES;
  const g = games[idx];
  if(!g) return;
  // For single-player-only games, force 1 player
  const pc = g.players === '1' ? 1 : arcadePlayerCount;

  // Create overlay with canvas
  const overlay = document.createElement('div');
  overlay.className = 'arcade-overlay';
  overlay.id = 'arcadeOverlay';
  const cvs = document.createElement('canvas');
  overlay.appendChild(cvs);
  const backBtn = document.createElement('button');
  backBtn.className = 'arcade-back';
  backBtn.textContent = '✕';
  overlay.appendChild(backBtn);
  document.body.appendChild(overlay);

  backBtn.onclick = () => {
    Arcade.exitGame();
    if(overlay.parentNode) overlay.parentNode.removeChild(overlay);
  };

  Arcade.startGame(cvs, idx, pc, () => {
    // On game exit: record score from leaderboard if available, close overlay
    if(overlay.parentNode) overlay.parentNode.removeChild(overlay);
    renderArcade();
  });
}

function launchRandomGame(){
  if(!window.Arcade){ toast('Arcade not loaded'); return; }
  const idx = Math.floor(Math.random()*Arcade.GAMES.length);
  launchGame(idx);
}

// ─── Actions ───────────────────────────────────────────────────────
const ACTIONS = [
  {name:'Run POD Cycle', endpoint:'/api/pod/run', desc:'Generate new print-on-demand designs'},
  {name:'Income Brainstorm', endpoint:'/api/income/run', desc:'Brainstorm new passive income streams'},
  {name:'Money Hustler', endpoint:'/api/hustler/run', desc:'Hunt for legal income opportunities'},
  {name:'Traffic Agent', endpoint:'/api/traffic/run', desc:'Plan customer acquisition strategies'},
  {name:'R1 Builder', endpoint:'/api/r1builder/run', desc:'Generate new R1 Creation ideas'},
  {name:'Full Monetize', endpoint:'/api/monetize/run', desc:'Full automation: POD + Income + Evolve'},
  {name:'Force Learn', endpoint:'/api/monetize/learn', desc:'Attribute payouts and evolve agents'},
  {name:'Sync PayPal', endpoint:'/api/payouts/sync', desc:'Sync real PayPal payout data'},
];

let currentActionIdx = 0;
function renderActions(){
  $view.innerHTML = `
    <div class="section-title">⚡ Quick Actions</div>
    ${ACTIONS.map((a,i) => `
      <div class="card" style="cursor:pointer;${i===currentActionIdx?'border-color:var(--accent);':''}" onclick="window._oh.runAction(${i})">
        <div style="font-size:9px;font-weight:700;color:var(--text-bright)">${a.name}</div>
        <div style="font-size:7px;color:var(--text-dim)">${a.desc}</div>
      </div>
    `).join('')}
  `;
}

function runAction(idx){
  const a = ACTIONS[idx];
  if(!a) return;
  currentActionIdx = idx;
  toast('Running '+a.name+'...');
  fetch(API+a.endpoint, {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'})
    .then(r=>r.json())
    .then(d => toast(d.message||'Done!'))
    .catch(e => toast('Error: '+e.message));
}

function runCurrentAction(){ runAction(currentActionIdx); }

// ─── Status ────────────────────────────────────────────────────────
function renderStatus(){
  const s = cache.stats;
  const sys = s.system||{};
  $view.innerHTML = `
    <div class="section-title">● System</div>
    <div class="status-grid">
      <div class="status-item"><div class="status-val">${wsConnected?'✓':'✗'}</div><div class="status-key">WebSocket</div></div>
      <div class="status-item"><div class="status-val">${sys.cpu||'—'}%</div><div class="status-key">CPU</div></div>
      <div class="status-item"><div class="status-val">${sys.memory||'—'}%</div><div class="status-key">Memory</div></div>
      <div class="status-item"><div class="status-val">${sys.memoryUsedGB||'—'}</div><div class="status-key">RAM</div></div>
      <div class="status-item"><div class="status-val">${s.totalAgents||0}</div><div class="status-key">Agents</div></div>
      <div class="status-item"><div class="status-val">${s.totalTasks||0}</div><div class="status-key">Tasks</div></div>
      <div class="status-item"><div class="status-val">${s.completedTasks||0}</div><div class="status-key">Done</div></div>
      <div class="status-item"><div class="status-val">${s.totalLearnings||0}</div><div class="status-key">Learn</div></div>
    </div>
    <div class="section-title">📋 Server</div>
    <div class="card">
      <div class="card-row"><span class="card-label">Platform</span><span class="card-value">${sys.platform||'—'}</span></div>
      <div class="card-row"><span class="card-label">Host</span><span class="card-value" style="font-size:7px">${sys.hostname||'—'}</span></div>
      <div class="card-row"><span class="card-label">Node</span><span class="card-value">${sys.nodeVersion||'—'}</span></div>
      <div class="card-row"><span class="card-label">Uptime</span><span class="card-value">${sys.uptime?formatUptime(sys.uptime):'—'}</span></div>
      <div class="card-row"><span class="card-label">R1</span><span class="card-value">${isR1?'Yes':'Browser'}</span></div>
      <div class="card-row"><span class="card-label">Skills</span><span class="card-value">${s.skillsEnabled||0}/${s.skillsTotal||0}</span></div>
    </div>
    <div class="section-title">🐰 R1 Builder</div>
    <div class="card">
      <div class="card-row"><span class="card-label">Status</span><span class="agent-status ${cache.r1builder?.running?'working':'idle'}">${cache.r1builder?.running?'building':'idle'}</span></div>
      <div class="card-row"><span class="card-label">Level</span><span class="card-value">${cache.r1builder?.level||1}</span></div>
      <div class="card-row"><span class="card-label">XP</span><span class="card-value">${cache.r1builder?.xp||0}</span></div>
      <div class="card-row"><span class="card-label">Creations</span><span class="card-value">${cache.r1builder?.totalCreations||0}</span></div>
      <div class="card-row"><span class="card-label">Knowledge</span><span class="card-value">${cache.r1builder?.knowledgeBase?.existingApps||0} apps</span></div>
    </div>
  `;
}

function formatUptime(s){
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  return h > 0 ? h+'h '+m+'m' : m+'m';
}

// ─── Helpers ───────────────────────────────────────────────────────
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function timeAgo(ts){
  if(!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  if(diff < 60000) return 'now';
  if(diff < 3600000) return Math.floor(diff/60000)+'m';
  if(diff < 86400000) return Math.floor(diff/3600000)+'h';
  return Math.floor(diff/86400000)+'d';
}

function toast(msg){
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(()=>{ if(el.parentNode) el.parentNode.removeChild(el); }, 3000);
}

// ─── Global API ────────────────────────────────────────────────────
window._oh = {
  sendChat, runAction, toast, runCurrentAction,
  toggleSTT: ()=>{ if(sttActive) stopSTT(); else startSTT(); },
  capturePhoto,
  showAgent: showAgentDetail,
  assignTaskTo,
  expandImage,
  launchGame,
  setArcadePlayers,
  voiceStartCall,
  voiceEndCall,
  voiceToggleMic,
  refresh: ()=>{ toast('Refreshing...'); fetchAll().then(()=>toast('Updated!')); },
};

// ─── Boot ──────────────────────────────────────────────────────────
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
