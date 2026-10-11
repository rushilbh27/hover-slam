// Vercel function: POST /api/event (a visit, a descent started, a descent finished). The work is in _stats.js.
import { handleEvent } from './_stats.js';

export default async function handler(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const out = await handleEvent({ method: req.method, body: req.body, ip, country: req.headers['x-vercel-ip-country'] });
  for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'no-store');
  res.status(out.status).json(out.json);
}
