// Remote-SSH mode policy: when it applies, which tools exist, and the query options that keep Claude off the local
// filesystem. Pure functions (no `vscode`), so the policy is unit-tested exactly as the extension uses it.
import * as path from 'path';
import { createHash } from 'crypto';
import type { AgentDefinition, McpSdkServerConfigWithInstance, Options } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { RemoteFilesystemClient, RemoteFilesystemError, SSH_REMOTE_NAME } from './remoteFilesystemClient';
import { REMOTE_SERVER_NAME, RemoteWorkspaceHost } from './remoteWorkspaceServer';
import { ALL_REMOTE_TOOLS, READ_ONLY_TOOLS } from './permissions';

export type WorkspaceMode = 'local' | 'remoteSsh' | 'guard';

/** Local windows run as before; Remote-SSH runs remote mode only when the experimental setting is on; every other remote keeps the guard. */
export function workspaceMode(remoteName: string | undefined, remoteSshEnabled: boolean): WorkspaceMode {
  if (!remoteName) return 'local';
  return remoteName === SSH_REMOTE_NAME && remoteSshEnabled ? 'remoteSsh' : 'guard';
}

/** MCP tool names as Claude sees them. */
export const REMOTE_TOOLS: readonly string[] = ALL_REMOTE_TOOLS.map(t => `mcp__${REMOTE_SERVER_NAME}__${t}`);
/** Auto-approved (allowedTools): they never change anything. Every other remote tool goes through the approval policy. */
export const REMOTE_READ_TOOLS: readonly string[] = READ_ONLY_TOOLS.map(t => `mcp__${REMOTE_SERVER_NAME}__${t}`);

/** Built-in tools kept in remote mode: none reads, writes or runs anything on this machine's filesystem. */
export const REMOTE_NATIVE_TOOLS: readonly string[] = ['AskUserQuestion', 'TodoWrite', 'EnterPlanMode', 'ExitPlanMode', 'WebFetch', 'WebSearch', 'Agent', 'Task'];
/** Sub-agent tools (Agent; Task is its older name). Sub-agents get only remote and web tools; every call they make passes the same hooks and approvals. */
export const SUBAGENT_TOOLS: readonly string[] = ['Agent', 'Task'];

/** Built-in tools that act on the local filesystem or run local processes; removed explicitly as well. */
export const LOCAL_ONLY_NATIVE_TOOLS: readonly string[] = [
  'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'Bash', 'Monitor',
  'EnterWorktree', 'ExitWorktree', 'Skill', 'Workflow',
];

/** The last line of defence (PreToolUse hook and canUseTool): anything else is denied in remote mode. */
export function isToolAllowedInRemoteMode(toolName: string): boolean {
  return REMOTE_NATIVE_TOOLS.includes(toolName) || REMOTE_TOOLS.includes(toolName);
}

/**
 * Local working directory for the CLI in remote mode: a directory in this extension's global storage, one per remote
 * authority + workspace, so sessions stay separate per remote workspace and never mix with local ones.
 */
export function remotePlaceholderDir(globalStorageDir: string, remoteAuthority: string, remoteWorkspacePath: string): string {
  const id = createHash('sha256').update(`${remoteAuthority}\n${remoteWorkspacePath}`).digest('hex').slice(0, 32);
  return path.join(globalStorageDir, 'remote-workspaces', id);
}

export function remoteSystemPrompt(host: RemoteWorkspaceHost): string {
  return [
    `The project is on a remote ${host.platform} host ("${host.hostname}"), opened in the editor over Remote-SSH. Its workspace root is ${host.root}${host.home ? `; the remote home directory is ${host.home}` : ''}.`,
    'Your working directory is only a placeholder on the user\'s computer: it does not contain the project, and the git status above (if any) is not the project\'s.',
    `Work only with the mcp__${REMOTE_SERVER_NAME}__* tools (files, search, commands, git); they act on the remote host. They reach any path the remote user can access, including other projects: absolute paths anywhere, paths relative to ${host.root}, and ~.`,
    'There is no local shell or local file access: build, test and run things with mcp__remote__execute_command, which runs on the remote host.',
    'Sub-agents (Agent tool) have the same remote tools and run in the foreground: prefer the remote-general and remote-explore agents.',
    'Read a file before replacing it with write_file; prefer apply_patch for edits. Commands that need privileges or affect the whole host, and access to credential files (~/.ssh, ~/.aws, …), ask the user first.',
  ].join('\n');
}

/**
 * A sub-agent call as it may run in remote mode: in the foreground (a background sub-agent would outlive the turn,
 * whose end closes its approvals), with the session's permission mode (no `mode`) and no isolation (`worktree` would
 * act on this computer, `remote` would start a cloud environment).
 */
export function sanitizeAgentInput(input: unknown): Record<string, unknown> {
  const { mode: _mode, isolation: _isolation, team_name: _team, ...rest } = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return { ...rest, run_in_background: false };
}

/** Sub-agents for remote work: the remote tools only (plus web), so they act on the remote host like the main conversation. */
export function remoteAgents(host: RemoteWorkspaceHost): Record<string, AgentDefinition> {
  const where = `The project is on the remote host "${host.hostname}" (workspace root ${host.root}). Use only the mcp__${REMOTE_SERVER_NAME}__* tools for files, search, commands and git; there is no local file access or shell.`;
  return {
    'remote-general': {
      description: 'General-purpose agent for multi-step work on the remote project: research, edits, running commands. Use it for delegated or parallel tasks.',
      prompt: `You are a sub-agent working on a remote project. ${where} Report concisely what you found or changed.`,
      tools: [...REMOTE_TOOLS, 'WebFetch', 'WebSearch', 'TodoWrite'],
    },
    'remote-explore': {
      description: 'Read-only agent for exploring the remote project: finding files, searching code, reading, git history. It never changes anything.',
      prompt: `You are a read-only sub-agent exploring a remote project. ${where} Never change files or run mutating commands. Report concisely.`,
      tools: [...REMOTE_READ_TOOLS, 'WebFetch', 'WebSearch'],
    },
  };
}

/** A project instruction file of the remote workspace (CLAUDE.md and friends). */
export interface ProjectInstructions { path: string; content: string; truncated: boolean }
export const PROJECT_INSTRUCTION_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];
export const MAX_PROJECT_INSTRUCTION_BYTES = 40 * 1024;

/** Reads the remote workspace's instruction files (missing ones skipped), each cut to 40 KB. Call only for a trusted workspace. */
export async function loadProjectInstructions(client: RemoteFilesystemClient, host: RemoteWorkspaceHost, onError?: (path: string, e: unknown) => void): Promise<ProjectInstructions[]> {
  const p = host.platform === 'win32' ? path.win32 : path.posix;
  const out: ProjectInstructions[] = [];
  for (const rel of PROJECT_INSTRUCTION_FILES) {
    const file = p.join(host.root, ...rel.split('/'));
    try {
      const { content, path: canonical } = await client.readFileDetails(file);
      const bytes = Buffer.from(content, 'utf8');
      const truncated = bytes.length > MAX_PROJECT_INSTRUCTION_BYTES;
      // Cut on a character boundary: drop a partial UTF-8 sequence at the end.
      const text = truncated ? bytes.subarray(0, MAX_PROJECT_INSTRUCTION_BYTES).toString('utf8').replace(/\uFFFD$/, '') : content;
      if (text.trim()) out.push({ path: canonical ?? file, content: text, truncated });
    } catch (e) {
      if (!(e instanceof RemoteFilesystemError && e.code === 'NOT_FOUND')) onError?.(file, e);
    }
  }
  return out;
}

/** The instruction files as a system-prompt section. */
export function projectInstructionsPrompt(files: ProjectInstructions[]): string {
  if (!files.length) return '';
  return ['', 'Project instructions from the remote workspace (CLAUDE.md files). Follow them as the project\'s own instructions:',
    ...files.map(f => `<project-instructions path="${f.path}">\n${f.content}${f.truncated ? `\n[… cut at ${MAX_PROJECT_INSTRUCTION_BYTES / 1024} KB]` : ''}\n</project-instructions>`)].join('\n');
}

/** Options merged over the normal ones in remote mode. `server` must be created fresh for each query. */
export function remoteQueryOptions(server: McpSdkServerConfigWithInstance, host: RemoteWorkspaceHost, project: ProjectInstructions[] = []): Partial<Options> {
  return {
    settingSources: ['user'],          // this machine's own settings; never project/local settings (the cwd is a placeholder)
    tools: [...REMOTE_NATIVE_TOOLS],   // base set of built-in tools (`--tools`)
    disallowedTools: [...LOCAL_ONLY_NATIVE_TOOLS],
    allowedTools: [...REMOTE_READ_TOOLS],
    mcpServers: { [REMOTE_SERVER_NAME]: server },
    strictMcpConfig: true,             // no .mcp.json, user or plugin MCP servers: they would run on this machine
    agents: remoteAgents(host),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: remoteSystemPrompt(host) + projectInstructionsPrompt(project) },
  };
}
