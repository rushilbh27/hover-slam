import { BOOSTER, G, DEG, clamp, SEEDS, REFERENCE_GAINS, DT, LEVELS, DEFAULT_GAINS, GAIN_RANGES, makeFlight, step, autopilot, windAt, mass, scoreFlight, evaluate, simulate } from './physics.js';
import { SETTINGS, SETTING, debrief, NUDGE } from './explain.js';
import { humanControl } from './controls.js';
import { BANK } from './bank.js';
import { nextScenario, bagProgress, scenarioFlight, faultLabels } from './scenario.js';
import { audio } from './audio.js';
import { icon } from './icons.js';
import { drawCallout, drawCrosshair, tangents, magnifierSpot, LOOK } from './ui.js';
import { initTooltips } from './tooltip.js';
import { sendFeedback } from './feedback.js';
import { LEVEL_COPY, descentDiagram, speedDiagram, levelThumb, keycaps, KEYS } from './menu.js';

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
  attract: false, // the start screen is open and an autopilot landing plays behind it
  view: 'welcome',
  attractIdx: 0,
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
const freshFx = () => ({ queue: [], pool: 0, poolX: 0, scorch: null, column: null, ripples: [], foam: [], standing: false, vent: [], plume: [], smoke: [], fire: [], debris: [], steam: [], dust: [], sparks: [], puffs: [], puffT: 0, flash: 0, shake: 0, ring: null, legs: 0, legsAt: 0, exploded: false, landedAt: 0, slow: 1, punch: 0, fin: 0, finCmd: 0, rcsCmd: 0, bolt: null, nextBolt: 3, bob: 0, scene: [], shoot: null, nextShoot: 4, sheet: null, nextSheet: 2.5, dol: null, nextDol: 5 });
const fx = freshFx();
const rain = [];
let poolAcc = 0; // fractional particles owed to the deck fire

// One look per level, so the difficulty is visible: a sunset, a dusk with a moon, a night storm.
const THEMES = {
  sunset: {
    sky: [[0, '#060b1d'], [0.45, '#121a3d'], [0.74, '#3b2350'], [0.9, '#a2464a'], [0.97, '#f0894f'], [1, '#ffc27a']],
    stars: 0.8, sun: true, moon: false, glow: '255, 196, 120', sea: ['#2a2140', '#16203a', '#070d1b'], cloud: '255, 176, 150', cloudMul: 1,
    swell: 1, glitter: '255, 190, 130', glx: 0.74, rain: false, bolts: false, whitecaps: false, ambient: 1, lights: 0.5,
    hull: ['#3c4658', '#151b27'], deck: ['#505b6c', '#6a7587'], rim: '255, 170, 110',
    birds: 7, haze: '255, 172, 112',
  },
  dusk: {
    sky: [[0, '#03050f'], [0.4, '#0a0f2e'], [0.72, '#221a49'], [0.9, '#55306a'], [0.97, '#9b476b'], [1, '#cf7468']],
    stars: 1.7, sun: false, moon: true, glow: '205, 110, 140', sea: ['#2a1d45', '#111838', '#050a17'], cloud: '200, 140, 190', cloudMul: 1.4,
    swell: 1.8, glitter: '210, 220, 255', glx: 0.64, rain: false, bolts: false, whitecaps: false, ambient: 0.72, lights: 1,
    hull: ['#343d4f', '#10151f'], deck: ['#444e5f', '#5a6578'], rim: '200, 150, 200',
    birds: 3, haze: '196, 108, 132',
  },
  storm: {
    sky: [[0, '#02050a'], [0.5, '#08111a'], [0.8, '#122030'], [1, '#243546']],
    stars: 0, sun: false, moon: false, glow: '120, 150, 190', sea: ['#1c2937', '#0c1621', '#03080f'], cloud: '120, 145, 180', cloudMul: 3.4,
    swell: 3.2, glitter: '150, 180, 220', glx: 0.5, rain: true, bolts: true, whitecaps: true, ambient: 0.4, lights: 1.7,
    hull: ['#232b37', '#0a0e14'], deck: ['#2c3440', '#3a4452'], rim: '150, 180, 230',
    birds: 0, haze: '58, 84, 110',
  },
};
function themeKey() {
  if (app.mode !== 'game' || app.attract) return 'sunset';
  return { easy: 'sunset', medium: 'dusk', hard: 'storm' }[app.level] || 'sunset';
}
function theme() { return THEMES[themeKey()]; }
const cam = { x: 0, y: 1000, s: 0.3, snap: true };
// Extra background life, shuffled so each flight shows a different pair and the sky never feels like a loop.
const SHARED = ['birds', 'lighthouse', 'shoot', 'kite', 'balloon', 'buoy', 'dolphins']; // Easy and Medium rotate through the same set
const SCENE_POOL = { easy: SHARED, medium: [...SHARED, 'plane', 'moonpath'], hard: ['sheet', 'scud', 'swell'] };
const SCENE_COUNT = { easy: 3, medium: 3, hard: 2 };
function pickScene() {
  if (app.mode !== 'game' || app.attract) return ['birds'];
  const pool = (SCENE_POOL[app.level] || []).filter((k) => k !== 'birds');
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const picked = pool.slice(0, SCENE_COUNT[app.level] || 2);
  return app.level === 'hard' ? picked : ['birds', ...picked]; // gulls are always there on Easy and Medium
}
const has = (k) => fx.scene.includes(k);
const scud = Array.from({ length: 9 }, (_, i) => ({ x: i / 9, y: 0.5 + ((i * 37) % 11) / 30, w: 0.09 + ((i * 13) % 7) / 60, v: 0.7 + ((i * 29) % 10) / 14 }));


// Gulls over the water, with a thin haze where the sea meets the sky.
const birds = [];
{
  let seed = 31;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 9; i++) birds.push({ x0: (rnd() - 0.5) * 3000, y: 45 + rnd() * 300, v: (rnd() < 0.7 ? 1 : -1) * (5 + rnd() * 7), flap: 2.6 + rnd() * 2.2, ph: rnd() * 6.28, size: 0.8 + rnd() * 0.6, glide: rnd() * 6.28 });
}

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
  if (app.attract) {
    // the backdrop landing is fast-forwarded to the middle of the burn, so the engine is already lit
    // and the legs are about to open the moment the screen is revealed
    app.flight = makeFlight(SEEDS[app.attractIdx % SEEDS.length], undefined);
    const f = app.flight;
    for (let n = 0; n < 120 * 60 && f.state.y > 190 && !f.state.done; n++) step(f, autopilot(f, REFERENCE_GAINS), DT);
    fx.legs = 0;
  }
  else if (app.mode === 'game') {
    if (!app.scenario) pickScenario();
    app.flight = scenarioFlight(app.level, app.scenario);
  } else app.flight = makeFlight(app.seed, undefined);
  app.input.engine = false;
  app.input.throttle = 0.8;
  app.trail = [];
  app.steer = { want: 0, vHold: 0 };
  app.ended = false;
  app.acc = 0;
  audio.reset(); // cut off the last flight's one-off sounds
  clearTimeout(app.cardTimer); // a result card from the flight you just left must not appear over this one
  clearTimeout(app.labTimer);
  Object.assign(fx, freshFx());
  fx.scene = pickScene();
  cam.snap = true;
  $('outcome').classList.add('hidden');
  $('caption').classList.add('hidden');
  $('cue').classList.add('hidden');
  renderFaultChips();
}

function start() {
  newFlight();
  app.running = true;
  $('intro').classList.add('hidden');
  if (app.mode === 'sim') { app.report = debrief(app.gains, app.seed); setDrawer(false); } // watch the flight with the whole scene
  coachStart();
}

// A new scenario from the shuffle bag: every one in the level is played before any repeats.
function pickScenario() {
  app.scenario = nextScenario(app.level, BANK, store);
}

const FAULT_TIPS = {
  leak: 'Propellant is draining from the tank. Light later and brake harder so the burn is short.',
  thrustCap: 'The engine cannot give full thrust, so it brakes more slowly. Light it earlier.',
  dropouts: 'The engine stops for a moment, more than once. Keep some height in hand.',
  weakSide: 'The booster turns slowly toward one side. Start leaning early, and plan to steer the other way.',
};
function renderFaultChips() {
  const labels = app.mode === 'game' && app.scenario ? faultLabels(app.scenario.faults) : [];
  $('faults').innerHTML = labels.map((l) => `<span class="fault ${l.tone}" data-k="${l.key}" data-tip="${l.short}" data-tip-detail="${FAULT_TIPS[l.key]}" data-tip-pos="bottom">${l.text}</span>`).join('');
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
  if (app.attract) return autopilot(f, REFERENCE_GAINS);
  return app.mode === 'sim' ? autopilot(f, app.gains) : human(f, DT, app.steer);
}

const keys = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', KeyA: 'left', KeyD: 'right', KeyW: 'up', KeyS: 'down' };
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (app.attract) {
    // on the start screen only Space or Enter (with nothing focused) moves on from the welcome
    if ((e.code === 'Space' || e.code === 'Enter') && e.target === document.body && app.view === 'welcome') { e.preventDefault(); setView('levels'); }
    else if (e.code === 'Escape' && app.view !== 'welcome') setView('welcome');
    return;
  }
  if (e.code === 'Escape') { e.preventDefault(); setDrawer(!app.menuOpen); return; }
  if (app.menuOpen) return; // the game is paused: the keys belong to the drawer
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
  if (f && app.running && !app.hold && !app.menuOpen && !f.state.done) {
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
  if (!app.menuOpen) updateFx(dt * (app.speed > 1 ? 1.5 : 1) * fx.slow); // the picture holds still while the drawer is open
  render(dt);
  hud();
  placeFocus();
  if (app.flight) audio.tick(dt, audioState());
  requestAnimationFrame(frame);
}

// what the sound engine needs to know, every frame
function audioState() {
  const f = app.flight, s = f.state;
  return {
    menu: app.attract, running: app.running && !app.menuOpen, done: s.done,
    lit: s.engineOn && !s.cut && !s.done && s.fuel > 0 && !app.menuOpen, throttle: s.throttle,
    fall: -s.vy, alt: Math.max(0, s.y - BOOSTER.legHeight), wind: Math.abs(windAt(f.wind, s.t, s.y)),
    theme: themeKey(), scene: fx.scene,
  };
}

// ---------- outcome ----------
function onEnd() {
  app.ended = true;
  const f = app.flight;
  const o = f.state.outcome;
  const s = f.state;
  const c = o.checks || {};
  const soft = c.vertical && c.horizontal && c.upright && c.steady;
  if (app.attract) {
    // behind the start screen: let the landing play out, then fly the next wind
    if (o.landed) { fx.landedAt = performance.now(); fx.ring = { r: 0, a: 1 }; touchdown(s, 'Landed'); }
    app.cardTimer = setTimeout(() => { if (app.attract) { app.attractIdx++; newFlight(); app.running = true; } }, 4200);
    return;
  }
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
    waterImpact(s, 0.3, false); // a gentle touch in the water: it tips over and sinks
  } else if (o.reason !== 'Flew away' && o.reason !== 'Timed out') {
    crash(s);
  }
  app.cardTimer = setTimeout(() => showOutcome(o), o.landed || fx.standing ? 1500 : fx.exploded ? 2300 : 1300); // a crash gets time to play out
  if (app.mode === 'sim') { renderReport(); app.labTimer = setTimeout(() => { if (app.ended && app.mode === 'sim') setDrawer(true); }, 2000); } // the report slides back in
  if (COACH.on) store.set('hs.coachDone', 1); // the lesson is for the first game only, however it ended
  COACH.on = false;
  $('coach').classList.add('hidden');
  if (app.mode === 'game' && o.landed) {
    const sc = scoreFlight(o);
    const best = store.get('hs.best', {});
    if (!best[app.level] || sc > best[app.level]) { best[app.level] = sc; store.set('hs.best', best); }
    const cleared = store.get('hs.cleared', {});
    if (app.scenario && (!cleared[app.scenario.id] || sc > cleared[app.scenario.id])) { cleared[app.scenario.id] = sc; store.set('hs.cleared', cleared); }
  }
}

// A landing that feels like one: dust rolls across the deck, sparks scatter, the camera punches in
// and holds a beat in slow motion, and the word lands with it.
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
  if (app.attract) return; // no captions or sounds behind the menu
  audio.touchdown(tone === 'warn' ? 'rough' : 'soft');
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
  if (app.mode === 'sim') return; // the lab's report says it all
  $('o-title').textContent = o.landed ? 'Landed' : o.reason;
  $('o-title').className = 'o-title ' + (o.landed ? 'good' : 'bad');
  const c = o.checks || {};
  let sub = '';
  if (o.landed) sub = `Score ${scoreFlight(o)} out of 100.`;
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
  rateReset(o);
  $('outcome').classList.remove('hidden');
}

// ---------- optional feedback after a landing ----------
// Stars, then a note if the player wants to leave one. It is never required, never repeats within a run, and the keys stay free for the game.
const RATE = { n: 0, sent: false, ctx: null };
const RATE_WORDS = ['', 'Poor', 'Fair', 'Good', 'Great', 'Excellent'];
function ratePaint(n) {
  for (const b of $('rate-stars').querySelectorAll('.star')) {
    const on = Number(b.dataset.n) <= n;
    b.classList.toggle('on', on); // the filled and the outline icon are both in the button; CSS shows one, so the element under the pointer never changes
    b.setAttribute('aria-checked', String(Number(b.dataset.n) === RATE.n));
  }
}
function rateReset(o) {
  const show = app.mode === 'game' && Boolean(o.landed);
  $('rate').classList.toggle('hidden', !show);
  Object.assign(RATE, { n: 0, sent: false, ctx: show ? { level: app.level, scenarioId: app.scenario && app.scenario.id, outcome: 'Landed', score: scoreFlight(o) } : null });
  $('rate-stars').innerHTML = [1, 2, 3, 4, 5].map((n) => `<button class="star" role="radio" aria-checked="false" aria-label="${n} out of 5, ${RATE_WORDS[n]}" data-n="${n}" data-tip="${RATE_WORDS[n]}" data-tip-pos="top"><span class="s-out">${icon('star', 22)}</span><span class="s-fill">${icon('star-fill', 22)}</span></button>`).join('');
  ratePaint(0);
  $('rate-more').classList.add('hidden');
  $('rate-text').value = '';
  $('rate-send').disabled = false;
  $('rate-q').textContent = 'How was that run? Optional.';
  $('rate-note').classList.remove('hidden');
}
$('rate-stars').addEventListener('click', (e) => {
  const b = e.target.closest('.star');
  if (!b || RATE.sent) return;
  RATE.n = Number(b.dataset.n);
  ratePaint(RATE.n);
  $('rate-more').classList.remove('hidden');
});
$('rate-stars').addEventListener('pointerover', (e) => { const b = e.target.closest('.star'); if (b && !RATE.sent) ratePaint(Number(b.dataset.n)); });
$('rate-stars').addEventListener('pointerleave', () => { if (!RATE.sent) ratePaint(RATE.n); });
$('rate-send').addEventListener('click', async () => {
  if (RATE.sent || !RATE.ctx) return;
  RATE.sent = true;
  $('rate-send').disabled = true;
  const ok = await sendFeedback({ ...RATE.ctx, rating: RATE.n || null, comment: $('rate-text').value });
  $('rate-q').textContent = ok ? 'Thanks, that helps.' : 'Thanks. It will send when you are back online.';
  $('rate-more').classList.add('hidden');
  $('rate-note').classList.add('hidden');
});

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
$('start').addEventListener('click', () => start());
$('restart').addEventListener('click', () => { setDrawer(false); if (app.mode === 'game') start(); else showIntro(); });

// ---------- effects ----------

// ---------- crashes ----------
// A hard crash is not one thing. On the barge it is a fireball and a column of black smoke, with burning wreckage thrown across a
// hard deck and fires that keep going. In the sea there is no fire: a column of water, spray, foam, rings spreading over the
// surface, and wreckage that goes under. How big either one is follows how hard it hit.
const DECK_HALF = 32; // the barge, in metres either side of the pad centre
const rnd = (a, b) => a + Math.random() * (b - a);
const calmMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function crash(s) {
  const k = clamp(Math.hypot(s.vx, s.vy) / 55, 0.35, 1.5); // a 6 m/s thump is not a 150 m/s impact
  if (Math.abs(s.x) <= DECK_HALF) deckCrash(s, k);
  else waterImpact(s, k, true);
}

function deckCrash(s, k) {
  fx.exploded = true;
  audio.crash(Math.abs(s.vy));
  const calm = calmMotion();
  fx.flash = calm ? 0.2 : Math.min(1, 0.5 + 0.4 * k);
  fx.shake = calm ? 0.3 : Math.min(1, 0.55 + 0.45 * k);
  fx.slow = calm ? 1 : 0.35; // a beat of slow motion, then it eases back
  fx.punch = calm ? 0 : 0.8;
  const y = Math.max(0, s.y), n = (a) => Math.max(4, Math.round(a * k));
  // the first burst: hot gas thrown out hard and low along the deck
  for (let i = 0; i < n(60); i++) {
    const dir = i % 2 ? 1 : -1;
    fx.fire.push({ x: s.x + rnd(-3, 3), y: rnd(0.3, 3), vx: dir * rnd(8, 52) * (0.6 + 0.4 * k), vy: rnd(1, 12), life: 0, max: rnd(0.5, 1.3), r: rnd(3, 8) });
  }
  // the fireball: a ball of fire that boils upward, hot and bright at first, then orange, then dark red
  for (let i = 0; i < n(64); i++) {
    const a = rnd(0.12, 0.88) * Math.PI, v = rnd(5, 8 + 26 * k);
    fx.fire.push({ x: s.x + rnd(-4, 4), y: y * Math.random() + rnd(1, 5), vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.9 + 8, life: 0, max: rnd(0.9, 2.3), r: rnd(4, 5 + 7 * k), rise: 10 });
  }
  // black smoke that climbs in a column and takes a long time to thin out
  for (let i = 0; i < n(34); i++) {
    fx.fire.push({ smoke: true, x: s.x + rnd(-5, 5), y: rnd(1, 8), vx: rnd(-7, 7), vy: rnd(4, 14), life: 0, max: rnd(0.3, 0.9), tail: rnd(3.5, 6.5), r: rnd(4, 7), rise: 15 });
  }
  // the propellant goes up a moment later: a second, bigger bloom, higher
  fx.queue.push({ in: 0.28, f: () => {
    fx.flash = Math.max(fx.flash, calm ? 0.15 : 0.5 * Math.min(1, k));
    fx.shake = Math.max(fx.shake, calm ? 0.25 : 0.75);
    for (let i = 0; i < n(46); i++) {
      const a = rnd(0.1, 0.9) * Math.PI, v = rnd(6, 10 + 24 * k);
      fx.fire.push({ x: s.x + rnd(-6, 6), y: rnd(4, 12), vx: Math.cos(a) * v * (Math.random() < 0.5 ? -1 : 1) * 0.8, vy: Math.sin(a) * v + 8, life: 0, max: rnd(0.9, 2.0), r: rnd(6, 7 + 9 * k), rise: 12 });
    }
    audio.thump();
  } });
  // wreckage: chunks that tumble out, burning and trailing smoke for a moment, and bounce on the deck
  for (let i = 0; i < n(22); i++) {
    const big = i < 4;
    fx.debris.push({ hot: true, x: s.x + rnd(-2, 2), y: y + rnd(0, 30), vx: rnd(-30, 30) * (0.5 + 0.5 * k) * (big ? 0.5 : 1), vy: rnd(10, 18 + 32 * k), a: rnd(0, 6), va: rnd(-10, 10), w: big ? rnd(3, 5) : rnd(0.8, 2.6), h: big ? rnd(1, 2) : rnd(0.5, 1.6), life: 0 });
  }
  // sparks shower and bounce, dust rolls out, a shock ring runs along the deck, and it all leaves a scorch and a fire that keeps burning
  for (let i = 0; i < n(44); i++) {
    const dir = i % 2 ? 1 : -1;
    fx.sparks.push({ x: s.x + rnd(-3, 3), y: rnd(0.5, 3), vx: dir * rnd(4, 34), vy: rnd(8, 30), life: 0, max: rnd(0.6, 1.5) });
  }
  for (let i = 0; i < 26; i++) {
    const dir = i % 2 ? 1 : -1;
    fx.dust.push({ x: s.x + rnd(-3, 3), y: rnd(0.4, 1.4), vx: dir * rnd(8, 44), vy: rnd(0.3, 2), life: 0, max: rnd(1, 2), r: rnd(1.6, 3.4) });
  }
  fx.ring = { r: 0, a: 1, bad: true };
  fx.scorch = { x: s.x, r: 5 + 7 * k, t: 0 };
  fx.pool = 3 + 2.5 * k;
  fx.poolX = s.x;
}

// Into the sea: from a gentle touch (it tips over and goes under) to a high-speed hit (a tall column of water).
function waterImpact(s, k, big) {
  fx.exploded = true; // it goes under
  const calm = calmMotion();
  audio.splash(big);
  fx.shake = calm ? 0.2 : big ? Math.min(0.9, 0.35 + 0.4 * k) : 0.3;
  if (big && !calm) { fx.slow = 0.4; fx.punch = 0.6; }
  const n = (a) => Math.max(6, Math.round(a * k));
  fx.column = { x: s.x, t: 0, k };
  // spray: a crown of droplets thrown up and out, tallest in the middle
  for (let i = 0; i < n(big ? 110 : 150); i++) {
    const d = rnd(-1, 1), up = (1 - Math.abs(d) * 0.55) * rnd(14, 38 + 40 * k);
    fx.sparks.push({ x: s.x + d * rnd(0.5, 3), y: 0.2, vx: d * rnd(5, 18 + 10 * k), vy: up, life: 0, max: rnd(1.1, 2.4), water: true });
  }
  // mist hanging over it
  for (let i = 0; i < n(12); i++) fx.steam.push({ x: s.x + rnd(-3, 3), y: rnd(0.8, 3 + 12 * k), vx: rnd(-4, 4), vy: rnd(2, 8), life: 0, max: rnd(1.6, 3), r: rnd(1.6, 3 + 3 * k) });
  // foam that stays on the surface after it, and rings that spread out and fade
  for (let i = 0; i < n(big ? 12 : 6); i++) fx.foam.push({ x: s.x + rnd(-1, 1) * (3 + 7 * k), r: rnd(2, 4 + 5 * k), life: 0, max: rnd(2.8, 5) });
  fx.ring = { r: 0, a: 1, bad: true };
  fx.ripples = [0.18, 0.5, 0.9].map((d, i) => ({ x: s.x, r: 0, a: 0.55 - i * 0.1, wait: d, speed: 20 + 10 * k - i * 3 }));
  if (!big) return;
  // wreckage that splashes down around it and sinks, and the steam where hot metal meets water
  for (let i = 0; i < n(12); i++) {
    fx.debris.push({ x: s.x + rnd(-2, 2), y: rnd(0, 18), vx: rnd(-22, 22) * (0.5 + 0.5 * k), vy: rnd(10, 16 + 26 * k), a: rnd(0, 6), va: rnd(-9, 9), w: rnd(0.8, 3), h: rnd(0.5, 1.6), life: 0 });
  }
  for (let i = 0; i < 9; i++) fx.steam.push({ x: s.x + rnd(-4, 4), y: rnd(0.6, 4), vx: rnd(-5, 5), vy: rnd(3, 9), life: 0, max: rnd(2, 3.4), r: rnd(2, 5) });
}

function updateFx(dt) {
  const f = app.flight;
  if (!f) return;
  const s = f.state;
  const B = BOOSTER;
  fx.flash = Math.max(0, fx.flash - dt * 2.2);
  fx.shake = Math.max(0, fx.shake - dt * 1.6);
  const legs0 = fx.legs;
  fx.legs = clamp(fx.legs + (s.y < 320 || s.done ? dt / 2.2 : 0), 0, 1);
  if (legs0 === 0 && fx.legs > 0 && !app.attract) audio.legs();
  if (legs0 < 1 && fx.legs >= 1) fx.legsAt = performance.now();
  fx.punch = Math.max(0, fx.punch - dt * 1.4);
  fx.fin += (fx.finCmd - fx.fin) * Math.min(1, dt * 9);

  // cold-gas thrusters near the top fire while a lean key is held, steadily, on the side opposite the turn.
  // They follow the keys, not the control loop's small corrections, so what you see is what you pressed.
  const lean = app.mode === 'game' && !app.attract && app.running ? (app.input.right ? 1 : 0) - (app.input.left ? 1 : 0) : 0;
  if (!s.done && lean) {
    const F2 = f.faults, weak = F2 && F2.weakSide && (F2.weakSide === 'left') === (lean < 0) ? F2.weakFactor : 1; // a weak side puffs weakly
    for (fx.puffT -= dt; fx.puffT <= 0; fx.puffT += 0.045) fx.puffs.push({ side: -lean, life: 0, max: 0.3, v: 0.6 + 0.6 * weak, oy: (Math.random() - 0.5) * 0.9 });
  } else fx.puffT = 0;
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
  const tt = performance.now() / 1000;
  fx.bob = has('swell')
    ? (Math.sin(tt * 0.55) * 0.75 + Math.sin(tt * 1.1 + 1.3) * 0.25) * Math.min(0.5 * cam.s * th.swell, 2.8)
    : Math.sin(tt * 0.9) * Math.min(0.22 * cam.s * th.swell, 1.6);
  // a shooting star every so often, and sheet lightning that lights the clouds from inside
  if (has('shoot') && !s.done) {
    if (fx.shoot) { fx.shoot.t += dt; if (fx.shoot.t > fx.shoot.life) fx.shoot = null; }
    else { fx.nextShoot -= dt; if (fx.nextShoot <= 0) { const d = Math.random() < 0.5 ? 1 : -1; fx.shoot = { t: 0, life: 0.9 + Math.random() * 0.5, x: 0.15 + Math.random() * 0.7, y: 0.05 + Math.random() * 0.3, d, len: 0.12 + Math.random() * 0.1, slope: 0.25 + Math.random() * 0.3 }; fx.nextShoot = 7 + Math.random() * 7; } }
  } else fx.shoot = null;
  if (has('sheet') && !s.done) {
    if (fx.sheet) { fx.sheet.t += dt; if (fx.sheet.t > 0.9) fx.sheet = null; }
    else { fx.nextSheet -= dt; if (fx.nextSheet <= 0) { fx.sheet = { t: 0, x: 0.1 + Math.random() * 0.8, y: 0.15 + Math.random() * 0.35 }; fx.nextSheet = 2.5 + Math.random() * 4.5; } }
  } else fx.sheet = null;
  if (has('dolphins') && !s.done) {
    if (fx.dol) { fx.dol.t += dt; if (fx.dol.t > 0.9 + fx.dol.n * 0.45) fx.dol = null; }
    else { fx.nextDol -= dt; if (fx.nextDol <= 0) { fx.dol = { t: 0, x: 0.1 + Math.random() * 0.75, d: Math.random() < 0.5 ? 1 : -1, n: 2 + Math.floor(Math.random() * 2) }; fx.nextDol = 14 + Math.random() * 10; } }
  } else fx.dol = null;

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

  for (const p of fx.steam) { p.x += p.vx * dt; p.y += p.vy * dt; p.life += dt; p.r += dt * 3; }
  fx.steam = fx.steam.filter((p) => p.life < p.max);

  for (const p of fx.fire) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - dt * 1.5; p.vy = p.vy * (1 - dt * 1.5) + dt * (p.rise || 6); if (p.y < 0) { p.y = 0; p.vy = Math.abs(p.vy) * 0.3; } p.life += dt; p.r += dt * (p.life < p.max ? 9 : 1.5); }
  fx.fire = fx.fire.filter((p) => p.life < p.max + (p.tail || (p.smoke ? 2.5 : 0))).slice(-420);
  for (const d of fx.debris) {
    d.x += d.vx * dt; d.y += d.vy * dt; d.vy -= G * dt; d.a += d.va * dt; d.life += dt;
    if (d.hot && d.life > 0.3 && d.life < 1.5 && Math.random() < dt * 9) fx.fire.push({ smoke: true, x: d.x, y: d.y, vx: 0, vy: 1, life: 0, max: 0.12, tail: 1.5, r: rnd(0.8, 1.6), rise: 5 }); // burning wreckage trails smoke
    if (d.y < 0.5 && Math.abs(d.x) < 34) { d.y = 0.5; d.vy = -d.vy * 0.3; d.vx *= 0.6; d.va *= 0.5; }
    else if (d.y < 0) { // splashes into the sea
      d.dead = true;
      fx.steam.push({ x: d.x, y: 0.4, vx: (Math.random() - 0.5) * 6, vy: 3 + Math.random() * 4, life: 0, max: 1.2, r: 1.5 });
      for (let i = 0; i < 5; i++) fx.sparks.push({ x: d.x, y: 0.2, vx: rnd(-5, 5), vy: rnd(6, 16), life: 0, max: rnd(0.6, 1.1), water: true });
      fx.foam.push({ x: d.x, r: rnd(1, 2.4), life: 0, max: rnd(1.6, 2.6) });
    }
  }
  fx.debris = fx.debris.filter((d) => !d.dead && d.life < 9);
  // things set up to happen a moment after the crash, and the fire that keeps burning on the deck
  for (const q of fx.queue) { q.in -= dt; if (q.in <= 0) q.f(); }
  fx.queue = fx.queue.filter((q) => q.in > 0);
  if (fx.pool > 0) {
    fx.pool -= dt;
    poolAcc += dt * 110;
    for (; poolAcc >= 1; poolAcc--) fx.fire.push({ x: fx.poolX + rnd(-9, 9), y: rnd(0.3, 1.5), vx: rnd(-3, 3), vy: rnd(3, 9), life: 0, max: rnd(0.4, 0.95), r: rnd(1.3, 2.8), rise: 16 });
    if (Math.random() < dt * 22) fx.fire.push({ smoke: true, x: fx.poolX + rnd(-8, 8), y: rnd(1, 3), vx: rnd(-2, 2), vy: rnd(4, 9), life: 0, max: 0.2, tail: rnd(2, 3.4), r: rnd(1.8, 3), rise: 12 });
  }
  if (fx.scorch) fx.scorch.t += dt;
  // the water: a column that rises and falls back, rings that spread, foam that lingers
  if (fx.column) { fx.column.t += dt; if (fx.column.t > 2.4) fx.column = null; }
  for (const r of fx.ripples) { if (r.wait > 0) r.wait -= dt; else { r.r += r.speed * dt; r.a -= dt * 0.22; } }
  fx.ripples = fx.ripples.filter((r) => r.a > 0);
  for (const p of fx.foam) { p.life += dt; p.r += dt * 0.9; }
  fx.foam = fx.foam.filter((p) => p.life < p.max);
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
  const shift = touchUI && W < 500 ? (0.17 * W) / ts : app.attract && W > 800 ? (0.2 * W) / ts : 0; // on the start screen the action sits right of the title
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
  drawHorizonLife(th);
  drawExtras(th);
  drawBarge(f, th);
  app.pred = null;
  if (!app.attract && app.running && !s.done) drawTrail();
  if (app.mode === 'game' && app.running && !s.done) drawPrediction(f);
  drawScorch();
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
  drawFoam();
  drawColumn();
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
  drawScenePins(f);
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
    for (let x = 0; x <= W; x += 16) ctx.lineTo(x, y + Math.sin(x * 0.02 + t * (0.6 + j * 0.1) + j) * (1 + j * 0.4) * th.swell * (has('swell') ? 1.7 : 1));
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


// ---------- shuffled extras: medium (shooting star, plane, moon path, lighthouse) and hard (sheet lightning, scud, swell) ----------
function drawExtras(th) {
  const hy = sy(0);
  if (!fx.scene.length || hy < 30 || hy > H + 4) return;
  const t = performance.now() / 1000;
  if (has('shoot') && fx.shoot) {
    const s = fx.shoot, p = s.t / s.life;
    const x = W * (s.x + s.d * p * s.len * 2.2), y = hy * (s.y + p * s.len * s.slope * 2.2);
    const tail = W * s.len * 0.8 * Math.sin(Math.PI * Math.min(1, p * 1.1));
    const a = Math.sin(Math.PI * Math.min(1, p)) ;
    const g = ctx.createLinearGradient(x, y, x - s.d * tail, y - tail * s.slope);
    g.addColorStop(0, `rgba(255, 244, 230, ${0.9 * a})`); g.addColorStop(1, 'rgba(255, 244, 230, 0)');
    ctx.strokeStyle = g; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - s.d * tail, y - tail * s.slope); ctx.stroke();
  }
  if (has('plane')) {
    const dur = 80, ph = ((t / dur) % 1 + 1) % 1;
    const x = W * (-0.05 + ph * 1.1), y = hy * 0.16 + Math.sin(ph * 6.28) * 3;
    const blinkR = Math.sin(t * 2.4) > 0.55, strobe = (t * 1.1) % 1 < 0.08;
    ctx.fillStyle = 'rgba(8, 6, 20, 0.7)'; ctx.fillRect(x - 3, y - 0.5, 6, 1.2);
    for (const [dx, col, on, r] of [[-3.2, '255, 70, 60', blinkR, 4], [3.2, '70, 255, 150', true, 3], [0, '255, 255, 255', strobe, 5]]) {
      if (!on) continue;
      const g = ctx.createRadialGradient(x + dx, y, 0, x + dx, y, r);
      g.addColorStop(0, `rgba(${col}, 0.95)`); g.addColorStop(1, `rgba(${col}, 0)`);
      ctx.fillStyle = g; ctx.fillRect(x + dx - r, y - r, r * 2, r * 2);
    }
  }

  if (has('kite')) {
    const dur = 140, ph = ((t / dur + 0.31) % 1 + 1) % 1;
    const x = W * (-0.04 + ph * 1.08), y = hy * (0.42 + 0.05 * Math.sin(t * 0.35)), sw = Math.sin(t * 1.3) * 0.25;
    const lit = clamp(th.ambient, 0.5, 1);
    ctx.save(); ctx.translate(x, y); ctx.rotate(sw);
    ctx.fillStyle = `rgba(255, ${Math.round(150 * lit)}, ${Math.round(70 * lit)}, 0.95)`;
    ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(5, 0); ctx.lineTo(0, 7); ctx.lineTo(-5, 0); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255, 244, 220, 0.8)'; ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(5, 0); ctx.lineTo(0, 0); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = `rgba(255, 220, 190, 0.7)`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, 7);
    for (let k = 1; k <= 7; k++) ctx.lineTo(Math.sin(t * 2.2 - k * 0.9) * 3.2, 7 + k * 3.4);
    ctx.stroke(); ctx.restore();
  }
  if (has('balloon')) {
    const dur = 110, ph = ((t / dur + 0.12) % 1 + 1) % 1;
    const sunX = W * th.glx - cam.x * 0.02;
    const x = sunX + 70 + Math.sin(ph * 5) * 14 + ph * 40, y = hy - 6 - ph * hy * 0.5, r = clamp(H * 0.011, 5, 11);
    const fade = smooth(0, 0.08, ph) * (1 - smooth(0.9, 1, ph));
    ctx.globalAlpha = fade;
    const cols = ['#e2553d', '#f4d28a'];
    for (let k = 0; k < 4; k++) { ctx.fillStyle = cols[k % 2]; ctx.beginPath(); ctx.ellipse(x + (k - 1.5) * r * 0.45, y, r * 0.5, r * 1.05, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = 'rgba(40, 24, 24, 0.9)'; ctx.fillRect(x - r * 0.25, y + r * 1.5, r * 0.5, r * 0.45);
    ctx.strokeStyle = 'rgba(40, 24, 24, 0.6)'; ctx.lineWidth = 0.7; ctx.beginPath(); ctx.moveTo(x - r * 0.7, y + r * 0.9); ctx.lineTo(x - r * 0.25, y + r * 1.5); ctx.moveTo(x + r * 0.7, y + r * 0.9); ctx.lineTo(x + r * 0.25, y + r * 1.5); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (has('dolphins') && fx.dol) {
    const dl = fx.dol, d = dl.d;
    for (let k = 0; k < dl.n; k++) {
      const p = (dl.t - k * 0.45) / 0.9;
      if (p < 0 || p > 1) continue;
      const bx = W * dl.x + d * (k * 26 + p * 46), ground = hy + 5 + k * 2;
      const arc = Math.sin(Math.PI * p), by = ground - arc * 15;
      const ang = Math.atan2(-Math.cos(Math.PI * p) * 15 * Math.PI / 0.9 * 0.02, d * 46 / 0.9 * 0.02);
      ctx.save(); ctx.translate(bx, by); ctx.rotate(d > 0 ? -ang * 0.8 : ang * 0.8 + Math.PI * 0 ); if (d < 0) ctx.scale(-1, 1);
      ctx.fillStyle = th.moon ? '#141a2e' : '#1d1830';
      ctx.beginPath(); ctx.ellipse(0, 0, 6.5, 2.1, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(5, -0.5); ctx.lineTo(9, -2.5); ctx.lineTo(8.2, 0.4); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-1, -1.6); ctx.lineTo(-2.4, -4); ctx.lineTo(1, -1.7); ctx.closePath(); ctx.fill();
      ctx.restore();
      if (p < 0.12 || p > 0.88) { ctx.fillStyle = 'rgba(235, 242, 255, 0.5)'; ctx.fillRect(bx - 5, ground, 10, 1.4); }
    }
  }
  if (has('buoy')) {
    const sc = cam.s, d = clamp(6 * sc, 5, 30), bx = sx(-47), by = sy(0) + fx.bob * 1.4 + d * 0.5 + 3;
    const w = Math.max(4, 1.1 * sc), h = Math.max(7, 2.2 * sc);
    ctx.fillStyle = 'rgba(180, 200, 235, 0.25)'; ctx.fillRect(bx - w * 1.4, by + 1, w * 2.8, 1.2);
    ctx.fillStyle = '#d6432e'; ctx.fillRect(bx - w / 2, by - h * 0.5, w, h * 0.5);
    ctx.fillStyle = '#e9edf2'; ctx.fillRect(bx - w / 2, by - h * 0.9, w, h * 0.4);
    ctx.fillStyle = '#2a303c'; ctx.fillRect(bx - 0.6, by - h * 1.25, 1.2, h * 0.35);
    const on = Math.sin(t * 3.1) > 0, r = Math.max(5, 1.6 * sc) * (on ? 1.5 : 0.8);
    const g = ctx.createRadialGradient(bx, by - h * 1.3, 0, bx, by - h * 1.3, r);
    g.addColorStop(0, on ? 'rgba(255, 240, 160, 0.95)' : 'rgba(255, 240, 160, 0.3)'); g.addColorStop(1, 'rgba(255, 240, 160, 0)');
    ctx.fillStyle = g; ctx.fillRect(bx - r, by - h * 1.3 - r, r * 2, r * 2);
  }
  if (has('moonpath') && th.moon) {
    const mx = W * 0.64 - cam.x * 0.02;
    ctx.fillStyle = 'rgba(214, 226, 255, 1)';
    for (let i = 0; i < 46; i++) {
      const d = i / 46, y = hy + 3 + d * d * (H - hy) * 0.9;
      const swell = Math.sin(i * 1.7 + t * (0.9 + d)) * 0.5 + 0.5;
      const w = (6 + d * W * 0.09) * (0.35 + 0.65 * swell);
      const x = mx + Math.sin(i * 3.3 + t * 0.7) * (4 + d * 26);
      ctx.globalAlpha = (0.12 + 0.34 * swell) * (1 - d * 0.7);
      ctx.fillRect(x - w / 2, y, w, 1 + d * 1.8);
    }
    ctx.globalAlpha = 1;
  }
  if (has('lighthouse')) {
    const lx = W * 0.18 - cam.x * 0.02 * cam.s, u = clamp(H * 0.006, 3, 7);
    ctx.fillStyle = '#0a0d1a'; // the rock and the tower
    ctx.beginPath(); ctx.ellipse(lx, hy + 0.5, u * 3, u * 0.7, 0, Math.PI, 0); ctx.fill();
    ctx.beginPath(); ctx.moveTo(lx - u * 0.7, hy); ctx.lineTo(lx - u * 0.4, hy - u * 4.2); ctx.lineTo(lx + u * 0.4, hy - u * 4.2); ctx.lineTo(lx + u * 0.7, hy); ctx.closePath(); ctx.fill();
    const ly = hy - u * 4.6, rot = t * 0.7, c = Math.cos(rot), side = Math.sin(rot) >= 0 ? 1 : -1;
    const power = c * c * c * c; // bright only when the lamp faces us or turns its beam along the horizon
    const glow = ctx.createRadialGradient(lx, ly, 0, lx, ly, u * 9);
    glow.addColorStop(0, `rgba(255, 238, 190, ${0.35 + 0.55 * power})`); glow.addColorStop(1, 'rgba(255, 238, 190, 0)');
    ctx.fillStyle = glow; ctx.fillRect(lx - u * 9, ly - u * 9, u * 18, u * 18);
    const len = W * 0.55 * (1 - c * c) ** 0.5 * 0.9;
    if (len > 8) {
      const bg = ctx.createLinearGradient(lx, 0, lx + side * len, 0);
      bg.addColorStop(0, 'rgba(255, 238, 190, 0.30)'); bg.addColorStop(1, 'rgba(255, 238, 190, 0)');
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + side * len, ly - u * 1.8); ctx.lineTo(lx + side * len, ly + u * 2.4); ctx.closePath(); ctx.fill();
    }
  }
  if (has('scud')) {
    const f = app.flight, wind = f ? f.wind.steady : 2, dir = wind >= 0 ? 1 : -1, sp = (0.012 + Math.min(Math.abs(wind), 12) * 0.0035) * dir;
    for (const c of scud) {
      const px = (((c.x + t * sp * c.v) % 1.3) + 1.3) % 1.3 - 0.15;
      const cx = W * px, cy = hy * c.y, w = W * c.w;
      for (let k = 0; k < 4; k++) {
        const ox = (k - 1.5) * w * 0.55, oy = Math.sin(k * 2.1 + c.x * 9) * hy * 0.012;
        const g = ctx.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, w * 0.7);
        g.addColorStop(0, 'rgba(6, 10, 16, 0.42)'); g.addColorStop(1, 'rgba(6, 10, 16, 0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(cx + ox, cy + oy, w * 0.7, w * 0.17, 0, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  if (has('sheet') && fx.sheet) {
    const k = fx.sheet.t, a = k < 0.07 ? 1 : k < 0.14 ? 0.25 : k < 0.24 ? 0.85 : Math.max(0, 1 - (k - 0.24) / 0.6) * 0.4;
    const gx = W * fx.sheet.x, gy = hy * fx.sheet.y, r = W * 0.5;
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
    g.addColorStop(0, `rgba(215, 228, 255, ${0.85 * a})`); g.addColorStop(0.5, `rgba(160, 188, 240, ${0.38 * a})`); g.addColorStop(1, 'rgba(150, 180, 235, 0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, hy);
    ctx.fillStyle = `rgba(190, 210, 255, ${0.1 * a})`; ctx.fillRect(0, hy, W, H - hy); // and it catches the sea
  }
}

const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// A gull is two jointed wings. The inner wing leads the stroke and the tip lags behind it, which gives the
// whip of a real wingbeat. The body rises on the downstroke. When it glides, the wings hold still, slightly raised.
function drawGull(x, y, size, phase, flapGain, a, col) {
  const w = size * 7; // half the wingspan, in pixels
  const inner = Math.sin(phase) * 0.62 * flapGain + 0.22 * (1 - flapGain); // radians above level
  const tip = Math.sin(phase - 1.0) * 0.95 * flapGain - 0.5 * (1 - flapGain); // gliding: wrists up, tips drooped
  const by = y + Math.cos(phase) * w * 0.1 * flapGain; // up on the downstroke
  const ex = Math.cos(inner) * w * 0.55, ey = Math.sin(inner) * w * 0.55;
  const tx = ex + Math.cos(inner + tip) * w * 0.45, ty = ey + Math.sin(inner + tip) * w * 0.45;
  ctx.strokeStyle = col.replace('A', a.toFixed(2));
  ctx.lineWidth = Math.max(1, size * 0.85);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x - tx, by - ty); ctx.lineTo(x - ex, by - ey); ctx.lineTo(x, by);
  ctx.lineTo(x + ex, by - ey); ctx.lineTo(x + tx, by - ty);
  ctx.stroke();
}

function drawHorizonLife(th) {
  const hy = sy(0);
  if (hy < 20 || hy > H + 4) return;
  const t = performance.now() / 1000;
  // haze where the far water melts into the sky
  const hz = ctx.createLinearGradient(0, hy - 26, 0, hy + 8);
  hz.addColorStop(0, `rgba(${th.haze}, 0)`);
  hz.addColorStop(0.72, `rgba(${th.haze}, 0.26)`);
  hz.addColorStop(1, `rgba(${th.haze}, 0)`);
  ctx.fillStyle = hz;
  ctx.fillRect(0, hy - 26, W, 34);
  // gulls
  if (has('birds') && th.birds) {
    const col = th.moon || th.stars > 1 ? 'rgba(8, 6, 20, A)' : 'rgba(22, 14, 32, A)';
    for (let i = 0; i < Math.min(birds.length, th.birds); i++) {
      const b = birds[i];
      const wx = ((b.x0 + b.v * t + 1600) % 3200 + 3200) % 3200 - 1600;
      const x = W / 2 + (wx - cam.x * 0.82) * cam.s;
      const y = sy(b.y + Math.sin(t * 0.5 + b.glide) * 6);
      if (x < -20 || x > W + 20 || y < -10 || y > hy - 6) continue;
      const near = clamp(cam.s, 0.35, 1.8);
      const edge = 1 - smooth(1200, 1600, Math.abs(wx));
      // gulls flap in bursts and glide in between, so the wing pose blends smoothly rather than snapping
      const gain = smooth(-0.1, 0.35, Math.sin(t * 0.35 + b.glide));
      drawGull(x, y, b.size * (0.55 + near * 0.6), t * b.flap + b.ph, gain, 0.7 * edge, col);
    }
  }
}

const BOX = ['#8a4b3a', '#3f5f7a', '#a8843a', '#4f6350'];
const STACKS = [{ x: -30.4, boxes: [0, 1, 2] }];

let deckhouse = null;
function drawBarge(f, th) {
  deckhouse = null;
  const s = cam.s;
  const t = performance.now() / 1000;
  const halfDeck = 32;
  const x0 = sx(-halfDeck), x1 = sx(halfDeck);
  const d = clamp(6 * s, 5, 30); // the slice of deck we look down onto
  const y0 = sy(0) + fx.bob;
  const front = y0 + d / 2, back = y0 - d / 2;
  const hull = Math.max(4, 5 * s);
  const top = back - 3.8 * s - Math.max(2, 0.8 * s); // top of the end walls and beacon posts

  // hull: raked ends, a pale belt along the top, plating seams
  const rake = Math.max(2, 2.2 * s);
  const hg = ctx.createLinearGradient(0, front, 0, front + hull);
  hg.addColorStop(0, th.hull[0]); hg.addColorStop(1, th.hull[1]);
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.moveTo(x0 - 1.2 * s, front); ctx.lineTo(x1 + 1.2 * s, front);
  ctx.lineTo(x1 + 1.2 * s - rake, front + hull); ctx.lineTo(x0 - 1.2 * s + rake, front + hull);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.fillRect(x0 - 1.2 * s, front, x1 - x0 + 2.4 * s, Math.max(1, hull * 0.16));
  if (s > 0.9) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
    for (let m = -30; m <= 30; m += 6) ctx.fillRect(sx(m), front + hull * 0.16, 1, hull * 0.84);
    ctx.fillStyle = 'rgba(235, 240, 250, 0.2)'; // hull number and draft marks
    for (let m = -29; m <= -23; m += 2) ctx.fillRect(sx(m), front + hull * 0.5, Math.max(1, 0.18 * s), Math.max(2, 0.7 * s));
  }
  // the thruster pods that hold the ship on station, standing out past each end
  for (const side of [-1, 1]) {
    const px = side < 0 ? x0 - 3.2 * s : x1 + 0.9 * s;
    const pw = 2.3 * s, ph = hull * 0.85, py = front - hull * 0.1;
    ctx.fillStyle = th.hull[0];
    ctx.fillRect(px, py, pw, ph);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(px, py, pw, Math.max(1, 0.15 * s));
    ctx.fillStyle = 'rgba(232, 180, 60, 0.75)'; // hazard stripe
    ctx.fillRect(px, py + ph * 0.45, pw, Math.max(1, 0.35 * s));
  }
  // deck top
  const dg = ctx.createLinearGradient(0, back, 0, front);
  dg.addColorStop(0, th.deck[0]); dg.addColorStop(1, th.deck[1]);
  ctx.fillStyle = dg;
  ctx.fillRect(x0, back, x1 - x0, d);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.fillRect(x0, front - 1, x1 - x0, 1);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.16)'; // deck plating
  for (let m = -30; m <= 30; m += 4) ctx.fillRect(sx(m), back, 1, d);
  ctx.fillStyle = 'rgba(232, 180, 60, 0.5)'; // yellow edge line
  ctx.fillRect(x0, front - Math.max(2, 0.4 * s), x1 - x0, Math.max(1, 0.2 * s));
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
  // a low deckhouse at the right end, with a lit window row and a mast
  {
    const hx = sx(21.6), hw = 7.6 * s, hh = 3.4 * s, hb = back + d * 0.3;
    ctx.fillStyle = '#6f7b8c';
    ctx.fillRect(hx, hb - hh, hw, hh);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.fillRect(hx, hb - hh, hw, Math.max(1, 0.22 * s));
    ctx.fillStyle = '#4f5a6a';
    ctx.fillRect(hx + hw * 0.62, hb - hh - 1.1 * s, hw * 0.34, 1.1 * s); // bridge block
    ctx.strokeStyle = '#58637a'; ctx.lineWidth = Math.max(1, 0.18 * s); // mast
    ctx.beginPath(); ctx.moveTo(hx + hw * 0.8, hb - hh - 1.1 * s); ctx.lineTo(hx + hw * 0.8, hb - hh - 3.4 * s); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(hx + hw * 0.8 - 0.8 * s, hb - hh - 2.6 * s); ctx.lineTo(hx + hw * 0.8 + 0.8 * s, hb - hh - 2.6 * s); ctx.stroke();
    deckhouse = { x: hx, w: hw, y: hb - hh, h: hh, mastY: hb - hh - 3.4 * s, mastX: hx + hw * 0.8, bridgeY: hb - hh - 1.1 * s };
  }
  // end walls
  ctx.fillStyle = '#262d3a';
  ctx.fillRect(x0, top + Math.max(2, 0.8 * s), 1.6 * s, front - top - Math.max(2, 0.8 * s));
  ctx.fillRect(x1 - 1.6 * s, top + Math.max(2, 0.8 * s), 1.6 * s, front - top - Math.max(2, 0.8 * s));

  // light level: darker themes dim the barge; its own lights are drawn on top afterwards
  const dim = (1 - th.ambient) * 0.85;
  if (dim > 0.02) {
    ctx.fillStyle = `rgba(2, 6, 14, ${dim})`;
    const wallTop = top + Math.max(2, 0.8 * s);
    ctx.fillRect(x0 - 1.2 * s, back, x1 - x0 + 2.4 * s, front + hull - back); // deck and hull
    ctx.fillRect(x0 - 3.2 * s, front - hull * 0.1, 2.3 * s, hull * 0.85); // thruster pods
    ctx.fillRect(x1 + 0.9 * s, front - hull * 0.1, 2.3 * s, hull * 0.85);
    ctx.fillRect(x0, wallTop, 1.6 * s, back - wallTop); // end walls
    ctx.fillRect(x1 - 1.6 * s, wallTop, 1.6 * s, back - wallTop);
    for (const st of STACKS) ctx.fillRect(sx(st.x), back + d * 0.28 - st.boxes.length * 2.6 * s, 6 * s, st.boxes.length * 2.6 * s);
    if (deckhouse) { ctx.fillRect(deckhouse.x, deckhouse.y, deckhouse.w, deckhouse.h); ctx.fillRect(deckhouse.x + deckhouse.w * 0.62, deckhouse.bridgeY, deckhouse.w * 0.34, deckhouse.y - deckhouse.bridgeY); }
  }
  // a rail along the front edge, and the deckhouse windows (lit after the dimming)
  if (s > 0.7) {
    ctx.strokeStyle = 'rgba(190, 200, 215, 0.55)'; ctx.lineWidth = 1;
    const rh = Math.max(3, 1.0 * s), ry0 = front - 1;
    ctx.beginPath(); ctx.moveTo(x0, ry0 - rh); ctx.lineTo(x1, ry0 - rh); ctx.stroke();
    ctx.beginPath();
    for (let m = -31; m <= 31; m += 3) { const rx2 = sx(m); ctx.moveTo(rx2, ry0); ctx.lineTo(rx2, ry0 - rh); }
    ctx.stroke();
  }
  if (deckhouse) {
    const dh = deckhouse;
    ctx.fillStyle = `rgba(255, 220, 150, ${0.35 + 0.5 * th.lights * 0.5})`;
    for (let i = 0; i < 4; i++) ctx.fillRect(dh.x + dh.w * (0.08 + i * 0.15), dh.y + dh.h * 0.3, dh.w * 0.09, dh.h * 0.26);
    ctx.fillRect(dh.x + dh.w * 0.66, dh.bridgeY + 0.3 * s, dh.w * 0.26, Math.max(1, 0.4 * s));
    const mb = Math.sin(t * 1.9) > 0.2;
    ctx.fillStyle = mb ? 'rgba(255, 90, 80, 0.95)' : 'rgba(255, 90, 80, 0.35)';
    ctx.fillRect(dh.mastX - 1, dh.mastY - 1, 2.4, 2.4);
  }
  // sunset rim light on the end wall facing the sun
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
      const c = k < 0.25 ? '255, 222, 150' : k < 0.6 ? '255, 132, 52' : '196, 56, 28';
      g.addColorStop(0, `rgba(${c}, ${0.46 * (1 - k * 0.7)})`);
      g.addColorStop(1, `rgba(${c}, 0)`);
    } else {
      ctx.globalCompositeOperation = 'source-over';
      const a = 0.17 * (1 - (p.life - p.max) / (p.tail || 2.5));
      g.addColorStop(0, `rgba(36, 31, 33, ${a})`);
      g.addColorStop(1, 'rgba(36, 31, 33, 0)');
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
    ctx.fillStyle = d.hot && d.life < 1.5 ? '#ffb070' : '#4a505b';
    ctx.fillRect((-d.w / 2) * cam.s, (-d.h / 2) * cam.s, d.w * cam.s, d.h * cam.s);
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

// the black mark a deck fire leaves, on the deck only
function drawScorch() {
  const c = fx.scorch;
  if (!c) return;
  const x0 = sx(-DECK_HALF), x1 = sx(DECK_HALF), d = clamp(6 * cam.s, 5, 30), y0 = sy(0) + fx.bob;
  const x = sx(c.x), r = c.r * cam.s, a = 0.6 * Math.min(1, c.t * 1.5);
  ctx.save();
  ctx.beginPath(); ctx.rect(x0, y0 - d / 2, x1 - x0, d); ctx.clip();
  ctx.translate(x, y0); ctx.scale(1, 0.42);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  g.addColorStop(0, `rgba(6, 5, 5, ${a})`);
  g.addColorStop(0.55, `rgba(12, 9, 9, ${a * 0.6})`);
  g.addColorStop(1, 'rgba(12, 9, 9, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(-r, -r, r * 2, r * 2);
  ctx.restore();
}

// foam lying on the surface after something went in
function drawFoam() {
  for (const p of fx.foam) {
    const k = p.life / p.max, r = p.r * cam.s, a = 0.6 * (1 - k) * Math.min(1, p.life * 6);
    ctx.save();
    ctx.translate(sx(p.x), sy(0) + 1);
    ctx.scale(1, 0.2);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, `rgba(238, 246, 255, ${a})`);
    g.addColorStop(0.7, `rgba(210, 228, 244, ${a * 0.6})`);
    g.addColorStop(1, 'rgba(210, 228, 244, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.restore();
  }
}

// the column of water thrown up by a hard hit: it climbs fast, widens, and falls back in on itself
function drawColumn() {
  const c = fx.column;
  if (!c) return;
  const T = c.t, rise = clamp(T / 0.45, 0, 1), fall = clamp((T - 0.45) / 1.6, 0, 1);
  const hgt = (10 + 24 * c.k) * (1 - (1 - rise) ** 2.4) * (1 - fall ** 1.7);
  if (hgt < 0.3) return;
  const wb = (2.4 + 3.2 * c.k) * (1 + 0.9 * T), wt = wb * (0.62 + 0.5 * fall);
  const x = sx(c.x), y = sy(0), h = hgt * cam.s, b = wb * cam.s, t = wt * cam.s;
  const a = 0.8 * (1 - fall ** 2);
  const g = ctx.createLinearGradient(0, y - h, 0, y);
  g.addColorStop(0, `rgba(244, 250, 255, ${a})`);
  g.addColorStop(1, `rgba(150, 196, 228, ${a * 0.65})`);
  ctx.save();
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x - b, y);
  ctx.bezierCurveTo(x - b * 0.7, y - h * 0.45, x - t * 1.1, y - h * 0.75, x - t * 0.8, y - h * 0.93); // up the side to a rounded crown
  ctx.quadraticCurveTo(x, y - h - t * 0.7, x + t * 0.8, y - h * 0.93);
  ctx.bezierCurveTo(x + t * 1.1, y - h * 0.75, x + b * 0.7, y - h * 0.45, x + b, y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawRing() {
  for (const r of fx.ripples) { // rings spreading over the water
    if (r.wait > 0) continue;
    ctx.strokeStyle = `rgba(220, 236, 255, ${Math.max(0, r.a)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(sx(r.x), sy(0), r.r * cam.s, r.r * cam.s * 0.16, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (!fx.ring) return;
  const s = app.flight.state;
  ctx.strokeStyle = fx.ring.bad ? `rgba(255, 210, 160, ${fx.ring.a * 0.6})` : `rgba(91, 227, 164, ${fx.ring.a * 0.8})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(sx(s.x), sy(0), fx.ring.r * cam.s, fx.ring.r * cam.s * 0.16, 0, 0, Math.PI * 2);
  ctx.stroke();
}

// The overlays that make the scene read like a technical diagram: hairlines, a blue line for where you have been, a dashed white
// line for where you are heading, and small capital labels on leader lines.
function drawTrail() {
  const pts = app.trail;
  if (pts.length < 2) return;
  const n = pts.length, chunk = 14;
  ctx.save();
  ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (let i = 0; i < n - 1; i += chunk) { // older stretches fade
    const end = Math.min(n - 1, i + chunk);
    ctx.strokeStyle = `rgba(110, 155, 255, ${0.12 + 0.78 * (end / n)})`;
    ctx.beginPath();
    ctx.moveTo(sx(pts[i][0]), sy(pts[i][1]));
    for (let j = i + 1; j <= end; j++) ctx.lineTo(sx(pts[j][0]), sy(pts[j][1]));
    ctx.stroke();
  }
  ctx.restore();
}

function drawPrediction(f) {
  // where you'll be in the next few seconds if you hold the controls as they are
  const sim = { wind: f.wind, limits: f.limits, pad: f.pad, minThrottle: f.minThrottle, fuel0: f.fuel0, state: { ...f.state } };
  const st = { ...app.steer };
  const pts = [[f.state.x, f.state.y]];
  for (let i = 0; i < 240 && !sim.state.done; i++) {
    step(sim, human(sim, 1 / 40, st), 1 / 40);
    if (i % 4 === 0) pts.push([sim.state.x, sim.state.y]);
  }
  const o = sim.state.outcome;
  const end = sim.state.done && o && o.checks && 'onPad' in o.checks ? { x: sim.state.x, onPad: o.checks.onPad, off: Math.max(0, o.distance - f.pad.halfWidth) } : null;
  app.pred = { pts, end };
  ctx.save();
  ctx.lineWidth = 1; ctx.setLineDash([4, 5]); ctx.lineCap = 'round';
  const parts = 4, per = Math.ceil(pts.length / parts);
  for (let c = 0; c < parts; c++) { // fading out as it runs on
    const seg = pts.slice(Math.max(0, c * per - 1), (c + 1) * per);
    if (seg.length < 2) continue;
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.85 - c * 0.2})`;
    ctx.beginPath();
    seg.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
    ctx.stroke();
  }
  ctx.restore();
  if (end) drawCrosshair(ctx, sx(end.x), sy(0), 8, end.onPad ? LOOK.line : LOOK.amber);
}

// the pad, when it has slid off the side of the picture
function drawPadPointer(f) {
  const px = sx(0);
  if (px > 24 && px < W - 24) return;
  const left = px <= 24;
  const x = left ? 28 : W - 28;
  const y = clamp(sy(0) - 40, 80, H - 40);
  ctx.save();
  ctx.fillStyle = LOOK.line;
  ctx.beginPath();
  if (left) { ctx.moveTo(x - 12, y); ctx.lineTo(x + 2, y - 9); ctx.lineTo(x + 2, y + 9); }
  else { ctx.moveTo(x + 12, y); ctx.lineTo(x - 2, y - 9); ctx.lineTo(x - 2, y + 9); }
  ctx.fill();
  ctx.font = LOOK.font;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '1px';
  ctx.textAlign = left ? 'left' : 'right';
  ctx.fillText(`PAD ${Math.round(Math.abs(f.state.x))} M`, left ? x + 8 : x - 8, y + 24);
  ctx.restore();
}

// where the approach window sits over the picture, so nothing else is placed on top of it
function mapRect() {
  const a = canvas.getBoundingClientRect(), b = mini.getBoundingClientRect();
  return b.width ? { x: b.left - a.left, y: b.top - a.top, w: b.width, h: b.height } : null;
}

function drawScenePins(f) {
  const s = f.state;
  drawPadPointer(f);
  if (app.attract || !app.running || s.done) return;
  const h = Math.max(0, s.y - BOOSTER.legHeight);
  ctx.save();
  // the label on the predicted touchdown, fading once the magnifier takes over
  if (app.mode === 'game' && app.pred && app.pred.end) {
    const e = app.pred.end, x = sx(e.x), right = x < W * 0.62;
    ctx.globalAlpha = clamp((h - 40) / 40, 0, 1);
    if (ctx.globalAlpha > 0) drawCallout(ctx, x + (right ? 6 : -6), sy(0), e.onPad ? 'Predicted: on the pad' : `Predicted: ${Math.round(e.off)} m off`, { dir: right ? 1 : -1, rise: -34, bend: 26, run: 150, color: e.onPad ? LOOK.line : LOOK.amber });
    ctx.globalAlpha = 1;
  }
  // labels on the booster itself, once it is big enough to carry them: the engine, and the legs
  const vs = boosterScale();
  if (42 * vs >= 126 && !app.menuOpen) {
    const x0 = sx(s.x), y0 = sy(s.y), c = Math.cos(s.theta), sn = Math.sin(s.theta);
    const at = (bx, by) => [x0 + vs * (bx * c - by * sn), y0 + vs * (bx * sn + by * c)]; // a point on the booster, in metres from the nozzle
    const legsText = fx.legs > 0 && fx.legs < 1 ? 'Legs deploying' : fx.legs >= 1 && performance.now() - fx.legsAt < 3500 ? 'Legs locked' : '';
    // both labels run out to the right, under the numbers (the gauge is on the left): the legs one first, the engine one below it
    if (legsText) { const [ax, ay] = at(7.9, 2.5); drawCallout(ctx, ax, ay, legsText, { dir: 1, rise: 34, bend: 22, run: 100 }); }
    const engineRise = legsText ? 62 : 34;
    if (s.cut) { const [ax, ay] = at(0.85, 0.4); drawCallout(ctx, ax, ay, 'Engine out', { dir: 1, rise: engineRise, bend: 26, run: 100, color: LOOK.amber }); }
    else if (s.engineOn && s.throttle > 0.02) { const [ax, ay] = at(0.85, 0.4); drawCallout(ctx, ax, ay, `Engine ${Math.round(s.throttle * 100)}%`, { dir: 1, rise: engineRise, bend: 26, run: 100 }); }
  }
  ctx.restore();
  // a magnifier over the last stretch: the legs and the deck close up, and how the landing limits stand
  if (W >= 700 && h < 60) {
    const R = 66, alpha = clamp((60 - h) / 20, 0, 1);
    const zoom = clamp(R / (cam.s * (h / 2 + 4)), 1, 3.5); // frames the feet and the deck, and tightens as they meet
    const P = [sx(s.x), sy(0)];
    const spot = magnifierSpot({ px: P[0], py: P[1], r: R, W, H, avoid: mapRect(), below: 70 });
    const yc = h / 2; // halfway between the feet and the deck
    const half = (R / zoom) * dpr;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath(); ctx.arc(spot.x, spot.y, R, 0, Math.PI * 2);
    ctx.fillStyle = '#000'; ctx.fill();
    ctx.save(); ctx.clip();
    ctx.drawImage(canvas, sx(s.x) * dpr - half, sy(yc) * dpr - half, half * 2, half * 2, spot.x - R, spot.y - R, R * 2, R * 2); // a copy of what is already drawn
    ctx.restore();
    ctx.strokeStyle = LOOK.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(spot.x, spot.y, R, 0, Math.PI * 2); ctx.stroke();
    const cone = tangents(P, [spot.x, spot.y], R);
    if (cone) {
      ctx.globalAlpha = alpha * 0.75;
      ctx.beginPath(); cone.forEach(([x, y]) => { ctx.moveTo(P[0], P[1]); ctx.lineTo(x, y); }); ctx.stroke();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = LOOK.line; ctx.beginPath(); ctx.arc(P[0], P[1], 2.5, 0, Math.PI * 2); ctx.fill();
    }
    const L = f.limits;
    const rows = [
      [`Fall ${Math.abs(s.vy).toFixed(1)} / limit ${L.vy}`, Math.abs(s.vy) <= L.vy],
      [`Side ${Math.abs(s.vx).toFixed(1)} / limit ${L.vx}`, Math.abs(s.vx) <= L.vx],
      [`Tilt ${Math.abs(s.theta / DEG).toFixed(1)}° / limit ${Math.round(L.tilt / DEG)}°`, Math.abs(s.theta) <= L.tilt],
    ];
    ctx.font = LOOK.font; ctx.textAlign = 'center';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1px';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.9)'; ctx.shadowBlur = 5; // readable over a bright horizon
    rows.forEach(([t, ok], i) => { ctx.fillStyle = ok ? '#9bb8ff' : LOOK.amber; ctx.fillText(t.toUpperCase(), spot.x, spot.y + R + 20 + i * 16); });
    ctx.restore();
  }
}

// The approach window: the whole descent side on, with the height stretched so the last few hundred metres have room.
function drawMinimap(f) {
  const cw = mini.clientWidth, ch = mini.clientHeight;
  if (!cw) return;
  if (mini.width !== Math.round(cw * dpr) || mini.height !== Math.round(ch * dpr)) { mini.width = Math.round(cw * dpr); mini.height = Math.round(ch * dpr); }
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mctx.clearRect(0, 0, cw, ch);
  const L = 16, R = cw - 16, T = 34, B = ch - 28, xr = 320, yr = 2500;
  const mx = (x) => (L + R) / 2 + clamp(x / xr, -1, 1) * ((R - L) / 2);
  const my = (y) => B - Math.sqrt(clamp(y, 0, yr) / yr) * (B - T);
  const s = f.state;
  mctx.font = '600 10px "D-DIN", "Arial Narrow", Arial, sans-serif';
  if ('letterSpacing' in mctx) mctx.letterSpacing = '1.4px';
  mctx.fillStyle = '#bdbdbd';
  mctx.fillText('APPROACH', L - 2, 19);
  // height ticks down the left edge, and the deck
  mctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  for (const y of [100, 500, 1000, 2000]) mctx.fillRect(L - 9, my(y), 5, 1);
  mctx.fillRect(L - 9, B, R - L + 18, 1);
  // the pad, with a tick at its middle
  mctx.fillStyle = '#fff';
  mctx.fillRect(mx(-f.pad.halfWidth), B - 1, mx(f.pad.halfWidth) - mx(-f.pad.halfWidth), 3);
  mctx.fillRect(mx(0), B - 7, 1, 7);
  // the five winds of the autopilot lab, faint
  for (const gtr of app.ghosts) {
    mctx.strokeStyle = gtr.landed ? 'rgba(110, 155, 255, 0.35)' : 'rgba(242, 193, 78, 0.45)';
    mctx.lineWidth = 1;
    mctx.beginPath();
    gtr.trace.forEach(([x, y], i) => (i ? mctx.lineTo(mx(x), my(y)) : mctx.moveTo(mx(x), my(y))));
    mctx.stroke();
  }
  // where you have been (solid blue) and where you are heading (dashed white)
  mctx.lineJoin = 'round';
  mctx.strokeStyle = LOOK.blue; mctx.lineWidth = 2;
  mctx.beginPath();
  app.trail.forEach(([x, y], i) => (i ? mctx.lineTo(mx(x), my(y)) : mctx.moveTo(mx(x), my(y))));
  mctx.stroke();
  if (app.pred && app.pred.pts.length > 1) {
    mctx.strokeStyle = 'rgba(255, 255, 255, 0.8)'; mctx.lineWidth = 1; mctx.setLineDash([3, 4]);
    mctx.beginPath();
    app.pred.pts.forEach(([x, y], i) => (i ? mctx.lineTo(mx(x), my(y)) : mctx.moveTo(mx(x), my(y))));
    mctx.stroke();
    mctx.setLineDash([]);
  }
  // you
  const dx = mx(s.x), dy = my(s.y);
  mctx.fillStyle = '#fff';
  mctx.beginPath(); mctx.arc(dx, dy, 3.5, 0, Math.PI * 2); mctx.fill();
  if (!s.done) drawCallout(mctx, dx, dy, 'Booster', { dir: dx < cw / 2 ? 1 : -1, rise: -16, bend: 12, run: 64, font: '600 10px "D-DIN", Arial, sans-serif', tracking: '1.2px' });
  mctx.fillStyle = '#bdbdbd';
  mctx.textAlign = 'left';
  mctx.fillText(`OFF PAD ${Math.round(Math.abs(s.x))} M`, L - 2, ch - 8);
  mctx.textAlign = 'start';
}

// ---------- HUD ----------
let hudT = 0;
// an arrow icon in a slot, rewritten only when it changes
function setDir(el, name) {
  if (el.dataset.name === name) return;
  el.dataset.name = name;
  el.innerHTML = name ? icon(name, 13) : '';
}

// keeps the instruments beside the booster, every frame, and inside the picture
function placeFocus() {
  const f = app.flight;
  if (!f || !$('focus').classList.contains('on')) return;
  const s = f.state;
  const hw = clamp(cam.s * 2.4, 8, 70), small = W < 520;
  // keep the gauge on the left and the numbers on the right of the booster, a clear hand's width away from it, and both inside the picture
  const gl = small ? 40 : 76, gr = small ? 50 : 90;
  const lo = (small ? 78 : 96) + hw + gl + 6, hi = W - (hw + gr + (small ? 158 : 206)) - 10;
  const x = hi < lo ? (lo + hi) / 2 : clamp(sx(s.x), lo, hi), y = clamp(sy(s.y + 21), small ? 240 : 130, H - 150);
  const fc = $('focus');
  fc.style.setProperty('--hw', `${hw.toFixed(1)}px`);
  fc.style.setProperty('--gl', `${gl}px`);
  fc.style.setProperty('--gr', `${gr}px`);
  fc.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  // the "light the engine" cue sits just under the instruments, where the eyes already are (phones keep it centred, higher up)
  const cue = $('cue');
  if (W >= 520) { cue.style.left = `${x.toFixed(1)}px`; cue.style.top = `${Math.min(y + 112, H - 210).toFixed(1)}px`; }
  else { cue.style.left = ''; cue.style.top = ''; }
}

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
  const aim = Math.sqrt(1.44 + 2 * (app.mode === 'game' ? levelCfg().aimDecel : 3) * h);
  const guided = app.mode === 'game' && levelCfg().target && !s.done;
  $('t-vy').className = low ? (Math.abs(s.vy) <= Math.max(L.vy, aim + 1) ? 'ok' : 'warn') : guided ? (-s.vy > aim + 4 ? 'warn' : 'ok') : '';
  $('t-vx').className = low ? (Math.abs(s.vx) <= L.vx ? 'ok' : 'warn') : '';
  $('t-dx').className = low ? (Math.abs(s.x) <= f.pad.halfWidth ? 'ok' : 'warn') : '';
  $('t-tilt').className = low ? (Math.abs(s.theta) <= L.tilt ? 'ok' : 'warn') : '';
  // the instruments that ride with the booster: a gauge that wants the dot on the centre tick, and the numbers that decide a landing
  const fall = -s.vy;
  const flying = app.running && !s.done && !app.attract;
  const dev = clamp((fall - aim) / (aim * 0.3 + 4), -1, 1); // below the tick: falling faster than the plan, so brake
  $('dev').style.display = guided ? '' : 'none';
  $('dev').style.setProperty('--dy', `${(dev * 52).toFixed(1)}px`);
  $('dev').dataset.s = Math.abs(dev) < 0.25 ? '' : Math.abs(dev) < 0.6 ? 'amber' : 'red';
  $('t-vy-target').innerHTML = guided ? (low ? `aim ${aim.toFixed(0)}<br>limit ${L.vy}` : `aim ${aim.toFixed(0)}`) : ''; // numbers only, so markup is safe
  const focus = $('focus');
  focus.classList.toggle('on', flying);
  focus.classList.toggle('final', low);
  $('lim-dx').textContent = `/ ±${+f.pad.halfWidth.toFixed(0)}`;
  $('lim-vx').textContent = `/ ${L.vx}`;
  $('lim-tilt').textContent = `/ ${Math.round(L.tilt / DEG)}°`;
  setDir($('pad-dir'), Math.abs(s.x) > 2 ? (s.x > 0 ? 'arrow-left' : 'arrow-right') : ''); // the pad is the other way from where you are
  setDir($('vx-dir'), Math.abs(s.vx) > 0.3 ? (s.vx > 0 ? 'arrow-right' : 'arrow-left') : '');
  const strip = $('strip'), range = clamp(80 + h * 0.35, 80, 420);
  strip.classList.toggle('on', flying);
  const dotPct = 50 + clamp(s.x / range, -1, 1) * 50;
  $('strip-dot').style.left = `${dotPct}%`;
  $('strip-pad').style.width = `${clamp((f.pad.halfWidth / range) * 100, 2, 100)}%`;
  const vel = $('strip-vel'), vlen = clamp(Math.abs(s.vx) * 8, 0, 70);
  vel.style.left = `${dotPct}%`; vel.style.width = `${vlen}px`; vel.style.transform = s.vx < 0 ? 'translateX(-100%)' : 'none';
  const driftOut = low && (Math.abs(s.vx) > L.vx || Math.abs(s.theta) > L.tilt || Math.abs(s.x) > f.pad.halfWidth * 1.2);
  strip.dataset.s = driftOut ? (Math.abs(s.vx) > L.vx * 1.8 || Math.abs(s.x) > f.pad.halfWidth * 2 ? 'red' : 'amber') : '';
  // a cue at the edge of the eye: too fast near the deck, or drifting out of the landing limits
  const tooFast = guided && flying && h < 400 && h > 6 && fall > aim * 1.35 + 6;
  const edge = $('edge');
  edge.classList.toggle('alarm', tooFast && !app.menuOpen);
  edge.classList.toggle('warn', !tooFast && driftOut && flying && !app.menuOpen);
  $('lamp-fuel').classList.toggle('hidden', !(flying && s.fuel / f.fuel0 < 0.12));
  $('lamp-paused').classList.toggle('hidden', !(app.menuOpen && app.running && !s.done));
  coachUpdate(f, s, h);
  const eb = $('d-engine');
  eb.classList.toggle('on', s.engineOn && !s.done);
  eb.setAttribute('aria-pressed', String(Boolean(s.engineOn && !s.done)));
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
  $('faults').style.visibility = app.running || app.ended ? 'visible' : 'hidden'; // the briefing card shows them before the start
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
  const sub = msg === 'Light the engine' ? (window.matchMedia('(pointer: coarse)').matches ? 'Tap Engine' : 'Press Space') : '';
  if (cue.dataset.k !== msg + sub) { // only rebuilt when the words change
    cue.dataset.k = msg + sub;
    cue.textContent = msg;
    if (sub) { const small = document.createElement('small'); small.textContent = sub; cue.appendChild(small); }
  }
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
    b.dataset.tip = lv.label; b.dataset.tipDetail = LEVEL_COPY[k].tagline;
    b.addEventListener('click', () => { app.level = k; store.set('hs.level', k); renderWindOptions(); setDrawer(false); showIntro(true); });
    box.appendChild(b);
  }
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
  document.body.dataset.mode = mode;
  app.ghosts = [];
  renderWindOptions();
  showIntro(true);
  setDrawer(mode === 'sim'); // the lab opens on its settings, the game on the scene
}

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

// ---------- settings, the lab drawer and the dock ----------
// In a flight, settings are a small popover over the dock; in the autopilot lab the nine settings live in a drawer. Either one pauses
// the flight while it is open, and Esc opens and closes it.
function setDrawer(open) {
  const lab = app.mode === 'sim';
  const el = lab ? $('drawer') : $('settings'), other = lab ? $('settings') : $('drawer');
  other.classList.remove('open'); other.inert = true;
  if (!open && el.contains(document.activeElement)) document.activeElement.blur(); // never leave Space on a hidden button
  el.classList.toggle('open', open);
  el.inert = !open;
  app.menuOpen = open;
  document.body.classList.toggle('drawer-open', open);
  $('d-menu').setAttribute('aria-expanded', String(open && !lab));
  $('d-lab').setAttribute('aria-expanded', String(open && lab));
  if (open) {
    Object.assign(app.input, { left: false, right: false, up: false, down: false });
    (lab ? $('drawer-close') : el.querySelector('.level.active') || el.querySelector('button')).focus({ preventScroll: true });
  }
}
for (const [id, name] of [['d-engine', 'engine'], ['d-retry', 'retry'], ['d-new', 'shuffle'], ['d-menu', 'gear'], ['d-lab', 'sliders'], ['drawer-close', 'close']]) $(id).innerHTML = icon(name, 20);
$('to-lab').innerHTML = `${icon('sliders', 16)}Autopilot lab`;
$('to-how').innerHTML = `${icon('help', 16)}How to play`;
$('d-engine').addEventListener('click', (e) => {
  e.currentTarget.blur();
  if (!app.running && !$('intro').classList.contains('hidden')) return start();
  if (app.mode === 'game' && app.running) app.input.engine = !app.input.engine;
});
$('d-retry').addEventListener('click', (e) => { e.currentTarget.blur(); start(); });
$('d-new').addEventListener('click', (e) => { e.currentTarget.blur(); showIntro(true); });
for (const id of ['d-menu', 'd-lab']) $(id).addEventListener('click', (e) => { e.currentTarget.blur(); setDrawer(!app.menuOpen); });
$('drawer-close').addEventListener('click', () => setDrawer(false));
$('to-lab').addEventListener('click', () => setMode('sim'));
$('to-game').addEventListener('click', () => setMode('game'));
$('to-how').addEventListener('click', () => { setDrawer(false); showStart('how'); });
$('stage').addEventListener('pointerdown', () => { if (app.menuOpen) setDrawer(false); });
$('hints').checked = store.get('hs.hints', true);
$('hints').addEventListener('change', (e) => { store.set('hs.hints', e.target.checked); if (e.target.checked) store.set('hs.coachDone', 0); }); // turning hints on brings the lesson back

// ---------- the tutorial: key prompts at the moment they matter ----------
// Space to light the engine, then the lean, then the speed. Each step ends when the player does the thing, and the lesson is
// shown on the first game only, on whatever level it is. Hints can be switched off, or back on for the next game, in settings.
const COACH = { on: false, step: 0, lean: 0, speed: 0, t: 0, shown: '' };
function coachStart() {
  COACH.on = app.mode === 'game' && !app.attract && store.get('hs.hints', true) && store.get('hs.coachDone', 0) < 1; // the first game only, on whatever level it is
  Object.assign(COACH, { step: 0, lean: 0, speed: 0, t: 0, shown: '' });
  $('coach').classList.add('hidden');
}
const keycap = (label, k, wide) => `<kbd class="cap${wide ? ' wide' : ''}" data-k="${k}">${label}</kbd>`;
function coachUpdate(f, s, h) {
  const el = $('coach');
  if (!COACH.on || !app.running || s.done || app.menuOpen) { el.classList.add('hidden'); return; }
  const touch = window.matchMedia('(pointer: coarse)').matches;
  const inp = app.input;
  if (COACH.step === 0 && s.engineOn) COACH.step = 1;
  if (COACH.step === 1) {
    if (inp.left || inp.right) COACH.lean += 0.05;
    if (COACH.lean > 0.7 || Math.abs(s.x) < f.pad.halfWidth) COACH.step = 2;
  }
  if (COACH.step === 2) {
    if (inp.up || inp.down) COACH.speed += 0.05;
    COACH.t += 0.05;
    if (COACH.speed > 0.3 || COACH.t > 10) COACH.step = 3;
  }
  const low = h < 150;
  const hot = COACH.step === 1 ? (s.x > 0 ? 'left' : 'right') : ''; // the key that goes toward the pad
  const key = `${COACH.step}${hot}${touch}${low}`;
  if (COACH.step === 3 && !low) { el.classList.add('hidden'); return; }
  if (key !== COACH.shown) {
    COACH.shown = key;
    const lv = levelCfg();
    const steps = [
      [keycap('Space', 'engine', true), 'Light the engine', touch ? 'Tap Engine.' : '', app.level === 'easy' ? 'A cue tells you when it is time.' : 'Around 1,600 m leaves time to steer.'],
      [keycap('←', 'left') + keycap('→', 'right'), 'Lean toward the pad', 'The arrow beside To pad shows the way.', 'Steering only works while the engine burns.'],
      [keycap('↑', 'up') + keycap('↓', 'down'), 'Keep the dot on the centre tick', 'Up slows you down, down speeds you up.', 'Let go of both to hold your speed.'],
      ['', 'Almost there', `Touch down under ${f.limits.vy} m/s,`, 'upright and over the pad.'],
    ][COACH.step];
    $('coach-keys').innerHTML = steps[0];
    $('coach-text').innerHTML = `<b>${steps[1]}</b><span>${[steps[2], steps[3]].filter(Boolean).join(' ')}</span>`;
    if (hot) $('coach-keys').querySelector(`[data-k="${hot}"]`).classList.add('hot');
  }
  for (const k of el.querySelectorAll('kbd[data-k]')) k.classList.toggle('down', k.dataset.k === 'engine' ? Boolean(s.engineOn) : Boolean(inp[k.dataset.k]));
  el.classList.remove('hidden');
}

// ---------- start screen: welcome, how to play, choose a level ----------
const startEl = $('start-screen');

function renderHow() {
  $('view-how').innerHTML = `
    <div class="vhead"><div><h2>How to play</h2><p class="lede">The engine can't hover, so there is one burn. Light it, hold your speed on the aim-for number, steer onto the pad.</p></div>
    <div class="nav"><button id="how-back" class="ghost">Back</button><button id="how-go" class="primary big">Choose a level</button></div></div>
    <div class="how">
      <div class="how-figs">
        <figure>${descentDiagram()}<figcaption>A whole descent, side on.</figcaption></figure>
        <figure>${speedDiagram()}<figcaption>Falling speed against height. Light the engine early, brake onto the dotted aim-for line, then follow it down.</figcaption></figure>
      </div>
      <div class="plate">
        <ol class="steps">
          <li><span><b>Fall</b>The engine is off. Easy shows a cue when to light it. On Medium and Hard, light it around 1,600 m so there is time to steer. Steering only works while the engine burns.</span></li>
          <li><span><b>Burn</b>Press Space. Keep your falling speed on the aim-for number beside it: up slows you down, down speeds you up, and letting go holds your speed. Lean with left and right.</span></li>
          <li><span><b>Touch down</b>Upright, over the green, and slow: under 3 m/s down, 1.5 m/s sideways and 6 degrees of tilt. Easy forgives more.</span></li>
        </ol>
        <ul class="keys">${KEYS.map((k) => `<li><span class="caps">${keycaps(k.caps)}</span>${k.text}</li>`).join('')}</ul>
        <p class="limits">Every run is a different <b>scenario</b>: a high or low drop, a fuel leak, weak thrust, a flaky thruster. The briefing before each descent says what to expect.</p>
      </div>
    </div>
    `;
  $('how-back').addEventListener('click', () => setView('welcome'));
  $('how-go').addEventListener('click', () => setView('levels'));
}

function renderLevelCards() {
  const cleared = store.get('hs.cleared', {});
  const best = store.get('hs.best', {});
  $('view-levels').innerHTML = `
    <h2>Choose a level</h2>
    <p class="lede">Each level has 30 scenarios, played in a shuffled order so nothing repeats until you have seen them all.</p>
    <div class="cards">${Object.entries(LEVELS).map(([k, lv]) => {
      const n = (BANK[k] || []).filter((sc) => cleared[sc.id]).length;
      const copy = LEVEL_COPY[k];
      return `<button class="lvl-card" data-level="${k}">${levelThumb(k)}<span class="body"><span class="nm">${lv.label}</span><span class="tg">${copy.tagline}</span><span class="dt">${copy.detail}</span><span class="pr">${n ? `<b>${n}</b> of ${(BANK[k] || []).length} cleared${best[k] ? `, best ${best[k]}` : ''}` : `${(BANK[k] || []).length} scenarios, none flown yet`}</span></span></button>`;
    }).join('')}</div>
    <div class="nav"><button id="lv-back" class="ghost">Back</button><button id="lv-how" class="textlink">How to play</button></div>`;
  for (const c of document.querySelectorAll('.lvl-card')) c.addEventListener('click', () => chooseLevel(c.dataset.level));
  $('lv-back').addEventListener('click', () => setView('welcome'));
  $('lv-how').addEventListener('click', () => setView('how'));
}

function setView(v) {
  app.view = v;
  startEl.dataset.view = v;
  if (v === 'how') renderHow();
  if (v === 'levels') renderLevelCards();
  for (const el of startEl.querySelectorAll('.view')) el.classList.toggle('hidden', el.dataset.view !== v);
  startEl.scrollTop = 0;
  const first = startEl.querySelector(`[data-view="${v}"] .primary, [data-view="${v}"] .lvl-card`);
  if (first) first.focus({ preventScroll: true });
}

function showStart(view) {
  clearTimeout(app.cardTimer);
  app.menuOpen = false; // the drawer is hidden behind the start screen, so it must not keep the game paused
  document.body.classList.remove('drawer-open');
  app.attract = true;
  app.running = false;
  document.body.classList.add('in-menu');
  startEl.classList.remove('hidden');
  newFlight();
  app.running = true;
  setView(view);
  requestAnimationFrame(() => { resize(); cam.snap = true; });
}

function leaveStart() {
  clearTimeout(app.cardTimer);
  app.attract = false;
  app.running = false;
  document.body.classList.remove('in-menu');
  startEl.classList.add('hidden');
  store.set('hs.seen', true);
  requestAnimationFrame(resize);
}

function chooseLevel(k) {
  app.level = k;
  store.set('hs.level', k);
  leaveStart();
  setMode('game');
}

$('st-play').addEventListener('click', () => setView('levels'));
$('st-how').addEventListener('click', () => setView('how'));
$('st-tune').addEventListener('click', () => { leaveStart(); setMode('sim'); });
$('menu-btn').addEventListener('click', () => showStart('levels'));

// ---------- boot ----------
audio.init();
initTooltips();
resize();
renderLevels();
renderSliders();
setMode('game');
showStart('welcome'); // always open on the main screen
requestAnimationFrame((t) => { last = t; frame(t); document.body.classList.add('go'); setTimeout(() => { app.hold = false; }, 700); }); // the fog clears once the first frame is drawn; the landing starts as it thins
app.hold = document.body.classList.contains('boot'); // the backdrop landing waits for the fog to clear
setTimeout(() => { app.hold = false; const c = $('curtain'); if (c) c.remove(); document.body.classList.remove('boot'); }, 5000);

// handle for tests and tinkering in the console
window.hoverslam = { app, fx, cam, audio, BANK, showIntro, showStart, setView, chooseLevel };
