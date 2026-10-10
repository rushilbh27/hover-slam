import { BOOSTER, G, DEG, clamp, mass } from './physics.js';

// Game controls (default): the arrows set a lean that ramps in smoothly, and on Easy and Medium
// letting go makes it lean against its own drift. Up and down brake or speed up; letting go
// holds the current falling speed. Expert mode is the raw hardware: engine angle and throttle lever.
export function humanControl(f, dt, st, inp, lv, raw = false) {
  const s = f.state;
  const B = BOOSTER;
  const dir = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
  if (raw) return { engine: inp.engine, throttle: inp.throttle, gimbal: -dir * B.gimbalMax, rcs: dir };

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
  if (rate === 0 && st.rate) st.vHold = s.vy; // let go: hold the speed you have now, not the one the key was chasing
  st.rate = rate;
  st.vHold = clamp(Math.min(st.vHold + rate * dt, -0.8), s.vy - 6, s.vy + 6); // it never asks for a climb
  // landing assist (Easy, Medium): never let the held speed exceed a safe descent for this height
  if (lv.flare && !inp.down) st.vHold = Math.max(st.vHold, -Math.sqrt(lv.flare.c ** 2 + 2 * lv.flare.a * h));
  const throttle = (mass(s) * (G + rate + 3 * (st.vHold - s.vy))) / (B.thrustMax * Math.max(0.6, Math.cos(s.theta)));
  return { engine: inp.engine, throttle, gimbal, rcs };
}
