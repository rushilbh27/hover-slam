// Writes scenario candidates from rules, with no API key. Same output shape as the Claude generator.
import { mulberry32, makeFlight } from '../../public/physics.js';
import { RANGES, scenarioOpts, faultLabels } from '../../public/scenario.js';

const pick = (r, list) => list[Math.floor(r() * list.length)];
const between = ([lo, hi], r) => lo + (hi - lo) * r();

const NAMES = {
  easy: {
    low: ['Short hop', 'Low pass', 'Quick drop', 'Close to home', "Stone's throw", 'Just overhead', 'Easy does it', 'Soft start', 'Warm-up lap', 'Back garden'],
    high: ['Long fall', 'High drop', 'Top of the sky', 'Deep descent', 'Cloud dive', 'Falling star', 'Big drop', 'Edge of space', 'Skydiver', 'The plunge'],
    breezy: ['Breezy deck', 'Light crosswind', 'Sea breeze', 'Salt air', 'Gentle gusts', 'Windward side', 'Soft squall', 'Trade wind', 'Harbour breeze', 'Flag flapper'],
    calm: ['Calm approach', 'Still air', 'Easy glide', 'Quiet sea', 'Glass water', 'Dead calm', 'Slow Sunday', 'Smooth sailing', 'Mill pond', 'Hushed descent'],
  },
  medium: {
    none: ['Crosswind drop', 'Gusty approach', 'Tight pad', 'Salt wind', 'Side-eye', 'Narrow margin', 'Rough weather', 'Cold front', 'Choppy sea', 'Thin deck'],
    leak: ['Slow leak', 'Leaking tank', 'Fuel bleed', 'Dripping lines', 'Cracked seal', 'Pinhole', 'Fuel on the wind', 'Losing propellant', 'Loose valve', 'Seeping tank'],
    thrustCap: ['Tired engine', 'Throttled back', 'Weak thrust', 'Limp engine', 'Short of breath', 'Governed burn', 'Gentle push', 'Half-hearted burn', 'Clipped engine', 'Low on power'],
    dropouts: ['Brief stall', 'Hiccup', 'Quick cough', 'Missed beat', 'Short stumble', 'Flutter', 'Blink', 'Momentary lapse', 'Skip', 'Stutter step'],
  },
  hard: {
    weakSide: ['Flaky steering', 'Stubborn thruster', 'Lopsided steering', 'Sticky gimbal', 'One good side', 'Lame thruster', 'Wonky nozzle', 'Pulling sideways', 'Sluggish side', 'Drifting hand'],
    thrustCap: ['Underpowered', 'Starved engine', 'Short on thrust', 'Throttle jam', 'Capped burn', 'Thin flame', 'Tight on thrust', 'Weak shove'],
    dropouts: ['Stuttering engine', 'Engine hiccups', 'Cut-out burn', 'Flame-out scare', 'Misfire', 'Coughing engine', 'Dead air', 'Skipped beat'],
    leak: ['Bleeding tank', 'Open valve', 'Gushing line', 'Race the leak', 'Draining fast', 'Breached tank', 'Fuel in the wind', 'Runaway leak'],
    two: ['Double trouble', 'Bad day at sea', 'Nothing works', "Murphy's landing", 'Everything at once', 'Perfect storm', 'Two strikes', 'Cursed flight', 'Bad omens', 'Rough night'],
  },
};

function briefing(level, sc, flight, labels) {
  const y = Math.round(flight.state.y / 100) * 100;
  const off = Math.round(Math.abs(flight.state.x) / 10) * 10;
  const start = `Starts about ${y} m up and ${off} m off the pad.`;
  const wind = sc.opts.windScale < 0.3 ? 'Calm air.' : sc.opts.windScale < 0.8 ? 'Light wind.' : sc.opts.windScale < 1.3 ? 'Strong wind.' : 'Violent gusts.';
  if (!labels.length) {
    if (level === 'easy') return `${start} ${wind} Plenty of fuel.`;
    return sc.faults ? `Pre-flight check: nothing flagged. ${start} ${wind}` : `${start} ${wind} No faults: just you and the gusts.`; // a hidden cut-out says nothing
  }
  const f = sc.faults;
  const bits = [];
  if (f.leak) bits.push(`A fuel line is leaking at ${Math.round(f.leak)} kg/s, so don't dawdle: light early enough to steer, then follow the aim-for speed straight down.`);
  if (f.thrustCap) bits.push(`The engine only gives ${Math.round(f.thrustCap * 100)}% thrust, so light it earlier.`);
  const cuts = (f.dropouts || 0) + (f.lowCut ? 1 : 0) + (f.stutter ? 1 : 0);
  if (cuts && !f.hidden) bits.push(`The engine cuts out ${cuts === 1 ? 'once' : cuts + ' times'}, without warning${f.lowCut ? ', and one can come close to the deck' : ''}${f.mild ? ', but only briefly' : ''}. Keep some height in hand.`);
  if (f.weakSide) bits.push(`${f.weakSide === 'left' ? 'Left' : 'Right'} steering is weak${f.flicker ? ' and flickers' : ''}, so leaning ${f.weakSide} is slow. Start early if the pad is on that side.`);
  return `${bits.join(' ')} ${start}`;
}

// i: candidate number. Different i give different scenarios; the same i always gives the same one.
export function candidate(level, i, taken = new Set()) {
  const r = mulberry32(i * 7717 + (level === 'easy' ? 11 : level === 'medium' ? 23 : 37));
  const R = RANGES[level];
  const opts = {};
  for (const k of ['altScale', 'offsetScale', 'speedScale', 'windScale', 'fuel', 'padHalf']) opts[k] = between(R[k], r);
  const faults = {};
  let kinds = [];
  if (level === 'medium') {
    const x = r();
    kinds = x < 0.17 ? [] : x < 0.5 ? ['leak'] : x < 0.83 ? ['thrustCap'] : ['dropouts'];
  } else if (level === 'hard') {
    const pool = ['weakSide', 'weakSide', 'thrustCap', 'thrustCap', 'dropouts', 'dropouts', 'dropouts', 'dropouts', 'leak', 'leak'];
    const n = r() < 0.45 ? 1 : 2;
    while (kinds.length < n) {
      const k = pick(r, pool);
      if (kinds.includes(k)) continue;
      if ((k === 'weakSide' && kinds.includes('dropouts')) || (k === 'dropouts' && kinds.includes('weakSide'))) continue; // a weak side and cut-outs together are too much
      kinds.push(k);
    }
  }
  const hard = level === 'hard';
  for (const k of kinds) {
    // two faults at once are each a little gentler, so a pair stays beatable
    const pair = kinds.length === 2;
    if (k === 'leak') faults.leak = hard ? between(pair ? [75, 105] : [85, 130], r) : between([60, 100], r);
    if (k === 'thrustCap') faults.thrustCap = hard ? between(pair ? [0.66, 0.74] : [0.6, 0.74], r) : between([0.6, 0.75], r);
    if (k === 'dropouts' && !hard) { faults.dropouts = 1; faults.mild = true; } // Medium: one short cut-out, early
    if (k === 'dropouts' && hard) {
      const x = r();
      faults.dropouts = x < 0.3 ? 1 : x < 0.7 ? 2 : x < 0.93 ? 3 : 4;
      if (r() < 0.4) faults.lowCut = true;
      if (faults.dropouts <= 2 && r() < 0.25) faults.stutter = true;
      if (r() < 0.4) faults.hidden = true;
    }
    if (k === 'weakSide') { faults.weakSide = r() < 0.5 ? 'left' : 'right'; faults.weakFactor = between([0.28, 0.42], r); faults.flicker = r() < 0.4; }
  }
  if (hard && kinds.length) { opts.windScale = between([1.1, 1.45], r); opts.padHalf = between([10.5, 12], r); } // faults are the extra difficulty, so the weather and pad ease a little
  const seed = 100 + Math.floor(r() * 899000);
  const sc = { level, seed, opts, faults: kinds.length ? faults : null, source: 'rules' };
  const flight = makeFlightFor(level, sc);
  const labels = faultLabels(sc.faults);
  let pool;
  if (level === 'easy') pool = opts.windScale > 0.32 ? NAMES.easy.breezy : opts.altScale > 0.78 ? NAMES.easy.high : opts.altScale < 0.65 ? NAMES.easy.low : NAMES.easy.calm;
  else if (level === 'medium') pool = NAMES.medium[kinds[0] || 'none'];
  else pool = kinds.length === 2 ? NAMES.hard.two : NAMES.hard[kinds[0]];
  const free = pool.filter((n) => !taken.has(n)); // prefer a name this bank has not used yet
  sc.name = pick(r, free.length ? free : pool);
  sc.briefing = briefing(level, sc, flight, labels);
  return sc;
}

function makeFlightFor(level, sc) {
  return makeFlight(sc.seed, scenarioOpts(level, sc));
}

// Names repeat across a bank, so the nth repeat gets a number: "Slow leak", "Slow leak II"...
export function uniqueName(name, taken) {
  if (!taken.has(name)) return name;
  const roman = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
  for (const n of roman) if (!taken.has(`${name} ${n}`)) return `${name} ${n}`;
  return `${name} ${taken.size}`;
}

