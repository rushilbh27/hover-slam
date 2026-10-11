// Markup for the start screens: the how-to-play diagrams and the level cards.
// Pure functions that return strings, so they can be tested without a browser.
import { G } from './physics.js';

export const LEVEL_COPY = {
  easy: {
    tagline: 'Calm air, a wide pad and an engine that can hover.',
    detail: 'It forgives an early light. Start here.',
  },
  medium: {
    tagline: 'Real crosswind and a small pad.',
    detail: 'Light early enough to steer, then follow the aim-for speed.',
  },
  hard: {
    tagline: 'Night, rain and gusts. The engine can never hover.',
    detail: 'One burn that ends at the deck, and things break.',
  },
};

// The speed the on-screen "aim for" number asks for at a given height.
export const aimSpeed = (h, decel = 5) => Math.sqrt(1.44 + 2 * decel * Math.max(0, h));

// Falling speed against height for a sensible burn: free fall, light at lightAt, brake until the speed
// meets the aim-for line, then follow it down. Heights in metres, speeds in m/s.
export function descentProfile({ top = 2000, v0 = 150, lightAt = 1600, decel = 15, aimDecel = 5, step = 10 } = {}) {
  const pts = [];
  let v = v0;
  let lit = false;
  let joined = null;
  for (let h = top; h >= 0; h -= step) {
    if (h === top) { pts.push([v, h]); continue; }
    if (!lit && h <= lightAt) lit = true;
    if (!lit) v = Math.sqrt(v * v + 2 * G * step);
    else if (v > aimSpeed(h, aimDecel)) {
      v = Math.max(aimSpeed(h, aimDecel), v - (decel / v) * step);
      if (v <= aimSpeed(h, aimDecel) + 0.01 && !joined) joined = [v, h];
    } else {
      v = aimSpeed(h, aimDecel);
      if (!joined) joined = [v, h];
    }
    pts.push([v, h]);
  }
  return { pts, joined, lightAt };
}

const num = (n) => Math.round(n * 10) / 10;

// Side view of a whole descent with the three stages marked on the path.
// The rocket and the drawn line share these two curves, so it can never leave its path.
const FALL_PATH = 'M330 24 C 345 60, 360 100, 372 140';
const BURN_PATH = 'C 378 172, 406 196, 406 244';

export function descentDiagram() {
  return `
<svg class="diagram" viewBox="0 0 560 330" role="img" aria-label="A booster falls, lights its engine, brakes down toward the landing platform and touches down on the green landing zone.">
  <defs>
    <linearGradient id="d-sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0b1020"/><stop offset=".55" stop-color="#2a2150"/><stop offset=".85" stop-color="#a14a52"/><stop offset="1" stop-color="#f0894f"/>
    </linearGradient>
  </defs>
  <rect width="560" height="270" fill="url(#d-sky)"/>
  <rect y="270" width="560" height="60" fill="#0b121d"/>
  <rect x="318" y="262" width="176" height="9" fill="#586272"/>
  <rect x="318" y="271" width="176" height="5" fill="#1c2430"/>
  <rect x="372" y="260" width="68" height="3" class="d-pad"/>
  <path d="${FALL_PATH}" class="d-fall"/>
  <path d="M372 140 ${BURN_PATH}" class="d-burn"/>
  <g class="d-anim" aria-hidden="true">
    <g class="d-rocket">
      <g class="d-legs"><path d="M1 -4 L13 -12 M1 4 L13 12"><animate attributeName="opacity" values="0;0;1;1" keyTimes="0;0.66;0.72;1" dur="10s" repeatCount="indefinite"/></path></g>
      <rect x="-30" y="-4" width="32" height="8"/>
      <path d="M-30 -4 L-37 0 L-30 4 Z"/>
      <rect x="-26" y="-7" width="4" height="14" class="d-fin"/>
      <rect x="2" y="-3" width="3" height="6" class="d-skirt"/>
      <g><animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes="0;0.43;0.44;0.93;0.94;1" dur="10s" repeatCount="indefinite"/>
        <path d="M5 -3 L26 0 L5 3 Z" class="d-flame"><animateTransform attributeName="transform" type="scale" values="1 1;1.35 0.85;0.9 1.05;1 1" dur="0.28s" repeatCount="indefinite" additive="sum"/></path></g>
      <animateMotion dur="10s" repeatCount="indefinite" rotate="auto" calcMode="spline" keyPoints="0;0.52;1;1" keyTimes="0;0.43;0.93;1" keySplines="0.4 0 1 1;0 0 0.3 1;0 0 1 1" path="${FALL_PATH} ${BURN_PATH}"/>
    </g>
  </g>
  <g class="d-mark"><circle cx="330" cy="24" r="13"/><text x="330" y="29" text-anchor="middle">1</text></g>
  <g class="d-mark"><circle cx="372" cy="140" r="13"/><text x="372" y="145" text-anchor="middle">2</text></g>
  <g class="d-mark"><circle cx="440" cy="236" r="13"/><text x="440" y="241" text-anchor="middle">3</text></g>
  <g class="d-tag"><text x="310" y="22" text-anchor="end">FALL</text><text x="310" y="36" text-anchor="end" class="d-sub">engine off</text></g>
  <g class="d-tag"><text x="352" y="136" text-anchor="end">BURN</text><text x="352" y="150" text-anchor="end" class="d-sub">Space, then brake</text></g>
  <g class="d-tag"><text x="458" y="232">TOUCH DOWN</text><text x="458" y="246" class="d-sub">on the green</text></g>
  <g class="d-read" aria-hidden="true">
    <text x="20" y="28" class="d-rd">FALLING <tspan class="d-rv">150 m/s</tspan><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.42;0.43;1" calcMode="discrete" dur="10s" repeatCount="indefinite"/></text>
    <text x="20" y="28" class="d-rd">ENGINE ON, SLOWING <tspan class="d-rv">150 to 3 m/s</tspan><animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes="0;0.42;0.43;0.7;0.71;1" calcMode="discrete" dur="10s" repeatCount="indefinite"/></text>
    <text x="20" y="28" class="d-rd">LEGS OUT, DOWN AT <tspan class="d-rv">2 m/s</tspan><animate attributeName="opacity" values="0;0;1;1" keyTimes="0;0.7;0.71;1" calcMode="discrete" dur="10s" repeatCount="indefinite"/></text>
  </g>
  <g class="d-static">
    <g class="d-rocket" transform="translate(330 24) rotate(-14)"><rect x="-4" y="-30" width="8" height="32" rx="1.5"/></g>
    <g class="d-rocket" transform="translate(372 140) rotate(-16)"><rect x="-4" y="-30" width="8" height="32" rx="1.5"/><path d="M-3 2 L3 2 L0 22 Z" class="d-flame"/></g>
    <g class="d-rocket" transform="translate(406 252)"><rect x="-4" y="-32" width="8" height="32" rx="1.5"/><path d="M-4 -4 L-12 4 M4 -4 L12 4" class="d-leg"/></g>
  </g>
  <text x="30" y="318" class="d-axis">about 2,000 m up</text>
  <text x="430" y="318" class="d-axis" text-anchor="end">the landing platform</text>
</svg>`;
}

// Falling speed against height: the aim-for line, and a pilot's speed settling onto it.
export function speedDiagram() {
  const W = 560, H = 236, L = 62, R = 22, T = 12, B = 34;
  const vmax = 190, hmax = 2000;
  const x = (v) => num(L + (v / vmax) * (W - L - R));
  const y = (h) => num(T + ((hmax - h) / hmax) * (H - T - B));
  const prof = descentProfile();
  const aim = [];
  for (let h = hmax; h >= 0; h -= 20) aim.push(`${x(aimSpeed(h))} ${y(h)}`);
  const pilot = prof.pts.map(([v, h]) => `${x(v)} ${y(h)}`).join(' L');
  const lightY = y(prof.lightAt);
  const lightX = x(prof.pts.find((p) => p[1] <= prof.lightAt)[0]);
  const j = prof.joined || [60, 1000];
  const grid = [0, 50, 100, 150].map((v) => `<line x1="${x(v)}" y1="${T}" x2="${x(v)}" y2="${H - B}" class="g-grid"/><text x="${x(v)}" y="${H - B + 16}" text-anchor="middle" class="g-tick">${v}</text>`).join('');
  const hgrid = [0, 500, 1000, 1500, 2000].map((h) => `<line x1="${L}" y1="${y(h)}" x2="${W - R}" y2="${y(h)}" class="g-grid"/><text x="${L - 8}" y="${y(h) + 4}" text-anchor="end" class="g-tick">${h}</text>`).join('');
  return `
<svg class="diagram" viewBox="0 0 ${W} ${H}" role="img" aria-label="Falling speed against height. The pilot lights the engine near 1,600 metres, slows down onto the aim-for line, then follows it to the deck.">
  ${grid}${hgrid}
  <rect x="${L}" y="${y(40)}" width="${x(3) - L}" height="${y(0) - y(40)}" class="g-safe"/>
  <path d="M${aim.join(' L')}" class="g-aim"/>
  <path d="M${pilot}" class="g-pilot"/>
  <circle cx="${lightX}" cy="${lightY}" r="5" class="g-dot"/>
  <text x="${lightX - 10}" y="${lightY - 9}" text-anchor="end" class="g-note">light the engine</text>
  <text x="${x(j[0]) + 16}" y="${y(j[1]) + 22}" class="g-note">slowed onto the aim-for line</text>
  <text x="${x(aimSpeed(1350)) - 10}" y="${y(1350) + 4}" text-anchor="end" class="g-note g-aimnote">aim-for speed</text>
  <text x="${x(3) + 8}" y="${y(0) - 6}" class="g-note g-safenote">under 3 m/s at the deck</text>
  <text x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle" class="g-axis">falling speed, metres per second</text>
  <text transform="translate(12 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle" class="g-axis">height, metres</text>
</svg>`;
}

// A small scene for each level card, in that level's own light.
export function levelThumb(level) {
  const L = {
    easy: { sky: ['#0c1330', '#3b2a5c', '#c4565a', '#ffb06a'], sea: '#101a2e', y: 74, tilt: 0, flame: true, deco: '<circle cx="232" cy="112" r="15" fill="#ffe0aa"/>' },
    medium: { sky: ['#050816', '#1c1a44', '#6a3a78', '#d4756d'], sea: '#0a1020', y: 62, tilt: 5, flame: false, deco: '<circle cx="224" cy="40" r="11" fill="#eef2fc"/><circle cx="224" cy="40" r="22" fill="#eef2fc" opacity=".08"/>' },
    hard: { sky: ['#03060b', '#0b1520', '#1a2a3a', '#2e4254'], sea: '#070d14', y: 52, tilt: -8, flame: false, deco: Array.from({ length: 22 }, (_, i) => `<path d="M${14 + i * 13} ${(i * 37) % 90} l-6 16" stroke="#9ab4d4" stroke-width="1" opacity=".35"/>`).join('') + '<path d="M196 0 L184 36 L200 40 L180 84" stroke="#e4ecff" stroke-width="2" fill="none" opacity=".8"/>' },
  }[level];
  const id = `t-${level}`;
  const flame = L.flame ? '<path d="M-3 0 L3 0 L0 17 Z" class="d-flame"/>' : '';
  return `
<svg class="thumb" viewBox="0 0 300 170" aria-hidden="true">
  <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${L.sky.map((c, i) => `<stop offset="${[0, 0.45, 0.8, 1][i]}" stop-color="${c}"/>`).join('')}</linearGradient></defs>
  <rect width="300" height="130" fill="url(#${id})"/>
  <rect y="130" width="300" height="40" fill="${L.sea}"/>
  ${L.deco}
  <rect x="100" y="124" width="112" height="7" fill="#566174"/>
  <rect x="100" y="131" width="112" height="4" fill="#1a212c"/>
  <rect x="136" y="122" width="40" height="2.5" fill="#5be3a4"/>
  <rect x="102" y="114" width="9" height="10" fill="#8a4b3a"/><rect x="201" y="116" width="9" height="8" fill="#3f5f7a"/>
  <g transform="translate(150 ${L.y}) rotate(${L.tilt})"><rect x="-4" y="-34" width="8" height="34" rx="1.5" fill="#e9edf2"/><rect x="-4" y="-34" width="8" height="5" fill="#1b2029"/><path d="M-4 -4 L-11 4 M4 -4 L11 4" stroke="#1b2029" stroke-width="2" fill="none"/>${flame}</g>
</svg>`;
}

// The numbers that tell the levels apart, read straight from the level settings.
export function levelSpecs(lv) {
  const o = lv.opts, w = o.windScale;
  return [
    ['Pad', `${Math.round(o.padHalf * 2)} m`],
    ['Wind', w <= 0.5 ? 'Light' : w <= 1.1 ? 'Cross' : 'Gusts'],
    ['Min throttle', `${Math.round(o.minThrottle * 100)}%`],
    ['Land under', `${o.limits.vy} m/s`],
  ];
}

export const KEYS = [
  { caps: ['Space'], text: 'Engine on or off' },
  { caps: ['←', '→'], text: 'Lean the booster' },
  { caps: ['↑'], text: 'Slow down' },
  { caps: ['↓'], text: 'Speed up. Let go of both to keep your speed' },
];

export const keycaps = (caps) => caps.map((c) => `<kbd class="cap${c === 'Space' ? ' wide' : ''}">${c}</kbd>`).join('');
