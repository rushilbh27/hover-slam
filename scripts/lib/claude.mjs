// Asks Claude to write scenarios. Plain fetch, no dependencies. Claude only writes the scenario data;
// the simulator then checks every one, so a bad or unwinnable scenario never reaches the bank.
import { RANGES, FAULT_RANGES, validateScenario } from '../../public/scenario.js';

export const MODEL = process.env.SCENARIO_MODEL || 'claude-opus-5-5';
const USE_FALLBACK = process.env.NO_FALLBACK !== '1';

export function hasKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const num = { type: 'number' };
export const SCHEMA = {
  type: 'object',
  properties: {
    scenarios: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A short evocative title, 2 to 4 words, sentence case.' },
          briefing: { type: 'string', description: 'One or two plain sentences telling the pilot what is different this time and how to plan for it. Under 300 characters.' },
          seed: { type: 'integer', description: 'A random whole number from 1000 to 999999. It fixes the exact start position and wind gusts.' },
          opts: {
            type: 'object',
            properties: { altScale: num, offsetScale: num, speedScale: num, windScale: num, fuel: num, padHalf: num },
            required: ['altScale', 'offsetScale', 'speedScale', 'windScale', 'fuel', 'padHalf'],
            additionalProperties: false,
          },
          faults: {
            type: 'object',
            description: 'Use the neutral value for any fault you do not want: leak 0, thrustCap 1, dropouts 0, weakSide "none".',
            properties: {
              leak: num,
              thrustCap: num,
              dropouts: { type: 'integer' },
              weakSide: { type: 'string', enum: ['none', 'left', 'right'] },
              weakFactor: num,
              flicker: { type: 'boolean' },
            },
            required: ['leak', 'thrustCap', 'dropouts', 'weakSide', 'weakFactor', 'flicker'],
            additionalProperties: false,
          },
        },
        required: ['name', 'briefing', 'seed', 'opts', 'faults'],
        additionalProperties: false,
      },
    },
  },
  required: ['scenarios'],
  additionalProperties: false,
};

function systemPrompt(level) {
  const R = RANGES[level];
  const r = (k) => `${R[k][0]} to ${R[k][1]}`;
  const faultText = R.faults.length
    ? `Faults allowed on this level (at most ${R.maxFaults} per scenario): ${R.faults
        .map((f) => ({ leak: `leak = fuel lost in flight, ${FAULT_RANGES.leak.join(' to ')} kg/s`, thrustCap: `thrustCap = share of full thrust, ${FAULT_RANGES.thrustCap.join(' to ')}`, dropouts: `dropouts = short engine cut-outs during the burn, ${FAULT_RANGES.dropouts.join(' to ')}`, weakSide: `weakSide = 'left' or 'right' loses steering power (weakFactor ${FAULT_RANGES.weakFactor.join(' to ')} of normal; flicker = it also cuts in and out)` })[f])
        .join('; ')}.`
    : 'No faults on this level: vary only the starting conditions.';
  return `You design scenarios for Hoverslam, a game where the player lands a rocket booster on a barge. The engine cannot hover, so the burn must end exactly at the deck. Each play should feel different from the last.

You are writing scenarios for the ${level.toUpperCase()} level. Every number must stay inside these ranges or the scenario is dropped:
- altScale ${r('altScale')} (1 is about 2000 m up; higher means a longer fall)
- offsetScale ${r('offsetScale')} (1 is about 190 m from the pad)
- speedScale ${r('speedScale')} (1 is about 145 m/s entry speed)
- windScale ${r('windScale')} (crosswind and gusts)
- fuel ${r('fuel')} kg
- padHalf ${r('padHalf')} m (half the width of the landing zone)
${faultText}

Rules:
- Make the scenarios clearly different from each other: vary the start height and distance, the wind, and which faults appear. Do not just sort them by difficulty.
- ${level === 'easy' ? 'Easy is gentle. Some are low and close, some start high, but all are forgiving.' : level === 'medium' ? 'Medium adds one real problem in most scenarios, such as a fuel leak or a thrust limit, and some are plain crosswind drops.' : 'Hard should feel dangerous but fair. Combine faults sometimes. A human with good timing must still be able to win.'}
- Every scenario is run through a simulator. Ones that cannot be landed are thrown away, so do not make everything extreme.
- The name is a short title. The briefing is plain English, written to the pilot, with no jargon and no em dashes.
- Use the neutral value for faults you do not want.`;
}

// Turns Claude's answer into scenario objects (not yet validated against the ranges).
export function fromAnswer(parsed, level) {
  const list = parsed && Array.isArray(parsed.scenarios) ? parsed.scenarios : [];
  return list.map((s) => {
    const f = s.faults || {};
    return {
      level,
      name: s.name,
      briefing: s.briefing,
      seed: s.seed,
      opts: s.opts,
      faults: {
        leak: f.leak > 0 ? f.leak : 0,
        thrustCap: f.thrustCap < 1 ? f.thrustCap : 1,
        dropouts: f.dropouts > 0 ? f.dropouts : 0,
        weakSide: f.weakSide === 'left' || f.weakSide === 'right' ? f.weakSide : null,
        weakFactor: f.weakFactor,
        flicker: f.flicker,
      },
      source: 'claude',
    };
  });
}

// Returns { scenarios: [validated scenarios], rejected: [{name, errors}], model, usage }.
export async function proposeScenarios({ level, count = 12, avoid = [], fetchImpl = fetch }) {
  const base = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const userText = `Write ${count} scenarios for the ${level} level.${avoid.length ? `\nDo not reuse these names: ${avoid.slice(-60).join(', ')}.` : ''}`;
  let feedback = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const body = {
      model: MODEL,
      max_tokens: 16000,
      system: systemPrompt(level),
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: userText + feedback }],
    };
    const headers = { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' };
    if (USE_FALLBACK) {
      headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
      body.fallbacks = 'default';
    }
    const res = await fetchImpl(`${base}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const msg = await res.json();
    if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request.');
    const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      feedback = '\n\nYour last answer was not valid JSON. Reply with the JSON only.';
      continue;
    }
    const scenarios = [];
    const rejected = [];
    for (const raw of fromAnswer(parsed, level)) {
      const v = validateScenario(raw, level);
      if (v.ok) scenarios.push(v.scenario);
      else rejected.push({ name: raw.name, errors: v.errors });
    }
    if (!scenarios.length) {
      feedback = `\n\nNone of those were valid: ${rejected.slice(0, 4).map((r) => `${r.name}: ${r.errors.join('; ')}`).join(' | ')}. Stay inside the ranges.`;
      continue;
    }
    for (const s of scenarios) s.source = 'claude';
    return { scenarios, rejected, model: msg.model, usage: msg.usage, attempts: attempt };
  }
  throw new Error('Claude did not return any valid scenarios after 2 attempts.');
}
