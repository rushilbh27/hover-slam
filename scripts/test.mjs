// Run with: npm test. No dependencies, no browser.
import assert from 'node:assert/strict';
import { BOOSTER, G, DT, DEG, clamp, mass, SEEDS, LEVELS, GAIN_RANGES, DEFAULT_GAINS, REFERENCE_GAINS, makeFlight, step, autopilot, validateGains, scoreFlight, evaluate } from '../public/physics.js';
import { SETTINGS, NUDGE, debrief } from '../public/explain.js';
import { humanControl } from '../public/controls.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n     ${e.message}`);
    process.exitCode = 1;
  }
}

function fly(opts, controller) {
  const f = makeFlight(opts.seed, opts.level);
  while (!f.state.done) step(f, controller(f), DT);
  return f.state.outcome;
}

// A scripted player who reacts five times a second. "lazy" never touches up or down.
function player(level, mode) {
  const lv = LEVELS[level];
  return (seed) => {
    const f = makeFlight(seed, lv.opts);
    const s = f.state;
    const inp = { left: false, right: false, up: false, down: false, engine: false, throttle: 0.8 };
    const st = { want: 0, vHold: 0 };
    let react = 0;
    while (!s.done) {
      if ((react += DT) >= 0.2) {
        react = 0;
        const h = s.y - BOOSTER.legHeight;
        if (!inp.engine && s.vy < -5) {
          const brake = (0.85 * BOOSTER.thrustMax) / mass(s) - G;
          if (h <= ((s.vy * s.vy) / (2 * brake)) * 1.3) inp.engine = true;
        }
        const aim = Math.sqrt(1 + 6 * Math.max(0, h));
        inp.up = mode === 'careful' && -s.vy > aim + 0.5;
        inp.down = mode === 'careful' && -s.vy < aim - 3;
        const toward = Math.sign(-s.x);
        const away = s.vx * toward;
        const want = clamp(Math.abs(s.x) * 0.08, 0, 8);
        inp.left = inp.right = false;
        if (h > 25 && Math.abs(s.x) > 3 && away < want - 0.5) (toward > 0 ? (inp.right = true) : (inp.left = true));
      }
      step(f, humanControl(f, DT, st, inp, lv), DT);
    }
    return s.outcome;
  };
}

const landedCount = (level, mode) => SEEDS.filter((seed) => player(level, mode)(seed).landed).length;

// ---------- physics ----------
test('same seed gives the same flight', () => {
  assert.deepEqual(evaluate(DEFAULT_GAINS), evaluate(DEFAULT_GAINS));
});

test('the engine cannot hover on the real throttle floor: tiny fuel + 40% thrust climbs', () => {
  const f = makeFlight(1);
  Object.assign(f.state, { y: 500, vy: 0, fuel: 100, x: 0, vx: 0 });
  const thrustAcc = (0.4 * BOOSTER.thrustMax) / mass(f.state);
  assert.ok(thrustAcc > G, 'a nearly empty booster at 40% should out-push gravity');
});

test('the throttle floor follows the level: 15% Easy, 25% Medium, 35% Hard or lower', () => {
  assert.equal(makeFlight(1, LEVELS.easy.opts).minThrottle, 0.15);
  assert.equal(makeFlight(1, LEVELS.medium.opts).minThrottle, 0.25);
  assert.ok(makeFlight(1, LEVELS.hard.opts).minThrottle <= 0.35);
});

test('levels get harder: smaller pad and tighter landing limits', () => {
  const [e, m, h] = ['easy', 'medium', 'hard'].map((k) => makeFlight(1, LEVELS[k].opts));
  assert.ok(e.pad.halfWidth > m.pad.halfWidth && m.pad.halfWidth > h.pad.halfWidth);
  assert.ok(e.limits.vy > m.limits.vy && m.limits.vy > h.limits.vy);
});

test('fuel is consumed and never goes negative', () => {
  const f = makeFlight(2);
  while (!f.state.done) step(f, autopilot(f, REFERENCE_GAINS), DT);
  assert.ok(f.state.fuel >= 0 && f.state.fuel < f.fuel0);
});

// ---------- autopilot and scoring ----------
test('the reference settings land every wind; the starting settings leave something to tune', () => {
  assert.equal(evaluate(REFERENCE_GAINS).landed, 5);
  assert.ok(evaluate(DEFAULT_GAINS).landed < 5);
});

test('the autopilot can land every wind on Easy and Medium', () => {
  for (const level of ['easy', 'medium']) {
    for (const seed of SEEDS) {
      const o = fly({ seed, level: LEVELS[level].opts }, (f) => autopilot(f, REFERENCE_GAINS));
      assert.equal(o.landed, true, `${level} wind ${seed}: ${o.reason}`);
    }
  }
});

test('landing scores beat crash scores, and softer, closer landings score higher', () => {
  const good = { landed: true, distance: 0, vy: -0.5, fuelLeft: 2000 };
  const worse = { landed: true, distance: 10, vy: -2.5, fuelLeft: 100 };
  const crash = { landed: false, distance: 5, vy: -30 };
  assert.ok(scoreFlight(good) > scoreFlight(worse) && scoreFlight(worse) > scoreFlight(crash));
});

test('settings validator accepts good values and rejects bad ones', () => {
  assert.equal(validateGains(DEFAULT_GAINS).ok, true);
  assert.equal(validateGains({ ...DEFAULT_GAINS, kp: undefined }).ok, false);
  assert.equal(validateGains({ ...DEFAULT_GAINS, kp: '2' }).ok, false);
  assert.equal(validateGains({ ...DEFAULT_GAINS, kp: NaN }).ok, false);
  assert.equal(validateGains({ ...DEFAULT_GAINS, kp: 99 }).ok, false);
  assert.equal(validateGains(null).ok, false);
});

// ---------- explanations ----------
test('every setting is explained and matches the setting ranges', () => {
  assert.deepEqual(SETTINGS.map((s) => s.key).sort(), Object.keys(GAIN_RANGES).sort());
  for (const s of SETTINGS) for (const k of ['name', 'what', 'low', 'high', 'group']) assert.ok(s[k], `${s.key} is missing ${k}`);
  assert.deepEqual(Object.keys(NUDGE).sort(), Object.keys(GAIN_RANGES).sort());
});

test('debrief: a clean landing is called clean', () => {
  const d = debrief(REFERENCE_GAINS, 1);
  assert.equal(d.outcome.landed, true);
  assert.match(d.findings[0].title, /^Clean landing/);
});

test('debrief: lighting too late says so and points at ignition altitude', () => {
  const d = debrief({ ...REFERENCE_GAINS, ignite_alt: 500 }, 1);
  const f = d.findings.find((x) => x.title.startsWith('Hit the deck too hard'));
  assert.ok(f, 'expected a hit-too-hard finding');
  assert.ok(f.fixes.some((x) => x.key === 'ignite_alt' && x.dir > 0));
});

test('debrief: a tiny touchdown speed is diagnosed as stopping in mid-air', () => {
  const d = debrief({ ...REFERENCE_GAINS, touch_speed: 0.2 }, 1);
  assert.match(d.findings[0].title, /^It stopped in mid-air/);
});

test('debrief: too little damping is diagnosed as a tumble, fixed by more damping', () => {
  const d = debrief({ ...REFERENCE_GAINS, kp: 9, kd: 0.2 }, 1);
  assert.equal(d.outcome.reason, 'Lost control');
  assert.ok(d.findings.some((f) => f.fixes.some((x) => x.key === 'kd' && x.dir > 0)));
});

test('debrief: ignoring the pad is diagnosed as a miss or a slide', () => {
  const d = debrief({ ...REFERENCE_GAINS, kx: 0, kvx: 0 }, 3);
  assert.match(d.findings[0].title, /^(Missed the pad|Slid off|Landed in the sea)/);
});

test('debrief: every finding has a title, a detail and valid fixes', () => {
  const cases = [DEFAULT_GAINS, REFERENCE_GAINS, { ...REFERENCE_GAINS, ignite_alt: 500 }, { ...REFERENCE_GAINS, kx: 0.3, kvx: 0.1 }, { ...REFERENCE_GAINS, brake_decel: 22 }];
  for (const g of cases) {
    for (const seed of [1, 3]) {
      for (const f of debrief(g, seed).findings) {
        assert.ok(f.title && f.detail);
        for (const fx of f.fixes) assert.ok(fx.key in GAIN_RANGES && (fx.dir === 1 || fx.dir === -1));
      }
    }
  }
});

// ---------- the game ----------
test('game: on Easy a player who never touches up or down still wins every wind', () => {
  assert.equal(landedCount('easy', 'lazy'), 5);
});

test('game: a careful player wins every wind on Easy and Medium', () => {
  assert.equal(landedCount('easy', 'careful'), 5);
  assert.equal(landedCount('medium', 'careful'), 5);
});

test('game: Hard is winnable, on most winds for a careful player', () => {
  assert.ok(landedCount('hard', 'careful') >= 2);
});

test('game: releasing the arrows on Easy stops the sideways drift', () => {
  const lv = LEVELS.easy;
  const f = makeFlight(1, { ...lv.opts, windScale: 0 });
  Object.assign(f.state, { y: 800, vy: -20, vx: 8, x: 0, engineOn: true, ignited: true, throttle: 0.6 });
  const st = { want: 0, vHold: -20 };
  const none = { left: false, right: false, up: false, down: false, engine: true, throttle: 0.8 };
  for (let i = 0; i < 6 * 120 && !f.state.done; i++) step(f, humanControl(f, DT, st, none, lv), DT);
  assert.ok(Math.abs(f.state.vx) < 3, `still drifting at ${f.state.vx.toFixed(1)} m/s`);
});

test('game: the lean builds up smoothly with no sudden jump or overshoot', () => {
  const lv = LEVELS.medium;
  const f = makeFlight(1, { ...lv.opts, windScale: 0 });
  Object.assign(f.state, { y: 3000, vy: -40, engineOn: true, ignited: true, throttle: 0.7, vx: 0, x: 0 });
  const st = { want: 0, vHold: -40 };
  const right = { left: false, right: true, up: false, down: false, engine: true, throttle: 0.8 };
  let prev = 0;
  let maxStep = 0;
  let maxTheta = 0;
  for (let i = 0; i < 4 * 120; i++) {
    step(f, humanControl(f, DT, st, right, lv), DT);
    maxStep = Math.max(maxStep, Math.abs(f.state.theta - prev));
    prev = f.state.theta;
    maxTheta = Math.max(maxTheta, f.state.theta / DEG);
  }
  assert.ok(maxStep < 0.4 * DEG, `lean jumped ${(maxStep / DEG).toFixed(2)}° in one step`);
  assert.ok(maxTheta < lv.lean * 1.15, `overshot to ${maxTheta.toFixed(1)}°`);
  assert.ok(maxTheta > lv.lean * 0.7, `only leaned ${maxTheta.toFixed(1)}°`);
});

test('game: the arrows turn the booster even with the engine off', () => {
  const lv = LEVELS.medium;
  const f = makeFlight(1, { ...lv.opts, windScale: 0 });
  Object.assign(f.state, { y: 3000, vy: -40 });
  const st = { want: 0, vHold: -40 };
  const left = { left: true, right: false, up: false, down: false, engine: false, throttle: 0.8 };
  for (let i = 0; i < 3 * 120; i++) step(f, humanControl(f, DT, st, left, lv), DT);
  assert.ok(f.state.theta < -3 * DEG, `theta ${(f.state.theta / DEG).toFixed(1)}°`);
});

test('game: with the engine on, the booster never climbs when the keys are left alone', () => {
  const lv = LEVELS.easy;
  const f = makeFlight(1, lv.opts);
  const st = { want: 0, vHold: 0 };
  const idle = { left: false, right: false, up: false, down: false, engine: true, throttle: 0.8 };
  let climbed = false;
  while (!f.state.done && f.state.t < 60) {
    step(f, humanControl(f, DT, st, idle, lv), DT);
    if (f.state.vy > 1.5) climbed = true;
  }
  assert.equal(climbed, false);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
