// Conversations and their scheduling (multi-conversation spec §2–§4). One ConversationSession per conversation holds
// every piece of per-request state; the Scheduler runs sessions' operations with a concurrency limit and makes Stop
// reliable in every cancelable state (queued, starting, running, waiting for permission).
// No runtime dependency on `vscode`, so it can be tested on its own.
import { randomUUID } from 'crypto';
import type { CanUseTool, HookCallback, Query } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import type { RemoteSessionState } from './remote/remoteWorkspaceServer';
import type { WorkspaceSnapshot } from './review';
import { emptyPresentation, PresentationState } from './presentation';

export type Mode = 'auto' | 'ask' | 'askBeforeEach' | 'plan';
/** `idle` = no operation has run yet in this session; the rest are the §4 operation states. */
export type SessionStatus = 'idle' | 'queued' | 'starting' | 'running' | 'waiting-for-permission' | 'stopping' | 'completed' | 'failed' | 'interrupted';
const CANCELABLE: SessionStatus[] = ['queued', 'starting', 'running', 'waiting-for-permission'];

/** Where a conversation runs. Frozen when the session is created. */
export interface SessionWorkspace { readonly cwd: string; readonly folderPath: string | undefined; readonly isRemote: boolean }

export class ConversationSession {
  /** Stable for the conversation's lifetime; the routing key. Never the CLI's id, except for conversations created before this id existed (§3). */
  readonly conversationId: string;
  /** The CLI's session id (from `system/init`); may be absent (new conversation) or change (resume/fork). */
  sdkSessionId: string | undefined;
  status: SessionStatus = 'idle';
  currentOperationId: string | undefined;
  cancellationIntent: { operationId: string; requestedAt: number } | undefined;
  lastError: string | undefined;
  q: Query | undefined;
  abort: AbortController | undefined;
  /** The current prompt's id (checkpoints and "Restore to here" are keyed by it). */
  turn = '';
  /** Set by "Restore to here": the next prompt continues the conversation from this transcript entry. */
  rewindTo: string | undefined;
  title = 'New chat';
  readonly permissionWaiters = new Map<string, (choice: string) => void>();
  readonly bashSnaps = new Map<string, WorkspaceSnapshot>();
  /** tool_use_ids holding the shared path lock (released after the tool, or when the operation ends). */
  readonly heldLocks = new Set<string>();
  /** Remote tool state of this conversation: file hashes, running foreground commands, approved privileged calls. */
  remoteSession: RemoteSessionState | undefined;
  /** "Always allow" choices of this conversation (never used for risky remote calls). */
  readonly alwaysAllowed = new Set<string>();
  /** What the panel shows for this conversation (§6), kept up to date whether or not it is displayed. */
  readonly presentation: PresentationState = emptyPresentation();
  /** Incremented on every presentation change; panels apply deltas only in sequence. */
  seq = 0;
  /** Its transcript is being loaded: changes are kept, not forwarded, until one snapshot is sent. */
  loading = false;
  /** Bound to this session when it is created (see ChatProvider.bindCallbacks); never resolve the session later. */
  canUseTool!: CanUseTool;
  preToolUse!: HookCallback;
  postToolUse!: HookCallback;
  permissionDenied!: HookCallback;

  constructor(readonly workspace: SessionWorkspace, public model: string, public effort: string, public mode: Mode, conversationId?: string) {
    this.conversationId = conversationId ?? randomUUID();
  }

  /** An operation is accepted and not finished (queued, starting, running, waiting, stopping). */
  get busy() { return this.currentOperationId !== undefined; }
}

/** Thrown inside an operation when Stop arrived before the SDK query existed. */
export const CANCELLED_BEFORE_START = new Error('cancelled before start');

/** The body of one operation: may throw CANCELLED_BEFORE_START at its checkpoints (see `cancelled`). */
export type OperationBody<A> = (session: ConversationSession, opId: string, args: A) => Promise<void>;

export class Scheduler<A> {
  /** Operations that have been dequeued and not finished. */
  running = 0;
  private readonly runQueue: { session: ConversationSession; opId: string; args: A }[] = [];

  /** `onSettled` runs once per accepted operation when it is over: finished, failed, stopped, or dropped from the queue. */
  constructor(public maxConcurrentRunning: number, private readonly body: OperationBody<A>,
    private readonly onSettled: (session: ConversationSession, opId: string, error?: unknown) => void = () => undefined) { }

  /** Accepts an operation: its identity exists from this moment, so Stop can never be lost. Synchronous. */
  requestSend(session: ConversationSession, args: A): string {
    const opId = session.currentOperationId = randomUUID();
    session.cancellationIntent = undefined;
    session.lastError = undefined;
    session.status = 'queued';
    this.runQueue.push({ session, opId, args });
    this.drainQueue();
    return opId;
  }

  /** Whether Stop was requested for this operation (checked at each phase boundary of the body). */
  cancelled(session: ConversationSession, opId: string) { return session.cancellationIntent?.operationId === opId; }

  get queued() { return this.runQueue.length; }

  private drainQueue() {
    while (this.running < this.maxConcurrentRunning && this.runQueue.length) {
      const { session, opId, args } = this.runQueue.shift()!;   // removed permanently: never processed twice
      if (this.cancelled(session, opId)) {
        session.status = 'interrupted';
        session.currentOperationId = undefined;
        this.onSettled(session, opId);
        continue;                                               // never started: `running` untouched
      }
      this.running++;
      void this.runSend(session, opId, args);
    }
  }

  private async runSend(session: ConversationSession, opId: string, args: A) {
    session.status = 'starting';
    let error: unknown;
    try {
      await this.body(session, opId, args);
    } catch (e: any) {
      if (e !== CANCELLED_BEFORE_START) { error = e; session.lastError = String(e?.message ?? e); }
    } finally {
      if (session.currentOperationId === opId) {
        session.status = this.cancelled(session, opId) ? 'interrupted' : session.lastError ? 'failed' : 'completed';
        session.q = undefined;
        session.currentOperationId = undefined;
      }
      this.running--;
      this.onSettled(session, opId, error);
      this.drainQueue();
    }
  }

  /**
   * Stops this session's current operation only. Valid while queued, starting, running or waiting for permission;
   * otherwise a no-op. Returns whether a stop was requested. `terminateRemote` ends the session's own remote commands.
   */
  stop(session: ConversationSession, terminateRemote?: (session: ConversationSession) => void): boolean {
    if (!CANCELABLE.includes(session.status) || !session.currentOperationId) return false;
    const opId = session.currentOperationId;
    session.cancellationIntent = { operationId: opId, requestedAt: Date.now() };
    if (session.status === 'queued') {
      // Never started: leave the queue now rather than when a slot frees up. `running` is untouched.
      const i = this.runQueue.findIndex(e => e.opId === opId);
      if (i >= 0) this.runQueue.splice(i, 1);
      session.status = 'interrupted';
      session.currentOperationId = undefined;
      this.onSettled(session, opId);
      return true;
    }
    session.status = 'stopping';
    if (session.q) { void session.q.interrupt().catch(() => undefined); }
    session.abort?.abort();   // settles this session's permission prompts through their abort listeners
    terminateRemote?.(session);
    // No query yet: the operation observes cancellationIntent at its next checkpoint and ends itself.
    return true;
  }
}
