// Remote file tools: search_content, write_file, apply_patch, file_operation.
// Writes are refused when the file changed since Claude last read it here, and write_file never replaces a file
// Claude has not read (as with the native Write tool).
import { z } from 'zod';
import { FilePatch, RemoteFilesystemError, TextEdit, WriteResult } from './remoteFilesystemClient';
import { ToolContext, ToolResult, fail, json, ok, reviewNote } from './remoteWorkspaceServer';
import { remotePathApi } from './remotePaths';

/** Applies exact-match edits locally (used to preview a patch before approval); null if an edit does not apply. */
export function previewEdits(text: string, edits: TextEdit[]): string | null {
  for (const e of edits) {
    if (!e.oldString) return null;
    const count = text.split(e.oldString).length - 1;
    if (count === 0 || (count > 1 && !e.replaceAll)) return null;
    text = e.replaceAll ? text.split(e.oldString).join(e.newString) : text.replace(e.oldString, () => e.newString);
  }
  return text;
}

function changeLine(abs: string, r: WriteResult): string {
  if (r.created) return `Created ${abs} (${r.lines ?? '?'} lines, ${r.bytesWritten} bytes)`;
  return `Updated ${abs}: ${r.previousLines ?? '?'} → ${r.lines ?? '?'} lines, ${r.previousBytes ?? '?'} → ${r.bytesWritten} bytes`;
}

const conflictHelp = (e: unknown): string | undefined => {
  if (!(e instanceof RemoteFilesystemError)) return undefined;
  if (e.code === 'ALREADY_EXISTS') return 'ALREADY_EXISTS: the file exists. Read it with read_file first, then write it (or use apply_patch).';
  if (e.code === 'CONFLICT') return `CONFLICT: ${e.detail} Read the file again with read_file before changing it.`;
  return undefined;
};

export function fileTools(ctx: ToolContext) {
  const { sdk, client, state, pathHint, readOnly, host } = ctx;
  /** Remembers the hash a file was read or written with, under the path requested and the canonical one. */
  const remember = (paths: (string | undefined)[], sha: string | undefined) => { if (sha) for (const p of paths) if (p) state.fileHashes.set(p, sha); };
  const edit = z.object({
    old_string: z.string().min(1).describe('Exact text to replace (must match once unless replace_all)'),
    new_string: z.string().describe('Replacement text'),
    replace_all: z.boolean().optional().describe('Replace every occurrence'),
  });

  return [
    sdk.tool('search_content', 'Search the CONTENTS of text files under a directory on the remote host (like grep). Literal by default; set regex for a JavaScript '
      + 'regular expression. Skips binary files, files over 1 MB, symbolic links, credential folders and .git/node_modules/dist/build. Results are bounded.', {
      pattern: z.string().min(1).describe('Text (or regular expression with regex=true) to find'),
      regex: z.boolean().optional(),
      case_sensitive: z.boolean().optional().describe('Defaults to true'),
      path: z.string().optional().describe(`Directory to search in. ${pathHint}. Defaults to the workspace root.`),
      include: z.array(z.string()).max(50).optional().describe('Glob patterns of files to search, relative to the searched directory, e.g. "*.cpp" or "src/**/*.h"'),
      exclude: z.array(z.string()).max(50).optional().describe('Glob patterns of files or directories to skip'),
      context_lines: z.number().int().min(0).max(10).optional(),
      max_results: z.number().int().min(1).max(1000).optional().describe('Defaults to 100'),
    }, async a => {
      const rel = ctx.resolve(a.path);
      if (!rel.ok) return rel.result;
      const access = ctx.access('search_content', a);
      if ('content' in access) return access;
      return ctx.guard(async () => {
        const r = await client.searchContent({ pattern: a.pattern, regex: a.regex, caseSensitive: a.case_sensitive, path: rel.path,
          include: a.include, exclude: a.exclude, contextLines: a.context_lines, maxResults: a.max_results, ...(access.allowSensitive ? { allowSensitive: true } : {}) });
        const matches = Array.isArray(r.matches) ? (r.matches as { path: string }[]).map(m => ({ ...m, path: ctx.absolute(m.path) })) : [];
        return json({ ...r, matches });
      }, true);
    }, readOnly),

    sdk.tool('write_file', 'Create a file, or replace a file you have read with read_file in this conversation, anywhere on the remote host. '
      + 'The write is atomic; writing to a symbolic link writes the file it points to. Prefer apply_patch to change part of a file.', {
      file_path: z.string().describe(pathHint),
      content: z.string().describe('The complete new file content'),
      create_parents: z.boolean().optional().describe('Create missing parent directories'),
    }, async a => {
      const rel = ctx.resolve(a.file_path);
      if (!rel.ok) return rel.result;
      const access = ctx.access('write_file', a);
      if ('content' in access) return access;
      return ctx.guard(async () => {
        const known = state.fileHashes.get(rel.path);
        try {
          const r = await client.writeFile(rel.path, a.content, { createParents: a.create_parents, returnContent: ctx.reviewing, allowSensitive: access.allowSensitive, ...(known ? { expectedSha256: known } : { mustNotExist: true }) });
          const written = ctx.absolute(r.path);   // canonical: a symbolic link resolved
          remember([rel.path, written], r.sha256);
          if (r.previousContent !== undefined && r.content !== undefined) ctx.record([{ path: written, before: r.previousContent, after: r.content, afterSha: r.sha256 }], 'edit');
          return ok(changeLine(written, r));
        } catch (e) {
          const help = conflictHelp(e);
          if (help) return fail(help);
          throw e;
        }
      }, true);
    }, { annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }),

    sdk.tool('apply_patch', 'Edit existing files anywhere on the remote host with exact text replacements. Each old_string must match exactly once '
      + '(add surrounding lines to make it unique) unless replace_all. All edits of all files are checked before anything is written; '
      + 'nothing is written if any edit does not match.', {
      files: z.array(z.object({ file_path: z.string().describe(pathHint), edits: z.array(edit).min(1).max(100) })).min(1).max(20),
    }, async a => {
      const files: FilePatch[] = [];
      for (const f of a.files) {
        const rel = ctx.resolve(f.file_path);
        if (!rel.ok) return rel.result;
        const known = state.fileHashes.get(rel.path);
        files.push({ path: rel.path, ...(known ? { expectedSha256: known } : {}),
          edits: f.edits.map(e => ({ oldString: e.old_string, newString: e.new_string, replaceAll: e.replace_all })) });
      }
      const access = ctx.access('apply_patch', a);
      if ('content' in access) return access;
      return ctx.guard(async () => {
        try {
          const r = await client.applyPatch(files, { returnContent: ctx.reviewing, allowSensitive: access.allowSensitive });
          r.files.forEach((w, i) => remember([files[i]?.path, ctx.absolute(w.path)], w.sha256));
          ctx.record(r.files.filter(w => w.previousContent !== undefined && w.content !== undefined)
            .map(w => ({ path: ctx.absolute(w.path), before: w.previousContent!, after: w.content!, afterSha: w.sha256 })), 'edit');
          return ok(r.files.map(w => changeLine(ctx.absolute(w.path), w)).join('\n'));
        } catch (e) {
          const help = conflictHelp(e);
          if (help) return fail(help);
          throw e;
        }
      }, true);
    }, { annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }),

    sdk.tool('file_operation', 'Create a directory, delete a file or directory, or move/rename a file or directory anywhere on the remote host. '
      + 'Symbolic links are acted on as links, never followed. Existing destinations are kept unless overwrite (files only). '
      + 'The filesystem root, the home directory and the workspace root are never deleted or moved.', {
      operation: z.enum(['create_directory', 'delete_file', 'delete_directory', 'move', 'rename']),
      path: z.string().describe(pathHint),
      destination: z.string().optional().describe('move: the new path. rename: the new name only (same directory).'),
      recursive: z.boolean().optional().describe('delete_directory: also delete everything inside'),
      overwrite: z.boolean().optional().describe('move/rename: replace an existing destination FILE'),
      create_parents: z.boolean().optional().describe('move: create missing parent directories of the destination'),
    }, async a => {
      const rel = ctx.resolve(a.path);
      if (!rel.ok) return rel.result;
      const p = remotePathApi(host.platform);
      let destination = a.destination;
      let destinationPath: string | undefined;
      if (a.operation === 'move') {
        const dest = ctx.resolve(a.destination ?? '');
        if (!dest.ok) return dest.result;
        destination = destinationPath = dest.path;
      } else if (a.operation === 'rename' && a.destination) {
        destinationPath = p.join(p.dirname(rel.path), a.destination);
      }
      const access = ctx.access('file_operation', a);
      if ('content' in access) return access;
      return ctx.guard(async () => {
        // The review snapshot covers exactly what this operation touches: the path and the destination.
        const snapshot = a.operation === 'create_directory' ? undefined : await ctx.snapshot([rel.path, ...(destinationPath ? [destinationPath] : [])]);
        let r;
        let report;
        try {
          r = await client.fileOperation({ operation: a.operation, path: rel.path, destination, recursive: a.recursive, overwrite: a.overwrite, createParents: a.create_parents, allowSensitive: access.allowSensitive });
        } finally {
          report = await ctx.recordSince(snapshot, 'fileOperation');
        }
        const touched = [rel.path, typeof r.path === 'string' ? ctx.absolute(r.path) : rel.path];
        const moved = typeof r.destination === 'string' ? ctx.absolute(r.destination) : undefined;
        for (const known of [...state.fileHashes.keys()]) {
          if (touched.some(t => known === t || known.startsWith(t + p.sep)) || known === moved) state.fileHashes.delete(known);
        }
        const note = reviewNote(report, [], host.platform);
        return json({ ...r, path: ctx.absolute(typeof r.path === 'string' ? r.path : rel.path), ...(moved ? { destination: moved } : {}), ...(note ? { review: note } : {}) });
      }, true);
    }, { annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }),
  ];
}

export type { ToolResult };
