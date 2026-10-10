// Scripted players and a flight computer, used to prove a scenario can be won.
import { BOOSTER, G, DT, clamp, mass, LEVELS, REFERENCE_GAINS, step, autopilot } from '../../public/physics.js';
import { humanControl } from '../../public/controls.js';
import { scenarioFlight } from '../../public/scenario.js';

// A player who reacts five times a second. "lazy" lights the engine and steers; it never touches up or down.
// "careful" also holds the falling speed near the aim-for speed.
export function playHuman(level, sc, mode) {
  const lv = LEVELS[level];
  const f = scenarioFlight(level, sc);
  const s = f.state;
  const inp = { left: false, right: false, up: false, down: false, engine: false, throttle: 0.8 };
  const st = { want: 0, vHold: 0 };
  let react = 0;
  while (!s.done) {
    if ((react += DT) >= 0.2) {
      react = 0;
      const h = s.y - BOOSTER.legHeight;
      if (!inp.engine && s.vy < -5) {
        const brake = (0.85 * BOOSTER.thrustMax * (f.faults ? f.faults.thrustCap : 1)) / mass(s) - G;
        if (brake > 0 && h <= ((s.vy * s.vy) / (2 * brake)) * 1.3) inp.engine = true;
      }
      const aim = Math.sqrt(1 + 6 * Math.max(0, h));
      inp.up = mode === 'careful' && -s.vy > aim + 0.5;
      inp.down = mode === 'careful' && -s.vy < aim - 3;
      const toward = Math.sign(-s.x);
      const away = s.vx * toward;
      const want = clamp(Math.abs(s.x) * 0.08, 0, 8);
      inp.left = inp.right = false;
      if (h > 25 && Math.abs(s.x) > 3 && away < want - 0.5) toward > 0 ? (inp.right = true) : (inp.left = true);
    }
    step(f, humanControl(f, DT, st, inp, lv), DT);
  }
  return s.outcome;
}

// The flight computer with a few ignition heights and braking strengths: if any lands, a landing exists.
// Returns the outcome with the most fuel left among the landings, or null.
export function autopilotBest(level, sc) {
  let best = null;
  for (const ignite_alt of [1400, 1200, 1600, 1000, 1800]) {
    for (const brake_decel of [7, 5, 9]) {
      const f = scenarioFlight(level, sc);
      const g = { ...REFERENCE_GAINS, ignite_alt, brake_decel };
      while (!f.state.done) step(f, autopilot(f, g), DT);
      const o = f.state.outcome;
      if (o.landed && (!best || o.fuelLeft > best.fuelLeft)) best = o;
    }
  }
  return best;
}
export const autopilotLands = (level, sc) => Boolean(autopilotBest(level, sc));

// Who must be able to win a scenario:
// Easy by a player who only lights the engine and steers.
// Medium by a careful player, or by the flight computer with 1500 kg of fuel to spare (leaks eat the
// careful player's margin, so a leak scenario is judged on whether the fuel is really there).
// Hard by at least the flight computer: it is possible, and it takes real skill.
export function winnable(level, sc) {
  if (level === 'easy') return { ok: playHuman(level, sc, 'lazy').landed, by: 'a player who only steers' };
  if (level === 'medium') {
    if (playHuman(level, sc, 'careful').landed) return { ok: true, by: 'a careful player' };
    const b = autopilotBest(level, sc);
    return { ok: Boolean(b && b.fuelLeft >= 1500), by: 'a careful player, or the flight computer with fuel to spare' };
  }
  return { ok: autopilotLands(level, sc), by: 'the flight computer' };
}
