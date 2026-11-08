// Finding and launching the Claude Code CLI on this machine (Windows, macOS, Linux), and its configuration directory.
// Nothing here runs a shell: a Windows npm shim (claude.cmd) is never executed; the program it points to (claude.exe,
// or cli.js run by node) is launched directly, so arguments are never re-parsed by cmd.exe.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** How to start the CLI. `sdkPath` goes to the SDK (`pathToClaudeCodeExecutable`; a .js path is run with node by the SDK). */
export interface CliLaunch {
  sdkPath: string;
  /** Program for execFile / a terminal, then `args` before the CLI's own arguments. */
  command: string;
  args: string[];
}

export interface CliDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exists(p: string): boolean;
  readText(p: string): string | undefined;
}

export const defaultDeps = (): CliDeps => ({
  platform: process.platform, env: process.env, home: os.homedir(),
  exists: p => { try { return fs.statSync(p).isFile(); } catch { return false; } },
  readText: p => { try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; } },
});

const pathApi = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

/** Claude Code's configuration directory: CLAUDE_CONFIG_DIR when set to an absolute path, otherwise ~/.claude. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir(), platform: NodeJS.Platform = process.platform): string {
  const p = pathApi(platform);
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured && p.isAbsolute(configured) ? p.normalize(configured) : p.join(home, '.claude');
}

const pathKey = (env: NodeJS.ProcessEnv) => Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
function onPath(names: string[], d: CliDeps): string | undefined {
  const p = pathApi(d.platform);
  for (const dir of (d.env[pathKey(d.env)] ?? '').split(d.platform === 'win32' ? ';' : ':')) {
    for (const name of names) { const f = dir && p.join(dir, name); if (f && d.exists(f)) return f; }
  }
}

const SCRIPT = /\.(js|mjs|cjs)$/i;
const SHIM = /\.(cmd|bat|ps1)$/i;

/**
 * The program an npm Windows shim starts. npm's cmd-shim writes `"%dp0%\node_modules\<pkg>\<bin>" %*` (or with
 * `%~dp0`); otherwise the package's `bin` entry, then known file names, are used.
 */
export function shimTarget(shim: string, d: CliDeps): string | undefined {
  const p = path.win32;
  const dir = p.dirname(shim);
  const text = d.readText(shim) ?? '';
  for (const m of text.matchAll(/%~?dp0%?\\([^"%\r\n*]+?\.(?:exe|js|mjs|cjs))/gi)) {
    const target = p.join(dir, m[1]);
    if (d.exists(target)) return target;
  }
  const pkg = p.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
  try {
    const bin = JSON.parse(d.readText(p.join(pkg, 'package.json')) ?? 'null')?.bin;
    const rel = typeof bin === 'string' ? bin : bin?.claude;
    if (typeof rel === 'string' && d.exists(p.join(pkg, rel))) return p.join(pkg, rel);
  } catch { /* no or invalid package.json */ }
  return ['bin/claude.exe', 'claude.exe', 'cli.js'].map(f => p.join(pkg, f)).find(f => d.exists(f));
}

/** node for running cli.js: next to the shim (npm prefers it), else on PATH, else "node" (resolved by the OS). */
function findNode(near: string | undefined, d: CliDeps): string {
  const p = pathApi(d.platform);
  const exe = d.platform === 'win32' ? 'node.exe' : 'node';
  const local = near && p.join(p.dirname(near), exe);
  return (local && d.exists(local) ? local : undefined) ?? onPath([exe], d) ?? exe;
}

/** How to launch `file` (a binary, a .js entry point, or a Windows npm shim); undefined when a shim cannot be resolved. */
export function launchFor(file: string, d: CliDeps): CliLaunch | undefined {
  let target = file;
  let shim: string | undefined;
  if (d.platform === 'win32' && SHIM.test(file)) {
    shim = file;
    const t = shimTarget(file, d);
    if (!t) return undefined;
    target = t;
  }
  if (SCRIPT.test(target)) return { sdkPath: target, command: findNode(shim, d), args: [target] };
  return { sdkPath: target, command: target, args: [] };
}

/** The CLI: the `claudePath` setting, then the usual install locations, then PATH (native binaries before npm shims). */
export function findClaude(configured: string | undefined, d: CliDeps = defaultDeps()): CliLaunch | undefined {
  if (configured) return launchFor(configured, d);
  const p = pathApi(d.platform);
  const win = d.platform === 'win32';
  const exe = win ? 'claude.exe' : 'claude';
  const known = [p.join(d.home, '.local', 'bin', exe), p.join(d.home, '.claude', 'local', exe),
    ...(win ? [] : ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'])];
  const found = known.find(f => d.exists(f)) ?? onPath([exe], d)
    ?? (win ? [d.env.APPDATA && p.join(d.env.APPDATA, 'npm', 'claude.cmd')].find((f): f is string => !!f && d.exists(f)) ?? onPath(['claude.cmd'], d) : undefined);
  return found ? launchFor(found, d) : undefined;
}

/** Extra PATH entry so the SDK's own `node` lookup finds the node chosen for cli.js. */
export function nodeDirFor(launch: CliLaunch | undefined, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!launch || !launch.args.length) return undefined;
  const p = pathApi(platform);
  return p.isAbsolute(launch.command) ? p.dirname(launch.command) : undefined;
}
