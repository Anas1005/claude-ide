// Per-conversation presentation state (multi-conversation spec §6): what the chat panel shows for one conversation,
// kept in the extension host whether or not that conversation is displayed, so switching back (or a recreated panel)
// gets one snapshot. It holds panel events (turns, streamed text, tool calls, prompts, notes), already merged —
// consecutive text chunks are one entry and answered prompts carry their answer — not a raw SDK message log.
// No dependency on `vscode`.

/** One panel event about a conversation (same shapes the panel renders). */
export interface PanelEvent { type: string; [key: string]: any }

export interface PresentationState {
  events: PanelEvent[];
  busy: boolean;
  /** Unsent input-box text. */
  draft: string;
}

/** Event types that belong to a conversation; everything else the panel receives is window-wide. */
export const CONVERSATION_EVENTS = new Set([
  'reset', 'title', 'user', 'rewound', 'busy', 'textDelta', 'assistantText', 'tool', 'toolResult',
  'permission', 'question', 'answered', 'done', 'scrollBottom', 'note', 'mode', 'error',
]);

/** Upper bound on kept events per conversation; older ones are dropped (the transcript keeps everything). */
export const MAX_EVENTS = 5000;

export const emptyPresentation = (): PresentationState => ({ events: [], busy: false, draft: '' });

/**
 * Applies `ev` to `state` and returns the event to forward to a panel that is showing this conversation (it can
 * differ from what is kept: a restore is forwarded as is, but kept as the shortened history plus a note).
 */
export function applyEvent(state: PresentationState, ev: PanelEvent): PanelEvent {
  const events = state.events;
  switch (ev.type) {
    case 'reset':
      events.length = 0;
      state.busy = false;
      break;
    case 'busy':
      state.busy = !!ev.value;
      events.push(ev);
      break;
    case 'textDelta': {
      const last = events[events.length - 1];
      if (last?.type === 'textDelta') events[events.length - 1] = { ...last, text: last.text + ev.text };
      else events.push({ ...ev });
      break;
    }
    case 'rewound': {
      const i = events.findIndex(e => e.type === 'user' && e.turn === ev.turn);
      if (i >= 0) events.length = i;
      if (events.some(e => e.type === 'user')) events.push({ type: 'note', text: ev.files ? `Restored ${ev.files} file${ev.files > 1 ? 's' : ''}.` : 'No files needed restoring.' });
      break;
    }
    case 'answered': {
      const prompt = events.find(e => (e.type === 'permission' || e.type === 'question') && e.id === ev.id);
      if (prompt) Object.assign(prompt, { answered: ev.choice });
      break;
    }
    default:
      events.push(ev);
  }
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  return ev;
}

/** Whether a transcript (SDK session messages) ends with a finished assistant turn; otherwise the last turn was cut off. */
export function transcriptComplete(messages: { type: string; parent_tool_use_id: string | null; message: unknown }[]): boolean {
  const main = messages.filter(m => m.parent_tool_use_id == null && (m.type === 'user' || m.type === 'assistant'));
  const last = main[main.length - 1];
  if (!last) return true;
  const stop = (last.message as { stop_reason?: string } | undefined)?.stop_reason;
  return last.type === 'assistant' && (stop === 'end_turn' || stop === 'stop_sequence' || stop === 'max_tokens');
}
