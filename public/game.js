(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const authContainer = document.querySelector('.auth');
  const classModal = document.getElementById('class-ui');
  const classInfo = document.getElementById('class-info');
  const regForm = document.getElementById('register-form');
  const loginForm = document.getElementById('login-form');
  const regMsg = document.getElementById('reg-msg');
  const loginMsg = document.getElementById('login-msg');
  const hud = document.getElementById('hud');
  const spellbarEl = document.getElementById('spellbar');
  const logoutBtn = document.getElementById('logout-btn');
  const invModal = document.getElementById('inventory');
  const goldValue = document.getElementById('gold-value');

  const API = '';
  let token = localStorage.getItem('token');
  let socket = null;
  let playerId = null;
  let players = {}; // id -> { x, y, name, class }
  const snapshotBuffer = []; // [{ time, players, lastProcessedSeqById }]
  const INTERP_DELAY = 120; // ms
  let lastServerSelf = null;
  let isClassOpen = false;
  let projectiles = {}; // id -> projectile snapshot
  let enemies = {}; // id -> enemy snapshot
  const floatTexts = []; // {x,y,text,color,ttl,spawn}
  let currentMap = 'grass';
  let showInventory = false;
  const slotCooldowns = new Map(); // slot -> msRemaining (client view)
  const unlockLevels = [1,3,6,10,18];
  // Input send tracking + client-side prediction history
  let lastSentInput = { dx: 0, dy: 0 };
  let lastInputSendAt = 0;
  let inputSeq = 0; // monotonically increasing sequence number
  const pendingInputs = []; // [{seq, dx, dy, dt}]
  let serverLastProcessedSeq = 0; // from server snapshots (self)

  function showGame() {
    authContainer.style.display = 'none';
    canvas.style.display = 'block';
  hud.style.display = 'block';
  updateSpellbarLocks();
  }

  function showAuth() {
    authContainer.style.display = 'block';
    canvas.style.display = 'none';
    hud.style.display = 'none';
  }

  async function register(username, password) {
    const res = await fetch(API + '/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    return res.json();
  }

  async function login(username, password) {
    const res = await fetch(API + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    return res.json();
  }

  regForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    regMsg.textContent = '...';
    try {
      const data = await register(username, password);
      regMsg.textContent = data.message || data.error || JSON.stringify(data);
    } catch (err) {
      regMsg.textContent = 'Register failed';
    }
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    loginMsg.textContent = '...';
    try {
      const data = await login(username, password);
      if (data.token) {
        token = data.token;
        localStorage.setItem('token', token);
        connectSocket();
        showGame();
      } else {
        loginMsg.textContent = data.error || 'Login failed';
      }
    } catch (err) {
      loginMsg.textContent = 'Login failed';
    }
  });

  function connectSocket() {
    socket = io('/', { auth: { token } });

    socket.on('connect', () => {
      // console.log('connected');
    });

    socket.on('initState', (state) => {
      playerId = state.selfId;
      currentMap = state.map || 'grass';
      players = state.players || {};
      projectiles = state.projectiles || {};
      enemies = state.enemies || {};
      snapshotBuffer.length = 0;
      snapshotBuffer.push({ time: performance.now(), players: deepClone(state.players || {}), lastProcessedSeqById: collectSeqs(state.players || {}) });
      // initialize reconciliation pointer for self
      const me = players[playerId];
      if (me && typeof me.lastProcessedSeq === 'number') serverLastProcessedSeq = me.lastProcessedSeq;
    });

    socket.on('playerJoined', (p) => {
      players[p.id] = p;
    });

    socket.on('playerLeft', (id) => {
      delete players[id];
    });

    socket.on('state', (serverState) => {
      const serverPlayers = serverState.players || serverState; // backward compat
      const now = performance.now();
      snapshotBuffer.push({ time: now, players: deepClone(serverPlayers), lastProcessedSeqById: collectSeqs(serverPlayers) });
      while (snapshotBuffer.length > 0 && (now - snapshotBuffer[0].time) > 2000) {
        snapshotBuffer.shift();
      }
      // Replace snapshot of players entirely; render uses snapshots anyway
      currentMap = serverState.map || currentMap;
      players = serverPlayers;
      projectiles = serverState.projectiles || {};
      enemies = serverState.enemies || {};

      // Reconciliation: if we have server's auth state for self with lastProcessedSeq
      const meServer = players[playerId];
      if (meServer && typeof meServer.lastProcessedSeq === 'number') {
        const lastSeq = meServer.lastProcessedSeq;
        serverLastProcessedSeq = lastSeq;
        reconcileToServer(meServer, lastSeq);
      }
    });

    socket.on('teleport', ({ x, y }) => {
      const me = players[playerId];
      if (me) { me.x = x; me.y = y; }
  snapshotBuffer.length = 0; // snap to server
  pendingInputs.length = 0; // drop unconfirmed inputs
  serverLastProcessedSeq = 0;
    });

    socket.on('floatText', (msg) => {
      if (!msg) return;
      floatTexts.push({ x: msg.x, y: msg.y, text: msg.text, color: msg.color || '#fff', ttl: msg.ttl || 1000, spawn: performance.now() });
    });

    socket.on('castAck', ({ slot, cooldownMs }) => {
      if (typeof slot === 'number' && typeof cooldownMs === 'number') {
        slotCooldowns.set(slot, cooldownMs);
      }
    });
    socket.on('castDenied', ({ slot, reason, msLeft }) => {
      if (typeof slot === 'number' && typeof msLeft === 'number') {
        slotCooldowns.set(slot, msLeft);
      }
    });

    socket.on('classSelected', ({ id, class: cls }) => {
      if (!players[id]) players[id] = {};
      players[id].class = cls;
    });
  }

  // Input
  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    keys.add(k);
    if (k === 'c' && playerId) {
      toggleClassUI(true);
      refreshClassInfo();
    } else if (k === 'escape') {
      toggleClassUI(false);
      toggleInventory(false);
    } else if (k === 'i') {
      toggleInventory(!showInventory);
    }
    // Spell hotkeys 1-5
    const num = parseInt(k, 10);
    if (!isNaN(num) && num >= 1 && num <= 5) {
      tryCast(num);
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

  // Class UI interactions
  function toggleClassUI(show) {
    isClassOpen = !!show;
    classModal.style.display = isClassOpen ? 'flex' : 'none';
  if (isClassOpen) refreshClassInfo();
  }
  classModal?.addEventListener('click', (e) => {
    if (e.target === classModal) toggleClassUI(false);
  });
  document.querySelectorAll('.class-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cls = btn.getAttribute('data-class');
      if (socket && cls) socket.emit('chooseClass', { classId: cls });
      toggleClassUI(false);
    });
  });

  function toggleInventory(show) {
    showInventory = !!show;
    invModal.style.display = showInventory ? 'flex' : 'none';
    updateGoldUI();
  }

  function updateGoldUI() {
    const me = players[playerId];
    if (me && typeof me.gold === 'number') {
      goldValue.textContent = String(me.gold);
    }
  }

  function refreshClassInfo() {
    const me = players[playerId];
    if (!me) { classInfo.textContent = ''; return; }
    const total = me.totalLevel || 1;
    const rewardMult = me.rewardMult || 1;
    const cls = me.class || 'none';
    const clsLvl = me.level || 1;
    const bonusPct = Math.round((rewardMult - 1) * 100);
    classInfo.innerHTML = `Class: ${cls} (Lv ${clsLvl})<br/>Total Level: ${total}<br/>Bonus XP/Gold: +${bonusPct}%`;
  }

  // Logout wiring
  logoutBtn?.addEventListener('click', () => {
    try { socket?.disconnect(); } catch {}
    socket = null;
    localStorage.removeItem('token');
    token = null;
    playerId = null;
    players = {};
    projectiles = {};
    enemies = {};
    snapshotBuffer.length = 0;
    showAuth();
  });

  // Client-side prediction + send updates
  let last = performance.now();
  const speed = 200; // px/s

  function tick(ts) {
    const dt = (ts - last) / 1000; last = ts;

    // Send inputs to server
    sendInputIfNeeded(dt);

    // Client-side prediction: apply own input immediately to local player
    const me = players[playerId];
    if (me) {
      const v = currentInputVector();
      let dx = v.dx, dy = v.dy;
      const len = Math.hypot(dx, dy) || 0;
      if (len > 0) { dx /= len; dy /= len; }
      const slowActive = (me.slowUntil || 0) > performance.now();
      const speedFactor = slowActive ? (me.slowFactor || 0.6) : 1;
      if (dx !== 0 || dy !== 0) {
        me.x += dx * speed * speedFactor * dt;
        me.y += dy * speed * speedFactor * dt;
      }
      // enqueue predicted input for reconciliation
      if (dx !== 0 || dy !== 0) {
        pendingInputs.push({ seq: inputSeq, dx, dy, dt: dt * speed * speedFactor });
      } else if (pendingInputs.length && pendingInputs[pendingInputs.length-1]?.seq !== inputSeq) {
        // still advance seq even if idle to keep ordering consistent
        pendingInputs.push({ seq: inputSeq, dx: 0, dy: 0, dt: 0 });
      }
    }

  // render
    ctx.clearRect(0,0,canvas.width,canvas.height);
    // background per map
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    if (currentMap === 'slime') {
      ctx.fillStyle = 'rgba(0, 80, 0, 0.15)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else if (currentMap === 'safe') {
      ctx.fillStyle = 'rgba(100, 100, 255, 0.10)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

  // Interpolate remote players based on buffered snapshots
    const renderTime = performance.now() - INTERP_DELAY;
    const a = findSnapshotBefore(renderTime);
    const b = findSnapshotAfter(renderTime);
    const base = (b || a) ? (b?.players || a.players) : {};

  for (const id in base) {
      let x, y, name;
      name = (players[id]?.name) || (base[id]?.name) || 'player';
        if (id === playerId && players[id]) {
          // use predicted local position
          x = players[id].x; y = players[id].y;
        } else {
          const pa = a?.players[id];
          const pb = b?.players[id];
          if (pa && pb && b.time !== a.time) {
            const t = (renderTime - a.time) / (b.time - a.time);
            x = smoothstepLerp(pa.x, pb.x, t);
            y = smoothstepLerp(pa.y, pb.y, t);
          } else if (pa) {
            x = pa.x; y = pa.y;
          } else if (pb) {
            x = pb.x; y = pb.y;
          } else {
            continue;
          }
        }
      ctx.beginPath();
      // slow effect visual for self
      const isSelf = id === playerId;
      if (isSelf && (players[id]?.slowUntil || 0) > performance.now()) {
        ctx.fillStyle = '#7fd';
      } else {
        ctx.fillStyle = isSelf ? '#5cf' : '#ccc';
      }
      ctx.arc(x, y, 10, 0, Math.PI*2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(name, x, y - 14);
      // Health bar for players if available
      const php = players[id]?.hp ?? base[id]?.hp;
      const pmax = players[id]?.hpMax ?? base[id]?.hpMax;
      if (typeof php === 'number' && typeof pmax === 'number') {
        drawHealthBar(x, y - 24, php, pmax, id === playerId ? '#5cf' : '#9f9');
      }
      // Render class label if present
      const cls = players[id]?.class || base[id]?.class || null;
      if (cls) {
        ctx.fillStyle = '#9cf';
        ctx.font = '11px sans-serif';
        ctx.fillText(`[${cls}]`, x, y + 20);
        ctx.fillStyle = '#fff';
        ctx.font = '12px sans-serif';
      }
    }

    // Draw projectiles
    for (const pid in projectiles) {
      const pr = projectiles[pid];
      if (!pr) continue;
      ctx.beginPath();
      ctx.fillStyle = pr.kind === 'fireball' ? '#ff7a3c' : '#fff';
      ctx.arc(pr.x, pr.y, pr.radius || 4, 0, Math.PI*2);
      ctx.shadowColor = '#ffb088';
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Draw enemies (slimes)
    for (const eid in enemies) {
      const en = enemies[eid];
      if (!en) continue;
      ctx.beginPath();
      ctx.fillStyle = en.kind === 'slime' ? '#6bd36b' : '#bbb';
      ctx.arc(en.x, en.y, en.radius || 12, 0, Math.PI*2);
      ctx.fill();
      if (typeof en.hp === 'number' && typeof en.hpMax === 'number') {
        drawHealthBar(en.x, en.y - (en.radius || 12) - 10, en.hp, en.hpMax, '#6bd36b');
      }
    }

  // Draw floating texts
    const nowFt = performance.now();
    for (let i = floatTexts.length - 1; i >= 0; i--) {
      const ft = floatTexts[i];
      const t = (nowFt - ft.spawn) / ft.ttl;
      if (t >= 1) { floatTexts.splice(i, 1); continue; }
      const y = ft.y - t * 30;
      const a = 1 - t;
      ctx.globalAlpha = Math.max(0, a);
      ctx.fillStyle = ft.color;
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(ft.text, ft.x, y);
      ctx.globalAlpha = 1;
    }

  requestAnimationFrame(tick);
  // Update HUD bits
  updateGoldUI();
  }
  requestAnimationFrame(tick);

  // Auto login if token exists
  if (token) {
    showGame();
    connectSocket();
  }

  // utils
  function deepClone(obj) { return JSON.parse(JSON.stringify(obj || {})); }
  function lerp(a, b, t) { t = Math.max(0, Math.min(1, t)); return a + (b - a) * t; }
  function findSnapshotBefore(t) {
    let prev = null;
    for (let i = snapshotBuffer.length - 1; i >= 0; i--) {
      const s = snapshotBuffer[i];
      if (s.time <= t) { prev = s; break; }
    }
    return prev || snapshotBuffer[0] || null;
  }
  function findSnapshotAfter(t) {
    for (let i = 0; i < snapshotBuffer.length; i++) {
      const s = snapshotBuffer[i];
      if (s.time >= t) return s;
    }
    return snapshotBuffer[snapshotBuffer.length - 1] || null;
  }
  function smoothstep(t){ t = Math.max(0, Math.min(1, t)); return t*t*(3-2*t);} 
  function smoothstepLerp(a,b,t){ return lerp(a,b,smoothstep(t)); }

  function sendInputIfNeeded(dt) {
    if (!socket || !playerId) return;
    const { dx, dy } = currentInputVector();
    const len = Math.hypot(dx, dy) || 0;
    const now = performance.now();
    const changed = dx !== lastSentInput.dx || dy !== lastSentInput.dy;
    if (changed || (now - lastInputSendAt) > 100) {
      inputSeq = (inputSeq + 1) >>> 0; // wrap-safe 32-bit
      socket.emit('input', { dx, dy, seq: inputSeq });
      lastSentInput = { dx, dy };
      lastInputSendAt = now;
    }
  }

  function currentInputVector() {
    let dx = 0, dy = 0;
    if (keys.has('w') || keys.has('arrowup')) dy -= 1;
    if (keys.has('s') || keys.has('arrowdown')) dy += 1;
    if (keys.has('a') || keys.has('arrowleft')) dx -= 1;
    if (keys.has('d') || keys.has('arrowright')) dx += 1;
    return { dx, dy };
  }

  function reconcileToServer(serverMe, lastSeq) {
    const me = players[playerId]; if (!me) return;
    const dxPos = me.x - serverMe.x;
    const dyPos = me.y - serverMe.y;
    const err = Math.hypot(dxPos, dyPos);
    const THRESH = 4; // pixels tolerance
    if (err > THRESH) {
      // Snap to server position, then reapply pending inputs after lastSeq
      me.x = serverMe.x; me.y = serverMe.y;
      // drop all inputs up to and including lastSeq
      let i = 0;
      while (i < pendingInputs.length && pendingInputs[i].seq <= lastSeq) i++;
      const remaining = pendingInputs.slice(i);
      // rebuild from server-auth position
      for (const inp of remaining) {
        me.x += inp.dx * inp.dt;
        me.y += inp.dy * inp.dt;
      }
      // keep only remaining for future reconciliation
      pendingInputs.length = 0;
      Array.prototype.push.apply(pendingInputs, remaining);
    } else {
      // discard confirmed inputs to prevent growth
      let i = 0; while (i < pendingInputs.length && pendingInputs[i].seq <= lastSeq) i++;
      if (i > 0) pendingInputs.splice(0, i);
    }
  }

  function collectSeqs(pl) {
    const map = {}; for (const id in pl) map[id] = pl[id]?.lastProcessedSeq || 0; return map;
  }

  // Health bar drawing helper
  function drawHealthBar(x, y, hp, hpMax, color = '#9cf') {
    const w = 40, h = 6;
    const pad = 1;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - w/2, y, w, h);
    const ratio = Math.max(0, Math.min(1, (hp || 0) / (hpMax || 1)));
    ctx.fillStyle = color;
    ctx.fillRect(x - w/2 + pad, y + pad, (w - 2*pad) * ratio, h - 2*pad);
  }

  // Casting helpers
  function updateSpellbarLocks() {
    const me = players[playerId];
    const lvl = me?.level || 1;
    document.querySelectorAll('#spellbar .slot').forEach(el => {
      const s = Number(el.getAttribute('data-slot'));
      const req = unlockLevels[s-1];
      el.classList.toggle('locked', lvl < req);
      el.classList.toggle('ready', lvl >= req);
      // cooldown overlay
      const left = slotCooldowns.get(s) || 0;
      if (left > 0) {
        el.style.setProperty('--cd', Math.min(1, left / 1000).toString());
        el.style.background = `linear-gradient(to top, rgba(0,0,0,.5) ${Math.min(100, (left/1000)*100)}%, transparent 0%)`;
      } else {
        el.style.background = '';
      }
    });
  }
  function tryCast(slot) {
    const me = players[playerId];
    if (!me) return;
    if (me.level < unlockLevels[slot-1]) return;
    if ((slotCooldowns.get(slot) || 0) > 0) return;
    // For slot 1: mage fireball cast toward mouse position
    const target = lastMousePos || { x: me.x, y: me.y };
    socket?.emit('cast', { slot, targetX: target.x, targetY: target.y });
  }

  // Mouse targeting
  let lastMousePos = null;
  function getCanvasPos(evt) {
    const rect = canvas.getBoundingClientRect();
    return { x: (evt.clientX - rect.left), y: (evt.clientY - rect.top) };
  }
  canvas.addEventListener('mousemove', (e) => { lastMousePos = getCanvasPos(e); });
  canvas.addEventListener('click', (e) => {
    lastMousePos = getCanvasPos(e);
    tryCast(1); // primary cast on click for now
  });

  // Reflect level/class updates and refresh UI locks
  setInterval(() => {
    // decrement client-side cooldowns
    const dt = 100;
    for (const [slot, ms] of [...slotCooldowns]) {
      const n = Math.max(0, ms - dt);
      if (n <= 0) slotCooldowns.delete(slot); else slotCooldowns.set(slot, n);
    }
    if (playerId) updateSpellbarLocks();
  }, 100);

  // XP bar HUD (per current class)
  const xpBar = document.createElement('div');
  xpBar.className = 'xpbar';
  const xpFill = document.createElement('div');
  xpFill.className = 'xpfill';
  xpBar.appendChild(xpFill);
  document.body.appendChild(xpBar);
  function xpForNextLevel(level){ return 100 + (level - 1) * 50; }
  setInterval(() => {
    const me = players[playerId]; if (!me) return;
    const cls = me.class || 'none';
    const xp = (me.xpByClass?.[cls]) || 0;
    const need = xpForNextLevel(me.level || 1);
    const r = Math.max(0, Math.min(1, xp / need));
    xpFill.style.width = `${r*100}%`;
  }, 500);
})();
