// Remote command tools: execute_command, process_status, terminate_process.
// Commands run on the remote host in any directory (default the workspace root). Privileged commands run only with the exact input a
// person approved; foreground commands stop when the call is cancelled.
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { ExecSession } from './remoteFilesystemClient';
import { approvalKey, classifyCommand, pathsInCommand, remoteToolName } from './permissions';
import { ReviewReport, ToolContext, ToolResult, fail, json, reviewNote } from './remoteWorkspaceServer';

const POLL_MS = 300;
const OUTPUT_CHARS = 30000;

/** Tail of a stream for the model, saying how much was left out. */
function tail(slice: ExecSession['stdout']) {
  const text = slice.text.length > OUTPUT_CHARS ? slice.text.slice(-OUTPUT_CHARS) : slice.text;
  const omitted = slice.totalBytes - Buffer.byteLength(text);
  return omitted > 0 ? `[${omitted} earlier bytes omitted; use process_status with an offset to page]\n${text}` : text;
}

export function report(s: ExecSession) {
  return {
    session_id: s.sessionId, state: s.state, exit_code: s.exitCode, signal: s.signal, timed_out: s.timedOut, terminated: s.terminated,
    duration_ms: s.durationMs, cwd: s.cwd, ...(s.error ? { error: s.error } : {}),
    stdout: tail(s.stdout), stderr: tail(s.stderr),
    stdout_next_offset: s.stdout.nextOffset, stderr_next_offset: s.stderr.nextOffset,
  };
}

type EnvList = { name: string; value: string }[];
/** execute_command takes env as a list (zod records do not survive the SDK's JSON Schema conversion). */
const envRecord = (env: EnvList | undefined) => (env ? Object.fromEntries(env.map(e => [e.name, e.value])) : undefined);

/** The fields a privileged-command approval is bound to (the same on both sides of the approval). */
export const commandApprovalInput = (a: { command: string; args?: string[]; cwd?: string; env?: EnvList }) =>
  ({ command: a.command, args: a.args ?? null, cwd: a.cwd ?? null, env: envRecord(a.env) ?? null });

export function execTools(ctx: ToolContext) {
  const { sdk, client, state, host, readOnly } = ctx;

  const owner = state.owner;
  /** Only commands this conversation started can be inspected or stopped from it (also enforced remotely, API v4). */
  const notOurs = (sessionId: string): ToolResult | undefined => (state.started.has(sessionId) ? undefined
    : fail('PROCESS_NOT_FOUND: no process with that session ID was started in this conversation.'));

  /** Paths each background command named, for its review note when it is seen to have finished. */
  const named = new Map<string, string[]>();
  /** A background command seen to have finished: record what it changed, once; the review note says what was not covered. */
  const finished = async (s: ExecSession): Promise<ExecSession & { review?: string }> => {
    const snapshot = state.backgroundSnapshots.get(s.sessionId);
    if (snapshot && s.state !== 'running') {
      state.backgroundSnapshots.delete(s.sessionId);
      const note = reviewNote(await ctx.recordSince(snapshot, 'command'), named.get(s.sessionId) ?? [], host.platform);
      named.delete(s.sessionId);
      return note ? { ...s, review: note } : s;
    }
    return s;
  };
  const withNote = (r: object, note: string | undefined) => (note ? { ...r, review: note } : r);

  return [
    sdk.tool('execute_command', `Run a command on the remote ${host.platform} host (never on the user's computer), in any directory (default the workspace root). `
      + 'Without args, command is a shell command line (pipes, &&, redirects work). With args, command is a program run directly. '
      + 'stdin is closed (no interactive prompts). Use run_in_background for servers or long jobs, then process_status / terminate_process.', {
      command: z.string().min(1).describe('Shell command line, or a program name when args is given'),
      args: z.array(z.string()).max(1000).optional().describe('Arguments; when present no shell is used'),
      cwd: z.string().optional().describe(`Working directory. ${ctx.pathHint}. Defaults to the workspace root.`),
      env: z.array(z.object({ name: z.string(), value: z.string() })).max(50).optional().describe('Extra environment variables'),
      timeout_seconds: z.number().int().min(1).max(86400).optional().describe('Foreground default 120 (max 1800); background default 3600'),
      run_in_background: z.boolean().optional().describe('Return immediately with a session_id instead of waiting'),
    }, async (a, extra) => {
      const cwd = ctx.resolve(a.cwd);
      if (!cwd.ok) return cwd.result;
      const background = a.run_in_background === true;
      const timeoutMs = a.timeout_seconds !== undefined ? Math.min(a.timeout_seconds, background ? 86400 : 1800) * 1000 : undefined;
      const risk = classifyCommand(a.command, a.args);
      if (risk.privileged && !state.approvals.delete(approvalKey(remoteToolName('execute_command'), commandApprovalInput(a)))) {
        return fail('PRIVILEGE_NOT_APPROVED: this command uses privilege escalation and was not approved by the user for this exact input.');
      }
      return ctx.guard(async () => {
        // Files the command creates, changes or deletes under the workspace root and its working directory are recorded
        // for review; the result names any other paths it mentions, whose changes are not recorded.
        const mentioned = pathsInCommand(a.command, a.args, host.home, host.platform);
        const snapshot = await ctx.snapshot([host.root, cwd.path]);
        let s: ExecSession;
        try {
          s = await client.execStart({ command: a.command, args: a.args, cwd: cwd.path, env: envRecord(a.env), timeoutMs, background, allowPrivileged: risk.privileged, owner, correlationId: randomUUID() });
          state.started.add(s.sessionId);
        } catch (e) {
          if (snapshot) void client.snapshotDiscard(snapshot).catch(() => undefined);
          throw e;
        }
        if (background) {
          if (snapshot) { state.backgroundSnapshots.set(s.sessionId, snapshot); named.set(s.sessionId, mentioned); }
          await new Promise(r => setTimeout(r, 1000));
          const done = await finished(await client.execStatus({ sessionId: s.sessionId, owner }));
          return json(withNote({ ...report(done), note: 'Running in the background. Use process_status with this session_id to read output, terminate_process to stop it.' }, done.review));
        }
        const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
        state.foreground.add(s.sessionId);
        let review: ReviewReport | undefined;
        try {
          while (s.state === 'running') {
            if (signal?.aborted) {
              s = await client.execTerminate({ sessionId: s.sessionId, graceMs: 2000, owner });
              break;
            }
            await new Promise(r => setTimeout(r, POLL_MS));
            s = await client.execStatus({ sessionId: s.sessionId, maxBytes: 0, owner });
          }
          s = await client.execStatus({ sessionId: s.sessionId, owner });   // final output tail
        } finally {
          state.foreground.delete(s.sessionId);
          review = await ctx.recordSince(snapshot, 'command');
        }
        return json(withNote(report(s), reviewNote(review, mentioned, host.platform)));
      }, true);
    }, { annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }),

    sdk.tool('process_status', 'List the commands started in this conversation on the remote host, or show one (state, exit code, output). '
      + 'Pass stdout_offset/stderr_offset (the *_next_offset values from earlier) to read only new output.', {
      session_id: z.string().optional().describe('Omit to list all'),
      stdout_offset: z.number().int().min(0).optional(),
      stderr_offset: z.number().int().min(0).optional(),
    }, a => ctx.guard(async () => {
      if (!a.session_id) {
        const list = await client.execList(owner);
        // An older remote extension lists every command: keep this conversation's own.
        const sessions = (Array.isArray(list.sessions) ? list.sessions as { sessionId: string; state: string }[] : []).filter(s => state.started.has(s.sessionId));
        const notes: Record<string, string> = {};
        for (const s of sessions) {
          if (s.state !== 'running' && state.backgroundSnapshots.has(s.sessionId)) {
            const done = await finished(s as unknown as ExecSession);
            if (done.review) notes[s.sessionId] = done.review;
          }
        }
        return json({ ...list, sessions: sessions.map(s => withNote(s, notes[s.sessionId])) });
      }
      if (notOurs(a.session_id)) return notOurs(a.session_id)!;
      const done = await finished(await client.execStatus({ sessionId: a.session_id, stdoutOffset: a.stdout_offset, stderrOffset: a.stderr_offset, maxBytes: 64 * 1024, owner }));
      return json(withNote(report(done), done.review));
    }, true), readOnly),

    sdk.tool('terminate_process', 'Stop a command started in this conversation on the remote host (its whole process group). Sends SIGTERM, then SIGKILL '
      + 'after a short grace period; force sends SIGKILL at once. Only processes started in this conversation can be stopped.', {
      session_id: z.string().min(1),
      force: z.boolean().optional(),
    }, a => ctx.guard(async () => {
      if (notOurs(a.session_id)) return notOurs(a.session_id)!;
      const done = await finished(await client.execTerminate({ sessionId: a.session_id, force: a.force, graceMs: 3000, owner }));
      return json(withNote(report(done), done.review));
    }, true),
    { annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }),
  ];
}
