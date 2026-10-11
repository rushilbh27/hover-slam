// Vercel function: POST /api/feedback. The work is in _feedback.js, which the local server and the tests share.
import { handleFeedback } from './_feedback.js';

export default async function handler(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const out = await handleFeedback({ method: req.method, body: req.body, ip });
  for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'no-store');
  res.status(out.status).json(out.json);
}
