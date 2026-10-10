// Plain-language help for every autopilot setting, and a flight debrief that says what went wrong.
import { BOOSTER, G, DT, DEG, makeFlight, step, autopilot, mass, scoreFlight } from './physics.js';

export const SETTINGS = [
  {
    key: 'ignite_alt', name: 'Ignition altitude', unit: 'm', group: 'Landing burn',
    what: 'The height where the computer lights the engine for the landing burn.',
    low: 'Too low: not enough height left to stop. It hits the deck hard.',
    high: 'Too high: the burn lasts too long and the fuel runs out before touchdown.',
  },
  {
    key: 'brake_decel', name: 'Braking strength', unit: 'm/s²', group: 'Landing burn',
    what: 'How hard the speed plan brakes on the way down. Higher means it falls faster for longer and brakes harder at the end.',
    low: 'Too low: it slows down early, then creeps down and burns all its fuel.',
    high: 'Too high: it asks for more braking than the engine has (about 15 m/s²) and hits hard.',
  },
  {
    key: 'touch_speed', name: 'Touchdown speed', unit: 'm/s', group: 'Landing burn',
    what: 'The speed the plan aims for at the moment the legs touch. The legs survive up to 3 m/s.',
    low: 'Too low: it crawls just above the deck. It cannot hover, so it wastes fuel or bobs back up.',
    high: 'Too high: a hard landing that breaks the legs.',
  },
  {
    key: 'kv', name: 'Speed correction', unit: '', group: 'Landing burn',
    what: 'How hard the throttle reacts when the real speed is off the plan.',
    low: 'Too low: lazy throttle. It drifts off the plan and lands too fast.',
    high: 'Too high: twitchy throttle. The engine takes 0.25 s to respond, so it overshoots.',
  },
  {
    key: 'kx', name: 'Pad pull', unit: '°/m', group: 'Steering',
    what: 'How far it leans toward the pad for each metre it is off centre.',
    low: 'Too low: it ignores the pad and the wind carries it off.',
    high: 'Too high: it swings past the pad and back.',
  },
  {
    key: 'kvx', name: 'Drift brake', unit: '° per m/s', group: 'Steering',
    what: 'How far it leans against sideways drift. This is what stops it sliding.',
    low: 'Too low: it slides past the pad or lands moving sideways.',
    high: 'Too high: it fights every gust and never settles on the pad.',
  },
  {
    key: 'max_tilt', name: 'Max lean', unit: '°', group: 'Steering',
    what: 'The steepest the booster may lean while steering. It must stand up straight near the deck.',
    low: 'Too low: it cannot fight the wind or reach the pad.',
    high: 'Too high: big leans waste lift and take time to undo before touchdown.',
  },
  {
    key: 'kp', name: 'Attitude stiffness', unit: '', group: 'Balance',
    what: 'How hard the engine swivels (gimbals) to reach the lean the computer wants.',
    low: 'Too low: sluggish. Wind tips it and it cannot steer.',
    high: 'Too high: overshoots the lean and starts to wobble.',
  },
  {
    key: 'kd', name: 'Attitude damping', unit: '', group: 'Balance',
    what: 'How strongly it resists rotating. This is the shock absorber for wobble.',
    low: 'Too low: it rocks back and forth and can tip over.',
    high: 'Too high: slow to turn, so steering arrives late.',
  },
];

export const SETTING = Object.fromEntries(SETTINGS.map((s) => [s.key, s]));

const r1 = (v) => Math.round(v * 10) / 10;
const r0 = (v) => Math.round(v);

// Runs one flight, records what happened, and turns it into a debrief.
export function debrief(gains, seed, opts) {
  const f = makeFlight(seed, opts);
  const s = f.state;
  const B = BOOSTER;
  let ign = null; // state at ignition
  let fullThrottleT = 0;
  let minThrottleT = 0;
  let rose = false;
  let lowY = Infinity;
  let climb = { from: 0, peak: 0 };
  let wobble = 0;
  let lastSign = 0;
  let maxTilt = 0;
  let at500 = null;
  let crossed = false;
  let maxAbsX = 0;
  let fuelOutAt = null;
  const trace = [];
  let i = 0;
  const startX = s.x;

  while (!s.done) {
    const c = autopilot(f, gains);
    step(f, c, DT);
    if (s.engineOn && !ign) ign = { t: s.t, y: s.y, vy: s.vy, x: s.x, vx: s.vx, mass: mass(s) };
    if (s.engineOn) {
      if (c.throttle >= 0.999) fullThrottleT += DT;
      if (c.throttle <= f.minThrottle + 0.001) minThrottleT += DT;
    }
    if (ign) {
      if (s.y < lowY) lowY = s.y;
      if (s.y - lowY > climb.peak - climb.from) climb = { from: lowY, peak: s.y };
    }
    if (ign && s.fuel <= 0 && !fuelOutAt) fuelOutAt = { y: s.y, vy: s.vy, t: s.t };
    const tilt = s.theta / DEG;
    maxTilt = Math.max(maxTilt, Math.abs(tilt));
    const sign = Math.abs(tilt) > 1.5 ? Math.sign(tilt) : 0;
    if (sign && lastSign && sign !== lastSign) wobble++;
    if (sign) lastSign = sign;
    if (!at500 && s.y <= 500) at500 = { x: s.x, vx: s.vx };
    if (Math.sign(s.x) !== Math.sign(startX) && Math.abs(s.x) > 3) crossed = true;
    maxAbsX = Math.max(maxAbsX, Math.abs(s.x));
    if (i++ % 12 === 0) trace.push([s.x, s.y]);
  }
  const o = { ...s.outcome, maxG: s.maxG };
  const halfW = f.pad.halfWidth;
  const L = f.limits;

  // what the engine could do at ignition, and what stopping needed
  const burnS = ign ? s.t - ign.t : 0;
  let need = null;
  let avail = null;
  if (ign) {
    const h = Math.max(1, ign.y - B.legHeight);
    need = (ign.vy * ign.vy) / (2 * h);
    avail = B.thrustMax / ign.mass - G;
  }
  const fullBurnS = f.fuel0 / (B.thrustMax / (B.isp * G));

  const events = [];
  if (ign) events.push({ t: ign.t, text: `Engine lit at ${r0(ign.y)} m, falling at ${r0(-ign.vy)} m/s.` });
  else events.push({ t: 0, text: 'The engine never lit.' });
  if (ign && need !== null) events.push({ t: ign.t, text: `Stopping from there needed ${r1(need)} m/s² of braking. The engine could give about ${r1(avail)} m/s².` });
  if (fuelOutAt) events.push({ t: fuelOutAt.t, text: `Fuel ran out at ${r0(fuelOutAt.y)} m, still falling at ${r0(-fuelOutAt.vy)} m/s.` });
  if (at500) events.push({ t: null, text: `At 500 m it was ${r0(Math.abs(at500.x))} m from the pad, drifting ${r1(Math.abs(at500.vx))} m/s.` });
  events.push({
    t: o.time,
    text: o.reason === 'Lost control' || o.reason === 'Flew away' || o.reason === 'Timed out'
      ? `${o.reason}.`
      : `Touchdown: ${r1(Math.abs(o.vy))} m/s down, ${r1(Math.abs(o.vx))} m/s sideways, ${r1(Math.abs(o.tiltDeg))}° tilt, ${r1(o.distance)} m from centre.`,
  });

  const findings = [];
  const add = (title, detail, fixes = []) => findings.push({ title, detail, fixes });
  const g = gains;
  rose = climb.peak - climb.from > 15;
  if (rose) events.splice(events.length - 1, 0, { t: null, text: `It stopped at ${r0(climb.from)} m and climbed back up to ${r0(climb.peak)} m.` });

  if (!o.landed && rose) {
    const fixes = [];
    if (g.touch_speed < 0.8) fixes.push({ key: 'touch_speed', dir: 1 });
    if (g.kv > 2.5) fixes.push({ key: 'kv', dir: -1 });
    if (g.brake_decel < 6) fixes.push({ key: 'brake_decel', dir: 1 });
    if (!fixes.length) fixes.push({ key: 'touch_speed', dir: 1 }, { key: 'ignite_alt', dir: -1 });
    add(
      'It stopped in mid-air and flew back up.',
      `It came to a stop ${r0(climb.from)} m above the deck. The engine cannot throttle below ${r0(f.minThrottle * 100)}%, and a nearly empty booster at ${r0(f.minThrottle * 100)}% thrust is lighter than its push, so it climbed to ${r0(climb.peak)} m. This is why real boosters do a "hoverslam": the burn has to end exactly at the deck.`,
      fixes,
    );
  }

  if (o.landed) {
    const tips = [];
    if (o.distance > halfW * 0.4) tips.push(`it touched down ${r1(o.distance)} m from centre`);
    if (Math.abs(o.vy) > L.vy * 0.5) tips.push(`it landed at ${r1(Math.abs(o.vy))} m/s (softer scores more)`);
    if (o.fuelLeft < f.fuel0 * 0.1) tips.push(`only ${r0(o.fuelLeft)} kg of fuel was left`);
    add(
      'Clean landing.',
      tips.length ? `To score higher: ${tips.join('; ')}.` : 'Precise, soft and with fuel to spare. Now try it on all 5 winds.',
      tips.length && o.distance > halfW * 0.4 ? [{ key: 'kx', dir: 1 }, { key: 'kvx', dir: 1 }] : [],
    );
  }

  if (!o.landed && !rose && (o.outOfFuel || fuelOutAt)) {
    add(
      `Ran out of fuel ${fuelOutAt ? `at ${r0(fuelOutAt.y)} m` : 'near the deck'}.`,
      `There is only enough fuel for about ${r0(fullBurnS)} s of full thrust. This burn ran ${r0(burnS)} s. The engine cannot throttle below ${r0(f.minThrottle * 100)}%, so it cannot hover and wait.`,
      [],
    );
    const last = findings[findings.length - 1];
    if (need !== null && need < avail * 0.55) {
      last.detail += ` It lit far too early: stopping needed only ${r1(need)} m/s² of braking, but the engine had ${r1(avail)}.`;
      last.fixes.push({ key: 'ignite_alt', dir: -1 });
    }
    if (g.brake_decel < 6) {
      last.detail += ` The gentle speed plan (${g.brake_decel} m/s²) slowed it early and then crept down.`;
      last.fixes.push({ key: 'brake_decel', dir: 1 });
    }
    if (g.touch_speed < 0.8) last.fixes.push({ key: 'touch_speed', dir: 1 });
    if (!last.fixes.length) last.fixes.push({ key: 'ignite_alt', dir: -1 });
  }

  if (!o.landed && !o.outOfFuel && !fuelOutAt && o.checks && o.checks.vertical === false) {
    const detail = [`It touched down at ${r1(Math.abs(o.vy))} m/s. The legs survive ${L.vy} m/s.`];
    const fixes = [];
    if (need !== null && need > avail * 0.9) {
      detail.push(`It lit too late: stopping from ${r0(-ign.vy)} m/s in ${r0(ign.y)} m needed ${r1(need)} m/s² of braking, and the engine only had ${r1(avail)}.`);
      fixes.push({ key: 'ignite_alt', dir: 1 });
    }
    if (g.brake_decel > (avail ?? 15) - 1) {
      detail.push(`The speed plan asks for ${g.brake_decel} m/s² of braking, more than the engine can give.`);
      fixes.push({ key: 'brake_decel', dir: -1 });
    }
    if (g.touch_speed > 2.5) {
      detail.push(`The plan itself aims to touch down at ${g.touch_speed} m/s, too close to the limit.`);
      fixes.push({ key: 'touch_speed', dir: -1 });
    }
    if (g.kv < 0.6) {
      detail.push('The throttle barely reacts when it falls faster than planned.');
      fixes.push({ key: 'kv', dir: 1 });
    }
    if (!fixes.length) fixes.push({ key: 'ignite_alt', dir: 1 });
    add('Hit the deck too hard.', detail.join(' '), fixes);
  }

  if (!o.landed && !rose && o.checks && o.checks.onPad === false && o.reason !== 'Lost control') {
    const detail = [`It came down ${r0(o.distance)} m from the centre. The pad is ±${halfW} m.`];
    const fixes = [];
    const overshoot = crossed && o.distance > halfW;
    if (overshoot) {
      detail.push('It crossed over the pad and kept going: it leaned toward the pad but did not brake its sideways speed in time.');
      fixes.push({ key: 'kvx', dir: 1 }, { key: 'kx', dir: -1 });
    } else {
      if (g.kx < 0.05) {
        detail.push(`Pad pull is weak (${g.kx}°/m): even ${r0(Math.abs(startX))} m off it barely leans.`);
        fixes.push({ key: 'kx', dir: 1 });
      }
      if (g.max_tilt < 8) {
        detail.push(`Max lean is only ${g.max_tilt}°. That is not enough to fight the crosswind.`);
        fixes.push({ key: 'max_tilt', dir: 1 });
      }
      if (!fixes.length) {
        detail.push('It never got close enough before the last few hundred metres, when it must stand up straight.');
        fixes.push({ key: 'kx', dir: 1 }, { key: 'max_tilt', dir: 1 });
      }
    }
    add(o.distance > halfW * 3 ? 'Landed in the sea.' : 'Missed the pad.', detail.join(' '), fixes);
  }

  if (!o.landed && o.checks && o.checks.onPad !== false && o.checks.horizontal === false && o.checks.vertical !== false) {
    add('Slid off: too much sideways speed.', `It touched down moving ${r1(Math.abs(o.vx))} m/s sideways. The limit is ${L.vx} m/s. The drift brake has to cancel sideways speed before the legs touch.`, [{ key: 'kvx', dir: 1 }]);
  }

  if (!o.landed && (o.reason === 'Lost control' || o.reason === 'Tipped over' || wobble >= 6)) {
    const fixes = [];
    const detail = [];
    if (wobble >= 4 || g.kd < g.kp * 0.4) {
      detail.push(wobble >= 2 ? `It rocked from side to side ${wobble} times (up to ${r0(maxTilt)}°).` : `It swung to ${r0(maxTilt)}° and could not catch itself.`);
      if (g.kd < g.kp * 0.6) detail.push(`Damping (${g.kd}) is low for this stiffness (${g.kp}): every correction overshoots.`);
      fixes.push({ key: 'kd', dir: 1 });
      if (g.kp > 4) fixes.push({ key: 'kp', dir: -1 });
    } else if (g.kp < 1) {
      detail.push(`Attitude stiffness is ${g.kp}: the engine barely swivels, so wind and leans go uncorrected.`);
      fixes.push({ key: 'kp', dir: 1 });
    } else {
      detail.push(`It was still leaning ${r1(Math.abs(o.tiltDeg))}° at touchdown (limit ${r0(L.tilt / DEG)}°). It was still steering in the last metres.`);
      fixes.push({ key: 'kvx', dir: 1 }, { key: 'max_tilt', dir: -1 });
    }
    add(o.reason === 'Lost control' ? 'Lost control: it tumbled.' : 'Tipped over.', detail.join(' '), fixes);
  }

  if (!o.landed && !rose && (o.reason === 'Flew away' || o.reason === 'Timed out')) {
    add('It never came down.', `At ${r0(f.minThrottle * 100)}% minimum throttle the nearly empty booster is lighter than its thrust, so it climbs. The plan aimed for a speed so low it went back up.`, [{ key: 'touch_speed', dir: 1 }, { key: 'brake_decel', dir: 1 }]);
  }

  if (!findings.length) add(o.reason || 'Crashed.', 'No single setting stands out. Try one change at a time and watch the flight.', []);

  return { outcome: o, score: scoreFlight(o), events, findings, trace, rose, wobble, burnS };
}

// One nudge in the suggested direction, sized to be visible but not wild.
export const NUDGE = { ignite_alt: 150, brake_decel: 1.5, touch_speed: 0.4, kv: 0.3, kx: 0.03, kvx: 0.3, max_tilt: 3, kp: 0.8, kd: 0.8 };
