// Usage numbers for the developer page. The game posts small events (a visit, a descent started, a descent finished) to /api/event;
// nothing personal is kept: a random id from the player's browser, the level, the result and the device type. /api/stats turns them
// into the numbers on dev.html and is locked behind ADMIN_TOKEN. Both run on the same Neon database as the feedback.
import { sql } from './_feedback.js';

const EVENTS = 'hoverslam_events';
const FEEDBACK = 'hoverslam_feedback';
const LEVELS = ['easy', 'medium', 'hard'];

export const EVENTS_DDL = `create table if not exists ${EVENTS} (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  client_id text not null check (char_length(client_id) between 8 and 64),
  kind text not null check (kind in ('visit', 'start', 'end')),
  mode text check (mode in ('game', 'sim')),
  level text check (level in ('easy', 'medium', 'hard')),
  scenario_id text check (char_length(scenario_id) <= 20),
  outcome text check (char_length(outcome) <= 60),
  landed boolean,
  score smallint check (score between 0 and 100),
  duration_s smallint check (duration_s between 0 and 3600),
  device text check (device in ('phone', 'desktop'))
)`;

const text = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);

// What the browser sent, cleaned into a row, or null if it is not an event.
export function cleanEvent(b) {
  if (!b || typeof b !== 'object') return null;
  if (!['visit', 'start', 'end'].includes(b.kind)) return null;
  const client_id = text(b.client_id, 64);
  if (!client_id || client_id.length < 8) return null;
  const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
  return {
    client_id,
    kind: b.kind,
    mode: ['game', 'sim'].includes(b.mode) ? b.mode : null,
    level: LEVELS.includes(b.level) ? b.level : null,
    scenario_id: text(b.scenario_id, 20),
    outcome: text(b.outcome, 60),
    landed: typeof b.landed === 'boolean' ? b.landed : null,
    score: int(b.score, 0, 100),
    duration_s: int(b.duration_s, 0, 3600),
    device: ['phone', 'desktop'].includes(b.device) ? b.device : null,
  };
}

const hits = new Map();
function limited(ip, now = Date.now(), max = 120, windowMs = 10 * 60 * 1000) {
  const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > max;
}

let ready = false;
export function resetStatsForTests() { ready = false; hits.clear(); }

export async function handleEvent({ method, body, ip = 'unknown', env = process.env, fetchImpl = fetch }) {
  if (method !== 'POST') return { status: 405, json: { error: 'POST only' }, headers: { Allow: 'POST' } };
  const row = cleanEvent(body);
  if (!row) return { status: 400, json: { error: 'Not an event' } };
  if (limited(ip)) return { status: 429, json: { error: 'Too many' } };
  if (!env.DATABASE_URL) return { status: 503, json: { error: 'Storage is not set up' } };
  try {
    if (!ready) { await sql(env.DATABASE_URL, EVENTS_DDL, [], fetchImpl); ready = true; }
    await sql(env.DATABASE_URL, `insert into ${EVENTS} (client_id, kind, mode, level, scenario_id, outcome, landed, score, duration_s, device) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [row.client_id, row.kind, row.mode, row.level, row.scenario_id, row.outcome, row.landed, row.score, row.duration_s, row.device], fetchImpl);
    return { status: 201, json: { ok: true } };
  } catch {
    return { status: 502, json: { error: 'Could not save' } };
  }
}

// Same length and same bytes, compared without stopping at the first difference.
export function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const n = (v) => Number(v) || 0;

// "Authorization: Basic base64(user:password)" checked against ADMIN_USER (default "admin") and ADMIN_PASSWORD.
export function basicOk(header, env = process.env) {
  if (!env.ADMIN_PASSWORD) return false;
  const m = /^Basic\s+(.+)$/i.exec(String(header || ''));
  if (!m) return false;
  let pair = '';
  try { pair = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return false; }
  const i = pair.indexOf(':');
  if (i < 0) return false;
  const userOk = sameToken(pair.slice(0, i), env.ADMIN_USER || 'admin');
  const passOk = sameToken(pair.slice(i + 1), env.ADMIN_PASSWORD);
  return userOk && passOk;
}
export const CHALLENGE = { 'WWW-Authenticate': 'Basic realm="Hoverslam numbers", charset="UTF-8"' };

export async function handleStats({ method, authorization, env = process.env, fetchImpl = fetch }) {
  if (method !== 'GET') return { status: 405, json: { error: 'GET only' }, headers: { Allow: 'GET' } };
  if (!env.ADMIN_PASSWORD) return { status: 503, json: { error: 'ADMIN_PASSWORD is not set' } };
  if (!basicOk(authorization, env)) return { status: 401, json: { error: 'Login needed' }, headers: CHALLENGE };
  if (!env.DATABASE_URL) return { status: 503, json: { error: 'Storage is not set up' } };
  const q = async (query) => (await sql(env.DATABASE_URL, query, [], fetchImpl)).rows || [];
  try {
    await sql(env.DATABASE_URL, EVENTS_DDL, [], fetchImpl);
    const [[tot], [win], [ret], levels, outcomes, daily, devices, modes] = await Promise.all([
      q(`select count(distinct client_id) players, count(*) filter (where kind = 'visit') visits, count(*) filter (where kind = 'start') starts, count(*) filter (where kind = 'end') ends, count(*) filter (where kind = 'end' and landed) landed, round(avg(duration_s) filter (where kind = 'end' and mode = 'game')) avg_dur from ${EVENTS}`),
      q(`select count(distinct client_id) filter (where created_at > now() - interval '1 day') d1, count(distinct client_id) filter (where created_at > now() - interval '7 days') d7, count(distinct client_id) filter (where created_at > now() - interval '30 days') d30 from ${EVENTS}`),
      q(`select count(*) n from (select client_id from ${EVENTS} group by client_id having count(distinct created_at::date) > 1) t`),
      q(`select level, count(*) filter (where kind = 'start') starts, count(*) filter (where kind = 'end') ends, count(*) filter (where kind = 'end' and landed) landed, round(avg(score) filter (where kind = 'end' and landed)) avg_score, round(avg(duration_s) filter (where kind = 'end')) avg_dur from ${EVENTS} where mode = 'game' and level is not null group by level order by level`),
      q(`select outcome, count(*) n from ${EVENTS} where kind = 'end' and outcome is not null group by outcome order by n desc limit 8`),
      q(`select to_char(d, 'YYYY-MM-DD') as label, (select count(distinct client_id) from ${EVENTS} e where e.created_at::date = d::date) players, (select count(*) from ${EVENTS} e where e.kind = 'start' and e.created_at::date = d::date) games from generate_series(current_date - 13, current_date, interval '1 day') d order by d`),
      q(`select device, count(distinct client_id) n from ${EVENTS} where device is not null group by device`),
      q(`select mode, count(*) n from ${EVENTS} where kind = 'start' and mode is not null group by mode`),
    ]);
    let feedback = { count: 0, avg: null, stars: [0, 0, 0, 0, 0], latest: [] };
    try {
      const [f] = await q(`select count(*) n, round(avg(rating), 2) avg, count(*) filter (where rating = 1) r1, count(*) filter (where rating = 2) r2, count(*) filter (where rating = 3) r3, count(*) filter (where rating = 4) r4, count(*) filter (where rating = 5) r5 from ${FEEDBACK}`);
      const latest = await q(`select created_at, rating, comment, level, outcome, score from ${FEEDBACK} order by created_at desc limit 40`);
      feedback = { count: n(f.n), avg: f.avg === null ? null : Number(f.avg), stars: [n(f.r1), n(f.r2), n(f.r3), n(f.r4), n(f.r5)], latest };
    } catch { /* no feedback table yet */ }
    return {
      status: 200,
      json: {
        generated: new Date().toISOString(),
        totals: { players: n(tot.players), visits: n(tot.visits), starts: n(tot.starts), ends: n(tot.ends), landed: n(tot.landed), avgSeconds: n(tot.avg_dur), returning: n(ret.n), day: n(win.d1), week: n(win.d7), month: n(win.d30) },
        levels: levels.map((r) => ({ level: r.level, starts: n(r.starts), ends: n(r.ends), landed: n(r.landed), avgScore: r.avg_score === null ? null : n(r.avg_score), avgSeconds: n(r.avg_dur) })),
        outcomes: outcomes.map((r) => ({ outcome: r.outcome, n: n(r.n) })),
        daily: daily.map((r) => ({ day: r.label, players: n(r.players), games: n(r.games) })),
        devices: devices.map((r) => ({ device: r.device, n: n(r.n) })),
        modes: modes.map((r) => ({ mode: r.mode, n: n(r.n) })),
        feedback,
      },
    };
  } catch {
    return { status: 502, json: { error: 'Could not read the numbers' } };
  }
}
