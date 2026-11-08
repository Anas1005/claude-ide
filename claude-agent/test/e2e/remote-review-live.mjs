// Opt-in live check of change review in Remote-SSH mode (not part of `npm test`): the real Claude CLI edits, builds
// and runs a small C++ project through the production bundle, whose command bridge reaches the real remote workspace
// extension on this machine (a scratch workspace). Then the review is inspected and used: reject one change, accept
// the rest. Makes a small real model call with this machine's Claude sign-in.
// Usage: node test/e2e/remote-review-live.mjs [path to claude-agent-remote/out/extension.js]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { buildExtension, ROOT } from '../helpers/build.mjs';
import { loadExtension, makeContext, uri } from '../helpers/vscodeStub.mjs';

const require = createRequire(import.meta.url);
const REMOTE = process.argv[2] ?? path.join(ROOT, '..', 'claude-agent-remote', 'out', 'extension.js');
const CLI = path.join(ROOT, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude');

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-live-')));
fs.mkdirSync(path.join(ws, 'src'));
fs.writeFileSync(path.join(ws, 'src', 'main.cpp'), '#include <cstdio>\nint main() {\n  std::puts("v1");\n  return 0;\n}\n');
fs.writeFileSync(path.join(ws, 'notes.txt'), 'TODO: build\n');

const handlers = new Map();
const Module = require('module');
const load = Module._load;
Module._load = function (req, ...rest) {
  return req === 'vscode' ? { workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] }, window: { createOutputChannel: () => ({ appendLine() { }, clear() { }, show() { } }) },
    commands: { registerCommand: (id, fn) => { handlers.set(id, fn); return { dispose() { } }; } } } : load.call(this, req, ...rest);
};
const remote = require(REMOTE);
Module._load = load;
remote.activate({ subscriptions: [] });
const bridge = async (id, arg) => (id.startsWith('claudeIde.remote.') ? handlers.get(id)(arg) : undefined);

const bundle = await buildExtension();
const { ext, commands } = loadExtension(bundle, { remoteName: 'ssh-remote', remoteSsh: true, folder: uri('vscode-remote', 'ssh-remote+live', ws), bridge,
  settings: { claudePath: CLI, permissionMode: 'auto', defaultModel: 'claude-haiku-4-5-20251001' } });
const { chat, store } = ext.activate(makeContext(fs.mkdtempSync(path.join(os.tmpdir(), 'review-live-storage-'))));
Object.assign(chat, { view: { webview: { postMessage: async () => true } }, post: () => { } });
chat.active.mode = 'auto';
const prompts = [];
chat.ask = async (_s, title) => { prompts.push(title); return 'Allow'; };

await chat.send(chat.active, 'Using only the remote tools: 1) change src/main.cpp so it prints "v2" instead of "v1"; '
  + '2) create src/version.h containing exactly: #define VERSION 2; 3) build with: g++ -o app src/main.cpp and run ./app; '
  + '4) run: sed -i s/TODO/DONE/ notes.txt. Then reply with the program output only.', false);

const files = chat.remote.files;
const rel = k => files.display(k);
const pendingBefore = store.pending().map(p => `${rel(p.path)} ${p.status} +${p.add} -${p.del}`);
const mainKey = files.keyFor('src/main.cpp');
const hunks = store.hunks(mainKey).length;
await commands.get('claudeIde.rejectHunk')(files.uri(mainKey).fsPath, 0);   // as the inline widget does
const mainAfterReject = fs.readFileSync(path.join(ws, 'src/main.cpp'), 'utf8');
await commands.get('claudeIde.acceptAll')();
console.log(JSON.stringify({
  approvalPrompts: prompts,
  pendingAfterTurn: pendingBefore,
  mainCppHunks: hunks,
  mainCppAfterRejectingItsChange: mainAfterReject.includes('"v1"') ? 'v1 restored' : 'NOT restored',
  pendingAfterAcceptAll: store.pending().length,
  notesTxt: fs.readFileSync(path.join(ws, 'notes.txt'), 'utf8').trim(),
  versionH: fs.existsSync(path.join(ws, 'src/version.h')),
}, null, 1));
remote.deactivate();
fs.rmSync(ws, { recursive: true, force: true });
