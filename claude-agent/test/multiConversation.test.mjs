// Multi-conversation behaviour of the production bundle (SDK included) under a stub `vscode`, with the Claude CLI
// process faked (child_process.spawn intercepted): each fake CLI stays alive until its query is aborted, so we can
// see which conversations run, which are stopped, and what the panel receives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import { buildExtension } from './helpers/build.mjs';
import { loadExtension, makeContext, uri } from './helpers/vscodeStub.mjs';

const require = createRequire(import.meta.url);
const cp = require('child_process');
const bundle = await buildExtension();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-multi-'));
const until = async (cond, what) => {
  for (let i = 0; i < 250 && !cond(); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(cond(), `timed out waiting for ${what}`);
};

/** Fake CLI processes: alive until the SDK aborts them (Stop) or closes their input. */
function fakeCli() {
  const launches = [];
  const real = cp.spawn;
  cp.spawn = (command, args, opts) => {
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 5000 + launches.length, killed: false, exitCode: null });
    const exit = () => { if (proc.killed) return; proc.killed = true; proc.exitCode = 0; setImmediate(() => { proc.stdout.end(); proc.stderr.end(); proc.emit('exit', 0, null); proc.emit('close', 0, null); }); };
    proc.kill = () => { exit(); return true; };
    proc.stdin = new Writable({ write(c, _e, cb) { cb(); }, final(cb) { exit(); cb(); } });
    opts?.signal?.addEventListener('abort', exit);
    launches.push(proc);
    return proc;
  };
  return { launches, restore: () => { cp.spawn = real; } };
}

function openPanel(settings = {}) {
  const work = tmp();
  const { ext } = loadExtension(bundle, { remoteName: undefined, remoteSsh: false, folder: uri('file', '', work), settings });
  const { chat } = ext.activate(makeContext(tmp()));
  const panel = [];
  chat.view = { webview: { postMessage: async m => { panel.push(m); return true; } } };
  return { chat, panel };
}

test('two conversations run at once; switching never stops one; Stop(B) stops only B; switching back shows A live', async () => {
  const cli = fakeCli();
  try {
    const { chat, panel } = openPanel();
    const a = chat.active;
    const sentA = chat.send(a, 'task A', false);
    await until(() => cli.launches.length === 1, 'CLI of A');

    chat.newChat();                                   // used to stop A
    const b = chat.active;
    assert.notEqual(a.conversationId, b.conversationId);
    const sentB = chat.send(b, 'task B', false);
    await until(() => cli.launches.length === 2, 'CLI of B');
    assert.deepEqual([a.busy, b.busy, cli.launches[0].killed, cli.launches[1].killed], [true, true, false, false]);

    // While B is shown, A's updates are kept but not forwarded; every forwarded delta is B's.
    const shownFrom = panel.length;
    chat.post({ type: 'note', text: 'A progress' }, a);
    const forwarded = panel.slice(shownFrom).filter(m => m.type === 'delta').map(m => m.conversationId);
    assert.deepEqual(forwarded, []);
    assert.ok(a.presentation.events.some(e => e.type === 'note' && e.text === 'A progress'));
    const activity = panel.filter(m => m.type === 'activity').at(-1);
    assert.deepEqual(activity.conversations.map(c => [c.conversationId, c.status]), [[a.conversationId, 'running']]);

    chat.stopSession(b);
    await sentB;
    assert.deepEqual([cli.launches[1].killed, cli.launches[0].killed, a.busy, b.status], [true, false, true, 'interrupted']);

    // Switching back (presentation only) sends one snapshot with A's live state.
    await chat.onMessage({ type: 'switchTo', conversationId: a.conversationId });
    const snap = panel.filter(m => m.type === 'snapshot').at(-1);
    assert.equal(snap.conversationId, a.conversationId);
    assert.equal(snap.state.busy, true);
    assert.deepEqual(snap.state.events.filter(e => e.type === 'user' || e.type === 'note').map(e => e.text), ['task A', 'A progress']);
    // Deltas continue from the snapshot's sequence number.
    chat.post({ type: 'note', text: 'more A' }, a);
    const next = panel.at(-1);
    assert.deepEqual([next.type, next.conversationId, next.seq, next.event.text], ['delta', a.conversationId, snap.seq + 1, 'more A']);

    await chat.onMessage({ type: 'stop', conversationId: a.conversationId });
    await sentA;
    assert.deepEqual([cli.launches[0].killed, a.status], [true, 'interrupted']);
  } finally { cli.restore(); }
});

test('a background approval is listed with its conversation and answered there, whichever is shown', async () => {
  const cli = fakeCli();
  try {
    const { chat, panel } = openPanel();
    const a = chat.active;
    a.mode = 'ask';
    a.status = 'running';
    const verdict = a.canUseTool('Bash', { command: 'make' }, { signal: new AbortController().signal, suggestions: [] });
    const prompt = a.presentation.events.find(e => e.type === 'permission');
    chat.newChat();
    const listed = panel.filter(m => m.type === 'activity').at(-1).conversations.find(c => c.conversationId === a.conversationId);
    assert.deepEqual([listed.pendingApprovals, a.status], [1, 'waiting-for-permission']);
    // The panel answers from the other conversation's view: the id routes it to A.
    await chat.onMessage({ type: 'permission', id: prompt.id, choice: 'Allow once', conversationId: chat.active.conversationId });
    assert.equal((await verdict).behavior, 'allow');
    assert.deepEqual([a.status, a.permissionWaiters.size, prompt.answered], ['running', 0, 'Allow once']);
  } finally { cli.restore(); }
});

test('maxConcurrentRunning: the next conversation waits in the queue; stopping it there never starts it', async () => {
  const cli = fakeCli();
  try {
    const { chat } = openPanel({ maxConcurrentRunning: 1 });
    const a = chat.active;
    const sentA = chat.send(a, 'A', false);
    await until(() => cli.launches.length === 1, 'CLI of A');
    chat.newChat();
    const b = chat.active;
    const sentB = chat.send(b, 'B', false);
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual([b.status, cli.launches.length], ['queued', 1]);
    assert.ok(b.presentation.events.some(e => e.type === 'note' && /Queued/.test(e.text)));
    chat.stopSession(b);
    await sentB;
    assert.deepEqual([b.status, b.busy, cli.launches.length], ['interrupted', false, 1]);
    chat.stopSession(a);
    await sentA;
    await new Promise(r => setTimeout(r, 50));
    assert.equal(cli.launches.length, 1);   // B never started
  } finally { cli.restore(); }
});

test('deactivate stops every running conversation', async () => {
  const cli = fakeCli();
  try {
    const work = tmp();
    const { ext } = loadExtension(bundle, { remoteName: undefined, remoteSsh: false, folder: uri('file', '', work) });
    const { chat } = ext.activate(makeContext(tmp()));
    const sent = [chat.send(chat.active, 'A', false)];
    await until(() => cli.launches.length === 1, 'CLI of A');
    chat.newChat();
    sent.push(chat.send(chat.active, 'B', false));
    await until(() => cli.launches.length === 2, 'CLI of B');
    ext.deactivate();
    await Promise.all(sent);
    assert.deepEqual(cli.launches.map(p => p.killed), [true, true]);
  } finally { cli.restore(); }
});

test('soak: many conversations started, switched and stopped in random states leave nothing behind', async () => {
  const cli = fakeCli();
  try {
    const { chat, panel } = openPanel({ maxConcurrentRunning: 3 });
    let seed = 7;
    const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const all = [], sends = [];
    for (let round = 0; round < 40; round++) {
      const action = rand(4);
      if (action === 0 || all.length < 3) {                       // a new conversation with a prompt
        chat.newChat();
        const s = chat.active;
        all.push(s);
        sends.push(chat.send(s, `prompt ${round}`, false));
      } else if (action === 1) {                                  // stop one, whatever state it is in
        chat.stopSession(all[rand(all.length)]);
      } else if (action === 2) {                                  // show another one (presentation only)
        const s = all[rand(all.length)];
        if (chat.sessions.has(s.conversationId)) await chat.onMessage({ type: 'switchTo', conversationId: s.conversationId });
      } else {                                                    // a prompt in an idle one
        const s = all[rand(all.length)];
        if (!s.busy && chat.sessions.has(s.conversationId)) sends.push(chat.send(s, `again ${round}`, false));
      }
      await new Promise(r => setTimeout(r, rand(30)));
      assert.ok(chat.scheduler.running <= 3, 'concurrency limit');
    }
    for (const s of all) chat.stopSession(s);
    await Promise.all(sends);
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual({
      running: chat.scheduler.running, queued: chat.scheduler.queued, busy: all.filter(s => s.busy).length,
      waiters: all.reduce((n, s) => n + s.permissionWaiters.size, 0), locks: all.reduce((n, s) => n + s.heldLocks.size, 0),
      aliveCli: cli.launches.filter(p => !p.killed).length, resident: chat.sessions.size,
    }, { running: 0, queued: 0, busy: 0, waiters: 0, locks: 0, aliveCli: 0, resident: 1 });
    // Every forwarded delta belonged to the conversation shown at that moment, in sequence.
    let shown, seq;
    for (const m of panel) {
      if (m.type === 'snapshot') { shown = m.conversationId; seq = m.seq; }
      if (m.type === 'delta') { assert.equal(m.conversationId, shown); assert.equal(m.seq, ++seq); }
    }
  } finally { cli.restore(); }
});
