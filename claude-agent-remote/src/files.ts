// Safe file reads and atomic writes shared by writeFile and applyPatch.
// Targets are canonical (core.ts): writing to a symbolic link writes the file it points to, as a shell would.
import * as fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { RemoteFsError, ensureDirectory, existingDirectory, reported, resolvePath } from './core';

/** Largest file read or written through the bridge. */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

export function sha256(data: Buffer | string): string {
    return createHash('sha256').update(data).digest('hex');
}

/** Reads a regular file without following a final symlink (O_NOFOLLOW), bounded by MAX_FILE_BYTES. */
export async function readRegularFile(absolutePath: string): Promise<Buffer> {
    const handle = await fs.open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
        const info = await handle.stat();
        if (!info.isFile()) {
            throw new RemoteFsError('NOT_A_FILE', 'Path is not a regular file.');
        }
        if (info.size > MAX_FILE_BYTES) {
            throw new RemoteFsError('LIMIT_EXCEEDED', `File is larger than ${MAX_FILE_BYTES} bytes.`);
        }
        return await handle.readFile();
    } finally {
        await handle.close();
    }
}

export interface WriteTarget {
    /** Canonical path of the file written (a final symbolic link is resolved to the file it points to). */
    path: string;
    parent: string;
    targetPath: string;
    /** The file as it is now, if it exists (always a regular file). */
    existing?: { mode: number; content: Buffer };
}

/** Resolves where a file write will land: the canonical target (symbolic links resolved), after the path checks. */
export async function resolveWriteTarget(inputPath: unknown, createParents: boolean, allowSensitive?: unknown): Promise<WriteTarget> {
    if (typeof inputPath !== 'string' || inputPath.trim() === '' || inputPath.trim() === '.') {
        throw new RemoteFsError('INVALID_REQUEST', 'A file path is required.');
    }
    const resolved = await resolvePath(inputPath, { followFinal: true, mustExist: false, allowSensitive });
    const parent = createParents
        ? await ensureDirectory(path.dirname(resolved.absolutePath))
        : await existingDirectory(path.dirname(resolved.absolutePath));
    const targetPath = path.join(parent, path.basename(resolved.absolutePath));
    let existing: WriteTarget['existing'];

    try {
        const info = await fs.lstat(targetPath);
        if (info.isSymbolicLink()) {
            throw new RemoteFsError('NOT_FOUND', `${targetPath} is a broken symbolic link.`);
        }
        if (!info.isFile()) {
            throw new RemoteFsError('NOT_A_FILE', 'Target is not a regular file.');
        }
        existing = { mode: info.mode & 0o777, content: await readRegularFile(targetPath) };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }

    return { path: reported(targetPath), parent, targetPath, existing };
}

/**
 * Writes via a temporary file in the same directory, then renames it into place (atomic on one filesystem).
 * rename() replaces a final symlink itself rather than following it. Ancestor directories could still be swapped
 * by another process between resolution and rename: an OS-level race ordinary file APIs cannot close.
 */
export async function atomicWrite(target: WriteTarget, content: Buffer): Promise<void> {
    if (content.length > MAX_FILE_BYTES) {
        throw new RemoteFsError('LIMIT_EXCEEDED', `Content is larger than ${MAX_FILE_BYTES} bytes.`);
    }
    const temporaryPath = path.join(target.parent, `.claude-agent-tmp-${randomUUID()}`);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;

    try {
        handle = await fs.open(temporaryPath, 'wx', target.existing?.mode ?? 0o666);
        await handle.writeFile(content);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.rename(temporaryPath, target.targetPath);
    } catch (error) {
        if (handle) {
            await handle.close().catch(() => undefined);
        }
        await fs.unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}

/** Fails with CONFLICT when the caller saw a different version of the file than the one on disk now. */
export function checkExpected(target: WriteTarget, expectedSha256: unknown): void {
    if (expectedSha256 === undefined || expectedSha256 === null) {
        return;
    }
    if (typeof expectedSha256 !== 'string') {
        throw new RemoteFsError('INVALID_REQUEST', 'expectedSha256 must be a string.');
    }
    const actual = target.existing ? sha256(target.existing.content) : 'absent';
    if (actual !== expectedSha256) {
        throw new RemoteFsError('CONFLICT', target.existing
            ? 'The file changed since it was last read. Read it again before writing.'
            : 'The file no longer exists.');
    }
}

/** Largest file whose before/after content is returned for review (larger changes are reported, not reviewed). */
export const REVIEW_CONTENT_LIMIT = 2 * 1024 * 1024;

/** Text content for change review, or undefined when the file is too large or not valid text. */
export function reviewText(content: Buffer | undefined): string | null | undefined {
    if (content === undefined) {
        return null;
    }
    if (content.length > REVIEW_CONTENT_LIMIT || content.subarray(0, 8000).includes(0)) {
        return undefined;
    }
    return content.toString('utf8');
}

/** Before/after text of a write, for review in the editor (only when the caller asks for it). */
export interface ReviewContents { reviewSkipped?: boolean; previousContent?: string | null; content?: string }

export function reviewContents(target: WriteTarget, content: Buffer): ReviewContents {
    const previousContent = reviewText(target.existing?.content);
    const newContent = reviewText(content);
    return previousContent === undefined || newContent === undefined || newContent === null
        ? { reviewSkipped: true }
        : { previousContent, content: newContent };
}

/** What a write changed, for the caller to report. */
export function describeWrite(target: WriteTarget, content: Buffer) {
    const lines = (b: Buffer) => (b.length === 0 ? 0 : b.toString('utf8').split('\n').length);
    return {
        path: target.path,
        bytesWritten: content.length,
        created: !target.existing,
        previousBytes: target.existing?.content.length ?? 0,
        previousLines: target.existing ? lines(target.existing.content) : 0,
        lines: lines(content),
        previousSha256: target.existing ? sha256(target.existing.content) : null,
        sha256: sha256(content)
    };
}
