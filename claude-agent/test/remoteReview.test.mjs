// Change review in Remote-SSH mode, end to end without the editor: the production bundle of this extension (review
// store, review UI commands, chat panel, MCP tools) with its command bridge wired to the real compiled remote
// workspace extension, on scratch workspaces with real files and processes. Skipped when the remote extension is not
// built next to this repository.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { buildExtension, ROOT } from './helpers/build.mjs';
import { loadExtension, makeContext, uri } from './helpers/vscodeStub.mjs';

const REMOTE = process.env.CLAUDE_AGENT_REMOTE_OUT ?? path.join(ROOT, '..', 'claude-agent-remote', 'out', 'extension.js');
const available = fs.existsSync(REMOTE);
const skip = !available && 'remote extension not built';
const require = createRequire(import.meta.url);
const bundle = available ? await buildExtension() : undefined;

// One instance of the real remote extension; each test points its workspace folder at its own scratch directory.
const folderObject = { uri: { fsPath: '' } };
const handlers = new Map();
let remoteExt;
if (available) {
  const Module = require('module');
  const load = Module._load;
  Module._load = function (req, ...rest) {
    return req === 'vscode' ? { workspace: { workspaceFolders: [folderObject] }, window: { createOutputChannel: () => ({ appendLine() { }, clear() { }, show() { } }) },
      commands: { registerCommand: (id, fn) => { handlers.set(id, fn); return { dispose() { } }; } } } : load.call(this, req, ...rest);
  };
  remoteExt = require(REMOTE);
  Module._load = load;
  remoteExt.activate({ subscriptions: [] });
}
after(() => remoteExt?.deactivate());

const workspaces = [];
after(() => { for (const w of workspaces) fs.rmSync(w, { recursive: true, force: true }); });
function scratch(files) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-ws-')));
  workspaces.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content);
  }
  return ws;
}

/** Opens a Remote-SSH window on `ws`: activates the bundle, connects an MCP client to the chat panel's remote tools. */
async function openWindow(ws, { state, mode = 'ask', answer, apiVersion } = {}) {
  folderObject.uri.fsPath = ws;
  const bridge = async (id, arg) => {
    if (!id.startsWith('claudeIde.remote.')) return undefined;
    const r = await handlers.get(id)(arg);
    return id === 'claudeIde.remote.getInfo' && apiVersion ? { ...r, apiVersion } : r;
  };
  const folder = uri('vscode-remote', 'ssh-remote+test', ws);
  const warnings = [];
  const { ext, commands } = loadExtension(bundle, { remoteName: 'ssh-remote', remoteSsh: true, folder, bridge,
    warningAnswer: (message, rest) => { warnings.push(message); return answer?.(message, rest); } });
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'review-storage-'));
  workspaces.push(storage);
  const { chat, store } = ext.activate(makeContext(storage, state));
  const posts = [];
  Object.assign(chat.active, { turn: 'turn-1', mode });
  chat.post = m => posts.push(m);
  const { server } = await chat.remoteToolsServer(chat.active);
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const mcp = new Client({ name: 'review-test', version: '1' });
  await mcp.connect(b);
  const call = async (name, args) => {
    const r = await mcp.callTool({ name, arguments: args });
    assert.ok(!r.isError, `${name}: ${r.content[0].text}`);
    return r.content[0].text;
  };
  const files = chat.remote.files;
  // Pending reviews load asynchronously from the remote host: wait until every tracked file's content is known.
  for (let t = 0; t < 200 && store.tracked().some(k => files.read(k) === undefined); t++) await new Promise(r => setTimeout(r, 10));
  const key = rel => files.keyFor(rel);
  const run = (id, ...args) => commands.get(id)(...args);
  const pending = () => Object.fromEntries(store.pending().map(p => [files.display(p.path), p.status]));
  const tool = async (name, args) => { const r = await mcp.callTool({ name, arguments: args }); return { isError: !!r.isError, text: r.content[0].text }; };
  return { chat, store, files, key, run, call, tool, pending, posts, warnings, read: rel => fs.readFileSync(path.join(ws, rel), 'utf8'), exists: rel => fs.existsSync(path.join(ws, rel)), ws };
}

const A_CPP = 'int a() {\n  return 1;\n}\n\nint b() {\n  return 2;\n}\n\nint c() {\n  return 3;\n}\n';

test('multi-file review: edits, command changes, moves and deletes appear; per-change and per-file accept/reject work', { skip }, async () => {
  const ws = scratch({ 'src/a.cpp': A_CPP, 'src/b.h': '// HEADER\n', 'old.txt': 'keep me\n', 'docs/x.md': '# X\n' });
  const w = await openWindow(ws);
  await w.call('read_file', { file_path: 'src/a.cpp' });
  await w.call('apply_patch', { files: [{ file_path: `${ws}/src/a.cpp`, edits: [{ old_string: 'return 1;', new_string: 'return 10;' }, { old_string: 'return 3;', new_string: 'return 30;' }] }] });
  await w.call('write_file', { file_path: 'src/c.cpp', content: 'int c2();\n' });
  await w.call('execute_command', { command: 'sed -i s/HEADER/HDR/ src/b.h && echo generated > gen.txt && rm old.txt' });
  await w.call('file_operation', { operation: 'rename', path: 'docs/x.md', destination: 'y.md' });

  assert.deepEqual(w.pending(), { 'docs/x.md': 'D', 'docs/y.md': 'A', 'gen.txt': 'A', 'old.txt': 'D', 'src/a.cpp': 'M', 'src/b.h': 'M', 'src/c.cpp': 'A' });
  const changes = w.posts.filter(m => m.type === 'changes').at(-1).files;   // the chat panel's Changes strip
  assert.deepEqual(changes.find(f => f.name === 'a.cpp'), { path: w.key('src/a.cpp'), status: 'M', add: 2, del: 2, conversations: [w.chat.active.conversationId], name: 'a.cpp', dir: 'src' });
  assert.equal(w.store.hunks(w.key('src/a.cpp')).length, 2);

  // The editor's inline widget passes the document's fsPath: reject the first change, keep the second.
  await w.run('claudeIde.rejectHunk', w.files.uri(w.key('src/a.cpp')).fsPath, 0);
  assert.equal(w.read('src/a.cpp'), A_CPP.replace('return 3;', 'return 30;'));
  assert.equal(w.store.hunks(w.key('src/a.cpp')).length, 1);
  await w.run('claudeIde.acceptHunk', w.key('src/a.cpp'), 0);
  assert.equal(w.pending()['src/a.cpp'], undefined);
  assert.equal(w.read('src/a.cpp'), A_CPP.replace('return 3;', 'return 30;'));   // accepted change stays

  await w.run('claudeIde.rejectFile', w.key('src/c.cpp'));      // created → removed
  assert.equal(w.exists('src/c.cpp'), false);
  await w.run('claudeIde.rejectFile', w.key('old.txt'));        // deleted → back
  assert.equal(w.read('old.txt'), 'keep me\n');
  await w.run('claudeIde.rejectFile', w.key('docs/y.md'));      // a rename is a delete + a create
  await w.run('claudeIde.rejectFile', w.key('docs/x.md'));
  assert.deepEqual([w.exists('docs/y.md'), w.read('docs/x.md')], [false, '# X\n']);
  await w.run('claudeIde.acceptFile', w.key('src/b.h'));
  assert.equal(w.read('src/b.h'), '// HDR\n');
  assert.deepEqual(w.pending(), { 'gen.txt': 'A' });
  await w.run('claudeIde.rejectAll');
  assert.deepEqual([w.pending(), w.exists('gen.txt')], [{}, false]);
  assert.deepEqual(w.warnings, []);
});

test('Accept All keeps every change; Reject All restores every file', { skip }, async () => {
  const ws = scratch({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const w = await openWindow(ws);
  for (const f of ['a.txt', 'b.txt']) { await w.call('read_file', { file_path: f }); await w.call('write_file', { file_path: f, content: f.toUpperCase() }); }
  await w.call('write_file', { file_path: 'new/n.txt', content: 'n', create_parents: true });
  assert.equal(Object.keys(w.pending()).length, 3);
  await w.run('claudeIde.acceptAll');
  assert.deepEqual([w.pending(), w.read('a.txt'), w.read('new/n.txt')], [{}, 'A.TXT', 'n']);

  await w.call('read_file', { file_path: 'a.txt' });
  await w.call('write_file', { file_path: 'a.txt', content: 'again' });
  await w.call('execute_command', { command: 'echo x >> b.txt && touch made.txt' });
  assert.deepEqual(w.pending(), { 'a.txt': 'M', 'b.txt': 'M', 'made.txt': 'A' });
  await w.run('claudeIde.rejectAll');
  assert.deepEqual([w.pending(), w.read('a.txt'), w.read('b.txt'), w.exists('made.txt')], [{}, 'A.TXT', 'B.TXT', false]);
});

test('conflicts: edits made after Claude\'s change are never discarded silently', { skip }, async () => {
  const ws = scratch({ 'f.txt': 'a\nb\nc\n', 'g.txt': 'one\n' });
  let answer;
  const w = await openWindow(ws, { answer: () => answer });
  await w.call('read_file', { file_path: 'f.txt' });
  await w.call('apply_patch', { files: [{ file_path: 'f.txt', edits: [{ old_string: 'a\n', new_string: 'A\n' }] }] });
  fs.writeFileSync(path.join(ws, 'f.txt'), 'A\nb\nC\n');   // someone edits the file afterwards
  await w.files.refresh(w.key('f.txt'));                    // what the remote file watcher triggers

  answer = undefined;                                        // the person cancels
  await w.run('claudeIde.rejectFile', w.key('f.txt'));
  assert.equal(w.warnings.at(-1), 'Edited after Claude\'s change');
  assert.deepEqual([w.read('f.txt'), w.pending()['f.txt']], ['A\nb\nC\n', 'M']);

  // One change (§5(B)): the same check, nothing written until the person confirms...
  const warned = w.warnings.length;
  await w.run('claudeIde.rejectHunk', w.key('f.txt'), 0);
  assert.deepEqual([w.read('f.txt'), w.warnings.slice(warned)], ['A\nb\nC\n', ['Edited after Claude\'s change']]);
  await w.run('claudeIde.acceptHunk', w.key('f.txt'), 0);
  assert.deepEqual([w.read('f.txt'), w.pending()['f.txt'], w.warnings.length], ['A\nb\nC\n', 'M', warned + 2]);
  answer = 'Reject Anyway';                                  // ...then only that change is reverted; the later edit stays
  await w.run('claudeIde.rejectHunk', w.key('f.txt'), 0);
  assert.equal(w.read('f.txt'), 'a\nb\nC\n');

  await w.call('read_file', { file_path: 'g.txt' });
  await w.call('write_file', { file_path: 'g.txt', content: 'two\n' });
  fs.writeFileSync(path.join(ws, 'g.txt'), 'three\n');
  await w.files.refresh(w.key('g.txt'));
  answer = 'Reject Anyway';                                  // the person confirms discarding the later edit
  await w.run('claudeIde.rejectFile', w.key('g.txt'));
  assert.deepEqual([w.read('g.txt'), w.pending()['g.txt']], ['one\n', undefined]);

  // The file changes between the review's read and its write: nothing is written.
  await w.call('read_file', { file_path: 'g.txt' });
  await w.call('write_file', { file_path: 'g.txt', content: 'four\n' });
  await w.files.refresh(w.key('g.txt'));
  fs.writeFileSync(path.join(ws, 'g.txt'), 'five\n');
  await assert.rejects(w.files.write(w.key('g.txt'), 'one\n', { force: true }), e => e.name === 'ReviewConflict' && e.laterEdits === false);
  assert.equal(w.read('g.txt'), 'five\n');
});

test('pending reviews survive a window reload and can still be rejected', { skip }, async () => {
  const ws = scratch({ 'keep.txt': 'original\n' });
  const state = new Map([['claudeIde.revealed', true]]);
  const first = await openWindow(ws, { state });
  await first.call('read_file', { file_path: 'keep.txt' });
  await first.call('write_file', { file_path: 'keep.txt', content: 'changed\n' });
  await first.call('write_file', { file_path: 'added.txt', content: 'new\n' });
  assert.deepEqual(first.pending(), { 'added.txt': 'A', 'keep.txt': 'M' });
  assert.equal(state.has('claudeIde.baselines'), false);      // remote reviews never use the local keys

  const second = await openWindow(ws, { state });             // the IDE was closed and reopened
  assert.deepEqual(second.pending(), { 'added.txt': 'A', 'keep.txt': 'M' });
  await second.run('claudeIde.rejectFile', second.key('keep.txt'));
  await second.run('claudeIde.rejectFile', second.key('added.txt'));
  assert.deepEqual([second.read('keep.txt'), second.exists('added.txt'), second.warnings], ['original\n', false, []]);
});

test('"Restore to here" rewinds the remote files changed from that message on', { skip }, async () => {
  const ws = scratch({ 'r.txt': 'v0\n' });
  const w = await openWindow(ws, { answer: m => (m === 'Restore to before this message?' ? 'Restore' : undefined) });
  await w.call('read_file', { file_path: 'r.txt' });
  w.chat.active.turn = 'turn-1';
  await w.call('write_file', { file_path: 'r.txt', content: 'v1\n' });
  w.chat.active.turn = 'turn-2';
  await w.call('write_file', { file_path: 'r.txt', content: 'v2\n' });
  await w.call('write_file', { file_path: 'later.txt', content: 'x\n' });
  await w.run('claudeIde.acceptAll');                          // accepted changes can still be rewound
  await w.chat.restore(w.chat.active, ['turn-2']);
  assert.deepEqual([w.read('r.txt'), w.exists('later.txt')], ['v1\n', false]);
  assert.ok(w.posts.some(m => m.type === 'rewound' && m.files === 2));
});

test('"Ask before each edit": approved edits are final at once, command changes stay for review', { skip }, async () => {
  const ws = scratch({ 'e.txt': 'e\n' });
  const w = await openWindow(ws, { mode: 'askBeforeEach' });
  await w.call('read_file', { file_path: 'e.txt' });
  await w.call('write_file', { file_path: 'e.txt', content: 'E\n' });
  await w.call('execute_command', { command: 'echo gen > gen.txt' });
  assert.deepEqual(w.pending(), { 'gen.txt': 'A' });
});

test('background commands: their changes are recorded once they are seen to have finished', { skip }, async () => {
  const ws = scratch({});
  const w = await openWindow(ws);
  const bg = JSON.parse(await w.call('execute_command', { command: 'sleep 1.5 && echo done > bg.txt', run_in_background: true }));
  assert.deepEqual(w.pending(), {});
  await new Promise(r => setTimeout(r, 1800));
  await w.call('process_status', { session_id: bg.session_id });
  assert.deepEqual(w.pending(), { 'bg.txt': 'A' });
});

test('an older remote extension (before API 5): the tools say it must be updated; nothing is written or run', { skip }, async () => {
  const ws = scratch({ 'o.txt': 'o\n' });
  const w = await openWindow(ws, { apiVersion: 4 });
  for (const [name, args] of [['read_file', { file_path: 'o.txt' }], ['write_file', { file_path: 'o.txt', content: 'O\n' }], ['execute_command', { command: 'touch p.txt' }]]) {
    const r = await w.tool(name, args);
    assert.deepEqual([r.isError, /^UNSUPPORTED: .*0\.5\.0/.test(r.text)], [true, true], name);
  }
  assert.deepEqual([w.pending(), w.read('o.txt'), w.exists('p.txt')], [{}, 'o\n', false]);
});

test('files of another project (outside the workspace): reviewed, rejected per change and per file, conflicts detected', { skip }, async () => {
  const ws = scratch({ 'in.txt': 'in\n' });
  const other = scratch({ 'lib/o.txt': 'a\nb\nc\n', 'del.txt': 'gone soon\n', 'cmd.txt': 'x\n' });
  let answer;
  const w = await openWindow(ws, { answer: () => answer });
  const O = rel => path.join(other, rel);
  const readO = rel => fs.readFileSync(O(rel), 'utf8');
  await w.call('read_file', { file_path: O('lib/o.txt') });
  await w.call('apply_patch', { files: [{ file_path: O('lib/o.txt'), edits: [{ old_string: 'a\n', new_string: 'A\n' }, { old_string: 'c\n', new_string: 'C\n' }] }] });
  await w.call('write_file', { file_path: O('new.txt'), content: 'n\n' });
  await w.call('file_operation', { operation: 'delete_file', path: O('del.txt') });
  const ran = JSON.parse(await w.call('execute_command', { command: 'echo y >> cmd.txt', cwd: other }));   // a command in the other project
  assert.equal(ran.exit_code, 0);
  assert.deepEqual(w.pending(), { [O('lib/o.txt')]: 'M', [O('new.txt')]: 'A', [O('del.txt')]: 'D', [O('cmd.txt')]: 'M' });
  const strip = w.posts.filter(m => m.type === 'changes').at(-1).files.find(f => f.name === 'o.txt');
  assert.deepEqual([strip.dir, strip.path], [path.join(other, 'lib'), w.key(O('lib/o.txt'))]);   // shown by its absolute folder

  await w.run('claudeIde.rejectHunk', w.key(O('lib/o.txt')), 0);
  assert.equal(readO('lib/o.txt'), 'a\nb\nC\n');
  await w.run('claudeIde.rejectFile', w.key(O('new.txt')));
  await w.run('claudeIde.rejectFile', w.key(O('del.txt')));
  await w.run('claudeIde.rejectFile', w.key(O('cmd.txt')));
  assert.deepEqual([fs.existsSync(O('new.txt')), readO('del.txt'), readO('cmd.txt')], [false, 'gone soon\n', 'x\n']);

  // Edited outside the review after Claude's change: refused until the person confirms (§5(B)).
  fs.writeFileSync(O('lib/o.txt'), 'a\nB\nC\n');
  await w.files.refresh(w.key(O('lib/o.txt')));
  answer = undefined;
  await w.run('claudeIde.rejectFile', w.key(O('lib/o.txt')));
  assert.deepEqual([readO('lib/o.txt'), w.warnings.at(-1)], ['a\nB\nC\n', 'Edited after Claude\'s change']);
  answer = 'Reject Anyway';
  await w.run('claudeIde.rejectFile', w.key(O('lib/o.txt')));
  assert.deepEqual([readO('lib/o.txt'), w.pending()], ['a\nb\nc\n', {}]);
});

test('commands: changes the review snapshot did not cover are reported in the tool result', { skip }, async () => {
  const ws = scratch({});
  const elsewhere = scratch({ 'e.txt': 'e\n' });
  const w = await openWindow(ws);
  const r = JSON.parse(await w.call('execute_command', { command: `echo z >> ${elsewhere}/e.txt && head -c 3000000 /dev/zero > big.bin` }));
  assert.match(r.review, new RegExp(`not recorded for review: .*big\\.bin \\(binary or too large to review\\)`));
  assert.match(r.review, new RegExp(`Changes outside ${ws}.* are not recorded for review and cannot be undone with Restore; this call also named: ${elsewhere}/e\\.txt`));
  assert.deepEqual(w.pending(), {});   // nothing was recorded for the uncovered change
  const plain = JSON.parse(await w.call('execute_command', { command: 'echo ok > ok.txt' }));
  assert.equal(plain.review, undefined);
  assert.deepEqual(w.pending(), { 'ok.txt': 'A' });
});

test('local windows: the review still works on local files exactly as before', { skip: !bundle && 'bundle not built' }, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-local-')));
  workspaces.push(dir);
  const file = path.join(dir, 'l.txt');
  fs.writeFileSync(file, 'a\nb\nc\n');
  const { ext, commands } = loadExtension(bundle, { remoteName: undefined, remoteSsh: true, folder: uri('file', '', dir) });
  const state = new Map([['claudeIde.revealed', true]]);
  const { store } = ext.activate(makeContext(fs.mkdtempSync(path.join(os.tmpdir(), 'review-storage-')), state));
  store.snapshot(file, 't');                                  // what PreToolUse does before a native edit
  fs.writeFileSync(file, 'A\nb\nC\n');
  store.settle();
  assert.deepEqual(store.pending().map(p => [p.path, p.status, p.add, p.del]), [[file, 'M', 2, 2]]);
  await commands.get('claudeIde.rejectHunk')(file, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'a\nb\nC\n');
  await commands.get('claudeIde.rejectFile')(file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'a\nb\nc\n');
  assert.deepEqual([store.pending(), Object.keys(state.get('claudeIde.baselines'))], [[], []]);   // local keys, as before
});
