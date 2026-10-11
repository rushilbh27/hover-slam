// Reads the feedback players have left. Needs DATABASE_URL (the Neon connection string) in the environment or in .env.local.
//   npm run feedback            the 40 most recent, with a summary
//   npm run feedback -- 200     more of them
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from '../api/_feedback.js';

try {
  for (const line of fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env.local */ }

const url = process.env.DATABASE_URL;
if (!url) { console.error('No DATABASE_URL. Put the Neon connection string in .env.local, or run: DATABASE_URL=... npm run feedback'); process.exit(1); }
const limit = Math.min(500, Math.max(1, Number(process.argv[2]) || 40));

try {
  const sum = await sql(url, `select level, count(*)::int as n, round(avg(rating)::numeric, 2)::float as avg_rating from hoverslam_feedback group by level order by level`);
  const rows = await sql(url, `select created_at, rating, level, scenario_id, outcome, score, comment from hoverslam_feedback order by created_at desc limit $1`, [limit]);
  console.log('Summary by level');
  for (const r of sum.rows) console.log(`  ${(r.level || 'unknown').padEnd(8)} ${String(r.n).padStart(4)} responses   average rating ${r.avg_rating ?? 'n/a'}`);
  console.log(`\nLatest ${rows.rows.length}`);
  for (const r of rows.rows) {
    const when = new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ');
    console.log(`\n${when}  ${r.rating ? '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating) : '(no rating)'}  ${r.level || ''} ${r.scenario_id || ''} ${r.outcome || ''}${r.score != null ? `, score ${r.score}` : ''}`);
    if (r.comment) console.log(`  "${r.comment}"`);
  }
} catch (e) {
  console.error(/42P01|does not exist|neon 4/.test(String(e.message)) ? 'No feedback yet: the table is created when the first one arrives.' : `Could not read feedback: ${e.message}`);
  process.exit(1);
}
