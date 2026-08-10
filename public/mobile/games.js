/* ═══════════════════════════════════════════════════════════════════
   OpenHub R1 — Complete Arcade Games
   8 fully working games + Agent Leaderboard
   All games: 240x282 canvas, R1 scroll/sideClick + keyboard/mouse
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const Arcade = (() => {
const W = 240, H = 282;
let canvas, ctx, activeGame = null, animFrame = null;
let onBack = null;

// ─── Leaderboard ───────────────────────────────────────────────────
const LB_KEY = 'r1oh_arcade_lb';
function getLB(){ try { return JSON.parse(localStorage.getItem(LB_KEY)) || {}; } catch(e){ return {}; } }
function saveLB(lb){ try { localStorage.setItem(LB_KEY, JSON.stringify(lb)); } catch(e){} }
function recordScore(game, player, score){
  const lb = getLB();
  if(!lb[game]) lb[game] = [];
  lb[game].push({ player, score, time: Date.now() });
  lb[game].sort((a,b) => b.score - a.score);
  lb[game] = lb[game].slice(0, 20);
  saveLB(lb);
}
function getLeaderboard(game){ return (getLB()[game] || []).slice(0, 10); }
function getAgentScores(){
  const lb = getLB();
  const totals = {};
  for(const [game, entries] of Object.entries(lb)){
    for(const e of entries){
      if(!totals[e.player]) totals[e.player] = { total: 0, games: 0, best: {} };
      totals[e.player].total += e.score;
      totals[e.player].games++;
      if(!totals[e.player].best[game] || e.score > totals[e.player].best[game])
        totals[e.player].best[game] = e.score;
    }
  }
  return Object.entries(totals)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a,b) => b.total - a.total)
    .slice(0, 10);
}

// ─── Input ─────────────────────────────────────────────────────────
let keys = {};
let scrollDir = 0, sideClicked = false;
function setupInput(){
  window.addEventListener('scrollUp', () => { scrollDir = -1; });
  window.addEventListener('scrollDown', () => { scrollDir = 1; });
  window.addEventListener('sideClick', () => { sideClicked = true; });
  window.addEventListener('keydown', e => {
    keys[e.key] = true;
    if(e.key === 'Escape' || e.key === 'Backspace') exitGame();
  });
  window.addEventListener('keyup', e => { keys[e.key] = false; });
  if(canvas){
    canvas.addEventListener('click', e => {
      const r = canvas.getBoundingClientRect();
      canvas._clickX = e.clientX - r.left;
      canvas._clickY = e.clientY - r.top;
      canvas._clicked = true;
    });
    canvas.addEventListener('touchstart', e => {
      e.preventDefault();
      const t = e.touches[0];
      const r = canvas.getBoundingClientRect();
      canvas._clickX = t.clientX - r.left;
      canvas._clickY = t.clientY - r.top;
      canvas._clicked = true;
    }, {passive:false});
  }
}
function consumeScroll(){ const d = scrollDir; scrollDir = 0; return d; }
function consumeClick(){ const c = canvas._clicked; canvas._clicked = false; return c; }
function consumeSide(){ const c = sideClicked; sideClicked = false; return c; }

// ─── Drawing Helpers ───────────────────────────────────────────────
function clear(){ ctx.fillStyle = '#0a0a0f'; ctx.fillRect(0,0,W,H); }
function text(str, x, y, size, color, align){
  ctx.fillStyle = color || '#fff';
  ctx.font = (size||10)+'px JetBrains Mono, monospace';
  ctx.textAlign = align || 'center';
  ctx.fillText(str, x, y);
}
function rect(x,y,w,h,color){
  ctx.fillStyle = color;
  ctx.fillRect(x,y,w,h);
}
function roundRect(x,y,w,h,r,color){
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath(); ctx.fill();
}

// ═══════════════════════════════════════════════════════════════════
// GAME 1: SNAKE (2-4 players on same device, turn-based or split)
// ═══════════════════════════════════════════════════════════════════
function gameSnake(playerCount){
  const GRID = 12, COLS = Math.floor(W/GRID), ROWS = Math.floor((H-30)/GRID);
  const colors = ['#00f0ff','#ff3366','#00ff88','#ffaa00'];
  let snakes = [], foods = [], alive = [], scores = [], gameOver = false, tick = 0;

  function init(){
    snakes = []; alive = []; scores = [];
    for(let i=0; i<playerCount; i++){
      const startX = 3 + i * 4, startY = Math.floor(ROWS/2);
      snakes.push([{x:startX, y:startY},{x:startX-1, y:startY},{x:startX-2, y:startY}]);
      alive.push(true);
      scores.push(0);
    }
    foods = [];
    spawnFood();
    spawnFood();
  }

  function spawnFood(){
    let x, y, tries = 0;
    do { x = Math.floor(Math.random()*COLS); y = Math.floor(Math.random()*ROWS); tries++; }
    while(tries < 100 && snakes.some(s => s.some(p => p.x===x && p.y===y)));
    foods.push({x,y});
  }

  function step(){
    if(gameOver) return;
    tick++;
    // Player 1 uses arrow keys, others use WASD/IKJL/etc
    const dirs = [
      {dx: keys.ArrowRight?1:keys.ArrowLeft?-1:0, dy: keys.ArrowDown?1:keys.ArrowUp?-1:0},
      {dx: keys.d?1:keys.a?-1:0, dy: keys.s?1:keys.w?-1:0},
      {dx: keys.l?1:keys.j?-1:0, dy: keys.k?1:keys.i?-1:0},
      {dx: keys.ArrowRight?1:keys.ArrowLeft?-1:0, dy: 0} // P4 uses number pad
    ];

    for(let i=0; i<playerCount; i++){
      if(!alive[i]) continue;
      const snake = snakes[i];
      const d = dirs[i] || {dx:0,dy:0};
      // Prevent 180 turn
      const head = snake[0];
      if(d.dx !== 0 && head.x + d.dx !== snake[1]?.x) {
        snake.unshift({x: head.x + d.dx, y: head.y});
        snake.pop();
      } else if(d.dy !== 0 && head.y + d.dy !== snake[1]?.y) {
        snake.unshift({x: head.x, y: head.y + d.dy});
        snake.pop();
      } else {
        // Continue in same direction if no input
        const dx = head.x - (snake[1]?.x || head.x);
        const dy = head.y - (snake[1]?.y || head.y);
        snake.unshift({x: head.x + dx, y: head.y + dy});
        snake.pop();
      }

      const newHead = snake[0];
      // Wall collision
      if(newHead.x < 0 || newHead.x >= COLS || newHead.y < 0 || newHead.y >= ROWS){
        alive[i] = false; continue;
      }
      // Self collision
      if(snake.slice(1).some(p => p.x === newHead.x && p.y === newHead.y)){
        alive[i] = false; continue;
      }
      // Other snake collision
      for(let j=0; j<playerCount; j++){
        if(j===i || !alive[j]) continue;
        if(snakes[j].some(p => p.x === newHead.x && p.y === newHead.y)){
          alive[i] = false; break;
        }
      }
      // Food
      const fi = foods.findIndex(f => f.x === newHead.x && f.y === newHead.y);
      if(fi >= 0){
        scores[i] += 10;
        snake.push({...snake[snake.length-1]});
        foods.splice(fi, 1);
        spawnFood();
      }
    }

    if(alive.filter(Boolean).length < 2 && playerCount > 1){
      gameOver = true;
      for(let i=0; i<playerCount; i++) if(alive[i]) scores[i] += 50;
    }
    if(playerCount === 1 && !alive[0]) gameOver = true;
  }

  function draw(){
    clear();
    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    for(let x=0; x<=COLS; x++){ ctx.beginPath(); ctx.moveTo(x*GRID,0); ctx.lineTo(x*GRID,ROWS*GRID); ctx.stroke(); }
    for(let y=0; y<=ROWS; y++){ ctx.beginPath(); ctx.moveTo(0,y*GRID); ctx.lineTo(COLS*GRID,y*GRID); ctx.stroke(); }

    // Food
    foods.forEach(f => {
      ctx.fillStyle = '#ff3366';
      ctx.beginPath();
      ctx.arc(f.x*GRID+GRID/2, f.y*GRID+GRID/2, GRID/3, 0, Math.PI*2);
      ctx.fill();
    });

    // Snakes
    for(let i=0; i<playerCount; i++){
      snakes[i].forEach((p, idx) => {
        ctx.fillStyle = alive[i] ? colors[i] : 'rgba(100,100,100,0.3)';
        ctx.fillRect(p.x*GRID+1, p.y*GRID+1, GRID-2, GRID-2);
        if(idx === 0 && alive[i]){
          ctx.fillStyle = '#fff';
          ctx.fillRect(p.x*GRID+3, p.y*GRID+3, 3, 3);
        }
      });
    }

    // HUD
    text('SNAKE', W/2, H-20, 10, '#00f0ff');
    for(let i=0; i<playerCount; i++){
      text(`P${i+1}:${scores[i]}`, 30 + i*55, H-8, 8, colors[i]);
    }
    if(gameOver){
      roundRect(40, H/2-25, 160, 50, 8, 'rgba(0,0,0,0.8)');
      text('GAME OVER', W/2, H/2-5, 12, '#ff3366');
      text('Side click to exit', W/2, H/2+12, 8, '#666');
    }
  }

  init();
  return { update(){ if(tick%6===0) step(); draw(); if(consumeSide() && gameOver) exitGame(); }, destroy(){} };
}

// ═══════════════════════════════════════════════════════════════════
// GAME 2: 2048 (1 player, scroll to select direction, sideClick to confirm)
// ═══════════════════════════════════════════════════════════════════
function game2048(){
  const SIZE = 4, TILE = 50, OFFSET_X = (W-SIZE*TILE)/2, OFFSET_Y = 20;
  let grid, score, best, won, gameOver;

  function init(){
    grid = Array(SIZE).fill(null).map(() => Array(SIZE).fill(0));
    score = 0; best = parseInt(localStorage.getItem('r1oh_2048_best')||'0');
    won = false; gameOver = false;
    spawn(); spawn();
  }
  function spawn(){
    const empty = [];
    for(let r=0;r<SIZE;r++) for(let c=0;c<SIZE;c++) if(grid[r][c]===0) empty.push({r,c});
    if(!empty.length) return;
    const {r,c} = empty[Math.floor(Math.random()*empty.length)];
    grid[r][c] = Math.random()<0.9 ? 2 : 4;
  }
  function slide(row){
    let a = row.filter(v=>v), merged = false;
    for(let i=0;i<a.length-1;i++){
      if(a[i]===a[i+1]){ a[i]*=2; score+=a[i]; a.splice(i+1,1); merged=true; }
    }
    while(a.length<SIZE) a.push(0);
    return a;
  }
  function move(dir){
    let moved = false;
    const g2 = grid.map(r=>[...r]);
    if(dir===0){ // left
      for(let r=0;r<SIZE;r++){ const n=slide(grid[r]); if(n.join(',')!==grid[r].join(',')) moved=true; grid[r]=n; }
    } else if(dir===2){ // right
      for(let r=0;r<SIZE;r++){ const n=slide([...grid[r]].reverse()).reverse(); if(n.join(',')!==grid[r].join(',')) moved=true; grid[r]=n; }
    } else if(dir===1){ // up
      for(let c=0;c<SIZE;c++){ const col=grid.map(r=>r[c]); const n=slide(col); if(n.join(',')!==col.join(',')) moved=true; for(let r=0;r<SIZE;r++) grid[r][c]=n[r]; }
    } else { // down
      for(let c=0;c<SIZE;c++){ const col=grid.map(r=>r[c]).reverse(); const n=slide(col).reverse(); const orig=grid.map(r=>r[c]).join(','); if(n.join(',')!==orig) moved=true; for(let r=0;r<SIZE;r++) grid[r][c]=n[r]; }
    }
    if(moved){ spawn(); if(score>best){ best=score; localStorage.setItem('r1oh_2048_best',best); } }
    if(!canMove()) gameOver = true;
    if(!won && grid.some(r=>r.some(v=>v>=2048))) won = true;
  }
  function canMove(){
    for(let r=0;r<SIZE;r++) for(let c=0;c<SIZE;c++){
      if(grid[r][c]===0) return true;
      if(c<SIZE-1 && grid[r][c]===grid[r][c+1]) return true;
      if(r<SIZE-1 && grid[r][c]===grid[r+1][c]) return true;
    }
    return false;
  }
  function tileColor(v){
    const colors = {0:'#1a1a2e',2:'#2d2d5e',4:'#4a3f8a',8:'#7b2fbe',16:'#c62368',32:'#e63946',64:'#f4a261',128:'#e9c46a',256:'#2a9d8f',512:'#264653',1024:'#00f0ff',2048:'#ffaa00'};
    return colors[v] || '#ff3366';
  }

  let moveDir = -1, moveTimer = 0;
  function update(){
    clear();
    moveTimer++;
    const sd = consumeScroll();
    if(sd && !gameOver) moveDir = (moveDir + 1) % 4;
    if(consumeSide() && !gameOver && moveDir >= 0){ move(moveDir); moveDir = -1; }

    // Grid
    for(let r=0;r<SIZE;r++) for(let c=0;c<SIZE;c++){
      const x = OFFSET_X + c*TILE, y = OFFSET_Y + r*TILE;
      roundRect(x+1, y+1, TILE-2, TILE-2, 4, tileColor(grid[r][c]));
      if(grid[r][c]) text(grid[r][c], x+TILE/2, y+TILE/2+4, grid[r][c]>=100?11:13, '#fff');
    }

    // Direction indicator
    const arrows = ['←','↑','→','↓'];
    if(moveDir >= 0 && !gameOver){
      text('Move: ' + arrows[moveDir], W/2, OFFSET_Y + SIZE*TILE + 20, 10, '#00f0ff');
      text('Side click to slide', W/2, OFFSET_Y + SIZE*TILE + 34, 8, '#666');
    }

    text('2048', W/2, 14, 12, '#ffaa00');
    text('Score: '+score, 60, 14, 9, '#fff', 'left');
    text('Best: '+best, W-60, 14, 9, '#666', 'right');

    if(won){ roundRect(50,H/2-20,140,40,8,'rgba(0,0,0,0.8)'); text('YOU WIN! 2048!',W/2,H/2+4,11,'#ffaa00'); }
    if(gameOver){ roundRect(50,H/2-20,140,40,8,'rgba(0,0,0,0.8)'); text('GAME OVER',W/2,H/2+4,11,'#ff3366'); text('Click to exit',W/2,H/2+18,8,'#666'); }
    if(gameOver && consumeSide()) exitGame();
  }
  init();
  return { update, destroy(){} };
}

// ═══════════════════════════════════════════════════════════════════
// GAME 3: MEMORY (1-4 players, turn-based card matching)
// ═══════════════════════════════════════════════════════════════════
function gameMemory(playerCount){
  const COLS = 4, ROWS = 4, CARD_W = 52, CARD_H = 52;
  const OX = (W - COLS*CARD_W)/2, OY = 15;
  const SYMBOLS = ['🍎','🍊','🍋','🍇','🍉','🍓','🫐','🥝'];
  let cards, flipped, matched, currentPlayer, scores, lockInput, flipTimer;
  let selectedCard = 0, gameOver = false;

  function init(){
    const pairs = (COLS*ROWS)/2;
    const syms = SYMBOLS.slice(0, pairs);
    let deck = [...syms, ...syms];
    // Shuffle
    for(let i=deck.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [deck[i],deck[j]]=[deck[j],deck[i]]; }
    cards = deck.map(s => ({symbol:s, faceUp:false, matched:false}));
    flipped = []; matched = 0; currentPlayer = 0;
    scores = Array(playerCount).fill(0);
    lockInput = false; flipTimer = 0; selectedCard = 0; gameOver = false;
  }

  function flip(cardIdx){
    if(lockInput || cards[cardIdx].faceUp || cards[cardIdx].matched) return;
    cards[cardIdx].faceUp = true;
    flipped.push(cardIdx);

    if(flipped.length === 2){
      lockInput = true;
      const [a,b] = flipped;
      if(cards[a].symbol === cards[b].symbol){
        cards[a].matched = cards[b].matched = true;
        matched++;
        scores[currentPlayer] += 20;
        flipped = [];
        lockInput = false;
        if(matched === cards.length/2) gameOver = true;
      } else {
        flipTimer = 40;
      }
    }
  }

  function update(){
    clear();
    if(flipTimer > 0){
      flipTimer--;
      if(flipTimer === 0){
        flipped.forEach(i => cards[i].faceUp = false);
        flipped = [];
        currentPlayer = (currentPlayer + 1) % playerCount;
        lockInput = false;
      }
    }

    // Scroll to move selection
    const sd = consumeScroll();
    if(sd && !lockInput && !gameOver){
      selectedCard = (selectedCard + sd + cards.length) % cards.length;
    }
    if(consumeSide() && !gameOver){
      flip(selectedCard);
    }

    // Draw cards
    for(let i=0;i<cards.length;i++){
      const c = cards[i];
      const col = i%COLS, row = Math.floor(i/COLS);
      const x = OX + col*CARD_W, y = OY + row*CARD_H;
      const selected = i === selectedCard && !lockInput;

      if(c.matched){
        roundRect(x+2, y+2, CARD_W-4, CARD_H-4, 6, 'rgba(0,255,136,0.15)');
        text(c.symbol, x+CARD_W/2, y+CARD_H/2+6, 18, 'rgba(255,255,255,0.3)');
      } else if(c.faceUp || flipped.includes(i)){
        roundRect(x+2, y+2, CARD_W-4, CARD_H-4, 6, '#2d2d5e');
        text(c.symbol, x+CARD_W/2, y+CARD_H/2+6, 20, '#fff');
      } else {
        roundRect(x+2, y+2, CARD_W-4, CARD_H-4, 6, selected ? '#4a3f8a' : '#1a1a2e');
        if(selected){
          ctx.strokeStyle = '#00f0ff';
          ctx.lineWidth = 2;
          ctx.strokeRect(x+3, y+3, CARD_W-6, CARD_H-6);
        }
        text('?', x+CARD_W/2, y+CARD_H/2+6, 16, '#555');
      }
    }

    // HUD
    const colors = ['#00f0ff','#ff3366','#00ff88','#ffaa00'];
    for(let i=0;i<playerCount;i++){
      text(`P${i+1}:${scores[i]}`, 30+i*60, H-20, 9, i===currentPlayer?colors[i]:'#666');
    }
    text(`P${currentPlayer+1}'s turn`, W/2, H-8, 8, colors[currentPlayer]);

    if(gameOver){
      roundRect(40, H/2-25, 160, 50, 8, 'rgba(0,0,0,0.8)');
      text('COMPLETE!', W/2, H/2-5, 12, '#00ff88');
      const winner = scores.indexOf(Math.max(...scores));
      text(`P${winner+1} wins!`, W/2, H/2+12, 9, colors[winner]);
      if(consumeSide()) exitGame();
    }
  }
  init();
  return { update, destroy(){} };
}

// ═══════════════════════════════════════════════════════════════════
// GAME 4: PONG (1-2 players + AI, up to 4 with extra AI)
// ═══════════════════════════════════════════════════════════════════
function gamePong(playerCount){
  const PW = 8, PH = 40;
  let paddles, ball, scores, gameOver, rallies;

  function init(){
    paddles = [];
    scores = Array(playerCount).fill(0);
    gameOver = false; rallies = 0;
    // P1 left, P2 right, P3 top (horizontal), P4 bottom (horizontal)
    if(playerCount >= 1) paddles.push({x:10, y:H/2-PH/2, w:PW, h:PH, dy:0, ai: false});
    if(playerCount >= 2) paddles.push({x:W-10-PW, y:H/2-PH/2, w:PW, h:PH, dy:0, ai: playerCount===2});
    if(playerCount >= 3) paddles.push({x:W/2-PH/2, y:10, w:PH, h:PW, dx:0, ai: true, horiz:true});
    if(playerCount >= 4) paddles.push({x:W/2-PH/2, y:H-10-PW, w:PH, h:PW, dx:0, ai: true, horiz:true});
    resetBall();
  }

  function resetBall(){
    ball = {x:W/2, y:H/2, vx: (Math.random()>0.5?1:-1)*2.5, vy: (Math.random()-0.5)*3, r:4};
    rallies = 0;
  }

  function update(){
    clear();
    if(consumeSide() && gameOver) exitGame();

    // Paddle movement
    if(paddles[0] && !paddles[0].ai){
      if(keys.ArrowUp) paddles[0].y -= 4;
      if(keys.ArrowDown) paddles[0].y += 4;
    }
    if(paddles[1] && !paddles[1].ai){
      if(keys.w) paddles[1].y -= 4;
      if(keys.s) paddles[1].y += 4;
    }
    if(paddles[2] && !paddles[2].ai){
      if(keys.ArrowLeft) paddles[2].x -= 4;
      if(keys.ArrowRight) paddles[2].x += 4;
    }
    if(paddles[3] && !paddles[3].ai){
      if(keys.a) paddles[3].x -= 4;
      if(keys.d) paddles[3].x += 4;
    }

    // AI
    paddles.forEach((p, i) => {
      if(!p.ai) return;
      if(p.horiz){
        const target = ball.x - p.w/2;
        const diff = target - p.x;
        p.x += Math.sign(diff) * Math.min(Math.abs(diff), 2.5);
      } else {
        const target = ball.y - p.h/2;
        const diff = target - p.y;
        p.y += Math.sign(diff) * Math.min(Math.abs(diff), 2.5);
      }
    });

    // Clamp paddles
    paddles.forEach(p => {
      if(p.horiz){ p.x = Math.max(0, Math.min(W-p.w, p.x)); }
      else { p.y = Math.max(0, Math.min(H-p.h, p.y)); }
    });

    // Ball movement
    ball.x += ball.vx;
    ball.y += ball.vy;

    // Paddle collisions
    paddles.forEach((p, i) => {
      if(p.horiz){
        if(ball.y - ball.r < p.y + p.h && ball.y + ball.r > p.y &&
           ball.x > p.x && ball.x < p.x + p.w){
          ball.vy = -ball.vy;
          ball.y = ball.vy < 0 ? p.y - ball.r : p.y + p.h + ball.r;
          ball.vx += (ball.x - (p.x + p.w/2)) * 0.15;
          rallies++;
        }
      } else {
        if(ball.x - ball.r < p.x + p.w && ball.x + ball.r > p.x &&
           ball.y > p.y && ball.y < p.y + p.h){
          ball.vx = -ball.vx;
          ball.x = ball.vx < 0 ? p.x - ball.r : p.x + p.w + ball.r;
          ball.vy += (ball.y - (p.y + p.h/2)) * 0.15;
          rallies++;
        }
      }
    });

    // Wall / scoring
    if(ball.y < 0 || ball.y > H){ ball.vy = -ball.vy; ball.y = Math.max(ball.r, Math.min(H-ball.r, ball.y)); }
    if(ball.x < 0){ scores[1] = (scores[1]||0)+1; resetBall(); }
    if(ball.x > W){ scores[0] = (scores[0]||0)+1; resetBall(); }
    if(ball.y < 0 && paddles[2]) { scores[2] = (scores[2]||0)+1; resetBall(); }
    if(ball.y > H && paddles[3]) { scores[3] = (scores[3]||0)+1; resetBall(); }

    // Speed cap
    const speed = Math.sqrt(ball.vx*ball.vx + ball.vy*ball.vy);
    if(speed > 6){ ball.vx *= 6/speed; ball.vy *= 6/speed; }

    // Draw
    // Center line
    ctx.setLineDash([4,4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath(); ctx.moveTo(W/2,0); ctx.lineTo(W/2,H); ctx.stroke();
    ctx.setLineDash([]);

    // Paddles
    const pColors = ['#00f0ff','#ff3366','#00ff88','#ffaa00'];
    paddles.forEach((p,i) => {
      roundRect(p.x, p.y, p.w, p.h, 3, pColors[i]);
    });

    // Ball
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI*2); ctx.fill();

    // Scores
    for(let i=0;i<Math.min(playerCount,2);i++){
      text(scores[i]||0, i===0?W/4:W*3/4, 20, 16, pColors[i]);
    }

    text('PONG', W/2, H-8, 8, '#555');
  }
  init();
  return { update, destroy(){} };
}

// ═══════════════════════════════════════════════════════════════════
// GAME 5: FLAPPY (1 player, sideClick to flap, scroll to flap)
// ═══════════════════════════════════════════════════════════════════
function gameFlappy(){
  let bird, pipes, score, best, gameOver, started, frameCount;

  function init(){
    bird = {x:50, y:H/2, vy:0, r:8};
    pipes = []; score = 0;
    best = parseInt(localStorage.getItem('r1oh_flappy_best')||'0');
    gameOver = false; started = false; frameCount = 0;
  }

  function flap(){
    if(gameOver){ init(); return; }
    if(!started) started = true;
    bird.vy = -4.5;
  }

  function update(){
    clear();
    frameCount++;
    if(consumeSide() || consumeScroll()) flap();

    if(started && !gameOver){
      // Physics
      bird.vy += 0.25;
      bird.y += bird.vy;

      // Pipes
      if(frameCount % 90 === 0){
        const gap = 60;
        const gapY = 40 + Math.random() * (H - 80 - gap);
        pipes.push({x: W, gapY, gap, scored: false});
      }

      pipes.forEach(p => {
        p.x -= 2;
        // Score
        if(!p.scored && p.x + 20 < bird.x){ p.scored = true; score++; }
        // Collision
        if(bird.x + bird.r > p.x && bird.x - bird.r < p.x + 20){
          if(bird.y - bird.r < p.gapY || bird.y + bird.r > p.gapY + p.gap){
            gameOver = true;
            if(score > best){ best = score; localStorage.setItem('r1oh_flappy_best', best); }
          }
        }
      });
      pipes = pipes.filter(p => p.x > -30);

      // Ground/ceiling
      if(bird.y > H - 10 || bird.y < 0){
        gameOver = true;
        if(score > best){ best = score; localStorage.setItem('r1oh_flappy_best', best); }
      }
    }

    // Draw pipes
    pipes.forEach(p => {
      roundRect(p.x, 0, 20, p.gapY, 0, '#2d5e2d');
      roundRect(p.x, p.gapY + p.gap, 20, H - p.gapY - p.gap, 0, '#2d5e2d');
      // Highlight
      rect(p.x, p.gapY - 4, 20, 4, '#4a8a4a');
      rect(p.x, p.gapY + p.gap, 20, 4, '#4a8a4a');
    });

    // Bird
    ctx.fillStyle = '#ffaa00';
    ctx.beginPath(); ctx.arc(bird.x, bird.y, bird.r, 0, Math.PI*2); ctx.fill();
    // Eye
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(bird.x+3, bird.y-2, 3, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(bird.x+4, bird.y-2, 1.5, 0, Math.PI*2); ctx.fill();

    // HUD
    text(score, W/2, 25, 18, '#fff');
    text('Best: '+best, W/2, 40, 8, '#666');

    if(!started){
      text('FLAPPY', W/2, H/2-20, 14, '#ffaa00');
      text('Side click to flap', W/2, H/2, 9, '#666');
    }
    if(gameOver){
      roundRect(40, H/2-25, 160, 50, 8, 'rgba(0,0,0,0.8)');
      text('GAME OVER', W/2, H/2-5, 12, '#ff3366');
      text('Score: '+score, W/2, H/2+10, 9, '#fff');
      text('Click to restart', W/2, H/2+22, 7, '#666');
    }
  }
  init();
  return { update, destroy(){} };
}

// ═══════════════════════════════════════════════════════════════════
// GAME 6: SIMON (1-4 players, memory sequence)
// ═══════════════════════════════════════════════════════════════════
function gameSimon(playerCount){
  const COLORS = ['#ff3366','#00f0ff','#00ff88','#ffaa00'];
  const LABELS = ['R','B','G','Y'];
  let sequence, playerSeq, currentPlayer, scores, state, flashIdx, flashTimer;
  let inputIdx, gameOver, level;

  function init(){
    sequence = []; scores = Array(playerCount).fill(0);
    currentPlayer = 0; state = 'watch'; // watch, input, gameover
    flashIdx = 0; flashTimer = 0; inputIdx = 0; gameOver = false; level = 0;
    nextRound();
  }

  function nextRound(){
    sequence.push(Math.floor(Math.random() * 4));
    state = 'watch'; flashIdx = 0; flashTimer = 0;
    level++;
  }

  function update(){
    clear();

    if(state === 'watch'){
      flashTimer++;
      if(flashTimer > 20){
        flashTimer = 0;
        flashIdx++;
        if(flashIdx >= sequence.length){
          state = 'input';
          inputIdx = 0;
          playerSeq = [];
        }
      }
    }

    if(state === 'input'){
      const sd = consumeScroll();
      if(sd || consumeSide()){
        const btn = sd ? ((sd+1)/2|0) : 0; // scroll up=0, down=1, side=0
        const btnIdx = sd ? (sd < 0 ? 0 : 1) : 0;
        playerSeq.push(btnIdx);
        if(playerSeq[inputIdx] !== sequence[inputIdx]){
          state = 'gameover';
          gameOver = true;
        } else {
          inputIdx++;
          if(inputIdx >= sequence.length){
            scores[currentPlayer] += sequence.length * 10;
            currentPlayer = (currentPlayer + 1) % playerCount;
            setTimeout(nextRound, 500);
          }
        }
      }
    }

    // Draw 4 colored quadrants
    const bw = W/2, bh = (H-40)/2;
    for(let i=0;i<4;i++){
      const x = (i%2)*bw, y = Math.floor(i/2)*bh;
      let color = COLORS[i];
      if(state === 'watch' && flashIdx < sequence.length){
        if(sequence[flashIdx] === i) color = '#fff';
      }
      ctx.globalAlpha = state === 'watch' ? 0.6 : 1;
      rect(x+2, y+2, bw-4, bh-4, color);
      ctx.globalAlpha = 1;
      text(LABELS[i], x+bw/2, y+bh/2+4, 12, '#000');
    }

    // HUD
    const colors = ['#00f0ff','#ff3366','#00ff88','#ffaa00'];
    for(let i=0;i<playerCount;i++){
      text(`P${i+1}:${scores[i]}`, 30+i*55, H-18, 8, colors[i]);
    }
    text('SIMON Lvl:'+level, W/2, H-6, 8, '#555');

    if(gameOver){
      roundRect(40, H/2-25, 160, 50, 8, 'rgba(0,0,0,0.8)');
      text('WRONG!', W/2, H/2-5, 12, '#ff3366');
      const winner = scores.indexOf(Math.max(...scores));
      text(`P${winner+1} wins!`, W/2, H/2+12, 9, colors[winner]);
      if(consumeSide()) exitGame();
    }
  }
  init();
  return { update, destroy(){} };
}

// ═══════════════════════════════════════════════════════════════════
// GAME 7: WHACK-A-MOLE (1-4 players, turn-based, timed)
// ═══════════════════════════════════════════════════════════════════
function gameWhack(playerCount){
  const HOLES = 6, HOLE_W = 70, HOLE_H = 60;
  let moles, scores, currentPlayer, timer, gameOver, moleTimer, selectedHole;

  function init(){
    moles = Array(HOLES).fill(null).map(() => ({up:false, timer:0}));
    scores = Array(playerCount).fill(0);
    currentPlayer = 0; timer = 600; gameOver = false;
    moleTimer = 0; selectedHole = 0;
  }

  function update(){
    clear();
    if(gameOver){ if(consumeSide()) exitGame(); }

    const sd = consumeScroll();
    if(sd && !gameOver) selectedHole = (selectedHole + sd + HOLES) % HOLES;
    if(consumeSide() && !gameOver){
      if(moles[selectedHole].up){
        scores[currentPlayer] += 10;
        moles[selectedHole].up = false;
      }
    }

    if(!gameOver){
      timer--;
      moleTimer++;
      if(moleTimer > 30){
        moleTimer = 0;
        const idx = Math.floor(Math.random() * HOLES);
        moles[idx].up = true;
        moles[idx].timer = 40;
      }
      moles.forEach(m => { if(m.up){ m.timer--; if(m.timer<=0) m.up = false; } });
      if(timer <= 0){
        gameOver = true;
        currentPlayer = (currentPlayer + 1) % playerCount;
        if(currentPlayer === 0) gameOver = true; // All players went
        else { timer = 600; gameOver = false; }
      }
    }

    // Draw holes
    for(let i=0;i<HOLES;i++){
      const col = i%3, row = Math.floor(i/3);
      const x = 15 + col * (HOLE_W+10), y = 30 + row * (HOLE_H+20);
      // Hole
      ctx.fillStyle = '#1a1a2e';
      ctx.beginPath(); ctx.ellipse(x+HOLE_W/2, y+HOLE_H-5, HOLE_W/2-5, 12, 0, 0, Math.PI*2); ctx.fill();
      // Mole
      if(moles[i].up){
        ctx.fillStyle = '#8B4513';
        ctx.beginPath(); ctx.arc(x+HOLE_W/2, y+HOLE_H/2, 18, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(x+HOLE_W/2-5, y+HOLE_H/2-3, 3, 0, Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(x+HOLE_W/2+5, y+HOLE_H/2-3, 3, 0, Math.PI*2); ctx.fill();
      }
      // Selection indicator
      if(i === selectedHole && !gameOver){
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, HOLE_W, HOLE_H);
      }
    }

    // HUD
    const colors = ['#00f0ff','#ff3366','#00ff88','#ffaa00'];
    for(let i=0;i<playerCount;i++){
      text(`P${i+1}:${scores[i]}`, 30+i*55, H-18, 8, colors[i]);
    }
    text(`Time:${Math.ceil(timer/60)}`, W/2, H-6, 8, timer<120?'#ff3366':'#fff');
    text(`P${currentPlayer+1}'s turn`, W/2, 16, 8, colors[currentPlayer]);

    if(gameOver){
      roundRect(40, H/2-25, 160, 50, 8, 'rgba(0,0,0,0.8)');
      text('TIME UP!', W/2, H/2-5, 12, '#ffaa00');
      const winner = scores.indexOf(Math.max(...scores));
      text(`P${winner+1} wins!`, W/2, H/2+12, 9, colors[winner]);
    }
  }
  init();
  return { update, destroy(){} };
}

// ═══════════════════════════════════════════════════════════════════
// GAME 8: BUBBLE POP (1-4 players, tap bubbles before they escape)
// ═══════════════════════════════════════════════════════════════════
function gameBubble(playerCount){
  const MAX_BUBBLES = 8;
  let bubbles, scores, currentPlayer, timer, gameOver, selectedBubble, spawnTimer;

  function init(){
    bubbles = []; scores = Array(playerCount).fill(0);
    currentPlayer = 0; timer = 600; gameOver = false;
    selectedBubble = 0; spawnTimer = 0;
    for(let i=0;i<3;i++) spawnBubble();
  }

  function spawnBubble(){
    if(bubbles.length >= MAX_BUBBLES) return;
    const r = 12 + Math.random() * 10;
    bubbles.push({
      x: r + Math.random() * (W - r*2),
      y: H - r,
      vx: (Math.random()-0.5)*2,
      vy: -(1.5 + Math.random()*2),
      r,
      color: ['#00f0ff','#ff3366','#00ff88','#ffaa00','#7c3aed'][Math.floor(Math.random()*5)],
      points: Math.round(30 - r)
    });
  }

  function update(){
    clear();
    if(gameOver){ if(consumeSide()) exitGame(); }

    const sd = consumeScroll();
    if(sd && !gameOver && bubbles.length){
      selectedBubble = (selectedBubble + sd + bubbles.length) % bubbles.length;
    }
    if(consumeSide() && !gameOver && bubbles.length){
      const b = bubbles[selectedBubble];
      if(b){
        scores[currentPlayer] += b.points;
        bubbles.splice(selectedBubble, 1);
        if(selectedBubble >= bubbles.length) selectedBubble = Math.max(0, bubbles.length-1);
        currentPlayer = (currentPlayer + 1) % playerCount;
      }
    }

    if(!gameOver){
      timer--;
      spawnTimer++;
      if(spawnTimer > 40){ spawnTimer = 0; spawnBubble(); }

      bubbles.forEach(b => { b.x += b.vx; b.y += b.vy; b.vy -= 0.02; });
      bubbles = bubbles.filter(b => b.y > -b.r && b.x > -b.r && b.x < W+b.r);

      if(timer <= 0) gameOver = true;
    }

    // Draw
    bubbles.forEach((b, i) => {
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = b.color;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI*2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI*2); ctx.stroke();
      text(b.points, b.x, b.y+4, 8, '#fff');
      if(i === selectedBubble && !gameOver){
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r+4, 0, Math.PI*2); ctx.stroke();
      }
    });

    // HUD
    const colors = ['#00f0ff','#ff3366','#00ff88','#ffaa00'];
    for(let i=0;i<playerCount;i++){
      text(`P${i+1}:${scores[i]}`, 30+i*55, H-18, 8, colors[i]);
    }
    text(`Time:${Math.ceil(timer/60)}`, W/2, H-6, 8, timer<120?'#ff3366':'#fff');

    if(gameOver){
      roundRect(40, H/2-25, 160, 50, 8, 'rgba(0,0,0,0.8)');
      text('TIME UP!', W/2, H/2-5, 12, '#ffaa00');
      const winner = scores.indexOf(Math.max(...scores));
      text(`P${winner+1} wins!`, W/2, H/2+12, 9, colors[winner]);
    }
  }
  init();
  return { update, destroy(){} };
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════
const GAMES = [
  { id:'snake',     name:'Snake',      icon:'🐍', players: '1-4', factory: (n) => gameSnake(n) },
  { id:'2048',      name:'2048',       icon:'🔢', players: '1',   factory: () => game2048() },
  { id:'memory',    name:'Memory',     icon:'🃏', players: '1-4', factory: (n) => gameMemory(n) },
  { id:'pong',      name:'Pong',       icon:'🏓', players: '1-4', factory: (n) => gamePong(n) },
  { id:'flappy',    name:'Flappy',     icon:'🐦', players: '1',   factory: () => gameFlappy() },
  { id:'simon',     name:'Simon',      icon:'🔴', players: '1-4', factory: (n) => gameSimon(n) },
  { id:'whack',     name:'Whack-a-Mole', icon:'🔨', players: '1-4', factory: (n) => gameWhack(n) },
  { id:'bubble',    name:'Bubble Pop', icon:'🫧', players: '1-4', factory: (n) => gameBubble(n) },
];

function startGame(canvasEl, gameIdx, playerCount, backCb){
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  canvas.width = W; canvas.height = H;
  onBack = backCb;
  setupInput();
  const g = GAMES[gameIdx];
  activeGame = g.factory(playerCount || 1);
  function loop(){
    clear();
    activeGame.update();
    animFrame = requestAnimationFrame(loop);
  }
  loop();
}

function exitGame(){
  if(animFrame) cancelAnimationFrame(animFrame);
  if(activeGame && activeGame.destroy) activeGame.destroy();
  activeGame = null;
  if(onBack) onBack();
}

return {
  GAMES, W, H,
  startGame, exitGame,
  getLeaderboard, getAgentScores, recordScore,
  getLB, saveLB
};
})();

if(typeof window !== 'undefined') window.Arcade = Arcade;
