// Full stack without VS Code: MCP client → this extension's MCP server → RemoteFilesystemClient → (stand-in command
// bridge) → the real compiled remote workspace extension → real filesystem, processes and git on this machine.
// Skipped when the remote extension is not built next to this repository (../claude-agent-remote: run `npm install && npm run compile` there).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { loadModules, ROOT } from './helpers/build.mjs';

const REMOTE = process.env.CLAUDE_AGENT_REMOTE_OUT ?? path.join(ROOT, '..', 'claude-agent-remote', 'out', 'extension.js');
const available = fs.existsSync(REMOTE);
const require = createRequire(import.meta.url);

let call, ws, outside, home, state, remoteExt, handlers, perms;

before(async () => {
  if (!available) return;
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stack-ws-')));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stack-outside-')));   // other projects, outside the workspace
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stack-home-')));         // the remote user's home (credential locations)
  process.env.HOME = home;
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE\n');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(ws, 'escape.txt'));
  fs.mkdirSync(path.join(ws, 'src'));
  fs.writeFileSync(path.join(ws, 'src', 'main.cpp'), '#include <cstdio>\nint main() { std::puts("v1"); return 0; }\n');
  fs.writeFileSync(path.join(ws, 'Makefile'), 'app: src/main.cpp\n\tg++ -o app src/main.cpp\n');
  const g = (...a) => execFileSync('git', a, { cwd: ws });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 'Stack Test');
  g('add', '.'); g('commit', '-q', '-m', 'initial');

  handlers = new Map();
  const Module = require('module');
  const load = Module._load;
  Module._load = function (req, ...rest) {
    return req === 'vscode' ? { workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] }, window: { createOutputChannel: () => ({ appendLine() { }, clear() { }, show() { } }) },
      commands: { registerCommand: (id, fn) => { handlers.set(id, fn); return { dispose() { } }; } } } : load.call(this, req, ...rest);
  };
  remoteExt = require(REMOTE);
  Module._load = load;
  remoteExt.activate({ subscriptions: [] });

  const [clientMod, serverMod, permsMod] = await loadModules('src/remote/remoteFilesystemClient.ts', 'src/remote/remoteWorkspaceServer.ts', 'src/remote/permissions.ts');
  perms = permsMod;
  const bridge = async (command, request) => { const h = handlers.get(command); if (!h) throw new Error(`command '${command}' not found`); return h(request); };
  const client = clientMod.createRemoteFilesystemClient({ getRemoteName: () => 'ssh-remote', executeCommand: bridge, timeoutMs: 30000 });
  const info = await client.getInfo();
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  state = serverMod.newSessionState();
  const server = serverMod.createRemoteWorkspaceServer(sdk, client, { hostname: info.hostname, platform: info.platform, root: info.workspaceRoot, apiVersion: info.apiVersion, home: info.homeDirectory }, state);
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const mcp = new Client({ name: 'stack', version: '1' });
  await mcp.connect(b);
  call = async (name, args) => { const r = await mcp.callTool({ name, arguments: args }); return { isError: !!r.isError, text: r.content[0].text }; };
});

after(() => {
  if (!available) return;
  remoteExt.deactivate();
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

const code = r => r.text.split(':')[0];

test('full stack: edit, build, run and commit a C++ project through the 15 remote tools', { skip: !available && 'remote extension not built' }, async () => {
  assert.match((await call('search_files', { query: 'main' })).text, /src\/main\.cpp/);
  assert.match((await call('search_content', { pattern: 'puts', include: ['*.cpp'] })).text, /"line": 2/);
  assert.equal((await call('read_file', { file_path: `${ws}/src/main.cpp`, offset: 2, limit: 1 })).text, 'int main() { std::puts("v1"); return 0; }');
  assert.equal(code(await call('write_file', { file_path: 'Makefile', content: 'x' })), 'ALREADY_EXISTS');   // never read here: not replaced
  assert.equal((await call('read_file', { file_path: 'src/main.cpp' })).isError, false);
  const patched = await call('apply_patch', { files: [{ file_path: 'src/main.cpp', edits: [{ old_string: '"v1"', new_string: '"v2"' }] }] });
  assert.match(patched.text, /^Updated .*src\/main\.cpp: 3 → 3 lines/);
  assert.equal(code(await call('apply_patch', { files: [{ file_path: 'src/main.cpp', edits: [{ old_string: '"v1"', new_string: '"v3"' }] }] })), 'CONFLICT');
  assert.match((await call('write_file', { file_path: 'notes/todo.md', content: '- ship\n', create_parents: true })).text, /^Created .*notes\/todo\.md \(2 lines, 7 bytes\)/);

  const build = JSON.parse((await call('execute_command', { command: 'make app && ./app' })).text);
  assert.deepEqual([build.exit_code, build.stdout.trim().split('\n').pop()], [0, 'v2']);
  const failing = JSON.parse((await call('execute_command', { command: 'g++', args: ['-o', 'bad', 'missing.cpp'] })).text);
  assert.notEqual(failing.exit_code, 0);
  assert.match(failing.stderr, /missing\.cpp/);
  const timedOut = JSON.parse((await call('execute_command', { command: 'sleep 30', timeout_seconds: 1 })).text);
  assert.deepEqual([timedOut.timed_out, timedOut.terminated], [true, true]);
  const bg = JSON.parse((await call('execute_command', { command: 'while true; do echo tick; sleep 0.2; done', run_in_background: true })).text);
  assert.equal(bg.state, 'running');
  assert.match(JSON.parse((await call('process_status', { session_id: bg.session_id })).text).stdout, /tick/);
  assert.match((await call('process_status', {})).text, new RegExp(bg.session_id));
  const stopped = JSON.parse((await call('terminate_process', { session_id: bg.session_id })).text);
  assert.deepEqual([stopped.state, stopped.terminated], ['exited', true]);
  assert.equal(code(await call('terminate_process', { session_id: 'not-ours' })), 'PROCESS_NOT_FOUND');
  assert.equal(JSON.parse((await call('execute_command', { command: 'pwd', cwd: outside })).text).stdout.trim(), outside);
  assert.equal(code(await call('execute_command', { command: 'sudo -n true' })), 'PRIVILEGE_NOT_APPROVED');

  const status = JSON.parse((await call('git_status', {})).text);
  assert.deepEqual([status.branch, status.unstaged.map(s => s.path), status.untracked.includes('notes/')], ['main', ['src/main.cpp'], true]);
  assert.match(JSON.parse((await call('git_diff', { paths: ['src/main.cpp'] })).text).text, /-.*"v1".*\n\+.*"v2"/);
  await call('git_operation', { operation: 'branch_create', name: 'feature/v2' });
  await call('git_operation', { operation: 'branch_switch', name: 'feature/v2' });
  await call('git_operation', { operation: 'stage', paths: ['src/main.cpp'] });
  assert.equal(JSON.parse((await call('git_status', {})).text).staged[0].path, 'src/main.cpp');
  await call('git_operation', { operation: 'unstage', paths: ['src/main.cpp'] });
  await call('git_operation', { operation: 'stage', paths: [`${ws}/src/main.cpp`] });
  assert.match(JSON.parse((await call('git_operation', { operation: 'commit', message: 'Print v2' })).text).commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(JSON.parse((await call('git_log', { max_count: 2 })).text).commits.map(c => c.subject), ['Print v2', 'initial']);
  assert.deepEqual(JSON.parse((await call('git_operation', { operation: 'branch_list' })).text).branches.find(b => b.current).name, 'feature/v2');

  await call('file_operation', { operation: 'create_directory', path: 'docs/api' });
  await call('file_operation', { operation: 'move', path: 'notes/todo.md', destination: 'docs/api/todo.md' });
  await call('file_operation', { operation: 'rename', path: 'docs/api/todo.md', destination: 'TODO.md' });
  assert.equal(fs.readFileSync(path.join(ws, 'docs/api/TODO.md'), 'utf8'), '- ship\n');
  assert.equal(code(await call('file_operation', { operation: 'delete_directory', path: 'docs' })), 'CONFLICT');
  await call('file_operation', { operation: 'delete_directory', path: 'docs', recursive: true });
  assert.ok(!fs.existsSync(path.join(ws, 'docs')));
});

test('full stack: a second project outside the workspace: read, write, edit, move, copy, delete, search, run and git, without approval in auto mode', { skip: !available && 'remote extension not built' }, async () => {
  const proj = path.join(outside, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'a.txt'), 'alpha\n');
  const g = (...a) => execFileSync('git', a, { cwd: proj });
  g('init', '-q', '-b', 'trunk'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 'Other Project');
  g('add', '.'); g('commit', '-q', '-m', 'other initial');
  // Every decision for these calls in auto mode: allowed (where a file is relative to the workspace plays no part).
  const where = { root: ws, home, platform: process.platform };
  for (const [tool, input] of [['write_file', { file_path: `${proj}/x` }], ['file_operation', { operation: 'delete_file', path: `${proj}/x` }], ['execute_command', { command: 'cp a b', cwd: proj }]]) {
    assert.equal(perms.remoteToolDecision(`mcp__remote__${tool}`, input, 'auto', where, new Set()).decision, 'allow', tool);
  }

  assert.equal((await call('read_file', { file_path: `${proj}/a.txt` })).text, 'alpha\n');
  assert.equal((await call('read_file', { file_path: `../${path.basename(outside)}/proj/a.txt` })).text, 'alpha\n');   // relative, with ..
  assert.match((await call('apply_patch', { files: [{ file_path: `${proj}/a.txt`, edits: [{ old_string: 'alpha', new_string: 'beta' }] }] })).text, new RegExp(`^Updated ${proj}/a.txt`));
  assert.match((await call('write_file', { file_path: `${proj}/src/new.c`, content: 'int x;\n', create_parents: true })).text, new RegExp(`^Created ${proj}/src/new.c`));
  const moved = JSON.parse((await call('file_operation', { operation: 'move', path: `${proj}/src/new.c`, destination: `${proj}/lib/new.c`, create_parents: true })).text);
  assert.equal(moved.destination, `${proj}/lib/new.c`);
  const copied = JSON.parse((await call('execute_command', { command: 'cp a.txt copy.txt && cat copy.txt', cwd: proj })).text);
  assert.deepEqual([copied.exit_code, copied.stdout, copied.cwd], [0, 'beta\n', proj]);
  assert.equal(JSON.parse((await call('file_operation', { operation: 'delete_file', path: `${proj}/copy.txt` })).text).path, `${proj}/copy.txt`);
  assert.deepEqual(JSON.parse((await call('search_content', { pattern: 'beta', path: proj })).text).matches.map(m => m.path), [`${proj}/a.txt`]);
  assert.match((await call('search_files', { query: 'new', path: proj })).text, new RegExp(`${proj}/lib/new.c`));
  assert.match((await call('list_directory', { path: proj })).text, new RegExp(`${proj}/lib`));
  const st = JSON.parse((await call('git_status', { repository: proj })).text);
  assert.deepEqual([st.branch, st.repositoryRoot, st.unstaged.map(f => f.path), st.untracked], ['trunk', proj, ['a.txt'], ['lib/']]);
  await call('git_operation', { operation: 'stage', repository: proj, paths: [`${proj}/a.txt`, `${proj}/lib/new.c`] });
  assert.match(JSON.parse((await call('git_operation', { operation: 'commit', repository: proj, message: 'From the other window' })).text).commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(JSON.parse((await call('git_log', { repository: proj, max_count: 1 })).text).commits.map(c => c.subject), ['From the other window']);
  // A symbolic link from the workspace into another project is followed to its target (canonicalized first).
  assert.equal((await call('read_file', { file_path: 'escape.txt' })).text, 'OUTSIDE\n');
  assert.deepEqual([fs.readFileSync(path.join(proj, 'a.txt'), 'utf8'), fs.existsSync(path.join(proj, 'copy.txt')), fs.existsSync(path.join(proj, 'lib/new.c'))], ['beta\n', false, true]);
});

test('full stack: credential locations need approval at both layers, also through a symbolic link; OS permissions apply', { skip: !available && 'remote extension not built' }, async () => {
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.ssh/id_test'), 'PRIVATE\n');
  fs.symlinkSync(path.join(home, '.ssh/id_test'), path.join(outside, 'innocent'));
  const first = await call('read_file', { file_path: '~/.ssh/id_test' });          // refused by this extension (never sent)
  const viaLink = await call('read_file', { file_path: `${outside}/innocent` });  // refused by the remote extension after canonicalizing
  assert.deepEqual([code(first), code(viaLink), viaLink.text.includes(`resolves to ${home}/.ssh/id_test`)], ['SENSITIVE_PATH_NOT_APPROVED', 'SENSITIVE_PATH_NOT_APPROVED', true]);
  assert.deepEqual(JSON.parse((await call('search_content', { pattern: 'PRIVATE', path: home })).text).matches, []);
  state.approvals.add(perms.credentialApprovalKey('mcp__remote__read_file', [`${home}/.ssh/id_test`]));   // what approving the prompt adds
  assert.equal((await call('read_file', { file_path: '~/.ssh/id_test' })).text, 'PRIVATE\n');
  assert.equal(code(await call('read_file', { file_path: '~/.ssh/id_test' })), 'SENSITIVE_PATH_NOT_APPROVED');   // used once
  const locked = path.join(outside, 'locked.txt');
  fs.writeFileSync(locked, 'L');
  fs.chmodSync(locked, 0o000);
  if (process.getuid?.() !== 0) assert.equal(code(await call('read_file', { file_path: locked })), 'PERMISSION_DENIED');
  fs.chmodSync(locked, 0o600);
});

test('no local fallback: a missing remote extension, an unavailable remote and a hanging bridge are reported as errors', { skip: !available && 'remote extension not built' }, async () => {
  const [clientMod] = await loadModules('src/remote/remoteFilesystemClient.ts', 'src/remote/remoteWorkspaceServer.ts');
  const failures = [
    clientMod.createRemoteFilesystemClient({ getRemoteName: () => 'ssh-remote', executeCommand: async c => { throw new Error(`command '${c}' not found`); }, timeoutMs: 1000 }),
    clientMod.createRemoteFilesystemClient({ getRemoteName: () => undefined, executeCommand: async () => ({ success: true, data: {} }), timeoutMs: 1000 }),
    clientMod.createRemoteFilesystemClient({ getRemoteName: () => 'ssh-remote', executeCommand: () => new Promise(() => { }), timeoutMs: 100 }),
  ];
  const codes = [];
  for (const c of failures) {
    try { await c.execStart({ command: 'echo should-not-run-locally > local-marker' }); codes.push('resolved'); } catch (e) { codes.push(e.code); }
  }
  assert.deepEqual(codes, ['REMOTE_NOT_AVAILABLE', 'REMOTE_NOT_AVAILABLE', 'REMOTE_TIMEOUT']);
  assert.ok(!fs.existsSync(path.join(process.cwd(), 'local-marker')));
});
