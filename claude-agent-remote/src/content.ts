// searchContent: grep-like search of file contents under any directory (pure Node, no external tools).
// Symbolic links inside the tree are not followed (as ripgrep); credential locations are skipped unless approved; binary and oversized files are skipped; results, files and time are bounded.
import * as fs from 'fs/promises';
import * as path from 'path';
import { ApiResult, RemoteFsError, execute, isSensitivePath, reported, resolvePath } from './core';

const DEFAULT_EXCLUDED_DIRECTORIES = ['.git', 'node_modules', 'dist', 'build'];
const MAX_RESULTS = 1000;
const MAX_FILES_SCANNED = 20000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINE_CHARS = 500;
const TIME_BUDGET_MS = 15000;

interface SearchContentRequest {
    pattern: string;
    regex?: boolean;
    caseSensitive?: boolean;
    path?: string;
    include?: string[];
    exclude?: string[];
    contextLines?: number;
    maxResults?: number;
    allowSensitive?: boolean;
}

interface ContentMatch { path: string; line: number; column: number; text: string; before: string[]; after: string[] }

/** Glob → RegExp over '/'-separated relative paths: **, *, ?, {a,b}. A glob without '/' matches the base name anywhere. */
export function globToRegExp(glob: string): RegExp {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*' && glob[i + 1] === '*') {
            i++;
            if (glob[i + 1] === '/') {
                i++;
                out += '(?:.*/)?';
            } else {
                out += '.*';
            }
        } else if (c === '*') {
            out += '[^/]*';
        } else if (c === '?') {
            out += '[^/]';
        } else if (c === '{') {
            const end = glob.indexOf('}', i);
            if (end === -1) {
                out += '\\{';
                continue;
            }
            out += '(?:' + glob.slice(i + 1, end).split(',').map(a => a.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('|') + ')';
            i = end;
        } else {
            out += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(glob.includes('/') ? `^${out}$` : `(?:^|/)${out}$`);
}

function stringList(value: unknown, name: string): string[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > 50 || value.some(v => typeof v !== 'string' || v.length > 200)) {
        throw new RemoteFsError('INVALID_REQUEST', `${name} must be an array of at most 50 glob strings.`);
    }
    return value as string[];
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), min), max) : fallback;
}

export async function searchContent(request: SearchContentRequest): Promise<ApiResult<unknown>> {
    return execute(async () => {
        if (typeof request?.pattern !== 'string' || request.pattern === '' || request.pattern.length > 1000) {
            throw new RemoteFsError('INVALID_REQUEST', 'pattern must be a non-empty string of at most 1000 characters.');
        }
        const flags = request.caseSensitive === false ? 'i' : '';
        let matcher: RegExp;
        try {
            matcher = new RegExp(request.regex === true ? request.pattern : request.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
        } catch (error) {
            throw new RemoteFsError('INVALID_REQUEST', `Invalid regular expression: ${(error as Error).message}`);
        }
        const include = stringList(request.include, 'include').map(globToRegExp);
        const exclude = stringList(request.exclude, 'exclude').map(globToRegExp);
        const context = boundedInteger(request.contextLines, 0, 0, 10);
        const maxResults = boundedInteger(request.maxResults, 100, 1, MAX_RESULTS);

        const start = await resolvePath(request.path ?? '.', { allowSensitive: request.allowSensitive });
        const allowSensitive = request.allowSensitive === true;
        if (!(await fs.stat(start.absolutePath)).isDirectory()) {
            throw new RemoteFsError('NOT_A_DIRECTORY', 'Search root is not a directory.');
        }

        const deadline = Date.now() + TIME_BUDGET_MS;
        const matches: ContentMatch[] = [];
        let filesScanned = 0;
        let filesSkipped = 0;
        let stopped: string | undefined;
        const pending = [start.absolutePath];

        walk: while (pending.length > 0) {
            const directory = pending.pop()!;
            const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
            for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
                const absolutePath = path.join(directory, entry.name);
                if (entry.isSymbolicLink() || (!allowSensitive && isSensitivePath(absolutePath))) {
                    continue;
                }
                // Globs match paths relative to the directory searched (as ripgrep); results are absolute.
                const relative = path.relative(start.absolutePath, absolutePath).split(path.sep).join('/');
                if (entry.isDirectory()) {
                    if (!DEFAULT_EXCLUDED_DIRECTORIES.includes(entry.name) && !exclude.some(r => r.test(relative))) {
                        pending.push(absolutePath);
                    }
                    continue;
                }
                if (!entry.isFile() || exclude.some(r => r.test(relative)) || (include.length > 0 && !include.some(r => r.test(relative)))) {
                    continue;
                }
                if (filesScanned >= MAX_FILES_SCANNED) {
                    stopped = `scanned the maximum of ${MAX_FILES_SCANNED} files`;
                    break walk;
                }
                if (Date.now() > deadline) {
                    stopped = `stopped after ${TIME_BUDGET_MS / 1000} s`;
                    break walk;
                }
                const info = await fs.lstat(absolutePath).catch(() => undefined);
                if (!info?.isFile() || info.size > MAX_FILE_BYTES) {
                    filesSkipped++;
                    continue;
                }
                const buffer = await fs.readFile(absolutePath).catch(() => undefined);
                if (!buffer || buffer.subarray(0, 8000).includes(0)) {   // binary
                    filesSkipped++;
                    continue;
                }
                filesScanned++;
                const lines = buffer.toString('utf8').split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].length > 10000) {
                        continue;   // minified or generated; also keeps a pathological regex bounded per line
                    }
                    const found = matcher.exec(lines[i]);
                    if (!found) {
                        continue;
                    }
                    const clip = (s: string) => (s.length > MAX_LINE_CHARS ? s.slice(0, MAX_LINE_CHARS) + '…' : s);
                    matches.push({
                        path: reported(absolutePath), line: i + 1, column: found.index + 1, text: clip(lines[i]),
                        before: lines.slice(Math.max(0, i - context), i).map(clip),
                        after: lines.slice(i + 1, i + 1 + context).map(clip)
                    });
                    if (matches.length >= maxResults) {
                        stopped = `reached ${maxResults} matches`;
                        break walk;
                    }
                }
            }
        }
        return { matches, filesScanned, filesSkipped, truncated: stopped !== undefined, ...(stopped ? { reason: stopped } : {}) };
    });
}
