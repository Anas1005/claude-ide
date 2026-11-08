// Shared path core: resolution, canonicalization, the checks applied to canonical paths, typed errors.
// API v5: any path on this host the OS user can reach (absolute, or relative to the workspace root). Symbolic links
// are canonicalized before any check; the OS user's own permissions are the boundary (EACCES → PERMISSION_DENIED).
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { realpathSync } from 'fs';
import * as os from 'os';
import * as path from 'path';


export interface FileRequest {
    /** Absolute path on this host, or relative to the workspace root (API v5). */
    path: string;
    /** The user approved access to a credential location for this call. */
    allowSensitive?: boolean;
}

export interface ReadFileRequest extends FileRequest {
    /** API v6: 'base64' returns the raw bytes (at most MAX_BASE64_READ_BYTES), e.g. for images. Default 'utf8'. */
    encoding?: 'utf8' | 'base64';
}

export interface WriteFileRequest extends FileRequest {
    content: string;
    createParents?: boolean;
    /** Refuse to replace an existing file. */
    mustNotExist?: boolean;
    /** sha256 of the version the caller last read; CONFLICT if the file differs now. */
    expectedSha256?: string;
    /** Also return the previous and new text (for change review), when small enough. */
    returnContent?: boolean;
}

export interface SearchFilesRequest {
    /** Part of a name (case-insensitive). Optional when `pattern` is given. */
    query?: string;
    /** API v6: glob over paths relative to the searched directory (**, *, ?, {a,b}); matches files only. */
    pattern?: string;
    path?: string;
    maxResults?: number;
    exclude?: string[];
    allowSensitive?: boolean;
}

export interface FileEntry {
    name: string;
    /** Absolute path. */
    path: string;
    type: 'file' | 'directory';
    /** A symbolic link, listed with the type of what it points to. */
    symlink?: boolean;
}

export interface FileMetadata {
    path: string;
    name: string;
    type: 'file' | 'directory' | 'symlink' | 'other';
    /** For a symbolic link: the canonical path it points to (null when broken). */
    target?: string | null;
    size: number;
    modifiedAt: string;
    createdAt: string;
}

export type ApiErrorCode =
    | 'INVALID_REQUEST'
    | 'NO_WORKSPACE'
    | 'PATH_OUTSIDE_WORKSPACE'   // no longer produced (API v5); kept for older clients
    | 'NOT_FOUND'
    | 'NOT_A_DIRECTORY'
    | 'NOT_A_FILE'
    | 'PERMISSION_DENIED'
    | 'IO_ERROR'
    // Added for the full toolset:
    | 'ALREADY_EXISTS'          // destination exists and overwriting was not requested
    | 'CONFLICT'                // file changed since it was read, or an edit did not match exactly once
    | 'LIMIT_EXCEEDED'          // a size, count or concurrency bound was hit
    | 'PROCESS_NOT_FOUND'       // no process with that session ID was started by this extension
    | 'PRIVILEGE_NOT_APPROVED'  // privileged command without the approval flag
    | 'SENSITIVE_PATH_NOT_APPROVED'  // credential location without the approval flag (API v5)
    | 'GIT_ERROR';              // git reported an error (message carries git's output)

export type ApiResult<T> =
    | { success: true; data: T }
    | {
        success: false;
        error: { code: ApiErrorCode; message: string };
    };

export class RemoteFsError extends Error {
    constructor(
        public readonly code: ApiErrorCode,
        message: string
    ) {
        super(message);
        this.name = 'RemoteFsError';
    }
}

/** A path resolved for one operation (API v5: any path on this host the OS user can reach). */
export interface ResolvedPath {
    /** Directory relative paths resolve against: the workspace root, or the home directory when no folder is open. */
    base: string;
    /** The path as requested, made absolute and normalized (no symlinks resolved). */
    lexicalPath: string;
    /** Canonical path: every symbolic link resolved (with followFinal false, all but the final component). */
    absolutePath: string;
}

/** Canonical workspace root, or undefined when no folder is open. */
export async function getWorkspaceRoot(): Promise<string | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return undefined;
    }
    const root = await fs.realpath(folder.uri.fsPath).catch(() => undefined);
    return root && (await fs.stat(root)).isDirectory() ? root : undefined;
}

let canonicalHome: string | undefined;
/** The OS user's home directory, canonical. */
export function homeDirectory(): string {
    if (canonicalHome === undefined) {
        try { canonicalHome = realpathSync(os.homedir()); } catch { canonicalHome = os.homedir(); }
    }
    return canonicalHome;
}

/** Where relative paths resolve: the workspace root, else the home directory (no folder needs to be open). */
export async function getBaseDirectory(): Promise<string> {
    return (await getWorkspaceRoot()) ?? homeDirectory();
}

/** A request path as an absolute, normalized path: absolute as given, relative against `base`, "~" as the home directory. */
export function lexicalPath(input: unknown, base: string): string {
    if (typeof input !== 'string' || input.includes('\0')) {
        throw new RemoteFsError('INVALID_REQUEST', 'path must be a valid string.');
    }
    const raw = input.trim() === '' ? '.' : input;
    if (raw === '~' || raw.startsWith('~/')) {
        return path.normalize(path.join(os.homedir(), raw.slice(1)));
    }
    return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(base, raw);
}

/** Resolves every symbolic link in the existing part of `absolute`; missing trailing components are kept as given. */
export async function canonicalize(absolute: string): Promise<string> {
    const rest: string[] = [];
    let current = absolute;
    for (; ;) {
        try {
            return path.join(await fs.realpath(current), ...rest.reverse());
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOTDIR') {
                throw new RemoteFsError('NOT_A_DIRECTORY', 'A path component is not a directory.');
            }
            if (code !== 'ENOENT') {
                mapFsError(error);
            }
            const parent = path.dirname(current);
            if (parent === current) {
                return absolute;
            }
            rest.push(path.basename(current));
            current = parent;
        }
    }
}

// Credential locations: reading or changing them needs the user's approval (allowSensitive, set by the agent after
// the person approved that call). Checked on both the requested and the canonical path, so a symbolic link neither
// hides one nor makes one.
const SENSITIVE_IN_HOME = ['.ssh', '.gnupg', '.aws', '.config/gcloud', '.kube', '.docker/config.json', '.netrc', '.git-credentials'];
const SENSITIVE_SYSTEM = ['/etc/shadow', '/etc/gshadow', '/etc/sudoers', '/etc/sudoers.d'];

export function isSensitivePath(absolute: string): boolean {
    const homes = [...new Set([os.homedir(), homeDirectory()])];
    const roots = [...SENSITIVE_SYSTEM, ...homes.flatMap(h => SENSITIVE_IN_HOME.map(s => path.join(h, s)))];
    return roots.some(r => absolute === r || absolute.startsWith(r + path.sep));
}

function assertNotSensitive(paths: string[], allowSensitive: boolean, requested: string, canonical: string) {
    if (!allowSensitive && paths.some(isSensitivePath)) {
        throw new RemoteFsError('SENSITIVE_PATH_NOT_APPROVED', requested === canonical
            ? `${canonical} is a credential location; accessing it needs the user's approval.`
            : `${requested} resolves to ${canonical}, a credential location; accessing it needs the user's approval. Use that path to ask for it.`);
    }
}

export interface ResolveOptions {
    /** Resolve a final symbolic link (read/write its target). false: act on the link itself (stat, delete, move). */
    followFinal?: boolean;
    /** NOT_FOUND unless the path exists. */
    mustExist?: boolean;
    /** The user approved access to a credential location for this call. */
    allowSensitive?: unknown;
}

/** Resolves a request path to its canonical form, then applies the checks (credential locations) to it. */
export async function resolvePath(input: unknown, options: ResolveOptions = {}): Promise<ResolvedPath> {
    const { followFinal = true, mustExist = true } = options;
    const base = await getBaseDirectory();
    const lexical = lexicalPath(input ?? '.', base);
    const parent = await canonicalize(path.dirname(lexical));
    const entry = lexical === path.dirname(lexical) ? lexical : path.join(parent, path.basename(lexical));
    let absolutePath = entry;
    try {
        if (followFinal) {
            absolutePath = await fs.realpath(entry);
        } else {
            await fs.lstat(entry);
        }
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOTDIR') {
            throw new RemoteFsError('NOT_A_DIRECTORY', 'A path component is not a directory.');
        }
        if (code !== 'ENOENT') {
            mapFsError(error);
        }
        if (mustExist) {
            throw new RemoteFsError('NOT_FOUND', `${lexical} does not exist.`);
        }
    }
    assertNotSensitive([lexical, entry, absolutePath], options.allowSensitive === true, lexical, absolutePath);
    return { base, lexicalPath: lexical, absolutePath };
}

/** Creates `absolute` and missing parents (canonical result); an existing non-directory is NOT_A_DIRECTORY. */
export async function ensureDirectory(absolute: string): Promise<string> {
    const target = await canonicalize(absolute);
    try {
        await fs.mkdir(target, { recursive: true });
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST' || code === 'ENOTDIR') {
            throw new RemoteFsError('NOT_A_DIRECTORY', 'A parent path component is not a directory.');
        }
        mapFsError(error);
    }
    const real = await fs.realpath(target);
    if (!(await fs.stat(real)).isDirectory()) {
        throw new RemoteFsError('NOT_A_DIRECTORY', 'A parent path component is not a directory.');
    }
    return real;
}

/** An existing directory (canonical path given). */
export async function existingDirectory(absolute: string): Promise<string> {
    let info;
    try {
        info = await fs.stat(absolute);
    } catch (error) {
        mapFsError(error);
    }
    if (!info.isDirectory()) {
        throw new RemoteFsError('NOT_A_DIRECTORY', 'A parent path component is not a directory.');
    }
    return absolute;
}

/**
 * Directories that are never deleted or moved away: the filesystem root, and the home directory and the workspace
 * root and everything containing them.
 */
export async function assertNotProtected(absolute: string, what: string): Promise<void> {
    const keep = [homeDirectory(), await getWorkspaceRoot()].filter((p): p is string => !!p);
    if (absolute === path.parse(absolute).root || keep.some(k => k === absolute || k.startsWith(absolute + path.sep))) {
        throw new RemoteFsError('INVALID_REQUEST', `${absolute} cannot be ${what}: it is the filesystem root, the home directory, the workspace root or contains one of them.`);
    }
}

export function mapFsError(error: unknown): never {
    const code = (error as NodeJS.ErrnoException)?.code;

    if (code === 'ENOENT') {
        throw new RemoteFsError('NOT_FOUND', 'Path does not exist.');
    }

    if (code === 'EACCES' || code === 'EPERM') {
        throw new RemoteFsError('PERMISSION_DENIED', 'Permission denied.');
    }

    throw error;
}

/** '/'-separated form of an absolute path, as reported to the agent. */
export const reported = (absolute: string) => absolute.split(path.sep).join('/');

export function toApiError(error: unknown): {
    code: ApiErrorCode;
    message: string;
} {
    if (error instanceof RemoteFsError) {
        return { code: error.code, message: error.message };
    }

    const code = (error as NodeJS.ErrnoException)?.code;

    if (code === 'ENOENT') {
        return { code: 'NOT_FOUND', message: 'Path does not exist.' };
    }

    if (code === 'EACCES' || code === 'EPERM') {
        return { code: 'PERMISSION_DENIED', message: 'Permission denied.' };
    }

    return {
        code: 'IO_ERROR',
        message: error instanceof Error ? error.message : String(error)
    };
}

export async function execute<T>(
    operation: () => Promise<T>
): Promise<ApiResult<T>> {
    try {
        return { success: true, data: await operation() };
    } catch (error) {
        return { success: false, error: toApiError(error) };
    }
}

