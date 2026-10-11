// Zero-dependency static server for ./public, plus POST /api/feedback (the same code Vercel runs).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleFeedback } from './api/_feedback.js';
import { handleEvent, handleStats, basicOk, CHALLENGE } from './api/_stats.js';

// DATABASE_URL (the Neon connection string) may live in .env.local, which is git-ignored. Without it, feedback is politely refused.
try {
  for (const line of fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env.local */ }

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/feedback') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 8192) req.destroy(); });
    req.on('end', async () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* not JSON */ }
      const out = await handleFeedback({ method: req.method, body, ip: req.socket.remoteAddress });
      res.writeHead(out.status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(out.headers || {}) });
      res.end(JSON.stringify(out.json));
    });
    return;
  }
  if (url.pathname === '/api/stats') {
    handleStats({ method: req.method, authorization: req.headers.authorization }).then((out) => {
      res.writeHead(out.status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(out.headers || {}) });
      res.end(JSON.stringify(out.json));
    });
    return;
  }
  if (url.pathname === '/admin') {
    if (!process.env.ADMIN_PASSWORD) { res.writeHead(503); return res.end('ADMIN_PASSWORD is not set'); }
    if (!basicOk(req.headers.authorization)) { res.writeHead(401, { 'content-type': 'text/plain', ...CHALLENGE }); return res.end('Login needed'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'api', '_admin.html')));
  }
  if (url.pathname === '/api/event') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on('end', async () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* not JSON */ }
      const out = await handleEvent({ method: req.method, body, ip: req.socket.remoteAddress });
      res.writeHead(out.status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(out.headers || {}) });
      res.end(JSON.stringify(out.json));
    });
    return;
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}).listen(PORT, HOST, () => console.log(`Hoverslam on http://localhost:${PORT}`));
