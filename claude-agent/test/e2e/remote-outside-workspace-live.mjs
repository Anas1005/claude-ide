// Opt-in live check (not part of `npm test`) of workspace-independent access (API v5): the real Claude CLI through the
// production bundle, with its command bridge wired to the real remote workspace extension on this machine (Remote-SSH
// mode, Haiku). The window's workspace is one scratch folder; a second scratch project lives outside it.
//  1) auto: read, edit, create, move, copy (command), delete and search in the other project, with no approval prompt;
//     every change is recorded for review under its absolute path.
//  2) ask: the normal workflow (edits apply, a delete is asked); plan: nothing is written.
//  3) a credential location (~/.ssh, a file that does not exist) is asked even in auto mode; it is denied here, so
//     nothing is read. The real ~/.ssh is never read or changed.
// Usage: node test/e2e/remote-outside-workspace-live.mjs [path to claude-agent-remote/out/extension.js]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import { buildExtension, ROOT } from '../helpers/build.mjs';
import { loadExtension, makeContext, uri } from '../helpers/vscodeStub.mjs';

const require = createRequire(import.meta.url);
const REMOTE = process.argv[2] ?? path.join(ROOT, '..', 'claude-agent-remote', 'out', 'extension.js');
const CLI = path.join(ROOT, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude');

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'outside-live-ws-')));
const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'outside-live-other-project-')));
fs.writeFileSync(path.join(ws, 'README.md'), 'workspace\n');
fs.writeFileSync(path.join(proj, 'a.txt'), 'alpha\n');
fs.writeFileSync(path.join(proj, 'old.txt'), 'old\n');
const P = rel => path.join(proj, rel);
const exists = rel => fs.existsSync(P(rel));
const read = rel => (exists(rel) ? fs.readFileSync(P(rel), 'utf8') : null);

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
const { ext } = loadExtension(bundle, { remoteName: 'ssh-remote', remoteSsh: true, folder: uri('vscode-remote', 'ssh-remote+live', ws), bridge,
  settings: { claudePath: CLI, permissionMode: 'auto', defaultModel: 'claude-haiku-4-5-20251001', resumeLastConversation: false } });
const { chat, store } = ext.activate(makeContext(fs.mkdtempSync(path.join(os.tmpdir(), 'outside-live-state-'))));
chat.view = { webview: { postMessage: async () => true } };
let prompts = [];
let answer = () => 'Allow';
chat.ask = async (_s, title, detail) => { prompts.push(`${title} | ${detail.replace(/\n+/g, ' ').slice(0, 160)}`); return answer(title, detail); };
const turn = async (mode, text) => {
  chat.newChat();
  chat.active.mode = mode;
  prompts = [];
  await chat.send(chat.active, text, false);
  return prompts;
};
const pending = () => Object.fromEntries(store.pending().map(p => [chat.remote.files.display(p.path), p.status]));

// ---- 1) auto mode: another project, no approval ----
const autoPrompts = await turn('auto', 'Use only the mcp__remote__* tools, one call per step, in this order, and do not ask questions: '
  + `1) read_file ${P('a.txt')}. 2) apply_patch on ${P('a.txt')}: replace "alpha" with "beta". 3) write_file ${P('new.txt')} with content "new". `
  + `4) file_operation move ${P('new.txt')} to ${P('moved/new.txt')} with create_parents true. 5) execute_command "cp a.txt copy.txt" with cwd ${proj}. `
  + `6) file_operation delete_file ${P('old.txt')}. 7) search_content for "beta" with path ${proj}. Then reply DONE.`);
const auto = {
  prompts: autoPrompts,
  files: { 'a.txt': read('a.txt'), 'moved/new.txt': read('moved/new.txt'), 'copy.txt': read('copy.txt'), 'old.txt': read('old.txt'), 'new.txt': read('new.txt') },
  review: pending(),
};

// ---- 2) ask: normal workflow; plan: nothing written ----
const askPrompts = await turn('ask', `Use only the mcp__remote__* tools, one call each: 1) write_file ${P('ask.txt')} with content "ask". `
  + `2) file_operation delete_file ${P('copy.txt')}. Then reply DONE.`);
const ask = { prompts: askPrompts, askWritten: read('ask.txt'), copyDeleted: !exists('copy.txt') };
const planPrompts = await turn('plan', `Use only the mcp__remote__* tools: call write_file ${P('plan.txt')} with content "plan" right now, then reply DONE.`);
const plan = { prompts: planPrompts, planWritten: exists('plan.txt') };

// ---- 3) a credential location is asked even in auto mode (denied here: nothing is read) ----
const probe = `~/.ssh/claude-live-test-${randomUUID()}`;
answer = () => 'Deny';
const credPrompts = await turn('auto', `Use only the mcp__remote__* tools: call read_file with file_path "${probe}" exactly once, then reply with the result.`);
const credential = { prompts: credPrompts };

console.log(JSON.stringify({ workspace: ws, otherProject: proj, auto, ask, plan, credential }, null, 1));
const reviewed = auto.review;
const pass = auto.prompts.length === 0
  && auto.files['a.txt'] === 'beta\n' && auto.files['moved/new.txt'] === 'new' && auto.files['copy.txt'] === 'beta\n' && auto.files['old.txt'] === null && auto.files['new.txt'] === null
  && reviewed[P('a.txt')] === 'M' && reviewed[P('moved/new.txt')] === 'A' && reviewed[P('copy.txt')] === 'A' && reviewed[P('old.txt')] === 'D'
  && ask.askWritten === 'ask' && ask.copyDeleted && ask.prompts.length === 1 && /file_operation/.test(ask.prompts[0])
  && !plan.planWritten && plan.prompts.length === 0
  && credential.prompts.length >= 1 && credential.prompts.every(p => /credential location/.test(p));
console.log(pass ? 'LIVE OUTSIDE-WORKSPACE ACCESS: PASS' : 'LIVE OUTSIDE-WORKSPACE ACCESS: FAIL');
ext.deactivate();
remote.deactivate();
for (const d of [ws, proj]) fs.rmSync(d, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
