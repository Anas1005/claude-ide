// A stand-in `vscode` module for loading the production bundle of the extension outside the editor.
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Module = require('module');

/** Callable, constructible, endlessly nested stand-in for VS Code API surface the test does not care about. */
export function anything() {
  return new Proxy(function () { }, {
    get: (_, k) => (k === 'then' ? undefined : k === Symbol.iterator ? [][Symbol.iterator] : anything()),
    apply: () => anything(),
    construct: () => anything(),
  });
}
/** Enough of vscode.Uri for the extension: immutable, `with`, string round trip. fsPath is the path (POSIX host). */
export class Uri {
  constructor(scheme, authority, p, query = '') { Object.assign(this, { scheme, authority, path: p, query }); Object.freeze(this); }
  get fsPath() { return this.path; }
  with(c) { return new Uri(c.scheme ?? this.scheme, c.authority ?? this.authority, c.path ?? this.path, c.query ?? this.query); }
  toString() { return `${this.scheme}://${this.authority}${encodeURI(this.path)}${this.query ? '?' + this.query : ''}`; }
  static file(p) { return new Uri('file', '', p); }
  static parse(s) { const u = new URL(s); return new Uri(u.protocol.slice(0, -1), u.host, decodeURI(u.pathname), u.search.slice(1)); }
  static joinPath(b, ...parts) { return b.with({ path: path.posix.join(b.path, ...parts) }); }
}
export const uri = (scheme, authority, p) => new Uri(scheme, authority, p);

/** Minimal vscode.EventEmitter, so store changes reach their listeners. */
class EventEmitter {
  listeners = [];
  event = listener => { this.listeners.push(listener); return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } }; };
  fire(value) { for (const l of [...this.listeners]) l(value); }
  dispose() { this.listeners = []; }
}

/** Loads a fresh copy of the bundle against a stub `vscode` for one window. */
export function loadExtension(bundle, { remoteName, remoteSsh, folder, hostInfo, bridge, settings: extraSettings = {}, warningAnswer = () => undefined }) {
  const commands = new Map();
  const settings = { defaultModel: 'claude-sonnet-5', permissionMode: 'ask', claudePath: process.execPath, authMode: 'claudeCode', blockUntilReviewed: false, 'experimental.remoteSsh': remoteSsh, ...extraSettings };
  const bridgeCalls = [];
  const vscode = new Proxy({
    env: { remoteName },
    workspace: new Proxy({
      workspaceFolders: folder ? [{ uri: folder, name: path.basename(folder.path) }] : [],
      textDocuments: [],
      isTrusted: true,
      asRelativePath: u => { const p = typeof u === 'string' ? u : u.path; const root = folder?.path; return root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p; },
      getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d), update: async () => { } }),
    }, { get: (t, k) => (k in t ? t[k] : anything()) }),
    window: new Proxy({
      activeTextEditor: undefined, visibleTextEditors: [], createOutputChannel: () => ({ info() { }, warn() { }, error() { }, appendLine() { }, show() { }, dispose() { } }),
      showWarningMessage: async (message, ...rest) => warningAnswer(message, rest),
      showInformationMessage: async () => undefined,
    },
      { get: (t, k) => (k in t ? t[k] : anything()) }),
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() { } }; },
      getCommands: async () => [],
      executeCommand: async (id, arg) => { bridgeCalls.push(id); return bridge ? bridge(id, arg) : id === 'claudeIde.remote.getInfo' ? hostInfo : undefined; },
    },
    Uri,
    EventEmitter,
    languages: anything(),
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    // The bundle's ESM interop copies only own keys: every class/enum the source names must exist here.
    ...Object.fromEntries(['CodeLens', 'MarkdownString', 'OverviewRulerLane', 'Position', 'Range', 'RelativePattern', 'Selection',
      'StatusBarAlignment', 'TextEditorRevealType', 'ThemeColor', 'TreeItem'].map(k => [k, anything()])),
  }, { get: (t, k) => (k in t ? t[k] : anything()) });
  const load = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : load.call(this, req, ...rest); };
  try {
    delete require.cache[bundle];
    return { ext: require(bundle), bridgeCalls, commands, vscode };
  } finally { Module._load = load; }
}

export function makeContext(storage, state = new Map([['claudeIde.revealed', true]])) {
  return {
    subscriptions: [], extensionUri: anything(), globalStorageUri: { fsPath: storage }, secrets: { get: async () => undefined },
    extension: { packageJSON: JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) },
    workspaceState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: async (k, v) => { state.set(k, v); }, keys: () => [...state.keys()] },
  };
}

