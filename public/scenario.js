// Scenarios: a named variation of a level (higher drop, fuel leak, a flaky thruster...).
// A scenario is plain data, so it can be written by hand, by rules or by Claude, and checked the same way.
import { LEVELS, makeFlight } from './physics.js';

// What each level may vary. Anything outside these ranges is rejected.
export const RANGES = {
  easy: { altScale: [0.5, 1.0], offsetScale: [0.2, 0.8], speedScale: [0.7, 0.95], windScale: [0.1, 0.5], fuel: [9000, 12000], padHalf: [18, 24], faults: [], maxFaults: 0 },
  medium: { altScale: [0.85, 1.15], offsetScale: [0.7, 1.1], speedScale: [0.9, 1.05], windScale: [0.7, 1.2], fuel: [8200, 9400], padHalf: [12, 16], faults: ['leak', 'thrustCap'], maxFaults: 1 },
  hard: { altScale: [0.95, 1.2], offsetScale: [0.9, 1.3], speedScale: [1.0, 1.1], windScale: [1.1, 1.7], fuel: [7600, 8600], padHalf: [9, 12], faults: ['leak', 'thrustCap', 'dropouts', 'weakSide'], maxFaults: 2 },
};
export const FAULT_RANGES = { leak: [25, 140], thrustCap: [0.55, 0.92], dropouts: [1, 3], weakFactor: [0.2, 0.7] };
export const FACTORS = ['altScale', 'offsetScale', 'speedScale', 'windScale', 'fuel', 'padHalf'];

const inRange = (v, [lo, hi]) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

// Which faults a scenario really has, whatever the neutral values the writer used for "none".
export function activeFaults(f) {
  const out = [];
  if (!f) return out;
  if (f.leak > 0) out.push('leak');
  if (typeof f.thrustCap === 'number' && f.thrustCap < 1) out.push('thrustCap');
  if (f.dropouts > 0) out.push('dropouts');
  if (f.weakSide) out.push('weakSide');
  return out;
}

// Returns { ok, errors, scenario } where scenario is a clean copy with only the known fields.
export function validateScenario(sc, level = sc && sc.level) {
  const errors = [];
  const R = RANGES[level];
  if (!R) return { ok: false, errors: [`unknown level ${level}`], scenario: null };
  if (!sc || typeof sc !== 'object') return { ok: false, errors: ['scenario must be an object'], scenario: null };
  const name = String(sc.name || '').trim();
  const briefing = String(sc.briefing || '').trim();
  if (!name || name.length > 40) errors.push('name must be 1 to 40 characters');
  if (!briefing || briefing.length > 320) errors.push('briefing must be 1 to 320 characters');
  if (!Number.isInteger(sc.seed) || sc.seed < 1 || sc.seed > 999999) errors.push('seed must be a whole number from 1 to 999999');
  const o = sc.opts || {};
  const opts = {};
  for (const k of FACTORS) {
    if (!inRange(o[k], R[k])) errors.push(`${k} must be between ${R[k][0]} and ${R[k][1]} on ${level} (got ${o[k]})`);
    else opts[k] = round(o[k], k === 'fuel' ? 0 : 2);
  }
  const f = sc.faults || {};
  const act = activeFaults(f);
  const faults = {};
  for (const a of act) if (!R.faults.includes(a)) errors.push(`${a} is not allowed on ${level}`);
  if (act.length > R.maxFaults) errors.push(`${level} allows at most ${R.maxFaults} fault${R.maxFaults === 1 ? '' : 's'} (got ${act.length})`);
  if (act.includes('leak')) {
    if (!inRange(f.leak, FAULT_RANGES.leak)) errors.push(`leak must be between ${FAULT_RANGES.leak[0]} and ${FAULT_RANGES.leak[1]} kg/s`);
    else faults.leak = round(f.leak, 0);
  }
  if (act.includes('thrustCap')) {
    if (!inRange(f.thrustCap, FAULT_RANGES.thrustCap)) errors.push(`thrustCap must be between ${FAULT_RANGES.thrustCap[0]} and ${FAULT_RANGES.thrustCap[1]}`);
    else faults.thrustCap = round(f.thrustCap, 2);
  }
  if (act.includes('dropouts')) {
    if (!Number.isInteger(f.dropouts) || !inRange(f.dropouts, FAULT_RANGES.dropouts)) errors.push('dropouts must be a whole number from 1 to 3');
    else faults.dropouts = f.dropouts;
  }
  if (act.includes('weakSide')) {
    if (f.weakSide !== 'left' && f.weakSide !== 'right') errors.push("weakSide must be 'left' or 'right'");
    else faults.weakSide = f.weakSide;
    if (!inRange(f.weakFactor, FAULT_RANGES.weakFactor)) errors.push(`weakFactor must be between ${FAULT_RANGES.weakFactor[0]} and ${FAULT_RANGES.weakFactor[1]}`);
    else faults.weakFactor = round(f.weakFactor, 2);
    faults.flicker = Boolean(f.flicker);
  }
  if (errors.length) return { ok: false, errors, scenario: null };
  const scenario = { id: sc.id ? String(sc.id) : undefined, level, name, briefing, seed: sc.seed, opts, faults: act.length ? faults : null };
  if (sc.source) scenario.source = String(sc.source);
  return { ok: true, errors, scenario };
}

// The level's own settings, with the scenario's variations on top.
export function scenarioOpts(level, sc) {
  return { ...LEVELS[level].opts, ...sc.opts, faults: sc.faults || undefined };
}

export function scenarioFlight(level, sc) {
  return makeFlight(sc.seed, scenarioOpts(level, sc));
}

// What to show the player for each fault.
export function faultLabels(f) {
  const out = [];
  if (!f) return out;
  if (f.leak > 0) out.push({ key: 'leak', text: `Fuel leak: ${Math.round(f.leak)} kg/s`, short: 'Fuel leak', tone: 'bad' });
  if (typeof f.thrustCap === 'number' && f.thrustCap < 1) out.push({ key: 'thrustCap', text: `Engine limited to ${Math.round(f.thrustCap * 100)}% thrust`, short: 'Low thrust', tone: 'warn' });
  if (f.dropouts > 0) out.push({ key: 'dropouts', text: `Engine cut-outs: ${f.dropouts === 1 ? 'one' : f.dropouts} while it burns`, short: 'Engine cut-outs', tone: 'bad' });
  if (f.weakSide) out.push({ key: 'weakSide', text: `${f.weakSide === 'left' ? 'Left' : 'Right'} steering weak${f.flicker ? ' and flickering' : ''}`, short: `${f.weakSide === 'left' ? 'Left' : 'Right'} steering`, tone: 'bad' });
  return out;
}

// ---------- shuffle bag ----------
// Every scenario in a level is played once, in random order, before any repeats. The same one
// never comes up twice in a row, even across a reshuffle. Progress is kept in `store`
// (anything with get(key, fallback) and set(key, value)).
export function shuffle(list, rnd = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function nextScenario(level, bank, store, rnd = Math.random) {
  const all = bank[level] || [];
  if (!all.length) return null;
  const ids = all.map((s) => s.id);
  let bag = (store.get(`hs.bag.${level}`, []) || []).filter((id) => ids.includes(id));
  const last = store.get(`hs.last.${level}`, null);
  if (!bag.length) {
    bag = shuffle(ids, rnd);
    if (bag.length > 1 && bag[0] === last) [bag[0], bag[1]] = [bag[1], bag[0]];
  }
  const id = bag.shift();
  store.set(`hs.bag.${level}`, bag);
  store.set(`hs.last.${level}`, id);
  return all.find((s) => s.id === id);
}

export function bagProgress(level, bank, store) {
  const total = (bank[level] || []).length;
  const bag = store.get(`hs.bag.${level}`, null);
  if (bag === null) return { played: 0, total }; // nothing played yet
  const ids = new Set((bank[level] || []).map((s) => s.id));
  return { played: total - bag.filter((id) => ids.has(id)).length, total };
}
