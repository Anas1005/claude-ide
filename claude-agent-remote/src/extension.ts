
import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
    ApiResult, FileEntry, FileMetadata, FileRequest, ReadFileRequest, RemoteFsError, SearchFilesRequest, WriteFileRequest,
    execute, homeDirectory, isSensitivePath, reported, resolvePath
} from './core';
import { ReviewContents, atomicWrite, checkExpected, describeWrite, readRegularFile, resolveWriteTarget, reviewContents, sha256 } from './files';
import { globToRegExp, searchContent } from './content';
import { applyPatch } from './patch';
import { fileOperation } from './fileOps';
import { execStart, execStatus, execTerminate, terminateAll } from './exec';
import { gitDiff, gitLog, gitOperation, gitStatus } from './git';
import { snapshotBegin, snapshotDiff, snapshotDiscard } from './snapshot';

type WriteSummary = ReturnType<typeof describeWrite> & ReviewContents;

const COMMANDS = {
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
    snapshotDiscard: 'claudeIde.remote.fs.snapshotDiscard'
} as const;

/** Version of the command API; the local agent checks it before using commands added after the first release. */
export const API_VERSION = 6;   // 3: change review (returnContent, snapshots); 4: command ownership (owner, correlationId); 5: absolute paths anywhere on the host; 6: base64 reads, glob file search

/** Largest file returned by a base64 read (API v6). */
export const MAX_BASE64_READ_BYTES = 5 * 1024 * 1024;

async function readFile(
    request: ReadFileRequest
): Promise<ApiResult<{ path: string; content: string; sha256: string; encoding?: 'base64'; size?: number }>> {
    return execute(async () => {
        const encoding = request?.encoding ?? 'utf8';
        if (encoding !== 'utf8' && encoding !== 'base64') {
            throw new RemoteFsError('INVALID_REQUEST', "encoding must be 'utf8' or 'base64'.");
        }
        const resolved = await resolvePath(request?.path, { allowSensitive: request?.allowSensitive });
        if (encoding === 'base64') {
            const info = await fs.stat(resolved.absolutePath);
            if (info.isFile() && info.size > MAX_BASE64_READ_BYTES) {
                throw new RemoteFsError('LIMIT_EXCEEDED', `File is larger than ${MAX_BASE64_READ_BYTES} bytes.`);
            }
        }
        const content = await readRegularFile(resolved.absolutePath);   // canonical: a symbolic link was resolved first
        if (encoding === 'base64') {
            if (content.length > MAX_BASE64_READ_BYTES) {   // grew since the check
                throw new RemoteFsError('LIMIT_EXCEEDED', `File is larger than ${MAX_BASE64_READ_BYTES} bytes.`);
            }
            return { path: reported(resolved.absolutePath), content: content.toString('base64'), sha256: sha256(content), encoding: 'base64' as const, size: content.length };
        }

        return {
            path: reported(resolved.absolutePath),
            content: content.toString('utf8'),
            sha256: sha256(content)
        };
    });
}

async function writeFile(
    request: WriteFileRequest
): Promise<ApiResult<WriteSummary>> {
    return execute(async () => {
        if (typeof request?.content !== 'string') {
            throw new RemoteFsError(
                'INVALID_REQUEST',
                'content must be a string.'
            );
        }

        const target = await resolveWriteTarget(request.path, request.createParents === true, request.allowSensitive);

        if (request.mustNotExist === true && target.existing) {
            throw new RemoteFsError('ALREADY_EXISTS', 'The file already exists.');
        }
        checkExpected(target, request.expectedSha256);

        const content = Buffer.from(request.content, 'utf8');
        await atomicWrite(target, content);

        return { ...describeWrite(target, content), ...(request.returnContent === true ? reviewContents(target, content) : {}) };
    });
}

async function listDirectory(
    request: FileRequest
): Promise<ApiResult<FileEntry[]>> {
    return execute(async () => {
        const resolved = await resolvePath(request?.path ?? '.', { allowSensitive: request?.allowSensitive });
        const info = await fs.stat(resolved.absolutePath);

        if (!info.isDirectory()) {
            throw new RemoteFsError(
                'NOT_A_DIRECTORY',
                'Path is not a directory.'
            );
        }

        const entries = await fs.readdir(resolved.absolutePath, {
            withFileTypes: true
        });

        const results: FileEntry[] = [];

        for (const entry of entries) {
            const absolute = path.join(resolved.absolutePath, entry.name);
            let isDirectory = entry.isDirectory();
            let isFile = entry.isFile();
            if (entry.isSymbolicLink()) {
                // Listed with the type of what it points to; a broken link is left out.
                const target = await fs.stat(absolute).catch(() => undefined);
                isDirectory = !!target?.isDirectory();
                isFile = !!target?.isFile();
            }
            if (!isDirectory && !isFile) {
                continue;
            }

            results.push({
                name: entry.name,
                path: reported(absolute),
                type: isDirectory ? 'directory' : 'file',
                ...(entry.isSymbolicLink() ? { symlink: true } : {})
            });
        }

        return results;
    });
}

async function stat(
    request: FileRequest
): Promise<ApiResult<FileMetadata>> {
    return execute(async () => {
        const resolved = await resolvePath(request?.path, { followFinal: false, allowSensitive: request?.allowSensitive });
        const info = await fs.lstat(resolved.absolutePath);

        let type: FileMetadata['type'] = 'other';

        if (info.isSymbolicLink()) {
            type = 'symlink';
        } else if (info.isDirectory()) {
            type = 'directory';
        } else if (info.isFile()) {
            type = 'file';
        }

        const target = info.isSymbolicLink() ? await fs.realpath(resolved.absolutePath).catch(() => null) : undefined;
        return {
            path: reported(resolved.absolutePath),
            name: path.basename(resolved.absolutePath),
            type,
            ...(target !== undefined ? { target: target === null ? null : reported(target) } : {}),
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
            createdAt: info.birthtime.toISOString()
        };
    });
}

async function searchFiles(
    request: SearchFilesRequest
): Promise<ApiResult<FileEntry[]>> {
    return execute(async () => {
        const hasQuery = typeof request?.query === 'string' && request.query.trim() !== '';
        const hasPattern = typeof request?.pattern === 'string' && request.pattern.trim() !== '';
        if (request?.query !== undefined && typeof request.query !== 'string' || request?.pattern !== undefined && typeof request.pattern !== 'string') {
            throw new RemoteFsError('INVALID_REQUEST', 'query and pattern must be strings.');
        }
        if (!hasQuery && !hasPattern) {
            throw new RemoteFsError(
                'INVALID_REQUEST',
                'A non-empty search query or glob pattern is required.'
            );
        }
        const glob = hasPattern ? globToRegExp(request.pattern!.trim().replace(/^\.\//, '')) : undefined;

        if (
            request.exclude !== undefined &&
            (!Array.isArray(request.exclude) ||
                request.exclude.some(item => typeof item !== 'string'))
        ) {
            throw new RemoteFsError(
                'INVALID_REQUEST',
                'exclude must be an array of strings.'
            );
        }

        const start = await resolvePath(request.path ?? '.', { allowSensitive: request.allowSensitive });
        const allowSensitive = request.allowSensitive === true;
        const startInfo = await fs.stat(start.absolutePath);

        if (!startInfo.isDirectory()) {
            throw new RemoteFsError(
                'NOT_A_DIRECTORY',
                'Search root is not a directory.'
            );
        }

        const query = hasQuery ? request.query!.toLocaleLowerCase() : undefined;

        const requestedMax = Number.isFinite(request.maxResults)
            ? Math.floor(request.maxResults!)
            : 200;

        const maxResults = Math.min(Math.max(requestedMax, 1), 1000);

        const excluded = new Set([
            '.git',
            'node_modules',
            'dist',
            'build',
            ...(request.exclude ?? [])
        ]);

        const results: FileEntry[] = [];
        const pending = [start.absolutePath];

        while (pending.length > 0 && results.length < maxResults) {
            const directory = pending.pop()!;

            const entries = await fs.readdir(directory, {
                withFileTypes: true
            }).catch(() => []);

            for (const entry of entries) {
                if (results.length >= maxResults) {
                    break;
                }

                if (excluded.has(entry.name) || entry.isSymbolicLink()) {
                    continue;
                }

                if (!entry.isDirectory() && !entry.isFile()) {
                    continue;
                }

                const absolutePath = path.join(directory, entry.name);
                if (!allowSensitive && isSensitivePath(absolutePath)) {
                    continue;
                }

                if (entry.isDirectory()) {
                    pending.push(absolutePath);
                }

                const nameMatches = query === undefined || entry.name.toLocaleLowerCase().includes(query);
                const globMatches = !glob || (entry.isFile() && glob.test(path.relative(start.absolutePath, absolutePath).split(path.sep).join('/')));
                if (nameMatches && globMatches) {
                    results.push({
                        name: entry.name,
                        path: reported(absolutePath),
                        type: entry.isDirectory() ? 'directory' : 'file'
                    });
                }
            }
        }

        return results;
    });
}

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('Claude Agent Remote');
    context.subscriptions.push(output);

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.getInfo, () => {
            const info = {
                apiVersion: API_VERSION,
                hostname: os.hostname(),
                platform: process.platform,
                arch: process.arch,
                username: os.userInfo().username,
                workspaceRoot:
                    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
                // API v5: paths may be absolute anywhere on this host; relative ones resolve against the workspace root.
                homeDirectory: homeDirectory()
            };

            output.clear();
            output.appendLine('===== CLAUDE AGENT REMOTE =====');
            output.appendLine(JSON.stringify(info, null, 2));
            output.show(true);

            return info;
        }),

        vscode.commands.registerCommand(COMMANDS.readFile, readFile),
        vscode.commands.registerCommand(COMMANDS.writeFile, writeFile),
        vscode.commands.registerCommand(COMMANDS.listDirectory, listDirectory),
        vscode.commands.registerCommand(COMMANDS.stat, stat),
        vscode.commands.registerCommand(COMMANDS.searchFiles, searchFiles),
        vscode.commands.registerCommand(COMMANDS.searchContent, searchContent),
        vscode.commands.registerCommand(COMMANDS.applyPatch, applyPatch),
        vscode.commands.registerCommand(COMMANDS.fileOperation, fileOperation),
        vscode.commands.registerCommand(COMMANDS.execStart, execStart),
        vscode.commands.registerCommand(COMMANDS.execStatus, execStatus),
        vscode.commands.registerCommand(COMMANDS.execTerminate, execTerminate),
        vscode.commands.registerCommand(COMMANDS.gitStatus, gitStatus),
        vscode.commands.registerCommand(COMMANDS.gitDiff, gitDiff),
        vscode.commands.registerCommand(COMMANDS.gitLog, gitLog),
        vscode.commands.registerCommand(COMMANDS.gitOperation, gitOperation),
        vscode.commands.registerCommand(COMMANDS.snapshotBegin, snapshotBegin),
        vscode.commands.registerCommand(COMMANDS.snapshotDiff, snapshotDiff),
        vscode.commands.registerCommand(COMMANDS.snapshotDiscard, snapshotDiscard)
    );
}

export function deactivate(): void {
    terminateAll();
}
