// Approval policy for the remote tools. One decision table drives both the PreToolUse hook (which the CLI always
// runs, even for tools allowedTools would auto-approve) and canUseTool (the approval UI). Verified with CLI 2.1.283:
// hook "allow" runs a tool without canUseTool, "ask" routes it to canUseTool, "deny" blocks it; plan mode by itself
// does NOT stop MCP tools, so plan enforcement lives here.
import { createHash } from 'crypto';
import { remotePathApi, toRemotePath } from './remotePaths';

export type ApprovalMode = 'auto' | 'ask' | 'askBeforeEach' | 'plan';

const P = 'mcp__remote__';

/** Tools that never change anything: auto-approved (allowedTools) in every mode, plan included. */
export const READ_ONLY_TOOLS = ['read_file', 'list_directory', 'stat', 'search_files', 'search_content', 'git_status', 'git_diff', 'git_log', 'process_status'];
/** Tools that change files, processes or repository state. */
export const MUTATING_TOOLS = ['write_file', 'apply_patch', 'file_operation', 'execute_command', 'terminate_process', 'git_operation'];
export const ALL_REMOTE_TOOLS = [...READ_ONLY_TOOLS, ...MUTATING_TOOLS];
export const remoteToolName = (short: string) => P + short;

export interface CommandRisk {
  /** Needs approval even in auto mode. */
  risky: boolean;
  /** Uses sudo/su/doas/pkexec/runuser: the remote host refuses it unless approved. */
  privileged: boolean;
  reasons: string[];
}

const PRIVILEGE = /(^|[^A-Za-z0-9_.-])(sudo|su|doas|pkexec|runuser)($|[^A-Za-z0-9_.-])/;
const PREFIXES = new Set(['env', 'nohup', 'time', 'exec', 'nice', 'ionice', 'stdbuf', 'timeout', 'command', 'builtin', 'xargs']);
const HOST_WIDE = new Set([
  'systemctl', 'service', 'shutdown', 'reboot', 'halt', 'poweroff', 'init', 'telinit', 'mount', 'umount', 'swapon', 'swapoff',
  'fdisk', 'parted', 'sfdisk', 'mkswap', 'iptables', 'ip6tables', 'nft', 'ufw', 'firewall-cmd', 'useradd', 'userdel', 'usermod',
  'groupadd', 'groupdel', 'passwd', 'chpasswd', 'visudo', 'crontab', 'kill', 'killall', 'pkill', 'docker', 'podman', 'sysctl',
  'modprobe', 'insmod', 'rmmod', 'chroot', 'nsenter', 'setcap',
]);
const PACKAGE_MANAGERS = new Set(['apt', 'apt-get', 'aptitude', 'dpkg', 'yum', 'dnf', 'rpm', 'pacman', 'apk', 'snap', 'zypper', 'flatpak', 'brew']);
const DESTRUCTIVE_PROGRAMS = new Set(['dd', 'shred', 'wipefs', 'blkdiscard']);

/** Words and the first program of each shell segment (after VAR=value and wrapper commands). */
function segments(command: string, args?: string[]): string[][] {
  if (args) return [[command, ...args]];
  return command.split(/&&|\|\||[;|&\n]/).map(s => s.trim().split(/\s+/).filter(Boolean)).filter(s => s.length > 0);
}
function program(tokens: string[]): { name: string; rest: string[] } {
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || PREFIXES.has(tokens[i].split('/').pop()!) || tokens[i].startsWith('-') || /^\d+(\.\d+)?[smhd]?$/.test(tokens[i]))) i++;
  const name = (tokens[i] ?? '').replace(/^['"(]+|['")]+$/g, '').split('/').pop() ?? '';
  return { name, rest: tokens.slice(i + 1) };
}

// Credential locations (the same list the remote extension enforces): reading or changing them needs approval in
// every mode. Where a file is relative to the workspace plays no part in any decision (API v5).
const CREDENTIALS_IN_HOME = ['.ssh', '.gnupg', '.aws', '.config/gcloud', '.kube', '.docker/config.json', '.netrc', '.git-credentials'];
const CREDENTIALS_SYSTEM = ['/etc/shadow', '/etc/gshadow', '/etc/sudoers', '/etc/sudoers.d'];
/** A credential location named in a command line (~/.ssh, $HOME/.aws/…, /etc/shadow, …). */
const CREDENTIAL_IN_COMMAND = /(^|[\s'"=:~/<>])\.(ssh|gnupg|aws|kube|netrc|git-credentials|docker\/config\.json|config\/gcloud)(?=$|[\s'"/;&|)<>])|\/etc\/(g?shadow|sudoers)\b/;

/** Is this absolute remote path a credential location (or inside one)? */
export function isCredentialPath(absolute: string, home: string | undefined, remotePlatform = 'linux'): boolean {
  const p = remotePathApi(remotePlatform);
  const roots = [...CREDENTIALS_SYSTEM, ...(home ? CREDENTIALS_IN_HOME.map(c => p.join(home, c)) : [])];
  return roots.some(r => absolute === r || absolute.startsWith(r + p.sep));
}

/**
 * Heuristic risk classification for auto mode. It is NOT a sandbox: a command can read or write anything the remote
 * user can access. It decides which commands need a person to look at them first. `_workspaceRoot` is unused: no
 * decision depends on where a path is relative to the workspace.
 */
export function classifyCommand(command: string, args: string[] | undefined, _workspaceRoot?: string): CommandRisk {
  const reasons: string[] = [];
  const text = [command, ...(args ?? [])].join(' ');
  const privileged = PRIVILEGE.test(text);
  if (privileged) reasons.push('uses privilege escalation (sudo/su/doas/pkexec/runuser)');
  if (CREDENTIAL_IN_COMMAND.test(text)) reasons.push('reads or changes credential files (~/.ssh, ~/.aws, /etc/shadow, …)');
  if (!args) {
    if (/(^|[\s;&|(])(eval|source)\s|\b(bash|sh|zsh|dash)\s+-c\b|\$\(\s*(curl|wget)|<\(\s*(curl|wget)/.test(command)) reasons.push('runs dynamically built shell code');
    if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(command)) reasons.push('pipes a download into a shell');
  }
  for (const tokens of segments(command, args)) {
    const { name, rest } = program(tokens);
    if (!name) continue;
    if (HOST_WIDE.has(name)) reasons.push(`${name} affects the whole host or other processes`);
    if (PACKAGE_MANAGERS.has(name) && rest.some(r => /^(install|remove|purge|upgrade|dist-upgrade|uninstall|erase|-S|-R|-U|-i|-r|add|del)$/.test(r))) reasons.push(`${name} changes system packages`);
    if (DESTRUCTIVE_PROGRAMS.has(name) || name.startsWith('mkfs')) reasons.push(`${name} can destroy data`);
    if (name === 'rm' && rest.some(r => /^-[a-zA-Z]*[rRf]/.test(r) || r === '--recursive' || r === '--force')) reasons.push('rm with -r/-f deletes recursively or without asking');
    if (name === 'find' && rest.some(r => r === '-delete' || r === '-exec' || r === '-execdir')) reasons.push('find with -delete/-exec');
    if ((name === 'npm' || name === 'pnpm' || name === 'yarn') && rest.some(r => r === '-g' || r === '--global' || r === 'global')) reasons.push(`${name} global install`);
    if ((name === 'pip' || name === 'pip3') && rest.includes('install') && rest.some(r => r === '--user' || r === '--break-system-packages' || r === '--system')) reasons.push('pip install into the user or system environment');
    if (name === 'git') {
      const sub = rest.find(r => !r.startsWith('-'));
      if (sub === 'push' && rest.some(r => /^(-f|--force|--force-with-lease|--mirror|--delete|-d)$/.test(r) || r.startsWith('+') || r.startsWith(':'))) reasons.push('git push that can overwrite or delete remote history');
      else if (sub === 'push') reasons.push('git push publishes to a remote');
      if (sub === 'reset' && rest.includes('--hard')) reasons.push('git reset --hard discards changes');
      if (sub === 'clean') reasons.push('git clean deletes untracked files');
      if (sub === 'branch' && rest.some(r => /^(-D|-d|--delete|-f|--force|-M)$/.test(r))) reasons.push('git branch deletion or forced move');
      if ((sub === 'checkout' || sub === 'restore') && rest.some(r => r === '.' || r === '--' || r === '-f' || r === '--force')) reasons.push(`git ${sub} that discards working-tree changes`);
      if (sub === 'filter-branch' || sub === 'filter-repo' || (sub === 'rebase' && rest.includes('--root'))) reasons.push(`git ${sub} rewrites history`);
    }
  }
  return { risky: reasons.length > 0, privileged, reasons: [...new Set(reasons)] };
}

/**
 * Absolute paths a command line names (tokens starting with "/" or "~", quotes and redirections removed): used to say
 * which changes a review snapshot did not cover. Heuristic; /dev and /proc are left out.
 */
export function pathsInCommand(command: string, args: string[] | undefined, home: string | undefined, platform = 'linux'): string[] {
  const p = remotePathApi(platform);
  const tokens = [command, ...(args ?? [])].flatMap(t => (args ? [t] : t.split(/[\s;&|()<>]+/)));
  const out = new Set<string>();
  for (const raw of tokens) {
    const t = raw.replace(/^[0-9]*>>?/, '').replace(/^['"]+|['"]+$/g, '').replace(/^\$\{?HOME\}?(?=\/|$)/, '~');
    let abs: string | undefined;
    if ((t === '~' || t.startsWith('~/')) && home) abs = p.join(home, t.slice(1));
    else if (p.isAbsolute(t) && !t.startsWith('//')) abs = p.normalize(t);
    if (abs && !/^\/(dev|proc|sys)(\/|$)/.test(abs)) out.add(abs.length > 1 ? abs.replace(/[\\/]+$/, '') : abs);
  }
  return [...out];
}

export interface ToolDecision {
  decision: 'allow' | 'ask' | 'deny';
  reason: string;
  /** May the person choose "Always allow" for this kind of call in this session? */
  canAlwaysAllow: boolean;
  /** Key remembered by "Always allow". */
  alwaysKey?: string;
  /** Credential locations this call reads or changes: approving it lets exactly these through (credentialApprovalKey). */
  credentials?: string[];
}

/** Where relative paths resolve and where "~" is, as the remote host reported them. */
export interface RemoteWhere { root: string; home?: string; platform?: string }

/** The paths a remote tool call names, absolute (move/rename destinations included). */
export function toolPaths(short: string, input: Record<string, unknown>, where: RemoteWhere): string[] {
  const platform = where.platform ?? 'linux';
  const resolve = (v: unknown) => {
    if (typeof v !== 'string' && v !== undefined) return undefined;
    const r = toRemotePath(v as string | undefined, where.root, platform, where.home);
    return r.ok ? r.path : undefined;
  };
  const out: (string | undefined)[] = [];
  if (short === 'read_file' || short === 'write_file' || short === 'stat') out.push(resolve(input.file_path));
  if (short === 'list_directory' || short === 'search_files' || short === 'search_content') out.push(resolve(input.path));
  if (short === 'apply_patch' && Array.isArray(input.files)) for (const f of input.files) out.push(resolve((f as { file_path?: unknown })?.file_path));
  if (short === 'file_operation') {
    const source = resolve(input.path);
    out.push(source);
    if (input.operation === 'move') out.push(resolve(input.destination ?? ''));
    if (input.operation === 'rename' && source && typeof input.destination === 'string') out.push(remotePathApi(platform).join(remotePathApi(platform).dirname(source), input.destination));
  }
  return out.filter((p): p is string => !!p);
}

/** Credential locations among the paths of a remote tool call. */
export function credentialTargets(short: string, input: Record<string, unknown>, where: RemoteWhere): string[] {
  return [...new Set(toolPaths(short, input, where).filter(p => isCredentialPath(p, where.home, where.platform)))].sort();
}

/** Identifies an approved credential access: the tool and exactly those locations. */
export const credentialApprovalKey = (toolName: string, credentials: string[]) => approvalKey(toolName, { credentials: [...credentials].sort() });

const describe = (input: Record<string, unknown>) => String(input.operation ?? '');

/**
 * Decision for one remote tool call. `alwaysAllowed` holds keys the person chose "Always allow" for in this
 * session; risky calls never use it.
 */
export function remoteToolDecision(toolName: string, input: Record<string, unknown>, mode: ApprovalMode, where: string | RemoteWhere, alwaysAllowed: ReadonlySet<string>): ToolDecision {
  const short = toolName.startsWith(P) ? toolName.slice(P.length) : toolName;
  const location: RemoteWhere = typeof where === 'string' ? { root: where } : where;
  if (!READ_ONLY_TOOLS.includes(short) && !MUTATING_TOOLS.includes(short)) return { decision: 'deny', reason: `${toolName} is not a remote workspace tool`, canAlwaysAllow: false };
  const readOnly = READ_ONLY_TOOLS.includes(short) || (short === 'git_operation' && input.operation === 'branch_list');
  if (!readOnly && mode === 'plan') return { decision: 'deny', reason: 'Plan mode: nothing may be changed or run yet. Present the plan with ExitPlanMode and wait for approval.', canAlwaysAllow: false };
  // Credential locations: asked in every mode (plan included, for reads), never "Always allow".
  const credentials = credentialTargets(short, input, location);
  if (credentials.length > 0) return { decision: 'ask', reason: `credential location: ${credentials.join(', ')}`, canAlwaysAllow: false, credentials };
  if (readOnly) return { decision: 'allow', reason: 'read-only', canAlwaysAllow: false };

  let risky: string[] = [];
  let kind: 'edit' | 'delete' | 'command' | 'process' | 'git' = 'edit';
  if (short === 'execute_command') {
    kind = 'command';
    risky = classifyCommand(String(input.command ?? ''), Array.isArray(input.args) ? input.args.map(String) : undefined).reasons;
  } else if (short === 'file_operation') {
    if (input.operation === 'delete_file' || input.operation === 'delete_directory') kind = 'delete';
    if (input.operation === 'delete_directory' && input.recursive === true) risky = ['deletes a directory and everything in it'];
    if (input.overwrite === true) risky = [...risky, 'overwrites an existing file'];
  } else if (short === 'terminate_process') {
    kind = 'process';
  } else if (short === 'git_operation') {
    kind = 'git';
  }
  if (risky.length > 0) return { decision: 'ask', reason: risky.join('; '), canAlwaysAllow: false };

  const alwaysKey = short === 'file_operation' || short === 'git_operation' ? `${short}:${describe(input)}` : short;
  if (alwaysAllowed.has(alwaysKey)) return { decision: 'allow', reason: 'allowed for this session', canAlwaysAllow: false };
  if (mode === 'auto') return { decision: 'allow', reason: 'auto mode', canAlwaysAllow: false };
  if (mode === 'askBeforeEach') return { decision: 'ask', reason: 'Ask before each change', canAlwaysAllow: false, alwaysKey };
  // ask mode, as for local work: edits proceed (local edits are applied and staged without a prompt); deletes,
  // commands, git changes and process control are asked, with "Always allow" available.
  if (kind === 'edit') return { decision: 'allow', reason: 'ask mode: file edits are applied without a prompt', canAlwaysAllow: false };
  return { decision: 'ask', reason: `ask mode: ${kind === 'delete' ? 'deletions' : kind === 'command' ? 'commands' : kind === 'git' ? 'git changes' : 'process control'} need approval`, canAlwaysAllow: true, alwaysKey };
}

/** Identifies one exact call, so a privileged command runs only with the input a person approved. */
export function approvalKey(toolName: string, input: unknown): string {
  const stable = (v: unknown): unknown => (Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, stable((v as Record<string, unknown>)[k])])) : v);
  return createHash('sha256').update(`${toolName}\n${JSON.stringify(stable(input))}`).digest('hex');
}
