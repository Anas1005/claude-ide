import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { applyHunk, computeHunks, diffStats, Hunk } from './hunks';

export type Status = 'A' | 'M' | 'D';
/** A file with pending changes; `conversations` = which conversations changed it (attribution only). */
export interface Pending { path: string; status: Status; add: number; del: number; conversations?: string[] }

export const log = vscode.window.createOutputChannel('Claude IDE', { log: true });
const read = (p: string): string | null => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
function write(p: string, content: string | null) {
  if (content === null) { fs.rmSync(p, { force: true }); return; }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/**
 * Where reviewed files live. Keys identify files; `localFiles` (local paths, Node fs) is the original behaviour, and
 * Remote-SSH mode supplies a backend whose keys are remote URIs and whose reads and writes go to the remote host.
 */
export interface ReviewFiles {
  /** Current content: null = does not exist, undefined = not known yet (remote content still loading). */
  read(key: string): string | null | undefined;
  /** Writes `content` (null deletes). A remote backend checks the version first and may throw ReviewConflict. */
  write(key: string, content: string | null, options?: ReviewWriteOptions): void | Promise<void>;
  /** Re-reads the current content before an operation that depends on it (remote); absent locally. */
  refresh?(key: string): Promise<void>;
  uri(key: string): vscode.Uri;
  /** Key of an editor/explorer URI, or undefined when this backend does not handle it. */
  keyOf(uri: vscode.Uri): string | undefined;
  /** Key from a command argument: a key, an editor file system path or a URI string. */
  keyOfArg(arg: string): string | undefined;
  /** Key of a `claude-baseline:` URI built from `uri(key)`. */
  keyOfBaseline(uri: vscode.Uri): string | undefined;
}
export interface ReviewWriteOptions {
  /** Rejecting one change: the rest of the file, including later edits, is kept. */
  hunk?: boolean;
  /** The person confirmed discarding edits made after Claude's change. */
  force?: boolean;
}
/** A review write was not done because the file is not what the review expected; nothing was changed. */
export class ReviewConflict extends Error {
  constructor(message: string, readonly laterEdits: boolean) { super(message); this.name = 'ReviewConflict'; }
}

/** Local files: the original implementation (synchronous fs on local paths). */
export const localFiles: ReviewFiles = {
  read: p => read(p),
  write: (p, content) => write(p, content),
  uri: p => vscode.Uri.file(p),
  keyOf: u => (u.scheme === 'file' ? u.fsPath : undefined),
  keyOfArg: a => a,
  keyOfBaseline: u => u.fsPath,
};

/** Conversation id used for review entries recorded before conversations had ids (and by callers that give none). */
export const LEGACY_CONVERSATION = 'legacy';

const hashOf = (content: string | null) => (content === null ? null : createHash('sha256').update(content, 'utf8').digest('hex'));

/**
 * Path locks shared by every conversation (multi-conversation spec §5): a tool's whole snapshot → write → record
 * section, and every review write, holds its paths. Paths are always taken in one sorted order, so operations on
 * several paths cannot deadlock. Holds of the same owner (one conversation, whose tool calls the CLI already orders)
 * do not wait for each other.
 */
export class PathLock {
  private readonly tails = new Map<string, Promise<void>>();
  /** Current holder of each path: its owner, how many holds it has, and what frees the path for the next waiter. */
  private readonly owners = new Map<string, { owner: string; count: number; free: () => void }>();
  private readonly held = new Map<string, { paths: string[] }>();

  async acquire(paths: string[], holderId: string, owner: string = holderId): Promise<void> {
    const sorted = [...new Set(paths)].sort();   // the one global order
    const taken: string[] = [];
    try {
      for (const p of sorted) {
        const o = this.owners.get(p);
        if (o && o.owner === owner) { o.count++; taken.push(p); continue; }   // re-entrant for the same conversation
        const prev = this.tails.get(p) ?? Promise.resolve();
        let free!: () => void;
        const next = new Promise<void>(res => (free = res));
        const tail = prev.then(() => next);
        this.tails.set(p, tail);
        await prev;
        this.owners.set(p, { owner, count: 1, free: () => { if (this.tails.get(p) === tail) this.tails.delete(p); free(); } });
        taken.push(p);
      }
    } catch (e) { this.releasePaths(taken); throw e; }
    this.held.set(holderId, { paths: taken });
  }

  /** One hold less on each path; a path is freed for the next waiter when its owner holds it no more. */
  private releasePaths(paths: string[]) {
    for (const p of paths) {
      const o = this.owners.get(p);
      if (o && --o.count <= 0) { this.owners.delete(p); o.free(); }
    }
  }

  /** Idempotent: safe to call twice or for an unknown holder. */
  release(holderId: string): void {
    const h = this.held.get(holderId);
    this.held.delete(holderId);
    if (h) this.releasePaths(h.paths);
  }

  isHeld(holderId: string) { return this.held.has(holderId); }

  /** Runs `body` holding `paths`. */
  async with<T>(paths: string[], body: () => Promise<T>): Promise<T> {
    const id = `review:${Math.random().toString(36).slice(2)}`;
    await this.acquire(paths, id);
    try { return await body(); } finally { this.release(id); }
  }
}

/** One conversation's pre-image of one file: the content before its first change in this review. */
interface Entry { pre: string | null; turn: string; seq: number }
type Checkpoint = { turn: string; files: Record<string, string | null>; conversationId?: string };
/** Per path, per conversation: hash of the content that conversation last left there (null = it deleted the file). */
type Known = Record<string, Record<string, { hash: string | null; at: number }>>;

/**
 * Baselines = original content of every file Claude touched, per conversation (null = did not exist). Disk holds
 * the proposal. The review shows each file against its earliest baseline; a conversation's own changes can be
 * rejected without touching earlier ones (§5).
 */
export class ReviewStore {
  private entries = new Map<string, Map<string, Entry>>();
  private checkpoints: Checkpoint[] = [];
  private known: Known;
  private seq = 0;
  /** Snapshotted but the tool has not written yet — must not be pruned as "unchanged". */
  private settling = new Set<string>();
  private emitter = new vscode.EventEmitter<void>();
  readonly onChange = this.emitter.event;
  readonly pathLock = new PathLock();
  private readonly entriesKey: string;
  private readonly knownKey: string;

  constructor(readonly state: vscode.Memento, readonly files: ReviewFiles = localFiles,
    private readonly keys = { baselines: 'claudeIde.baselines', checkpoints: 'claudeIde.checkpoints' }) {
    this.entriesKey = `${keys.baselines}.byConversation`;
    this.knownKey = `${keys.baselines}.known`;
    const saved = state.get<Record<string, Record<string, Entry>>>(this.entriesKey);
    if (saved) {
      for (const [p, byConv] of Object.entries(saved)) this.entries.set(p, new Map(Object.entries(byConv)));
      this.seq = Math.max(0, ...[...this.entries.values()].flatMap(m => [...m.values()].map(e => e.seq))) + 1;
    } else {
      // Reviews saved before conversations had ids: one baseline per file, owned by no particular conversation.
      for (const [p, pre] of Object.entries(state.get<Record<string, string | null>>(keys.baselines, {}))) {
        this.entries.set(p, new Map([[LEGACY_CONVERSATION, { pre, turn: '', seq: this.seq++ }]]));
      }
    }
    this.checkpoints = state.get<Checkpoint[]>(keys.checkpoints, []);
    this.known = state.get<Known>(this.knownKey, {});
    this.prune();
  }

  /** Every file the review or a checkpoint refers to. */
  tracked(): string[] {
    return [...new Set([...this.entries.keys(), ...this.checkpoints.flatMap(c => Object.keys(c.files))])];
  }

  /** The earliest baseline of `p` (what the review shows the file against). */
  baseline(p: string) { return this.earliest(p)?.pre; }
  has(p: string) { return this.entries.has(p); }
  /** Conversations with pending changes to `p`, earliest first. */
  conversationsOf(p: string): string[] {
    return [...(this.entries.get(p) ?? new Map<string, Entry>())].sort((a, b) => a[1].seq - b[1].seq).map(([c]) => c);
  }

  private earliest(p: string): Entry | undefined {
    let first: Entry | undefined;
    for (const e of this.entries.get(p)?.values() ?? []) if (!first || e.seq < first.seq) first = e;
    return first;
  }

  /**
   * Call before a tool of `conversationId` modifies `p` (holding `pathLock` for `p`). Records its pre-image once per
   * conversation per review set, and once per turn for "Restore to here".
   */
  snapshot(p: string, turn: string, content: string | null = this.files.read(p) ?? null, conversationId = LEGACY_CONVERSATION) {
    let byConv = this.entries.get(p);
    if (!byConv) this.entries.set(p, byConv = new Map());
    if (!byConv.has(conversationId)) {
      byConv.set(conversationId, { pre: content, turn, seq: this.seq++ });
      log.info(`baseline ${p} (${content === null ? 'new file' : content.length + ' chars'}) turn=${turn} conversation=${conversationId}`);
    }
    let cp = this.checkpoints.find(c => c.turn === turn);
    if (!cp) this.checkpoints.push(cp = { turn, files: {}, conversationId });
    if (!(p in cp.files)) cp.files[p] = content;
    this.settling.add(p);
    this.save();
  }

  /** After a tool of `conversationId` wrote `p`: what it left there is that conversation's last-known state of `p`. */
  recordWrite(p: string, conversationId = LEGACY_CONVERSATION, content: string | null | undefined = this.files.read(p)) {
    if (content === undefined) return;
    (this.known[p] ??= {})[conversationId] = { hash: hashOf(content), at: Date.now() };
    this.saveKnown();
  }

  /** Call once the tool that triggered `snapshot` has finished. */
  settle() { this.settling.clear(); this.refresh(); }

  pending(): Pending[] {
    const out: Pending[] = [];
    for (const p of this.entries.keys()) {
      const base = this.earliest(p)!.pre;
      const cur = this.files.read(p);
      if (cur === undefined || cur === base) continue;
      out.push({ path: p, status: base === null ? 'A' : cur === null ? 'D' : 'M', ...diffStats(base ?? '', cur ?? ''), conversations: this.conversationsOf(p) });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  hunks(p: string, cur = this.files.read(p)): Hunk[] {
    const base = this.baseline(p);
    return base === undefined ? [] : computeHunks(base ?? '', cur ?? '');
  }

  private label(p: string) { return vscode.workspace.asRelativePath(this.files.uri(p), false); }

  /**
   * Before a review write (holding the path lock): the file must be what its last writer left there — `conversationId`'s
   * own last-known state, or the most recent writer's when the operation is about the whole file. Otherwise someone
   * changed it since (an external edit), and nothing is written unless the person confirmed (`force`).
   */
  private async checkUnchanged(p: string, options: ReviewWriteOptions | undefined, conversationId?: string) {
    await this.files.refresh?.(p);
    const cur = this.files.read(p);
    if (cur === undefined) throw new ReviewConflict(`${this.label(p)}: its current content could not be read.`, false);
    if (options?.force) return;
    const byConv = this.known[p] ?? {};
    const known = conversationId !== undefined ? byConv[conversationId]
      : Object.values(byConv).sort((a, b) => b.at - a.at)[0];
    if (known && known.hash !== hashOf(cur)) throw new ReviewConflict(`${this.label(p)} was changed after Claude's edit.`, true);
  }

  /** Writes and reads back: if the file is not what was written, the outcome is unknown and is reported, not assumed. */
  private async writeVerified(p: string, content: string | null, options?: ReviewWriteOptions) {
    await this.files.write(p, content, options);
    await this.files.refresh?.(p);
    if (this.files.read(p) !== content) throw new ReviewConflict(`${this.label(p)} may have changed right after this write; check it manually.`, false);
    // What the review wrote is the file's known state now, for every conversation that knew it.
    const h = hashOf(content);
    for (const k of Object.values(this.known[p] ?? {})) k.hash = h;
    this.saveKnown();
  }

  /** Accepts `p` (every conversation's changes, or only `conversationId`'s). Never writes to disk. */
  accept(p: string, conversationId?: string) {
    log.info(`accept ${p}${conversationId ? ` conversation=${conversationId}` : ''}`);
    if (conversationId === undefined) this.entries.delete(p);
    else {
      this.entries.get(p)?.delete(conversationId);
      if (!this.entries.get(p)?.size) this.entries.delete(p);
    }
    this.save();
  }

  /**
   * Rejects `p`: restores its earliest baseline (all changes), or only `conversationId`'s own pre-image, which keeps
   * the changes made before it (and fails as a conflict if anyone changed the file after that conversation).
   */
  async reject(p: string, options?: ReviewWriteOptions, conversationId?: string) {
    log.info(`reject ${p}${conversationId ? ` conversation=${conversationId}` : ''}`);
    await this.pathLock.with([p], () => this.rejectLocked(p, options, conversationId));
  }
  private async rejectLocked(p: string, options?: ReviewWriteOptions, conversationId?: string) {
    const entry = conversationId === undefined ? this.earliest(p) : this.entries.get(p)?.get(conversationId);
    if (!entry) return;
    await this.checkUnchanged(p, options, conversationId);
    await this.writeVerified(p, entry.pre, options);
    if (conversationId === undefined) this.entries.delete(p);
    else {
      // Later conversations' changes went with it; earlier ones are kept.
      const byConv = this.entries.get(p)!;
      for (const [c, e] of byConv) if (e.seq >= entry.seq) byConv.delete(c);
      if (!byConv.size) this.entries.delete(p);
    }
    this.save();
  }

  acceptAll() { log.info('acceptAll'); this.entries.clear(); this.save(); }
  /** Rejects every file it can, holding all their paths; files in conflict are left pending and reported together. */
  async rejectAll(options?: ReviewWriteOptions) {
    const conflicts: ReviewConflict[] = [];
    const paths = [...this.entries.keys()];
    await this.pathLock.with(paths, async () => {
      for (const p of paths) {
        try { await this.rejectLocked(p, options); } catch (e) { if (e instanceof ReviewConflict) conflicts.push(e); else throw e; }
      }
    });
    if (conflicts.length) throw new ReviewConflict(conflicts.map(c => c.message).join('\n'), conflicts.some(c => c.laterEdits));
  }

  /** A hunk decision is about the file as a whole: its baselines become one, attributed to the earliest conversation. */
  private collapse(p: string, pre: string | null) {
    const first = this.earliest(p);
    const owner = this.conversationsOf(p)[0] ?? LEGACY_CONVERSATION;
    this.entries.set(p, new Map([[owner, { pre, turn: first?.turn ?? '', seq: first?.seq ?? this.seq++ }]]));
  }

  async acceptHunk(p: string, i: number, options?: ReviewWriteOptions) {
    await this.pathLock.with([p], async () => {
      const base = this.baseline(p);
      if (base === undefined) return;
      await this.checkUnchanged(p, options);   // §5(B): changed since its last writer → conflict unless confirmed (force)
      this.collapse(p, applyHunk(base ?? '', this.files.read(p) ?? '', i, 'accept'));
      this.save();
    });
  }
  async rejectHunk(p: string, i: number, options?: ReviewWriteOptions) {
    await this.pathLock.with([p], async () => {
      const base = this.baseline(p);
      if (base === undefined) return;
      // §5(B): changed since its last writer → conflict, nothing written, unless confirmed (force). Once confirmed,
      // only this change is reverted in the file as it is now; the write is verified.
      await this.checkUnchanged(p, options);
      const next = applyHunk(base ?? '', this.files.read(p) ?? '', i, 'reject');
      // Rejecting the only hunk of a new file (or restoring a deleted one) restores the exact original.
      await this.writeVerified(p, base === null && next === '' ? null : next, { ...options, hunk: true });
      this.collapse(p, base);
      this.save();
    });
  }

  /** Undo every change made in these turns (a message and the ones after it), holding all their paths. */
  async restoreTo(turns: string[], options?: ReviewWriteOptions) {
    const ids = new Set(turns);
    const restore = new Map<string, { content: string | null; conversationId?: string }>();
    for (const cp of this.checkpoints.filter(c => ids.has(c.turn)))   // oldest first: the earliest pre-image wins
      for (const [p, c] of Object.entries(cp.files)) if (!restore.has(p)) restore.set(p, { content: c, conversationId: cp.conversationId });
    const conflicts: ReviewConflict[] = [];
    let restored = 0;
    await this.pathLock.with([...restore.keys()], async () => {
      for (const [p, { content, conversationId }] of restore) {
        try {
          await this.checkUnchanged(p, options, conversationId);
          await this.writeVerified(p, content, options);
          // That conversation's pending changes to `p` from these turns are undone with it.
          const own = conversationId !== undefined ? this.entries.get(p)?.get(conversationId) : undefined;
          if (own && ids.has(own.turn)) this.entries.get(p)!.delete(conversationId!);
          if (this.entries.get(p)?.size === 0) this.entries.delete(p);
          restored++;
        } catch (e) { if (e instanceof ReviewConflict) conflicts.push(e); else throw e; }
      }
    });
    // Keep the checkpoints when something could not be restored, so a confirmed retry still has the originals.
    if (!conflicts.length) this.checkpoints = this.checkpoints.filter(c => !ids.has(c.turn));
    this.save();
    return { restored, conflicts };
  }

  /** Drops files whose disk content equals their earliest baseline. */
  prune() {
    let changed = false;
    for (const p of [...this.entries.keys()]) {
      if (!this.settling.has(p) && this.files.read(p) === this.earliest(p)!.pre) { log.info(`unchanged, dropped ${p}`); this.entries.delete(p); changed = true; }
    }
    return changed;
  }

  save() {
    this.prune();
    const byConv: Record<string, Record<string, Entry>> = {};
    const earliest: Record<string, string | null> = {};
    for (const [p, m] of this.entries) { byConv[p] = Object.fromEntries(m); earliest[p] = this.earliest(p)!.pre; }
    void this.state.update(this.entriesKey, byConv);
    void this.state.update(this.keys.baselines, earliest);   // the previous format, still written (rollback keeps working)
    void this.state.update(this.keys.checkpoints, this.checkpoints.slice(-50));
    this.saveKnown();
    this.emitter.fire();
  }
  /** Keeps last-known hashes only for files still under review or in a checkpoint. */
  private saveKnown() {
    const keep = new Set(this.tracked());
    for (const p of Object.keys(this.known)) if (!keep.has(p)) delete this.known[p];
    void this.state.update(this.knownKey, this.known);
  }
  refresh() { if (this.prune()) this.save(); else this.emitter.fire(); }
}

// ---------- Bash change detection ----------

const SKIP = new Set(['.git', 'node_modules', '.dart_tool', 'build', 'dist', 'out', '.next', 'Pods', '.gradle', 'target', '.venv', '__pycache__']);
// Note: caps keep snapshots cheap; files beyond them are not tracked for Bash edits. Use git plumbing if that matters.
const MAX_FILES = 20000, MAX_BYTES = 512 * 1024;
type SnapshotEntry = { mtimeMs: number; size: number; content: string | null };
const cache = new Map<string, SnapshotEntry>();

function walk(root: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= MAX_FILES) break;
    const p = path.join(root, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p, out); }
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export type WorkspaceSnapshot = Map<string, SnapshotEntry>;

export function snapshotWorkspace(root: string): WorkspaceSnapshot {
  const snap: WorkspaceSnapshot = new Map();
  for (const p of walk(root)) {
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch { continue; }
    let e = cache.get(p);
    if (!e || e.mtimeMs !== st.mtimeMs || e.size !== st.size) {
      e = { mtimeMs: st.mtimeMs, size: st.size, content: st.size <= MAX_BYTES ? read(p) : null };
      if (e.content?.includes('\0')) e.content = null; // binary
      cache.set(p, e);
    }
    snap.set(p, e);
  }
  return snap;
}

/** Records baselines (and last-known states) for every file a Bash command of `conversationId` created, changed or deleted. */
export function recordBashChanges(store: ReviewStore, root: string, before: WorkspaceSnapshot, turn: string, conversationId = LEGACY_CONVERSATION) {
  const after = snapshotWorkspace(root);
  const record = (p: string, pre: string | null, now: string | null | undefined) => { store.snapshot(p, turn, pre, conversationId); store.recordWrite(p, conversationId, now); };
  for (const [p, a] of after) {
    const b = before.get(p);
    // Content is null for binary or large files: their last-known state is then not recorded (undefined).
    if (!b) record(p, null, a.content ?? undefined);
    else if (b.content !== null && (b.mtimeMs !== a.mtimeMs || b.size !== a.size)) record(p, b.content, a.content ?? undefined);
  }
  for (const [p, b] of before) if (!after.has(p) && b.content !== null) record(p, b.content, null);
}

// ---------- Editor UI ----------

export const BASELINE_SCHEME = 'claude-baseline';
export const PROPOSED_SCHEME = 'claude-proposed';
export const proposed = new Map<string, string>();

const cfg = () => vscode.workspace.getConfiguration('claudeIde');

export function registerReviewUi(ctx: vscode.ExtensionContext, store: ReviewStore) {
  const files = store.files;
  const contentChanged = new vscode.EventEmitter<vscode.Uri>();
  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, {
    onDidChange: contentChanged.event,
    provideTextDocumentContent: u => store.baseline(files.keyOfBaseline(u) ?? '') ?? '',
  }));
  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, {
    provideTextDocumentContent: u => (u.query === 'empty' ? '' : proposed.get(u.fsPath) ?? ''),
  }));

  // Explorer "Claude Changes" tree
  const treeChanged = new vscode.EventEmitter<void>();
  const tree = vscode.window.createTreeView('claudeIde.changes', {
    treeDataProvider: {
      onDidChangeTreeData: treeChanged.event,
      getChildren: () => store.pending(),
      getTreeItem: (f: Pending) => {
        const item = new vscode.TreeItem(files.uri(f.path));
        const dir = path.dirname(vscode.workspace.asRelativePath(files === localFiles ? f.path : files.uri(f.path)));
        item.description = `${f.status}  +${f.add} −${f.del}${dir === '.' ? '' : '  ' + dir}`;
        item.contextValue = 'pending';
        item.command = { command: 'claudeIde.open', title: 'Open', arguments: [f.path] };
        return item;
      },
    },
  });

  // Badges on files in Explorer / tabs
  const decoChanged = new vscode.EventEmitter<vscode.Uri[]>();
  let lastPending: Pending[] = [];
  ctx.subscriptions.push(vscode.window.registerFileDecorationProvider({
    onDidChangeFileDecorations: decoChanged.event,
    provideFileDecoration: u => {
      const key = files.keyOf(u);
      const f = key === undefined ? undefined : lastPending.find(p => p.path === key);
      if (!f) return;
      const color = { A: 'gitDecoration.addedResourceForeground', M: 'gitDecoration.modifiedResourceForeground', D: 'gitDecoration.deletedResourceForeground' }[f.status];
      return { badge: f.status, tooltip: `Claude: pending (+${f.add} −${f.del})`, color: new vscode.ThemeColor(color), propagate: true };
    },
  }));

  // In-editor highlights
  const addedDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(40, 167, 69, 0.15)',
    borderColor: 'rgba(40, 167, 69, 0.8)', borderStyle: 'solid', borderWidth: '0 0 0 3px',
    overviewRulerColor: 'rgba(40, 167, 69, 0.8)', overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  const removedDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderColor: 'rgba(220, 53, 69, 0.8)', borderStyle: 'solid', borderWidth: '2px 0 0 0',
    overviewRulerColor: 'rgba(220, 53, 69, 0.8)', overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  // Claude IDE (the fork) renders removed lines, per-hunk buttons and the review bar natively.
  let native = false;
  let nativeSent = new Set<string>();
  void vscode.commands.getCommands(false).then(c => { native = c.includes('_claudeIde.setReview'); update(); });
  const pushNative = () => {
    if (!native) return;
    const inline = cfg().get('reviewStyle') !== 'sideBySide';
    const now = new Set<string>();
    lastPending.forEach((f, i) => {
      if (!inline || f.status === 'D') return;
      const doc = vscode.workspace.textDocuments.find(d => files.keyOf(d.uri) === f.path);
      now.add(f.path);
      void vscode.commands.executeCommand('_claudeIde.setReview', files.uri(f.path), store.hunks(f.path, doc?.getText()), i, lastPending.length);
    });
    for (const p of nativeSent) if (!now.has(p)) void vscode.commands.executeCommand('_claudeIde.setReview', files.uri(p), []);
    nativeSent = now;
  };

  const decorate = (ed: vscode.TextEditor) => {
    const key = files.keyOf(ed.document.uri);
    if (key === undefined || !store.has(key) || cfg().get('reviewStyle') === 'sideBySide') {
      ed.setDecorations(addedDeco, []); ed.setDecorations(removedDeco, []); return;
    }
    const hunks = store.hunks(key, ed.document.getText());
    const last = Math.max(0, ed.document.lineCount - 1);
    const added: vscode.DecorationOptions[] = [], removed: vscode.DecorationOptions[] = [];
    for (const h of hunks) {
      if (h.added) added.push({ range: new vscode.Range(h.start, 0, h.start + h.added - 1, 0) });
      if (!h.removed || native) continue;
      // Note: in stock VS Code, removed lines are shown as hover + ghost text; real view zones need the fork (see README).
      const line = Math.min(h.start, last);
      const first = h.removedText.split('\n')[0];
      removed.push({
        range: new vscode.Range(line, 0, line, 0),
        hoverMessage: new vscode.MarkdownString().appendMarkdown(`**Removed by Claude (${h.removed} line${h.removed > 1 ? 's' : ''})**`).appendCodeblock(h.removedText, ed.document.languageId),
        renderOptions: { after: { contentText: `  ⌫ −${h.removed}: ${first.trim().slice(0, 60)}${h.removed > 1 ? ' …' : ''}`, color: 'rgba(220, 53, 69, 0.9)', textDecoration: 'none; text-decoration: line-through; opacity: 0.8', fontStyle: 'italic' } },
      });
    }
    ed.setDecorations(addedDeco, added);
    ed.setDecorations(removedDeco, removed);
  };

  // Per-hunk Accept | Reject lenses
  const lensChanged = new vscode.EventEmitter<void>();
  ctx.subscriptions.push(vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: 'vscode-remote' }], {
    onDidChangeCodeLenses: lensChanged.event,
    provideCodeLenses: doc => {
      const key = files.keyOf(doc.uri);
      if (native || !cfg().get('showHunkCodeLens') || key === undefined || !store.has(key)) return [];
      return store.hunks(key, doc.getText()).flatMap((h, i) => {
        const r = new vscode.Range(Math.min(h.start, Math.max(0, doc.lineCount - 1)), 0, Math.min(h.start, Math.max(0, doc.lineCount - 1)), 0);
        return [
          new vscode.CodeLens(r, { title: '$(check) Accept ⌥⏎', command: 'claudeIde.acceptHunk', arguments: [key, i] }),
          new vscode.CodeLens(r, { title: '$(discard) Reject ⇧⌥⌫', command: 'claudeIde.rejectHunk', arguments: [key, i] }),
          new vscode.CodeLens(r, { title: `$(diff) +${h.added} −${h.removed}`, command: 'claudeIde.openDiff', arguments: [key] }),
        ];
      });
    },
  }));

  // Status bar: pending count + review bar for the active file (extension-API stand-in for the floating bar)
  const mk = (text: string, command: string, tooltip: string, prio: number) => {
    const s = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, prio);
    Object.assign(s, { text, command, tooltip });
    ctx.subscriptions.push(s);
    return s;
  };
  const count = mk('', 'claudeIde.review', 'Review Claude changes', 100);
  const bar = [
    mk('$(check) Accept File ⌘⏎', 'claudeIde.acceptFile', 'Accept all changes in this file', 99),
    mk('$(discard) Reject ⌘⌫', 'claudeIde.rejectFile', 'Reject all changes in this file', 98),
    mk('$(arrow-up)', 'claudeIde.prevHunk', 'Previous change (⌥[)', 97),
    mk('$(arrow-down)', 'claudeIde.nextHunk', 'Next change (⌥])', 96),
    mk('$(arrow-right) Next File', 'claudeIde.nextFile', 'Next changed file (⌥⌘↓)', 95),
  ];

  const activePath = () => {
    const u = vscode.window.activeTextEditor?.document.uri;
    return !u ? undefined : u.scheme === BASELINE_SCHEME ? files.keyOfBaseline(u) : files.keyOf(u);
  };

  const update = () => {
    const prev = lastPending;
    lastPending = store.pending();
    const n = lastPending.length;
    count.text = `$(sparkle) Claude: ${n} pending`;
    n ? count.show() : count.hide();
    const active = activePath();
    const activeHas = !!active && lastPending.some(p => p.path === active);
    for (const b of bar) activeHas && !native ? b.show() : b.hide();
    void vscode.commands.executeCommand('setContext', 'claudeIde.hasPending', n > 0);
    void vscode.commands.executeCommand('setContext', 'claudeIde.activeHasPending', activeHas);
    tree.badge = n ? { value: n, tooltip: `${n} pending` } : undefined;
    treeChanged.fire();
    lensChanged.fire();
    decoChanged.fire([...prev, ...lastPending].map(p => files.uri(p.path)));
    for (const p of lastPending) contentChanged.fire(files.uri(p.path).with({ scheme: BASELINE_SCHEME }));
    vscode.window.visibleTextEditors.forEach(decorate);
    pushNative();
  };

  let timer: NodeJS.Timeout | undefined;
  const soon = () => { clearTimeout(timer); timer = setTimeout(() => store.refresh(), 150); };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const onFs = (u: vscode.Uri) => {
    const key = files.keyOf(u);
    if (key === undefined || !store.has(key)) return;
    if (files.refresh) void files.refresh(key).then(soon, soon); else soon();   // remote: reload the changed file first
  };
  ctx.subscriptions.push(
    tree, watcher, store.onChange(update),
    watcher.onDidChange(onFs), watcher.onDidCreate(onFs), watcher.onDidDelete(onFs),
    vscode.window.onDidChangeActiveTextEditor(update),
    vscode.window.onDidChangeVisibleTextEditors(eds => eds.forEach(decorate)),
    vscode.workspace.onDidChangeTextDocument(e => { const key = files.keyOf(e.document.uri); if (key !== undefined && store.has(key)) soon(); }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('claudeIde')) update(); }),
  );

  // ---------- Commands ----------

  const target = (arg: unknown): string | undefined => {
    if (typeof arg === 'string') return files.keyOfArg(arg);
    const a = arg as { resourceUri?: vscode.Uri; path?: string; fsPath?: string } | undefined;
    if (a?.resourceUri) return files.keyOf(a.resourceUri);
    if (a instanceof vscode.Uri) return files.keyOf(a);
    const s = a?.fsPath ?? (typeof a?.path === 'string' ? a.path : undefined);
    return s !== undefined ? files.keyOfArg(s) : activePath();
  };
  const saveIfDirty = async (p: string) => {
    const doc = vscode.workspace.textDocuments.find(d => files.keyOf(d.uri) === p);
    if (doc?.isDirty) await doc.save();
  };
  /** Review writes that hit a conflict change nothing; say why, and offer to discard later edits when that is the cause. */
  const withConflicts = async (op: (options?: ReviewWriteOptions) => Promise<unknown>, action: 'Reject' | 'Accept' = 'Reject') => {
    try { await op(); } catch (e) {
      if (!(e instanceof ReviewConflict)) throw e;
      if (!e.laterEdits) { void vscode.window.showWarningMessage(`Claude review: nothing was changed. ${e.message}`); return; }
      const detail = action === 'Reject'
        ? `${e.message}\n\nRejecting writes Claude's original back over those later edits.`
        : `${e.message}\n\nAccepting this change keeps the file as it is now.`;
      const choice = await vscode.window.showWarningMessage('Edited after Claude\'s change', { modal: true, detail }, `${action} Anyway`);
      if (choice === `${action} Anyway`) await withConflicts(() => op({ force: true }), action);
    } finally { store.refresh(); }
  };

  const openDiff = (p: string) => vscode.commands.executeCommand('vscode.diff',
    files.uri(p).with({ scheme: BASELINE_SCHEME }), files.uri(p), `${path.basename(files.uri(p).path)} (original ↔ Claude)`);

  const open = async (p: string) => {
    const f = store.pending().find(x => x.path === p);
    if (!f) return vscode.window.showTextDocument(files.uri(p));
    if (f.status === 'D' || cfg().get('reviewStyle') === 'sideBySide') return openDiff(p);
    const ed = await vscode.window.showTextDocument(files.uri(p));
    const h = store.hunks(p, ed.document.getText())[0];
    if (h) reveal(ed, h.start);
  };
  const reveal = (ed: vscode.TextEditor, line: number) => {
    const pos = new vscode.Position(Math.min(line, ed.document.lineCount - 1), 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  };
  const hunkAtCursor = (p: string) => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return 0;
    const line = ed.selection.active.line;
    const hs = store.hunks(p, ed.document.getText());
    const i = hs.findIndex(h => line >= h.start && line < h.start + Math.max(1, h.added));
    return i >= 0 ? i : Math.max(0, hs.findIndex(h => h.start >= line));
  };
  const stepHunk = (dir: 1 | -1) => {
    const ed = vscode.window.activeTextEditor, p = activePath();
    if (!ed || !p) return;
    const hs = store.hunks(p, ed.document.getText());
    if (!hs.length) return;
    const line = ed.selection.active.line;
    const next = dir > 0 ? hs.find(h => h.start > line) ?? hs[0] : [...hs].reverse().find(h => h.start < line) ?? hs[hs.length - 1];
    reveal(ed, next.start);
  };
  const stepFile = (dir: 1 | -1) => {
    const list = store.pending();
    if (!list.length) return;
    const i = list.findIndex(f => f.path === activePath());
    return open(list[(i + dir + list.length) % list.length].path);
  };
  const afterFileOp = (p: string) => {
    // Keep momentum: jump to the next pending file, like Cursor.
    const next = store.pending()[0];
    if (next && activePath() === p) void open(next.path);
  };

  const reg = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('claudeIde.open', (p: string) => { const key = files.keyOfArg(p); return key === undefined ? undefined : open(key); });
  reg('claudeIde.openDiff', (a: unknown) => { const p = target(a); if (p) return openDiff(p); });
  reg('claudeIde.acceptFile', async (a: unknown) => { const p = target(a); if (!p) return; await saveIfDirty(p); store.accept(p); afterFileOp(p); });
  reg('claudeIde.rejectFile', async (a: unknown) => { const p = target(a); if (!p) return; await saveIfDirty(p); await withConflicts(o => store.reject(p, o)); afterFileOp(p); });
  reg('claudeIde.acceptAll', () => store.acceptAll());
  reg('claudeIde.rejectAll', async () => {
    for (const f of store.pending()) await saveIfDirty(f.path);
    await withConflicts(o => store.rejectAll(o));
  });
  reg('claudeIde.acceptHunk', async (arg?: string, i?: number) => {
    const p = arg === undefined ? activePath() : files.keyOfArg(arg); if (!p) return;
    await saveIfDirty(p); const n = i ?? hunkAtCursor(p); await withConflicts(o => store.acceptHunk(p, n, o), 'Accept');
  });
  reg('claudeIde.rejectHunk', async (arg?: string, i?: number) => {
    const p = arg === undefined ? activePath() : files.keyOfArg(arg); if (!p) return;
    await saveIfDirty(p); const n = i ?? hunkAtCursor(p); await withConflicts(o => store.rejectHunk(p, n, o));
  });
  reg('claudeIde.nextHunk', () => stepHunk(1));
  reg('claudeIde.prevHunk', () => stepHunk(-1));
  reg('claudeIde.nextFile', () => stepFile(1));
  reg('claudeIde.prevFile', () => stepFile(-1));
  reg('claudeIde.review', async () => {
    const first = store.pending()[0];
    if (first) await open(first.path);
    await vscode.commands.executeCommand('claudeIde.changes.focus');
  });

  update();
  return { open, openDiff };
}
