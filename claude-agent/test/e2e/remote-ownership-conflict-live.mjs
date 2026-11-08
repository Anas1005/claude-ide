// Opt-in live check (not part of `npm test`): the real Claude CLI through the production bundle, against the real
// remote workspace extension on this machine (scratch workspace), Remote-SSH mode, auto mode, Haiku.
//  1) Process ownership: conversation B, told to stop and inspect conversation A's background command, is refused;
//     A's command keeps running; a caller without an owner (older client) cannot see or stop it either.
//  2) Review conflict (§5(B)): after Claude's edit, the file is changed outside the review; rejecting or accepting one
//     change is refused with the "Edited after Claude's change" dialog and writes nothing until confirmed.
// Usage: node test/e2e/remote-ownership-conflict-live.mjs [path to claude-agent-remote/out/extension.js]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { buildExtension, ROOT } from '../helpers/build.mjs';
import { loadExtension, makeContext, uri } from '../helpers/vscodeStub.mjs';

const require = createRequire(import.meta.url);
const REMOTE = process.argv[2] ?? path.join(ROOT, '..', 'claude-agent-remote', 'out', 'extension.js');
const CLI = path.join(ROOT, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude');

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'own-conflict-live-')));
fs.writeFileSync(path.join(ws, 'f.txt'), 'a\nb\nc\n');

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
const rpc = async (id, arg) => handlers.get(`claudeIde.remote.${id}`)(arg);

let answer;
const warnings = [];
const bundle = await buildExtension();
const { ext, commands } = loadExtension(bundle, { remoteName: 'ssh-remote', remoteSsh: true, folder: uri('vscode-remote', 'ssh-remote+live', ws), bridge,
  settings: { claudePath: CLI, permissionMode: 'auto', defaultModel: 'claude-haiku-4-5-20251001', resumeLastConversation: false },
  warningAnswer: m => { warnings.push(m); return answer; } });
const { chat, store } = ext.activate(makeContext(fs.mkdtempSync(path.join(os.tmpdir(), 'own-conflict-state-'))));
chat.view = { webview: { postMessage: async () => true } };
const said = s => s.presentation.events.filter(e => e.type === 'assistantText').map(e => e.text).join('\n');

// ---- 1) ownership ----
const A = chat.active;
await chat.send(A, 'Using only the remote tools: run the command "sleep 120" with run_in_background set to true. Reply with only the session_id.', false);
const aSession = [...A.remoteSession.started][0];
chat.newChat();
const B = chat.active;
await chat.send(B, `Using only the remote tools: call terminate_process with session_id "${aSession}", then call process_status with session_id "${aSession}". `
  + 'Do not start any command. Reply with the exact error code each call returned.', false);
const aStatus = await rpc('exec.status', { sessionId: aSession, owner: A.remoteSession.owner });
const unscopedStatus = await rpc('exec.status', { sessionId: aSession });
const unscopedTerminate = await rpc('exec.terminate', { sessionId: aSession, force: true });
const unscopedList = await rpc('exec.status', {});
const ownership = {
  aStartedOne: !!aSession, bReply: said(B).trim().slice(0, 200), bStartedNothing: B.remoteSession.started.size === 0,
  aStillRunningAfterB: aStatus.success && aStatus.data.state === 'running',
  unscopedStatus: unscopedStatus.success ? 'VISIBLE' : unscopedStatus.error.code,
  unscopedTerminate: unscopedTerminate.success ? 'TERMINATED' : unscopedTerminate.error.code,
  unscopedListSeesA: unscopedList.success && unscopedList.data.sessions.some(s => s.sessionId === aSession),
  aStillRunningAfterUnscoped: (await rpc('exec.status', { sessionId: aSession, owner: A.remoteSession.owner })).data?.state === 'running',
};
if (aSession) await rpc('exec.terminate', { sessionId: aSession, owner: A.remoteSession.owner, force: true });

// ---- 2) review conflict ----
chat.newChat();
const C = chat.active;
await chat.send(C, 'Using only the remote tools: read f.txt, then use apply_patch to replace its first line "a" with "A" (old_string "a\\nb", new_string "A\\nb"). Reply DONE.', false);
const files = chat.remote.files;
const key = files.keyFor('f.txt');
const afterClaude = fs.readFileSync(path.join(ws, 'f.txt'), 'utf8');
fs.writeFileSync(path.join(ws, 'f.txt'), afterClaude.replace(/^c$/m, 'C'));   // edited outside the review
await files.refresh(key);
const read = () => fs.readFileSync(path.join(ws, 'f.txt'), 'utf8');
const w0 = warnings.length;
answer = undefined;                                             // the person cancels the dialog
await commands.get('claudeIde.rejectHunk')(key, 0);
const afterRefusedReject = read();
await commands.get('claudeIde.acceptHunk')(key, 0);
const afterRefusedAccept = read();
const pendingAfterRefusals = store.pending().length;
answer = 'Reject Anyway';                                       // the person confirms
await commands.get('claudeIde.rejectHunk')(key, 0);
const conflict = {
  claudeEdited: afterClaude === 'A\nb\nc\n',
  dialogs: warnings.slice(w0),
  fileAfterRefusedReject: afterRefusedReject, fileAfterRefusedAccept: afterRefusedAccept, pendingAfterRefusals,
  fileAfterConfirmedReject: read(),
};

console.log(JSON.stringify({ ownership, conflict }, null, 1));
const pass = ownership.aStartedOne && /PROCESS_NOT_FOUND/.test(ownership.bReply) && ownership.bStartedNothing && ownership.aStillRunningAfterB
  && ownership.unscopedStatus === 'PROCESS_NOT_FOUND' && ownership.unscopedTerminate === 'PROCESS_NOT_FOUND' && !ownership.unscopedListSeesA && ownership.aStillRunningAfterUnscoped
  && conflict.claudeEdited && conflict.dialogs.length === 3 && conflict.dialogs.every(d => d === 'Edited after Claude\'s change')
  && conflict.fileAfterRefusedReject === 'A\nb\nC\n' && conflict.fileAfterRefusedAccept === 'A\nb\nC\n' && conflict.pendingAfterRefusals === 1
  && conflict.fileAfterConfirmedReject === 'a\nb\nC\n';
console.log(pass ? 'LIVE OWNERSHIP + CONFLICT: PASS' : 'LIVE OWNERSHIP + CONFLICT: FAIL');
ext.deactivate();
remote.deactivate();
fs.rmSync(ws, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
