import { BOOSTER, G, DEG, clamp, SEEDS, DT, LEVELS, DEFAULT_GAINS, GAIN_RANGES, makeFlight, step, autopilot, windAt, mass, scoreFlight, evaluate, simulate } from './physics.js';
import { SETTINGS, SETTING, debrief, NUDGE } from './explain.js';

const $ = (id) => document.getElementById(id);
const lerp = (a, b, t) => a + (b - a) * t;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};

// ---------- state ----------
const app = {
  mode: 'game', // 'game' (you fly) or 'sim' (autopilot flies your settings)
  level: store.get('hs.level', 'medium'),
  seed: 1,
  speed: 1,
  gains: { ...DEFAULT_GAINS, ...store.get('hs.gains', {}) },
  flight: null,
  running: false,
  input: { left: false, right: false, up: false, down: false, engine: false, throttle: 0.8 },
  trail: [],
  ghosts: [],
  report: null,
  ended: false,
};

const canvas = $('stage');
const ctx = canvas.getContext('2d');
const mini = $('minimap');
const mctx = mini.getContext('2d');
let W = 0, H = 0, dpr = 1;

function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = canvas.getBoundingClientRect();
  W = r.width; H = r.height;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
}
window.addEventListener('resize', resize);

// ---------- visual effects state ----------
const fx = { plume: [], smoke: [], fire: [], debris: [], steam: [], flash: 0, shake: 0, ring: null, legs: 0, exploded: false, landedAt: 0, slow: 1 };
const cam = { x: 0, y: 1000, s: 0.3, snap: true };

const stars = Array.from({ length: 160 }, () => ({ x: Math.random(), y: Math.random() * 0.62, r: Math.random() * 1.2 + 0.2, p: Math.random() * 6.28 }));
const clouds = [];
{
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const alt of [420, 760, 1150, 1600, 2050]) for (let i = 0; i < 6; i++) clouds.push({ y: alt + (rnd() - 0.5) * 120, x: (rnd() - 0.5) * 2400, w: 180 + rnd() * 420, h: 10 + rnd() * 22, a: 0.05 + rnd() * 0.08 });
}

// ---------- flight setup ----------
function levelCfg() { return LEVELS[app.level]; }

function newFlight() {
  const opts = app.mode === 'game' ? levelCfg().opts : undefined;
  app.flight = makeFlight(app.seed, opts);
  app.input.engine = false;
  app.input.throttle = 0.8;
  app.trail = [];
  app.steer = { want: 0, vHold: 0 };
  app.ended = false;
  app.acc = 0;
  Object.assign(fx, { plume: [], smoke: [], fire: [], debris: [], steam: [], flash: 0, shake: 0, ring: null, legs: 0, exploded: false, landedAt: 0, slow: 1 });
  cam.snap = true;
  $('outcome').classList.add('hidden');
  $('cue').classList.add('hidden');
}

function start() {
  newFlight();
  app.running = true;
  $('intro').classList.add('hidden');
  if (app.mode === 'sim') app.report = debrief(app.gains, app.seed);
}

function showIntro() {
  newFlight();
  app.running = false;
  const intro = $('intro');
  if (app.mode === 'game') {
    $('i-title').textContent = 'Bring it home.';
    $('i-sub').textContent = app.level === 'easy'
      ? 'Easy: light wind, a wide pad and an engine that can hover. Press Space when the cue appears, then ease it down.'
      : 'The booster is falling at 140 m/s toward a barge at sea. Its engine can\'t throttle below 40%, so it can\'t hover. Light it too early and the fuel runs out. Too late and it hits the deck.';
    $('start').textContent = 'Start descent';
  } else {
    $('i-title').textContent = 'Your settings, its flight.';
    $('i-sub').textContent = 'The flight computer will fly this booster using the nine settings in the panel. Press Run flight to watch, then read what went wrong.';
    $('start').textContent = 'Run flight';
  }
  intro.classList.remove('hidden');
}

// ---------- control ----------
// Game controls (default): the arrows set a lean that ramps in smoothly, and on Easy and Medium
// letting go makes it lean against its own drift. Up and down brake or speed up; letting go
// holds the current falling speed. Expert mode is the raw hardware: engine angle and throttle lever.
function humanControl(f, dt, st, inp = app.input) {
  const s = f.state;
  const B = BOOSTER;
  const lv = levelCfg();
  const dir = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
  if ($('raw').checked) return { engine: inp.engine, throttle: inp.throttle, gimbal: -dir * B.gimbalMax, rcs: dir };

  // attitude: aim for a smooth, well-damped turn whatever the throttle; thrusters cover the rest
  const h = Math.max(0, s.y - B.legHeight);
  const cap = lv.lean * DEG * clamp(h / 40, 0.35, 1); // stand up straight near the deck
  let goal = dir * cap;
  if (!dir && lv.driftHold) goal = clamp(-1.4 * s.vx * DEG, -cap, cap);
  st.want += clamp(goal - st.want, -28 * DEG * dt, 28 * DEG * dt);
  const I = (mass(s) * B.height * B.height) / 12;
  const need = I * (2.25 * (st.want - s.theta) - 2.7 * s.omega);
  const T = s.engineOn ? s.throttle * B.thrustMax : 0;
  const gimbal = T > 1e4 ? clamp(-need / (T * B.armCoM), -B.gimbalMax, B.gimbalMax) : 0;
  const rcs = clamp((need + T * B.armCoM * Math.sin(gimbal)) / B.rcsTorque, -1, 1);

  // speed hold
  if (!s.engineOn) st.vHold = s.vy;
  const rate = inp.up ? 18 : inp.down ? -8 : 0;
  st.vHold = clamp(Math.min(st.vHold + rate * dt, 1.5), s.vy - 6, s.vy + 6);
  // landing assist (Easy, Medium): never let the held speed exceed a safe descent for this height
  if (lv.flare && !inp.down) st.vHold = Math.max(st.vHold, -Math.sqrt(lv.flare.c ** 2 + 2 * lv.flare.a * h));
  const throttle = (mass(s) * (G + rate + 3 * (st.vHold - s.vy))) / (B.thrustMax * Math.max(0.6, Math.cos(s.theta)));
  return { engine: inp.engine, throttle, gimbal, rcs };
}

function control(f) {
  return app.mode === 'sim' ? autopilot(f, app.gains) : humanControl(f, DT, app.steer);
}

const keys = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', KeyA: 'left', KeyD: 'right', KeyW: 'up', KeyS: 'down' };
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (!app.running && !$('intro').classList.contains('hidden')) return start();
    if (app.mode === 'game' && app.running) app.input.engine = !app.input.engine;
    return;
  }
  if (e.code === 'KeyR') return app.mode === 'game' ? start() : showIntro();
  if (e.code === 'Enter' && !app.running) return start();
  const k = keys[e.code];
  if (k) { app.input[k] = true; e.preventDefault(); }
});
window.addEventListener('keyup', (e) => { const k = keys[e.code]; if (k) app.input[k] = false; });
window.addEventListener('blur', () => Object.assign(app.input, { left: false, right: false, up: false, down: false }));

for (const b of document.querySelectorAll('#touch button')) {
  const k = b.dataset.k;
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (k === 'engine') { if (!app.running) start(); else app.input.engine = !app.input.engine; }
    else app.input[k] = true;
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => { if (k !== 'engine') app.input[k] = false; });
}

// ---------- main loop ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const f = app.flight;
  if (f && app.running && !f.state.done) {
    const inp = app.input;
    if (app.mode === 'game' && $('raw').checked) inp.throttle = clamp(inp.throttle + ((inp.up ? 1 : 0) - (inp.down ? 1 : 0)) * 1.2 * dt, f.minThrottle, 1);
    // slow motion for the last metres
    fx.slow = lerp(fx.slow, f.state.y < 35 && f.state.engineOn ? 0.5 : 1, Math.min(1, dt * 4));
    app.acc += dt * app.speed * fx.slow;
    let n = 0;
    while (app.acc >= DT && n < 2000 && !f.state.done) {
      step(f, control(f), DT);
      app.acc -= DT;
      n++;
    }
    if (!app.trail.length || f.state.t - app.trail[app.trail.length - 1][2] > 0.1) app.trail.push([f.state.x, f.state.y, f.state.t]);
    if (f.state.done && !app.ended) onEnd();
  }
  updateFx(dt * (app.speed > 1 ? 1.5 : 1) * fx.slow);
  render(dt);
  hud();
  requestAnimationFrame(frame);
}

// ---------- outcome ----------
function onEnd() {
  app.ended = true;
  const f = app.flight;
  const o = f.state.outcome;
  const s = f.state;
  if (o.landed) {
    fx.landedAt = performance.now();
    fx.ring = { r: 0, a: 1 };
  } else if (o.reason !== 'Flew away' && o.reason !== 'Timed out') {
    explode(s);
  }
  setTimeout(() => showOutcome(o), o.landed ? 900 : 1300);
  if (app.mode === 'sim') renderReport();
  if (app.mode === 'game' && o.landed) {
    const sc = scoreFlight(o);
    const best = store.get('hs.best', {});
    if (!best[app.level] || sc > best[app.level]) { best[app.level] = sc; store.set('hs.best', best); }
    renderBest();
  }
}

function stat(label, value, ok) {
  return `<div><label>${label}</label><b class="${ok === undefined ? '' : ok ? 'ok' : 'warn'}">${value}</b></div>`;
}

function showOutcome(o) {
  $('o-title').textContent = o.landed ? 'Landed' : o.reason;
  $('o-title').className = 'o-title ' + (o.landed ? 'good' : 'bad');
  const c = o.checks || {};
  let sub = '';
  if (o.landed) sub = `Score ${scoreFlight(o)} out of 100.`;
  else if (app.mode === 'sim' && app.report) sub = app.report.findings[0].title + ' See the panel for why.';
  else sub = gameHint(o);
  $('o-sub').textContent = sub;
  const isTouch = o.reason !== 'Lost control' && o.reason !== 'Flew away' && o.reason !== 'Timed out';
  $('o-stats').innerHTML = isTouch
    ? stat('Falling', `${Math.abs(o.vy).toFixed(1)} m/s`, c.vertical) + stat('Sideways', `${Math.abs(o.vx).toFixed(1)} m/s`, c.horizontal) + stat('Tilt', `${Math.abs(o.tiltDeg).toFixed(1)}°`, c.upright) + stat('Off centre', `${o.distance.toFixed(1)} m`, c.onPad) + stat('Fuel left', `${Math.round(o.fuelLeft)} kg`)
    : stat('Time', `${o.time.toFixed(1)} s`) + stat('Fuel left', `${Math.round(o.fuelLeft)} kg`);
  $('o-retry').textContent = app.mode === 'sim' ? 'Run again' : 'Try again';
  $('outcome').classList.remove('hidden');
}

function gameHint(o) {
  const f = app.flight;
  const L = f.limits;
  if (o.reason === 'Ran out of fuel') return 'You burned too long. Light the engine later and brake harder near the end.';
  if (o.reason === 'Hit too hard') return `You touched down at ${Math.abs(o.vy).toFixed(1)} m/s. Keep it under ${L.vy} m/s: light the engine earlier or hold more throttle at the end.`;
  if (o.reason === 'Missed the pad' || o.reason === 'Landed in the sea') return 'Lean toward the pad early, then lean back the other way to stop the drift before touchdown.';
  if (o.reason.startsWith('Slid')) return `Too much sideways speed (limit ${L.vx} m/s). Lean against the drift in the last 100 m.`;
  if (o.reason === 'Tipped over') return 'Stand it up straight before the legs touch.';
  if (o.reason === 'Lost control') return 'It tumbled. Small, short leans work better than holding an arrow down.';
  if (o.reason === 'Flew away') return 'With the engine on and little fuel left, it climbs. Cut the engine (Space) to fall again.';
  return '';
}

$('o-retry').addEventListener('click', () => start());
$('o-next').addEventListener('click', () => { app.seed = (app.seed % SEEDS.length) + 1; $('seed').value = app.seed; start(); });
$('start').addEventListener('click', () => start());
$('restart').addEventListener('click', () => (app.mode === 'game' ? start() : showIntro()));

// ---------- effects ----------

function explode(s) {
  fx.exploded = true;
  fx.flash = 1;
  fx.shake = 1;
  const y = Math.max(0, s.y);
  for (let i = 0; i < 140; i++) {
    const a = Math.random() * Math.PI;
    const v = 8 + Math.random() * 45;
    fx.fire.push({ x: s.x + (Math.random() - 0.5) * 6, y: y + Math.random() * 20, vx: Math.cos(a) * v * (Math.random() < 0.5 ? -1 : 1), vy: Math.sin(a) * v * 0.7 + 4, life: 0, max: 0.8 + Math.random() * 1.8, r: 3 + Math.random() * 6 });
  }
  for (let i = 0; i < 18; i++) {
    fx.debris.push({ x: s.x, y: y + Math.random() * 30, vx: (Math.random() - 0.5) * 50, vy: 10 + Math.random() * 35, a: Math.random() * 6, va: (Math.random() - 0.5) * 12, w: 1 + Math.random() * 3, h: 0.6 + Math.random() * 2, life: 0 });
  }
  fx.ring = { r: 0, a: 1, bad: true };
}

function updateFx(dt) {
  const f = app.flight;
  if (!f) return;
  const s = f.state;
  const B = BOOSTER;
  fx.flash = Math.max(0, fx.flash - dt * 2.2);
  fx.shake = Math.max(0, fx.shake - dt * 1.6);
  fx.legs = clamp(fx.legs + (s.y < 320 || s.done ? dt / 2.2 : 0), 0, 1);

  // plume particles, stored relative to the nozzle in metres
  if (s.engineOn && !s.done) {
    const a = s.theta + s.gimbal;
    const n = Math.round(3 + s.throttle * 5);
    for (let i = 0; i < n; i++) {
      const sp = (55 + Math.random() * 45) * (0.5 + s.throttle);
      const spread = (Math.random() - 0.5) * 0.25;
      fx.plume.push({ rx: (Math.random() - 0.5) * 1.2, ry: 0, vx: -Math.sin(a + spread) * sp, vy: -Math.cos(a + spread) * sp, life: 0, max: 0.5 + Math.random() * 0.8, r: 1.2 + Math.random() * 1.5 });
    }
  }
  const w = windAt(f.wind, s.t, s.y);
  const ground = -(s.y); // deck height relative to the nozzle
  for (const p of fx.plume) {
    const tvx = w - s.vx, tvy = -s.vy; // air at rest, seen from the booster
    p.vx += (tvx - p.vx) * Math.min(1, dt * 2.6);
    p.vy += (tvy - p.vy) * Math.min(1, dt * 2.6);
    p.rx += p.vx * dt; p.ry += p.vy * dt;
    if (p.ry < ground) { p.ry = ground; p.vy = Math.abs(p.vy) * 0.08; p.vx += (Math.random() < 0.5 ? -1 : 1) * 25; }
    p.life += dt;
    p.r += dt * 6;
  }
  fx.plume = fx.plume.filter((p) => p.life < p.max).slice(-700);

  // deck smoke when the plume hits the barge
  if (s.engineOn && !s.done && s.y < 70) {
    const k = (1 - s.y / 70) * s.throttle;
    for (let i = 0; i < Math.round(k * 6); i++) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      fx.smoke.push({ x: s.x + (Math.random() - 0.5) * 4, y: 0.5, vx: dir * (15 + Math.random() * 40), vy: 1 + Math.random() * 4, life: 0, max: 1.6 + Math.random() * 2, r: 2 + Math.random() * 3 });
    }
  }
  for (const p of fx.smoke) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - dt * 0.9; p.vy += dt * 1.5; p.life += dt; p.r += dt * 7; }
  fx.smoke = fx.smoke.filter((p) => p.life < p.max).slice(-500);

  // landed: steam venting
  if (s.done && s.outcome && s.outcome.landed && performance.now() - fx.landedAt < 6000 && Math.random() < 0.6) {
    fx.steam.push({ x: s.x + (Math.random() - 0.5) * 3, y: B.legHeight + 30 + Math.random() * 8, vx: (Math.random() - 0.3) * 4 + w * 0.3, vy: 2 + Math.random() * 3, life: 0, max: 2 + Math.random() * 2, r: 1.5 + Math.random() * 2 });
  }
  for (const p of fx.steam) { p.x += p.vx * dt; p.y += p.vy * dt; p.life += dt; p.r += dt * 3; }
  fx.steam = fx.steam.filter((p) => p.life < p.max);

  for (const p of fx.fire) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - dt * 1.5; p.vy = p.vy * (1 - dt * 1.5) + dt * 6; if (p.y < 0) { p.y = 0; p.vy = Math.abs(p.vy) * 0.3; } p.life += dt; p.r += dt * 9; }
  fx.fire = fx.fire.filter((p) => p.life < p.max + 2.5);
  for (const d of fx.debris) { d.x += d.vx * dt; d.y += d.vy * dt; d.vy -= G * dt; d.a += d.va * dt; if (d.y < 0.5 && Math.abs(d.x) < 34) { d.y = 0.5; d.vy = -d.vy * 0.3; d.vx *= 0.6; d.va *= 0.5; } d.life += dt; }
  if (fx.ring) { fx.ring.r += dt * (fx.ring.bad ? 90 : 30); fx.ring.a -= dt * (fx.ring.bad ? 1.2 : 0.5); if (fx.ring.a <= 0) fx.ring = null; }
}

// ---------- rendering ----------
const sx = (x) => W / 2 + (x - cam.x) * cam.s;
const sy = (y) => H / 2 - (y - cam.y) * cam.s;

function updateCam(dt) {
  const s = app.flight.state;
  const y = Math.max(0, s.y);
  const ts = clamp((H * 0.7) / (y + 102), 0.18, 4.2);
  const ty = (0.32 * H) / ts;
  const span = (W * 0.36) / ts;
  const tx = clamp(s.x * 0.5, s.x - span, s.x + span);
  if (cam.snap) { cam.s = ts; cam.x = tx; cam.y = ty; cam.snap = false; return; }
  const k = Math.min(1, dt * 3.5);
  cam.s = lerp(cam.s, ts, k); cam.x = lerp(cam.x, tx, k); cam.y = (0.32 * H) / cam.s;
}

function render(dt) {
  if (!W) resize();
  const f = app.flight;
  if (!f) return;
  updateCam(dt);
  const s = f.state;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const shake = fx.shake * fx.shake * 14;
  ctx.save();
  if (shake) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  drawSky();
  drawClouds();
  drawSea();
  drawBarge(f);
  if (app.mode === 'game' && app.running && !s.done) drawPrediction(f);
  drawSmoke(fx.smoke, 'deck');
  if (!fx.exploded) {
    // nothing of the booster or its flame shows below the deck
    ctx.save();
    ctx.beginPath();
    ctx.rect(-50, -50, W + 100, sy(0) + 50 - Math.max(0.5, 0.2 * cam.s));
    ctx.clip();
    drawBooster(f);
    ctx.restore();
  }
  drawFire();
  drawSmoke(fx.steam, 'steam');
  drawRing();
  ctx.restore();
  if (fx.flash > 0) { ctx.fillStyle = `rgba(255, 214, 170, ${fx.flash * 0.55})`; ctx.fillRect(0, 0, W, H); }
  drawPadArrow(f);
  drawMinimap(f);
}

function drawSky() {
  const hy = sy(0);
  const g = ctx.createLinearGradient(0, 0, 0, hy);
  g.addColorStop(0, '#060b1d');
  g.addColorStop(0.45, '#121a3d');
  g.addColorStop(0.74, '#3b2350');
  g.addColorStop(0.9, '#a2464a');
  g.addColorStop(0.97, '#f0894f');
  g.addColorStop(1, '#ffc27a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, Math.max(0, hy) + 1);
  const t = performance.now() / 1000;
  for (const st of stars) {
    const y = st.y * hy;
    const a = (1 - st.y / 0.62) * (0.55 + 0.45 * Math.sin(t * 1.3 + st.p));
    ctx.fillStyle = `rgba(230, 236, 255, ${a * 0.8})`;
    ctx.fillRect(st.x * W, y, st.r, st.r);
  }
  // the sun, just setting
  const sunX = W * 0.74 - cam.x * 0.02;
  const glow = ctx.createRadialGradient(sunX, hy, 0, sunX, hy, W * 0.55);
  glow.addColorStop(0, 'rgba(255, 196, 120, 0.55)');
  glow.addColorStop(0.25, 'rgba(255, 130, 80, 0.18)');
  glow.addColorStop(1, 'rgba(255, 120, 80, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, hy);
  ctx.fillStyle = '#ffe2b0';
  ctx.beginPath();
  ctx.arc(sunX, hy + 2, Math.max(10, H * 0.035), Math.PI, 0);
  ctx.fill();
}

function drawClouds() {
  for (const c of clouds) {
    const x = W / 2 + (c.x - cam.x * 0.7) * cam.s;
    const y = sy(c.y);
    const w = c.w * cam.s, h = Math.max(2, c.h * cam.s);
    if (y < -h || y > sy(0) - 2 || x + w < -50 || x - w > W + 50) continue;
    const g = ctx.createRadialGradient(x, y, 0, x, y, w);
    g.addColorStop(0, `rgba(255, 176, 150, ${c.a})`);
    g.addColorStop(1, 'rgba(255, 176, 150, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, w, h, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawSea() {
  const hy = sy(0);
  if (hy > H) return;
  const g = ctx.createLinearGradient(0, hy, 0, H);
  g.addColorStop(0, '#2a2140');
  g.addColorStop(0.08, '#16203a');
  g.addColorStop(1, '#070d1b');
  ctx.fillStyle = g;
  ctx.fillRect(0, hy, W, H - hy);
  // sun glitter on the water
  const t = performance.now() / 1000;
  const sunX = W * 0.74 - cam.x * 0.02;
  for (let i = 0; i < 70; i++) {
    const d = i / 70;
    const y = hy + 2 + d * d * (H - hy);
    const spread = 8 + d * W * 0.12;
    const x = sunX + Math.sin(i * 12.9898 + t * 0.9) * spread;
    const len = 6 + d * 40 * (0.5 + 0.5 * Math.sin(i * 3.1 + t * 2));
    ctx.fillStyle = `rgba(255, 190, 130, ${0.35 * (1 - d)})`;
    ctx.fillRect(x - len / 2, y, len, 1 + d * 1.5);
  }
  // swell lines
  ctx.strokeStyle = 'rgba(140, 170, 220, 0.07)';
  ctx.lineWidth = 1;
  for (let j = 1; j < 7; j++) {
    const y = hy + (H - hy) * (j / 7) ** 1.6;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 16) ctx.lineTo(x, y + Math.sin(x * 0.02 + t * (0.6 + j * 0.1) + j) * (1 + j * 0.4));
    ctx.stroke();
  }
}

function drawBarge(f) {
  const s = cam.s;
  const halfDeck = 32;
  const x0 = sx(-halfDeck), x1 = sx(halfDeck), y0 = sy(0);
  const hull = 5 * s;
  // hull
  const hg = ctx.createLinearGradient(0, y0, 0, y0 + hull);
  hg.addColorStop(0, '#3c4658');
  hg.addColorStop(1, '#151b27');
  ctx.fillStyle = hg;
  ctx.fillRect(x0, y0, x1 - x0, Math.max(3, hull));
  // deck
  ctx.fillStyle = '#5d6879';
  ctx.fillRect(x0, y0 - Math.max(1, 0.4 * s), x1 - x0, Math.max(1.5, 0.6 * s));
  // blast walls at the ends
  ctx.fillStyle = '#2b3342';
  ctx.fillRect(x0, y0 - 4 * s, 1.6 * s, 4 * s);
  ctx.fillRect(x1 - 1.6 * s, y0 - 4 * s, 1.6 * s, 4 * s);
  // landing zone
  const half = f.pad.halfWidth;
  const near = clamp(1 - f.state.y / 600, 0.25, 1);
  const pz = ctx.createLinearGradient(sx(-half), 0, sx(half), 0);
  pz.addColorStop(0, 'rgba(91, 227, 164, 0)');
  pz.addColorStop(0.15, `rgba(91, 227, 164, ${0.7 * near})`);
  pz.addColorStop(0.5, `rgba(220, 255, 236, ${0.95 * near})`);
  pz.addColorStop(0.85, `rgba(91, 227, 164, ${0.7 * near})`);
  pz.addColorStop(1, 'rgba(91, 227, 164, 0)');
  ctx.fillStyle = pz;
  ctx.fillRect(sx(-half), y0 - Math.max(1.5, 0.5 * s), sx(half) - sx(-half), Math.max(2, 0.5 * s));
  // centre mark
  ctx.fillStyle = `rgba(240, 255, 246, ${near})`;
  ctx.fillRect(sx(0) - Math.max(1, 0.3 * s), y0 - Math.max(3, 1.2 * s), Math.max(2, 0.6 * s), Math.max(3, 1.2 * s));
  // beacons
  const blink = Math.sin(performance.now() / 260) > 0;
  for (const bx of [-halfDeck + 0.8, halfDeck - 0.8]) {
    const x = sx(bx), y = y0 - 4.6 * s;
    const r = Math.max(6, 3 * s);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * (blink ? 2.4 : 1.4));
    g.addColorStop(0, blink ? 'rgba(255, 110, 90, 0.95)' : 'rgba(255, 110, 90, 0.4)');
    g.addColorStop(1, 'rgba(255, 110, 90, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r * 3, y - r * 3, r * 6, r * 6);
  }
  // water line foam
  ctx.fillStyle = 'rgba(200, 220, 255, 0.18)';
  ctx.fillRect(x0 - 3, y0 + hull - 1, x1 - x0 + 6, 2);
  // engine light on the deck
  const st = f.state;
  if (st.engineOn && st.y < 150 && !st.done) {
    const k = (1 - st.y / 150) * st.throttle;
    const lx = sx(st.x), ly = y0;
    const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, 60 * s * 0.6 + 40);
    lg.addColorStop(0, `rgba(255, 190, 110, ${0.65 * k})`);
    lg.addColorStop(1, 'rgba(255, 150, 80, 0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = lg;
    ctx.fillRect(lx - 400, ly - 300, 800, 330);
    ctx.globalCompositeOperation = 'source-over';
  }
}

function boosterScale() {
  return Math.max(cam.s, 1.15);
}

function drawBooster(f) {
  const s = f.state;
  const vs = boosterScale();
  const x = sx(s.x), y = sy(s.y);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(s.theta);
  ctx.scale(vs, vs);
  // in here: metres, body frame, y up is negative. Origin = nozzle exit.

  // plume first (behind the booster), additive
  ctx.save();
  ctx.translate(0, -1.0);
  ctx.rotate(s.gimbal * 1.8);
  if (s.engineOn && !s.done) drawFlame(s);
  ctx.restore();
  drawPlumeParticles(s);

  // legs
  const dep = easeInOut(fx.legs);
  for (const side of [-1, 1]) drawLeg(side, dep);

  // nozzle
  ctx.save();
  ctx.translate(0, -1.0);
  ctx.rotate(s.gimbal * 1.8);
  const ng = ctx.createLinearGradient(-0.9, 0, 0.9, 0);
  ng.addColorStop(0, '#2b2f36'); ng.addColorStop(0.45, '#6b7079'); ng.addColorStop(1, '#22262c');
  ctx.fillStyle = ng;
  ctx.beginPath();
  ctx.moveTo(-0.5, -0.6); ctx.lineTo(0.5, -0.6); ctx.lineTo(0.85, 1.0); ctx.lineTo(-0.85, 1.0); ctx.closePath();
  ctx.fill();
  if (s.engineOn) {
    ctx.fillStyle = `rgba(255, 150, 70, ${0.5 + s.throttle * 0.4})`;
    ctx.fillRect(-0.85, 0.75, 1.7, 0.25);
  }
  ctx.restore();

  // engine section
  ctx.fillStyle = '#23272e';
  ctx.fillRect(-1.6, -2.2, 3.2, 1.4);

  // body
  const bodyTop = -42, bodyBot = -2.0;
  const bg = ctx.createLinearGradient(-1.85, 0, 1.85, 0);
  bg.addColorStop(0, '#8790a0');
  bg.addColorStop(0.3, '#f3f5f8');
  bg.addColorStop(0.62, '#dfe4ea');
  bg.addColorStop(0.88, '#c9a08a');
  bg.addColorStop(1, '#7d6a66');
  ctx.fillStyle = bg;
  ctx.fillRect(-1.85, bodyTop, 3.7, bodyBot - bodyTop);
  // soot from re-entry, heavier at the bottom
  const soot = ctx.createLinearGradient(0, bodyBot, 0, -20);
  soot.addColorStop(0, 'rgba(26, 22, 22, 0.9)');
  soot.addColorStop(0.35, 'rgba(40, 34, 32, 0.55)');
  soot.addColorStop(1, 'rgba(40, 34, 32, 0)');
  ctx.fillStyle = soot;
  ctx.fillRect(-1.85, -20, 3.7, 20 + bodyBot);
  // streaks
  ctx.fillStyle = 'rgba(30, 26, 26, 0.18)';
  for (const [sx0, len] of [[-1.2, 14], [-0.3, 9], [0.7, 17], [1.3, 7]]) ctx.fillRect(sx0, bodyBot - len, 0.22, len);
  // interstage
  ctx.fillStyle = '#16191f';
  ctx.fillRect(-1.85, bodyTop, 3.7, 4.6);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.fillRect(-1.85, bodyTop + 4.3, 3.7, 0.3);
  // grid fins
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.translate(side * 1.85, bodyTop + 2.4);
    ctx.fillStyle = '#2c3038';
    ctx.fillRect(side > 0 ? 0 : -1.7, -0.55, 1.7, 1.1);
    ctx.strokeStyle = '#555c67';
    ctx.lineWidth = 0.12;
    for (let k = 0; k <= 4; k++) {
      const xx = (side > 0 ? 0 : -1.7) + k * 0.425;
      ctx.beginPath(); ctx.moveTo(xx, -0.55); ctx.lineTo(xx, 0.55); ctx.stroke();
    }
    ctx.restore();
  }
  // rim light from the sunset (right side)
  ctx.fillStyle = 'rgba(255, 170, 110, 0.22)';
  ctx.fillRect(1.45, bodyTop + 4.6, 0.4, bodyBot - bodyTop - 4.6);
  // engine glow on the base
  if (s.engineOn) {
    const eg = ctx.createRadialGradient(0, 0, 0, 0, 0, 7);
    eg.addColorStop(0, `rgba(255, 180, 100, ${0.35 * s.throttle})`);
    eg.addColorStop(1, 'rgba(255, 150, 80, 0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = eg;
    ctx.fillRect(-7, -7, 14, 14);
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
}

function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; }

function drawLeg(side, dep) {
  // hinge near the base; stowed legs lie along the body pointing up, deployed legs reach the deck
  const hx = side * 1.85, hy = -3.0;
  const stowed = 0, deployed = 136 * DEG;
  const ang = lerp(stowed, deployed, dep);
  const len = 8.2;
  const tx = hx + side * Math.sin(ang) * len;
  const ty = hy - Math.cos(ang) * len;
  ctx.strokeStyle = '#1c2027';
  ctx.lineWidth = 0.75;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(tx, ty); ctx.stroke();
  ctx.strokeStyle = 'rgba(160, 170, 185, 0.35)';
  ctx.lineWidth = 0.18;
  ctx.beginPath(); ctx.moveTo(hx + side * 0.2, hy); ctx.lineTo(tx + side * 0.2, ty); ctx.stroke();
  // piston from the body to the middle of the leg
  if (dep > 0.05) {
    const mx = lerp(hx, tx, 0.5), my = lerp(hy, ty, 0.5);
    ctx.strokeStyle = '#3a414c';
    ctx.lineWidth = 0.28;
    ctx.beginPath(); ctx.moveTo(side * 1.85, -9); ctx.lineTo(mx, my); ctx.stroke();
  }
  // foot
  ctx.fillStyle = '#2a3039';
  ctx.beginPath(); ctx.ellipse(tx, ty, 0.9, 0.3, 0, 0, Math.PI * 2); ctx.fill();
}

function drawFlame(s) {
  const t = performance.now() / 1000;
  const th = s.throttle;
  const alt = Math.max(0, s.y);
  const L = (9 + 20 * th) * (1 + Math.min(1.4, alt / 1500)) * (1 + 0.06 * Math.sin(t * 47) + 0.04 * Math.random());
  const wide = 1 + Math.min(1.6, alt / 900);
  ctx.globalCompositeOperation = 'lighter';
  // glow
  const g0 = ctx.createRadialGradient(0, 2, 0, 0, 2, 9 * wide);
  g0.addColorStop(0, `rgba(255, 170, 90, ${0.45 * th + 0.15})`);
  g0.addColorStop(1, 'rgba(255, 120, 60, 0)');
  ctx.fillStyle = g0;
  ctx.fillRect(-10 * wide, -8, 20 * wide, 20 * wide);
  // flame body
  const g1 = ctx.createLinearGradient(0, 1, 0, 1 + L);
  g1.addColorStop(0, 'rgba(255, 255, 250, 1)');
  g1.addColorStop(0.1, 'rgba(255, 236, 190, 0.95)');
  g1.addColorStop(0.35, 'rgba(255, 168, 80, 0.75)');
  g1.addColorStop(0.7, 'rgba(255, 96, 50, 0.3)');
  g1.addColorStop(1, 'rgba(255, 80, 40, 0)');
  ctx.fillStyle = g1;
  ctx.beginPath();
  ctx.moveTo(-0.8, 1);
  ctx.bezierCurveTo(-1.8 * wide, 1 + L * 0.3, -0.7 * wide, 1 + L * 0.8, 0, 1 + L);
  ctx.bezierCurveTo(0.7 * wide, 1 + L * 0.8, 1.8 * wide, 1 + L * 0.3, 0.8, 1);
  ctx.closePath();
  ctx.fill();
  // blue-white core
  const g2 = ctx.createLinearGradient(0, 1, 0, 1 + L * 0.45);
  g2.addColorStop(0, 'rgba(230, 240, 255, 0.95)');
  g2.addColorStop(1, 'rgba(170, 200, 255, 0)');
  ctx.fillStyle = g2;
  ctx.beginPath();
  ctx.moveTo(-0.55, 1);
  ctx.quadraticCurveTo(-0.6, 1 + L * 0.25, 0, 1 + L * 0.45);
  ctx.quadraticCurveTo(0.6, 1 + L * 0.25, 0.55, 1);
  ctx.closePath();
  ctx.fill();
  // shock diamonds
  for (let k = 1; k <= 3; k++) {
    ctx.fillStyle = `rgba(255, 245, 220, ${0.5 / k})`;
    ctx.beginPath();
    ctx.ellipse(0, 1 + L * (0.12 + k * 0.11), 0.45, 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function drawPlumeParticles(s) {
  // particles live in world-aligned metres relative to the nozzle; undo the booster rotation
  ctx.save();
  ctx.rotate(-s.theta);
  ctx.globalCompositeOperation = 'lighter';
  for (const p of fx.plume) {
    const k = p.life / p.max;
    const a = (1 - k) * 0.35;
    const r = p.r;
    const g = ctx.createRadialGradient(p.rx, -p.ry, 0, p.rx, -p.ry, r);
    const c = k < 0.3 ? '255, 200, 120' : k < 0.6 ? '255, 130, 70' : '150, 110, 100';
    g.addColorStop(0, `rgba(${c}, ${a})`);
    g.addColorStop(1, `rgba(${c}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(p.rx - r, -p.ry - r, r * 2, r * 2);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

function drawSmoke(list, kind) {
  for (const p of list) {
    const k = p.life / p.max;
    const x = sx(p.x), y = sy(p.y), r = p.r * cam.s;
    const a = (kind === 'steam' ? 0.25 : 0.32) * (1 - k);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const c = kind === 'steam' ? '230, 236, 245' : '205, 190, 185';
    g.addColorStop(0, `rgba(${c}, ${a})`);
    g.addColorStop(1, `rgba(${c}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

function drawFire() {
  if (!fx.fire.length && !fx.debris.length) return;
  for (const p of fx.fire) {
    const k = p.life / p.max;
    const x = sx(p.x), y = sy(p.y), r = p.r * cam.s;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    if (k < 1) {
      ctx.globalCompositeOperation = 'lighter';
      const c = k < 0.3 ? '255, 230, 170' : k < 0.6 ? '255, 140, 60' : '200, 60, 30';
      g.addColorStop(0, `rgba(${c}, ${0.7 * (1 - k * 0.7)})`);
      g.addColorStop(1, `rgba(${c}, 0)`);
    } else {
      ctx.globalCompositeOperation = 'source-over';
      const a = 0.35 * (1 - (p.life - p.max) / 2.5);
      g.addColorStop(0, `rgba(40, 34, 36, ${a})`);
      g.addColorStop(1, 'rgba(40, 34, 36, 0)');
    }
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.globalCompositeOperation = 'source-over';
  for (const d of fx.debris) {
    ctx.save();
    ctx.translate(sx(d.x), sy(d.y));
    ctx.rotate(d.a);
    ctx.fillStyle = d.life < 1.5 ? '#ffb070' : '#2a2e35';
    ctx.fillRect((-d.w / 2) * cam.s, (-d.h / 2) * cam.s, d.w * cam.s, d.h * cam.s);
    ctx.restore();
  }
}

function drawRing() {
  if (!fx.ring) return;
  const s = app.flight.state;
  ctx.strokeStyle = fx.ring.bad ? `rgba(255, 210, 160, ${fx.ring.a * 0.6})` : `rgba(91, 227, 164, ${fx.ring.a * 0.8})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(sx(s.x), sy(0), fx.ring.r * cam.s, fx.ring.r * cam.s * 0.16, 0, 0, Math.PI * 2);
  ctx.stroke();
}

function drawPrediction(f) {
  // where you'll be in the next few seconds if you hold the controls as they are
  const sim = { wind: f.wind, limits: f.limits, pad: f.pad, minThrottle: f.minThrottle, fuel0: f.fuel0, state: { ...f.state } };
  const st = { ...app.steer };
  const pts = [];
  for (let i = 0; i < 240 && !sim.state.done; i++) {
    step(sim, humanControl(sim, 1 / 40, st), 1 / 40);
    if (i % 4 === 0) pts.push([sim.state.x, sim.state.y]);
  }
  ctx.fillStyle = 'rgba(238, 242, 247, 0.55)';
  for (let i = 0; i < pts.length; i++) {
    ctx.globalAlpha = 1 - i / pts.length;
    ctx.beginPath();
    ctx.arc(sx(pts[i][0]), sy(pts[i][1]), 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  if (sim.state.done && sim.state.outcome && sim.state.outcome.checks && 'onPad' in sim.state.outcome.checks) {
    const x = sx(sim.state.x), y = sy(0);
    const ok = sim.state.outcome.checks.onPad;
    ctx.strokeStyle = ok ? 'rgba(91, 227, 164, 0.9)' : 'rgba(255, 107, 91, 0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x - 6, y - 8); ctx.lineTo(x + 6, y - 20); ctx.moveTo(x + 6, y - 8); ctx.lineTo(x - 6, y - 20); ctx.stroke();
  }
}

function drawPadArrow(f) {
  const px = sx(0);
  if (px > 24 && px < W - 24) return;
  const left = px <= 24;
  const x = left ? 28 : W - 28;
  const y = clamp(sy(0) - 40, 80, H - 40);
  ctx.fillStyle = 'rgba(91, 227, 164, 0.95)';
  ctx.beginPath();
  if (left) { ctx.moveTo(x - 12, y); ctx.lineTo(x + 2, y - 9); ctx.lineTo(x + 2, y + 9); }
  else { ctx.moveTo(x + 12, y); ctx.lineTo(x - 2, y - 9); ctx.lineTo(x - 2, y + 9); }
  ctx.fill();
  ctx.font = '600 13px "Barlow Condensed", system-ui, sans-serif';
  ctx.textAlign = left ? 'left' : 'right';
  ctx.fillText(`Pad ${Math.round(Math.abs(f.state.x))} m`, left ? x + 8 : x - 8, y + 24);
}

function drawMinimap(f) {
  const w = mini.width, h = mini.height;
  mctx.clearRect(0, 0, w, h);
  const xr = 320, yr = 2400;
  const mx = (x) => w / 2 + (x / xr) * (w / 2 - 10);
  const my = (y) => h - 18 - (y / yr) * (h - 30);
  mctx.fillStyle = 'rgba(120, 150, 200, 0.12)';
  mctx.fillRect(0, my(0), w, h - my(0));
  mctx.fillStyle = '#5be3a4';
  mctx.fillRect(mx(-f.pad.halfWidth), my(0) - 2, mx(f.pad.halfWidth) - mx(-f.pad.halfWidth), 4);
  for (const gtr of app.ghosts) {
    mctx.strokeStyle = gtr.landed ? 'rgba(91, 227, 164, 0.35)' : 'rgba(255, 107, 91, 0.35)';
    mctx.lineWidth = 1.5;
    mctx.beginPath();
    gtr.trace.forEach(([x, y], i) => (i ? mctx.lineTo(mx(x), my(y)) : mctx.moveTo(mx(x), my(y))));
    mctx.stroke();
  }
  mctx.strokeStyle = 'rgba(255, 179, 71, 0.9)';
  mctx.lineWidth = 2;
  mctx.beginPath();
  app.trail.forEach(([x, y], i) => (i ? mctx.lineTo(mx(x), my(y)) : mctx.moveTo(mx(x), my(y))));
  mctx.stroke();
  const s = f.state;
  mctx.fillStyle = '#eef2f7';
  mctx.beginPath(); mctx.arc(mx(s.x), my(s.y), 4, 0, Math.PI * 2); mctx.fill();
}

// ---------- HUD ----------
let hudT = 0;
function hud() {
  const f = app.flight;
  if (!f) return;
  const now = performance.now();
  if (now - hudT < 50) return;
  hudT = now;
  const s = f.state;
  const B = BOOSTER;
  const h = Math.max(0, s.y - B.legHeight);
  const L = f.limits;
  $('t-alt').textContent = h < 100 ? h.toFixed(1) : Math.round(h);
  $('t-vy').textContent = (-s.vy).toFixed(1);
  $('t-vx').textContent = Math.abs(s.vx).toFixed(1);
  $('t-dx').textContent = Math.abs(s.x).toFixed(h < 100 ? 1 : 0);
  $('t-tilt').textContent = (s.theta / DEG).toFixed(1);
  $('t-gim').textContent = (s.gimbal / DEG).toFixed(1);
  const low = h < 120;
  const aim = Math.sqrt(1 + 2 * 3 * h);
  const guided = app.mode === 'game' && levelCfg().target && !s.done;
  $('t-vy').className = low ? (Math.abs(s.vy) <= Math.max(L.vy, aim + 1) ? 'ok' : 'warn') : guided ? (-s.vy > aim + 4 ? 'warn' : 'ok') : '';
  $('t-vx').className = low ? (Math.abs(s.vx) <= L.vx ? 'ok' : 'warn') : '';
  $('t-dx').className = low ? (Math.abs(s.x) <= f.pad.halfWidth ? 'ok' : 'warn') : '';
  $('t-tilt').className = low ? (Math.abs(s.theta) <= L.tilt ? 'ok' : 'warn') : '';
  // target speed helper on Easy and Medium
  $('t-vy-target').textContent = guided ? `m/s, aim for ${aim.toFixed(0)}` : 'm/s';
  const lit = s.engineOn && !s.done;
  const thr = lit ? s.throttle : 0;
  $('b-thr').style.width = `${thr * 100}%`;
  const raw = $('raw').checked;
  $('t-thr').textContent = lit ? `${Math.round(s.throttle * 100)}%` : app.mode === 'game' && raw ? `set ${Math.round(app.input.throttle * 100)}%` : '0%';
  const hover = (mass(s) * G) / (BOOSTER.thrustMax * Math.max(0.6, Math.cos(s.theta)));
  const mark = $('hover-mark');
  mark.style.left = `${clamp(hover, 0, 1) * 100}%`;
  mark.classList.toggle('hidden', app.mode !== 'game' || s.done || !raw);
  $('b-fuel').style.width = `${(s.fuel / f.fuel0) * 100}%`;
  $('t-fuel').textContent = `${Math.round(s.fuel)} kg`;
  const fe = $('f-engine');
  fe.textContent = lit ? 'Engine on' : 'Engine off';
  fe.className = 'flag' + (lit ? ' on' : '');
  const fl = $('f-legs');
  fl.textContent = fx.legs >= 1 ? 'Legs down' : fx.legs > 0 ? 'Legs deploying' : 'Legs stowed';
  fl.className = 'flag' + (fx.legs >= 1 ? ' good' : '');
  $('f-pilot').textContent = app.mode === 'sim' ? 'Autopilot flying' : 'You fly';
  $('f-pilot').className = 'flag' + (app.mode === 'sim' ? ' auto' : '');
  const t = Math.floor(s.t);
  $('t-clock').textContent = `T+ ${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  const w = windAt(f.wind, s.t, s.y);
  $('t-wind').textContent = Math.abs(w).toFixed(1);
  $('wind-arrow').style.transform = `rotate(${w < 0 ? 180 : 0}deg)`;
  $('t-level').textContent = app.mode === 'game' ? `${levelCfg().label} level` : 'Simulator';

  // cues: climbing (any level), and "light it now" on Easy
  const cue = $('cue');
  let msg = '';
  if (app.mode === 'game' && app.running && !s.done) {
    if (s.engineOn && s.vy > 1.5) msg = 'Climbing: throttle down or cut the engine';
    else if (levelCfg().cue && !s.engineOn && s.vy < -5) {
      const brake = (0.85 * B.thrustMax) / mass(s) - G;
      if (h <= ((s.vy * s.vy) / (2 * brake)) * 1.35) msg = 'Light the engine';
    }
  }
  cue.textContent = msg;
  cue.classList.toggle('hidden', !msg);
}

// ---------- game pane ----------
function renderLevels() {
  const box = $('levels');
  box.innerHTML = '';
  for (const [k, lv] of Object.entries(LEVELS)) {
    const b = document.createElement('button');
    b.className = 'level' + (k === app.level ? ' active' : '');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(k === app.level));
    b.textContent = lv.label;
    b.addEventListener('click', () => { app.level = k; store.set('hs.level', k); renderLevels(); showIntro(); });
    box.appendChild(b);
  }
  const lv = levelCfg();
  $('level-blurb').textContent = lv.blurb;
  const f = makeFlight(1, lv.opts);
  $('limits-text').textContent = `Land inside the green zone (±${f.pad.halfWidth} m) at under ${f.limits.vy} m/s down, ${f.limits.vx} m/s sideways and ${Math.round(f.limits.tilt / DEG)}° of tilt. The dotted line shows where you're heading.`;
  renderBest();
}

function renderBest() {
  const best = store.get('hs.best', {});
  const parts = Object.entries(LEVELS).filter(([k]) => best[k]).map(([k, lv]) => `${lv.label} ${best[k]}`);
  $('best').textContent = parts.length ? `Best scores: ${parts.join(', ')}` : '';
}

// ---------- simulator pane ----------
function fmt(key, v) {
  const step = GAIN_RANGES[key][2];
  const d = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return Number(v).toFixed(d);
}

function renderSliders() {
  const box = $('sliders');
  box.innerHTML = '';
  let group = '';
  for (const st of SETTINGS) {
    if (st.group !== group) {
      group = st.group;
      const h = document.createElement('h3');
      h.className = 'group';
      h.textContent = group;
      box.appendChild(h);
    }
    const [lo, hi, stp] = GAIN_RANGES[st.key];
    const row = document.createElement('div');
    row.className = 'slider';
    row.id = `row-${st.key}`;
    row.innerHTML = `
      <label for="g-${st.key}">${st.name}</label>
      <output id="o-${st.key}">${fmt(st.key, app.gains[st.key])} ${st.unit}</output>
      <input type="range" id="g-${st.key}" min="${lo}" max="${hi}" step="${stp}" value="${app.gains[st.key]}">
      <p class="what">${st.what}</p>
      <details><summary>Too low or too high?</summary><p>${st.low}</p><p>${st.high}</p></details>`;
    box.appendChild(row);
    row.querySelector('input').addEventListener('input', (e) => setGain(st.key, Number(e.target.value), false));
  }
}

function setGain(key, v, syncInput = true) {
  const [lo, hi, stp] = GAIN_RANGES[key];
  v = clamp(Math.round(v / stp) * stp, lo, hi);
  app.gains[key] = Number(v.toFixed(4));
  $(`o-${key}`).textContent = `${fmt(key, app.gains[key])} ${SETTING[key].unit}`;
  if (syncInput) $(`g-${key}`).value = app.gains[key];
  store.set('hs.gains', app.gains);
}

function renderReport() {
  const r = app.report;
  const box = $('report');
  if (!r) { box.innerHTML = ''; return; }
  const o = r.outcome;
  const events = r.events.map((e) => `<li>${e.t !== null && e.t !== undefined ? `<span class="t">T+${e.t.toFixed(1)} s</span>` : '<span class="t"></span>'}${e.text}</li>`).join('');
  const findings = r.findings.map((fd, i) => {
    const fixes = fd.fixes.map((fx2) => {
      const st = SETTING[fx2.key];
      return `<button class="fix" data-key="${fx2.key}" data-dir="${fx2.dir}">${fx2.dir > 0 ? 'Raise' : 'Lower'} ${st.name.toLowerCase()}</button>`;
    }).join('');
    return `<div class="finding${i === 0 ? ' main' : ''}"><h4>${fd.title}</h4><p>${fd.detail}</p>${fixes ? `<div class="fixes">${fixes}</div>` : ''}</div>`;
  }).join('');
  box.innerHTML = `
    <div class="report-head ${o.landed ? 'good' : 'bad'}"><b>${o.landed ? 'Landed' : o.reason}</b><span>Score ${r.score}</span></div>
    <h3 class="group">What went wrong</h3>
    ${findings}
    <h3 class="group">What happened</h3>
    <ol class="events">${events}</ol>`;
  for (const b of box.querySelectorAll('.fix')) {
    b.addEventListener('click', () => {
      const k = b.dataset.key;
      const dir = Number(b.dataset.dir);
      setGain(k, app.gains[k] + dir * NUDGE[k]);
      const row = $(`row-${k}`);
      row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
      start();
    });
  }
}

$('run').addEventListener('click', () => { $('test-result').innerHTML = ''; start(); });
$('reset-gains').addEventListener('click', () => {
  for (const k of Object.keys(GAIN_RANGES)) setGain(k, DEFAULT_GAINS[k]);
  app.report = null; app.ghosts = []; renderReport(); $('test-result').innerHTML = ''; showIntro();
});
$('test-all').addEventListener('click', () => {
  const ev = evaluate(app.gains);
  app.ghosts = SEEDS.map((seed) => simulate(app.gains, seed, true));
  const box = $('test-result');
  box.innerHTML = `<div class="summary">${ev.landed} of 5 landed. Average score ${ev.mean_score}.</div>` +
    ev.flights.map((fl) => `<button class="flight-chip ${fl.landed ? 'good' : 'bad'}" data-seed="${fl.seed}"><span>Wind ${fl.seed}</span><span>${fl.landed ? 'Landed' : fl.reason}</span><b>${fl.score}</b></button>`).join('') +
    '<p class="muted">Click a flight to watch it and read its debrief. Lines on the map show all five.</p>';
  for (const b of box.querySelectorAll('.flight-chip')) b.addEventListener('click', () => { app.seed = Number(b.dataset.seed); $('seed').value = app.seed; start(); });
});

// ---------- tabs and selects ----------
function setMode(mode) {
  app.mode = mode;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === mode);
  for (const p of document.querySelectorAll('.pane')) p.classList.toggle('hidden', p.dataset.pane !== mode);
  document.body.dataset.mode = mode;
  app.ghosts = [];
  showIntro();
}
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => setMode(t.dataset.tab));

for (const seed of SEEDS) {
  const w = makeFlight(seed).wind.steady;
  const o = document.createElement('option');
  o.value = seed;
  o.textContent = `${seed}: ${Math.abs(w).toFixed(0)} m/s from the ${w > 0 ? 'left' : 'right'}`;
  $('seed').appendChild(o);
}
$('seed').addEventListener('change', (e) => { app.seed = Number(e.target.value); app.mode === 'game' ? showIntro() : start(); });
$('speed').addEventListener('change', (e) => { app.speed = Number(e.target.value); });

// ---------- boot ----------
resize();
renderLevels();
renderSliders();
setMode('game');
requestAnimationFrame((t) => { last = t; frame(t); });
