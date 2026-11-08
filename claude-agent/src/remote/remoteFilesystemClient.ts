// Typed client for the remote workspace filesystem exposed by the `claude-agent-remote` workspace extension.
// Adapted from claude-agent-local/src/remote/remoteFilesystemClient.ts (same contract, typed errors and timeout).
// It does not import `vscode`: the caller passes the command bridge in, so the client has no dependency on another
// extension and its logic is testable without an editor.

/** Command IDs registered by the remote workspace extension. */
export const REMOTE_COMMANDS = {
  getInfo: 'claudeIde.remote.getInfo',
  readFile: 'claudeIde.remote.fs.readFile',
  writeFile: 'claudeIde.remote.fs.writeFile',
  listDirectory: 'claudeIde.remote.fs.listDirectory',
  stat: 'claudeIde.remote.fs.stat',
  searchFiles: 'claudeIde.remote.fs.searchFiles',
  searchContent: 'claudeIde.remote.fs.searchContent',
  applyPatch: 'claudeIde.remote.fs.applyPatch',
  fileOperation: 'claudeIde.remote.fs.fileOperation',
  execStart: 'claudeIde.remote.exec.start',
  execStatus: 'claudeIde.remote.exec.status',
  execTerminate: 'claudeIde.remote.exec.terminate',
  gitStatus: 'claudeIde.remote.git.status',
  gitDiff: 'claudeIde.remote.git.diff',
  gitLog: 'claudeIde.remote.git.log',
  gitOperation: 'claudeIde.remote.git.operation',
  snapshotBegin: 'claudeIde.remote.fs.snapshotBegin',
  snapshotDiff: 'claudeIde.remote.fs.snapshotDiff',
  snapshotDiscard: 'claudeIde.remote.fs.snapshotDiscard',
} as const;

/** Remote command API version with the full toolset (claude-agent-remote 0.2.0). */
export const REQUIRED_API_VERSION = 2;
/** Remote command API version with change-review support: returnContent and workspace snapshots (0.3.0). */
export const REVIEW_API_VERSION = 3;
/** Remote command API version with absolute paths anywhere on the host, snapshot roots and credential approvals (0.5.0). */
export const PATHS_API_VERSION = 5;
/** Remote command API version with base64 (image) reads and glob file search (0.6.0). */
export const MEDIA_API_VERSION = 6;

/** `vscode.env.remoteName` reported by Remote-SSH. */
export const SSH_REMOTE_NAME = 'ssh-remote';

export const DEFAULT_TIMEOUT_MS = 30_000;

/** Error codes produced by the remote extension (must match its contract). */
export type RemoteApiErrorCode =
  | 'INVALID_REQUEST' | 'NO_WORKSPACE' | 'PATH_OUTSIDE_WORKSPACE' | 'NOT_FOUND'
  | 'NOT_A_DIRECTORY' | 'NOT_A_FILE' | 'PERMISSION_DENIED' | 'IO_ERROR'
  | 'ALREADY_EXISTS' | 'CONFLICT' | 'LIMIT_EXCEEDED' | 'PROCESS_NOT_FOUND' | 'PRIVILEGE_NOT_APPROVED' | 'GIT_ERROR'
  | 'SENSITIVE_PATH_NOT_APPROVED';

/** Error codes produced locally by the client. */
export type ClientErrorCode = 'REMOTE_NOT_AVAILABLE' | 'REMOTE_COMMAND_FAILED' | 'REMOTE_TIMEOUT' | 'MALFORMED_RESPONSE';

export type RemoteFilesystemErrorCode = RemoteApiErrorCode | ClientErrorCode;

const REMOTE_API_ERROR_CODES: ReadonlySet<string> = new Set<RemoteApiErrorCode>([
  'INVALID_REQUEST', 'NO_WORKSPACE', 'PATH_OUTSIDE_WORKSPACE', 'NOT_FOUND',
  'NOT_A_DIRECTORY', 'NOT_A_FILE', 'PERMISSION_DENIED', 'IO_ERROR',
  'ALREADY_EXISTS', 'CONFLICT', 'LIMIT_EXCEEDED', 'PROCESS_NOT_FOUND', 'PRIVILEGE_NOT_APPROVED', 'GIT_ERROR',
  'SENSITIVE_PATH_NOT_APPROVED',
]);

export type RemoteOperation = keyof typeof REMOTE_COMMANDS;

/** Every failure of a remote call: remote failures keep their code and message, transport failures use a client code. */
export class RemoteFilesystemError extends Error {
  constructor(
    readonly code: RemoteFilesystemErrorCode,
    readonly operation: RemoteOperation,
    readonly detail: string,
    readonly remoteCode?: string,
  ) {
    super(`${operation}: ${code}: ${detail}`);
    this.name = 'RemoteFilesystemError';
  }
}

export interface DirectoryEntry { name: string; /** Absolute path (API v5; workspace-relative before). */ path: string; type: 'file' | 'directory'; symlink?: boolean }
export type SearchResult = DirectoryEntry;
export interface FileStat { path: string; name: string; type: 'file' | 'directory' | 'symlink' | 'other'; size: number; modifiedAt: string; createdAt: string }
export interface WriteOptions {
  createParents?: boolean;
  /** Refuse to replace an existing file (ALREADY_EXISTS). */
  mustNotExist?: boolean;
  /** sha256 of the version last read; CONFLICT if the file is different now. */
  expectedSha256?: string;
  /** Also return previous/new text for change review (API version 3). */
  returnContent?: boolean;
  /** The user approved access to a credential location for this call (API version 5). */
  allowSensitive?: boolean;
}
/** Read-type calls: the user approved access to a credential location (API version 5). */
export interface AccessOptions { allowSensitive?: boolean }
/** `path` and `bytesWritten` come from every remote version; the rest from API version 2. */
export interface WriteResult {
  path: string; bytesWritten: number;
  created?: boolean; previousBytes?: number; previousLines?: number; lines?: number; previousSha256?: string | null; sha256?: string;
  /** With returnContent: the text before (null = file was created) and after the write, unless reviewSkipped. */
  previousContent?: string | null; content?: string; reviewSkipped?: boolean;
}
/** A file a command or file operation created (A), changed (M) or deleted (D), from a workspace snapshot. */
export interface SnapshotChange { path: string; status: 'A' | 'M' | 'D'; before: string | null; after: string | null; afterSha: string | null }
export interface SnapshotDiff { changes: SnapshotChange[]; skipped: { path: string; status: string; skipped: string }[]; truncated: boolean; /** API v5: the directories (or files) compared. */ roots?: string[] }
export interface SearchOptions { path?: string; maxResults?: number; exclude?: string[]; allowSensitive?: boolean; /** Glob over paths relative to `path`, files only (API v6). */ pattern?: string }
export interface FileBytes { path: string; base64: string; size: number; sha256: string }
/** What the remote extension host reports about itself (`claudeIde.remote.getInfo`). */
export interface RemoteHostInfo { hostname: string; platform: string; arch: string; workspaceRoot: string | null; /** Absent before API version 2. */ apiVersion?: number; /** The remote user's home directory (API version 5). */ homeDirectory?: string }
export interface TextEdit { oldString: string; newString: string; replaceAll?: boolean }
export interface FilePatch { path: string; edits: TextEdit[]; expectedSha256?: string }
export type FileOperationName = 'create_directory' | 'delete_file' | 'delete_directory' | 'move' | 'rename';
export interface FileOperationRequest { operation: FileOperationName; path: string; destination?: string; recursive?: boolean; overwrite?: boolean; createParents?: boolean; allowSensitive?: boolean }
export interface SearchContentRequest { pattern: string; regex?: boolean; caseSensitive?: boolean; path?: string; include?: string[]; exclude?: string[]; contextLines?: number; maxResults?: number; allowSensitive?: boolean }
export interface ExecStartRequest {
  command: string; args?: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number; background?: boolean; allowPrivileged?: boolean;
  /** The conversation that starts it (API v4: only that owner can see or stop it). */
  owner?: string;
  /** This start request's own id (API v4). */
  correlationId?: string;
}
/** Requests about started commands; `owner` limits them to that conversation's commands (API v4). */
export interface ExecQuery { sessionId: string; owner?: string }
export interface StreamSlice { offset: number; nextOffset: number; totalBytes: number; droppedBytes: number; text: string }
export interface ExecSession {
  sessionId: string; command: string; cwd: string; background: boolean; state: 'running' | 'exited' | 'failed';
  exitCode: number | null; signal: string | null; timedOut: boolean; terminated: boolean; error?: string;
  startedAt: string; durationMs: number; stdout: StreamSlice; stderr: StreamSlice; wasRunning?: boolean;
}
export type GitOperationName = 'branch_list' | 'branch_create' | 'branch_switch' | 'stage' | 'unstage' | 'commit';
/** Results the agent passes through to Claude as JSON; validated as objects. */
export type RemoteRecord = Record<string, unknown>;

/**
 * Paths are absolute remote paths, or relative to the workspace root (API v5; results carry absolute paths). Every
 * method resolves with validated data or rejects with a {@link RemoteFilesystemError}.
 */
export interface RemoteFilesystemClient {
  getInfo(): Promise<RemoteHostInfo>;
  readFile(path: string, options?: AccessOptions): Promise<string>;
  /** Content plus its sha256 (API version 2; sha256 is '' from older remotes) and the canonical path read (API v5). */
  readFileDetails(path: string, options?: AccessOptions): Promise<{ content: string; sha256: string; path?: string }>;
  /** Raw bytes, base64-encoded, at most 5 MB (API v6). */
  readFileBytes(path: string, options?: AccessOptions): Promise<FileBytes>;
  writeFile(path: string, content: string, options?: WriteOptions): Promise<WriteResult>;
  listDirectory(path?: string, options?: AccessOptions): Promise<DirectoryEntry[]>;
  stat(path: string, options?: AccessOptions): Promise<FileStat>;
  searchFiles(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  searchContent(request: SearchContentRequest): Promise<RemoteRecord>;
  applyPatch(files: FilePatch[], options?: { returnContent?: boolean; allowSensitive?: boolean }): Promise<{ files: WriteResult[] }>;
  /** Snapshot of `roots` (API v5; the workspace root when omitted). */
  snapshotBegin(roots?: string[]): Promise<{ snapshotId: string; files: number; truncated: boolean; roots?: string[] }>;
  snapshotDiff(snapshotId: string): Promise<SnapshotDiff>;
  snapshotDiscard(snapshotId: string): Promise<RemoteRecord>;
  fileOperation(request: FileOperationRequest): Promise<RemoteRecord>;
  execStart(request: ExecStartRequest): Promise<ExecSession>;
  execStatus(request: ExecQuery & { stdoutOffset?: number; stderrOffset?: number; maxBytes?: number }): Promise<ExecSession>;
  execList(owner?: string): Promise<RemoteRecord>;
  execTerminate(request: ExecQuery & { force?: boolean; graceMs?: number }): Promise<ExecSession>;
  gitStatus(request: { repository?: string }): Promise<RemoteRecord>;
  gitDiff(request: { repository?: string; staged?: boolean; paths?: string[]; contextLines?: number; stat?: boolean; maxBytes?: number }): Promise<RemoteRecord>;
  gitLog(request: { repository?: string; maxCount?: number; paths?: string[]; ref?: string }): Promise<RemoteRecord>;
  gitOperation(request: { operation: GitOperationName; repository?: string; name?: string; startPoint?: string; paths?: string[]; message?: string; includeRemote?: boolean }): Promise<RemoteRecord>;
}

/** The command bridge, passed in by the extension (and replaced in tests). */
export interface RemoteFilesystemClientEnvironment {
  getRemoteName(): string | undefined;
  executeCommand(command: string, request?: object): PromiseLike<unknown>;
  timeoutMs: number;
  /** Called whenever the remote extension is found unavailable (so cached remote facts can be dropped). */
  onRemoteNotAvailable?(): void;
}

type Validator<T> = (value: unknown) => value is T;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isDirectoryEntry = (v: unknown): v is DirectoryEntry =>
  isRecord(v) && typeof v.name === 'string' && typeof v.path === 'string' && (v.type === 'file' || v.type === 'directory');
const isDirectoryEntryArray = (v: unknown): v is DirectoryEntry[] => Array.isArray(v) && v.every(isDirectoryEntry);
const isFileStat = (v: unknown): v is FileStat =>
  isRecord(v) && typeof v.path === 'string' && typeof v.name === 'string'
  && (v.type === 'file' || v.type === 'directory' || v.type === 'symlink' || v.type === 'other')
  && typeof v.size === 'number' && typeof v.modifiedAt === 'string' && typeof v.createdAt === 'string';
const isWriteResult = (v: unknown): v is WriteResult => isRecord(v) && typeof v.path === 'string' && typeof v.bytesWritten === 'number';
const isReadResult = (v: unknown): v is { path: string; content: string } => isRecord(v) && typeof v.path === 'string' && typeof v.content === 'string';
const isHostInfo = (v: unknown): v is RemoteHostInfo =>
  isRecord(v) && typeof v.hostname === 'string' && typeof v.platform === 'string' && typeof v.arch === 'string'
  && (typeof v.workspaceRoot === 'string' || v.workspaceRoot === null) && (v.apiVersion === undefined || typeof v.apiVersion === 'number');
const isStreamSlice = (v: unknown) => isRecord(v) && typeof v.text === 'string' && typeof v.nextOffset === 'number';
const isExecSession = (v: unknown): v is ExecSession =>
  isRecord(v) && typeof v.sessionId === 'string' && (v.state === 'running' || v.state === 'exited' || v.state === 'failed')
  && isStreamSlice(v.stdout) && isStreamSlice(v.stderr);
const isPatchResult = (v: unknown): v is { files: WriteResult[] } => isRecord(v) && Array.isArray(v.files) && v.files.every(isWriteResult);
const isSnapshot = (v: unknown): v is { snapshotId: string; files: number; truncated: boolean } => isRecord(v) && typeof v.snapshotId === 'string';
const isSnapshotChange = (v: unknown): v is SnapshotChange => isRecord(v) && typeof v.path === 'string' && (v.status === 'A' || v.status === 'M' || v.status === 'D')
  && (typeof v.before === 'string' || v.before === null) && (typeof v.after === 'string' || v.after === null);
const isSnapshotDiff = (v: unknown): v is SnapshotDiff => isRecord(v) && Array.isArray(v.changes) && v.changes.every(isSnapshotChange) && Array.isArray(v.skipped);

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** The approval flag, sent only when set (older remotes ignore unknown fields either way). */
const access = (options?: { allowSensitive?: boolean }) => (options?.allowSensitive === true ? { allowSensitive: true } : {});
/** VS Code rejects with "command 'x' not found" when nothing registered it (remote extension missing or not running). */
const isCommandNotFound = (e: unknown) => /command '[^']+' not found/i.test(describe(e));

class CommandBridgeClient implements RemoteFilesystemClient {
  constructor(private readonly env: RemoteFilesystemClientEnvironment) { }

  async getInfo() {
    const info = await this.execute('getInfo', undefined);
    if (!isHostInfo(info)) throw new RemoteFilesystemError('MALFORMED_RESPONSE', 'getInfo', 'The remote host information does not match the expected shape.');
    return info;
  }
  async readFile(path: string, options?: AccessOptions) { return (await this.invoke('readFile', { path, ...access(options) }, isReadResult)).content; }
  async readFileDetails(path: string, options?: AccessOptions) {
    const r: { content: string; sha256?: unknown; path: string } = await this.invoke('readFile', { path, ...access(options) }, isReadResult);
    return { content: r.content, sha256: typeof r.sha256 === 'string' ? r.sha256 : '', path: r.path };
  }
  async readFileBytes(path: string, options?: AccessOptions) {
    const r = await this.invoke('readFile', { path, encoding: 'base64', ...access(options) }, isReadResult) as { path: string; content: string; encoding?: unknown; size?: unknown; sha256?: unknown };
    if (r.encoding !== 'base64') throw new RemoteFilesystemError('MALFORMED_RESPONSE', 'readFile', 'The remote host returned text instead of bytes: it needs claude-agent-remote 0.6.0 (API version 6).');
    return { path: r.path, base64: r.content, size: typeof r.size === 'number' ? r.size : Buffer.byteLength(r.content, 'base64'), sha256: typeof r.sha256 === 'string' ? r.sha256 : '' };
  }
  writeFile(path: string, content: string, options?: WriteOptions) {
    return this.invoke('writeFile', { path, content, createParents: options?.createParents === true, mustNotExist: options?.mustNotExist, expectedSha256: options?.expectedSha256, returnContent: options?.returnContent, ...access(options) }, isWriteResult);
  }
  listDirectory(path = '.', options?: AccessOptions) { return this.invoke('listDirectory', { path, ...access(options) }, isDirectoryEntryArray); }
  stat(path: string, options?: AccessOptions) { return this.invoke('stat', { path, ...access(options) }, isFileStat); }
  searchFiles(query: string, options?: SearchOptions) {
    return this.invoke('searchFiles', { ...(query ? { query } : {}), ...(options?.pattern ? { pattern: options.pattern } : {}), path: options?.path, maxResults: options?.maxResults, exclude: options?.exclude, ...access(options) }, isDirectoryEntryArray);
  }
  searchContent(request: SearchContentRequest) { return this.invoke('searchContent', request, isRecord); }
  applyPatch(files: FilePatch[], options?: { returnContent?: boolean; allowSensitive?: boolean }) { return this.invoke('applyPatch', { files, returnContent: options?.returnContent, ...access(options) }, isPatchResult); }
  snapshotBegin(roots?: string[]) { return this.invoke('snapshotBegin', roots ? { roots } : {}, isSnapshot); }
  snapshotDiff(snapshotId: string) { return this.invoke('snapshotDiff', { snapshotId }, isSnapshotDiff); }
  snapshotDiscard(snapshotId: string) { return this.invoke('snapshotDiscard', { snapshotId }, isRecord); }
  fileOperation(request: FileOperationRequest) { return this.invoke('fileOperation', request, isRecord); }
  execStart(request: ExecStartRequest) { return this.invoke('execStart', request, isExecSession); }
  execStatus(request: ExecQuery & { stdoutOffset?: number; stderrOffset?: number; maxBytes?: number }) { return this.invoke('execStatus', request, isExecSession); }
  execList(owner?: string) { return this.invoke('execStatus', owner === undefined ? {} : { owner }, isRecord); }
  execTerminate(request: ExecQuery & { force?: boolean; graceMs?: number }) { return this.invoke('execTerminate', request, isExecSession); }
  gitStatus(request: { repository?: string }) { return this.invoke('gitStatus', request, isRecord); }
  gitDiff(request: Parameters<RemoteFilesystemClient['gitDiff']>[0]) { return this.invoke('gitDiff', request, isRecord); }
  gitLog(request: Parameters<RemoteFilesystemClient['gitLog']>[0]) { return this.invoke('gitLog', request, isRecord); }
  gitOperation(request: Parameters<RemoteFilesystemClient['gitOperation']>[0]) { return this.invoke('gitOperation', request, isRecord); }

  /** Runs one `ApiResult` command and converts every outcome into validated data or a {@link RemoteFilesystemError}. */
  private async invoke<T>(operation: Exclude<RemoteOperation, 'getInfo'>, request: object, isData: Validator<T>): Promise<T> {
    const response = await this.execute(operation, request);
    if (response === undefined || response === null) throw new RemoteFilesystemError('MALFORMED_RESPONSE', operation, 'The remote extension returned no result.');
    if (!isRecord(response) || typeof response.success !== 'boolean') throw new RemoteFilesystemError('MALFORMED_RESPONSE', operation, 'The remote response is not an ApiResult.');
    if (response.success === false) {
      const error = isRecord(response.error) ? response.error : undefined;
      const code = typeof error?.code === 'string' ? error.code : undefined;
      const message = typeof error?.message === 'string' ? error.message : 'The remote extension reported a failure without a message.';
      if (!code || !REMOTE_API_ERROR_CODES.has(code)) throw new RemoteFilesystemError('MALFORMED_RESPONSE', operation, `Unknown remote error code '${code ?? 'none'}': ${message}`, code);
      throw new RemoteFilesystemError(code as RemoteApiErrorCode, operation, message, code);
    }
    if (!isData(response.data)) throw new RemoteFilesystemError('MALFORMED_RESPONSE', operation, 'The remote response data does not match the expected shape.');
    return response.data;
  }

  /** Checks the window is Remote-SSH, then runs the command with a timeout; never falls back to anything local. */
  private async execute(operation: RemoteOperation, request: object | undefined): Promise<unknown> {
    try {
      return await this.executeOnce(operation, request);
    } catch (e) {
      if (e instanceof RemoteFilesystemError && e.code === 'REMOTE_NOT_AVAILABLE') this.env.onRemoteNotAvailable?.();
      throw e;
    }
  }

  private async executeOnce(operation: RemoteOperation, request: object | undefined): Promise<unknown> {
    const remoteName = this.env.getRemoteName();
    if (remoteName !== SSH_REMOTE_NAME) {
      throw new RemoteFilesystemError('REMOTE_NOT_AVAILABLE', operation, remoteName
        ? `Active remote is '${remoteName}', not a Remote-SSH workspace.`
        : 'No Remote-SSH workspace is active (local-only window).');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RemoteFilesystemError('REMOTE_TIMEOUT', operation,
        `No response from the remote extension within ${this.env.timeoutMs} ms.`)), this.env.timeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve(this.env.executeCommand(REMOTE_COMMANDS[operation], request)), timeout]);
    } catch (e) {
      if (e instanceof RemoteFilesystemError) throw e;
      if (isCommandNotFound(e)) throw new RemoteFilesystemError('REMOTE_NOT_AVAILABLE', operation, `The remote extension is not installed or not running (${describe(e)}).`);
      throw new RemoteFilesystemError('REMOTE_COMMAND_FAILED', operation, describe(e));
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createRemoteFilesystemClient(env: RemoteFilesystemClientEnvironment): RemoteFilesystemClient {
  return new CommandBridgeClient(env);
}
