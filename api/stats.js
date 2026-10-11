// Vercel function: GET /api/stats (the numbers for /admin). Needs the admin login.
import { handleStats } from './_stats.js';

export default async function handler(req, res) {
  const out = await handleStats({ method: req.method, authorization: req.headers.authorization });
  for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'no-store');
  res.status(out.status).json(out.json);
}
