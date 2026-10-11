// The icon set: one stroke style on a 24 grid (1.5 px line, square ends, mitred corners), drawn to sit
// beside D-DIN. Each icon is a list of SVG path/shape strings; icon(name) returns an inline <svg>.
export const ICONS = {
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  close: ['M5 5l14 14', 'M19 5L5 19'],
  engine: ['M12 2l3 4v10H9V6z', 'M10 19h4l-2 3z', 'M9 12h6'],
  retry: ['M20 12a8 8 0 1 1-2.4-5.7', 'M20 3.5V8h-4.5'],
  shuffle: ['M3 7h4l10 10h4', 'M3 17h4l2.5-2.5', 'M14.5 9.5L17 7h4', 'M18 4l3 3-3 3', 'M18 14l3 3-3 3'],
  speed: ['M4 17a8 8 0 1 1 16 0', 'M12 17l4-5', 'M12 7v1.5', 'M5.6 11l1.3.8', 'M18.4 11l-1.3.8'],
  'sound-on': ['M4 9v6h4l5 4V5L8 9z', 'M16.5 8.5a5 5 0 0 1 0 7', 'M19 6a8.5 8.5 0 0 1 0 12'],
  'sound-off': ['M4 9v6h4l5 4V5L8 9z', 'M17 9l5 6', 'M22 9l-5 6'],
  music: ['M9 18V5l11-2v13', 'M6.5 15.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M17.5 13.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'],
  'music-off': ['M9 18V5l11-2v13', 'M6.5 15.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M17.5 13.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M3 3l18 18'],
  help: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1 1-1.1 1.8', 'M12 17h.01'],
  sliders: ['M4 6h3', 'M11 6h9', 'M9 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4z', 'M4 12h9', 'M17 12h3', 'M15 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z', 'M4 18h5', 'M13 18h7', 'M11 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'],
  'arrow-right': ['M4 12h16', 'M14 6l6 6-6 6'],
  'arrow-left': ['M20 12H4', 'M10 6l-6 6 6 6'],
  'arrow-up': ['M12 20V4', 'M6 10l6-6 6 6'],
  'arrow-down': ['M12 4v16', 'M6 14l6 6 6-6'],
  'chevron-left': ['M15 5l-7 7 7 7'],
  'chevron-right': ['M9 5l7 7-7 7'],
  wind: ['M3 8h11a3 3 0 1 0-3-3', 'M3 12h16a3 3 0 1 1-3 3', 'M3 16h7'],
  check: ['M5 13l4 4 10-10'],
  plus: ['M12 5v14', 'M5 12h14'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 11v6', 'M12 7h.01'],
};

export function icon(name, size = 20) {
  const parts = ICONS[name];
  if (!parts) return '';
  return `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true" focusable="false">${parts.map((d) => `<path d="${d}"/>`).join('')}</svg>`;
}
