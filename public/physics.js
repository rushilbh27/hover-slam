// 2D booster landing physics: thrust vector control, throttle limits, fuel burn, drag and wind.
// Plain JavaScript, no dependencies; runs in the browser and in Node.
// Units: metres, seconds, kilograms, radians. x is horizontal (+ right), y is altitude.
// theta is tilt from vertical (+ = nose leaning toward +x). gimbal is the engine deflection.

export const BOOSTER = {
  height: 42, // m
  dryMass: 25600, // kg
  fuel0: 7600, // kg of propellant left for the landing burn
  thrustMax: 845e3, // N at full throttle
  minThrottle: 0.4, // engine cannot throttle below 40%: the booster cannot hover
  isp: 282, // s, sea level
  gimbalMax: (7 * Math.PI) / 180, // rad
  gimbalRate: (20 * Math.PI) / 180, // rad/s actuator speed
  throttleLag: 0.25, // s
  armCoM: 15, // m from engine to centre of mass
  dragArea: 10.5, // m^2 frontal area
  cd: 0.8,
  legHeight: 2.5, // m below the engine when legs are out
  rcsTorque: 2.5e5, // N·m from the cold-gas thrusters near the top (works with the engine off)
};

export const G = 9.81;
export const PAD = { x: 0, halfWidth: 15 };
export const LIMITS = { vy: 3, vx: 1.5, tilt: (6 * Math.PI) / 180, omega: (6 * Math.PI) / 180, distance: PAD.halfWidth };
export const SEEDS = [1, 2, 3, 4, 5];

export const DEG = Math.PI / 180;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Each seed fixes the entry conditions and the wind for one flight.
// opts (game levels): windScale, fuel, padHalf, limits, minThrottle, speedScale, altScale, offsetScale, faults
// faults (scenarios): { leak: kg/s of fuel lost in flight, thrustCap: 0..1 of full thrust,
//   dropouts: number of engine cut-outs spread over the burn, weakSide: 'left'|'right', weakFactor: 0..1 steering
//   authority on that side, flicker: true if that side also cuts in and out,
//   lowCut: one more cut-out as it nears the deck, stutter: a few quick cuts in a row,
//   mild: shorter cut-outs early in the burn (Medium), hidden: the briefing does not mention the cut-outs }
export function makeFlight(seed = 1, opts = {}) {
  const r = mulberry32(seed * 7919 + 13);
  const side = r() < 0.5 ? -1 : 1;
  const ws = opts.windScale ?? 1;
  const wind = {
    steady: (r() * 2 - 1) * 9 * ws, // m/s crosswind
    gusts: [0, 1, 2].map(() => ({ amp: (1.5 + r() * 3.5) * ws, freq: 0.05 + r() * 0.25, phase: r() * 6.283 })),
  };
  const fuel0 = opts.fuel ?? BOOSTER.fuel0;
  const halfWidth = opts.padHalf ?? PAD.halfWidth;
  const limits = { ...LIMITS, distance: halfWidth, ...(opts.limits || {}) };
  const state = {
    t: 0,
    x: side * (120 + r() * 130) * (opts.offsetScale ?? 1),
    y: (1900 + r() * 300) * (opts.altScale ?? 1),
    vx: (-side * (2 + r() * 10) + (r() * 2 - 1) * 6) * (opts.offsetScale ?? 1),
    vy: -(125 + r() * 40) * (opts.speedScale ?? 1),
    theta: (r() * 2 - 1) * 3 * DEG,
    omega: (r() * 2 - 1) * 0.6 * DEG,
    fuel: fuel0,
    gimbal: 0,
    throttle: 0,
    ignited: false,
    engineOn: false,
    done: false,
    outcome: null,
    maxG: 0,
    burnT: 0, // seconds the engine has been running
    cut: false, // true while an engine cut-out fault is active
    lowDone: false, // the low cut-out has fired
    lowEnd: 0, // when it ends
    rcsEff: 0, // thruster command after faults
  };
  return { seed, wind, state, fuel0, pad: { x: PAD.x, halfWidth }, limits, minThrottle: opts.minThrottle ?? BOOSTER.minThrottle, faults: makeFaults(opts.faults, seed) };
}

// Faults get their own random stream so a flight without faults is exactly what it always was.
export function makeFaults(f, seed) {
  if (!f) return null;
  const r = mulberry32(seed * 104729 + 7);
  const dropouts = [];
  // cut-outs are spread over the whole burn, one per slot so they never pile up, and the engine gives no warning
  const n = f.dropouts || 0;
  const from = f.mild ? 2 : 1.5, to = f.mild ? 12 : 18;
  for (let i = 0; i < n; i++) dropouts.push({ at: from + (i + r()) * ((to - from) / n), dur: f.mild ? 0.3 + r() * 0.2 : 0.4 + r() * 0.5 });
  if (f.stutter) { // a few quick cuts in a row, like a fuel-feed fault
    const at0 = 3 + r() * 11;
    for (let k = 0; k < 4; k++) dropouts.push({ at: at0 + k * 0.55, dur: 0.18 + r() * 0.12 });
  }
  dropouts.sort((a, b) => a.at - b.at);
  return {
    leak: f.leak || 0,
    leakStart: f.leakStart ?? 2, // seconds into the flight when the leak opens
    thrustCap: f.thrustCap ?? 1,
    dropouts, // seconds after the engine is lit
    lowCut: f.lowCut ? { alt: 70 + r() * 110, dur: 0.4 + r() * 0.3 } : null, // fires once, at this height above the deck
    weakSide: f.weakSide || null,
    weakFactor: f.weakFactor ?? 1,
    flicker: Boolean(f.flicker),
    noise: r() * 1000,
  };
}

export function windAt(wind, t, y) {
  let w = wind.steady;
  for (const g of wind.gusts) w += g.amp * Math.sin(6.283 * g.freq * t + g.phase);
  return w * Math.min(1, Math.max(0.15, y / 400)); // wind dies down near the surface
}

export function mass(s) {
  return BOOSTER.dryMass + s.fuel;
}

// Advances one step. control = { engine: bool, throttle: 0..1, gimbal: rad (command) }.
export function step(flight, control, dt) {
  const s = flight.state;
  if (s.done) return s;
  const B = BOOSTER;

  // engine on/off; once lit it stays lit until the pilot cuts it or fuel runs out
  const wantOn = Boolean(control.engine) && s.fuel > 0;
  if (wantOn) s.ignited = true;
  s.engineOn = wantOn;

  // throttle with lag, limited to 40-100% while the engine runs
  const thrCmd = s.engineOn ? clamp(control.throttle, flight.minThrottle ?? B.minThrottle, 1) : 0;
  s.throttle += (thrCmd - s.throttle) * Math.min(1, dt / B.throttleLag);
  if (!s.engineOn) s.throttle = 0;

  // faults
  const F = flight.faults;
  if (s.engineOn) s.burnT += dt;
  if (F && F.lowCut && !s.lowDone && s.engineOn && s.y - B.legHeight <= F.lowCut.alt) { s.lowDone = true; s.lowEnd = s.t + F.lowCut.dur; }
  s.cut = Boolean(F && s.engineOn && (F.dropouts.some((d) => s.burnT >= d.at && s.burnT < d.at + d.dur) || s.t < s.lowEnd));
  if (F && F.leak > 0 && s.t >= F.leakStart && s.fuel > 0) s.fuel = Math.max(0, s.fuel - F.leak * dt);
  let gCmd = clamp(control.gimbal || 0, -B.gimbalMax, B.gimbalMax);
  let rcsCmd = clamp(control.rcs || 0, -1, 1);
  if (F && F.weakSide) {
    // positive gimbal and negative thruster command both lean the booster left
    const left = F.weakSide === 'left';
    let k = F.weakFactor;
    if (F.flicker) {
      const h = Math.sin(Math.floor(s.t / 0.35) * 12.9898 + F.noise) * 43758.5453;
      if (h - Math.floor(h) < 0.4) k = 0;
    }
    if (Math.sign(gCmd) === (left ? 1 : -1)) gCmd *= k;
    if (Math.sign(rcsCmd) === (left ? -1 : 1)) rcsCmd *= k;
  }
  s.rcsEff = rcsCmd;
  const dg = clamp(gCmd - s.gimbal, -B.gimbalRate * dt, B.gimbalRate * dt);
  s.gimbal += dg;

  const m = mass(s);
  const T = s.engineOn && !s.cut ? s.throttle * B.thrustMax * (F ? F.thrustCap : 1) : 0;
  const I = (m * B.height * B.height) / 12;

  // thrust acts along the body, deflected by the gimbal
  const a = s.theta + s.gimbal;
  let fx = T * Math.sin(a);
  let fy = T * Math.cos(a);
  // engine deflection at the base turns the booster the other way
  let torque = -T * B.armCoM * Math.sin(s.gimbal);
  torque += rcsCmd * B.rcsTorque;

  // drag against the air, with wind
  const w = windAt(flight.wind, s.t, s.y);
  const rvx = s.vx - w;
  const rvy = s.vy;
  const rv = Math.hypot(rvx, rvy);
  const rho = 1.225 * Math.exp(-s.y / 8500);
  const q = 0.5 * rho * B.cd * B.dragArea * rv;
  fx -= q * rvx;
  fy -= q * rvy;
  // side wind pushes on the long body and slightly tips it
  torque += 0.5 * rho * 1.2 * 3.7 * B.height * (w - s.vx) * Math.abs(w - s.vx) * 0.6 * Math.cos(s.theta);
  torque -= 2.5e5 * s.omega; // aerodynamic and slosh damping

  const ax = fx / m;
  const ay = fy / m - G;
  s.maxG = Math.max(s.maxG, Math.hypot(ax, ay + G) / G);
  s.vx += ax * dt;
  s.vy += ay * dt;
  s.omega += (torque / I) * dt;
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  s.theta += s.omega * dt;
  if (T > 0) s.fuel = Math.max(0, s.fuel - (T / (B.isp * G)) * dt);
  s.t += dt;

  // touchdown when the legs reach the ground
  if (s.y <= B.legHeight) {
    s.done = true;
    s.y = B.legHeight;
    const L = flight.limits || LIMITS;
    const halfW = flight.pad ? flight.pad.halfWidth : PAD.halfWidth;
    const dist = Math.abs(s.x - PAD.x);
    const checks = {
      vertical: Math.abs(s.vy) <= L.vy,
      horizontal: Math.abs(s.vx) <= L.vx,
      upright: Math.abs(s.theta) <= L.tilt,
      steady: Math.abs(s.omega) <= L.omega,
      onPad: dist <= L.distance,
    };
    const landed = Object.values(checks).every(Boolean);
    s.outcome = {
      landed,
      outOfFuel: s.fuel <= 0,
      checks,
      vx: s.vx,
      vy: s.vy,
      tiltDeg: (s.theta * 180) / Math.PI,
      distance: dist,
      fuelLeft: s.fuel,
      time: s.t,
      reason: landed ? 'Landed' : s.fuel <= 0 && !checks.vertical ? 'Ran out of fuel' : !checks.onPad ? (dist <= halfW * 3 ? 'Missed the pad' : 'Landed in the sea') : !checks.vertical ? 'Hit too hard' : !checks.upright || !checks.steady ? 'Tipped over' : 'Slid off: too much sideways speed',
    };
  } else if (s.t > 120 || Math.abs(s.theta) > 1.2 || s.y > 4000) {
    s.done = true;
    s.outcome = { landed: false, reason: Math.abs(s.theta) > 1.2 ? 'Lost control' : s.y > 4000 ? 'Flew away' : 'Timed out', distance: Math.abs(s.x), fuelLeft: s.fuel, time: s.t, vx: s.vx, vy: s.vy, tiltDeg: (s.theta * 180) / Math.PI, checks: {} };
  }
  return s;
}

// ---------- autopilot: the thing you (or Claude) tune ----------
// Starting gains for players: lands sometimes. Tuning them is the game.
export const DEFAULT_GAINS = {
  ignite_alt: 1200, // m: when to light the landing burn
  brake_decel: 7, // m/s^2: how hard the speed profile brakes
  touch_speed: 1.2, // m/s: target speed at touchdown
  kv: 1.2, // vertical speed loop gain
  kx: 0.07, // deg of tilt per metre off the pad
  kvx: 0.7, // deg of tilt per m/s sideways
  max_tilt: 12, // deg
  kp: 2.5, // attitude gain
  kd: 1.2, // attitude damping
};

// A set that lands all five test flights (found by a grid search). Used by tests only.
export const REFERENCE_GAINS = { ignite_alt: 1400, brake_decel: 7, touch_speed: 1.2, kv: 1.2, kx: 0.12, kvx: 1, max_tilt: 15, kp: 2.5, kd: 2.2 };

export const GAIN_RANGES = {
  ignite_alt: [300, 2000, 10],
  brake_decel: [3, 25, 0.5],
  touch_speed: [0.2, 5, 0.1],
  kv: [0.1, 5, 0.05],
  kx: [0, 0.3, 0.005],
  kvx: [0, 4, 0.05],
  max_tilt: [2, 25, 0.5],
  kp: [0, 10, 0.1],
  kd: [0, 10, 0.1],
};

export function validateGains(g) {
  const errors = [];
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(GAIN_RANGES)) {
    const v = g && g[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${k} must be a number`);
    else if (v < lo || v > hi) errors.push(`${k} must be between ${lo} and ${hi} (got ${v})`);
    else out[k] = v;
  }
  return { ok: errors.length === 0, errors, gains: errors.length ? null : out };
}

export function autopilot(flight, g) {
  const s = flight.state;
  const B = BOOSTER;
  const h = Math.max(0, s.y - B.legHeight);
  const engine = s.ignited || s.y <= g.ignite_alt;

  // vertical: follow a braking speed profile down to touch_speed
  // speed profile v^2 = c^2 + 2*a*h: brakes evenly at brake_decel and reaches touch_speed at the ground
  const vTarget = -Math.sqrt(g.touch_speed * g.touch_speed + 2 * g.brake_decel * h);
  // feed-forward the planned braking, correct the remaining error with kv
  const aUp = G + g.brake_decel + g.kv * (vTarget - s.vy);
  const thrust = (mass(s) * aUp) / Math.max(0.6, Math.cos(s.theta));
  const cap = flight.faults ? flight.faults.thrustCap : 1; // the computer knows when the engine is limited
  const throttle = clamp(thrust / (B.thrustMax * cap), 0, 1);

  // lateral: lean toward the pad, stand up straight near the ground
  const upright = clamp(h / 60, 0.15, 1);
  const maxTilt = g.max_tilt * DEG * upright;
  const thetaDes = clamp((g.kx * (PAD.x - s.x) - g.kvx * s.vx) * DEG, -maxTilt, maxTilt);

  // attitude: gimbal opposite to the turn we want (see torque sign in step)
  const err = thetaDes - s.theta;
  const gimbal = clamp(-(g.kp * err - g.kd * s.omega), -B.gimbalMax, B.gimbalMax);
  return { engine, throttle, gimbal };
}

export const DT = 1 / 120;

// Manual-control game levels. opts go straight into makeFlight.
export const LEVELS = {
  easy: {
    label: 'Easy',
    blurb: 'Light wind, a big pad and extra fuel. The engine throttles down to 15%, so it can hover. The landing assist softens the last metres, and it stops drifting by itself when you let go of the arrows.',
    opts: { windScale: 0.25, fuel: 11000, padHalf: 22, minThrottle: 0.15, speedScale: 0.8, altScale: 0.75, offsetScale: 0.35, limits: { vy: 6, vx: 3, tilt: 12 * DEG, omega: 12 * DEG } },
    flare: { c: 1.5, a: 3 }, // landing assist: caps the falling speed near the deck
    lean: 12, target: true, driftHold: true, aimDecel: 3, // aimDecel: the braking the on-screen aim-for speed assumes
  },
  medium: {
    label: 'Medium',
    blurb: 'Real crosswind, a smaller pad, and you pick the moment to light the engine. Light early enough to steer, around 1,600 m, then follow the aim-for speed down to the deck. Lands at up to 3.2 m/s. The landing assist only helps in the last few metres, and it still stops drifting when you let go of the arrows.',
    opts: { windScale: 1.0, fuel: 8600, padHalf: 14, minThrottle: 0.3, offsetScale: 0.85, limits: { vy: 3.2, vx: 1.6, tilt: 6.5 * DEG, omega: 6.5 * DEG } },
    flare: { c: 1.4, a: 6 },
    lean: 12, target: true, driftHold: true, aimDecel: 5,
  },
  hard: {
    label: 'Hard',
    blurb: 'The real thing. Strong gusts, a narrow pad, and an engine that can\'t throttle below 40%, so it can never hover: you have to time one burn that ends exactly at the deck. Land at under 3 m/s down, 1.5 m/s sideways and 6° of tilt. No landing assist, and nothing stops your drift but you.',
    opts: { windScale: 1.4, fuel: 8200, padHalf: 11, minThrottle: 0.4, limits: { vy: 3, vx: 1.5, tilt: 6 * DEG, omega: 6 * DEG } },
    flare: null,
    lean: 10, target: true, driftHold: false, aimDecel: 5,
  },
};

export function simulate(gains, seed, keepTrace = false) {
  const f = makeFlight(seed);
  const trace = [];
  let i = 0;
  while (!f.state.done) {
    step(f, autopilot(f, gains), DT);
    if (keepTrace && i++ % 12 === 0) trace.push([f.state.x, f.state.y]);
  }
  return { ...f.state.outcome, maxG: f.state.maxG, trace };
}

// Score 0..100 for one flight: landing counts most, then precision, softness and fuel.
export function scoreFlight(o) {
  if (!o.landed) {
    const near = Math.max(0, 1 - o.distance / 300);
    const soft = Math.max(0, 1 - Math.abs(o.vy) / 60);
    return Math.round(25 * near * soft);
  }
  const precision = 1 - o.distance / PAD.halfWidth;
  const softness = 1 - Math.abs(o.vy) / LIMITS.vy;
  const fuel = o.fuelLeft / BOOSTER.fuel0;
  return Math.round(50 + 25 * precision + 15 * softness + 10 * Math.min(1, fuel * 3));
}

export function evaluate(gains, seeds = SEEDS) {
  const flights = seeds.map((seed) => {
    const o = simulate(gains, seed);
    return { seed, landed: o.landed, reason: o.reason, score: scoreFlight(o), vy: +o.vy.toFixed(2), vx: +o.vx.toFixed(2), tilt_deg: +o.tiltDeg.toFixed(1), miss_m: +o.distance.toFixed(1), fuel_left_kg: Math.round(o.fuelLeft) };
  });
  return {
    landed: flights.filter((f) => f.landed).length,
    mean_score: Math.round(flights.reduce((a, f) => a + f.score, 0) / flights.length),
    flights,
  };
}
