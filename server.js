'use strict';
const express = require('express');
const http = require('http');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const storage = require('./storage');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// In-memory stores
const users = new Map(); // username -> { username, passHash }
const players = new Map(); // userId -> { id, name, x, y, class, level, hp, hpMax, xpByClass, cooldowns }
let nextProjId = 1;
const projectiles = new Map(); // projId -> { id, owner, map, x, y, vx, vy, radius, expiresAt }
let nextEnemyId = 1;
const enemies = new Map(); // enemyId -> { id, kind, map, x, y, vx, vy, radius }
const sockets = new Map(); // username -> socket

// Helpers
function signToken(username) {
  return jwt.sign({ sub: username }, JWT_SECRET, { expiresIn: '7d' });
}

function authMiddleware(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { username: payload.sub };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Routes
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (users.has(username)) return res.status(409).json({ error: 'username taken' });
  const passHash = await bcrypt.hash(password, 10);
  users.set(username, { username, passHash });
  try { storage.setUser(username, { username, passHash }); } catch {}
  return res.json({ message: 'registered' });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  let user = users.get(username);
  if (!user) {
    const persisted = storage.getUser(username);
    if (persisted) {
      user = persisted;
      users.set(username, user);
    }
  }
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(password, user.passHash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  const token = signToken(username);
  return res.json({ token });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ username: req.user.username });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const TICK_MS = 33; // ~30 Hz
const SPEED = 200; // px/s
const WORLD = { w: 800, h: 600 };
const inputs = new Map(); // username -> { dx, dy, at, seq }
const respawnQueue = []; // [{ at, count }]
// Anti-cheat notes:
// - Server-authoritative movement and combat
// - Rate limits on inputs/casts
// - Target clamping and map-scoped projectiles
// - Persisted state on server; clients never set gold/xp directly
// TODO: Consider adding signature checks, replay protection, and authoritative inventory transactions.

function ensurePlayerFromStorage(username) {
  // Create player if not exists
  if (!players.has(username)) {
    players.set(username, {
      id: username,
      name: username,
      x: 400 + Math.random() * 40 - 20,
      y: 300 + Math.random() * 40 - 20,
      class: null,
      level: 1,
      hp: 100,
      hpMax: 100,
      xpByClass: {},
      cooldowns: {},
    lastSafe: { map: 'safe', x: WORLD.w / 2, y: WORLD.h - 30 },
      gold: 0,
    });
  }
  const p = players.get(username);
  const pdata = storage.getPlayerData(username) || { selectedClass: null, classes: {} };
  // migrate legacy class id 'mage' to 'firemage'
  if (pdata.selectedClass === 'mage') pdata.selectedClass = 'firemage';
  if (pdata.classes && pdata.classes.mage && !pdata.classes.firemage) {
    pdata.classes.firemage = pdata.classes.mage;
    delete pdata.classes.mage;
  }
  if (typeof pdata.gold !== 'number') pdata.gold = 0;
  const sel = pdata.selectedClass || null;
  if (sel) {
    const clsBag = pdata.classes[sel] || { level: 1, xp: 0, hpMax: 100, hp: 100 };
    p.class = sel;
    p.level = clsBag.level || 1;
    p.hpMax = clsBag.hpMax || 100;
    p.hp = Math.min(p.hpMax, clsBag.hp ?? p.hpMax);
    p.xpByClass[sel] = clsBag.xp || 0;
  }
  // If nothing existed, write defaults to storage lazily
  if (!storage.getPlayerData(username)) {
    storage.setPlayerData(username, pdata);
  }
  // default lastSafe if missing
  if (!p.lastSafe) p.lastSafe = { map: 'safe', x: WORLD.w / 2, y: WORLD.h - 30 };
  p.gold = typeof pdata.gold === 'number' ? pdata.gold : 0;
  return p;
}

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('No token'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.user = { username: payload.sub };
    next();
  } catch (e) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const username = socket.user.username;
  // Ensure player exists and load persisted state if available
  ensurePlayerFromStorage(username);
  sockets.set(username, socket);
  const pSelf = players.get(username);
  pSelf.map = pSelf.map || 'grass';

  // Send initial state
  socket.emit('initState', buildSnapshotForMap(pSelf.map, username));
  // notify others in same map
  for (const [u, s] of sockets) {
    if (u === username) continue;
    const op = players.get(u);
    if (op && op.map === pSelf.map) s.emit('playerJoined', pSelf);
  }

  // Authoritative input: client only sends direction intent
  socket.on('input', ({ dx, dy, seq }) => {
  // simple anti-cheat rate limit: max 50 inputs/second
  const now = Date.now();
  socket._rateIn = socket._rateIn || { c: 0, t: now };
  if (now - socket._rateIn.t > 1000) { socket._rateIn.c = 0; socket._rateIn.t = now; }
  if (++socket._rateIn.c > 50) return;
    const p = players.get(username);
    if (!p) return;
    const ndx = Number(dx) || 0;
    const ndy = Number(dy) || 0;
    // clamp to [-1,1]
    inputs.set(username, { dx: Math.max(-1, Math.min(1, ndx)), dy: Math.max(-1, Math.min(1, ndy)), at: Date.now(), seq: Number(seq) || 0 });
  });

  // Class selection (only 'firemage' for now)
  socket.on('chooseClass', ({ classId }) => {
    const p = players.get(username);
    if (!p) return;
    if (!classId) return;
    const allowed = new Set(['firemage']);
    if (!allowed.has(classId)) return;
  p.class = classId;
  // Load or create per-class bag
  const pdata = storage.getPlayerData(username) || { selectedClass: null, classes: {} };
  pdata.selectedClass = classId;
  const bag = pdata.classes[classId] || { level: 1, xp: 0, hpMax: 100, hp: 100 };
  pdata.classes[classId] = bag;
  // Reflect into live player
  p.level = bag.level || 1;
  p.hpMax = bag.hpMax || 100;
  p.hp = Math.min(p.hpMax, bag.hp ?? p.hpMax);
  p.xpByClass[classId] = bag.xp || 0;
  try { storage.setPlayerData(username, pdata); } catch {}
    // Notify this client (ack) and others via next broadcast
    socket.emit('classSelected', { id: p.id, class: p.class });
  });

  // Cast spell (basic gating)
  socket.on('cast', ({ slot, targetX, targetY }) => {
  // simple anti-cheat rate limit: max 10 casts/second (cooldowns still apply)
  const nowRt = Date.now();
  socket._rateCast = socket._rateCast || { c: 0, t: nowRt };
  if (nowRt - socket._rateCast.t > 1000) { socket._rateCast.c = 0; socket._rateCast.t = nowRt; }
  if (++socket._rateCast.c > 10) return;
    const p = players.get(username);
    if (!p) return;
    if (typeof slot !== 'number') return;
    // Unlock levels per slot: 1,3,6,10,18
    const unlock = [1, 3, 6, 10, 18];
    if (slot < 1 || slot > 5) return;
    if ((p.level || 1) < unlock[slot - 1]) return;
    const now = Date.now();
    p.cooldowns = p.cooldowns || {};
    const onCdUntil = p.cooldowns[slot] || 0;
    if (onCdUntil > now) {
      const msLeft = onCdUntil - now;
      socket.emit('castDenied', { slot, reason: 'cooldown', msLeft });
      return;
    }

  // Only firemage spell 1: fireball
  if (p.class === 'firemage' && slot === 1) {
      // clamp target within world bounds
      const tx = Math.max(0, Math.min(WORLD.w, Number(targetX) || p.x));
      const ty = Math.max(0, Math.min(WORLD.h, Number(targetY) || p.y));
      const dx = (tx - p.x);
      const dy = (ty - p.y);
      const len = Math.hypot(dx, dy) || 1;
      const speed = 450; // px/s
      const vx = (dx / len) * speed;
      const vy = (dy / len) * speed;
      const id = nextProjId++;
      const lifetime = 1500; // ms
      const maxDist = 550; // px range limit
      projectiles.set(id, {
        id,
        owner: p.id,
  map: p.map || 'grass',
        x: p.x,
        y: p.y,
        sx: p.x,
        sy: p.y,
        vx,
        vy,
        radius: 4,
        expiresAt: Date.now() + lifetime,
        kind: 'fireball',
        maxDist
      });
      // set cooldown 1s
  const cdMs = 1000;
      p.cooldowns[slot] = now + cdMs;
      socket.emit('castAck', { slot, cooldownMs: cdMs });
    }
  });

  socket.on('disconnect', () => {
    // Persist current class state on disconnect
    const p = players.get(username);
    if (p && p.class) {
      const pdata = storage.getPlayerData(username) || { selectedClass: p.class, classes: {} };
      const cls = p.class;
      const bag = pdata.classes[cls] || { level: 1, xp: 0, hpMax: 100, hp: 100 };
      bag.level = p.level || bag.level || 1;
      bag.hpMax = p.hpMax || bag.hpMax || 100;
      bag.hp = Math.max(0, Math.min(bag.hpMax || p.hpMax || 100, p.hp ?? bag.hp ?? (bag.hpMax || 100)));
      bag.xp = p.xpByClass?.[cls] ?? bag.xp ?? 0;
      pdata.classes[cls] = bag;
      pdata.selectedClass = cls;
      try { storage.setPlayerData(username, pdata); } catch {}
    }
    // Keep players in world on disconnect? For now, remove.
    players.delete(username);
    sockets.delete(username);
    // notify others in same map
    for (const [u, s] of sockets) {
      const op = players.get(u);
      if (op && p && op.map === p.map) s.emit('playerLeft', username);
    }
  });
});

// Simple enemy spawner
function spawnSlimes(map = 'grass', n = 5) {
  for (let i = 0; i < n; i++) {
    const id = nextEnemyId++;
    const x = 100 + Math.random() * 600;
    const y = 150 + Math.random() * 300;
    const baseSpeed = 30 + Math.random() * 20;
    const angle = Math.random() * Math.PI * 2;
    let stats;
    if (map === 'grass') {
      stats = { level: 1, radius: 12, hp: 50, hpMax: 50, aggressive: false, xpReward: 20, goldReward: 5, detectRange: 220, touchDamage: 8, moveSpeed: baseSpeed };
    } else if (map === 'slime') {
      stats = { level: 2, radius: 14, hp: 90, hpMax: 90, aggressive: true, fireRateMs: 1400, attackRange: 260, shotDamage: 14, shotSpeed: 300, slowFactor: 0.6, slowMs: 1300, xpReward: 40, goldReward: 12, detectRange: 320, touchDamage: 12, moveSpeed: baseSpeed + 5 };
    } else { // slime2
      stats = { level: 3, radius: 15, hp: 120, hpMax: 120, aggressive: true, fireRateMs: 1000, attackRange: 280, shotDamage: 18, shotSpeed: 340, slowFactor: 0.6, slowMs: 1400, xpReward: 60, goldReward: 18, detectRange: 360, touchDamage: 16, moveSpeed: baseSpeed + 15 };
    }
    enemies.set(id, { id, kind: 'slime', map, x, y, vx: Math.cos(angle)*(stats.moveSpeed||baseSpeed), vy: Math.sin(angle)*(stats.moveSpeed||baseSpeed), ...stats });
  }
}
if (enemies.size === 0) { spawnSlimes('grass', 6); spawnSlimes('slime', 6); spawnSlimes('slime2', 6); /* no spawns in 'safe' */ }

// Broadcast loop (~30 Hz)
setInterval(() => {
  const dt = TICK_MS / 1000;
  const now = Date.now();

  // Apply inputs to move players
  for (const [id, p] of players) {
    const inp = inputs.get(id) || { dx: 0, dy: 0, at: 0, seq: p.lastProcessedSeq || 0 };
    let { dx, dy, at } = inp;
    if (!at || (now - at) > 200) { dx = 0; dy = 0; }
    const len = Math.hypot(dx, dy) || 0;
    if (len > 0) { dx /= len; dy /= len; }
  // slow debuff
  const slowActive = p.slowUntil && p.slowUntil > now;
  const speedFactor = slowActive ? (p.slowFactor || 0.6) : 1;
    p.x += dx * SPEED * speedFactor * dt;
    p.y += dy * SPEED * speedFactor * dt;
    // mark last processed input sequence number for reconciliation
    p.lastProcessedSeq = inp.seq || p.lastProcessedSeq || 0;
    // map transitions at edges
    p.map = p.map || 'grass';
    if (p.map === 'grass' && p.x >= WORLD.w - 5) {
      p.map = 'slime';
      p.x = 20; // enter from left
      const s = sockets.get(id);
      if (s) s.emit('teleport', { x: p.x, y: p.y });
    } else if (p.map === 'slime' && p.x <= 5) {
      p.map = 'grass';
      p.x = WORLD.w - 20; // enter from right
      const s = sockets.get(id);
      if (s) s.emit('teleport', { x: p.x, y: p.y });
    } else if (p.map === 'slime' && p.x >= WORLD.w - 5) {
      p.map = 'slime2';
      p.x = 20; // enter slime2 from left
      const s = sockets.get(id);
      if (s) s.emit('teleport', { x: p.x, y: p.y });
    } else if (p.map === 'slime2' && p.x <= 5) {
      p.map = 'slime';
      p.x = WORLD.w - 20; // back to slime from right
      const s = sockets.get(id);
      if (s) s.emit('teleport', { x: p.x, y: p.y });
    } else if (p.map === 'grass' && p.y <= 5) {
      // enter SAFE zone north of grass
      p.map = 'safe';
      p.y = WORLD.h - 20; // appear at bottom of safe
      // mark last safe visited
      p.lastSafe = { map: 'safe', x: p.x, y: p.y };
      const s = sockets.get(id);
      if (s) s.emit('teleport', { x: p.x, y: p.y });
    } else if (p.map === 'safe' && p.y >= WORLD.h - 5) {
      // return to grass from south edge of safe
      p.map = 'grass';
      p.y = 20; // appear near top of grass
      const s = sockets.get(id);
      if (s) s.emit('teleport', { x: p.x, y: p.y });
    }
    // bounds with 10px margin
    p.x = Math.max(10, Math.min(WORLD.w - 10, p.x));
    p.y = Math.max(10, Math.min(WORLD.h - 10, p.y));
  }

  // Step projectiles and handle collisions
  for (const [id, pr] of Array.from(projectiles.entries())) {
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    const dist = Math.hypot((pr.x - (pr.sx ?? pr.x)), (pr.y - (pr.sy ?? pr.y)));

    // Collide with enemies
    let remove = false;
    if (pr.kind !== 'slimeBall') {
      for (const e of enemies.values()) {
        if (e.map !== pr.map) continue;
        const d = Math.hypot(e.x - pr.x, e.y - pr.y);
        if (d <= (e.radius + pr.radius)) {
          // Apply damage to enemy
          const dmg = pr.kind === 'fireball' ? 20 : (pr.damage || 10);
          e.hp = Math.max(0, (e.hp ?? 1) - dmg);
          // floating damage number in same map
          emitFloatText(e.x, e.y - (e.radius || 12) - 6, `-${dmg}`, '#ffcc66', 1000, e.map);
          remove = true;
          if (e.hp <= 0) {
            enemies.delete(e.id);
            // schedule respawn of 1 slime in ~2.5s
            respawnQueue.push({ at: now + 2500, count: 1, map: e.map });
            // Award XP and gold to owner if exists
            const owner = players.get(pr.owner);
            if (owner) {
              const cls = owner.class || 'none';
              // Persisted per-class bag
              const pdata = storage.getPlayerData(owner.id) || { selectedClass: owner.class || null, classes: {} };
              const bag = pdata.classes[cls] || { level: 1, xp: 0, hpMax: 100, hp: 100 };
              const mult = getRewardMultiplier(owner.id);
              const xpBase = e.xpReward || 20;
              const goldBase = e.goldReward || 0;
              // deny XP if killing enemies 3+ levels below
              const lvlDiff = (bag.level || 1) - (e.level || 1);
              let xpGain = Math.max(1, Math.floor(xpBase * mult));
              if (lvlDiff >= 3) xpGain = 0;
              const goldGain = Math.max(0, Math.floor(goldBase * mult));
              bag.xp = (bag.xp || 0) + xpGain;
              owner.xpByClass[cls] = bag.xp;
              // XP float text at enemy location, scoped to map
              if (xpGain > 0) emitFloatText(e.x, e.y, `+${xpGain} XP`, '#66ccff', 1000, e.map);
              if (goldGain > 0) {
                pdata.gold = Math.max(0, (pdata.gold || 0) + goldGain);
                owner.gold = pdata.gold;
                emitFloatText(e.x, e.y - 14, `+${goldGain}g`, '#ffd700', 1000, e.map);
              }
              // Level up loop (per-class)
              let need = xpForNextLevel(bag.level || 1);
              while ((bag.level || 1) < 10 && (bag.xp || 0) >= need) {
                bag.xp -= need;
                bag.level = (bag.level || 1) + 1;
                bag.hpMax = (bag.hpMax || 100) + 5;
                bag.hp = Math.min(bag.hpMax, (bag.hp ?? bag.hpMax) + 10);
                need = xpForNextLevel(bag.level);
              }
              pdata.classes[cls] = bag;
              pdata.selectedClass = cls; // reflect current
              try { storage.setPlayerData(owner.id, pdata); } catch {}
              // Mirror into live fields for current class
              if (owner.class === cls) {
                owner.level = bag.level;
                owner.hpMax = bag.hpMax;
                owner.hp = Math.min(owner.hpMax, bag.hp);
              }
            }
          }
          break;
        }
      }
    }

    // Collide with players (PvP for player projectiles outside safe)
    if (!remove && pr.kind !== 'slimeBall') {
      for (const pv of players.values()) {
        if (pv.id === pr.owner) continue;
        if ((pv.map || 'grass') !== pr.map) continue;
        if ((pv.map || 'grass') === 'safe') continue; // PvP disabled in safe zone
        const d = Math.hypot(pv.x - pr.x, pv.y - pr.y);
        const prRad = pr.radius || 4;
        if (d <= (10 + prRad)) {
          const dmg = pr.damage || (pr.kind === 'fireball' ? 20 : 10);
          pv.hp = Math.max(0, (pv.hp ?? 1) - dmg);
          emitFloatText(pv.x, pv.y - 20, `-${dmg}`, '#ff3333', 1000, pv.map || 'grass');
          remove = true;
          if (pv.hp <= 0) handlePlayerDeath(pv, now, pr.owner, true);
          break;
        }
      }
    }

    // Collide with players (slimeBall)
    if (!remove && pr.kind === 'slimeBall') {
      for (const p of players.values()) {
        if ((p.map || 'grass') !== pr.map) continue;
        const d = Math.hypot(p.x - pr.x, p.y - pr.y);
        const prRad = pr.radius || 5;
        if (d <= (10 + prRad)) { // player radius ~10
          const dmg = pr.damage || 12;
          p.hp = Math.max(0, (p.hp ?? 1) - dmg);
          // apply slow
          const slowMs = pr.slowMs || 1200;
          p.slowFactor = pr.slowFactor || 0.6;
          p.slowUntil = now + slowMs;
          emitFloatText(p.x, p.y - 20, `-${dmg}`, '#ff5555', 1000, p.map || 'grass');
          remove = true;
          if (p.hp <= 0) handlePlayerDeath(p, now);
          break;
        }
      }
    }

    if (remove || pr.x < -50 || pr.x > 850 || pr.y < -50 || pr.y > 650 || now > pr.expiresAt || (pr.maxDist && dist > pr.maxDist)) {
      projectiles.delete(id);
    }
  }

  // Step enemies (wander+bounce+chase)
  for (const e of enemies.values()) {
    // Chase nearest player in same map if within detect range
    let target = null, nd = Infinity;
    for (const p of players.values()) {
      if ((p.map || 'grass') !== e.map) continue;
      const d = Math.hypot(p.x - e.x, p.y - e.y);
      if (d < nd) { nd = d; target = p; }
    }
    if (target && nd <= (e.detectRange || 200)) {
      const dx = target.x - e.x;
      const dy = target.y - e.y;
      const len = Math.hypot(dx, dy) || 1;
      const sp = e.moveSpeed || 40;
      e.vx = (dx / len) * sp;
      e.vy = (dy / len) * sp;
    }
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    if (e.x < 20 || e.x > 780) e.vx *= -1;
    if (e.y < 20 || e.y > 580) e.vy *= -1;
    // Aggressive elites shoot slime balls
  if (e.aggressive) {
      e.lastShotAt = e.lastShotAt || 0;
      const fireRate = e.fireRateMs || 1400;
      if (now - e.lastShotAt >= fireRate) {
        // find nearest player in range
        let nearest = null, nd = Infinity;
        for (const p of players.values()) {
          if ((p.map || 'grass') !== e.map) continue;
          const d = Math.hypot(p.x - e.x, p.y - e.y);
          if (d < nd) { nd = d; nearest = p; }
        }
        const range = e.attackRange || 240;
        if (nearest && nd <= range) {
          const dx = nearest.x - e.x;
          const dy = nearest.y - e.y;
          const len = Math.hypot(dx, dy) || 1;
          const speed = e.shotSpeed || 280;
          const idp = nextProjId++;
          projectiles.set(idp, {
            id: idp,
            owner: `enemy:${e.id}`,
            map: e.map,
            x: e.x,
            y: e.y,
            sx: e.x,
            sy: e.y,
            vx: (dx / len) * speed,
            vy: (dy / len) * speed,
            radius: 5,
            kind: 'slimeBall',
            damage: e.shotDamage || 12,
            slowFactor: e.slowFactor || 0.6,
            slowMs: e.slowMs || 1200,
            expiresAt: now + 2000,
            maxDist: 500,
          });
          e.lastShotAt = now;
        }
      }
    }

    // Collision damage on touch with players
    for (const p of players.values()) {
      if ((p.map || 'grass') !== e.map) continue;
      const d = Math.hypot(p.x - e.x, p.y - e.y);
      if (d <= (e.radius || 12) + 10) {
        if (!p.touchImmuneUntil || p.touchImmuneUntil < now) {
          const dmg = e.touchDamage || 8;
          p.hp = Math.max(0, (p.hp ?? 1) - dmg);
          emitFloatText(p.x, p.y - 16, `-${dmg}`, '#ff4444', 1000, p.map || 'grass');
          p.touchImmuneUntil = now + 500; // brief CD to avoid melt
          if (p.hp <= 0) handlePlayerDeath(p, now);
        }
      }
    }
  }

  // Process respawn queue
  while (respawnQueue.length && respawnQueue[0].at <= now) {
    const job = respawnQueue.shift();
    const count = Math.max(1, Math.floor(job.count || 1));
  spawnSlimes(job.map || 'grass', count);
  }

  // Per-player, per-map snapshots
  for (const [uid, s] of sockets) {
    const p = players.get(uid);
    if (!p) continue;
    const snap = buildSnapshotForMap(p.map || 'grass', uid);
    snap.serverTime = now;
    s.volatile.emit('state', snap);
  }
}, TICK_MS);

function xpForNextLevel(level) {
  return 100 + (level - 1) * 50;
}

function emitFloatText(x, y, text, color = '#fff', ttl = 1000, mapId = null) {
  try {
    for (const [uid, s] of sockets) {
      const p = players.get(uid);
      if (!p) continue;
      if (mapId && (p.map || 'grass') !== mapId) continue;
      s.emit('floatText', { x, y, text, color, ttl });
    }
  } catch {}
}

function handlePlayerDeath(p, now = Date.now(), killerId = null, isPvp = false) {
  const cls = p.class || 'none';
  const pdata = storage.getPlayerData(p.id) || { selectedClass: cls, classes: {} };
  const bag = pdata.classes[cls] || { level: p.level || 1, xp: p.xpByClass?.[cls] || 0, hpMax: p.hpMax || 100, hp: p.hp || 100 };
  const oldXp = bag.xp || 0;
  const loss = Math.floor(oldXp * 0.10);
  bag.xp = Math.max(0, oldXp - loss);
  p.xpByClass[cls] = bag.xp;
  pdata.classes[cls] = bag;
  pdata.selectedClass = cls;
  try { storage.setPlayerData(p.id, pdata); } catch {}
  emitFloatText(p.x, p.y, `-${loss} XP`, '#ff6666', 1200, p.map || 'grass');
  // Transfer XP to killer in PvP if applicable and not in safe
  if (isPvp && killerId) {
    const killer = players.get(killerId);
    if (killer && (killer.map || 'grass') !== 'safe') {
      const kcls = killer.class || 'none';
      const kpdata = storage.getPlayerData(killer.id) || { selectedClass: kcls, classes: {} };
      const kbag = kpdata.classes[kcls] || { level: killer.level || 1, xp: killer.xpByClass?.[kcls] || 0, hpMax: killer.hpMax || 100, hp: killer.hp || 100 };
      kbag.xp = (kbag.xp || 0) + loss;
      killer.xpByClass[kcls] = kbag.xp;
      // Level up loop
  let need = xpForNextLevel(kbag.level || 1);
  while ((kbag.level || 1) < 10 && (kbag.xp || 0) >= need) {
        kbag.xp -= need;
        kbag.level = (kbag.level || 1) + 1;
        kbag.hpMax = (kbag.hpMax || 100) + 5;
        kbag.hp = Math.min(kbag.hpMax, (kbag.hp ?? kbag.hpMax) + 10);
        need = xpForNextLevel(kbag.level);
      }
      kpdata.classes[kcls] = kbag;
      kpdata.selectedClass = kcls;
      try { storage.setPlayerData(killer.id, kpdata); } catch {}
      // mirror live
      if (killer.class === kcls) {
        killer.level = kbag.level;
        killer.hpMax = kbag.hpMax;
        killer.hp = Math.min(killer.hpMax, kbag.hp);
      }
      emitFloatText(killer.x, killer.y - 20, `+${loss} XP`, '#66ccff', 1200, killer.map || 'grass');
    }
  }
  // resurrect at last safe zone visited
  p.hp = p.hpMax;
  p.hitImmuneUntil = now + 1000;
  const safe = p.lastSafe || { map: 'safe', x: WORLD.w/2, y: WORLD.h - 30 };
  p.map = safe.map || 'safe';
  p.x = safe.x ?? (WORLD.w/2);
  p.y = safe.y ?? (WORLD.h - 30);
  const s = sockets.get(p.id);
  if (s) s.emit('teleport', { x: p.x, y: p.y });
}

function buildSnapshotForMap(mapId = 'grass', selfId = null) {
  const pl = {};
  for (const [id, p] of players) if ((p.map || 'grass') === mapId) pl[id] = p;
  const pr = {};
  for (const [id, prj] of projectiles) if ((prj.map || 'grass') === mapId) pr[id] = prj;
  const en = {};
  for (const [id, e] of enemies) if ((e.map || 'grass') === mapId) en[id] = e;
  // augment self with totalLevel and rewardMult
  if (selfId && pl[selfId]) {
    const pdata = storage.getPlayerData(selfId) || { classes: {} };
    let total = 0;
    for (const cls of Object.values(pdata.classes || {})) {
      const lvl = typeof cls.level === 'number' ? cls.level : 1;
      total += Math.max(1, lvl);
    }
    const rewardMult = Math.min(1 + (total - 1) * 0.05, 3);
    pl[selfId] = { ...pl[selfId], totalLevel: total, rewardMult };
  }
  return { selfId: selfId || null, map: mapId, players: pl, projectiles: pr, enemies: en };
}

function getRewardMultiplier(userId) {
  // multiplier increases with total levels across classes (simple: 1 + totalLevels*0.05, capped)
  const pdata = storage.getPlayerData(userId) || { classes: {} };
  let total = 0;
  for (const cls of Object.values(pdata.classes || {})) {
    const lvl = typeof cls.level === 'number' ? cls.level : 1;
    total += Math.max(1, lvl);
  }
  const mult = 1 + (total - 1) * 0.05; // 5% per level beyond level 1
  return Math.min(mult, 3); // cap at 3x
}

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
