// Review backend for Remote-SSH workspaces. Keys are `vscode-remote://` URIs of remote files, in the workspace or
// anywhere else on the host (API v5); content lives on the remote host and is read and written through
// RemoteFilesystemClient, so the remote extension's checks apply to every review write. Writes are checked against the version last seen, and a whole-file
// reject refuses to discard edits made after Claude's change unless the person confirms.
import * as vscode from 'vscode';
import * as path from 'path';
import { createHash } from 'crypto';
import { ReviewConflict, ReviewFiles, ReviewWriteOptions } from '../review';
import { RemoteFilesystemClient, RemoteFilesystemError } from './remoteFilesystemClient';

const CLAUDE_VERSIONS_KEY = 'claudeIde.remote.claudeVersions';
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const isNotFound = (e: unknown) => e instanceof RemoteFilesystemError && e.code === 'NOT_FOUND';
/**
 * Review reads and writes act on files Claude changed (credential locations only with the user's approval) and are the
 * person's own action in the review: the credential check does not stop them.
 */
const REVIEW_ACCESS = { allowSensitive: true } as const;
const isConflict = (e: unknown) => e instanceof RemoteFilesystemError && (e.code === 'CONFLICT' || e.code === 'ALREADY_EXISTS');

export class RemoteReviewFiles implements ReviewFiles {
  /** Current content (null = absent) and its sha256, as last read or written. */
  private current = new Map<string, { content: string | null; sha: string | null }>();
  /** sha256 of the content Claude last left in each file (null = Claude deleted it). Persisted with the review. */
  private claudeVersions: Map<string, string | null>;

  constructor(private readonly client: RemoteFilesystemClient, readonly folder: vscode.Uri, private readonly state: vscode.Memento) {
    this.claudeVersions = new Map(Object.entries(state.get<Record<string, string | null>>(CLAUDE_VERSIONS_KEY, {})));
  }

  /** Key of a remote path: absolute (any file on the host), or relative to the workspace folder. */
  keyFor(remotePath: string): string {
    const posix = remotePath.replace(/\\/g, '/');
    if (/^[A-Za-z]:\//.test(posix)) return this.folder.with({ path: '/' + posix }).toString();   // win32 remote: C:/x → /C:/x
    if (posix.startsWith('/')) return this.folder.with({ path: path.posix.normalize(posix) }).toString();
    return vscode.Uri.joinPath(this.folder, ...posix.split('/').filter(Boolean)).toString();
  }
  /** The remote path of a key, as the remote extension takes it (absolute). */
  remotePath(key: string): string {
    const p = vscode.Uri.parse(key).path;
    return /^\/[A-Za-z]:\//.test(p) ? p.slice(1) : p;
  }
  /** How a key is shown: relative to the workspace folder when inside it, else the absolute remote path. */
  display(key: string): string {
    const p = vscode.Uri.parse(key).path;
    const rel = path.posix.relative(this.folder.path, p);
    return rel && !rel.startsWith('..') && !path.posix.isAbsolute(rel) ? rel : this.remotePath(key);
  }

  read(key: string) { return this.current.get(key)?.content; }
  uri(key: string) { return vscode.Uri.parse(key); }

  keyOf(u: vscode.Uri): string | undefined {
    if (u.scheme !== this.folder.scheme || u.authority !== this.folder.authority || !u.path || u.path === '/') return undefined;
    return this.keyFor(u.path);
  }
  keyOfBaseline(u: vscode.Uri) { return this.keyOf(u.with({ scheme: this.folder.scheme })); }
  keyOfArg(arg: string): string | undefined {
    if (/^[a-z][\w+.-]+:/i.test(arg)) return this.keyOf(vscode.Uri.parse(arg));   // a URI string (a key)
    // A file system path, as the editor's inline review widget passes it (separators depend on this machine).
    for (const key of this.current.keys()) if (vscode.Uri.parse(key).fsPath === arg) return key;
    const posix = arg.replace(/\\/g, '/');
    return posix.startsWith('/') ? this.keyOf(this.folder.with({ path: posix })) : undefined;
  }

  /** After Claude changed a file: what is there now, and that this version is Claude's. */
  recordClaudeChange(key: string, content: string | null, sha?: string | null) {
    const version = content === null ? null : sha ?? sha256(content);
    this.current.set(key, { content, sha: version });
    this.claudeVersions.set(key, version);
    this.persist();
  }

  async refresh(key: string) {
    try {
      const { content, sha256: sha } = await this.client.readFileDetails(this.remotePath(key), REVIEW_ACCESS);
      this.current.set(key, { content, sha: sha || sha256(content) });
    } catch (e) {
      if (!isNotFound(e)) throw e;
      this.current.set(key, { content: null, sha: null });
    }
  }

  /** Loads the current content of reviewed files (after a window reload); files that fail stay unknown. */
  async load(keys: string[]) {
    await Promise.all(keys.map(k => this.refresh(k).catch(() => undefined)));
  }

  async write(key: string, content: string | null, options?: ReviewWriteOptions) {
    const rel = this.display(key);
    const target = this.remotePath(key);
    const now = this.current.get(key);
    if (!now) throw new ReviewConflict(`${rel}: its current content could not be read from the remote host.`, false);
    if (!options?.hunk && !options?.force && this.claudeVersions.has(key) && this.claudeVersions.get(key) !== now.sha) {
      throw new ReviewConflict(`${rel} was changed after Claude's edit.`, true);
    }
    if (content === now.content) return;
    try {
      if (content === null) {
        // Delete only the exact version reviewed: re-check right before deleting.
        const check = await this.client.readFileDetails(target, REVIEW_ACCESS);
        if ((check.sha256 || sha256(check.content)) !== now.sha) throw new ReviewConflict(`${rel} changed on the remote host; review it again.`, false);
        await this.client.fileOperation({ operation: 'delete_file', path: target, ...REVIEW_ACCESS });
        this.current.set(key, { content: null, sha: null });
      } else {
        const r = await this.client.writeFile(target, content, {
          createParents: true, ...REVIEW_ACCESS, ...(now.sha === null ? { mustNotExist: true } : { expectedSha256: now.sha }),
        });
        this.current.set(key, { content, sha: r.sha256 ?? sha256(content) });
      }
    } catch (e) {
      if (e instanceof ReviewConflict) throw e;
      if (isConflict(e) || (content === null && isNotFound(e))) {
        await this.refresh(key).catch(() => undefined);
        throw new ReviewConflict(`${rel} changed on the remote host; review it again.`, false);
      }
      throw e;
    }
    // What the review wrote is the file's known state now, not a later edit.
    if (this.claudeVersions.has(key)) this.claudeVersions.set(key, this.current.get(key)!.sha);
    this.persist();
  }

  /** Drops versions of files no longer under review. */
  forget(keep: Iterable<string>) {
    const k = new Set(keep);
    for (const key of [...this.claudeVersions.keys()]) if (!k.has(key)) this.claudeVersions.delete(key);
    this.persist();
  }

  private persist() {
    void this.state.update(CLAUDE_VERSIONS_KEY, Object.fromEntries(this.claudeVersions));
  }
}
