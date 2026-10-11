// Optional feedback after a landing: a star rating and a short note, sent with the level and the result. There is no account and
// nothing personal: only a random id kept in this browser, so repeat players can be told apart from new ones.
// It is posted to this site's own /api/feedback, which saves it on the server. Feedback that cannot be sent (offline, or storage
// not set up yet) waits in this browser and goes out with the next one.
const ENDPOINT = '/api/feedback';
const QUEUE = 'hs.feedbackQueue';
const read = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };

export function clientId() {
  let id = read('hs.cid', null);
  if (!id) {
    id = (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    write('hs.cid', id);
  }
  return id;
}

// Cleans one piece of feedback into the shape the table accepts, or returns null if there is nothing to send.
export function shape({ rating, comment, level, scenarioId, outcome, score }) {
  const r = Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null;
  const c = typeof comment === 'string' && comment.trim() ? comment.trim().slice(0, 500) : null;
  if (r === null && c === null) return null;
  return {
    rating: r,
    comment: c,
    level: ['easy', 'medium', 'hard'].includes(level) ? level : null,
    scenario_id: scenarioId ? String(scenarioId).slice(0, 20) : null,
    outcome: outcome ? String(outcome).slice(0, 60) : null,
    score: Number.isInteger(score) && score >= 0 && score <= 100 ? score : null,
    client_id: clientId(),
  };
}

async function post(row) {
  const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(row), keepalive: true });
  if (!res.ok) throw new Error(`feedback ${res.status}`);
}

// Resolves true once it has been sent (and anything that was waiting with it), false if it is waiting for later.
export async function sendFeedback(input) {
  const row = shape(input);
  if (!row) return false;
  const waiting = read(QUEUE, []);
  waiting.push(row);
  write(QUEUE, waiting.slice(-20));
  try {
    let left = waiting.slice(-20);
    while (left.length) { await post(left[0]); left = left.slice(1); write(QUEUE, left); } // one at a time, so a failure never repeats what went through
    return true;
  } catch {
    return false;
  }
}
