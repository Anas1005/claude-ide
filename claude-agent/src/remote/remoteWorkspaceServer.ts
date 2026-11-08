// In-process MCP server that gives Claude the remote host: files, search, commands and git, at any path the remote
// user can reach (API v5). It runs inside this (local) extension host; every tool call goes through
// RemoteFilesystemClient → VS Code command bridge → the remote extension, which canonicalizes paths and applies its
// checks itself. There is no MCP server on the remote host.
import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { createSdkMcpServer, tool, McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { MEDIA_API_VERSION, PATHS_API_VERSION, RemoteFilesystemClient, RemoteFilesystemError, REQUIRED_API_VERSION, REVIEW_API_VERSION } from './remoteFilesystemClient';
import { isUnder, toRemoteAbsolute, toRemotePath } from './remotePaths';
import { fileTools } from './remoteFileTools';
import { execTools } from './remoteExecTools';
import { gitTools } from './remoteGitTools';
import { MUTATING_TOOLS, credentialApprovalKey, credentialTargets, remoteToolName } from './permissions';

/** The two SDK functions this module needs (taken from the lazily imported SDK module). */
export interface SdkMcpApi { createSdkMcpServer: typeof createSdkMcpServer; tool: typeof tool }

/** Where the workspace is, as the remote host reported it. `root` is where relative paths resolve; `home` is "~". */
export interface RemoteWorkspaceHost { hostname: string; platform: string; root: string; apiVersion?: number; home?: string }

/** One file a tool created, changed or deleted: before/after text (null = absent). */
export interface RemoteChange { path: string; before: string | null; after: string | null; afterSha?: string | null }
export type ChangeSource = 'edit' | 'fileOperation' | 'command';
/** Receives changes for review in the editor (set by the chat panel). */
export interface RemoteChangeRecorder { record(changes: RemoteChange[], source: ChangeSource): void }

/** Conversation-scoped state shared by the tools (lives as long as the chat session, not one query). */
export interface RemoteSessionState {
  /** Change review in the editor; absent → changes are not recorded. */
  review?: RemoteChangeRecorder;
  /** Workspace snapshots of background commands, diffed once they are seen to have finished. */
  backgroundSnapshots: Map<string, string>;
  /** sha256 of each remote file (absolute path, as requested and canonical) as last read or written here: writes refuse unexpected changes. */
  fileHashes: Map<string, string>;
  /** Foreground command sessions of the current turn, terminated when the person presses Stop. */
  foreground: Set<string>;
  /** approvalKey()s of exact calls a person approved, consumed by privileged commands and credential access. */
  approvals: Set<string>;
  /** The conversation these tools act for: owner of every command they start (the remote side enforces it, API v4). */
  owner: string;
  /** Session ids of the commands this conversation started: the only ones its tools may inspect or stop. */
  started: Set<string>;
}

export function newSessionState(review?: RemoteChangeRecorder, owner: string = randomUUID()): RemoteSessionState {
  return { review, backgroundSnapshots: new Map(), fileHashes: new Map(), foreground: new Set(), approvals: new Set(), owner, started: new Set() };
}

export const REMOTE_SERVER_NAME = 'remote';

export type ToolResult = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean };

/** Image types read_file returns as images (API v6), by extension; the bytes must match. */
export const IMAGE_EXTENSIONS: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
/** The image type of `bytes` from its signature, or undefined. */
export function imageType(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return undefined;
}
export const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
export const fail = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] });
export const json = (value: unknown) => ok(JSON.stringify(value, null, 1));

/** What a change snapshot covered and what it could not record, for the tool result. */
export interface ReviewReport { recorded: number; skipped: { path: string; skipped: string }[]; truncated: boolean; roots: string[] }

/** Everything a tool group needs. */
export interface ToolContext {
  sdk: SdkMcpApi;
  client: RemoteFilesystemClient;
  host: RemoteWorkspaceHost;
  state: RemoteSessionState;
  /** Model path → absolute remote path (relative to the workspace root, "~" the remote home), or an error result. */
  resolve(input: string | undefined): { ok: true; path: string } | { ok: false; result: ToolResult };
  /** A path from the remote extension as shown to Claude (absolute). */
  absolute(value: string): string;
  /**
   * Credential locations need the user's approval (asked before the call, consumed here): the flag for the remote
   * extension, or the error result when this call was not approved.
   */
  access(tool: string, input: Record<string, unknown>): { allowSensitive: boolean } | ToolResult;
  /** Runs a tool body, mapping every error to a tool error; `needsV2` refuses politely on an older remote extension. */
  guard(body: () => Promise<ToolResult>, needsV2?: boolean): Promise<ToolResult>;
  readOnly: { annotations: { readOnlyHint: true; destructiveHint: false; openWorldHint: false } };
  pathHint: string;
  /** True when changes are recorded for review (a recorder is attached and the remote supports it). */
  reviewing: boolean;
  record(changes: RemoteChange[], source: ChangeSource): void;
  /** Takes a remote snapshot of `roots` (for review), or undefined when not reviewing or it failed. */
  snapshot(roots: string[]): Promise<string | undefined>;
  /** Diffs a snapshot taken by snapshot() and records the changes; what it could not record is reported. Never throws. */
  recordSince(snapshotId: string | undefined, source: ChangeSource): Promise<ReviewReport | undefined>;
}

/**
 * The review note for a tool result: which locations were snapshotted, what changed there but could not be recorded,
 * and which other paths the call named (changes there are not recorded for review and Restore cannot undo them).
 */
export function reviewNote(report: ReviewReport | undefined, named: string[], platform: string): string | undefined {
  if (!report) return undefined;
  const outside = [...new Set(named.filter(p => !report.roots.some(r => isUnder(p, r, platform))))];
  const lines: string[] = [];
  if (report.skipped.length) lines.push(`Changed but not recorded for review: ${report.skipped.slice(0, 20).map(s => `${s.path} (${s.skipped})`).join(', ')}${report.skipped.length > 20 ? ', …' : ''}.`);
  if (report.truncated) lines.push(`The review snapshot of ${report.roots.join(', ')} was incomplete (too many files or changes): some changes there may not be recorded.`);
  if (outside.length) lines.push(`Changes outside ${report.roots.join(', ')} are not recorded for review and cannot be undone with Restore; this call also named: ${outside.slice(0, 20).join(', ')}.`);
  return lines.length ? lines.join(' ') : undefined;
}

export function errorText(e: unknown): string {
  if (e instanceof RemoteFilesystemError) {
    const hint = e.code === 'REMOTE_NOT_AVAILABLE' ? ' The remote workspace extension (claude-agent-remote) must be installed and running on the remote host.' : '';
    return `${e.code}: ${e.detail}${hint}`;
  }
  return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
}

function toolContext(sdk: SdkMcpApi, client: RemoteFilesystemClient, host: RemoteWorkspaceHost, state: RemoteSessionState): ToolContext {
  const reviewing = !!state.review && (host.apiVersion ?? 1) >= REVIEW_API_VERSION;
  const where = { root: host.root, home: host.home, platform: host.platform };
  return {
    sdk, client, host, state,
    resolve: input => {
      // Older remote extensions accept workspace-relative paths only: say so instead of sending paths they refuse.
      if ((host.apiVersion ?? 1) < PATHS_API_VERSION) {
        return { ok: false, result: fail(`UNSUPPORTED: the remote workspace extension on ${host.hostname} is too old (API ${host.apiVersion ?? 1}). Install claude-agent-remote 0.5.0 or later there.`) };
      }
      const converted = toRemotePath(input, host.root, host.platform, host.home);
      return converted.ok ? converted : { ok: false, result: fail(`INVALID_REQUEST: ${converted.message}`) };
    },
    absolute: value => toRemoteAbsolute(value, host.root, host.platform),
    access: (tool, input) => {
      const credentials = credentialTargets(tool, input, where);
      if (credentials.length === 0) return { allowSensitive: false };
      if (state.approvals.delete(credentialApprovalKey(remoteToolName(tool), credentials))) return { allowSensitive: true };
      return fail(`SENSITIVE_PATH_NOT_APPROVED: ${credentials.join(', ')} is a credential location; the user did not approve this access.`);
    },
    guard: async (body, needsV2 = false) => {
      if (needsV2 && (host.apiVersion ?? 1) < REQUIRED_API_VERSION) {
        return fail(`UNSUPPORTED: the remote workspace extension on ${host.hostname} is too old for this tool. Install claude-agent-remote 0.2.0 or later there.`);
      }
      try { return await body(); } catch (e) { return fail(errorText(e)); }
    },
    readOnly: { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    pathHint: `Absolute path anywhere on the remote host, or relative to the workspace root ${host.root}`,
    reviewing,
    record: (changes, source) => { if (reviewing && changes.length) state.review!.record(changes, source); },
    snapshot: async roots => (reviewing ? (await client.snapshotBegin(roots).catch(() => undefined))?.snapshotId : undefined),
    recordSince: async (snapshotId, source) => {
      if (!snapshotId) return undefined;
      const diff = await client.snapshotDiff(snapshotId).catch(() => undefined);
      if (!diff) return undefined;
      state.review!.record(diff.changes.map(c => ({ path: c.path, before: c.before, after: c.after, afterSha: c.afterSha })), source);
      return { recorded: diff.changes.length, skipped: diff.skipped.map(s => ({ path: s.path, skipped: s.skipped })), truncated: diff.truncated, roots: diff.roots ?? [host.root] };
    },
  };
}

/** Runs `body` exclusively (a window-wide lock shared by every conversation's remote server). */
export type Exclusive = <T>(body: () => Promise<T>) => Promise<T>;

/** A FIFO lock: one body at a time, in call order. */
export function createExclusive(): Exclusive {
  let tail: Promise<unknown> = Promise.resolve();
  return body => {
    const run = tail.then(body, body);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * All remote tools; `instructions` repeat the workspace facts for the model. A new server is created for every query.
 * `exclusive`, when given, serializes the mutating tools (files, processes, git) across conversations, so their
 * remote changes and change snapshots never interleave; read-only tools stay concurrent.
 */
export function createRemoteWorkspaceServer(sdk: SdkMcpApi, client: RemoteFilesystemClient, host: RemoteWorkspaceHost, state: RemoteSessionState = newSessionState(), exclusive?: Exclusive): McpSdkServerConfigWithInstance {
  const ctx = toolContext(sdk, client, host, state);
  const { readOnly, pathHint } = ctx;
  const absolute = <T extends { path: string }>(items: T[]) => items.map(i => ({ ...i, path: ctx.absolute(i.path) }));
  /** Resolves the path and the credential approval, then runs the body. */
  const withPath = (tool: string, input: Record<string, unknown>, value: string | undefined, body: (target: string, allowSensitive: boolean) => Promise<ToolResult>, needsV2 = false) => {
    const target = ctx.resolve(value);
    if (!target.ok) return Promise.resolve(target.result);
    const access = ctx.access(tool, input);
    if ('content' in access) return Promise.resolve(access);
    return ctx.guard(() => body(target.path, access.allowSensitive), needsV2);
  };

  return sdk.createSdkMcpServer({
    name: REMOTE_SERVER_NAME,
    version: '2.0.0',
    alwaysLoad: true,
    instructions: `These tools work on the remote ${host.platform} host "${host.hostname}" (workspace root ${host.root}${host.home ? `, home ${host.home}` : ''}). `
      + 'Any path the remote user can access works: absolute paths anywhere (other projects included), paths relative to the workspace root, and ~. '
      + 'Commands run on that host, never on the user\'s computer. Read a file before replacing it with write_file; prefer apply_patch for edits.',
    tools: [
      sdk.tool('read_file', 'Read a UTF-8 text file on the remote host (optionally only some lines), or view a PNG, JPEG, GIF or WebP image (at most 5 MB).', {
        file_path: z.string().describe(pathHint),
        offset: z.number().int().min(1).optional().describe('First line to return (1-based)'),
        limit: z.number().int().min(1).optional().describe('Maximum number of lines to return'),
      }, a => withPath('read_file', a, a.file_path, async (target, allowSensitive) => {
        const { offset, limit } = a;
        const ext = /\.([A-Za-z0-9]+)$/.exec(target)?.[1]?.toLowerCase();
        if (ext && IMAGE_EXTENSIONS[ext]) {
          if ((host.apiVersion ?? 1) < MEDIA_API_VERSION) {
            return fail(`UNSUPPORTED: viewing images needs claude-agent-remote 0.6.0 or later on ${host.hostname} (it has API ${host.apiVersion ?? 1}). Text files still work.`);
          }
          const img = await client.readFileBytes(target, { allowSensitive });
          const bytes = Buffer.from(img.base64, 'base64');
          const type = imageType(bytes);
          if (!type) return fail(`INVALID_REQUEST: ${img.path} is named .${ext} but its content is not a PNG, JPEG, GIF or WebP image.`);
          return { content: [{ type: 'text', text: `${img.path} (${type}, ${img.size} bytes)` }, { type: 'image', data: img.base64, mimeType: type }] };
        }
        const { content, sha256, path: canonical } = await client.readFileDetails(target, { allowSensitive });
        if (sha256) for (const p of new Set([target, canonical ?? target])) state.fileHashes.set(p, sha256);
        if (offset === undefined && limit === undefined) return ok(content);
        const lines = content.split('\n');
        const start = (offset ?? 1) - 1;
        return ok(lines.slice(start, limit === undefined ? undefined : start + limit).join('\n'));
      }), readOnly),

      sdk.tool('list_directory', 'List the files and directories directly inside a directory on the remote host. Symbolic links are listed with the type of what they point to.', {
        path: z.string().optional().describe(`${pathHint}. Defaults to the workspace root.`),
      }, a => withPath('list_directory', a, a.path, async (target, allowSensitive) => json(absolute(await client.listDirectory(target, { allowSensitive })))), readOnly),

      sdk.tool('stat', 'Get the type (file, directory, symlink, other), size and timestamps of a path on the remote host. A symbolic link is reported as a link, with its target.', {
        file_path: z.string().describe(pathHint),
      }, a => withPath('stat', a, a.file_path, async (target, allowSensitive) => {
        const s = await client.stat(target, { allowSensitive });
        return json({ ...s, path: ctx.absolute(s.path) });
      }), readOnly),

      sdk.tool('search_files', 'Find files and directories on the remote host under a directory: by NAME containing the query (case-insensitive), '
        + 'and/or FILES whose path relative to that directory matches a glob pattern (e.g. "**/*.ts", "src/*.{c,h}"; a pattern without "/" matches at any depth). '
        + 'Give query, pattern or both. This does not search file contents (use search_content). Skips .git, node_modules, dist, build, symbolic links and credential folders.', {
        query: z.string().min(1).optional().describe('Part of a file or directory name'),
        pattern: z.string().min(1).optional().describe('Glob over paths relative to the searched directory (**, *, ?, {a,b}); matches files only'),
        path: z.string().optional().describe(`Directory to search in. ${pathHint}. Defaults to the workspace root.`),
        max_results: z.number().int().min(1).max(1000).optional().describe('Defaults to 200'),
      }, a => {
        if (!a.query && !a.pattern) return Promise.resolve(fail('INVALID_REQUEST: give query, pattern or both.'));
        if (a.pattern && (host.apiVersion ?? 1) < MEDIA_API_VERSION) {
          return Promise.resolve(fail(`UNSUPPORTED: glob patterns need claude-agent-remote 0.6.0 or later on ${host.hostname} (it has API ${host.apiVersion ?? 1}). Use query, or search_content with include globs.`));
        }
        return withPath('search_files', a, a.path, async (target, allowSensitive) =>
          json(absolute(await client.searchFiles(a.query ?? '', { path: target, maxResults: a.max_results, allowSensitive, pattern: a.pattern }))));
      }, readOnly),

      ...fileTools(ctx),
      ...execTools(ctx),
      ...gitTools(ctx),
    ].map(t => (exclusive && MUTATING_TOOLS.includes(t.name) ? { ...t, handler: (args: any, extra: unknown) => exclusive(() => t.handler(args, extra)) } : t)),
  });
}
