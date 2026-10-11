// Feedback from players, kept in Neon (serverless Postgres). The browser never sees the database: it posts to /api/feedback, and this
// code, running on the server, checks what arrived and inserts it with a parameterised query. It talks to Neon over its plain HTTPS
// SQL endpoint, so there is nothing to install. The only setting is DATABASE_URL, the connection string Neon gives you.
const TABLE = 'hoverslam_feedback';
const LEVELS = ['easy', 'medium', 'hard'];

export const DDL = `create table if not exists ${TABLE} (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  rating smallint check (rating between 1 and 5),
  comment text check (char_length(comment) <= 500),
  level text check (level in ('easy', 'medium', 'hard')),
  scenario_id text check (char_length(scenario_id) <= 20),
  outcome text check (char_length(outcome) <= 60),
  score smallint check (score between 0 and 100),
  client_id text check (char_length(client_id) <= 64),
  constraint has_content check (rating is not null or comment is not null)
)`;

// What the browser sent, cleaned into a row, or null if there is nothing worth keeping.
export function clean(body) {
  if (!body || typeof body !== 'object') return null;
  const rating = Number.isInteger(body.rating) && body.rating >= 1 && body.rating <= 5 ? body.rating : null;
  const comment = typeof body.comment === 'string' && body.comment.trim() ? body.comment.trim().slice(0, 500) : null;
  if (rating === null && comment === null) return null;
  const text = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
  return {
    rating,
    comment,
    level: LEVELS.includes(body.level) ? body.level : null,
    scenario_id: text(body.scenario_id, 20),
    outcome: text(body.outcome, 60),
    score: Number.isInteger(body.score) && body.score >= 0 && body.score <= 100 ? body.score : null,
    client_id: text(body.client_id, 64),
  };
}

// One SQL statement over Neon's HTTPS endpoint. Values travel as parameters, never inside the query text.
export async function sql(connectionString, query, params = [], fetchImpl = fetch) {
  const res = await fetchImpl(`https://${new URL(connectionString).host}/sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': connectionString },
    body: JSON.stringify({ query, params }),
  });
  if (!res.ok) {
    let why = '';
    try { why = (await res.json()).message || ''; } catch { /* no body */ }
    throw new Error(`neon ${res.status} ${why}`.trim());
  }
  return res.json();
}

// A few posts per address per ten minutes: enough for a family on one connection, not enough to flood. It lives in this server
// instance's memory, so it is a speed bump and not a wall.
const hits = new Map();
export function limited(ip, now = Date.now(), max = 8, windowMs = 10 * 60 * 1000) {
  const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > max;
}

let ready = false;
export function resetForTests() { ready = false; hits.clear(); }

// The whole endpoint, as a plain function so the server, Vercel and the tests all run the same code.
export async function handleFeedback({ method, body, ip = 'unknown', env = process.env, fetchImpl = fetch }) {
  if (method !== 'POST') return { status: 405, json: { error: 'POST only' }, headers: { Allow: 'POST' } };
  const row = clean(body);
  if (!row) return { status: 400, json: { error: 'Nothing to save' } };
  if (limited(ip)) return { status: 429, json: { error: 'Too many, try again later' } };
  if (!env.DATABASE_URL) return { status: 503, json: { error: 'Feedback storage is not set up' } };
  try {
    if (!ready) { await sql(env.DATABASE_URL, DDL, [], fetchImpl); ready = true; }
    await sql(env.DATABASE_URL, `insert into ${TABLE} (rating, comment, level, scenario_id, outcome, score, client_id) values ($1, $2, $3, $4, $5, $6, $7)`,
      [row.rating, row.comment, row.level, row.scenario_id, row.outcome, row.score, row.client_id], fetchImpl);
    return { status: 201, json: { ok: true } };
  } catch {
    return { status: 502, json: { error: 'Could not save' } };
  }
}
