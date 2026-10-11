// Vercel function: GET /admin. The browser's own username and password box (HTTP Basic), then the numbers page.
import fs from 'node:fs';
import path from 'node:path';
import { basicOk, CHALLENGE } from './_stats.js';

export default function handler(req, res) {
  if (!process.env.ADMIN_PASSWORD) return res.status(503).send('ADMIN_PASSWORD is not set');
  if (!basicOk(req.headers.authorization)) {
    for (const [k, v] of Object.entries(CHALLENGE)) res.setHeader(k, v);
    return res.status(401).send('Login needed');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(fs.readFileSync(path.join(process.cwd(), 'api', '_admin.html'), 'utf8'));
}
