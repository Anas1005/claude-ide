// Opt-in live check (not part of `npm test`) of the 0.6.0 additions: the real Claude CLI through the production bundle,
// with its command bridge wired to the real remote workspace extension on this machine (Remote-SSH mode, Haiku).
// Scratch workspace plus a second scratch project outside it.
//  1) CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md of the remote workspace reach Claude.
//  2) read_file shows a PNG image to Claude (MCP image content, base64 read over the bridge).
//  3) search_files with a glob pattern in the other project.
//  4) editor context: the active remote editor's selection (a file outside the workspace) is sent to Claude.
//  5) attachments: a file outside the workspace, dropped on the panel, is read by Claude.
//  6) sub-agents: a remote-general sub-agent edits a file and starts a background command: the change is in this
//     conversation's review, the command is owned by this conversation (another one cannot see it); a sub-agent's
//     credential access is asked (denied here); Stop cancels a sub-agent's foreground command on the remote host.
// Usage: node test/e2e/remote-parity-live.mjs [path to claude-agent-remote/out/extension.js]
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import { buildExtension, ROOT } from '../helpers/build.mjs';
import { loadExtension, makeContext, uri } from '../helpers/vscodeStub.mjs';

const require = createRequire(import.meta.url);
const REMOTE = process.argv[2] ?? path.join(ROOT, '..', 'claude-agent-remote', 'out', 'extension.js');
const CLI = path.join(ROOT, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude');

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'parity-live-ws-')));
const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'parity-live-other-')));
const P = rel => path.join(proj, rel);
const word = () => randomUUID().slice(0, 8).toUpperCase();
const W = { md: `ALPHA${word()}`, dot: `BRAVO${word()}`, local: `CHARLIE${word()}`, sel: `ident_${word().toLowerCase()}`, att: `ATTACH${word()}` };
fs.writeFileSync(path.join(ws, 'CLAUDE.md'), `# Project rules\nThe first project codeword is ${W.md}.\n`);
fs.mkdirSync(path.join(ws, '.claude'));
fs.writeFileSync(path.join(ws, '.claude/CLAUDE.md'), `The second project codeword is ${W.dot}.\n`);
fs.writeFileSync(path.join(ws, 'CLAUDE.local.md'), `The third project codeword is ${W.local}.\n`);
for (const f of ['src/main.rs', 'src/lib/util.rs', 'build.rs', 'README.md', 'src/notes.txt']) { fs.mkdirSync(path.dirname(P(f)), { recursive: true }); fs.writeFileSync(P(f), '// x\n'); }
fs.writeFileSync(P('code.c'), `int a;\nint ${W.sel} = 42;\nint b;\n`);
fs.writeFileSync(P('attached.txt'), `${W.att}\n`);

/** A solid-colour PNG (no image libraries). */
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
fs.writeFileSync(P('swatch.png'), png(64, 64, [220, 20, 20]));

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
const requests = [];
const bridge = async (id, arg) => { if (id.startsWith('claudeIde.remote.')) { requests.push([id.slice(17), arg]); return handlers.get(id)(arg); } };
const rpc = (id, arg) => handlers.get(`claudeIde.remote.${id}`)(arg);

const bundle = await buildExtension();
const folder = uri('vscode-remote', 'ssh-remote+live', ws);
const { ext, vscode, commands } = loadExtension(bundle, { remoteName: 'ssh-remote', remoteSsh: true, folder, bridge,
  settings: { claudePath: CLI, permissionMode: 'auto', defaultModel: 'claude-haiku-4-5-20251001', resumeLastConversation: false } });
const { chat, store } = ext.activate(makeContext(fs.mkdtempSync(path.join(os.tmpdir(), 'parity-live-state-'))));
const panel = [];
chat.view = { webview: { postMessage: async m => { panel.push(m); return true; } } };
let prompts = [];
let answer = () => 'Allow';
chat.ask = async (_s, title, detail) => { prompts.push(`${title} | ${String(detail).replace(/\n+/g, ' ').slice(0, 160)}`); return answer(title, detail); };
const said = s => s.presentation.events.filter(e => e.type === 'assistantText').map(e => e.text).join('\n');
const asyncLaunched = s => s.presentation.events.some(e => e.type === 'toolResult' && /Async agent launched/i.test(String(e.output ?? '')));
const tools = s => s.presentation.events.filter(e => e.type === 'toolUse' || e.type === 'tool').map(e => e.name ?? e.tool).filter(Boolean);
const fresh = (mode = 'auto') => { chat.newChat(); chat.active.mode = mode; prompts = []; return chat.active; };

// ---- 1) project instructions ----
let s = fresh();
await chat.send(s, 'What are the first, second and third project codewords? Do not use any tools. Reply with only the three codewords separated by spaces.', false);
const instructions = { reply: said(s).trim().slice(0, 200) };
instructions.ok = [W.md, W.dot, W.local].every(w => instructions.reply.includes(w));

// ---- 2) image ----
s = fresh();
let r0 = requests.length;
await chat.send(s, `Use mcp__remote__read_file on ${P('swatch.png')} and tell me its colour. Reply with one lowercase colour word only.`, false);
const image = { reply: said(s).trim().slice(0, 80), base64Read: requests.slice(r0).some(([id, a]) => id === 'fs.readFile' && a?.encoding === 'base64' && a.path === P('swatch.png')) };
image.ok = image.base64Read && /red/i.test(image.reply);

// ---- 3) glob ----
s = fresh();
r0 = requests.length;
await chat.send(s, `Use mcp__remote__search_files with path ${proj} and pattern "**/*.rs" (no query). Reply with only the matching file names, comma-separated.`, false);
const glob = { reply: said(s).trim().slice(0, 200), patternSent: requests.slice(r0).some(([id, a]) => id === 'fs.searchFiles' && a?.pattern === '**/*.rs') };
glob.ok = glob.patternSent && ['main.rs', 'util.rs', 'build.rs'].every(n => glob.reply.includes(n)) && !/notes\.txt|README/.test(glob.reply);

// ---- 4) editor context: selection in a file outside the workspace ----
s = fresh();
const codeDoc = { uri: uri('vscode-remote', 'ssh-remote+live', P('code.c')), getText: () => `int ${W.sel} = 42;` };
vscode.window.activeTextEditor = { document: codeDoc, selection: { isEmpty: false, start: { line: 1 }, end: { line: 1 } } };
chat.postActiveFile();
await chat.send(s, 'Which variable name is declared in the selected code, and which file is it in? Do not use any tools. Reply as: <name> <absolute file path>', false);   // no "current file" toggle: the selection is sent anyway
vscode.window.activeTextEditor = undefined;
const editor = { reply: said(s).trim().slice(0, 200), activeFileShown: panel.filter(m => m.type === 'activeFile').at(-1)?.name };
editor.ok = editor.reply.includes(W.sel) && editor.reply.includes(P('code.c')) && editor.activeFileShown === 'code.c';

// ---- 5) attachment outside the workspace ----
s = fresh();
const before = panel.length;
await commands.get('claudeIde.dropResources')([uri('vscode-remote', 'ssh-remote+live', P('attached.txt')).toString(), 'vscode-remote://ssh-remote+elsewhere/etc/hostname']);
const refs = panel.slice(before).filter(m => m.type === 'addRef').map(m => m.ref.path);
await chat.send(s, 'Read the attached file with the remote tools and reply with its content only.', false, [], refs);
const attachment = { refs, reply: said(s).trim().slice(0, 80), note: panel.slice(before).find(m => m.type === 'note')?.text };
attachment.ok = refs.length === 1 && refs[0] === P('attached.txt') && attachment.reply.includes(W.att) && /1 item/.test(attachment.note ?? '');

// ---- 6) sub-agents ----
s = fresh();
await chat.send(s, 'Use the Agent tool with subagent_type "remote-general", run_in_background true and mode "bypassPermissions", and this task for it: '
  + `"Using only mcp__remote__ tools: 1) call write_file for ${P('sub.txt')} with content SUB. 2) call execute_command with command \\"sleep 120\\" and run_in_background true. Report the session_id." `
  + 'Do not do these steps yourself. When the sub-agent finishes, reply with only the session_id it reported.', false);
const A = s;
const started = [...A.remoteSession.started];
chat.newChat();
const B = chat.active;
const visibleToB = started.length ? await rpc('exec.status', { sessionId: started[0], owner: B.remoteSession.owner }) : undefined;
const aStatus = started.length ? await rpc('exec.status', { sessionId: started[0], owner: A.remoteSession.owner }) : undefined;
const pendingSub = store.pending().find(p => chat.remote.files.display(p.path) === P('sub.txt'));
const subagent = {
  agentUsed: tools(A).some(t => t === 'Agent' || t === 'Task'), reply: said(A).trim().slice(0, 120), sub: fs.existsSync(P('sub.txt')) ? fs.readFileSync(P('sub.txt'), 'utf8') : null,
  inReview: pendingSub?.status, ownedByA: started.length === 1 && aStatus?.success && aStatus.data.state === 'running',
  hiddenFromB: visibleToB ? (visibleToB.success ? 'VISIBLE' : visibleToB.error.code) : 'n/a', prompts: [...prompts], foreground: !asyncLaunched(A),
};
if (started[0]) await rpc('exec.terminate', { sessionId: started[0], owner: A.remoteSession.owner, force: true });
subagent.ok = subagent.foreground && subagent.agentUsed && subagent.sub === 'SUB' && subagent.inReview === 'A' && subagent.ownedByA && subagent.hiddenFromB === 'PROCESS_NOT_FOUND' && subagent.prompts.length === 0;

// Security: a sub-agent's credential access is asked even in auto mode (denied), and local tools stay unavailable.
s = fresh();
answer = () => 'Deny';
const probe = `~/.ssh/claude-live-test-${randomUUID()}`;
await chat.send(s, 'Use the Agent tool with subagent_type "remote-general" and this task for it: '
  + `"Call mcp__remote__read_file with file_path ${probe} exactly once, then try the Bash tool to run: cat ${probe}. Report what happened." Then reply with a one-line summary.`, false);
const security = { calls: s.presentation.events.filter(e => e.type === 'tool' || e.type === 'toolResult').map(e => e.type === 'tool' ? `${e.sub ? 'sub:' : ''}${e.name} ${e.summary ?? ''}` : `→ ${String(e.output ?? '').slice(0, 140)}`), reply: said(s).slice(0, 300), prompts: [...prompts], agentUsed: tools(s).some(t => t === 'Agent' || t === 'Task'), probeExists: fs.existsSync(probe.replace('~', os.homedir())) };
security.foreground = !asyncLaunched(s);
security.ok = security.foreground && security.agentUsed && security.prompts.length >= 1 && security.prompts.every(p => /credential (location|files)/.test(p)) && !security.probeExists;
answer = () => 'Allow';

// Cancellation: Stop while a sub-agent's foreground command runs on the remote host.
s = fresh();
const r1 = requests.length;
const run = chat.send(s, 'Use the Agent tool with subagent_type "remote-general" and this task for it: '
  + '"Call mcp__remote__execute_command with command \\"sleep 90\\" (foreground, timeout_ms 120000) and report its exit code." Then reply DONE.', false);
let execStart;
for (let i = 0; i < 600 && !execStart; i++) { await new Promise(r => setTimeout(r, 200)); execStart = requests.slice(r1).find(([id]) => id === 'exec.start'); }
await new Promise(r => setTimeout(r, 1500));
const owned = await rpc('exec.status', { owner: s.remoteSession.owner });
const sessionId = owned.success ? owned.data.sessions.find(x => x.state === 'running')?.sessionId : undefined;
const t0 = Date.now();
chat.stopSession(s);
await run;
await new Promise(r => setTimeout(r, 3000));
const after = sessionId ? await rpc('exec.status', { sessionId, owner: s.remoteSession.owner }) : undefined;
const cancel = { started: !!execStart, sessionId: !!sessionId, stoppedInMs: Date.now() - t0, remoteStateAfterStop: after?.success ? after.data.state : after?.error?.code, busy: s.busy };
cancel.ok = cancel.started && cancel.sessionId && cancel.remoteStateAfterStop !== 'running' && !cancel.busy && cancel.stoppedInMs < 20000;

const result = { workspace: ws, otherProject: proj, instructions, image, glob, editor, attachment, subagent, security, cancel };
console.log(JSON.stringify(result, null, 1));
const pass = [instructions, image, glob, editor, attachment, subagent, security, cancel].every(x => x.ok);
console.log(pass ? 'LIVE 0.6.0 PARITY: PASS' : 'LIVE 0.6.0 PARITY: FAIL');
ext.deactivate();
remote.deactivate();
for (const d of [ws, proj]) fs.rmSync(d, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
