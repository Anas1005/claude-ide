// Presentation state per conversation (multi-conversation spec §6): merged events, restore, answered prompts, and
// detection of a transcript whose last turn was cut off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadModules } from './helpers/build.mjs';

const [{ applyEvent, emptyPresentation, transcriptComplete, MAX_EVENTS }] = await loadModules('src/presentation.ts');

test('events are merged into state: streamed text, busy, answered prompts, restore, reset', () => {
  const st = emptyPresentation();
  for (const ev of [
    { type: 'user', text: 'one', turn: 't1' }, { type: 'busy', value: true },
    { type: 'textDelta', text: 'Hel' }, { type: 'textDelta', text: 'lo' },
    { type: 'permission', id: 'p1', title: 'Bash' }, { type: 'answered', id: 'p1', choice: 'Allow once' },
    { type: 'done' }, { type: 'busy', value: false },
    { type: 'user', text: 'two', turn: 't2' }, { type: 'assistantText', text: 'x' },
  ]) applyEvent(st, ev);
  assert.deepEqual(st.events.map(e => e.type), ['user', 'busy', 'textDelta', 'permission', 'done', 'busy', 'user', 'assistantText']);
  assert.deepEqual([st.events[2].text, st.events[3].answered, st.busy], ['Hello', 'Allow once', false]);

  const forwarded = applyEvent(st, { type: 'rewound', turn: 't2', files: 2 });
  assert.equal(forwarded.type, 'rewound');   // the live panel applies the restore itself
  assert.deepEqual(st.events.slice(-2).map(e => [e.type, e.text]), [['busy', undefined], ['note', 'Restored 2 files.']]);

  applyEvent(st, { type: 'reset', title: 'x' });
  assert.deepEqual([st.events, st.busy], [[], false]);
});

test('kept events are bounded', () => {
  const st = emptyPresentation();
  for (let i = 0; i < MAX_EVENTS + 10; i++) applyEvent(st, { type: 'note', text: String(i) });
  assert.deepEqual([st.events.length, st.events[0].text], [MAX_EVENTS, '10']);
});

test('a transcript is complete only when the last main-thread message is a finished assistant turn', () => {
  const a = stop => ({ type: 'assistant', parent_tool_use_id: null, message: { stop_reason: stop } });
  const u = { type: 'user', parent_tool_use_id: null, message: {} };
  const sub = { type: 'user', parent_tool_use_id: 'x', message: {} };
  assert.deepEqual([
    transcriptComplete([]), transcriptComplete([u, a('end_turn')]), transcriptComplete([u, a('end_turn'), sub]),
    transcriptComplete([u, a('tool_use')]), transcriptComplete([u, a('end_turn'), u]), transcriptComplete([u, a(null)]),
  ], [true, true, true, false, false, false]);
});
