// Snapshots for change review: taken before a command or file operation, diffed after it, so the agent can show
// every file it created, changed or deleted under the snapshot's roots (API v5: any directories or files; default
// the workspace root). Changes elsewhere are not seen; the agent says so. Snapshots stay on this (remote) host; only
// the changed files' before/after text crosses the bridge. Symbolic links are never followed; build and dependency
// directories and credential locations are skipped.
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ApiResult, RemoteFsError, execute, getBaseDirectory, isSensitivePath, reported, resolvePath } from './core';
import { REVIEW_CONTENT_LIMIT, sha256 } from './files';

const SKIP = new Set(['.git', 'node_modules', '.dart_tool', 'build', 'dist', 'out', '.next', 'Pods', '.gradle', 'target', '.venv', '__pycache__']);
const MAX_FILES = 20000;
/** Files up to this size keep their content in a snapshot (as the local review does). */
const MAX_CONTENT_BYTES = 512 * 1024;
/** Total content one snapshot may hold; beyond it files are tracked by size and time only. */
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOTS = 8;
const SNAPSHOT_TTL_MS = 60 * 60_000;
const MAX_CHANGES = 500;
const MAX_ROOTS = 8;

interface Entry { size: number; mtimeMs: number; ino: number; content?: Buffer }
interface Snapshot { roots: string[]; entries: Map<string, Entry>; createdAt: number; truncated: boolean }

const snapshots = new Map<string, Snapshot>();
/** Content cache shared by snapshots: unchanged files are not read again. */
const cache = new Map<string, Entry>();

/** Files under the roots (a root may be a file, or missing), keyed by absolute path; MAX_FILES in all. */
async function walk(roots: string[]): Promise<{ entries: Map<string, Entry>; truncated: boolean }> {
    const entries = new Map<string, Entry>();
    let held = 0;
    let truncated = false;
    const addFile = async (absolute: string) => {
        if (entries.size >= MAX_FILES) {
            truncated = true;
            return;
        }
        const info = await fs.lstat(absolute).catch(() => undefined);
        if (!info?.isFile()) {
            return;
        }
        let entry = cache.get(absolute);
        if (!entry || entry.size !== info.size || entry.mtimeMs !== info.mtimeMs || entry.ino !== info.ino) {
            entry = { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino };
            if (info.size <= MAX_CONTENT_BYTES && held + info.size <= MAX_SNAPSHOT_BYTES) {
                entry.content = await fs.readFile(absolute).catch(() => undefined);
            }
            cache.set(absolute, entry);
        }
        if (entry.content) {
            held += entry.content.length;
        }
        entries.set(reported(absolute), entry);
    };
    for (const root of roots) {
        const info = await fs.lstat(root).catch(() => undefined);
        if (!info || isSensitivePath(root)) {
            continue;
        }
        if (!info.isDirectory()) {
            await addFile(root);
            continue;
        }
        const pending = [root];
        while (pending.length > 0 && !truncated) {
            const directory = pending.pop()!;
            const items = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
            for (const item of items) {
                const absolute = path.join(directory, item.name);
                if (item.isSymbolicLink() || isSensitivePath(absolute)) {
                    continue;
                }
                if (item.isDirectory()) {
                    if (!SKIP.has(item.name)) {
                        pending.push(absolute);
                    }
                    continue;
                }
                if (item.isFile()) {
                    await addFile(absolute);
                    if (truncated) {
                        break;
                    }
                }
            }
        }
    }
    return { entries, truncated };
}

/** Canonical roots, without any root inside another. */
async function snapshotRoots(input: unknown): Promise<string[]> {
    if (input === undefined) {
        return [await getBaseDirectory()];
    }
    if (!Array.isArray(input) || input.length === 0 || input.length > MAX_ROOTS || input.some(r => typeof r !== 'string')) {
        throw new RemoteFsError('INVALID_REQUEST', `roots must list 1 to ${MAX_ROOTS} paths.`);
    }
    const canonical = [...new Set(await Promise.all(input.map(async r => (await resolvePath(r, { mustExist: false, allowSensitive: true })).absolutePath)))];
    return canonical.filter(r => !canonical.some(o => o !== r && (r.startsWith(o.endsWith(path.sep) ? o : o + path.sep))));
}

function expire() {
    const now = Date.now();
    for (const [id, s] of snapshots) {
        if (now - s.createdAt > SNAPSHOT_TTL_MS) {
            snapshots.delete(id);
        }
    }
    while (snapshots.size >= MAX_SNAPSHOTS) {
        snapshots.delete(snapshots.keys().next().value!);
    }
}

export async function snapshotBegin(request?: { roots?: string[] }): Promise<ApiResult<unknown>> {
    return execute(async () => {
        expire();
        const roots = await snapshotRoots(request?.roots);
        const { entries, truncated } = await walk(roots);
        const snapshotId = randomUUID();
        snapshots.set(snapshotId, { roots, entries, createdAt: Date.now(), truncated });
        return { snapshotId, files: entries.size, truncated, roots: roots.map(reported) };
    });
}

const isText = (b: Buffer) => b.length <= REVIEW_CONTENT_LIMIT && !b.subarray(0, 8000).includes(0);

interface Change { path: string; status: 'A' | 'M' | 'D'; before: string | null; after: string | null; afterSha: string | null }
interface Skipped { path: string; status: 'A' | 'M' | 'D'; skipped: string }

export async function snapshotDiff(request: { snapshotId: string; keep?: boolean }): Promise<ApiResult<unknown>> {
    return execute(async () => {
        const snapshot = snapshots.get(String(request?.snapshotId));
        if (!snapshot) {
            throw new RemoteFsError('NOT_FOUND', 'Unknown or expired snapshot.');
        }
        if (request.keep !== true) {
            snapshots.delete(String(request.snapshotId));
        }
        const { entries: after, truncated } = await walk(snapshot.roots);
        const changes: Change[] = [];
        const skipped: Skipped[] = [];
        const add = (relative: string, status: Change['status'], before: Entry | undefined, now: Entry | undefined) => {
            if (changes.length + skipped.length >= MAX_CHANGES) {
                return false;
            }
            const beforeText = before === undefined ? null : before.content && isText(before.content) ? before.content.toString('utf8') : undefined;
            const afterText = now === undefined ? null : now.content && isText(now.content) ? now.content.toString('utf8') : undefined;
            if (beforeText === undefined || afterText === undefined) {
                skipped.push({ path: relative, status, skipped: 'binary or too large to review' });
            } else if (beforeText !== afterText) {
                changes.push({ path: relative, status, before: beforeText, after: afterText, afterSha: now?.content ? sha256(now.content) : null });
            }
            return true;
        };
        let complete = true;
        for (const [relative, now] of after) {
            const before = snapshot.entries.get(relative);
            if (!before) {
                complete = add(relative, 'A', undefined, now) && complete;
            } else if (before.size !== now.size || before.mtimeMs !== now.mtimeMs || before.ino !== now.ino) {
                complete = add(relative, 'M', before, now) && complete;
            }
        }
        for (const [relative, before] of snapshot.entries) {
            if (!after.has(relative)) {
                complete = add(relative, 'D', before, undefined) && complete;
            }
        }
        return { changes, skipped, truncated: truncated || snapshot.truncated || !complete, roots: snapshot.roots.map(reported) };
    });
}

export async function snapshotDiscard(request: { snapshotId: string }): Promise<ApiResult<unknown>> {
    return execute(async () => ({ discarded: snapshots.delete(String(request?.snapshotId)) }));
}
