import { BOOSTER, G, DEG, clamp, SEEDS, DT, LEVELS, DEFAULT_GAINS, GAIN_RANGES, makeFlight, step, autopilot, windAt, mass, scoreFlight, evaluate, simulate } from './physics.js';
import { SETTINGS, SETTING, debrief, NUDGE } from './explain.js';
import { humanControl } from './controls.js';
import { BANK } from './bank.js';
import { nextScenario, bagProgress, scenarioFlight, faultLabels } from './scenario.js';

const $ = (id) => document.getElementById(id);
const lerp = (a, b, t) => a + (b - a) * t;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};

// ---------- state ----------
const app = {
  mode: 'game', // 'game' (you fly) or 'sim' (autopilot flies your settings)
  level: store.get('hs.level', 'easy'),
  seed: 1,
  speed: 1,
  gains: { ...DEFAULT_GAINS, ...store.get('hs.gains', {}) },
  flight: null,
  scenario: null, // the scenario being played in the game (a variation of the level)
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
const freshFx = () => ({ standing: false, vent: [], plume: [], smoke: [], fire: [], debris: [], steam: [], dust: [], sparks: [], puffs: [], flash: 0, shake: 0, ring: null, legs: 0, exploded: false, landedAt: 0, slow: 1, punch: 0, fin: 0, finCmd: 0, rcsCmd: 0, bolt: null, nextBolt: 3, bob: 0 });
const fx = freshFx();
const rain = [];

// One look per level, so the difficulty is visible: a sunset, a dusk with a moon, a night storm.
const THEMES = {
  sunset: {
    sky: [[0, '#060b1d'], [0.45, '#121a3d'], [0.74, '#3b2350'], [0.9, '#a2464a'], [0.97, '#f0894f'], [1, '#ffc27a']],
    stars: 0.8, sun: true, moon: false, glow: '255, 196, 120', sea: ['#2a2140', '#16203a', '#070d1b'], cloud: '255, 176, 150', cloudMul: 1,
    swell: 1, glitter: '255, 190, 130', glx: 0.74, rain: false, bolts: false, whitecaps: false, ambient: 1, lights: 0.5,
    hull: ['#3c4658', '#151b27'], deck: ['#505b6c', '#6a7587'], rim: '255, 170, 110',
  },
  dusk: {
    sky: [[0, '#03050f'], [0.4, '#0a0f2e'], [0.72, '#221a49'], [0.9, '#55306a'], [0.97, '#9b476b'], [1, '#cf7468']],
    stars: 1.7, sun: false, moon: true, glow: '205, 110, 140', sea: ['#2a1d45', '#111838', '#050a17'], cloud: '200, 140, 190', cloudMul: 1.4,
    swell: 1.8, glitter: '210, 220, 255', glx: 0.64, rain: false, bolts: false, whitecaps: false, ambient: 0.72, lights: 1,
    hull: ['#343d4f', '#10151f'], deck: ['#444e5f', '#5a6578'], rim: '200, 150, 200',
  },
  storm: {
    sky: [[0, '#02050a'], [0.5, '#08111a'], [0.8, '#122030'], [1, '#243546']],
    stars: 0, sun: false, moon: false, glow: '120, 150, 190', sea: ['#1c2937', '#0c1621', '#03080f'], cloud: '120, 145, 180', cloudMul: 3.4,
    swell: 3.2, glitter: '150, 180, 220', glx: 0.5, rain: true, bolts: true, whitecaps: true, ambient: 0.4, lights: 1.7,
    hull: ['#232b37', '#0a0e14'], deck: ['#2c3440', '#3a4452'], rim: '150, 180, 230',
  },
};
function theme() {
  if (app.mode !== 'game') return THEMES.sunset;
  return THEMES[{ easy: 'sunset', medium: 'dusk', hard: 'storm' }[app.level]] || THEMES.sunset;
}
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
  if (app.mode === 'game') {
    if (!app.scenario) pickScenario();
    app.flight = scenarioFlight(app.level, app.scenario);
  } else app.flight = makeFlight(app.seed, undefined);
  app.input.engine = false;
  app.input.throttle = 0.8;
  app.trail = [];
  app.steer = { want: 0, vHold: 0 };
  app.ended = false;
  app.acc = 0;
  clearTimeout(app.cardTimer); // a result card from the flight you just left must not appear over this one
  Object.assign(fx, freshFx());
  cam.snap = true;
  $('outcome').classList.add('hidden');
  $('caption').classList.add('hidden');
  $('cue').classList.add('hidden');
  $('alert').classList.add('hidden');
  renderFaultChips();
}

function start() {
  newFlight();
  app.running = true;
  $('intro').classList.add('hidden');
  if (app.mode === 'sim') app.report = debrief(app.gains, app.seed);
}

// A new scenario from the shuffle bag: every one in the level is played before any repeats.
function pickScenario() {
  app.scenario = nextScenario(app.level, BANK, store);
}

function renderFaultChips() {
  const labels = app.mode === 'game' && app.scenario ? faultLabels(app.scenario.faults) : [];
  $('faults').innerHTML = labels.map((l) => `<span class="fault ${l.tone}" data-k="${l.key}">${l.text}</span>`).join('');
  $('i-faults').innerHTML = labels.map((l) => `<span class="fault ${l.tone}">${l.text}</span>`).join('');
}

// fresh = true shows a new scenario; otherwise the same one comes back (retry, resize, tab switch)
function showIntro(fresh = false) {
  if (app.mode === 'game' && (fresh || !app.scenario)) pickScenario();
  newFlight();
  app.running = false;
  const intro = $('intro');
  if (app.mode === 'game') {
    const sc = app.scenario;
    const prog = bagProgress(app.level, BANK, store);
    const floor = Math.round(makeFlight(1, levelCfg().opts).minThrottle * 100);
    $('i-kicker').textContent = `${levelCfg().label} · scenario ${prog.played} of ${prog.total} this round`;
    $('i-title').textContent = sc.name;
    $('i-sub').textContent = sc.briefing;
    $('i-rule').textContent = app.level === 'easy' ? `The engine throttles down to ${floor}%, so it can hover.` : `The engine can't throttle below ${floor}%, so it can't hover: end the burn at the deck.`;
    $('i-hint').classList.remove('hidden');
    $('start').textContent = 'Start descent';
  } else {
    $('i-kicker').textContent = 'Simulator';
    $('i-title').textContent = 'Your settings, its flight.';
    $('i-sub').textContent = 'The flight computer will fly this booster using the nine settings in the panel. Press Run flight to watch, then read what went wrong.';
    $('i-rule').textContent = '';
    $('i-hint').classList.add('hidden');
    $('start').textContent = 'Run flight';
  }
  intro.classList.remove('hidden');
  renderLevels();
}

// ---------- control ----------
// Game controls live in controls.js so the tests can fly with them.
const human = (f, dt, st, inp = app.input) => humanControl(f, dt, st, inp, levelCfg(), $('raw').checked);

function control(f) {
  return app.mode === 'sim' ? autopilot(f, app.gains) : human(f, DT, app.steer);
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
  if (e.code === 'KeyN' && app.mode === 'game' && !e.ctrlKey && !e.metaKey) return showIntro(true);
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
      const c = control(f);
      fx.finCmd = app.mode === 'sim' ? clamp((-c.gimbal / BOOSTER.gimbalMax) * 0.8, -0.8, 0.8) : $('raw').checked ? clamp((c.rcs || 0) * 0.8, -0.8, 0.8) : clamp((app.steer.want - f.state.theta) * 9, -0.8, 0.8);
      step(f, c, DT);
      fx.rcsCmd = f.state.rcsEff; // what the thrusters really did, after faults
      app.acc -= DT;
      n++;
    }
    if (!app.trail.length || f.state.t - app.trail[app.trail.length - 1][2] > 0.1) app.trail.push([f.state.x, f.state.y, f.state.t]);
    if (f.state.done && !app.ended) onEnd();
  } else if (f && f.state.done) {
    fx.slow = lerp(fx.slow, 1, Math.min(1, dt * 0.9)); // ease out of the touchdown slow motion
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
  const c = o.checks || {};
  const soft = c.vertical && c.horizontal && c.upright && c.steady;
  if (o.landed) {
    fx.landedAt = performance.now();
    fx.ring = { r: 0, a: 1 };
    touchdown(s, 'Landed');
  } else if (soft && o.distance <= 31) {
    // down safely on the barge, just outside the pad: it stands, so no fireball
    fx.landedAt = performance.now();
    fx.standing = true;
    touchdown(s, 'Off the pad', 'warn');
  } else if (soft) {
    splash(s); // a gentle touch in the water: it tips over and sinks
  } else if (o.reason !== 'Flew away' && o.reason !== 'Timed out') {
    explode(s);
  }
  app.cardTimer = setTimeout(() => showOutcome(o), o.landed || fx.standing ? 1500 : 1300);
  if (app.mode === 'sim') renderReport();
  if (app.mode === 'game' && o.landed) {
    const sc = scoreFlight(o);
    const best = store.get('hs.best', {});
    if (!best[app.level] || sc > best[app.level]) { best[app.level] = sc; store.set('hs.best', best); }
    const cleared = store.get('hs.cleared', {});
    if (app.scenario && (!cleared[app.scenario.id] || sc > cleared[app.scenario.id])) { cleared[app.scenario.id] = sc; store.set('hs.cleared', cleared); }
    renderBest();
  }
}

// A landing that feels like one: dust rolls across the deck, sparks scatter, the camera punches in
// and holds a beat in slow motion, and the word lands with it.
function splash(s) {
  fx.exploded = true; // it goes under
  for (let i = 0; i < 46; i++) {
    fx.sparks.push({ x: s.x + (Math.random() - 0.5) * 5, y: 0.2, vx: (Math.random() - 0.5) * 18, vy: 10 + Math.random() * 24, life: 0, max: 1.2 + Math.random() * 0.9, water: true });
  }
  for (let i = 0; i < 7; i++) fx.steam.push({ x: s.x + (Math.random() - 0.5) * 4, y: 0.8, vx: (Math.random() - 0.5) * 5, vy: 2 + Math.random() * 3, life: 0, max: 1.6, r: 1.2 + Math.random() });
  fx.ring = { r: 0, a: 1, bad: true };
  fx.shake = 0.3;
}

function touchdown(s, word, tone) {
  for (let i = 0; i < 40; i++) {
    const dir = i % 2 ? 1 : -1;
    fx.dust.push({ x: s.x + (Math.random() - 0.5) * 5, y: 0.4 + Math.random() * 0.8, vx: dir * (6 + Math.random() * 36), vy: 0.3 + Math.random() * 2, life: 0, max: 0.8 + Math.random() * 1.0, r: 1.2 + Math.random() * 1.8 });
  }
  for (let i = 0; i < 26; i++) {
    const dir = Math.random() < 0.5 ? -1 : 1;
    fx.sparks.push({ x: s.x + dir * (1 + Math.random() * 6), y: 0.6, vx: dir * (4 + Math.random() * 22), vy: 5 + Math.random() * 16, life: 0, max: 0.5 + Math.random() * 0.7 });
  }
  fx.slow = 0.25;
  fx.punch = 1;
  fx.shake = 0.3;
  const cap = $('caption');
  cap.textContent = word;
  cap.classList.toggle('warn', tone === 'warn');
  cap.classList.remove('hidden');
  cap.classList.remove('pop');
  void cap.offsetWidth;
  cap.classList.add('pop');
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
  const game = app.mode === 'game';
  $('o-scn').textContent = game && app.scenario ? `${levelCfg().label} · ${app.scenario.name}` : '';
  $('o-retry').textContent = game ? 'Retry this one' : 'Run again';
  $('o-next').textContent = game ? 'New scenario' : 'Next wind';
  // after a win the natural next step is a new scenario; after a loss it is another go
  $('o-next').classList.toggle('primary', !game || o.landed);
  $('o-retry').classList.toggle('primary', game && !o.landed);
  $('outcome').classList.remove('hidden');
}

function gameHint(o) {
  const f = app.flight;
  const L = f.limits;
  const F = f.faults;
  if (F && o.reason === 'Ran out of fuel' && F.leak > 0) return 'The leak drained the tank. Light the engine later and brake harder so the burn is shorter.';
  if (F && F.thrustCap < 1 && o.reason === 'Hit too hard') return `The engine only gives ${Math.round(F.thrustCap * 100)}% thrust, so it brakes more slowly. Light it earlier than you would normally.`;
  if (F && F.dropouts.length && (o.reason === 'Hit too hard' || o.reason === 'Ran out of fuel')) return 'The engine cut out during the burn. Keep extra height in hand so one cut-out is not fatal.';
  if (F && F.weakSide && (o.reason === 'Missed the pad' || o.reason === 'Landed in the sea' || o.reason.startsWith('Slid'))) return `${F.weakSide === 'left' ? 'Left' : 'Right'} steering is weak. Start leaning early, and plan to steer the other way when you can.`;
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
$('o-next').addEventListener('click', () => {
  if (app.mode === 'game') return showIntro(true);
  app.seed = (app.seed % SEEDS.length) + 1; $('seed').value = app.seed; start();
});
$('reroll').addEventListener('click', () => showIntro(true));
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
    fx.fire.push({ smoke: Math.random() < 0.3, x: s.x + (Math.random() - 0.5) * 6, y: y + Math.random() * 20, vx: Math.cos(a) * v * (Math.random() < 0.5 ? -1 : 1), vy: Math.sin(a) * v * 0.7 + 4, life: 0, max: 0.8 + Math.random() * 1.8, r: 3 + Math.random() * 6 });
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
  fx.punch = Math.max(0, fx.punch - dt * 1.4);
  fx.fin += (fx.finCmd - fx.fin) * Math.min(1, dt * 9);

  // cold-gas thrusters near the top: the gas leaves on the side opposite the way the booster turns
  if (!s.done && Math.abs(fx.rcsCmd) > 0.1 && Math.random() < Math.min(1, Math.abs(fx.rcsCmd) * 1.6)) {
    fx.puffs.push({ side: -Math.sign(fx.rcsCmd), life: 0, max: 0.3, v: 0.6 + Math.abs(fx.rcsCmd) * 0.6, oy: (Math.random() - 0.5) * 0.9 });
  }
  for (const p of fx.puffs) p.life += dt;
  fx.puffs = fx.puffs.filter((p) => p.life < p.max);

  // a fuel leak: propellant vents from the side of the tank and streams away behind it
  const F = f.faults;
  if (F && F.leak > 0 && s.t >= F.leakStart && s.fuel > 0 && !s.done) {
    for (let i = 0; i < 2; i++) {
      const d = 8 + Math.random() * 8;
      fx.vent.push({ x: s.x + Math.sin(s.theta) * d + Math.cos(s.theta) * 2, y: s.y + Math.cos(s.theta) * d, vx: s.vx * 0.2 + 3 + Math.random() * 6, vy: s.vy * 0.4 + (Math.random() - 0.5) * 3, life: 0, max: 0.9 + Math.random() * 0.8, r: 0.8 + Math.random() * 0.9 });
    }
  }
  for (const p of fx.vent) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - dt * 0.7; p.life += dt; p.r += dt * 2.4; }
  fx.vent = fx.vent.filter((p) => p.life < p.max).slice(-160);

  // lightning and the swell on the barge
  const th = theme();
  if (th.bolts && !s.done) {
    if (fx.bolt) { fx.bolt.t += dt; if (fx.bolt.t > 0.7) fx.bolt = null; }
    else { fx.nextBolt -= dt; if (fx.nextBolt <= 0) { fx.bolt = { t: 0, x: 0.12 + Math.random() * 0.76, seed: Math.random() * 1000 }; fx.nextBolt = 4 + Math.random() * 7; } }
  } else fx.bolt = null;
  fx.bob = Math.sin(performance.now() / 1000 * 0.9) * Math.min(0.22 * cam.s * th.swell, 1.6);

  // plume particles, stored relative to the nozzle in metres
  if (s.engineOn && !s.done && !s.cut) {
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
    if (p.ry < ground) { p.ry = ground; p.vy = Math.abs(p.vy) * 0.08; p.vx += (Math.random() < 0.5 ? -1 : 1) * 14; p.life += dt * 1.5; }
    p.life += dt * (s.done ? 4 : 1); // the flame dies the moment the engine cuts
    p.r += dt * 6;
  }
  fx.plume = fx.plume.filter((p) => p.life < p.max).slice(-700);

  // deck smoke when the plume hits the barge
  if (s.engineOn && !s.cut && !s.done && s.y < 70) {
    const k = (1 - s.y / 70) * s.throttle;
    for (let i = 0; i < Math.round(k * 3); i++) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      fx.smoke.push({ x: s.x + (Math.random() - 0.5) * 4, y: 0.5, vx: dir * (15 + Math.random() * 40), vy: 1 + Math.random() * 3, life: 0, max: 1.2 + Math.random() * 1.4, r: 1.6 + Math.random() * 2.2 });
    }
  }
  for (const p of fx.dust) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - dt * 1.3; p.vy *= 1 - dt; p.life += dt; p.r += dt * 2.5; }
  fx.dust = fx.dust.filter((p) => p.life < p.max);
  for (const p of fx.sparks) {
    p.x += p.vx * dt; p.y += p.vy * dt; p.vy -= G * (p.water ? 1 : 1.6) * dt; p.life += dt;
    if (p.water) { if (p.y < 0 && p.vy < 0) p.life = p.max; } // droplets fall back into the sea
    else if (p.y < 0.3) { p.y = 0.3; p.vy = Math.abs(p.vy) * 0.35; p.vx *= 0.7; }
  }
  fx.sparks = fx.sparks.filter((p) => p.life < p.max);
  for (const p of fx.smoke) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - dt * 0.9; p.vy += dt * 1.5; p.life += dt; p.r += dt * 4; }
  fx.smoke = fx.smoke.filter((p) => p.life < p.max).slice(-260);

  // landed: steam venting
  if (s.done && s.outcome && (s.outcome.landed || fx.standing) && performance.now() - fx.landedAt < 6000 && Math.random() < 0.6) {
    fx.steam.push({ x: s.x + (Math.random() - 0.5) * 3, y: B.legHeight + 30 + Math.random() * 8, vx: (Math.random() - 0.3) * 4 + w * 0.3, vy: 2 + Math.random() * 3, life: 0, max: 2 + Math.random() * 2, r: 1.5 + Math.random() * 2 });
  }
  for (const p of fx.steam) { p.x += p.vx * dt; p.y += p.vy * dt; p.life += dt; p.r += dt * 3; }
  fx.steam = fx.steam.filter((p) => p.life < p.max);

  for (const p of fx.fire) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - dt * 1.5; p.vy = p.vy * (1 - dt * 1.5) + dt * 6; if (p.y < 0) { p.y = 0; p.vy = Math.abs(p.vy) * 0.3; } p.life += dt; p.r += dt * (p.life < p.max ? 9 : 1.5); }
  fx.fire = fx.fire.filter((p) => p.life < p.max + (p.smoke ? 2.5 : 0)).slice(-260);
  for (const d of fx.debris) {
    d.x += d.vx * dt; d.y += d.vy * dt; d.vy -= G * dt; d.a += d.va * dt; d.life += dt;
    if (d.y < 0.5 && Math.abs(d.x) < 34) { d.y = 0.5; d.vy = -d.vy * 0.3; d.vx *= 0.6; d.va *= 0.5; }
    else if (d.y < 0) { d.dead = true; fx.steam.push({ x: d.x, y: 0.4, vx: (Math.random() - 0.5) * 6, vy: 3 + Math.random() * 4, life: 0, max: 1.2, r: 1.5 }); } // splashes into the sea
  }
  fx.debris = fx.debris.filter((d) => !d.dead && d.life < 9);
  if (fx.ring) { fx.ring.r += dt * (fx.ring.bad ? 90 : 30); fx.ring.a -= dt * (fx.ring.bad ? 1.2 : 0.5); if (fx.ring.a <= 0) fx.ring = null; }
}

// ---------- rendering ----------
const sx = (x) => W / 2 + (x - cam.x) * cam.s;
const sy = (y) => H / 2 - (y - cam.y) * cam.s;

function updateCam(dt) {
  const s = app.flight.state;
  const y = Math.max(0, s.y);
  const touchUI = getComputedStyle($('touch')).display !== 'none';
  // on touch layouts the deck sits higher so the thumb buttons never cover it
  const ground = touchUI ? (H < 420 ? 0.7 : 0.62) : 0.82;
  const ts = clamp((H * (ground - 0.12)) / (y + 102), 0.18, 4.2) * (1 + 0.07 * fx.punch * fx.punch);
  const ty = ((ground - 0.5) * H) / ts;
  const span = (W * 0.36) / ts;
  // narrow portrait screens: slide the view so the booster flies on the right, clear of the readouts
  const shift = touchUI && W < 500 ? (0.17 * W) / ts : 0;
  const tx = clamp(s.x * 0.5, s.x - span, s.x + span) - shift;
  if (cam.snap) { cam.s = ts; cam.x = tx; cam.y = ty; cam.snap = false; return; }
  const k = Math.min(1, dt * 3.5);
  cam.s = lerp(cam.s, ts, k); cam.x = lerp(cam.x, tx, k); cam.y = ((ground - 0.5) * H) / cam.s;
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
  const th = theme();
  drawSky(th);
  drawClouds(th);
  drawBolt();
  drawSea(th);
  drawBarge(f, th);
  if (app.mode === 'game' && app.running && !s.done) drawPrediction(f);
  drawSmoke(fx.smoke, 'deck');
  if (!fx.exploded) {
    // nothing of the booster or its flame shows below the deck
    ctx.save();
    ctx.beginPath();
    ctx.rect(-50, -50, W + 100, sy(0) + fx.bob + 50 + clamp(6 * cam.s, 5, 30) * 0.15);
    ctx.clip();
    drawBooster(f);
    ctx.restore();
  }
  drawFire();
  drawSmoke(fx.vent, 'vent');
  drawSmoke(fx.dust, 'dust');
  drawSmoke(fx.steam, 'steam');
  drawSparks();
  drawRing();
  ctx.restore();
  drawRain(dt, th);
  if (fx.bolt) { const a = boltAlpha(); ctx.fillStyle = `rgba(190, 210, 255, ${a * 0.2})`; ctx.fillRect(0, 0, W, H); }
  if (fx.flash > 0) { ctx.fillStyle = `rgba(255, 214, 170, ${fx.flash * 0.55})`; ctx.fillRect(0, 0, W, H); }
  drawPadArrow(f);
  drawMinimap(f);
}

function drawSky(th) {
  const hy = sy(0);
  const g = ctx.createLinearGradient(0, 0, 0, hy);
  for (const [o, c] of th.sky) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, Math.max(0, hy) + 1);
  const t = performance.now() / 1000;
  if (th.stars) {
    for (const st of stars) {
      const y = st.y * hy;
      const a = (1 - st.y / 0.62) * (0.55 + 0.45 * Math.sin(t * 1.3 + st.p)) * th.stars;
      ctx.fillStyle = `rgba(230, 236, 255, ${Math.min(1, a * 0.8)})`;
      ctx.fillRect(st.x * W, y, st.r, st.r);
    }
  }
  const sunX = W * th.glx - cam.x * 0.02;
  const glow = ctx.createRadialGradient(sunX, hy, 0, sunX, hy, W * 0.55);
  glow.addColorStop(0, `rgba(${th.glow}, ${th.sun ? 0.55 : 0.3})`);
  glow.addColorStop(0.25, `rgba(${th.glow}, ${th.sun ? 0.18 : 0.1})`);
  glow.addColorStop(1, `rgba(${th.glow}, 0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, hy);
  if (th.sun) {
    ctx.fillStyle = '#ffe2b0';
    ctx.beginPath();
    ctx.arc(sunX, hy + 2, Math.max(10, H * 0.035), Math.PI, 0);
    ctx.fill();
  }
  if (th.moon) {
    const mx = W * 0.64 - cam.x * 0.02, my = hy * 0.3, mr = Math.max(9, H * 0.028);
    const mg = ctx.createRadialGradient(mx, my, mr * 0.6, mx, my, mr * 5);
    mg.addColorStop(0, 'rgba(210, 220, 255, 0.25)');
    mg.addColorStop(1, 'rgba(210, 220, 255, 0)');
    ctx.fillStyle = mg;
    ctx.fillRect(mx - mr * 5, my - mr * 5, mr * 10, mr * 10);
    ctx.fillStyle = '#e8eefc';
    ctx.beginPath(); ctx.arc(mx, my, mr, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(150, 165, 200, 0.35)'; // maria
    ctx.beginPath(); ctx.arc(mx - mr * 0.3, my - mr * 0.15, mr * 0.28, 0, Math.PI * 2); ctx.arc(mx + mr * 0.25, my + mr * 0.3, mr * 0.2, 0, Math.PI * 2); ctx.fill();
  }
}

function drawClouds(th) {
  const mul = th.cloudMul;
  for (const c of clouds) {
    const x = W / 2 + (c.x - cam.x * 0.7) * cam.s;
    const y = sy(c.y);
    const w = c.w * cam.s * (mul > 2 ? 1.5 : 1), h = Math.max(2, c.h * cam.s * (mul > 2 ? 1.8 : 1));
    if (y < -h || y > sy(0) - 2 || x + w < -50 || x - w > W + 50) continue;
    const a = Math.min(0.55, c.a * mul);
    const g = ctx.createRadialGradient(x, y, 0, x, y, w);
    g.addColorStop(0, `rgba(${th.cloud}, ${a})`);
    g.addColorStop(1, `rgba(${th.cloud}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, w, h, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

// lightning: a jagged bolt that flickers twice, lighting the sky
function boltAlpha() {
  const t = fx.bolt ? fx.bolt.t : 9;
  return t < 0.08 ? 1 : t < 0.14 ? 0.15 : t < 0.22 ? 0.9 : Math.max(0, 1 - (t - 0.22) / 0.45) * 0.45;
}
function drawBolt() {
  if (!fx.bolt) return;
  const a = boltAlpha();
  const hy = sy(0);
  const hash = (n) => { const v = Math.sin(n * 127.1 + fx.bolt.seed) * 43758.5453; return v - Math.floor(v); };
  let x = fx.bolt.x * W, y = 0;
  const pts = [[x, y]];
  const n = 16;
  for (let i = 1; i <= n; i++) { y = (hy * 0.92 * i) / n; x += (hash(i) - 0.5) * W * 0.06; pts.push([x, y]); }
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = `rgba(150, 180, 255, ${a * 0.35})`;
  ctx.lineWidth = 7;
  ctx.beginPath(); pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); ctx.stroke();
  ctx.strokeStyle = `rgba(240, 246, 255, ${a})`;
  ctx.lineWidth = 1.8;
  ctx.beginPath(); pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); ctx.stroke();
  ctx.restore();
}

function drawRain(dt, th) {
  if (!th.rain) { rain.length = 0; return; }
  const want = Math.min(170, Math.round((W * H) / 7500));
  while (rain.length < want) rain.push({ x: Math.random() * W, y: Math.random() * H, v: 0.8 + Math.random() * 0.6, l: 10 + Math.random() * 16 });
  rain.length = want;
  const f = app.flight;
  const w = f ? windAt(f.wind, f.state.t, f.state.y) : 0;
  const slant = clamp(w * 0.05, -0.6, 0.6);
  ctx.strokeStyle = 'rgba(170, 195, 230, 0.26)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const p of rain) {
    const v = 1100 * p.v * Math.min(dt, 0.05);
    p.y += v; p.x += v * slant;
    if (p.y > H) { p.y = -20; p.x = Math.random() * W; }
    if (p.x > W + 20) p.x = -20; else if (p.x < -20) p.x = W + 20;
    ctx.moveTo(p.x - slant * p.l, p.y - p.l);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

function drawSea(th) {
  const hy = sy(0);
  if (hy > H) return;
  const g = ctx.createLinearGradient(0, hy, 0, H);
  g.addColorStop(0, th.sea[0]);
  g.addColorStop(0.08, th.sea[1]);
  g.addColorStop(1, th.sea[2]);
  ctx.fillStyle = g;
  ctx.fillRect(0, hy, W, H - hy);
  const t = performance.now() / 1000;
  // glitter from the sun or the moon
  if (th.glitter) {
    const sunX = W * th.glx - cam.x * 0.02;
    const strength = th.sun ? 0.35 : th.moon ? 0.22 : 0.07;
    for (let i = 0; i < 70; i++) {
      const d = i / 70;
      const y = hy + 2 + d * d * (H - hy);
      const spread = 8 + d * W * 0.12;
      const x = sunX + Math.sin(i * 12.9898 + t * 0.9) * spread;
      const len = 6 + d * 40 * (0.5 + 0.5 * Math.sin(i * 3.1 + t * 2));
      ctx.fillStyle = `rgba(${th.glitter}, ${strength * (1 - d)})`;
      ctx.fillRect(x - len / 2, y, len, 1 + d * 1.5);
    }
  }
  // swell lines, taller in rougher weather
  ctx.strokeStyle = th.rain ? 'rgba(150, 180, 220, 0.13)' : 'rgba(140, 170, 220, 0.07)';
  ctx.lineWidth = 1;
  for (let j = 1; j < 7; j++) {
    const y = hy + (H - hy) * (j / 7) ** 1.6;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 16) ctx.lineTo(x, y + Math.sin(x * 0.02 + t * (0.6 + j * 0.1) + j) * (1 + j * 0.4) * th.swell);
    ctx.stroke();
  }
  // whitecaps on the crests
  if (th.whitecaps) {
    ctx.fillStyle = 'rgba(210, 225, 245, 0.28)';
    for (let j = 1; j < 7; j++) {
      const y = hy + (H - hy) * (j / 7) ** 1.6;
      for (let x = 0; x <= W; x += 22) {
        const ph = x * 0.02 + t * (0.6 + j * 0.1) + j;
        if (Math.sin(ph * 2.3 + j * 5) > 0.82) ctx.fillRect(x, y + Math.sin(ph) * (1 + j * 0.4) * th.swell - 1, 8 + j * 3, 1.5);
      }
    }
  }
}

const BOX = ['#8a4b3a', '#3f5f7a', '#a8843a', '#4f6350'];
const STACKS = [{ x: -30.4, boxes: [0, 1, 2] }, { x: 24.4, boxes: [3, 0] }];

function drawBarge(f, th) {
  const s = cam.s;
  const t = performance.now() / 1000;
  const halfDeck = 32;
  const x0 = sx(-halfDeck), x1 = sx(halfDeck);
  const d = clamp(6 * s, 5, 30); // the slice of deck we look down onto
  const y0 = sy(0) + fx.bob;
  const front = y0 + d / 2, back = y0 - d / 2;
  const hull = Math.max(4, 5 * s);
  const top = back - 3.8 * s - Math.max(2, 0.8 * s); // top of the end walls and beacon posts

  // hull, with plating seams
  const hg = ctx.createLinearGradient(0, front, 0, front + hull);
  hg.addColorStop(0, th.hull[0]); hg.addColorStop(1, th.hull[1]);
  ctx.fillStyle = hg;
  ctx.fillRect(x0, front, x1 - x0, hull);
  if (s > 0.9) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
    for (let m = -30; m <= 30; m += 6) ctx.fillRect(sx(m), front, 1, hull);
  }
  // deck top
  const dg = ctx.createLinearGradient(0, back, 0, front);
  dg.addColorStop(0, th.deck[0]); dg.addColorStop(1, th.deck[1]);
  ctx.fillStyle = dg;
  ctx.fillRect(x0, back, x1 - x0, d);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.fillRect(x0, front - 1, x1 - x0, 1);
  // stacked containers along the back of the deck, clear of the landing zone
  for (const st of STACKS) {
    const bw = 6 * s, bh = 2.6 * s;
    const bx = sx(st.x);
    st.boxes.forEach((c, i) => {
      const by = back + d * 0.28 - (i + 1) * bh;
      ctx.fillStyle = BOX[c];
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
      ctx.fillRect(bx, by, bw, Math.max(1, 0.18 * s));
      ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.fillRect(bx, by + bh - Math.max(1, 0.12 * s), bw, Math.max(1, 0.12 * s));
      if (s > 1.2) { for (let k = 1; k < 6; k++) ctx.fillRect(bx + k * (bw / 6), by + 0.2 * s, 1, bh - 0.4 * s); }
    });
  }
  // end walls
  ctx.fillStyle = '#262d3a';
  ctx.fillRect(x0, top + Math.max(2, 0.8 * s), 1.6 * s, front - top - Math.max(2, 0.8 * s));
  ctx.fillRect(x1 - 1.6 * s, top + Math.max(2, 0.8 * s), 1.6 * s, front - top - Math.max(2, 0.8 * s));

  // light level: darker themes dim the barge; its own lights are drawn on top afterwards
  const dim = (1 - th.ambient) * 0.85;
  if (dim > 0.02) {
    ctx.fillStyle = `rgba(2, 6, 14, ${dim})`;
    ctx.fillRect(x0 - 2, top, x1 - x0 + 4, front + hull - top + 2);
  }
  // sunset rim light on the end wall facing the sun
  ctx.fillStyle = `rgba(${th.rim}, ${0.22 * th.ambient})`;
  ctx.fillRect(x1 - 1.6 * s, top + Math.max(2, 0.8 * s), 0.5 * s, front - top - Math.max(2, 0.8 * s));

  // deck lights along the front edge
  const warm = th.lights;
  for (let m = -29; m <= 29; m += 5.8) {
    const lx = sx(m), ly = front - Math.max(1, 0.5 * s);
    const r = Math.max(4, 1.5 * s) * (0.8 + 0.2 * warm);
    const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, r);
    lg.addColorStop(0, `rgba(255, 214, 150, ${Math.min(0.95, 0.5 * warm)})`);
    lg.addColorStop(1, 'rgba(255, 190, 110, 0)');
    ctx.fillStyle = lg;
    ctx.fillRect(lx - r, ly - r, r * 2, r * 2);
    ctx.fillStyle = 'rgba(255, 240, 210, 0.95)';
    ctx.fillRect(lx - 0.7, ly - 0.7, 1.4, 1.4);
  }

  // landing zone: a ring the width of the real pad, with the X at its centre
  const half = f.pad.halfWidth;
  const near = clamp(1 - f.state.y / 600, 0.3, 1);
  const rx = half * s, ry = d * 0.44;
  const cx = sx(0), cy = y0;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = `rgba(91, 227, 164, ${0.1 * near})`;
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  const glowA = (th.rain ? 0.35 : 0.2) * near;
  ctx.strokeStyle = `rgba(91, 227, 164, ${glowA})`;
  ctx.lineWidth = Math.max(5, 0.9 * s);
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = `rgba(190, 255, 224, ${0.95 * near})`;
  ctx.lineWidth = Math.max(1.5, 0.35 * s);
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = Math.max(1, 0.2 * s);
  ctx.beginPath(); ctx.ellipse(cx, cy, rx * 0.5, ry * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - rx * 0.26, cy - ry * 0.55); ctx.lineTo(cx + rx * 0.26, cy + ry * 0.55);
  ctx.moveTo(cx + rx * 0.26, cy - ry * 0.55); ctx.lineTo(cx - rx * 0.26, cy + ry * 0.55);
  ctx.stroke();

  // blinking beacons on the end walls
  const blink = Math.sin(t * 3.8) > 0;
  for (const bx of [-halfDeck + 0.8, halfDeck - 0.8]) {
    const x = sx(bx), y = top - 0.4 * s;
    const r = Math.max(6, 3 * s);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * (blink ? 2.4 : 1.4));
    g.addColorStop(0, blink ? 'rgba(255, 110, 90, 0.95)' : 'rgba(255, 110, 90, 0.4)');
    g.addColorStop(1, 'rgba(255, 110, 90, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r * 3, y - r * 3, r * 6, r * 6);
    ctx.fillStyle = '#ff8f7a';
    ctx.fillRect(x - 1, y - 1, 2, 2);
  }
  // waterline foam that slides along the hull
  const wl = front + hull;
  ctx.fillStyle = 'rgba(200, 220, 255, 0.16)';
  ctx.fillRect(x0 - 3, wl - 1, x1 - x0 + 6, 2);
  ctx.strokeStyle = 'rgba(200, 220, 255, 0.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 7; i++) {
    const fxp = x0 + (((i / 7 + t * 0.02) % 1) * (x1 - x0));
    ctx.beginPath(); ctx.ellipse(fxp, wl + 2, 8 + (i % 3) * 4, 1.6, 0, 0, Math.PI * 2); ctx.stroke();
  }
  // engine light on the deck
  const st = f.state;
  if (st.engineOn && !st.cut && st.y < 150 && !st.done) {
    const k = (1 - st.y / 150) * st.throttle;
    const lx = sx(st.x), ly = y0;
    const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, 60 * s * 0.6 + 40);
    lg.addColorStop(0, `rgba(255, 190, 110, ${0.4 * k})`);
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
  // on touchdown the body settles onto its legs: a quick, damped bounce
  const landed = s.done && s.outcome && (s.outcome.landed || fx.standing);
  const tl = landed ? (performance.now() - fx.landedAt) / 1000 : 0;
  const squash = landed ? Math.max(-0.12, 0.55 * Math.exp(-5 * tl) * Math.cos(16 * tl)) : 0;
  if (landed) ctx.translate(0, fx.bob / vs);

  // plume first (behind the booster), additive
  ctx.save();
  ctx.translate(0, -1.0);
  ctx.rotate(s.gimbal * 1.8);
  if (s.engineOn && !s.done && !s.cut) drawFlame(s);
  ctx.restore();
  drawPlumeParticles(s);

  // legs
  const dep = easeInOut(fx.legs);
  for (const side of [-1, 1]) drawLeg(side, dep, squash);

  ctx.save();
  ctx.translate(0, squash); // everything above the feet rides the compression

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
  // rim light from the sunset (right side)
  ctx.fillStyle = 'rgba(255, 170, 110, 0.22)';
  ctx.fillRect(1.45, bodyTop + 4.6, 0.4, bodyBot - bodyTop - 4.6);
  // engine glow on the base
  if (s.engineOn && !s.cut) {
    const eg = ctx.createRadialGradient(0, 0, 0, 0, 0, 7);
    eg.addColorStop(0, `rgba(255, 180, 100, ${0.35 * s.throttle})`);
    eg.addColorStop(1, 'rgba(255, 150, 80, 0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = eg;
    ctx.fillRect(-7, -7, 14, 14);
    ctx.globalCompositeOperation = 'source-over';
  }
  // cold-gas thruster puffs near the top
  for (const p of fx.puffs) {
    const k = p.life / p.max;
    const px = p.side * (2.0 + k * 9 * p.v), py = bodyTop + 6 + p.oy;
    const r = 0.9 + k * 3.0 * p.v;
    const pg = ctx.createRadialGradient(px, py, 0, px, py, r);
    pg.addColorStop(0, `rgba(250, 253, 255, ${Math.min(1, (1 - k) * 1.3 * Math.min(1.2, p.v))})`);
    pg.addColorStop(1, 'rgba(245, 250, 255, 0)');
    ctx.fillStyle = pg;
    ctx.fillRect(px - r, py - r, r * 2, r * 2);
  }
  // a short bright flash right at the thruster
  if (fx.puffs.length) {
    const q = fx.puffs[fx.puffs.length - 1];
    if (q.life < 0.1) {
      const fxp = q.side * 2.0, fy = bodyTop + 6 + q.oy;
      const fg = ctx.createRadialGradient(fxp, fy, 0, fxp, fy, 1.6);
      fg.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
      fg.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = fg;
      ctx.fillRect(fxp - 1.6, fy - 1.6, 3.2, 3.2);
    }
  }
  ctx.restore();
  ctx.restore();
}

function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; }

function drawLeg(side, dep, squash = 0) {
  // hinge near the base; stowed legs lie along the body pointing up. Deployed, the feet sit exactly
  // legHeight below the engine, which is where the physics says the booster touches the deck.
  const hx = side * 1.85, hy0 = -3.0;
  const len = 8.2;
  const deployed = Math.acos(-(BOOSTER.legHeight - hy0) / len);
  const ang = lerp(0, deployed, dep);
  const tx = hx + side * Math.sin(ang) * len;
  const ty = hy0 - Math.cos(ang) * len;
  const hy = hy0 + squash; // the body sinks onto fixed feet
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
    ctx.beginPath(); ctx.moveTo(side * 1.85, -9 + squash); ctx.lineTo(mx, my); ctx.stroke();
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
    const x = sx(p.x), y = sy(p.y), r = kind === 'vent' ? Math.max(p.r * cam.s, 3.2) : p.r * cam.s; // vapour stays visible from high up
    const a = (kind === 'steam' ? 0.22 : kind === 'dust' ? 0.2 : kind === 'vent' ? 0.45 : 0.17) * (1 - k);
    const c = kind === 'steam' ? '230, 236, 245' : kind === 'dust' ? '196, 184, 170' : kind === 'vent' ? '190, 225, 255' : '205, 190, 185';
    ctx.save();
    ctx.translate(x, y);
    if (kind === 'dust' || kind === 'deck') ctx.scale(1, kind === 'dust' ? 0.42 : 0.55); // it rolls flat across the deck
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, `rgba(${c}, ${a})`);
    g.addColorStop(1, `rgba(${c}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.restore();
  }
}

function drawSparks() {
  if (!fx.sparks.length) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (const p of fx.sparks) {
    const k = p.life / p.max;
    const x = sx(p.x), y = sy(p.y);
    ctx.strokeStyle = p.water ? `rgba(215, 232, 255, ${0.9 * (1 - k * 0.6)})` : `rgba(255, ${Math.round(190 - 80 * k)}, 100, ${1 - k})`;
    ctx.lineWidth = p.water ? 2.2 : 1.6;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - p.vx * 0.035 * cam.s, y + p.vy * 0.035 * cam.s); ctx.stroke();
  }
  ctx.restore();
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
      const a = 0.13 * (1 - (p.life - p.max) / 2.5);
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
    ctx.globalAlpha = clamp(1 - (d.life - 2.5) / 2.5, 0, 1);
    ctx.fillStyle = d.life < 1.5 ? '#ffb070' : '#4a505b';
    ctx.fillRect((-d.w / 2) * cam.s, (-d.h / 2) * cam.s, d.w * cam.s, d.h * cam.s);
    ctx.globalAlpha = 1;
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
    step(sim, human(sim, 1 / 40, st), 1 / 40);
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
  const lit = s.engineOn && !s.done && !s.cut;
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
  const F = f.faults;
  $('bar-fuel').classList.toggle('leaking', Boolean(F && F.leak > 0 && s.t >= F.leakStart && s.fuel > 0 && !s.done));
  const alert = $('alert');
  if (s.cut && !s.done) { alert.textContent = 'Engine cut'; alert.classList.remove('hidden'); } else alert.classList.add('hidden');
  $('faults').style.visibility = app.running || app.ended ? 'visible' : 'hidden'; // the briefing card shows them before the start
  const cutChip = $('faults').querySelector('[data-k="dropouts"]');
  if (cutChip) cutChip.classList.toggle('live', s.cut);
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
  $('t-level').textContent = app.mode === 'game' && app.scenario ? `${levelCfg().label} · ${app.scenario.name}` : 'Simulator';

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
    b.addEventListener('click', () => { app.level = k; store.set('hs.level', k); renderWindOptions(); showIntro(true); });
    box.appendChild(b);
  }
  const lv = levelCfg();
  $('level-blurb').textContent = lv.blurb;
  const f = app.mode === 'game' && app.scenario ? scenarioFlight(app.level, app.scenario) : makeFlight(1, lv.opts);
  $('limits-text').textContent = `Land inside the green zone (±${+f.pad.halfWidth.toFixed(1)} m) at under ${f.limits.vy} m/s down, ${f.limits.vx} m/s sideways and ${Math.round(f.limits.tilt / DEG)}° of tilt. The dotted line shows where you're heading.`;
  renderBest();
}

function renderBest() {
  const best = store.get('hs.best', {});
  const cleared = store.get('hs.cleared', {});
  const parts = Object.entries(LEVELS).map(([k, lv]) => {
    const n = (BANK[k] || []).filter((sc) => cleared[sc.id]).length;
    return n || best[k] ? `${lv.label}: ${n} of ${(BANK[k] || []).length} scenarios cleared${best[k] ? `, best ${best[k]}` : ''}` : null;
  }).filter(Boolean);
  $('best').innerHTML = parts.join('<br>');
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
  renderWindOptions();
  $('wind-label').classList.toggle('hidden', mode === 'game');
  $('reroll').classList.toggle('hidden', mode !== 'game');
  showIntro(true);
}
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => setMode(t.dataset.tab));

// the wind shown for each seed is the one the current level really uses
function renderWindOptions() {
  const sel = $('seed');
  const keep = String(app.seed);
  sel.innerHTML = '';
  const opts = app.mode === 'game' ? levelCfg().opts : undefined;
  for (const seed of SEEDS) {
    const w = makeFlight(seed, opts).wind.steady;
    const o = document.createElement('option');
    o.value = seed;
    o.textContent = Math.abs(w) < 0.5 ? `${seed}: calm, gusts only` : `${seed}: ${Math.abs(w).toFixed(0)} m/s from the ${w > 0 ? 'left' : 'right'}`;
    sel.appendChild(o);
  }
  sel.value = keep;
}
$('seed').addEventListener('change', (e) => { app.seed = Number(e.target.value); if (app.mode === 'sim') start(); });
$('speed').addEventListener('change', (e) => { app.speed = Number(e.target.value); });

// ---------- boot ----------
resize();
renderLevels();
renderSliders();
setMode('game');
requestAnimationFrame((t) => { last = t; frame(t); });

// handle for tests and tinkering in the console
window.hoverslam = { app, fx, cam, BANK, showIntro };
