import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import type { Options, PermissionMode, PermissionResult, PermissionUpdate, PreToolUseHookInput, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { startRecording, stopRecording } from './voice';
import { claudeConfigDir, CliLaunch, findClaude as discoverClaude, nodeDirFor } from './claudeCli';
import { log, ReviewConflict, ReviewStore, registerReviewUi, snapshotWorkspace, recordBashChanges, proposed, PROPOSED_SCHEME } from './review';
import { registerRemoteGuard } from './remoteGuard';
import { createRemoteFilesystemClient, DEFAULT_TIMEOUT_MS, RemoteFilesystemClient } from './remote/remoteFilesystemClient';
import { ChangeSource, createExclusive, createRemoteWorkspaceServer, newSessionState, RemoteChange, RemoteWorkspaceHost } from './remote/remoteWorkspaceServer';
import { RemoteReviewFiles } from './remote/remoteReviewFiles';
import { isToolAllowedInRemoteMode, loadProjectInstructions, sanitizeAgentInput, SUBAGENT_TOOLS, remotePlaceholderDir, remoteQueryOptions, workspaceMode } from './remote/remoteMode';
import { approvalKey, classifyCommand, credentialApprovalKey, pathsInCommand, remoteToolDecision } from './remote/permissions';
import { commandApprovalInput } from './remote/remoteExecTools';
import { previewEdits } from './remote/remoteFileTools';
import { isUnder, toRemotePath } from './remote/remotePaths';
import { CANCELLED_BEFORE_START, ConversationSession, Mode, Scheduler, SessionWorkspace } from './session';
import { applyEvent, CONVERSATION_EVENTS, PanelEvent, transcriptComplete } from './presentation';

const SDK_MODE: Record<Mode, PermissionMode> = { auto: 'acceptEdits', ask: 'acceptEdits', askBeforeEach: 'default', plan: 'plan' };
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
type Image = { name: string; mediaType: string; data: string };

/** The prompt as one streamed user message: carries images, and our own uuid so "Restore to here" can find it in the transcript. */
async function* userMessage(text: string, images: Image[], uuid: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user', uuid, parent_tool_use_id: null,
    message: { role: 'user', content: [...images.map(i => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType as 'image/png', data: i.data } })), { type: 'text' as const, text }] },
  } as SDKUserMessage;
}
/** Splits a transcript prompt back into what the user typed and the files they attached (see `send`). */
function parsePrompt(text: string) {
  let refs: string[] = [];
  text = text.replace(/\n\n\(Attached: (.*)\)$/, (_, a: string) => { refs = a.split(' ').map(r => r.replace(/^@/, '')); return ''; });
  text = text.replace(/\n\n\((Current file: @[^\n]*|Selection in @[\s\S]*)$/, '');
  return { text, refs };
}
const cfg = () => vscode.workspace.getConfiguration('claudeIde');
const sdk = () => import('@anthropic-ai/claude-agent-sdk');

const isWin = process.platform === 'win32';
/** VS Code writes Windows drive letters in lowercase (c:\\); Claude reports C:\\. Match VS Code so paths compare equal. */
const normPath = (p: string) => (isWin ? p.replace(/^[A-Z]:/, d => d.toLowerCase()) : p);
const pathKey = () => Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';   // "Path" on Windows
/** Claude Code's configuration directory (CLAUDE_CONFIG_DIR, else ~/.claude), with a trailing separator, as VS Code writes paths. */
const claudeHome = () => normPath(path.join(claudeConfigDir(), path.sep));

/** The CLI and how to launch it (the `claudePath` setting, install locations, PATH; Windows npm shims resolved). */
function findClaude(): CliLaunch | undefined {
  return discoverClaude(cfg().get<string>('claudePath') || undefined);
}

/** A selection's lines, 1-based and inclusive; a selection ending at the start of a line does not include that line. */
function selectionLines(sel: vscode.Selection): [number, number] {
  const last = sel.end.line > sel.start.line && sel.end.character === 0 ? sel.end.line - 1 : sel.end.line;
  return [sel.start.line + 1, last + 1];
}

const shortInput = (name: string, input: any, cwd: string): string => {
  const rel = (p?: string) => {
    if (!p) return '';
    for (const base of [cwd, (() => { try { return fs.realpathSync(cwd); } catch { return cwd; } })()]) {
      const r = path.relative(base, p);
      if (!r.startsWith('..') && !path.isAbsolute(r)) return r || p;
    }
    return p;
  };
  switch (name) {
    case 'Read': return rel(input.file_path);
    case 'Edit': case 'MultiEdit': case 'Write': return rel(input.file_path);
    case 'NotebookEdit': return rel(input.notebook_path);
    case 'Bash': return input.command ?? '';
    case 'Grep': return `${input.pattern}${input.path ? ' in ' + rel(input.path) : ''}`;
    case 'Glob': return input.pattern ?? '';
    case 'WebFetch': return input.url ?? '';
    case 'WebSearch': return input.query ?? '';
    case 'Task': case 'Agent': return input.description ?? '';
    case 'TodoWrite': return `${input.todos?.length ?? 0} todos`;
    case 'mcp__remote__read_file': case 'mcp__remote__stat': return input.file_path ?? '';
    case 'mcp__remote__list_directory': return input.path ?? '.';
    case 'mcp__remote__search_files': return `${input.query}${input.path ? ' in ' + input.path : ''}`;
    case 'mcp__remote__search_content': return `${input.pattern}${input.path ? ' in ' + input.path : ''}`;
    case 'mcp__remote__write_file': return input.file_path ?? '';
    case 'mcp__remote__apply_patch': return (input.files ?? []).map((f: any) => f.file_path).join(', ');
    case 'mcp__remote__file_operation': return `${input.operation} ${input.path ?? ''}${input.destination ? ' → ' + input.destination : ''}`;
    case 'mcp__remote__execute_command': return [input.command, ...(input.args ?? [])].join(' ');
    case 'mcp__remote__process_status': case 'mcp__remote__terminate_process': return input.session_id ?? 'all';
    case 'mcp__remote__git_status': case 'mcp__remote__git_diff': case 'mcp__remote__git_log': return input.repository ?? '.';
    case 'mcp__remote__git_operation': return `${input.operation}${input.name ? ' ' + input.name : ''}${input.message ? ': ' + input.message : ''}`;
    default: return JSON.stringify(input).slice(0, 120);
  }
};
const editStats = (name: string, input: any) => {
  const lines = (s?: string) => (s ? s.split('\n').length : 0);
  if (name === 'Edit') return { add: lines(input.new_string), del: lines(input.old_string) };
  if (name === 'MultiEdit') return (input.edits ?? []).reduce((a: any, e: any) => ({ add: a.add + lines(e.new_string), del: a.del + lines(e.old_string) }), { add: 0, del: 0 });
  if (name === 'Write') return { add: lines(input.content), del: 0 };
  return undefined;
};

/** Content a proposed Edit/MultiEdit/Write would leave on disk (for "Ask before each edit"). */
function proposedContent(name: string, input: any): string | undefined {
  const cur = (() => { try { return fs.readFileSync(input.file_path, 'utf8'); } catch { return ''; } })();
  const edit = (s: string, e: any) => (e.replace_all ? s.split(e.old_string).join(e.new_string) : s.replace(e.old_string, () => e.new_string));
  if (name === 'Write') return input.content;
  if (name === 'Edit') return edit(cur, input);
  if (name === 'MultiEdit') return (input.edits ?? []).reduce(edit, cur);
}

function toolOutput(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return JSON.stringify(content);
}

/**
 * Remote-SSH mode (experimental): the project is on another machine. Claude, the CLI and credentials stay here; the
 * CLI runs in a local placeholder directory and reads the project only through the remote tools.
 * One remote target per window (a Remote-SSH constraint); per-conversation remote state lives in ConversationSession.
 */
interface RemoteContext {
  client: RemoteFilesystemClient;
  /** The remote workspace folder (a `vscode-remote` URI), if one is open. */
  folder: vscode.Uri | undefined;
  /** Local placeholder working directory for this remote workspace. */
  cwd: string;
  /** Reported by the remote host on first use. */
  host?: RemoteWorkspaceHost;
  /** Review backend for remote files (absent when no remote folder is open). */
  files?: RemoteReviewFiles;
}

/** Review state for remote mode: in memory only. Saved baselines hold paths of whichever machine wrote them. */
class MemoryMemento implements vscode.Memento {
  private values = new Map<string, unknown>();
  keys() { return [...this.values.keys()]; }
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T) { return (this.values.has(key) ? this.values.get(key) : defaultValue) as T; }
  async update(key: string, value: unknown) { this.values.set(key, value); }
}

/** One prompt to run in a conversation. */
interface SendArgs { prompt: string; images: Image[] }

/** conversationId → CLI session id, persisted (additive; transcripts are unchanged). */
const ID_INDEX_KEY = 'claudeIde.idIndex';
/** conversationIds with an operation in progress, persisted so a reload can show them as interrupted (§6). */
const RUNNING_KEY = 'claudeIde.runningConversations';
/** Most conversationId → CLI id pairs kept (the oldest are forgotten; those conversations fall back to their CLI id). */
const MAX_ID_INDEX = 1000;
/** Most prompts waiting for a free slot in a window. */
const MAX_QUEUED = 32;
/** Panel events after which the conversation list (activity, approvals) may have changed. */
const ACTIVITY_EVENTS = new Set(['busy', 'permission', 'question', 'answered', 'done', 'title']);

class ChatProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  /** Resident conversations, by conversationId. */
  private readonly sessions = new Map<string, ConversationSession>();
  /** The conversation shown in the panel. Presentation only: never used to decide which session an operation belongs to. */
  private activeSessionId: string;
  private readonly idIndex: Map<string, string>;
  /** Folder for new local conversations (multi-root windows). */
  private folder?: string;
  /** Seeds for new conversations only. */
  private defaultModel = cfg().get<string>('defaultModel')!;
  private defaultEffort = 'high';
  private defaultMode = cfg().get<Mode>('permissionMode')!;
  private readonly scheduler: Scheduler<SendArgs>;
  /** Callers waiting for an operation to be over (send() resolves then). */
  private readonly settled = new Map<string, (error?: unknown) => void>();
  authed = false;
  private historyTimer?: NodeJS.Timeout;
  private autoResumed = false;
  /**
   * Window-wide lock for mutating remote tools (files, commands, git) across conversations. Commands are owned and
   * isolated per conversation (API v4), but remote changes are captured for review by diffing workspace snapshots
   * around each call, which cannot tell two conversations' concurrent changes apart; serializing keeps attribution
   * and review correct. Read-only remote tools are not serialized.
   */
  private readonly remoteExclusive = createExclusive();

  constructor(private ctx: vscode.ExtensionContext, private store: ReviewStore, private ui: ReturnType<typeof registerReviewUi>, private remote?: RemoteContext) {
    this.idIndex = new Map(Object.entries(ctx.workspaceState.get<Record<string, string>>(ID_INDEX_KEY, {})));
    this.scheduler = new Scheduler<SendArgs>(Math.max(1, cfg().get<number>('maxConcurrentRunning', 4)),
      (s, opId, args) => this.runSend(s, opId, args), (s, opId, error) => this.onSettled(s, opId, error));
    this.activeSessionId = this.createSession().conversationId;
    store.onChange(() => this.postChanges());
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.join(claudeConfigDir(), 'projects')), '**/*.jsonl'));
    const refresh = () => { clearTimeout(this.historyTimer); this.historyTimer = setTimeout(() => this.sendHistory(), 500); };
    ctx.subscriptions.push(watcher, watcher.onDidCreate(refresh), watcher.onDidChange(refresh), watcher.onDidDelete(refresh));
  }

  /** The conversation shown in the panel (for presentation and for messages that name no conversation). */
  get active(): ConversationSession { return this.sessions.get(this.activeSessionId)!; }

  /** Working directory of the shown conversation: for panel actions (history, file pickers), never for a running operation. */
  private get cwd() { return this.active.workspace.cwd; }

  private newWorkspace(): SessionWorkspace {
    // Remote: never the remote path, which is not a directory on this machine.
    if (this.remote) return { cwd: this.remote.cwd, folderPath: this.remote.folder?.path, isRemote: true };
    const cwd = this.folder ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    return { cwd, folderPath: cwd, isRemote: false };
  }

  private createSession(conversationId?: string): ConversationSession {
    const s = new ConversationSession(this.newWorkspace(), this.defaultModel, this.defaultEffort, this.defaultMode, conversationId);
    // A new conversation starts with its own remote state (hashes, approvals, "Always allow", commands it owns).
    if (this.remote) s.remoteSession = newSessionState(this.remote.files ? { record: (changes, source) => this.recordRemoteChanges(s, changes, source) } : undefined, s.conversationId);
    this.bindCallbacks(s);
    this.sessions.set(s.conversationId, s);
    return s;
  }

  /** Drops conversations that are neither shown nor doing anything (they reload from their transcript when reopened). */
  private prune() {
    for (const [id, s] of this.sessions) if (id !== this.activeSessionId && !s.busy && !s.permissionWaiters.size) this.sessions.delete(id);
  }

  private rememberSdkId(s: ConversationSession) {
    if (!s.sdkSessionId || this.idIndex.get(s.conversationId) === s.sdkSessionId) return;
    this.idIndex.delete(s.conversationId);   // re-insert: Map order = most recently used last
    this.idIndex.set(s.conversationId, s.sdkSessionId);
    for (const id of this.idIndex.keys()) { if (this.idIndex.size <= MAX_ID_INDEX) break; if (!this.sessions.has(id)) this.idIndex.delete(id); }
    void this.ctx.workspaceState.update(ID_INDEX_KEY, Object.fromEntries(this.idIndex));
  }

  /** Remote host facts, asked once per window; fails clearly (no local fallback) if the remote extension does not answer. */
  private async remoteHost(): Promise<RemoteWorkspaceHost> {
    const r = this.remote!;
    if (!r.host) {
      const info = await r.client.getInfo();
      if (!info.workspaceRoot) throw new Error('No folder is open in this Remote-SSH window. Open a remote folder to use Claude.');
      r.host = { hostname: info.hostname, platform: info.platform, root: info.workspaceRoot, apiVersion: info.apiVersion, home: info.homeDirectory };
    }
    return r.host;
  }

  /** A fresh in-process MCP server for one query of this conversation; it reaches the remote host only through the command bridge. */
  async remoteToolsServer(s: ConversationSession) {
    const host = await this.remoteHost();
    return { host, server: createRemoteWorkspaceServer(await sdk(), this.remote!.client, host, s.remoteSession!, this.remoteExclusive) };
  }

  /** Where remote paths resolve (workspace root), where "~" is, and the remote platform: for the approval rules. */
  private remoteWhere() {
    const host = this.remote?.host;
    return { root: host?.root ?? '', home: host?.home, platform: host?.platform };
  }

  /** A file under review opens in the review (inline diff); any other remote path opens as a plain editor. */
  private openRemoteOrReview(p: string, diff: boolean) {
    const key = this.remote?.files?.keyOfArg(p);
    if (key !== undefined && this.store.has(key)) return diff ? this.ui.openDiff(key) : this.ui.open(key);
    return this.openRemote(p);
  }

  /** Opens a remote file (absolute anywhere on the host, or workspace-relative) in the editor, through VS Code's remote filesystem. */
  private async openRemote(p: string) {
    const folder = this.remote?.folder;
    const files = this.remote?.files;
    if (!folder || !files || !p) return;
    const host = await this.remoteHost();
    const target = toRemotePath(p, host.root, host.platform, host.home);
    if (!target.ok) return;
    const uri = vscode.Uri.parse(files.keyFor(target.path));
    if ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.File) await vscode.window.showTextDocument(uri);
  }

  /**
   * Records remote changes for review, as the PreToolUse snapshot does for local edits: the first pre-image per file
   * becomes the baseline, and the turn's checkpoint keeps it for "Restore to here".
   */
  private recordRemoteChanges(s: ConversationSession, changes: RemoteChange[], source: ChangeSource) {
    const files = this.remote?.files;
    if (!files) return;
    const keys = changes.map(c => {
      const key = files.keyFor(c.path);
      this.store.snapshot(key, s.turn, c.before, s.conversationId);
      files.recordClaudeChange(key, c.after, c.afterSha);
      this.store.recordWrite(key, s.conversationId, c.after);
      return key;
    });
    log.info(`remote ${source}: ${keys.length} file(s) recorded for review`);
    this.store.settle();
    // As locally: edits approved one by one ("Ask before each edit") are final; command changes stay for review.
    if (s.mode === 'askBeforeEach' && source !== 'command') for (const key of keys) this.store.accept(key, s.conversationId);
  }

  /** "Ask before each edit" for remote writes: opens current ↔ proposed diffs, as for local edits. */
  private async previewRemoteEdit(name: string, input: any) {
    const folder = this.remote?.folder;
    if (!folder) return;
    const host = await this.remoteHost();
    const files: { file_path: string; content?: string; edits?: any[] }[] = name === 'mcp__remote__write_file'
      ? [{ file_path: input.file_path, content: input.content }] : (input.files ?? []);
    const review = this.remote!.files;
    for (const f of files.slice(0, 10)) {
      const target = toRemotePath(f.file_path, host.root, host.platform, host.home);
      if (!target.ok || !review) continue;
      // Shown only to the person, in this editor, while they decide: a credential file's current text is read for it.
      const current = await this.remote!.client.readFile(target.path, { allowSensitive: true }).catch(() => undefined);
      const next = f.content ?? previewEdits(current ?? '', (f.edits ?? []).map((e: any) => ({ oldString: e.old_string, newString: e.new_string, replaceAll: e.replace_all })));
      if (next === null || next === undefined) continue;
      const file = vscode.Uri.parse(review.keyFor(target.path));
      const right = file.with({ scheme: PROPOSED_SCHEME, query: String(Date.now()) });
      proposed.set(right.fsPath, next);
      await vscode.commands.executeCommand('vscode.diff', current === undefined ? right.with({ query: 'empty' }) : file, right, `${path.posix.basename(target.path)} (proposed by Claude)`, { preview: true });
    }
  }

  /** Approval for a remote tool call of this conversation, by the remote policy table (also enforced in PreToolUse). */
  private async remoteToolPermission(s: ConversationSession, name: string, input: any, signal: AbortSignal): Promise<PermissionResult> {
    const host = this.remote!.host;
    const d = remoteToolDecision(name, input, s.mode, this.remoteWhere(), s.alwaysAllowed);
    if (d.decision === 'deny') return { behavior: 'deny', message: d.reason };
    const approve = (): PermissionResult => {
      // A privileged command runs only with this exact approved input (the tool checks and consumes it).
      if (name === 'mcp__remote__execute_command' && classifyCommand(String(input.command ?? ''), input.args).privileged) {
        s.remoteSession!.approvals.add(approvalKey(name, commandApprovalInput(input)));
      }
      // Likewise access to exactly these credential locations.
      if (d.credentials?.length) s.remoteSession!.approvals.add(credentialApprovalKey(name, d.credentials));
      return { behavior: 'allow', updatedInput: input };
    };
    if (d.decision === 'allow') return approve();
    if (s.mode === 'askBeforeEach' && (name === 'mcp__remote__write_file' || name === 'mcp__remote__apply_patch')) await this.previewRemoteEdit(name, input).catch(() => undefined);
    const onAbort = () => s.permissionWaiters.forEach(w => w('deny'));
    signal.addEventListener('abort', onAbort);
    try {
      const choices = d.canAlwaysAllow ? ['Allow once', 'Always allow', 'Deny'] : ['Allow', 'Deny'];
      const label = name.replace('mcp__remote__', '');
      const choice = await this.ask(s, `${label} on ${host?.hostname ?? 'the remote host'}`, `${shortInput(name, input, s.workspace.cwd)}\n\n${d.reason}`, choices,
        { kind: label === 'execute_command' ? 'bash' : 'tool' });
      if (choice === 'Always allow' && d.alwaysKey) s.alwaysAllowed.add(d.alwaysKey);
      return choice === 'Deny' || choice === 'deny' ? { behavior: 'deny', message: 'The user rejected this action.' } : approve();
    } finally { signal.removeEventListener('abort', onAbort); }
  }

  /**
   * Claude Code reports real paths (e.g. /private/tmp/x) while the editor may have opened the folder through a
   * symlink (/tmp/x). Map tool paths back into the workspace's form so the review UI matches open editors.
   */
  private toWorkspacePath(cwd: string, p: string) {
    const abs = normPath(path.resolve(cwd, p));
    let real: string;
    try { real = normPath(fs.realpathSync(cwd)); } catch { return abs; }
    return real !== cwd && (abs === real || abs.startsWith(real + path.sep)) ? cwd + abs.slice(real.length) : abs;
  }

  /**
   * Posts to the panel. An event about conversation `s` updates its presentation state and is forwarded (as a numbered
   * delta) only while `s` is the one shown; window-wide messages go straight to the panel.
   */
  private post(msg: any, s?: ConversationSession) {
    if (s && CONVERSATION_EVENTS.has(msg.type)) return this.emit(s, msg);
    void this.view?.webview.postMessage(msg);
  }

  private emit(s: ConversationSession, ev: PanelEvent) {
    const forward = applyEvent(s.presentation, ev);
    s.seq++;
    if (ACTIVITY_EVENTS.has(ev.type)) this.postActivity();
    if (s.conversationId !== this.activeSessionId || s.loading) return;
    void this.view?.webview.postMessage({ type: 'delta', conversationId: s.conversationId, seq: s.seq, event: forward });
  }

  /** The whole presentation of `s`: the panel replaces its view of that conversation with it. */
  private sendSnapshot(s: ConversationSession) {
    void this.view?.webview.postMessage({
      type: 'snapshot', conversationId: s.conversationId, seq: s.seq,
      state: { title: s.title, model: s.model, effort: s.effort, mode: s.mode, status: s.status, busy: s.presentation.busy, draft: s.presentation.draft, events: s.presentation.events },
    });
  }

  /** Conversations other than the shown one that are working, waiting for approval, or were cut off: badges in the panel. */
  private postActivity() {
    const conversations = [...this.sessions.values()]
      .filter(x => x.conversationId !== this.activeSessionId && (x.busy || x.permissionWaiters.size > 0 || x.status === 'interrupted' || x.status === 'failed'))
      .map(x => ({ conversationId: x.conversationId, title: x.title, status: x.status, pendingApprovals: x.permissionWaiters.size }));
    void this.view?.webview.postMessage({ type: 'activity', active: this.activeSessionId, conversations });
  }

  /** Shows a resident conversation. Presentation only: nothing is started, stopped or reset. */
  private switchTo(s: ConversationSession) {
    this.activeSessionId = s.conversationId;
    this.prune();
    this.sendSnapshot(s);
    this.postActivity();
  }

  private persistRunning() {
    void this.ctx.workspaceState.update(RUNNING_KEY, [...this.sessions.values()].filter(x => x.busy).map(x => x.conversationId));
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = Math.random().toString(36).slice(2);
    const uri = (f: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${view.webview.cspSource} data:;">
<link rel="stylesheet" href="${uri('main.css')}"></head><body><div id="app"></div>
<script nonce="${nonce}" src="${uri('main.js')}"></script></body></html>`;
    view.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => this.post({ type: 'error', text: String(e?.message ?? e) })));
  }

  /** The conversation a panel message is about: the one it names, else the shown one. */
  private target(m: any): ConversationSession {
    return (typeof m?.conversationId === 'string' && this.sessions.get(m.conversationId)) || this.active;
  }

  private async onMessage(m: any) {
    switch (m.type) {
      case 'ready': return this.init();
      case 'send': return this.send(this.target(m), m.text, m.attach, m.images, m.refs, m.selection !== false);
      case 'stop': return void this.stopSession(this.target(m));
      case 'setModel': { const s = this.target(m); s.model = this.defaultModel = m.value; return s.q?.setModel(m.value); }
      case 'setEffort': this.target(m).effort = this.defaultEffort = m.value; return;
      case 'setMode': {
        const s = this.target(m);
        s.mode = this.defaultMode = m.value;
        void cfg().update('permissionMode', m.value, vscode.ConfigurationTarget.Global);
        return s.q?.setPermissionMode(SDK_MODE[s.mode]);
      }
      case 'setFolder': if (this.remote) return; this.folder = m.value; this.newChat(); void this.loadCommands(); return this.sendHistory();
      case 'newChat': return this.newChat();
      case 'switchTo': { const s = this.sessions.get(m.conversationId); return s ? this.switchTo(s) : undefined; }
      case 'resync': return this.sendSnapshot(this.target(m));
      case 'draft': this.target(m).presentation.draft = String(m.text ?? ''); return;
      case 'history': return this.sendHistory();
      case 'openSession': return this.openSession(m.id);
      case 'pickFile': return this.pickFile(m.inline !== false);
      case 'permission': {
        // Prompt ids are unique across conversations: answer the one that asked, whichever is shown.
        const s = [...this.sessions.values()].find(x => x.permissionWaiters.has(m.id));
        s?.permissionWaiters.get(m.id)?.(m.choice);
        return;
      }
      case 'open': return this.remote ? this.openRemoteOrReview(m.path, false) : this.ui.open(m.path);
      case 'openDiff': return this.remote ? this.openRemoteOrReview(m.path, true) : this.ui.openDiff(m.path);
      case 'accept': return vscode.commands.executeCommand('claudeIde.acceptFile', m.path);
      case 'reject': return vscode.commands.executeCommand('claudeIde.rejectFile', m.path);
      case 'acceptAll': return vscode.commands.executeCommand('claudeIde.acceptAll');
      case 'rejectAll': return vscode.commands.executeCommand('claudeIde.rejectAll');
      case 'review': return vscode.commands.executeCommand('claudeIde.review');
      case 'restore': return this.restore(this.target(m), m.turns);
      case 'micStart': {
        const err = await startRecording();
        return this.post(err ? { type: 'mic', state: 'idle', error: err } : { type: 'mic', state: 'recording' });
      }
      case 'micStop': {
        this.post({ type: 'mic', state: 'transcribing' });
        try {
          const text = await stopRecording();
          this.post({ type: 'mic', state: 'idle' });
          return text ? this.post({ type: 'insert', text: text + ' ' }) : undefined;
        } catch (e: any) {
          return this.post({ type: 'mic', state: 'idle', error: String(e?.message ?? e) });
        }
      }
      case 'trust': return vscode.commands.executeCommand('workbench.trust.manage');
      case 'signIn': return this.signIn();
      case 'checkAuth': return this.checkAuth();
      case 'setApiKey': return vscode.commands.executeCommand('claudeIde.setApiKey');
      case 'dropFiles': return this.addFiles(m.uris);
      case 'openFileRef': {
        if (this.remote) return this.openRemote(m.path);
        const p = path.resolve(this.cwd, m.path);
        return fs.existsSync(p) ? this.ui.open(p) : undefined;
      }
    }
  }

  private async init() {
    const s = this.active;
    this.post({
      type: 'init', models: cfg().get<string[]>('models'), model: s.model, mode: s.mode, effort: s.effort,
      folders: this.remote
        ? (this.remote.folder ? [{ name: path.posix.basename(this.remote.folder.path), path: this.remote.folder.path }] : [])
        : (vscode.workspace.workspaceFolders ?? []).map(f => ({ name: f.name, path: f.uri.fsPath })),
      folder: this.remote ? this.remote.folder?.path : this.cwd, title: s.title,
    });
    this.sendSnapshot(s);   // also after the panel was recreated while conversations kept running
    this.postActivity();
    this.postChanges();
    this.postActiveFile();
    this.post({ type: 'trust', ok: vscode.workspace.isTrusted });
    void this.loadCommands();
    await this.checkAuth();
    // Pick up where you left off: open this folder's most recent conversation once per window.
    if (!this.active.sdkSessionId && !this.active.busy && !this.autoResumed && cfg().get('resumeLastConversation', true)) {
      this.autoResumed = true;
      const { listSessions } = await sdk();
      const latest = (await listSessions({ dir: this.cwd })).sort((a, b) => b.lastModified - a.lastModified)[0];
      if (latest) await this.openSession(latest.sessionId);
      await this.restoreRunning();
    }
  }

  /**
   * After a reload: conversations that were working when the window closed are loaded from their transcripts and,
   * unless their last turn finished, shown as interrupted. They cannot continue mid-turn (§6); a new prompt continues
   * from the last complete turn.
   */
  private async restoreRunning() {
    const ids = this.ctx.workspaceState.get<string[]>(RUNNING_KEY, []);
    void this.ctx.workspaceState.update(RUNNING_KEY, []);
    for (const id of ids) {
      const sdkId = this.idIndex.get(id);
      if (!sdkId || this.sessions.has(id) || [...this.sessions.values()].some(x => x.sdkSessionId === sdkId)) continue;
      const s = this.createSession(id);
      s.sdkSessionId = sdkId;
      await this.load(s).catch(e => log.warn(`could not restore conversation ${id}: ${e?.message ?? e}`));
    }
    this.postActivity();
  }

  trusted() { this.post({ type: 'trust', ok: true }); void this.loadCommands(); }

  private async agentEnv() {
    const nodeDir = nodeDirFor(findClaude());   // npm-installed cli.js: the node next to its shim
    const extra = [...(nodeDir ? [nodeDir] : []), ...(isWin ? [path.join(os.homedir(), '.local', 'bin')] : [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'])];
    const key = pathKey();
    const env: Record<string, string | undefined> = { ...process.env, [key]: [...extra, process.env[key]].filter(Boolean).join(path.delimiter) };
    if (cfg().get('authMode') === 'apiKey') env.ANTHROPIC_API_KEY = await this.ctx.secrets.get('claudeIde.apiKey');
    return env;
  }

  /** Slash commands (built-ins, custom commands, skills, plugins) for the "/" menu, fetched without sending a message. */
  private commandsCwd?: string;
  private async loadCommands() {
    if (this.commandsCwd === this.cwd || !vscode.workspace.isTrusted) return;
    const cwd = this.commandsCwd = this.cwd;
    const abort = new AbortController();
    try {
      const { query } = await sdk();
      const idle = (async function* () { await new Promise(r => abort.signal.addEventListener('abort', r)); })();
      const q = query({ prompt: idle as AsyncIterable<SDKUserMessage>, options: {
        cwd, abortController: abort, persistSession: false,
        ...(this.remote ? { settingSources: ['user'], strictMcpConfig: true } : { settingSources: ['user', 'project', 'local'] }),
        pathToClaudeCodeExecutable: findClaude()?.sdkPath, env: await this.agentEnv(),
      } });
      const cmds = await Promise.race([q.supportedCommands(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000))]);
      if (cwd === this.cwd) this.postCommands(cmds);
    } catch (e: any) {
      log.warn(`could not load slash commands: ${e?.message ?? e}`);
      if (cwd === this.commandsCwd) this.commandsCwd = undefined;
    } finally { abort.abort(); }
  }
  private postCommands(cmds: { name: string; description: string; argumentHint: string; aliases?: string[]; builtin?: boolean }[], s?: ConversationSession) {
    this.post({ type: 'commands', commands: cmds.map(c => ({ name: c.name, description: c.description, hint: c.argumentHint, aliases: c.aliases ?? [], builtin: !!c.builtin })) }, s);
  }

  private activeFileTimer?: ReturnType<typeof setTimeout>;
  /** Selection changes come in bursts while dragging: post the last one. */
  postActiveFileSoon() { clearTimeout(this.activeFileTimer); this.activeFileTimer = setTimeout(() => this.postActiveFile(), 120); }

  postActiveFile() {
    const ed = vscode.window.activeTextEditor;
    const c = ed && this.editorContext(ed, ed.document.uri.fsPath);
    // `lines`: the non-empty selection (1-based, inclusive) shown as a chip and sent with the next message.
    this.post({ type: 'activeFile', name: c?.name ?? '', lines: c && !ed!.selection.isEmpty ? selectionLines(ed!.selection) : null });
  }

  /**
   * The active editor as context for Claude, or undefined when it may not be used: in a local window a local file
   * (`@`-reference), in a Remote-SSH window a document of this remote host only (absolute remote path, as text).
   */
  private editorContext(ed: vscode.TextEditor, cwd: string): { ref: string; name: string } | undefined {
    const u = ed.document.uri;
    if (this.remote) {
      const remote = this.remoteEditorPath(u, true);
      return remote ? { ref: remote, name: path.posix.basename(remote) } : undefined;
    }
    return u.scheme === 'file' ? { ref: '@' + path.relative(cwd, u.fsPath), name: path.basename(u.fsPath) } : undefined;
  }

  /**
   * Remote mode: how Claude names a document of this Remote-SSH host (any path, same scheme and authority as the
   * workspace folder): relative inside the workspace, absolute elsewhere. Undefined for anything else (local files,
   * other hosts, untitled documents). Claude reads it with the remote tools, which apply their own path checks.
   */
  private remoteEditorPath(u: vscode.Uri, absolute = false): string | undefined {
    const files = this.remote?.files;
    if (files) {
      const key = files.keyOf(u);
      return key ? (absolute ? files.remotePath(key) : files.display(key)) : undefined;
    }
    // No workspace folder (a remote file opened on its own): this window's remote documents, by scheme and authority
    // (a window is connected to one remote), named by their absolute remote path.
    if (!this.remote || u.scheme !== 'vscode-remote' || !u.authority.startsWith(`${vscode.env.remoteName}+`) || !u.path || u.path === '/') return undefined;
    return /^\/[A-Za-z]:\//.test(u.path) ? u.path.slice(1) : u.path;
  }

  async checkAuth() {
    if (cfg().get('authMode') === 'apiKey') {
      const key = await this.ctx.secrets.get('claudeIde.apiKey');
      this.authed = !!key;
      return this.post({ type: 'auth', ok: !!key, detail: key ? 'API key' : 'No API key set' });
    }
    const cli = findClaude();
    if (!cli) return this.post({ type: 'auth', ok: false, detail: 'Claude Code not found. Install it (claude.ai/install or npm i -g @anthropic-ai/claude-code), or set claudeIde.claudePath.' });
    execFile(cli.command, [...cli.args, 'auth', 'status'], { timeout: 15000, env: await this.agentEnv() }, (err, stdout) => {
      let s: any = {};
      try { s = JSON.parse(stdout); } catch { /* older CLI: non-JSON output */ }
      const ok = s.loggedIn ?? !err;
      this.authed = ok;
      this.post({ type: 'auth', ok, detail: ok ? `Signed in (${s.authMethod ?? 'Claude Code'})` : 'Not signed in' });
    });
  }

  signIn() {
    // In a remote window an extension's terminal can open on the remote host; sign-in must happen on this machine.
    if (this.remote) {
      void vscode.window.showInformationMessage('Sign in from a local Claude IDE window, or run "claude" then "/login" in a terminal on this computer. Then use "Re-check sign-in".');
      return;
    }
    // Run claude itself as the terminal process: no shell quoting differences between zsh, PowerShell and cmd.
    const cli = findClaude();
    const t = vscode.window.createTerminal({ name: 'Claude sign-in', cwd: this.cwd, shellPath: cli?.command ?? (isWin ? 'claude.exe' : 'claude'), shellArgs: [...(cli?.args ?? []), '/login'] });
    t.show();
  }

  /** "Restore to here" in conversation `s`: undo Claude's file changes from that message on, drop those messages, and put the prompt back in the input. */
  private async restore(s: ConversationSession, turns: string[]) {
    const ok = await vscode.window.showWarningMessage('Restore to before this message?',
      { modal: true, detail: 'Files Claude changed from this message on go back to how they were, and this message and the ones after it are removed. Your message goes back into the input box.' }, 'Restore');
    if (ok !== 'Restore') return;
    this.stopSession(s);
    while (s.busy) await new Promise(r => setTimeout(r, 50));
    let result = await this.store.restoreTo(turns);
    if (result.conflicts.length) {
      // Remote files edited after Claude's change, or changed meanwhile: nothing of theirs was overwritten.
      const later = result.conflicts.some(c => c.laterEdits);
      const choice = await vscode.window.showWarningMessage('Some files were not restored', {
        modal: true, detail: result.conflicts.map(c => c.message).join('\n') + (later ? '\n\nRestoring them discards the edits made after Claude\'s change.' : ''),
      }, ...(later ? ['Restore Anyway'] : []));
      if (choice === 'Restore Anyway') result = await this.store.restoreTo(turns, { force: true });
      if (result.conflicts.length) return this.post({ type: 'note', text: `Restore stopped: ${result.conflicts.map((c: ReviewConflict) => c.message).join(' ')}` }, s);
    }
    const n = result.restored;
    if (s.sdkSessionId) {
      const { getSessionMessages } = await sdk();
      const msgs = await getSessionMessages(s.sdkSessionId, { dir: s.workspace.cwd });
      const i = msgs.findIndex(m => m.uuid === turns[0]);
      if (i === 0) { s.sdkSessionId = undefined; s.rewindTo = undefined; }   // first message: start over
      else if (i > 0) s.rewindTo = msgs[i - 1].uuid;
    }
    log.info(`restore ${turns[0]}: ${n} file(s), rewind to ${s.rewindTo ?? (s.sdkSessionId ? 'unchanged' : 'new chat')}`);
    this.post({ type: 'rewound', turn: turns[0], files: n }, s);
  }

  /** Shows a new, empty conversation. Other conversations keep running. */
  newChat() {
    const s = this.createSession();
    this.post({ type: 'reset', title: s.title }, s);
    this.switchTo(s);
  }

  private postChanges() {
    const files = this.remote?.files;
    const cwd = this.cwd;
    this.post({
      type: 'changes', files: this.store.pending().map(f => (files
        ? { ...f, name: path.posix.basename(files.display(f.path)), dir: path.posix.dirname(files.display(f.path)) }
        : { ...f, name: path.basename(f.path), dir: path.relative(cwd, path.dirname(f.path)) || '.' })),
    });
  }

  private async sendHistory() {
    if (!this.view) return;
    const { listSessions } = await sdk();
    const sessions = await listSessions({ dir: this.cwd });
    const current = this.active.sdkSessionId;
    const running = new Set([...this.sessions.values()].filter(x => x.busy).map(x => x.sdkSessionId));
    this.post({
      type: 'history', sessions: sessions.sort((a, b) => b.lastModified - a.lastModified).map(s => ({
        id: s.sessionId, title: (s.customTitle || s.summary || s.firstPrompt || '(untitled)').slice(0, 60), time: s.lastModified,
        size: s.fileSize, branch: s.gitBranch, current: s.sessionId === current, running: running.has(s.sessionId),
      })),
    });
  }

  /** Shows the conversation whose CLI session id is `sdkId` (from the history list). Other conversations keep running. */
  private async openSession(sdkId: string) {
    // Conversations from before conversationIds existed are known by their CLI id: it becomes their conversationId (§3).
    const conversationId = [...this.idIndex].find(([, v]) => v === sdkId)?.[0] ?? sdkId;
    const resident = this.sessions.get(conversationId) ?? [...this.sessions.values()].find(x => x.sdkSessionId === sdkId);
    if (resident) return this.switchTo(resident);   // its live state, including a run still in progress
    const s = this.createSession(conversationId);
    s.sdkSessionId = sdkId;
    this.rememberSdkId(s);
    this.activeSessionId = s.conversationId;
    await this.load(s);
    if (this.activeSessionId === s.conversationId) this.switchTo(s);   // unless another conversation was opened meanwhile
  }

  /** Builds the presentation of an idle conversation from its transcript (kept, not forwarded, until a snapshot). */
  private async load(s: ConversationSession) {
    s.loading = true;
    try {
      const { getSessionMessages, listSessions } = await sdk();
      const msgs = await getSessionMessages(s.sdkSessionId!, { dir: s.workspace.cwd });
      const info = (await listSessions({ dir: s.workspace.cwd })).find(x => x.sessionId === s.sdkSessionId);
      s.title = (info?.customTitle || info?.summary || info?.firstPrompt || 'Chat').slice(0, 60);
      this.post({ type: 'reset', title: s.title }, s);
      // Very long conversations (hundreds of MB) would freeze the panel; show the latest part. Claude still has the full history.
      const MAX = 300;
      if (msgs.length > MAX) this.post({ type: 'note', text: `Showing the latest ${MAX} of ${msgs.length} messages.` }, s);
      for (const m of msgs.slice(-MAX)) this.render(s, m as any, true);
      this.post({ type: 'done', replay: true }, s);
      if (!s.busy && !transcriptComplete(msgs as any)) {
        s.status = 'interrupted';
        this.post({ type: 'note', text: 'The last reply was interrupted. Send a message to continue from the last complete turn.' }, s);
      }
      this.post({ type: 'scrollBottom' }, s);
    } finally { s.loading = false; }
  }

  private async pickFile(inline = true) {
    const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,build,dist,out}/**', 5000);
    const items = files.map(f => vscode.workspace.asRelativePath(f, false)).sort();
    if (this.remote) {
      // Remote paths are text for Claude to read with the remote tools; "@" would make the local CLI look them up here.
      if (inline) {
        const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Reference a file' });
        if (pick) this.post({ type: 'insert', text: `${pick} ` });
      } else {
        for (const p of (await vscode.window.showQuickPick(items, { placeHolder: 'Attach files', canPickMany: true })) ?? []) {
          this.post({ type: 'addRef', ref: { path: p, name: path.posix.basename(p), isDir: false } });
        }
      }
      return;
    }
    if (inline) {
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Reference a file' });
      if (pick) this.post({ type: 'insert', text: `@${pick} ` });
      return;
    }
    const picks = await vscode.window.showQuickPick(items, { placeHolder: 'Attach files', canPickMany: true });
    if (picks?.length) this.addFiles(picks.map(p => vscode.Uri.file(path.resolve(this.cwd, p)).toString()));
  }

  /** Files/folders/images dropped on the panel or picked: images become image blocks, the rest context chips. */
  addFiles(uris: string[]) {
    log.info(`addFiles ${JSON.stringify(uris)}`);
    if (this.remote) return this.addRemoteFiles(uris);
    for (const u of uris) {
      const p = /^[a-z][\w+.-]+:/i.test(u) ? vscode.Uri.parse(u).fsPath : u;   // URI (not a C:\ path)
      if (!fs.existsSync(p)) continue;
      const isDir = fs.statSync(p).isDirectory();
      const mediaType = IMAGE_TYPES[path.extname(p).toLowerCase()];
      if (mediaType && fs.statSync(p).size <= 5 * 1024 * 1024) {
        this.post({ type: 'attachImage', image: { name: path.basename(p), mediaType, data: fs.readFileSync(p).toString('base64') } });
        continue;
      }
      const rel = path.relative(this.cwd, p);
      this.post({ type: 'addRef', ref: { path: (rel && !rel.startsWith('..') ? rel : p) + (isDir ? '/' : ''), name: path.basename(p), isDir } });
    }
    void vscode.commands.executeCommand('claudeIde.chat.focus');
  }

  /** Remote mode: files of this Remote-SSH host (any path) become references; nothing is read from either filesystem. */
  private addRemoteFiles(uris: string[]) {
    let skipped = 0;
    for (const u of uris) {
      const uri = /^[a-z][\w+.-]+:/i.test(u) ? vscode.Uri.parse(u) : undefined;
      const ref = uri && this.remoteEditorPath(uri);
      if (!ref) { skipped++; continue; }
      this.post({ type: 'addRef', ref: { path: ref, name: path.posix.basename(uri!.path), isDir: false } });
    }
    if (skipped) this.post({ type: 'note', text: `${skipped} item(s) not added: in a Remote-SSH window only files from this remote host can be attached.` });
    void vscode.commands.executeCommand('claudeIde.chat.focus');
  }

  /** Stops conversation `s` only: its query, its permission prompts, its remote foreground commands. */
  stopSession(s: ConversationSession) {
    const stopped = this.scheduler.stop(s, x => {
      const remote = this.remote, foreground = x.remoteSession?.foreground;
      if (remote && foreground) for (const id of foreground) void remote.client.execTerminate({ sessionId: id, graceMs: 2000, owner: x.remoteSession!.owner }).catch(() => undefined);
    });
    if (!stopped) return;
    for (const w of [...s.permissionWaiters.values()]) w('deny');
    for (const id of [...s.heldLocks]) this.releaseToolLock(s, id);
  }

  /** Local Bash: changes are recorded under the working folder only; say so when a command names paths elsewhere. */
  private noteUnreviewed(s: ConversationSession, command: unknown) {
    if (typeof command !== 'string') return;
    const platform = isWin ? 'win32' : 'linux';
    const root = s.workspace.cwd;
    const outside = pathsInCommand(command, undefined, os.homedir(), platform).filter(p => !isUnder(p, root, platform));
    if (outside.length) {
      this.post({ type: 'note', text: `This command names paths outside ${root} (${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ', …' : ''}): changes there are not recorded for review and cannot be undone with Restore.` }, s);
    }
  }

  private releaseToolLock(s: ConversationSession, toolUseId: string) {
    s.heldLocks.delete(toolUseId);
    this.store.pathLock.release(toolUseId);
  }

  /** Stops every conversation (window closing / extension deactivating). */
  dispose() {
    for (const s of this.sessions.values()) {
      this.stopSession(s);
      s.abort?.abort();
    }
  }

  private ask(s: ConversationSession, title: string, detail: string, choices: string[], extra: any = {}): Promise<string> {
    const id = Math.random().toString(36).slice(2);
    this.post({ type: 'permission', id, title, detail, choices, ...extra }, s);
    return this.waitForAnswer(s, id);
  }

  /** Waits for the answer to prompt `id` of conversation `s` (the panel's answer, or "deny" when stopped). */
  private waitForAnswer(s: ConversationSession, id: string): Promise<string> {
    if (s.status === 'running') s.status = 'waiting-for-permission';
    return new Promise(res => {
      s.permissionWaiters.set(id, choice => {
        if (!s.permissionWaiters.delete(id)) return;   // answered once
        if (s.status === 'waiting-for-permission' && !s.permissionWaiters.size) s.status = 'running';
        this.post({ type: 'answered', id, choice }, s);
        res(choice);
      });
      this.postActivity();
    });
  }

  /** The permission and hook callbacks of conversation `s`: they act on `s` only, whichever conversation is shown. */
  private bindCallbacks(s: ConversationSession) {
    s.canUseTool = async (name, input, options) => {
      const result = await decide(name, input, options);
      // A denied tool never runs, so its PostToolUse may never come: release what its PreToolUse took.
      if (result.behavior === 'deny' && options.toolUseID) this.releaseToolLock(s, options.toolUseID);
      return result;
    };
    const decide = async (name: string, input: any, { signal, suggestions }: { signal: AbortSignal; suggestions?: PermissionUpdate[] }): Promise<PermissionResult> => {
      if (this.remote && SUBAGENT_TOOLS.includes(name)) input = sanitizeAgentInput(input);   // also done in PreToolUse
      const allow: PermissionResult = { behavior: 'allow', updatedInput: input };
      const cwd = s.workspace.cwd;
      if (this.remote && !isToolAllowedInRemoteMode(name)) return { behavior: 'deny', message: `${name} is not available in a Remote-SSH workspace: it would act on this computer, not the remote project.` };
      if (this.remote && name.startsWith('mcp__remote__')) return this.remoteToolPermission(s, name, input, signal);
      if (name === 'AskUserQuestion') {
        // Multiple-choice questions from Claude: the panel shows options + "Other" and returns question → answer.
        const id = Math.random().toString(36).slice(2);
        this.post({ type: 'question', id, questions: input.questions }, s);
        const onAbort = () => s.permissionWaiters.get(id)?.('');
        signal.addEventListener('abort', onAbort);
        const reply = await this.waitForAnswer(s, id);
        signal.removeEventListener('abort', onAbort);
        if (!reply || reply === 'deny') return { behavior: 'deny', message: 'The user dismissed the questions without answering.' };
        return { behavior: 'allow', updatedInput: { ...input, answers: JSON.parse(reply) } };
      }
      if (s.mode === 'auto') return allow;
      let choice: string;
      const onAbort = () => s.permissionWaiters.forEach(w => w('deny'));
      signal.addEventListener('abort', onAbort);
      try {
        if (EDIT_TOOLS.has(name) && s.mode === 'plan') return { behavior: 'deny', message: 'Plan mode: nothing may be written yet. Present your plan with ExitPlanMode and wait for approval.' };
        if (EDIT_TOOLS.has(name) && s.mode !== 'askBeforeEach') return allow; // staged via baselines
        if (EDIT_TOOLS.has(name)) {
          const p = this.toWorkspacePath(cwd, input.file_path ?? input.notebook_path);
          const next = proposedContent(name, input);
          if (next !== undefined) {
            proposed.set(p, next);
            const left = fs.existsSync(p) ? vscode.Uri.file(p) : vscode.Uri.file(p).with({ scheme: PROPOSED_SCHEME, query: 'empty' });
            await vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(p).with({ scheme: PROPOSED_SCHEME, query: String(Date.now()) }), `${path.basename(p)} (proposed by Claude)`, { preview: true });
          }
          choice = await this.ask(s, `${name} ${path.relative(cwd, p)}`, 'Review the proposed change in the editor.', ['Accept', 'Reject'], { kind: 'edit', path: p });
          choice = choice === 'Accept' ? 'allow' : 'deny';
        } else if (name === 'ExitPlanMode') {
          choice = await this.ask(s, 'Plan ready', input.plan ?? '', ['Approve plan', 'Keep planning'], { kind: 'plan' });
          if (choice !== 'Approve plan') return { behavior: 'deny', message: 'The user wants to keep planning.' };
          s.mode = 'ask';
          this.post({ type: 'mode', value: 'ask' }, s);
          return { ...allow, updatedPermissions: [{ type: 'setMode', mode: SDK_MODE.ask, destination: 'session' }] };
        } else {
          choice = await this.ask(s, name, shortInput(name, input, cwd), ['Allow once', 'Always allow', 'Deny'], { kind: name === 'Bash' ? 'bash' : 'tool' });
          choice = choice === 'Always allow' ? 'always' : choice === 'Allow once' ? 'allow' : 'deny';
        }
      } finally { signal.removeEventListener('abort', onAbort); }
      if (choice === 'always') return { ...allow, updatedPermissions: suggestions };
      if (choice === 'allow') return allow;
      return { behavior: 'deny', message: 'The user rejected this action.' };
    };

    s.preToolUse = async input => {
      const i = input as PreToolUseHookInput, t: any = i.tool_input;
      log.info(`PreToolUse ${i.tool_name} mode=${s.mode} conversation=${s.conversationId}`);
      if (this.remote) {
        // Enforced here too: hooks run even for tools that permission rules would auto-allow.
        if (!isToolAllowedInRemoteMode(i.tool_name)) {
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${i.tool_name} is not available in a Remote-SSH workspace.` } };
        }
        // Sub-agents: always the cleaned input (foreground, session mode, no isolation). "ask" outside auto mode, so a
        // stored "Always allow" rule can never run the original input.
        if (SUBAGENT_TOOLS.includes(i.tool_name)) {
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: s.mode === 'auto' ? 'allow' : 'ask', permissionDecisionReason: 'Sub-agent with the remote tools only', updatedInput: sanitizeAgentInput(t) } };
        }
        if (!i.tool_name.startsWith('mcp__remote__')) return { continue: true };
        // The CLI always runs this hook; "allow" skips canUseTool, "ask" routes the call to it, "deny" blocks it.
        const d = remoteToolDecision(i.tool_name, t ?? {}, s.mode, this.remoteWhere(), s.alwaysAllowed);
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: d.reason } };
      }
      if (EDIT_TOOLS.has(i.tool_name)) {
        const f = t.file_path ?? t.notebook_path;
        const p = f && this.toWorkspacePath(s.workspace.cwd, f);
        // Claude's own state (plans, memory) is not user code; keep it out of the review stack.
        if (p && !p.startsWith(claudeHome())) {
          // Held until this tool has written (PostToolUse): another conversation's edit of `p` waits, and then
          // snapshots the file including this edit (§5). The tool cannot start before this hook returns.
          s.heldLocks.add(i.tool_use_id);
          await this.store.pathLock.acquire([p], i.tool_use_id, s.conversationId);
          if (!s.heldLocks.has(i.tool_use_id)) { this.store.pathLock.release(i.tool_use_id); return { continue: true }; }   // stopped meanwhile
          this.store.snapshot(p, s.turn, undefined, s.conversationId);
        }
      } else if (i.tool_name === 'Bash' && s.mode !== 'plan') {
        s.bashSnaps.set(i.tool_use_id, snapshotWorkspace(s.workspace.cwd));
      }
      return { continue: true };
    };

    s.postToolUse = async (input: any) => {
      if (this.remote) return { continue: true };   // nothing local was snapshotted
      try {
        const snap = s.bashSnaps.get(input.tool_use_id);
        if (snap) {
          s.bashSnaps.delete(input.tool_use_id);
          recordBashChanges(this.store, s.workspace.cwd, snap, s.turn, s.conversationId);
          this.noteUnreviewed(s, input.tool_input?.command);
        }
        if (EDIT_TOOLS.has(input.tool_name)) {
          const f = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
          const p = f && this.toWorkspacePath(s.workspace.cwd, f);
          if (p && this.store.has(p)) this.store.recordWrite(p, s.conversationId);
          // Edits approved one-by-one are final; keep only the checkpoint for "Restore to here".
          if (p && s.mode === 'askBeforeEach') this.store.accept(p, s.conversationId);
        }
        this.store.settle();
      } finally { this.releaseToolLock(s, input.tool_use_id); }
      return { continue: true };
    };

    s.permissionDenied = async (input: any) => {
      this.releaseToolLock(s, input.tool_use_id);
      return { continue: true };
    };
  }

  /** Accepts a prompt for conversation `s` and resolves when its operation is over (finished, failed or stopped). */
  /** `selection`: false when the person removed the selection chip; a non-empty selection is sent otherwise. */
  async send(s: ConversationSession, text: string, attach: boolean, images: Image[] = [], refs: string[] = [], selection = true) {
    log.info(`send ${JSON.stringify(text.slice(0, 80))} conversation=${s.conversationId}`);
    if (!vscode.workspace.isTrusted) return this.post({ type: 'trust', ok: false });
    if (s.busy) return this.post({ type: 'error', text: 'Claude is still working. Stop it first.' }, s);
    if (this.scheduler.queued >= MAX_QUEUED) return this.post({ type: 'error', text: `${MAX_QUEUED} prompts are already waiting. Stop a conversation or wait for one to finish.` }, s);
    if (cfg().get('blockUntilReviewed') && this.store.pending().length)
      return this.post({ type: 'error', text: 'Review pending changes before sending another prompt.' }, s);
    if (text.trim() === '/clear') return this.newChat();

    let prompt = text;
    const ed = vscode.window.activeTextEditor;
    // Local window: a local file as "@" reference. Remote-SSH window: an editor of this host only, by its absolute
    // remote path as text (no "@": the local CLI would look it up on this computer). The selection comes from the
    // open editor, so nothing is read from either filesystem here.
    const ctx = ed && this.editorContext(ed, s.workspace.cwd);
    const sel = ed?.selection;
    if (ctx && sel && !sel.isEmpty && (selection || attach)) {
      const [first, last] = selectionLines(sel);
      prompt += `\n\n(Selection in ${ctx.ref} lines ${first}-${last}:)\n\`\`\`\n${ed!.document.getText(sel)}\n\`\`\``;
    } else if (ctx && attach) {
      prompt += `\n\n(Current file: ${ctx.ref})`;
    }
    if (this.remote) log.info(`editor context: ${ed ? `${ed.document.uri.scheme}://${ed.document.uri.authority}${ed.document.uri.path} selection=${!ed.selection.isEmpty}` : 'no active editor'} → ${prompt === text ? 'not included' : 'included'}`);

    if (refs.length) prompt += `\n\n(Attached: ${refs.map(r => (this.remote ? r : '@' + r)).join(' ')})`;

    s.turn = randomUUID();
    if (!s.sdkSessionId) s.title = text.slice(0, 60);
    this.post({ type: 'user', text, turn: s.turn, title: s.title, images, refs }, s);

    this.post({ type: 'busy', value: true }, s);
    const opId = this.scheduler.requestSend(s, { prompt, images });
    if (s.status === 'queued') this.post({ type: 'note', text: `Queued: ${this.scheduler.running} other conversation(s) are running (limit ${this.scheduler.maxConcurrentRunning}). This one starts when one finishes.` }, s);
    this.persistRunning();
    this.postActivity();
    const error = await new Promise<unknown>(res => (s.busy && s.currentOperationId === opId ? this.settled.set(opId, res) : res(undefined)));
    if (error) throw error;   // failed before Claude started (e.g. the remote host did not answer)
  }

  private onSettled(s: ConversationSession, opId: string, error?: unknown) {
    const done = this.settled.get(opId);
    this.settled.delete(opId);
    this.post({ type: 'busy', value: false }, s);
    if (s.conversationId !== this.activeSessionId) this.prune();
    this.persistRunning();
    this.postActivity();
    done?.(error);
  }

  /** One operation of conversation `s` (run by the scheduler). Stop is checked at every step before the query exists. */
  private async runSend(s: ConversationSession, opId: string, { prompt, images }: SendArgs) {
    const checkpoint = () => { if (this.scheduler.cancelled(s, opId)) throw CANCELLED_BEFORE_START; };
    const env = await this.agentEnv();
    checkpoint();
    const options: Options = {
      cwd: s.workspace.cwd,
      model: s.model,
      effort: s.effort as Options['effort'],
      resume: s.sdkSessionId,
      resumeSessionAt: s.sdkSessionId ? s.rewindTo : undefined,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      permissionMode: SDK_MODE[s.mode],
      canUseTool: s.canUseTool,
      hooks: {
        PreToolUse: [{ hooks: [s.preToolUse] }], PostToolUse: [{ hooks: [s.postToolUse] }], PostToolUseFailure: [{ hooks: [s.postToolUse] }],
        PermissionDenied: [{ hooks: [s.permissionDenied] }],
      },
      includePartialMessages: true,
      pathToClaudeCodeExecutable: findClaude()?.sdkPath,
      env,
      stderr: d => log.warn('[claude]', d),
    };
    if (this.remote) {
      const { host, server } = await this.remoteToolsServer(s);
      // The remote project's CLAUDE.md files, read for this query (a trusted workspace only, as for local project settings).
      const project = vscode.workspace.isTrusted
        ? await loadProjectInstructions(this.remote.client, host, (f, e) => log.warn(`could not read ${f}: ${e instanceof Error ? e.message : e}`))
        : [];
      Object.assign(options, remoteQueryOptions(server, host, project));
      checkpoint();
    }
    const { query } = await sdk();
    checkpoint();
    const abort = s.abort = new AbortController();
    options.abortController = abort;
    const started = Date.now();
    try {
      s.rewindTo = undefined;
      const q = s.q = query({ prompt: userMessage(prompt, images, s.turn), options });
      if (this.scheduler.cancelled(s, opId)) { void q.interrupt().catch(() => undefined); abort.abort(); }
      if (s.status === 'starting') s.status = 'running';
      for await (const m of q) this.render(s, m);
    } catch (e: any) {
      const stopped = this.scheduler.cancelled(s, opId) || abort.signal.aborted;
      if (!stopped) s.lastError = String(e?.message ?? e);
      abort.abort();   // settles any permission prompt still open on an error path
      this.post({ type: 'done', error: stopped ? 'Stopped' : String(e?.message ?? e), durationMs: Date.now() - started }, s);
    } finally {
      for (const id of [...s.heldLocks]) this.releaseToolLock(s, id);   // whatever a tool that never finished still held
      this.store.settle();
    }
  }

  private render(s: ConversationSession, m: SDKMessage | any, replay = false) {
    const sub = m.parent_tool_use_id != null;
    const cwd = s.workspace.cwd;
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init' && !replay) {
          const isNew = s.sdkSessionId !== m.session_id;
          s.sdkSessionId = m.session_id;
          this.rememberSdkId(s);
          if (isNew) this.post({ type: 'title', text: s.title }, s);
          void s.q?.supportedCommands().then(c => this.postCommands(c, s)).catch(() => undefined);
        }
        if (m.subtype === 'commands_changed') this.postCommands(m.commands, s);
        if (m.subtype === 'local_command_output' && !replay) this.post({ type: 'assistantText', text: m.content }, s);
        // Leaving plan mode (plan approved) → continue in Ask mode so edits are staged for review.
        if (m.subtype === 'status' && m.permissionMode && m.permissionMode !== 'plan' && s.mode === 'plan' && !replay) {
          s.mode = 'ask';
          this.post({ type: 'mode', value: 'ask' }, s);
          void s.q?.setPermissionMode(SDK_MODE.ask).catch(() => undefined);
        }
        return;
      case 'stream_event': {
        const ev = m.event;
        if (!sub && ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') this.post({ type: 'textDelta', text: ev.delta.text }, s);
        return;
      }
      case 'assistant':
        for (const b of m.message?.content ?? []) {
          if (b.type === 'text' && !sub) this.post({ type: 'assistantText', text: b.text }, s);
          // Questions and plan approvals get their own cards; the raw tool line would just duplicate them.
          if (b.type === 'tool_use' && !['AskUserQuestion', 'ExitPlanMode'].includes(b.name)) this.post({
            type: 'tool', id: b.id, name: b.name, summary: shortInput(b.name, b.input, cwd), sub,
            path: b.input?.file_path && (this.remote ? b.input.file_path : this.toWorkspacePath(cwd, b.input.file_path)), stats: editStats(b.name, b.input),
          }, s);
        }
        return;
      case 'user': {
        const content = typeof m.message?.content === 'string' ? [{ type: 'text', text: m.message.content }] : m.message?.content ?? [];
        for (const b of content) if (b.type === 'tool_result') this.post({ type: 'toolResult', id: b.tool_use_id, output: toolOutput(b.content).slice(0, 20000), isError: !!b.is_error }, s);
        const text = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
        if (replay && !sub && text && !text.startsWith('<')) {
          const images = content.filter((b: any) => b.type === 'image' && b.source?.type === 'base64')
            .map((b: any) => ({ name: 'image', mediaType: b.source.media_type, data: b.source.data }));
          this.post({ type: 'user', turn: m.uuid, images, ...parsePrompt(text) }, s);
        }
        return;
      }
      case 'result':
        this.post({
          type: 'done', durationMs: m.duration_ms, cost: m.total_cost_usd,
          tokens: m.usage ? (m.usage.input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0) + (m.usage.output_tokens ?? 0) : undefined,
          error: m.subtype !== 'success' ? (m.errors?.join('\n') || m.subtype) : undefined,
        }, s);
        return;
    }
  }
}

/** The window's chat, for deactivate(). */
let chatProvider: ChatProvider | undefined;

export function activate(ctx: vscode.ExtensionContext) {
  revealPanelOnce(ctx);
  // Remote windows (SSH, WSL, containers, …): the agent runs on this machine and would act on local files, not the
  // remote project. Start nothing until remote support exists; the guard explains this in the panel.
  const mode = workspaceMode(vscode.env.remoteName, cfg().get<boolean>('experimental.remoteSsh', false));
  if (mode === 'guard') return registerRemoteGuard(ctx, vscode.env.remoteName!);
  const remote = mode === 'remoteSsh' ? createRemoteContext(ctx) : undefined;
  // Remote review state is kept under its own keys (remote URIs), never mixed with local paths.
  const store = !remote ? new ReviewStore(ctx.workspaceState)
    : remote.files ? new ReviewStore(ctx.workspaceState, remote.files, { baselines: 'claudeIde.remote.baselines', checkpoints: 'claudeIde.remote.checkpoints' })
      : new ReviewStore(new MemoryMemento());
  const ui = registerReviewUi(ctx, store);
  if (remote?.files) {
    const files = remote.files;
    void files.load(store.tracked()).then(() => store.refresh());   // pending reviews from before a reload
    store.onChange(() => files.forget(store.tracked()));
  }
  const chat = chatProvider = new ChatProvider(ctx, store, ui, remote);
  ctx.subscriptions.push(
    { dispose: () => chat.dispose() },
    vscode.window.registerWebviewViewProvider('claudeIde.chat', chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('claudeIde.newChat', () => chat.newChat()),
    vscode.commands.registerCommand('claudeIde.dropResources', (uris: string[]) => chat.addFiles(uris)),
    vscode.commands.registerCommand('claudeIde.signIn', () => chat.signIn()),
    vscode.commands.registerCommand('claudeIde.setApiKey', async () => {
      const key = await vscode.window.showInputBox({ prompt: 'Anthropic API key', password: true, ignoreFocusOut: true });
      if (key === undefined) return;
      await ctx.secrets.store('claudeIde.apiKey', key);
      await cfg().update('authMode', 'apiKey', vscode.ConfigurationTarget.Global);
      await chat.checkAuth();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => chat.postActiveFile()),
    vscode.window.onDidChangeTextEditorSelection(e => { if (e.textEditor === vscode.window.activeTextEditor) chat.postActiveFileSoon(); }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => chat.trusted()),
    vscode.window.onDidChangeWindowState(s => { if (s.focused && !chat.authed) void chat.checkAuth(); }),
  );
  return { chat, store }; // used by the integration test
}

/** Remote-SSH mode: the command-bridge client and this remote workspace's local placeholder directory. */
function createRemoteContext(ctx: vscode.ExtensionContext): RemoteContext {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const cwd = remotePlaceholderDir(ctx.globalStorageUri.fsPath, folder?.authority ?? vscode.env.remoteName ?? '', folder?.path ?? '');
  fs.mkdirSync(cwd, { recursive: true });
  const context: { client?: RemoteFilesystemClient; host?: RemoteWorkspaceHost } = {};
  const client = createRemoteFilesystemClient({
    getRemoteName: () => vscode.env.remoteName,
    executeCommand: (command, request) => vscode.commands.executeCommand<unknown>(command, request),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    // The remote host may have been reinstalled or upgraded meanwhile: ask for its facts again next time.
    onRemoteNotAvailable: () => { context.host = undefined; },
  });
  return Object.assign(context, { client, folder, cwd, files: folder ? new RemoteReviewFiles(client, folder, ctx.workspaceState) : undefined });
}

/** Show the Claude panel on the right the first time a workspace is opened; the layout is remembered after that. */
function revealPanelOnce(ctx: vscode.ExtensionContext) {
  if (ctx.workspaceState.get('claudeIde.revealed')) return;
  void ctx.workspaceState.update('claudeIde.revealed', true);
  void vscode.commands.executeCommand('workbench.view.extension.claudeIde');
}

/** Ends every conversation's query, permission prompts and remote foreground commands. */
export function deactivate() {
  chatProvider?.dispose();
  chatProvider = undefined;
}
