// The conversation scheduler (multi-conversation spec §4): Stop is never lost in any cancelable state, `running` is
// paired 1:1 with started operations, the concurrency limit holds, and a stopped queued operation never starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadModules } from './helpers/build.mjs';

const [{ ConversationSession, Scheduler, CANCELLED_BEFORE_START }] = await loadModules('src/session.ts');

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const session = () => new ConversationSession({ cwd: '/w', folderPath: '/w', isRemote: false }, 'm', 'high', 'auto');

/** A controllable operation body: each started operation waits until released, then checks for Stop like runSend. */
function harness(max) {
  const started = [], settled = [], gates = new Map();
  const scheduler = new Scheduler(max, async (s, opId) => {
    started.push(s.conversationId);
    await new Promise(r => gates.set(opId, r));   // "await agentEnv()/sdk()"
    if (scheduler.cancelled(s, opId)) throw CANCELLED_BEFORE_START;
    s.status = 'running';
    s.q = { interrupt: async () => { } };
    await new Promise(r => gates.set(opId + ':run', r));
  }, (s, opId, error) => settled.push({ id: s.conversationId, opId, status: s.status, error }));
  const release = opId => gates.get(opId)?.();
  return { scheduler, started, settled, release, gates };
}

test('identity exists at acceptance: Stop while starting (before the query exists) ends the operation, never lost', async () => {
  const h = harness(4), a = session();
  const opId = h.scheduler.requestSend(a, {});
  assert.equal(a.status, 'starting');
  assert.equal(h.scheduler.stop(a), true);
  assert.equal(a.status, 'stopping');
  h.release(opId);
  await tick();
  assert.deepEqual({ status: a.status, busy: a.busy, running: h.scheduler.running, settled: h.settled.map(x => x.status) },
    { status: 'interrupted', busy: false, running: 0, settled: ['interrupted'] });
});

test('concurrency limit; Stop while queued never starts it and touches no counter; the queue drains in order', async () => {
  const h = harness(1), a = session(), b = session(), c = session();
  const opA = h.scheduler.requestSend(a, {});
  h.scheduler.requestSend(b, {});
  const opC = h.scheduler.requestSend(c, {});
  assert.deepEqual([a.status, b.status, c.status, h.scheduler.running, h.scheduler.queued], ['starting', 'queued', 'queued', 1, 2]);
  h.scheduler.stop(b);
  assert.deepEqual([b.status, b.busy, h.scheduler.running, h.scheduler.queued], ['interrupted', false, 1, 1]);
  h.release(opA); await tick(); h.release(opA + ':run'); await tick();
  assert.deepEqual([a.status, c.status, h.scheduler.running], ['completed', 'starting', 1]);
  h.release(opC); await tick(); h.release(opC + ':run'); await tick();
  assert.deepEqual({ started: h.started, running: h.scheduler.running, statuses: [a.status, b.status, c.status] },
    { started: [a.conversationId, c.conversationId], running: 0, statuses: ['completed', 'interrupted', 'completed'] });
});

test('Stop only touches its own session; running sessions are independent', async () => {
  const h = harness(4), a = session(), b = session();
  let interruptedA = 0, interruptedB = 0;
  const opA = h.scheduler.requestSend(a, {}), opB = h.scheduler.requestSend(b, {});
  h.release(opA); h.release(opB); await tick();
  a.q.interrupt = async () => { interruptedA++; };
  b.q.interrupt = async () => { interruptedB++; };
  a.abort = new AbortController(); b.abort = new AbortController();
  h.scheduler.stop(a);
  assert.deepEqual([interruptedA, interruptedB, a.abort.signal.aborted, b.abort.signal.aborted, b.status], [1, 0, true, false, 'running']);
  h.release(opA + ':run'); h.release(opB + ':run'); await tick();
  assert.deepEqual([a.status, b.status, h.scheduler.running], ['interrupted', 'completed', 0]);
});

test('a failing operation is classified failed, reports its error once, and frees its slot', async () => {
  const settled = [];
  const s = new Scheduler(1, async () => { throw new Error('boom'); }, (x, opId, error) => settled.push(error?.message));
  const a = session();
  s.requestSend(a, {});
  await tick();
  assert.deepEqual([a.status, a.lastError, s.running, settled], ['failed', 'boom', 0, ['boom']]);
  assert.equal(s.stop(a), false);   // no-op once finished
});
