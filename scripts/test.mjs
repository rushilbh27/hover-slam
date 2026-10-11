// Run with: npm test. No dependencies, no browser.
import assert from 'node:assert/strict';
import { BOOSTER, G, DT, DEG, clamp, mass, SEEDS, LEVELS, GAIN_RANGES, DEFAULT_GAINS, REFERENCE_GAINS, makeFlight, step, autopilot, validateGains, scoreFlight, evaluate } from '../public/physics.js';
import { SETTINGS, NUDGE, debrief } from '../public/explain.js';
import { humanControl } from '../public/controls.js';
import { RANGES, FAULT_RANGES, validateScenario, activeFaults, faultLabels, scenarioFlight, nextScenario, bagProgress } from '../public/scenario.js';
import { BANK } from '../public/bank.js';
import { winnable, playKeys } from './lib/bots.mjs';
import { proposeScenarios, SCHEMA } from './lib/claude.mjs';
import { candidate } from './lib/procedural.mjs';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let passed = 0;
const pending = [];
function test(name, fn) {
  // run in order: each test waits for the one before it, so output stays in order even for async tests
  const prev = pending[pending.length - 1] || Promise.resolve();
  pending.push(
    prev.then(async () => {
      try {
        await fn();
        passed++;
        console.log(`ok   ${name}`);
      } catch (e) {
        console.error(`FAIL ${name}\n     ${e.message}`);
        process.exitCode = 1;
      }
    }),
  );
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

const WINDS = Array.from({ length: 20 }, (_, i) => i + 1);
const landedCount = (level, mode, winds = SEEDS) => winds.filter((seed) => player(level, mode)(seed).landed).length;

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

test('the throttle floor follows the level: 15% Easy, 30% Medium, the real 40% on Hard', () => {
  assert.equal(makeFlight(1, LEVELS.easy.opts).minThrottle, 0.15);
  assert.equal(makeFlight(1, LEVELS.medium.opts).minThrottle, 0.3);
  assert.equal(makeFlight(1, LEVELS.hard.opts).minThrottle, 0.4);
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

test('every level can be won: the reference autopilot lands most winds, even on Hard', () => {
  for (const level of ['easy', 'medium', 'hard']) {
    let n = 0;
    for (let seed = 1; seed <= 10; seed++) if (fly({ seed, level: LEVELS[level].opts }, (f) => autopilot(f, REFERENCE_GAINS)).landed) n++;
    assert.ok(n >= 7, `${level}: only ${n} of 10`);
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

test('game: a careful player wins every Easy wind and some Medium winds', () => {
  assert.equal(landedCount('easy', 'careful'), 5);
  const medium = landedCount('medium', 'careful', WINDS);
  assert.ok(medium >= 8, `Medium should be winnable by a careful player, got ${medium} of 20`);
});

test('game: Medium and Hard need real piloting, so a player who only lights the engine loses', () => {
  assert.equal(landedCount('medium', 'lazy', WINDS), 0);
  assert.equal(landedCount('hard', 'lazy', WINDS), 0);
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

// ---------- regression: Medium must be winnable by someone following the HUD ----------
test('Medium can hover until the tank is nearly empty (the engine floor is below the weight of the nearly empty booster)', () => {
  const floorThrust = LEVELS.medium.opts.minThrottle * BOOSTER.thrustMax;
  const weight = (fuelKg) => (BOOSTER.dryMass + fuelKg) * G;
  assert.ok(floorThrust < weight(1000), 'at 1000 kg left the booster must be able to descend gently');
  assert.ok(floorThrust < weight(3000), 'and at the 3000 kg a normal landing ends with');
});

const plain = (seed) => ({ seed, opts: {}, faults: null }); // a level exactly as it is, with no scenario changes

test('Medium: a key pilot who lights early and follows the aim-for speed lands most of the time (the bug that made Medium crash)', () => {
  let n = 0;
  for (const seed of WINDS) if (playKeys('medium', plain(seed), { igniteAt: 1600, aimDecel: LEVELS.medium.aimDecel }).landed) n++;
  assert.ok(n >= 16, `only ${n} of 20 landed`);
});

test('Hard can be won with the keys: a good pilot who lights early lands some winds, but far from all', () => {
  let n = 0;
  for (const seed of WINDS) if (playKeys('hard', plain(seed), { igniteAt: 1800, aimDecel: LEVELS.hard.aimDecel }).landed) n++;
  assert.ok(n >= 3 && n <= 14, `${n} of 20`);
});

test('the aim-for speed matches each level: gentle on Easy, firmer where the engine cannot hover', () => {
  assert.equal(LEVELS.easy.aimDecel, 3);
  assert.equal(LEVELS.medium.aimDecel, 5);
  assert.equal(LEVELS.hard.aimDecel, 5);
});

test('the speed hold never asks for a climb, and letting go of the keys holds the speed you have', () => {
  const lv = LEVELS.medium;
  const f = makeFlight(1, { ...lv.opts, windScale: 0 });
  Object.assign(f.state, { y: 1500, vy: -30, engineOn: true, ignited: true, throttle: 0.5 });
  const st = { want: 0, vHold: -30 };
  const up = { left: false, right: false, up: true, down: false, engine: true, throttle: 0.8 };
  const none = { left: false, right: false, up: false, down: false, engine: true, throttle: 0.8 };
  for (let i = 0; i < 2 * 120; i++) step(f, humanControl(f, DT, st, up, lv), DT); // slow right down
  assert.ok(st.vHold <= -0.8, `the target is ${st.vHold.toFixed(1)} m/s, which is not a descent`);
  const vAtRelease = f.state.vy;
  for (let i = 0; i < 3 * 120; i++) step(f, humanControl(f, DT, st, none, lv), DT);
  assert.ok(Math.abs(f.state.vy - vAtRelease) < 3, `speed drifted from ${vAtRelease.toFixed(1)} to ${f.state.vy.toFixed(1)}`);
  assert.ok(f.state.vy < 0, 'it must still be descending');
});

// ---------- faults ----------
const freeFall = (faults, seconds, engine = false) => {
  const f = makeFlight(3, { ...LEVELS.hard.opts, faults });
  Object.assign(f.state, { y: 3800, vy: engine ? -150 : -50 }); // below the 4000 m ceiling, with room to fall
  const none = { engine, throttle: 1, gimbal: 0 };
  for (let i = 0; i < seconds * 120; i++) step(f, none, DT);
  return f;
};

test('a flight with no faults is exactly what it was before faults existed', () => {
  assert.deepEqual(makeFlight(2, LEVELS.medium.opts).state, makeFlight(2, { ...LEVELS.medium.opts, faults: undefined }).state);
  assert.equal(makeFlight(2, LEVELS.medium.opts).faults, null);
});

test('fault: a leak drains fuel at its rate once it opens', () => {
  const a = freeFall(null, 10);
  const b = freeFall({ leak: 60, leakStart: 2 }, 10);
  assert.ok(Math.abs(a.state.fuel - b.state.fuel - 60 * 8) < 1, `lost ${(a.state.fuel - b.state.fuel).toFixed(0)} kg, expected 480`);
});

test('fault: a thrust cap really limits thrust', () => {
  const full = freeFall(null, 2, true);
  const half = freeFall({ thrustCap: 0.5 }, 2, true);
  assert.ok(full.state.vy - half.state.vy > 5, 'the capped engine should brake clearly less');
  assert.ok(half.state.fuel > full.state.fuel, 'and burn less fuel');
});

test('fault: engine cut-outs are spread over the whole burn, and thrust stops while one is active', () => {
  const f = makeFlight(9, { ...LEVELS.hard.opts, faults: { dropouts: 2 } });
  assert.equal(f.faults.dropouts.length, 2);
  for (const d of f.faults.dropouts) assert.ok(d.at >= 1.5 && d.at + d.dur <= 19.5, `cut-out at ${d.at.toFixed(1)}`);
  const wide = makeFlight(9, { ...LEVELS.hard.opts, faults: { dropouts: 4 } }).faults.dropouts;
  assert.ok(wide[3].at - wide[0].at > 6, 'four cut-outs are spread out, not bunched');
  Object.assign(f.faults, { dropouts: [{ at: 1.5, dur: 1 }] }); // pin one cut-out so the check below is exact
  Object.assign(f.state, { y: 3800, vy: -150 });
  let cutSteps = 0;
  let fuelDuringCut = 0;
  for (let i = 0; i < 10 * 120; i++) {
    const before = f.state.fuel;
    step(f, { engine: true, throttle: 1, gimbal: 0 }, DT);
    if (f.state.cut) { cutSteps++; fuelDuringCut += before - f.state.fuel; }
  }
  assert.ok(cutSteps > 0.5 * 120, 'expected at least half a second of cut-out');
  assert.equal(Math.round(fuelDuringCut), 0, 'no fuel burns while the engine is cut');
});

test('fault: a low cut-out fires once, near the deck, and only while the engine burns', () => {
  const f = makeFlight(9, { ...LEVELS.hard.opts, faults: { lowCut: true } });
  const lc = f.faults.lowCut;
  assert.ok(lc.alt >= 70 && lc.alt <= 180 && lc.dur >= 0.4 && lc.dur <= 0.7, 'height and length are in range');
  Object.assign(f.state, { y: 500, vy: -80 });
  let cutAt = null, cuts = 0, was = false;
  for (let i = 0; i < 40 * 120 && !f.state.done; i++) {
    step(f, { engine: true, throttle: 0.4, gimbal: 0 }, DT);
    if (f.state.cut && !was) { cuts++; cutAt = f.state.y; }
    was = f.state.cut;
  }
  assert.equal(cuts, 1, 'exactly one low cut-out');
  assert.ok(cutAt - 2.5 <= lc.alt + 5 && cutAt > 20, `it fired at ${cutAt.toFixed(0)} m`);
  const idle = makeFlight(9, { ...LEVELS.hard.opts, faults: { lowCut: true } });
  Object.assign(idle.state, { y: 100, vy: -5 });
  step(idle, { engine: false, throttle: 0, gimbal: 0 }, DT);
  assert.equal(idle.state.lowDone, false, 'with the engine off it does not use up the cut-out');
});

test('fault: a stutter is four quick cuts in a row', () => {
  const d = makeFlight(9, { ...LEVELS.hard.opts, faults: { stutter: true } }).faults.dropouts;
  assert.equal(d.length, 4);
  for (const x of d) assert.ok(x.dur < 0.35, 'each one is short');
  assert.ok(d[3].at - d[0].at < 2.5, 'and they come close together');
});

test('fault: weak left steering turns left less than right, and the other way round', () => {
  const turn = (side, cmd) => {
    const f = makeFlight(3, { ...LEVELS.hard.opts, faults: { weakSide: side, weakFactor: 0.3 } });
    Object.assign(f.state, { y: 3800, vy: -50, theta: 0, omega: 0 });
    for (let i = 0; i < 120; i++) step(f, { engine: false, throttle: 0, gimbal: 0, rcs: cmd }, DT);
    return Math.abs(f.state.theta);
  };
  // negative thruster command leans left
  assert.ok(turn('left', -1) < 0.45 * turn('left', 1), 'left weak: leaning left should be much slower');
  assert.ok(turn('right', 1) < 0.45 * turn('right', -1), 'right weak: leaning right should be much slower');
});

test('fault: a flickering side sometimes does nothing at all', () => {
  const f = makeFlight(3, { ...LEVELS.hard.opts, faults: { weakSide: 'left', weakFactor: 0.5, flicker: true } });
  let off = 0;
  let on = 0;
  for (let i = 0; i < 6 * 120; i++) {
    step(f, { engine: false, throttle: 0, gimbal: 0, rcs: -1 }, DT);
    if (f.state.rcsEff === 0) off++; else on++;
  }
  assert.ok(off > 0.15 * 6 * 120 && on > 0.3 * 6 * 120, `off ${off}, on ${on}`);
});

test('the flight computer and the speed hold both allow for a thrust limit', () => {
  const a = makeFlight(3, { ...LEVELS.hard.opts, faults: { thrustCap: 0.7 } });
  const b = makeFlight(3, LEVELS.hard.opts);
  Object.assign(a.state, { y: 400, vy: -75, ignited: true });
  Object.assign(b.state, { y: 400, vy: -75, ignited: true });
  assert.ok(autopilot(a, REFERENCE_GAINS).throttle > autopilot(b, REFERENCE_GAINS).throttle);
});

// ---------- scenarios ----------
const good = () => ({ name: 'Slow leak', briefing: 'A fuel line is leaking.', seed: 4242, opts: { altScale: 1, offsetScale: 0.9, speedScale: 1, windScale: 1, fuel: 8800, padHalf: 14 }, faults: { leak: 50 } });

test('scenario validator accepts a good scenario and rejects bad ones', () => {
  assert.equal(validateScenario(good(), 'medium').ok, true);
  assert.equal(validateScenario(good(), 'easy').ok, false, 'no faults on Easy');
  assert.equal(validateScenario({ ...good(), faults: { leak: 50, thrustCap: 0.8 } }, 'medium').ok, false, 'one fault only on Medium');
  assert.equal(validateScenario({ ...good(), faults: { weakSide: 'left', weakFactor: 0.4 } }, 'medium').ok, false, 'steering faults are Hard only');
  assert.equal(validateScenario({ ...good(), opts: { ...good().opts, windScale: 5 } }, 'medium').ok, false);
  assert.equal(validateScenario({ ...good(), faults: { leak: 9000 } }, 'medium').ok, false);
  assert.equal(validateScenario({ ...good(), seed: 0.5 }, 'medium').ok, false);
  assert.equal(validateScenario({ ...good(), name: '' }, 'medium').ok, false);
  assert.equal(validateScenario(good(), 'nowhere').ok, false);
  assert.equal(validateScenario(null, 'medium').ok, false);
  const clean = validateScenario({ ...good(), faults: { leak: 0, thrustCap: 1, dropouts: 0, weakSide: null } }, 'medium');
  assert.equal(clean.ok, true);
  assert.equal(clean.scenario.faults, null, 'neutral values mean no faults');
});

test('fault labels say what is wrong in plain words', () => {
  const t = faultLabels({ leak: 60, thrustCap: 0.8, dropouts: 1, weakSide: 'left', flicker: true }).map((l) => l.text).join(' | ');
  assert.match(t, /Fuel leak: 60 kg\/s/);
  assert.match(t, /limited to 80% thrust/);
  assert.match(t, /cut-outs/);
  assert.match(t, /Left steering weak and flickering/);
});

test('the bank has at least 24 scenarios per level, all valid, with unique ids, seeds and names', () => {
  for (const level of ['easy', 'medium', 'hard']) {
    const list = BANK[level];
    assert.ok(list.length >= 24, `${level} has ${list.length}`);
    assert.equal(new Set(list.map((s) => s.id)).size, list.length, `${level}: duplicate ids`);
    assert.equal(new Set(list.map((s) => s.seed)).size, list.length, `${level}: duplicate seeds`);
    assert.equal(new Set(list.map((s) => s.name)).size, list.length, `${level}: duplicate names`);
    for (const sc of list) {
      const v = validateScenario(sc, level);
      assert.ok(v.ok, `${sc.id}: ${v.errors.join('; ')}`);
      assert.ok(sc.briefing.length > 20, `${sc.id} needs a real briefing`);
    }
  }
});

test('the bank follows the level rules: Easy has no faults, Medium at most one, Hard one or two', () => {
  for (const sc of BANK.easy) assert.equal(activeFaults(sc.faults).length, 0);
  for (const sc of BANK.medium) assert.ok(activeFaults(sc.faults).length <= 1);
  for (const sc of BANK.hard) assert.ok([1, 2].includes(activeFaults(sc.faults).length), `${sc.id}`);
});

test('a hidden cut-out gets no chip and no mention, but still counts as a fault', () => {
  const f = { dropouts: 2, lowCut: true, hidden: true };
  assert.equal(faultLabels(f).length, 0);
  assert.deepEqual(activeFaults(f), ['dropouts']);
  assert.match(faultLabels({ dropouts: 2, lowCut: true }).map((l) => l.text).join(), /3 while it burns/);
});

test('cut-out variety is range-checked: up to four on Hard, one mild one on Medium, no extras on Medium', () => {
  const hardOpts = { altScale: 1.05, offsetScale: 1.1, speedScale: 1.05, windScale: 1.3, fuel: 8000, padHalf: 11 };
  const hard = (faults) => validateScenario({ ...good(), opts: hardOpts, faults }, 'hard');
  assert.equal(hard({ dropouts: 4, lowCut: true, stutter: true, hidden: true }).ok, true);
  assert.equal(hard({ dropouts: 5 }).ok, false);
  assert.equal(hard({ weakSide: 'left', weakFactor: 0.1 }).ok, true, 'steering can now be very weak');
  const med = (faults) => validateScenario({ ...good(), faults }, 'medium');
  assert.equal(med({ dropouts: 1, mild: true }).ok, true);
  assert.equal(med({ dropouts: 2 }).ok, false);
  assert.equal(med({ dropouts: 1, lowCut: true }).ok, false);
  assert.equal(hard({ dropouts: 1, mild: true }).ok, false);
});

test('the harder bank: Hard has real cut-outs, big leaks, weak engines and steering; Medium has no cap above 75%', () => {
  const hardFaults = BANK.hard.map((s) => s.faults);
  const withCuts = hardFaults.filter((f) => (f.dropouts || 0) + (f.lowCut ? 1 : 0) + (f.stutter ? 1 : 0) > 0);
  assert.ok(withCuts.length >= 12, `cut-outs in ${withCuts.length} Hard scenarios`);
  assert.ok(withCuts.some((f) => f.lowCut), 'some cut-outs come low');
  assert.ok(withCuts.some((f) => f.hidden), 'some are unannounced');
  assert.ok(withCuts.some((f) => f.dropouts >= 2), 'some come more than once');
  for (const f of hardFaults) {
    if (f.thrustCap) assert.ok(f.thrustCap <= 0.74, `Hard thrust ${f.thrustCap}`);
    if (f.leak) assert.ok(f.leak >= 70 && f.leak <= 90, `Hard leak ${f.leak}`);
    if (f.weakSide) assert.ok(f.weakFactor <= 0.42, `Hard steering ${f.weakFactor}`);
  }
  for (const sc of BANK.medium) {
    const f = sc.faults || {};
    if (f.thrustCap) assert.ok(f.thrustCap <= 0.75, `Medium thrust ${f.thrustCap}`);
    if (f.leak) assert.ok(f.leak >= 60 && f.leak <= 90, `Medium leak ${f.leak}`);
    if (f.dropouts) assert.ok(f.mild && f.dropouts === 1, 'Medium cut-outs are single and mild');
  }
  assert.ok(BANK.medium.filter((s) => s.faults && s.faults.dropouts).length >= 3, 'Medium has a few mild cut-outs');
});

test('the bank has a real mix of faults: every kind appears at least 4 times where allowed', () => {
  const count = (level, kind) => BANK[level].filter((s) => activeFaults(s.faults).includes(kind)).length;
  for (const k of ['leak', 'thrustCap']) assert.ok(count('medium', k) >= 4, `medium ${k}`);
  for (const k of ['leak', 'thrustCap', 'dropouts', 'weakSide']) assert.ok(count('hard', k) >= 4, `hard ${k}`);
  assert.ok(BANK.hard.some((s) => s.faults.weakSide === 'left') && BANK.hard.some((s) => s.faults.weakSide === 'right'));
});

test('the bank varies the start: Easy includes both low and high drops', () => {
  const alts = BANK.easy.map((s) => scenarioFlight('easy', s).state.y);
  assert.ok(Math.min(...alts) < 1300 && Math.max(...alts) > 1700, `${Math.min(...alts).toFixed(0)} to ${Math.max(...alts).toFixed(0)} m`);
});

test('every scenario in the bank can be won (checked by the same players that built it)', () => {
  for (const level of ['easy', 'medium', 'hard']) {
    for (const sc of BANK[level]) assert.ok(winnable(level, sc).ok, `${sc.id} ${sc.name} cannot be won`);
  }
});

test('scenarios are deterministic: the same scenario flies the same flight', () => {
  const sc = BANK.hard[0];
  const run = () => { const f = scenarioFlight('hard', sc); while (!f.state.done) step(f, autopilot(f, REFERENCE_GAINS), DT); return f.state.outcome; };
  assert.deepEqual(run(), run());
});

test('the rule-based generator is deterministic and only writes valid scenarios', () => {
  assert.deepEqual(candidate('hard', 7), candidate('hard', 7));
  for (const level of ['easy', 'medium', 'hard']) for (let i = 1; i <= 25; i++) {
    const v = validateScenario(candidate(level, i), level);
    assert.ok(v.ok, `${level} ${i}: ${v.errors.join('; ')}`);
  }
});

// ---------- the shuffle bag ----------
const memory = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, JSON.parse(JSON.stringify(v))) }; };
const seeded = (n) => () => { n = (n * 16807) % 2147483647; return n / 2147483647; };

test('the shuffle bag plays every scenario once before any repeat', () => {
  const st = memory();
  const rnd = seeded(5);
  const seen = [];
  for (let i = 0; i < BANK.medium.length; i++) seen.push(nextScenario('medium', BANK, st, rnd).id);
  assert.equal(new Set(seen).size, BANK.medium.length);
  assert.deepEqual(bagProgress('medium', BANK, st), { played: BANK.medium.length, total: BANK.medium.length });
});

test('after the bag empties it reshuffles, and never repeats the last scenario straight away', () => {
  const st = memory();
  const rnd = seeded(11);
  let last = null;
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < BANK.easy.length; i++) {
      const id = nextScenario('easy', BANK, st, rnd).id;
      assert.notEqual(id, last, 'same scenario twice in a row');
      last = id;
    }
  }
});

test('the bag survives a bank that changes: removed scenarios are skipped, new ones appear next round', () => {
  const st = memory();
  const rnd = seeded(3);
  const first = nextScenario('hard', BANK, st, rnd);
  const smaller = { ...BANK, hard: BANK.hard.filter((s) => s.id !== first.id).slice(0, 10) };
  for (let i = 0; i < 25; i++) {
    const next = nextScenario('hard', smaller, st, rnd);
    assert.ok(smaller.hard.some((s) => s.id === next.id), `${next && next.id} is not in the smaller bank`);
  }
});

test('levels keep separate bags', () => {
  const st = memory();
  const a = nextScenario('easy', BANK, st, seeded(1));
  const b = nextScenario('hard', BANK, st, seeded(1));
  assert.equal(a.level, 'easy');
  assert.equal(b.level, 'hard');
  assert.equal(bagProgress('easy', BANK, st).played, 1);
  assert.equal(bagProgress('medium', BANK, st).played, 0);
});

// ---------- Claude as scenario writer (against a fake API) ----------
async function fakeApi(replies) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      const text = replies[Math.min(requests.length - 1, replies.length - 1)];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 800, output_tokens: 300 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { requests, server, base: `http://127.0.0.1:${server.address().port}` };
}
const claudeScenario = (over = {}) => ({
  name: 'Cracked seal',
  briefing: 'A seal is failing. The tank loses fuel all the way down, so keep the burn short.',
  seed: 31337,
  opts: { altScale: 1, offsetScale: 0.9, speedScale: 1, windScale: 1, fuel: 8800, padHalf: 14 },
  faults: { leak: 55, thrustCap: 1, dropouts: 0, weakSide: 'none', weakFactor: 1, flicker: false },
  ...over,
});

test('Claude scenario call: right request, keeps valid scenarios, drops invalid ones', async () => {
  const bad = claudeScenario({ name: 'Too much', faults: { leak: 55, thrustCap: 0.7, dropouts: 0, weakSide: 'none', weakFactor: 1, flicker: false } }); // two faults on Medium
  const api = await fakeApi([JSON.stringify({ scenarios: [claudeScenario(), bad] })]);
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = api.base;
  try {
    const out = await proposeScenarios({ level: 'medium', count: 2, avoid: ['Slow leak'] });
    assert.equal(out.scenarios.length, 1);
    assert.equal(out.scenarios[0].name, 'Cracked seal');
    assert.equal(out.scenarios[0].source, 'claude');
    assert.equal(out.scenarios[0].faults.leak, 55);
    assert.equal(out.rejected.length, 1);
    assert.match(out.rejected[0].errors.join(' '), /at most 1 fault/);
    const r = api.requests[0];
    assert.equal(r.url, '/v1/messages');
    assert.equal(r.headers['x-api-key'], 'test-key');
    assert.equal(r.body.model, 'claude-opus-5-5');
    assert.equal(r.body.fallbacks, 'default');
    assert.match(String(r.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
    assert.equal(r.body.output_config.format.type, 'json_schema');
    assert.deepEqual(r.body.output_config.format.schema, SCHEMA);
    assert.equal(r.body.tool_choice, undefined, 'must not force tool choice');
    assert.match(r.body.messages[0].content, /Slow leak/);
    assert.match(r.body.system, /MEDIUM/);
    assert.match(r.body.system, /thrustCap/);
  } finally {
    api.server.close();
  }
});

test('Claude scenario call: retries once when the answer is not JSON', async () => {
  const api = await fakeApi(['Sure! Here are some scenarios', JSON.stringify({ scenarios: [claudeScenario()] })]);
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = api.base;
  try {
    const out = await proposeScenarios({ level: 'medium', count: 1 });
    assert.equal(out.attempts, 2);
    assert.match(api.requests[1].body.messages[0].content, /not valid JSON/);
  } finally {
    api.server.close();
  }
});

test('Claude scenario call: gives up with a clear error when nothing valid comes back', async () => {
  const api = await fakeApi([JSON.stringify({ scenarios: [claudeScenario({ faults: { leak: 55, thrustCap: 1, dropouts: 0, weakSide: 'left', weakFactor: 0.4, flicker: false } })] })]);
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = api.base;
  try {
    await assert.rejects(() => proposeScenarios({ level: 'medium', count: 1 }), /did not return any valid scenarios/);
  } finally {
    api.server.close();
  }
});

test('the scenario schema asks for exactly the fields the game uses', () => {
  const item = SCHEMA.properties.scenarios.items;
  assert.deepEqual(Object.keys(item.properties).sort(), ['briefing', 'faults', 'name', 'opts', 'seed']);
  assert.deepEqual(Object.keys(item.properties.faults.properties).sort(), ['dropouts', 'flicker', 'leak', 'thrustCap', 'weakFactor', 'weakSide']);
  assert.deepEqual(Object.keys(item.properties.opts.properties).sort(), ['altScale', 'fuel', 'offsetScale', 'padHalf', 'speedScale', 'windScale']);
});

// ---------- the look: fonts, icons, no leftovers ----------
test('the fonts the stylesheet names are in the repo, with their licence', () => {
  const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'style.css'), 'utf8');
  const files = [...css.matchAll(/url\("(fonts\/[^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(files.length >= 3, 'the stylesheet loads the D-DIN files');
  for (const f of files) assert.ok(fs.existsSync(path.join(import.meta.dirname, '..', 'public', f)), f);
  assert.ok(fs.existsSync(path.join(import.meta.dirname, '..', 'public', 'fonts', 'OFL-1.1.txt')), 'the font licence ships with the fonts');
  assert.ok(!/Big Shoulders|Instrument Sans|fonts\.googleapis/.test(css + fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8')), 'no web fonts left over');
});

test('the interface uses no orange: it is left to the scene art and the flame', () => {
  const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'style.css'), 'utf8');
  assert.ok(!/#ff6a28|#ff8a54|#ff7b3b|#ec5c18|255, 106, 40/i.test(css), 'old signal orange in the stylesheet');
});

test('every icon is a set of drawn paths, and the helper returns an inline svg', async () => {
  const { ICONS, icon } = await import('../public/icons.js');
  assert.ok(Object.keys(ICONS).length >= 20);
  for (const [name, parts] of Object.entries(ICONS)) {
    assert.ok(Array.isArray(parts) && parts.length > 0 && parts.every((d) => /^M/.test(d)), name);
    assert.match(icon(name), /^<svg class="icon"[^>]*viewBox="0 0 256 256"/);
  }
  assert.equal(icon('no-such-icon'), '');
});

test('the canvas helpers draw a callout, a crosshair and a path', async () => {
  const { drawCallout, drawCrosshair, drawPath } = await import('../public/ui.js');
  const calls = [];
  const ctx = new Proxy({}, { get: (_, k) => (k === 'measureText' ? () => ({ width: 60 }) : (...a) => calls.push([k, ...a])), set: () => true });
  drawCallout(ctx, 100, 100, 'Booster', { dir: 1 });
  drawCrosshair(ctx, 50, 50);
  drawPath(ctx, [[0, 0], [10, 10], [20, 5]], { dashed: true });
  const names = calls.map((c) => c[0]);
  for (const n of ['lineTo', 'fillText', 'arc', 'setLineDash', 'stroke']) assert.ok(names.includes(n), n);
  assert.equal(calls.find((c) => c[0] === 'fillText')[1], 'BOOSTER', 'labels are set in capitals');
});

test('every element id the game looks up exists in the page', () => {
  const dir = path.join(import.meta.dirname, '..', 'public');
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const markup = read('index.html') + read('app.js') + read('menu.js'); // some ids are made by templates in the scripts
  const ids = new Set([...read('app.js').matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]));
  const missing = [...ids].filter((id) => !markup.includes(`id="${id}"`) && !markup.includes(`id=\\"${id}\\"`));
  assert.deepEqual(missing, [], `ids with no element: ${missing.join(', ')}`);
  for (const id of ['focus', 'dev', 'strip', 'edge', 'dock', 'drawer', 'd-engine', 'd-menu', 't-vy', 't-alt', 't-dx', 't-vx', 't-tilt']) assert.ok(ids.has(id) || read('index.html').includes(`id="${id}"`), id);
});

// ---------- the single-file build ----------
test('the single-file build is valid JavaScript with the bank inside it', () => {
  execFileSync(process.execPath, [path.join(import.meta.dirname, 'build-standalone.mjs')], { stdio: 'ignore' });
  const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'dist', 'hoverslam.html'), 'utf8');
  const script = html.slice(html.indexOf('<script type="module">') + 22, html.lastIndexOf('</script>'));
  assert.ok(script.includes('const BANK ='), 'bank is bundled');
  assert.ok(html.includes('data:font/woff2;base64,') && !html.includes('url("fonts/'), 'the fonts are inside the file');
  assert.ok(script.includes('const ICONS ='), 'icons are bundled');
  const file = path.join(os.tmpdir(), `hoverslam-check-${process.pid}.mjs`);
  fs.writeFileSync(file, script);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } finally {
    fs.unlinkSync(file);
  }
});

await Promise.all(pending);
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
