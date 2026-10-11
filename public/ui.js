// Drawing helpers for the instrument look on a 2D canvas: hairline leader lines with a caps label,
// a crosshair marker, and a flown-path line. They draw in screen pixels; the caller does the projecting.
export const LOOK = {
  line: 'rgba(255, 255, 255, 0.85)',
  faint: 'rgba(255, 255, 255, 0.45)',
  blue: '#6e9bff',
  amber: '#f2c14e',
  font: '600 12px "D-DIN", "Arial Narrow", Arial, sans-serif',
};

// A callout: a thin line from the anchor out at an angle, then along under the label, like the labels on a
// technical diagram. dir is 1 to run right and -1 to run left; rise is how far it lifts (negative drops).
export function drawCallout(ctx, x, y, label, { dir = 1, rise = -34, bend = 30, run = 110, color = LOOK.line, font = LOOK.font, tracking = '1px' } = {}) {
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
  ctx.font = font;
  if ('letterSpacing' in ctx) ctx.letterSpacing = tracking;
  const text = label.toUpperCase();
  const w = Math.max(run, ctx.measureText(text).width + 6);
  const kx = x + dir * bend, ky = y + rise;
  ctx.beginPath();
  ctx.moveTo(x, y); ctx.lineTo(kx, ky); ctx.lineTo(kx + dir * w, ky);
  ctx.stroke();
  ctx.textBaseline = 'bottom';
  ctx.textAlign = dir > 0 ? 'left' : 'right';
  ctx.fillText(text, kx + dir * 3, ky - 4);
  ctx.restore();
}

// A target marker: a small dashed cross over a dot, as on a pad or a point of interest.
export function drawCrosshair(ctx, x, y, size = 9, color = LOOK.line) {
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x - size, y - size * 0.6); ctx.lineTo(x + size, y + size * 0.6);
  ctx.moveTo(x - size, y + size * 0.6); ctx.lineTo(x + size, y - size * 0.6);
  ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// A path as a thin line: solid and blue for where you have been, dashed and white for where you are heading.
export function drawPath(ctx, points, { dashed = false, color = dashed ? LOOK.line : LOOK.blue, width = dashed ? 1 : 2 } = {}) {
  if (points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (dashed) ctx.setLineDash([4, 5]);
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.stroke();
  ctx.restore();
}
