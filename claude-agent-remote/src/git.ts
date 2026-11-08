// Git for the agent: fixed argument lists run with execFile (never a shell), in any repository directory, with
// validated literal pathspecs. No force, amend, reset, clean, hook skipping or branch deletion is exposed.
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ApiResult, RemoteFsError, canonicalize, execute, lexicalPath, reported, resolvePath } from './core';
import { childEnvironment } from './exec';

const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 120_000;   // commit hooks may run builds or linters
const MAX_BUFFER = 32 * 1024 * 1024;
const DEFAULT_DIFF_BYTES = 200 * 1024;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_STATUS_ENTRIES = 2000;
const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/@{}~^+-]{1,255}$/;

interface Repo { base: string; directory: string }

/** The git working directory: any directory (canonical; default the workspace root). */
async function repository(input: unknown): Promise<Repo> {
    const resolved = await resolvePath(input ?? '.', { allowSensitive: true });
    if (!(await fs.stat(resolved.absolutePath)).isDirectory()) {
        throw new RemoteFsError('NOT_A_DIRECTORY', 'repository must be a directory.');
    }
    return { base: resolved.base, directory: resolved.absolutePath };
}

/** Paths (absolute, or relative to the workspace root) → canonical pathspecs relative to the git directory. */
async function pathspecs(repo: Repo, paths: unknown, required: boolean): Promise<string[]> {
    if (paths === undefined && !required) {
        return [];
    }
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 500 || paths.some(p => typeof p !== 'string')) {
        throw new RemoteFsError('INVALID_REQUEST', required ? 'paths must list 1 to 500 workspace paths.' : 'paths must be an array of workspace paths.');
    }
    return Promise.all(paths.map(async p => {
        const absolute = await canonicalize(lexicalPath(p, repo.base));
        const relative = path.relative(repo.directory, absolute);
        return relative === '' ? '.' : relative.split(path.sep).join('/');   // git itself refuses paths outside the repository
    }));
}

function git(repo: Repo, args: string[], timeout = READ_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
    const env = { ...childEnvironment({}), GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_EDITOR: 'true' };
    return new Promise((resolve, reject) => {
        execFile('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '--no-pager', ...args],
            { cwd: repo.directory, env, timeout, maxBuffer: MAX_BUFFER, windowsHide: true },
            (error, stdout, stderr) => {
                if (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    const detail = code === 'ENOENT' ? 'git is not installed on the remote host.'
                        : (error as { killed?: boolean }).killed ? `git did not finish within ${timeout / 1000} s.`
                            : (stderr || stdout || error.message).trim().slice(0, 4000);
                    reject(new RemoteFsError('GIT_ERROR', detail));
                } else {
                    resolve({ stdout, stderr });
                }
            });
    });
}

function ref(value: unknown, name: string): string {
    if (typeof value !== 'string' || !REF.test(value)) {
        throw new RemoteFsError('INVALID_REQUEST', `${name} is not a valid git reference name.`);
    }
    return value;
}

const clip = (text: string, maxBytes: number) => {
    const bytes = Buffer.byteLength(text);
    return bytes <= maxBytes
        ? { text, truncated: false, totalBytes: bytes }
        : { text: Buffer.from(text).subarray(0, maxBytes).toString('utf8'), truncated: true, totalBytes: bytes };
};

async function repositoryRoot(repo: Repo) {
    const top = (await git(repo, ['rev-parse', '--show-toplevel'])).stdout.trim();
    return reported(path.resolve(top));
}

export async function gitStatus(request: { repository?: string }): Promise<ApiResult<unknown>> {
    return execute(async () => {
        const repo = await repository(request?.repository);
        const { stdout } = await git(repo, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']);
        const result = {
            repositoryRoot: await repositoryRoot(repo),
            branch: null as string | null, commit: null as string | null, upstream: null as string | null, ahead: 0, behind: 0,
            staged: [] as { path: string; status: string; from?: string }[],
            unstaged: [] as { path: string; status: string }[],
            untracked: [] as string[],
            conflicted: [] as string[],
            truncated: false
        };
        const records = stdout.split('\0');
        let entries = 0;
        for (let i = 0; i < records.length; i++) {
            const r = records[i];
            if (r.startsWith('# branch.head ')) { result.branch = r.slice(14) === '(detached)' ? null : r.slice(14); continue; }
            if (r.startsWith('# branch.oid ')) { result.commit = r.slice(13) === '(initial)' ? null : r.slice(13); continue; }
            if (r.startsWith('# branch.upstream ')) { result.upstream = r.slice(18); continue; }
            if (r.startsWith('# branch.ab ')) { const [a, b] = r.slice(12).split(' '); result.ahead = Number(a); result.behind = -Number(b); continue; }
            if (!r || r.startsWith('#')) { continue; }
            if (++entries > MAX_STATUS_ENTRIES) { result.truncated = true; break; }
            const kind = r[0];
            if (kind === '?') { result.untracked.push(r.slice(2)); continue; }
            if (kind === 'u') { result.conflicted.push(r.split(' ').slice(10).join(' ')); continue; }
            if (kind === '1' || kind === '2') {
                const fields = r.split(' ');
                const xy = fields[1];
                const file = fields.slice(kind === '1' ? 8 : 9).join(' ');
                const from = kind === '2' ? records[++i] : undefined;
                if (xy[0] !== '.') { result.staged.push({ path: file, status: xy[0], ...(from ? { from } : {}) }); }
                if (xy[1] !== '.') { result.unstaged.push({ path: file, status: xy[1] }); }
            }
        }
        return { ...result, clean: !result.staged.length && !result.unstaged.length && !result.untracked.length && !result.conflicted.length };
    });
}

export async function gitDiff(request: { repository?: string; staged?: boolean; paths?: string[]; contextLines?: number; stat?: boolean; maxBytes?: number }): Promise<ApiResult<unknown>> {
    return execute(async () => {
        const repo = await repository(request?.repository);
        const context = typeof request.contextLines === 'number' ? Math.min(Math.max(Math.floor(request.contextLines), 0), 20) : 3;
        const maxBytes = typeof request.maxBytes === 'number' ? Math.min(Math.max(Math.floor(request.maxBytes), 1024), MAX_DIFF_BYTES) : DEFAULT_DIFF_BYTES;
        const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', `-U${context}`];
        if (request.staged === true) { args.push('--cached'); }
        if (request.stat === true) { args.push('--stat'); }
        const { stdout } = await git(repo, [...args, '--', ...(await pathspecs(repo, request.paths, false))]);
        return { staged: request.staged === true, ...clip(stdout, maxBytes) };
    });
}

export async function gitLog(request: { repository?: string; maxCount?: number; paths?: string[]; ref?: string }): Promise<ApiResult<unknown>> {
    return execute(async () => {
        const repo = await repository(request?.repository);
        const maxCount = typeof request.maxCount === 'number' ? Math.min(Math.max(Math.floor(request.maxCount), 1), 200) : 20;
        const args = ['log', `--max-count=${maxCount}`, '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e'];
        if (request.ref !== undefined) { args.push(ref(request.ref, 'ref')); }
        const { stdout } = await git(repo, [...args, '--', ...(await pathspecs(repo, request.paths, false))]);
        const commits = stdout.split('\x1e').map(s => s.trim()).filter(Boolean).map(line => {
            const [hash, author, email, date, subject] = line.split('\x1f');
            return { hash, author, email, date, subject };
        });
        return { commits };
    });
}

const OPERATIONS = ['branch_list', 'branch_create', 'branch_switch', 'stage', 'unstage', 'commit'] as const;

export async function gitOperation(request: { operation: typeof OPERATIONS[number]; repository?: string; name?: string; startPoint?: string; paths?: string[]; message?: string; includeRemote?: boolean }): Promise<ApiResult<unknown>> {
    return execute(async () => {
        if (!OPERATIONS.includes(request?.operation)) {
            throw new RemoteFsError('INVALID_REQUEST', `operation must be one of: ${OPERATIONS.join(', ')}.`);
        }
        const repo = await repository(request.repository);
        const op = request.operation;
        if (op === 'branch_list') {
            const args = ['branch', '--list', '--format=%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(objectname:short)'];
            if (request.includeRemote === true) { args.push('--all'); }
            const { stdout } = await git(repo, args);
            return {
                operation: op,
                branches: stdout.split('\n').filter(Boolean).map(l => {
                    const [name, head, upstream, commit] = l.split('\x1f');
                    return { name, current: head === '*', upstream: upstream || null, commit };
                })
            };
        }
        if (op === 'branch_create') {
            const name = ref(request.name, 'name');
            await git(repo, ['check-ref-format', '--branch', name]);
            const args = ['branch', name];
            if (request.startPoint !== undefined) { args.push(ref(request.startPoint, 'startPoint')); }
            await git(repo, args, WRITE_TIMEOUT_MS);
            return { operation: op, branch: name };
        }
        if (op === 'branch_switch') {
            const name = ref(request.name, 'name');
            const { stdout, stderr } = await git(repo, ['switch', name], WRITE_TIMEOUT_MS);   // refuses to overwrite local changes
            return { operation: op, branch: name, output: (stdout + stderr).trim().slice(0, 4000) };
        }
        if (op === 'stage' || op === 'unstage') {
            const specs = await pathspecs(repo, request.paths, true);
            await git(repo, op === 'stage' ? ['add', '--', ...specs] : ['restore', '--staged', '--', ...specs], WRITE_TIMEOUT_MS);
            return { operation: op, paths: specs };
        }
        if (typeof request.message !== 'string' || request.message.trim() === '' || request.message.length > 20000) {
            throw new RemoteFsError('INVALID_REQUEST', 'message must be a non-empty commit message.');
        }
        const { stdout } = await git(repo, ['commit', '-m', request.message], WRITE_TIMEOUT_MS);   // hooks run as configured
        const hash = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
        return { operation: op, commit: hash, output: stdout.trim().slice(0, 4000) };
    });
}

