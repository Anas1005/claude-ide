// Phase 0 gate (a), opt-in live check (not part of `npm test`): two concurrent SDK query() calls in the same cwd
// complete independently, and each writes its own uncorrupted JSONL transcript. Small real model calls.
// Usage: node test/e2e/phase0-concurrent-queries.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ROOT } from '../helpers/build.mjs';

const { query } = await import(path.join(ROOT, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'));
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-concurrent-')));
const projectDir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));

async function run(tag, word) {
  const events = [];
  let sessionId, result;
  const q = query({ prompt: `Reply with exactly the word ${word} and nothing else.`, options: { cwd, model: 'claude-haiku-4-5-20251001', permissionMode: 'default', tools: [] } });
  for await (const m of q) {
    events.push(`${Date.now()} ${m.type}${m.subtype ? '/' + m.subtype : ''}`);
    if (m.type === 'system' && m.subtype === 'init') sessionId = m.session_id;
    if (m.type === 'result') result = m;
  }
  return { tag, word, sessionId, ok: result?.subtype === 'success', text: result?.result?.trim(), events };
}

const started = Date.now();
const [a, b] = await Promise.all([run('A', 'ALPHA'), run('B', 'BRAVO')]);

function transcript(r) {
  const file = path.join(projectDir, `${r.sessionId}.jsonl`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const parsed = lines.map(l => JSON.parse(l));   // throws on a corrupted line
  const ids = new Set(parsed.map(e => e.sessionId).filter(Boolean));
  const text = JSON.stringify(parsed);
  return { lines: lines.length, sessionIds: [...ids], hasOwnWord: text.includes(r.word), hasOtherWord: text.includes(r.word === 'ALPHA' ? 'BRAVO' : 'ALPHA'), interrupted: text.includes('Request interrupted') };
}
const overlap = Math.min(Number(a.events.at(-1).split(' ')[0]), Number(b.events.at(-1).split(' ')[0])) > Math.max(Number(a.events[0].split(' ')[0]), Number(b.events[0].split(' ')[0]));
const report = { elapsedMs: Date.now() - started, overlappedInTime: overlap, A: { ...a, events: a.events.length, transcript: transcript(a) }, B: { ...b, events: b.events.length, transcript: transcript(b) } };
console.log(JSON.stringify(report, null, 1));
const pass = a.ok && b.ok && a.sessionId !== b.sessionId && a.text === 'ALPHA' && b.text === 'BRAVO' && overlap
  && [report.A.transcript, report.B.transcript].every(t => t.sessionIds.length === 1 && t.hasOwnWord && !t.hasOtherWord && !t.interrupted);
console.log(pass ? 'GATE A: PASS' : 'GATE A: FAIL');
fs.rmSync(cwd, { recursive: true, force: true });
fs.rmSync(projectDir, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
