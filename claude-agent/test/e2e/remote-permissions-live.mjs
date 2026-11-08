// Opt-in live check of the approval modes in Remote-SSH mode (not part of `npm test`).
// Runs the real Claude CLI through the production bundle of this extension, with its command bridge wired to the
// real remote workspace extension on this machine, once per mode, and records prompts and what actually happened.
// Makes small real model calls with this machine's Claude sign-in.
// Usage: node test/e2e/remote-permissions-live.mjs [path to claude-agent-remote/out/extension.js]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { buildExtension, ROOT } from '../helpers/build.mjs';
import { loadExtension, makeContext, uri } from '../helpers/vscodeStub.mjs';

const require = createRequire(import.meta.url);
const REMOTE = process.argv[2] ?? path.join(ROOT, '..', 'claude-agent-remote', 'out', 'extension.js');
const CLI = path.join(ROOT, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude');

// The real remote extension, against a workspace folder that changes per mode.
const folder = { uri: { fsPath: '' } };
const handlers = new Map();
const Module = require('module');
const load = Module._load;
Module._load = function (req, ...rest) {
  return req === 'vscode' ? { workspace: { workspaceFolders: [folder] }, window: { createOutputChannel: () => ({ appendLine() { }, clear() { }, show() { } }) },
    commands: { registerCommand: (id, fn) => { handlers.set(id, fn); return { dispose() { } }; } } } : load.call(this, req, ...rest);
};
const remote = require(REMOTE);
Module._load = load;
remote.activate({ subscriptions: [] });
const bridge = async (id, arg) => {
  if (!id.startsWith('claudeIde.remote.')) return undefined;   // editor commands (setContext, vscode.diff, …)
  const h = handlers.get(id);
  if (!h) throw new Error(`command '${id}' not found`);
  return h(arg);
};

const bundle = await buildExtension();
const PROMPT = 'Do exactly these three steps with the remote tools, one call each, and continue even if a step is refused: '
  + '1) mcp__remote__write_file: create hello.txt containing "hi". '
  + '2) mcp__remote__execute_command: run "echo built > build.log". '
  + '3) mcp__remote__execute_command: run "sudo -n true". Then stop and report which steps happened.';

const results = {};
for (const mode of ['auto', 'ask', 'askBeforeEach', 'plan']) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `perm-${mode}-`)));
  folder.uri.fsPath = ws;
  const { ext } = loadExtension(bundle, { remoteName: 'ssh-remote', remoteSsh: true, folder: uri('vscode-remote', 'ssh-remote+live', ws), bridge,
    settings: { claudePath: CLI, permissionMode: mode, defaultModel: 'claude-haiku-4-5-20251001' } });
  const { chat } = ext.activate(makeContext(fs.mkdtempSync(path.join(os.tmpdir(), 'perm-storage-'))));
  const prompts = [];
  chat.view = { webview: { postMessage: async () => true } };
  chat.post = () => { };
  chat.active.mode = mode;
  // Approve everything except the privileged command, so we see exactly which calls were asked.
  chat.ask = async (_s, title, detail) => { prompts.push(`${title}: ${detail.split('\n')[0]}`); return detail.includes('sudo') ? 'Deny' : 'Allow'; };
  await chat.send(chat.active, PROMPT, false);
  results[mode] = {
    prompts,
    helloWritten: fs.existsSync(path.join(ws, 'hello.txt')),
    commandRan: fs.existsSync(path.join(ws, 'build.log')),
  };
  fs.rmSync(ws, { recursive: true, force: true });
}
remote.deactivate();
console.log(JSON.stringify(results, null, 1));
