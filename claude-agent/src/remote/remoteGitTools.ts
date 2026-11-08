// Remote git tools: git_status, git_diff, git_log, git_operation (branch list/create/switch, stage, unstage, commit).
// No force, reset, clean, amend or branch deletion is offered; use execute_command (which asks first) for those.
import { z } from 'zod';
import { ToolContext, ToolResult, json } from './remoteWorkspaceServer';

export function gitTools(ctx: ToolContext) {
  const { sdk, client, readOnly } = ctx;
  const repoHint = `Directory inside the git repository (any repository on the remote host). ${ctx.pathHint}. Defaults to the workspace root.`;

  /** Converts the repository and path arguments, or returns the error result. */
  const convert = (repository: string | undefined, paths: string[] | undefined): { repository: string; paths?: string[] } | ToolResult => {
    const repo = ctx.resolve(repository);
    if (!repo.ok) return repo.result;
    if (!paths) return { repository: repo.path };
    const converted: string[] = [];
    for (const p of paths) {
      const rel = ctx.resolve(p);
      if (!rel.ok) return rel.result;
      converted.push(rel.path);
    }
    return { repository: repo.path, paths: converted };
  };
  const isError = (v: unknown): v is ToolResult => typeof v === 'object' && v !== null && 'content' in v;

  return [
    sdk.tool('git_status', 'Show the git branch, upstream, ahead/behind counts, and staged, unstaged, untracked and conflicted files.', {
      repository: z.string().optional().describe(repoHint),
    }, a => {
      const c = convert(a.repository, undefined);
      return isError(c) ? Promise.resolve(c) : ctx.guard(async () => json(await client.gitStatus(c)), true);
    }, readOnly),

    sdk.tool('git_diff', 'Show the working-tree diff, or the staged diff with staged=true, optionally for some paths. Output is bounded.', {
      repository: z.string().optional().describe(repoHint),
      staged: z.boolean().optional(),
      paths: z.array(z.string()).max(500).optional(),
      context_lines: z.number().int().min(0).max(20).optional(),
      stat: z.boolean().optional().describe('Summary of changed files instead of the full diff'),
      max_bytes: z.number().int().min(1024).max(2 * 1024 * 1024).optional().describe('Defaults to 200 KB'),
    }, a => {
      const c = convert(a.repository, a.paths);
      return isError(c) ? Promise.resolve(c) : ctx.guard(async () =>
        json(await client.gitDiff({ ...c, staged: a.staged, contextLines: a.context_lines, stat: a.stat, maxBytes: a.max_bytes })), true);
    }, readOnly),

    sdk.tool('git_log', 'Show recent commits (hash, author, date, subject), optionally for some paths or starting at a ref.', {
      repository: z.string().optional().describe(repoHint),
      max_count: z.number().int().min(1).max(200).optional().describe('Defaults to 20'),
      paths: z.array(z.string()).max(500).optional(),
      ref: z.string().optional().describe('Branch, tag or commit to start from'),
    }, a => {
      const c = convert(a.repository, a.paths);
      return isError(c) ? Promise.resolve(c) : ctx.guard(async () => json(await client.gitLog({ ...c, maxCount: a.max_count, ref: a.ref })), true);
    }, readOnly),

    sdk.tool('git_operation', 'Change the git repository: branch_list, branch_create (name, optional start_point), branch_switch (name; refuses '
      + 'to overwrite local changes), stage (paths), unstage (paths), commit (message; commit hooks run). Destructive operations are not offered.', {
      operation: z.enum(['branch_list', 'branch_create', 'branch_switch', 'stage', 'unstage', 'commit']),
      repository: z.string().optional().describe(repoHint),
      name: z.string().optional().describe('Branch name'),
      start_point: z.string().optional(),
      paths: z.array(z.string()).max(500).optional().describe('stage/unstage: paths in the repository (absolute, or relative to the workspace root)'),
      message: z.string().optional().describe('commit: the commit message'),
      include_remote: z.boolean().optional().describe('branch_list: include remote-tracking branches'),
    }, a => {
      const c = convert(a.repository, a.paths);
      return isError(c) ? Promise.resolve(c) : ctx.guard(async () => json(await client.gitOperation({
        operation: a.operation, ...c, name: a.name, startPoint: a.start_point, message: a.message, includeRemote: a.include_remote,
      })), true);
    }, { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }),
  ];
}
