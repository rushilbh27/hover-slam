// Vercel function: GET /api/stats?key=... (the numbers for dev.html). Locked behind ADMIN_TOKEN.
import { handleStats } from './_stats.js';

export default async function handler(req, res) {
  const token = String(req.headers['x-admin-key'] || req.query?.key || '');
  const out = await handleStats({ method: req.method, token });
  for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'no-store');
  res.status(out.status).json(out.json);
}
