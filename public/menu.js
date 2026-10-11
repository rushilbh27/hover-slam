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
  <path d="M96 34 L196 138" class="d-fall"/>
  <path d="M196 138 C 252 196, 330 232, 406 258" class="d-burn"/>
  <g class="d-mark"><circle cx="96" cy="34" r="13"/><text x="96" y="39" text-anchor="middle">1</text></g>
  <g class="d-mark"><circle cx="196" cy="138" r="13"/><text x="196" y="143" text-anchor="middle">2</text></g>
  <g class="d-mark"><circle cx="406" cy="236" r="13"/><text x="406" y="241" text-anchor="middle">3</text></g>
  <g class="d-rocket" transform="translate(96 34) rotate(-40)"><rect x="-4" y="-22" width="8" height="26" rx="1.5"/></g>
  <g class="d-rocket" transform="translate(196 138) rotate(-40)"><rect x="-4" y="-22" width="8" height="26" rx="1.5"/><path d="M-3 4 L3 4 L0 20 Z" class="d-flame"/></g>
  <g class="d-rocket" transform="translate(406 252)"><rect x="-4" y="-26" width="8" height="26" rx="1.5"/><path d="M-4 -4 L-12 4 M4 -4 L12 4" class="d-leg"/></g>
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

export const KEYS = [
  { caps: ['Space'], text: 'Engine on or off' },
  { caps: ['←', '→'], text: 'Lean the booster' },
  { caps: ['↑'], text: 'Slow down' },
  { caps: ['↓'], text: 'Speed up. Let go of both to hold your speed' },
];

export const keycaps = (caps) => caps.map((c) => `<kbd class="cap${c === 'Space' ? ' wide' : ''}">${c}</kbd>`).join('');
