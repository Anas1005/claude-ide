// fileOperation: create_directory, delete_file, delete_directory, move, rename — anywhere the OS user may.
// Paths are canonicalized up to the final component (core.ts); a final symbolic link is acted on as a link, never
// followed: deleting or moving a link affects the link itself, not its target.
import * as fs from 'fs/promises';
import * as path from 'path';
import {
    ApiResult, RemoteFsError, assertNotProtected, canonicalize, ensureDirectory, execute, existingDirectory, reported, resolvePath
} from './core';

export const MAX_DELETE_ENTRIES = 50000;
const OPERATIONS = ['create_directory', 'delete_file', 'delete_directory', 'move', 'rename'] as const;
type Operation = typeof OPERATIONS[number];

interface FileOperationRequest {
    operation: Operation;
    path: string;
    destination?: string;
    recursive?: boolean;
    overwrite?: boolean;
    createParents?: boolean;
    allowSensitive?: boolean;
}

const exists = async (p: string) => fs.lstat(p).then(() => true, (e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') {
        return false;
    }
    throw e;
});

/** Counts entries under a directory without following symlinks; throws LIMIT_EXCEEDED past the bound. */
async function countEntries(directory: string): Promise<number> {
    let count = 0;
    const pending = [directory];
    while (pending.length > 0) {
        const current = pending.pop()!;
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
            if (++count > MAX_DELETE_ENTRIES) {
                throw new RemoteFsError('LIMIT_EXCEEDED', `More than ${MAX_DELETE_ENTRIES} entries; delete smaller parts.`);
            }
            if (entry.isDirectory() && !entry.isSymbolicLink()) {
                pending.push(path.join(current, entry.name));
            }
        }
    }
    return count;
}

async function move(request: FileOperationRequest, renameOnly: boolean) {
    const source = await resolvePath(request.path, { followFinal: false, allowSensitive: request.allowSensitive });
    await assertNotProtected(source.absolutePath, 'moved');

    if (typeof request.destination !== 'string' || request.destination === '') {
        throw new RemoteFsError('INVALID_REQUEST', 'destination is required.');
    }
    let destinationPath: string;
    if (renameOnly) {
        if (/[\\/]/.test(request.destination) || request.destination === '.' || request.destination === '..') {
            throw new RemoteFsError('INVALID_REQUEST', 'rename takes a new name, not a path; use move to change directories.');
        }
        destinationPath = path.join(path.dirname(source.absolutePath), request.destination);
    } else {
        destinationPath = (await resolvePath(request.destination, { followFinal: false, mustExist: false, allowSensitive: request.allowSensitive })).absolutePath;
    }
    await resolvePath(destinationPath, { followFinal: false, mustExist: false, allowSensitive: request.allowSensitive });   // the checks on the canonical destination

    const sourceInfo = await fs.lstat(source.absolutePath);
    if (sourceInfo.isDirectory() && (destinationPath === source.absolutePath || destinationPath.startsWith(source.absolutePath + path.sep))) {
        throw new RemoteFsError('INVALID_REQUEST', 'A directory cannot be moved into itself.');
    }

    const parent = request.createParents === true
        ? await ensureDirectory(path.dirname(destinationPath))
        : await existingDirectory(await canonicalize(path.dirname(destinationPath)));
    const destination = path.join(parent, path.basename(destinationPath));

    let replaced = false;
    if (await exists(destination)) {
        if (request.overwrite !== true) {
            throw new RemoteFsError('ALREADY_EXISTS', 'The destination exists; set overwrite to replace a file.');
        }
        const destinationInfo = await fs.lstat(destination);
        if (destinationInfo.isDirectory() || sourceInfo.isDirectory()) {
            throw new RemoteFsError('CONFLICT', 'Directories are never overwritten; move or delete the destination first.');
        }
        replaced = true;
    }

    // Files without overwrite: link + unlink cannot clobber a destination created concurrently (EEXIST).
    if (!replaced && !sourceInfo.isDirectory()) {
        try {
            await fs.link(source.absolutePath, destination);
            await fs.unlink(source.absolutePath);
            return { destination: reported(destination), replaced };
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EEXIST') {
                throw new RemoteFsError('ALREADY_EXISTS', 'The destination appeared while moving; nothing was changed.');
            }
            if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV' && code !== 'EMLINK') {
                throw error;
            }
            // Filesystem without hard links: fall through to rename after re-checking.
            if (await exists(destination)) {
                throw new RemoteFsError('ALREADY_EXISTS', 'The destination appeared while moving; nothing was changed.');
            }
        }
    }
    try {
        await fs.rename(source.absolutePath, destination);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
            throw new RemoteFsError('IO_ERROR', 'Source and destination are on different filesystems.');
        }
        throw error;
    }
    return { destination: reported(destination), replaced };
}

export async function fileOperation(request: FileOperationRequest): Promise<ApiResult<unknown>> {
    return execute(async () => {
        if (!OPERATIONS.includes(request?.operation)) {
            throw new RemoteFsError('INVALID_REQUEST', `operation must be one of: ${OPERATIONS.join(', ')}.`);
        }
        const operation = request.operation;
        const allowSensitive = request.allowSensitive;

        if (operation === 'create_directory') {
            const target = await resolvePath(request.path, { followFinal: true, mustExist: false, allowSensitive });
            const existed = await exists(target.absolutePath);
            const created = await ensureDirectory(target.absolutePath);
            return { operation, path: reported(created), created: !existed };
        }

        if (operation === 'delete_file') {
            const target = await resolvePath(request.path, { followFinal: false, allowSensitive });
            const info = await fs.lstat(target.absolutePath);
            if (info.isDirectory()) {
                throw new RemoteFsError('NOT_A_FILE', 'Path is a directory; use delete_directory.');
            }
            await fs.unlink(target.absolutePath);   // a symlink is removed itself; its target is untouched
            return { operation, path: reported(target.absolutePath), wasSymlink: info.isSymbolicLink() };
        }

        if (operation === 'delete_directory') {
            const target = await resolvePath(request.path, { followFinal: false, allowSensitive });
            const info = await fs.lstat(target.absolutePath);
            if (info.isSymbolicLink()) {
                throw new RemoteFsError('NOT_A_DIRECTORY', 'Path is a symbolic link; use delete_file to remove the link (its target is kept).');
            }
            if (!info.isDirectory()) {
                throw new RemoteFsError('NOT_A_DIRECTORY', 'Path is not a directory; use delete_file.');
            }
            await assertNotProtected(target.absolutePath, 'deleted');
            if (request.recursive !== true) {
                try {
                    await fs.rmdir(target.absolutePath);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY' || (error as NodeJS.ErrnoException).code === 'EEXIST') {
                        throw new RemoteFsError('CONFLICT', 'The directory is not empty; set recursive to delete its contents.');
                    }
                    throw error;
                }
                return { operation, path: reported(target.absolutePath), entriesDeleted: 0 };
            }
            const entries = await countEntries(target.absolutePath);
            await fs.rm(target.absolutePath, { recursive: true, force: false });   // rm unlinks symlinks, never follows them
            return { operation, path: reported(target.absolutePath), entriesDeleted: entries };
        }

        const source = (await resolvePath(request.path, { followFinal: false, allowSensitive })).absolutePath;
        const moved = await move(request, operation === 'rename');
        return { operation, path: reported(source), ...moved };
    });
}
