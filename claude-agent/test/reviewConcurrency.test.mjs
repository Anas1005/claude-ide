// Conflict-safe concurrent editing (multi-conversation spec §5), on real files in a scratch folder, through the real
// PreToolUse/PostToolUse callbacks of two conversations of the production bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildExtension } from './helpers/build.mjs';
import { loadExtension, makeContext, uri } from './helpers/vscodeStub.mjs';

const bundle = await buildExtension();
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

function openWindow(files = {}, answer) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-conc-')));
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), content);
  const warnings = [];
  const { ext, commands } = loadExtension(bundle, { remoteName: undefined, remoteSsh: false, folder: uri('file', '', dir),
    warningAnswer: message => { warnings.push(message); return answer?.(message); } });
  const { chat, store } = ext.activate(makeContext(fs.mkdtempSync(path.join(os.tmpdir(), 'review-conc-state-'))));
  const a = chat.active;
  chat.newChat();
  const b = chat.active;
  for (const s of [a, b]) s.turn = `turn-${s.conversationId.slice(0, 4)}`;
  const f = rel => path.join(dir, rel);
  const pre = (s, rel, id) => s.preToolUse({ tool_name: 'Edit', tool_input: { file_path: f(rel) }, tool_use_id: id });
  const post = (s, rel, id) => s.postToolUse({ tool_name: 'Edit', tool_input: { file_path: f(rel) }, tool_use_id: id });
  /** One complete Edit by conversation `s`: lock + snapshot, the write, then record + release. */
  const edit = async (s, rel, content, id) => { await pre(s, rel, id); fs.writeFileSync(f(rel), content); await post(s, rel, id); };
  return { chat, store, commands, a, b, f, pre, post, edit, warnings, read: rel => fs.readFileSync(f(rel), 'utf8') };
}

test('one file, two conversations: B waits for A\'s whole edit; B\'s reject restores A\'s work; A\'s accept writes nothing', async () => {
  const w = openWindow({ 'x.txt': 'C0\n' });
  await w.pre(w.a, 'x.txt', 'a1');                    // A holds x.txt from its snapshot until its write is recorded
  let bStarted = false;
  const bPre = w.pre(w.b, 'x.txt', 'b1').then(() => { bStarted = true; });
  await tick();
  assert.equal(bStarted, false, 'B snapshots only after A has written');
  fs.writeFileSync(w.f('x.txt'), 'C1\n');
  await w.post(w.a, 'x.txt', 'a1');
  await bPre;
  fs.writeFileSync(w.f('x.txt'), 'C2\n');
  await w.post(w.b, 'x.txt', 'b1');

  assert.deepEqual(w.store.pending().map(p => [path.basename(p.path), p.conversations]), [['x.txt', [w.a.conversationId, w.b.conversationId]]]);
  assert.equal(w.store.baseline(w.f('x.txt')), 'C0\n');   // the review shows the file against its earliest baseline

  w.store.accept(w.f('x.txt'), w.a.conversationId);   // no disk write
  assert.equal(w.read('x.txt'), 'C2\n');
  await w.store.reject(w.f('x.txt'), undefined, w.b.conversationId);
  assert.deepEqual([w.read('x.txt'), w.store.pending()], ['C1\n', []]);   // B's own pre-image: A's accepted work stays
});

test('A cannot discard B\'s later edit by rejecting its own; an external edit is never overwritten silently', async () => {
  const w = openWindow({ 'y.txt': 'C0\n', 'z.txt': 'Z0\n' });
  await w.edit(w.a, 'y.txt', 'C1\n', 'a1');
  await w.edit(w.b, 'y.txt', 'C2\n', 'b1');
  await assert.rejects(w.store.reject(w.f('y.txt'), undefined, w.a.conversationId), e => e.name === 'ReviewConflict' && e.laterEdits);
  assert.equal(w.read('y.txt'), 'C2\n');

  await w.edit(w.a, 'z.txt', 'Z1\n', 'a2');
  fs.writeFileSync(w.f('z.txt'), 'someone else\n');          // outside our lock (a person, git, another process)
  await w.commands.get('claudeIde.rejectFile')(w.f('z.txt'));  // the person cancels the "Edited after Claude's change" dialog
  assert.deepEqual([w.read('z.txt'), w.warnings.at(-1)], ['someone else\n', 'Edited after Claude\'s change']);
});

test('a denied edit releases its lock; Stop releases what the conversation held', async () => {
  const w = openWindow({ 'd.txt': 'D0\n' });
  w.a.mode = 'plan';
  await w.pre(w.a, 'd.txt', 'a1');
  const verdict = await w.a.canUseTool('Edit', { file_path: w.f('d.txt') }, { signal: new AbortController().signal, toolUseID: 'a1' });
  assert.equal(verdict.behavior, 'deny');
  let bGot = false;
  await Promise.race([w.pre(w.b, 'd.txt', 'b1').then(() => { bGot = true; }), tick(500)]);
  assert.equal(bGot, true, 'the denied tool no longer blocks d.txt');

  // B now holds d.txt (its edit never finished); stopping B releases it.
  w.b.status = 'running'; w.b.currentOperationId = 'op';
  let aGot = false;
  const aPre = w.pre(w.a, 'd.txt', 'a2').then(() => { aGot = true; });
  await tick();
  assert.equal(aGot, false);
  w.chat.stopSession(w.b);
  await Promise.race([aPre, tick(500)]);
  assert.equal(aGot, true);
});

test('PathLock: sorted multi-path acquisition cannot deadlock; release is idempotent; one owner re-enters', async () => {
  const { store } = openWindow();
  const lock = store.pathLock;
  const order = [];
  await lock.acquire(['b', 'a'], 'h1');
  const h2 = lock.acquire(['a', 'b'], 'h2').then(() => order.push('h2'));
  const h3 = lock.acquire(['b'], 'h3').then(() => order.push('h3'));
  await tick();
  assert.deepEqual(order, []);
  lock.release('h1'); lock.release('h1'); lock.release('unknown');
  // h3 waits only for b and gets it first; h2 takes a, then waits for b behind h3. Neither can deadlock.
  await h3;
  await tick();
  assert.deepEqual(order, ['h3']);
  lock.release('h3');
  await h2;
  lock.release('h2');
  assert.deepEqual(order, ['h3', 'h2']);

  await lock.acquire(['p'], 't1', 'conversation-A');
  await Promise.race([lock.acquire(['p'], 't2', 'conversation-A'), tick(200).then(() => assert.fail('same owner must not wait'))]);
  let other = false;
  const o = lock.acquire(['p'], 't3', 'conversation-B').then(() => { other = true; });
  lock.release('t1');
  await tick();
  assert.equal(other, false, 'still held by t2');
  lock.release('t2');
  await o;
  assert.equal(other, true);
  lock.release('t3');
});

test('local Bash: a command naming paths outside the working folder gets a note that changes there are not reviewed', async () => {
  const w = openWindow({ 'k.txt': 'k\n' });
  w.a.mode = 'auto';
  const bash = (command, id) => ({ tool_name: 'Bash', tool_input: { command }, tool_use_id: id });
  await w.a.preToolUse(bash('echo x > /var/tmp/elsewhere.txt', 'b1'));
  await w.a.postToolUse(bash('echo x > /var/tmp/elsewhere.txt', 'b1'));
  await w.a.preToolUse(bash(`echo y > ${w.f('in.txt')}`, 'b2'));
  await w.a.postToolUse(bash(`echo y > ${w.f('in.txt')}`, 'b2'));
  const notes = w.a.presentation.events.filter(e => e.type === 'note').map(e => e.text);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /names paths outside .* \(\/var\/tmp\/elsewhere\.txt\): changes there are not recorded for review/);
});
