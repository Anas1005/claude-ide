// Remote command execution for the agent: processes run on THIS (remote) host, in any existing directory,
// each in its own process group and tracked by a random session ID. Only processes started here can be inspected or
// terminated. Output is bounded and redacted; privileged commands need an explicit approval flag from the caller.
import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ApiResult, RemoteFsError, execute, reported, resolvePath } from './core';

const MAX_RUNNING = 8;
const MAX_RETAINED = 64;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const DEFAULT_READ_BYTES = 64 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const FOREGROUND_TIMEOUT = { fallback: 120_000, max: 30 * 60_000 };
const BACKGROUND_TIMEOUT = { fallback: 60 * 60_000, max: 24 * 60 * 60_000 };
const MAX_GRACE_MS = 10_000;

const PRIVILEGE_COMMANDS = new Set(['sudo', 'su', 'doas', 'pkexec', 'runuser']);
const COMMAND_PREFIXES = new Set(['env', 'nohup', 'time', 'exec', 'nice', 'ionice', 'stdbuf', 'timeout', 'command', 'builtin']);
/** Environment variables a caller may not set: they inject code into every process or change how shells parse. */
const FORBIDDEN_ENV = /^(LD_PRELOAD|LD_AUDIT|DYLD_.*|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|PS4|IFS|PROMPT_COMMAND)$/;
const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH)/i;
const SECRET_PATTERNS = /\b(sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{32,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;

/** Append-only output buffer that keeps the newest MAX_STREAM_BYTES; offsets count every byte ever written. */
class OutputStream {
    private chunks: Buffer[] = [];
    private held = 0;
    total = 0;

    get dropped() { return this.total - this.held; }

    push(chunk: Buffer) {
        this.chunks.push(chunk);
        this.held += chunk.length;
        this.total += chunk.length;
        while (this.held > MAX_STREAM_BYTES && this.chunks.length > 1) {
            this.held -= this.chunks.shift()!.length;
        }
    }

    read(offset: number | undefined, maxBytes: number) {
        const all = Buffer.concat(this.chunks);
        const from = offset === undefined
            ? Math.max(this.dropped, this.total - maxBytes)   // no offset: the newest output
            : Math.max(offset, this.dropped);
        const slice = all.subarray(from - this.dropped, from - this.dropped + maxBytes);
        return { offset: from, nextOffset: from + slice.length, totalBytes: this.total, droppedBytes: this.dropped, text: slice.toString('utf8') };
    }
}

interface Session {
    id: string;
    command: string;
    cwd: string;
    background: boolean;
    child: ChildProcess;
    startedAt: number;
    endedAt?: number;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    error?: string;
    timedOut: boolean;
    terminated: boolean;
    timer?: NodeJS.Timeout;
    stdout: OutputStream;
    stderr: OutputStream;
    secrets: string[];
    closed: Promise<void>;
    /** Who started it: the agent's conversation, or LEGACY_OWNER for a request that named none. Requests see only their owner's. */
    owner: string;
    /** The caller's id for this one start request. */
    correlationId?: string;
}

const sessions = new Map<string, Session>();

const isRunning = (s: Session) => s.endedAt === undefined;

/** An optional caller-chosen id (owner, correlation id): short, plain characters. */
function callerId(value: unknown, name: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
        throw new RemoteFsError('INVALID_REQUEST', `${name} must be 1-128 letters, digits or _.:-`);
    }
    return value;
}

/**
 * Owner of requests that name none (clients older than API v4). Reserved: no request can name it or anything in its
 * namespace, so such clients only ever see and stop each other's commands, never a conversation's.
 */
export const LEGACY_OWNER = 'legacy:unscoped';
const RESERVED_OWNER_PREFIX = 'legacy:';

/** The owner a request acts for. */
function requestOwner(value: unknown): string {
    const owner = callerId(value, 'owner');
    if (owner === undefined) {
        return LEGACY_OWNER;
    }
    if (owner.startsWith(RESERVED_OWNER_PREFIX)) {
        throw new RemoteFsError('INVALID_REQUEST', `owner must not start with "${RESERVED_OWNER_PREFIX}" (reserved).`);
    }
    return owner;
}

/** The session with this id, if the request's owner started it; any other is reported as not found. */
function ownedSession(sessionId: unknown, owner: string): Session {
    const session = sessions.get(String(sessionId));
    if (!session || session.owner !== owner) {
        throw new RemoteFsError('PROCESS_NOT_FOUND', 'No process with that session ID was started by this agent (or it was discarded).');
    }
    return session;
}

/** First word of every shell segment (after env assignments and wrapper commands), as a base name. */
export function commandWords(command: string, args?: string[]): string[] {
    const segments = args ? [[command, ...args]] : command
        .split(/&&|\|\||[;|&\n()`]|\$\(/)
        .map(segment => segment.trim().split(/\s+/).filter(Boolean));
    const words: string[] = [];
    for (const tokens of segments) {
        let i = 0;
        while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || COMMAND_PREFIXES.has(path.basename(tokens[i]))
            || tokens[i].startsWith('-') || /^\d+(\.\d+)?[smhd]?$/.test(tokens[i]))) {
            i++;
        }
        if (i < tokens.length) {
            words.push(path.basename(tokens[i].replace(/^['"]|['"]$/g, '')));
        }
    }
    return words;
}

/**
 * Conservative: a privilege-escalation program named anywhere as a whole word counts (also inside `bash -c '…'`
 * or `$(which sudo)`). A false positive only means the caller must have approval for it.
 */
export function usesPrivilegeEscalation(command: string, args?: string[]): boolean {
    const text = [command, ...(args ?? [])].join(' ');
    return [...PRIVILEGE_COMMANDS].some(word => new RegExp(`(^|[^A-Za-z0-9_.-])${word}($|[^A-Za-z0-9_.-])`).test(text));
}

function validateEnv(env: unknown): Record<string, string> {
    if (env === undefined) {
        return {};
    }
    if (typeof env !== 'object' || env === null || Array.isArray(env)) {
        throw new RemoteFsError('INVALID_REQUEST', 'env must be an object of string values.');
    }
    const entries = Object.entries(env as Record<string, unknown>);
    if (entries.length > 50) {
        throw new RemoteFsError('INVALID_REQUEST', 'env may set at most 50 variables.');
    }
    for (const [name, value] of entries) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string' || value.length > 32768 || value.includes('\0')) {
            throw new RemoteFsError('INVALID_REQUEST', `Invalid environment variable ${name}.`);
        }
        if (FORBIDDEN_ENV.test(name)) {
            throw new RemoteFsError('INVALID_REQUEST', `${name} cannot be set.`);
        }
    }
    return env as Record<string, string>;
}

/** The child's environment: this host's, without editor internals, plus validated overrides; never interactive. */
export function childEnvironment(overrides: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (!/^(VSCODE_|ELECTRON_)/.test(name) && name !== 'NODE_OPTIONS') {
            env[name] = value;
        }
    }
    return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat', ...overrides };
}

function secretValues(env: NodeJS.ProcessEnv): string[] {
    return Object.entries(env)
        .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === 'string' && value.length >= 8)
        .map(([, value]) => value as string)
        .sort((a, b) => b.length - a.length);
}

export function redact(text: string, secrets: string[]): string {
    for (const secret of secrets) {
        text = text.split(secret).join('[REDACTED]');
    }
    return text.replace(SECRET_PATTERNS, '[REDACTED]');
}

function timeoutFor(value: unknown, background: boolean): number {
    const bounds = background ? BACKGROUND_TIMEOUT : FOREGROUND_TIMEOUT;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), bounds.max) : bounds.fallback;
}

/** Signals the session's whole process group (POSIX) so children started by the command stop too. */
function signal(session: Session, sig: NodeJS.Signals) {
    if (!isRunning(session) || session.child.pid === undefined) {
        return;
    }
    try {
        if (process.platform === 'win32') {
            session.child.kill(sig);
        } else {
            process.kill(-session.child.pid, sig);
        }
    } catch {
        // Already gone.
    }
}

async function stop(session: Session, force: boolean, graceMs: number) {
    if (!isRunning(session)) {
        return;
    }
    session.terminated = true;
    signal(session, force ? 'SIGKILL' : 'SIGTERM');
    if (!force) {
        const exited = await Promise.race([session.closed.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), graceMs))]);
        if (!exited) {
            signal(session, 'SIGKILL');
        }
    }
    await Promise.race([session.closed, new Promise(r => setTimeout(r, 2000))]);
}

function pruneSessions() {
    const finished = [...sessions.values()].filter(s => !isRunning(s)).sort((a, b) => a.endedAt! - b.endedAt!);
    while (sessions.size > MAX_RETAINED && finished.length > 0) {
        sessions.delete(finished.shift()!.id);
    }
}

function summary(session: Session, stdoutOffset?: number, stderrOffset?: number, maxBytes = DEFAULT_READ_BYTES) {
    const read = (stream: OutputStream, offset?: number) => {
        const r = stream.read(offset, maxBytes);
        return { ...r, text: redact(r.text, session.secrets) };
    };
    return {
        sessionId: session.id,
        owner: session.owner,
        ...(session.correlationId !== undefined ? { correlationId: session.correlationId } : {}),
        command: redact(session.command, session.secrets),
        cwd: session.cwd,
        background: session.background,
        state: isRunning(session) ? 'running' : session.error ? 'failed' : 'exited',
        exitCode: session.exitCode,
        signal: session.signal,
        timedOut: session.timedOut,
        terminated: session.terminated,
        error: session.error,
        startedAt: new Date(session.startedAt).toISOString(),
        durationMs: (session.endedAt ?? Date.now()) - session.startedAt,
        stdout: read(session.stdout, stdoutOffset),
        stderr: read(session.stderr, stderrOffset)
    };
}

interface ExecStartRequest {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    background?: boolean;
    allowPrivileged?: boolean;
    owner?: string;
    correlationId?: string;
}

export async function execStart(request: ExecStartRequest): Promise<ApiResult<unknown>> {
    return execute(async () => {
        if (typeof request?.command !== 'string' || request.command.trim() === '' || request.command.length > 20000 || request.command.includes('\0')) {
            throw new RemoteFsError('INVALID_REQUEST', 'command must be a non-empty string.');
        }
        const args = request.args;
        if (args !== undefined && (!Array.isArray(args) || args.length > 1000 || args.some(a => typeof a !== 'string' || a.includes('\0')))) {
            throw new RemoteFsError('INVALID_REQUEST', 'args must be an array of strings.');
        }
        const owner = requestOwner(request.owner);
        const correlationId = callerId(request.correlationId, 'correlationId');
        if (usesPrivilegeEscalation(request.command, args) && request.allowPrivileged !== true) {
            throw new RemoteFsError('PRIVILEGE_NOT_APPROVED', 'This command uses privilege escalation and was not approved for it.');
        }
        if ([...sessions.values()].filter(isRunning).length >= MAX_RUNNING) {
            throw new RemoteFsError('LIMIT_EXCEEDED', `At most ${MAX_RUNNING} commands may run at once; wait for one or terminate it.`);
        }

        const cwd = await resolvePath(request.cwd ?? '.', { allowSensitive: true });   // commands are classified by the agent
        if (!(await fs.stat(cwd.absolutePath)).isDirectory()) {
            throw new RemoteFsError('NOT_A_DIRECTORY', 'cwd is not a directory.');
        }
        const env = childEnvironment(validateEnv(request.env));
        const background = request.background === true;
        const display = args ? [request.command, ...args].join(' ') : request.command;

        // Without args the command is a shell command line (pipes, &&, redirects), run by the host's shell.
        const shell = process.platform === 'win32'
            ? { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', request.command] }
            : { file: existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', args: ['-c', request.command] };
        const child = args
            ? spawn(request.command, args, { cwd: cwd.absolutePath, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true })
            : spawn(shell.file, shell.args, { cwd: cwd.absolutePath, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });

        let markClosed!: () => void;
        const session: Session = {
            id: randomUUID(), command: display, cwd: reported(cwd.absolutePath), background, child,
            startedAt: Date.now(), exitCode: null, signal: null, timedOut: false, terminated: false,
            stdout: new OutputStream(), stderr: new OutputStream(), secrets: secretValues(env),
            closed: new Promise<void>(r => { markClosed = r; }), owner, correlationId
        };
        child.stdout!.on('data', (c: Buffer) => session.stdout.push(c));
        child.stderr!.on('data', (c: Buffer) => session.stderr.push(c));
        const finish = () => {
            if (session.endedAt === undefined) {
                session.endedAt = Date.now();
                clearTimeout(session.timer);
                markClosed();
                pruneSessions();
            }
        };
        child.on('close', (code, sig) => { session.exitCode = code; session.signal = sig; finish(); });

        const spawned = await new Promise<boolean>(resolve => {
            child.once('spawn', () => resolve(true));
            child.once('error', error => { session.error = error.message; finish(); resolve(false); });
        });
        if (!spawned) {
            throw new RemoteFsError('NOT_FOUND', `Could not start the command: ${session.error}`);
        }

        session.timer = setTimeout(() => { session.timedOut = true; void stop(session, false, 5000); }, timeoutFor(request.timeoutMs, background));
        sessions.set(session.id, session);
        return summary(session);
    });
}

interface ExecStatusRequest { sessionId?: string; stdoutOffset?: number; stderrOffset?: number; maxBytes?: number; owner?: string }

export async function execStatus(request: ExecStatusRequest): Promise<ApiResult<unknown>> {
    return execute(async () => {
        const owner = requestOwner(request?.owner);
        if (request?.sessionId === undefined) {
            return { sessions: [...sessions.values()].filter(s => s.owner === owner).map(s => { const { stdout, stderr, ...rest } = summary(s, undefined, undefined, 0); return { ...rest, stdoutBytes: stdout.totalBytes, stderrBytes: stderr.totalBytes }; }) };
        }
        const session = ownedSession(request.sessionId, owner);
        const maxBytes = typeof request.maxBytes === 'number' ? Math.min(Math.max(Math.floor(request.maxBytes), 0), MAX_READ_BYTES) : DEFAULT_READ_BYTES;
        const offset = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
        return summary(session, offset(request.stdoutOffset), offset(request.stderrOffset), maxBytes);
    });
}

interface ExecTerminateRequest { sessionId: string; force?: boolean; graceMs?: number; owner?: string }

export async function execTerminate(request: ExecTerminateRequest): Promise<ApiResult<unknown>> {
    return execute(async () => {
        const session = ownedSession(request?.sessionId, requestOwner(request?.owner));
        const graceMs = typeof request.graceMs === 'number' ? Math.min(Math.max(Math.floor(request.graceMs), 0), MAX_GRACE_MS) : 3000;
        const wasRunning = isRunning(session);
        await stop(session, request.force === true, graceMs);
        return { ...summary(session), wasRunning };
    });
}

/** Called on extension deactivation: no agent process outlives the extension host. */
export function terminateAll() {
    for (const session of sessions.values()) {
        signal(session, 'SIGKILL');
    }
}
