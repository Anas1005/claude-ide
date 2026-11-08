// 0.6.0: CLI discovery and launch on every platform (Windows npm shims), CLAUDE_CONFIG_DIR, remote image reading and
// glob search (API v6, v5 fallback), project instructions (CLAUDE.md), sub-agents in remote mode, and remote editor
// context / attachments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadModules, buildExtension } from './helpers/build.mjs';
import { loadExtension, makeContext, uri } from './helpers/vscodeStub.mjs';

const [cli, clientMod, serverMod, mode] = await loadModules(
  'src/claudeCli.ts', 'src/remote/remoteFilesystemClient.ts', 'src/remote/remoteWorkspaceServer.ts', 'src/remote/remoteMode.ts');
const sdk = await import('@anthropic-ai/claude-agent-sdk');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { RemoteFilesystemError } = clientMod;

// ---- Fix A: CLI discovery and launch ----

/** A fake machine: `files` maps path → text (or true for a binary). */
const machine = (platform, files, env = {}, home = platform === 'win32' ? 'C:\\Users\\u' : '/home/u') => ({
  platform, env, home,
  exists: p => p in files,
  readText: p => (typeof files[p] === 'string' ? files[p] : undefined),
});
const NPM = 'C:\\Users\\u\\AppData\\Roaming\\npm';
const PKG = `${NPM}\\node_modules\\@anthropic-ai\\claude-code`;
const SHIM_JS = '@ECHO off\r\nSET "_prog=node"\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
const SHIM_EXE = '@ECHO off\r\n"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';

test('Windows: native claude.exe is preferred and launched directly', () => {
  const d = machine('win32', { 'C:\\Users\\u\\.local\\bin\\claude.exe': true, [`${NPM}\\claude.cmd`]: SHIM_JS }, { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' });
  assert.deepEqual(cli.findClaude(undefined, d), { sdkPath: 'C:\\Users\\u\\.local\\bin\\claude.exe', command: 'C:\\Users\\u\\.local\\bin\\claude.exe', args: [] });
});

test('Windows: an npm claude.cmd is never executed: its cli.js runs with node, or its native exe directly', () => {
  const env = { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', Path: 'C:\\Program Files\\nodejs' };
  const js = machine('win32', { [`${NPM}\\claude.cmd`]: SHIM_JS, [`${PKG}\\cli.js`]: 'x', 'C:\\Program Files\\nodejs\\node.exe': true }, env);
  assert.deepEqual(cli.findClaude(undefined, js), { sdkPath: `${PKG}\\cli.js`, command: 'C:\\Program Files\\nodejs\\node.exe', args: [`${PKG}\\cli.js`] });
  assert.equal(cli.nodeDirFor(cli.findClaude(undefined, js), 'win32'), 'C:\\Program Files\\nodejs');
  const exe = machine('win32', { [`${NPM}\\claude.cmd`]: SHIM_EXE, [`${PKG}\\bin\\claude.exe`]: true }, env);
  assert.deepEqual(cli.findClaude(undefined, exe), { sdkPath: `${PKG}\\bin\\claude.exe`, command: `${PKG}\\bin\\claude.exe`, args: [] });
  // On PATH only (no APPDATA): found after claude.exe was not.
  const onPath = machine('win32', { 'D:\\tools\\npm\\claude.cmd': SHIM_JS, 'D:\\tools\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js': 'x', 'D:\\tools\\npm\\node.exe': true }, { PATH: 'D:\\tools\\npm' });
  assert.deepEqual(cli.findClaude(undefined, onPath), { sdkPath: 'D:\\tools\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js', command: 'D:\\tools\\npm\\node.exe', args: ['D:\\tools\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'] });
});

test('Windows: shim without a recognizable line falls back to package.json bin, then known files; unresolvable → not found', () => {
  const bin = machine('win32', { [`${NPM}\\claude.cmd`]: 'garbage', [`${PKG}\\package.json`]: JSON.stringify({ bin: { claude: 'bin/claude.exe' } }), [`${PKG}\\bin\\claude.exe`]: true });
  assert.equal(cli.findClaude(`${NPM}\\claude.cmd`, bin).command, `${PKG}\\bin\\claude.exe`);
  const known = machine('win32', { [`${NPM}\\claude.cmd`]: '', [`${PKG}\\cli.js`]: 'x' });
  assert.deepEqual(cli.findClaude(`${NPM}\\claude.cmd`, known), { sdkPath: `${PKG}\\cli.js`, command: 'node.exe', args: [`${PKG}\\cli.js`] });
  assert.equal(cli.findClaude(`${NPM}\\claude.cmd`, machine('win32', { [`${NPM}\\claude.cmd`]: '' })), undefined);
  // Shell metacharacters in a path stay one argument: nothing is ever passed to cmd.exe.
  const odd = 'C:\\a & b\\npm';
  const m = machine('win32', { [`${odd}\\claude.cmd`]: SHIM_JS, [`${odd}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`]: 'x', [`${odd}\\node.exe`]: true });
  const l = cli.findClaude(`${odd}\\claude.cmd`, m);
  assert.deepEqual([l.command, l.args], [`${odd}\\node.exe`, [`${odd}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`]]);
  assert.ok(!/\.(cmd|bat)$/i.test(l.command));
});

test('explicit claudePath: a binary as given; a .js entry point with node; Linux and macOS locations unchanged', () => {
  assert.deepEqual(cli.findClaude('/opt/claude/claude', machine('linux', {})), { sdkPath: '/opt/claude/claude', command: '/opt/claude/claude', args: [] });
  assert.deepEqual(cli.findClaude('/x/cli.js', machine('linux', { '/usr/bin/node': true }, { PATH: '/usr/bin' })), { sdkPath: '/x/cli.js', command: '/usr/bin/node', args: ['/x/cli.js'] });
  assert.equal(cli.findClaude(undefined, machine('linux', { '/home/u/.local/bin/claude': true, '/usr/local/bin/claude': true })).command, '/home/u/.local/bin/claude');
  assert.equal(cli.findClaude(undefined, machine('darwin', { '/opt/homebrew/bin/claude': true }, {}, '/Users/u')).command, '/opt/homebrew/bin/claude');
  assert.equal(cli.findClaude(undefined, machine('linux', { '/nvm/bin/claude': true }, { PATH: '/usr/bin:/nvm/bin' })).command, '/nvm/bin/claude');
  assert.equal(cli.findClaude(undefined, machine('linux', {})), undefined);
  // A .cmd on Linux/macOS is not a Windows shim: launched as given (never resolved through a shell).
  assert.equal(cli.findClaude('/x/claude.cmd', machine('linux', {})).command, '/x/claude.cmd');
  assert.equal(cli.nodeDirFor({ sdkPath: '/b', command: '/b', args: [] }, 'linux'), undefined);
});

// ---- Fix B: CLAUDE_CONFIG_DIR ----

test('claudeConfigDir: CLAUDE_CONFIG_DIR when absolute, else ~/.claude (per platform)', () => {
  assert.equal(cli.claudeConfigDir({}, '/home/u', 'linux'), '/home/u/.claude');
  assert.equal(cli.claudeConfigDir({ CLAUDE_CONFIG_DIR: '/data/claude/' }, '/home/u', 'linux'), '/data/claude/');
  assert.equal(cli.claudeConfigDir({ CLAUDE_CONFIG_DIR: 'relative' }, '/home/u', 'linux'), '/home/u/.claude');
  assert.equal(cli.claudeConfigDir({ CLAUDE_CONFIG_DIR: '  ' }, '/home/u', 'linux'), '/home/u/.claude');
  assert.equal(cli.claudeConfigDir({ CLAUDE_CONFIG_DIR: 'D:\\claude' }, 'C:\\Users\\u', 'win32'), 'D:\\claude');
  assert.equal(cli.claudeConfigDir({}, 'C:\\Users\\u', 'win32'), 'C:\\Users\\u\\.claude');
});

test('history watcher and the Claude-state check follow CLAUDE_CONFIG_DIR', async () => {
  const bundle = await buildExtension();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgdir-'));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const watched = [];
    const { ext, vscode } = loadExtension(bundle, { folder: uri('file', '', fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-ws-'))) });
    vscode.workspace.createFileSystemWatcher = pattern => { watched.push(pattern); return { onDidCreate() { }, onDidChange() { }, onDidDelete() { }, dispose() { } }; };
    vscode.RelativePattern = class { constructor(base, glob) { this.base = base.fsPath ?? base; this.glob = glob; } };
    ext.activate(makeContext(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-state-'))));
    assert.ok(watched.some(w => w.base === path.join(dir, 'projects') && w.glob === '**/*.jsonl'), JSON.stringify(watched));
    ext.deactivate();
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  }
  const src = fs.readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
  assert.ok(!/os\.homedir\(\), '\.claude/.test(src), 'no hard-coded ~/.claude left in extension.ts');
});

// ---- remote MCP: images and glob (API v6) ----

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const HOST6 = { hostname: 'contabo', platform: 'linux', root: '/home/anas/ws', apiVersion: 6, home: '/home/anas' };
function fakeClient(results = {}) {
  const calls = [];
  const client = {};
  const defaults = {
    readFileDetails: { content: 'text\n', sha256: 'h', path: '/home/anas/ws/a.txt' },
    readFileBytes: p => ({ path: p, base64: PNG.toString('base64'), size: PNG.length, sha256: 'h' }),
    searchFiles: [{ name: 'a.ts', path: '/home/anas/ws/src/a.ts', type: 'file' }],
  };
  for (const [name, value] of Object.entries({ ...defaults, ...results })) {
    client[name] = async (...args) => { calls.push([name, ...args]); return typeof value === 'function' ? value(...args) : value; };
  }
  return { calls, client };
}
async function connect(client, host = HOST6) {
  const server = serverMod.createRemoteWorkspaceServer(sdk, client, host);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const mcp = new Client({ name: 'test', version: '1' });
  await mcp.connect(b);
  return mcp;
}

test('read_file returns PNG/JPEG/GIF/WebP as MCP images (canonical path, signature checked); text files unchanged', async () => {
  const sigs = { 'a.png': PNG, 'b.JPG': Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'c.gif': Buffer.from('GIF89a..'), 'd.webp': Buffer.from('RIFF\0\0\0\0WEBPVP8 ') };
  const f = fakeClient({ readFileBytes: p => ({ path: '/real' + p, base64: sigs[path.posix.basename(p)].toString('base64'), size: 4, sha256: 'h' }) });
  const mcp = await connect(f.client);
  for (const [name, type] of [['a.png', 'image/png'], ['b.JPG', 'image/jpeg'], ['c.gif', 'image/gif'], ['d.webp', 'image/webp']]) {
    const r = await mcp.callTool({ name: 'read_file', arguments: { file_path: `img/${name}` } });
    assert.equal(r.isError, undefined);
    assert.equal(r.content[0].text.startsWith(`/real/home/anas/ws/img/${name} (${type}`), true, r.content[0].text);
    assert.deepEqual([r.content[1].type, r.content[1].mimeType, r.content[1].data], ['image', type, sigs[name].toString('base64')]);
  }
  const t = await mcp.callTool({ name: 'read_file', arguments: { file_path: 'a.txt' } });
  assert.equal(t.content[0].text, 'text\n');
  assert.deepEqual(f.calls.map(c => c[0]), ['readFileBytes', 'readFileBytes', 'readFileBytes', 'readFileBytes', 'readFileDetails']);
  await mcp.close();
});

test('read_file images: wrong content refused; credential path not sent without approval; remote limit is a tool error; v5 remote: clear UNSUPPORTED', async () => {
  const f = fakeClient({ readFileBytes: p => {
    if (p.endsWith('big.png')) throw new RemoteFilesystemError('LIMIT_EXCEEDED', 'readFile', 'File is larger than 5242880 bytes.', 'LIMIT_EXCEEDED');
    return { path: p, base64: Buffer.from('not an image').toString('base64'), size: 12, sha256: '' };
  } });
  const mcp = await connect(f.client);
  const call = async a => { const r = await mcp.callTool({ name: 'read_file', arguments: a }); return [!!r.isError, r.content[0].text.split(':')[0]]; };
  assert.deepEqual(await call({ file_path: 'fake.png' }), [true, 'INVALID_REQUEST']);
  assert.deepEqual(await call({ file_path: '~/.ssh/key.png' }), [true, 'SENSITIVE_PATH_NOT_APPROVED']);
  assert.deepEqual((await call({ file_path: 'big.png' }))[0], true);
  assert.deepEqual(f.calls.map(c => c[1]), ['/home/anas/ws/fake.png', '/home/anas/ws/big.png']);
  await mcp.close();
  const old = fakeClient();
  const mcp5 = await connect(old.client, { ...HOST6, apiVersion: 5 });
  const r = await mcp5.callTool({ name: 'read_file', arguments: { file_path: 'a.png' } });
  assert.deepEqual([r.isError, /^UNSUPPORTED: .*claude-agent-remote 0\.6\.0/.test(r.content[0].text), old.calls.length], [true, true, 0]);
  assert.equal((await mcp5.callTool({ name: 'read_file', arguments: { file_path: 'a.txt' } })).content[0].text, 'text\n');
  await mcp5.close();
});

test('search_files: glob pattern (v6), query, both; neither is refused; v5 remote refuses patterns clearly but keeps query', async () => {
  const f = fakeClient();
  const mcp = await connect(f.client);
  const call = async a => { const r = await mcp.callTool({ name: 'search_files', arguments: a }); return [!!r.isError, r.content[0].text.split(':')[0]]; };
  assert.equal((await call({ pattern: '**/*.ts', path: '/srv/other' }))[0], false);
  assert.equal((await call({ query: 'a', pattern: 'src/*.ts' }))[0], false);
  assert.equal((await call({ query: 'a' }))[0], false);
  assert.deepEqual(await call({}), [true, 'INVALID_REQUEST']);
  assert.deepEqual(f.calls, [
    ['searchFiles', '', { path: '/srv/other', maxResults: undefined, allowSensitive: false, pattern: '**/*.ts' }],
    ['searchFiles', 'a', { path: '/home/anas/ws', maxResults: undefined, allowSensitive: false, pattern: 'src/*.ts' }],
    ['searchFiles', 'a', { path: '/home/anas/ws', maxResults: undefined, allowSensitive: false, pattern: undefined }],
  ]);
  await mcp.close();
  const old = fakeClient();
  const mcp5 = await connect(old.client, { ...HOST6, apiVersion: 5 });
  const r = await mcp5.callTool({ name: 'search_files', arguments: { pattern: '*.ts' } });
  assert.deepEqual([r.isError, /^UNSUPPORTED/.test(r.content[0].text), old.calls.length], [true, true, 0]);
  assert.equal((await mcp5.callTool({ name: 'search_files', arguments: { query: 'a' } })).isError, undefined);
  await mcp5.close();
});

test('client: readFileBytes sends encoding base64 and rejects a text reply (v5 remote); searchFiles sends pattern only when given', async () => {
  const sent = [];
  let reply = { path: '/w/a.png', content: PNG.toString('base64'), sha256: 'h', encoding: 'base64', size: PNG.length };
  const client = clientMod.createRemoteFilesystemClient({ getRemoteName: () => 'ssh-remote', timeoutMs: 1000,
    executeCommand: async (cmd, req) => { sent.push([cmd, req]); return { success: true, data: cmd.endsWith('searchFiles') ? [] : reply }; } });
  assert.deepEqual(await client.readFileBytes('/w/a.png'), { path: '/w/a.png', base64: PNG.toString('base64'), size: PNG.length, sha256: 'h' });
  reply = { path: '/w/a.png', content: '\uFFFDPNG', sha256: 'h' };
  await assert.rejects(client.readFileBytes('/w/a.png', { allowSensitive: true }), e => e.code === 'MALFORMED_RESPONSE' && /0\.6\.0/.test(e.message));
  await client.searchFiles('', { path: '/w', pattern: '**/*.c' });
  await client.searchFiles('q', { path: '/w' });
  assert.deepEqual(sent.map(s => s[1]), [
    { path: '/w/a.png', encoding: 'base64' }, { path: '/w/a.png', encoding: 'base64', allowSensitive: true },
    { pattern: '**/*.c', path: '/w', maxResults: undefined, exclude: undefined }, { query: 'q', path: '/w', maxResults: undefined, exclude: undefined }]);
});

// ---- project instructions ----

test('project instructions: CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md; missing skipped; 40 KB cap; other errors reported', async () => {
  const big = 'é'.repeat(30000);   // 60000 bytes
  const files = { '/home/anas/ws/CLAUDE.md': 'Use tabs.', '/home/anas/ws/CLAUDE.local.md': big };
  const errors = [];
  const client = { readFileDetails: async p => {
    if (p === '/home/anas/ws/.claude/CLAUDE.md') throw new RemoteFilesystemError('NOT_FOUND', 'readFile', 'missing', 'NOT_FOUND');
    return { content: files[p], sha256: 'h', path: p };
  } };
  const got = await mode.loadProjectInstructions(client, HOST6, (f, e) => errors.push(f));
  assert.deepEqual(got.map(g => [g.path, g.truncated]), [['/home/anas/ws/CLAUDE.md', false], ['/home/anas/ws/CLAUDE.local.md', true]]);
  assert.ok(Buffer.byteLength(got[1].content) <= 40 * 1024 && !got[1].content.endsWith('\uFFFD'));
  assert.deepEqual(errors, []);
  const failing = { readFileDetails: async () => { throw new RemoteFilesystemError('PERMISSION_DENIED', 'readFile', 'no', 'PERMISSION_DENIED'); } };
  assert.deepEqual(await mode.loadProjectInstructions(failing, HOST6, f => errors.push(f)), []);
  assert.equal(errors.length, 3);
  const win = []; await mode.loadProjectInstructions({ readFileDetails: async p => { win.push(p); throw new RemoteFilesystemError('NOT_FOUND', 'readFile', 'x', 'NOT_FOUND'); } }, { ...HOST6, platform: 'win32', root: 'C:\\ws' });
  assert.deepEqual(win, ['C:\\ws\\CLAUDE.md', 'C:\\ws\\.claude\\CLAUDE.md', 'C:\\ws\\CLAUDE.local.md']);
  const server = serverMod.createRemoteWorkspaceServer(sdk, fakeClient().client, HOST6);
  const prompt = mode.remoteQueryOptions(server, HOST6, got).systemPrompt.append;
  assert.match(prompt, /<project-instructions path="\/home\/anas\/ws\/CLAUDE\.md">\nUse tabs\.\n<\/project-instructions>/);
  assert.match(prompt, /cut at 40 KB/);
  assert.ok(!/project-instructions/.test(mode.remoteQueryOptions(server, HOST6).systemPrompt.append));
});

// ---- sub-agents ----

test('remote sub-agents: Agent/Task allowed; remote agents have only remote (and web) tools; local tools stay denied', () => {
  const server = serverMod.createRemoteWorkspaceServer(sdk, fakeClient().client, HOST6);
  const o = mode.remoteQueryOptions(server, HOST6);
  assert.ok(o.tools.includes('Agent') && o.tools.includes('Task'));
  assert.ok(!o.disallowedTools.includes('Agent') && o.disallowedTools.includes('Bash') && o.disallowedTools.includes('Read'));
  const local = new Set(mode.LOCAL_ONLY_NATIVE_TOOLS);
  for (const [name, a] of Object.entries(o.agents)) {
    assert.ok(a.tools.every(t => t.startsWith('mcp__remote__') || ['WebFetch', 'WebSearch', 'TodoWrite'].includes(t)), name);
    assert.ok(!a.tools.some(t => local.has(t)), name);
  }
  assert.ok(o.agents['remote-explore'].tools.every(t => !t.startsWith('mcp__remote__') || mode.REMOTE_READ_TOOLS.includes(t)));
  assert.deepEqual(['Agent', 'Task', 'Bash', 'Read', 'Skill', 'mcp__other__x'].map(mode.isToolAllowedInRemoteMode), [true, true, false, false, false, false]);
});

// ---- remote editor context and attachments ----

test('remote editor context: file or selection of this host (any path) is sent as text; other hosts and local files are not; attachments any path', async () => {
  const bundle = await buildExtension();
  const folder = uri('vscode-remote', 'ssh-remote+h', '/home/anas/ws');
  const { ext, vscode, commands } = loadExtension(bundle, { remoteName: 'ssh-remote', remoteSsh: true, folder,
    hostInfo: { hostname: 'h', platform: 'linux', arch: 'x64', workspaceRoot: '/home/anas/ws', apiVersion: 6, homeDirectory: '/home/anas' } });
  const { chat } = ext.activate(makeContext(fs.mkdtempSync(path.join(os.tmpdir(), 'edctx-'))));
  const panel = [];
  chat.view = { webview: { postMessage: async m => { panel.push(m); return true; } } };
  const prompts = [];
  chat.scheduler.requestSend = (_s, args) => { prompts.push(args.prompt); return 'op'; };
  const editor = (u, sel) => ({ document: { uri: u, getText: () => 'int x;' }, selection: sel ?? { isEmpty: true } });
  const sel = { isEmpty: false, start: { line: 4 }, end: { line: 6 } };

  vscode.window.activeTextEditor = editor(uri('vscode-remote', 'ssh-remote+h', '/home/anas/ws/src/a.cpp'));
  await chat.send(chat.active, 'q1', true);
  vscode.window.activeTextEditor = editor(uri('vscode-remote', 'ssh-remote+h', '/srv/other/b.cpp'), sel);
  chat.newChat(); await chat.send(chat.active, 'q2', true);
  chat.postActiveFile();
  vscode.window.activeTextEditor = editor(uri('vscode-remote', 'ssh-remote+other', '/home/anas/ws/c.cpp'));
  chat.newChat(); await chat.send(chat.active, 'q3', true);
  vscode.window.activeTextEditor = editor(uri('file', '', '/home/me/local.cpp'));
  chat.newChat(); await chat.send(chat.active, 'q4', true);
  chat.postActiveFile();
  vscode.window.activeTextEditor = editor(uri('vscode-remote', 'ssh-remote+h', '/home/anas/ws/src/a.cpp'));
  chat.newChat(); await chat.send(chat.active, 'q5', false);
  // A selection is sent without the "current file" toggle; still only for this host.
  vscode.window.activeTextEditor = editor(uri('vscode-remote', 'ssh-remote+h', '/srv/other/b.cpp'), sel);
  chat.newChat(); await chat.send(chat.active, 'q6', false);
  vscode.window.activeTextEditor = editor(uri('vscode-remote', 'ssh-remote+other', '/srv/other/b.cpp'), sel);
  chat.newChat(); await chat.send(chat.active, 'q7', false);
  assert.deepEqual(prompts, [
    'q1\n\n(Current file: /home/anas/ws/src/a.cpp)',
    'q2\n\n(Selection in /srv/other/b.cpp lines 5-7:)\n```\nint x;\n```',
    'q3', 'q4', 'q5',
    'q6\n\n(Selection in /srv/other/b.cpp lines 5-7:)\n```\nint x;\n```',
    'q7']);
  assert.deepEqual(panel.filter(m => m.type === 'activeFile').map(m => m.name).slice(-2), ['b.cpp', '']);

  panel.length = 0;
  await commands.get('claudeIde.dropResources')([
    'vscode-remote://ssh-remote+h/srv/other/x.h', 'vscode-remote://ssh-remote+h/home/anas/ws/y.h',
    'vscode-remote://ssh-remote+evil/etc/passwd', 'file:///home/me/z.h', '/not/a/uri', 'vscode-remote://ssh-remote+h/']);
  assert.deepEqual(panel.filter(m => m.type === 'addRef').map(m => m.ref.path), ['/srv/other/x.h', 'y.h']);
  assert.match(panel.find(m => m.type === 'note').text, /^4 item\(s\) not added/);
  ext.deactivate();
});

test('remote sub-agent input: always foreground; permission mode, isolation and team fields removed; other fields kept', () => {
  assert.deepEqual(mode.sanitizeAgentInput({ description: 'd', prompt: 'p', subagent_type: 'remote-general', model: 'haiku', name: 'n', run_in_background: true, mode: 'bypassPermissions', isolation: 'worktree', team_name: 't' }),
    { description: 'd', prompt: 'p', subagent_type: 'remote-general', model: 'haiku', name: 'n', run_in_background: false });
  assert.deepEqual(mode.sanitizeAgentInput({ prompt: 'p', isolation: 'remote', mode: 'dontAsk' }), { prompt: 'p', run_in_background: false });
  assert.deepEqual(mode.sanitizeAgentInput(undefined), { run_in_background: false });
  const src = fs.readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
  assert.match(src, /SUBAGENT_TOOLS\.includes\(i\.tool_name\)\) \{\s*\n\s*return \{ hookSpecificOutput: \{ hookEventName: 'PreToolUse', permissionDecision: s\.mode === 'auto' \? 'allow' : 'ask'.*updatedInput: sanitizeAgentInput\(t\)/);
  assert.match(src, /SUBAGENT_TOOLS\.includes\(name\)\) input = sanitizeAgentInput\(input\)/);
});

test('real UI path (webview "send" message, toggle off): remote selection is sent, with or without a workspace folder; other hosts and local files never', async () => {
  const bundle = await buildExtension();
  for (const folder of [uri('vscode-remote', 'ssh-remote+contabo', '/home/anas/ws'), undefined]) {
    const { ext, vscode } = loadExtension(bundle, { remoteName: 'ssh-remote', remoteSsh: true, folder,
      hostInfo: { hostname: 'h', platform: 'linux', arch: 'x64', workspaceRoot: folder ? folder.path : null, apiVersion: 6, homeDirectory: '/home/anas' } });
    const { chat } = ext.activate(makeContext(fs.mkdtempSync(path.join(os.tmpdir(), 'uipath-'))));
    const panel = [];
    chat.view = { webview: { postMessage: async m => { panel.push(m); return true; } } };
    const prompts = [];
    chat.scheduler.requestSend = (_s, a) => { prompts.push(a.prompt); return 'op'; };
    const sendFromWebview = async (doc, isEmpty = false) => {
      vscode.window.activeTextEditor = { document: { uri: doc, getText: () => 'int main();' }, selection: { isEmpty, start: { line: 2 }, end: { line: 4 } } };
      chat.newChat();
      await chat.onMessage({ type: 'send', conversationId: chat.active.conversationId, text: 'explain', attach: false, images: [], refs: [] });
    };
    await sendFromWebview(uri('vscode-remote', 'ssh-remote+contabo', '/home/anas/ws/src/main.cpp'));
    await sendFromWebview(uri('vscode-remote', 'ssh-remote+contabo', '/srv/elsewhere/x.cpp'));
    await sendFromWebview(uri('vscode-remote', 'ssh-remote+contabo', '/home/anas/ws/src/main.cpp'), true);   // no selection, toggle off: unchanged
    await sendFromWebview(uri('vscode-remote', 'wsl+Ubuntu', '/home/anas/ws/src/main.cpp'));
    await sendFromWebview(uri('file', '', '/home/me/local.cpp'));
    const sel = p => `explain\n\n(Selection in ${p} lines 3-5:)\n\`\`\`\nint main();\n\`\`\``;
    assert.deepEqual(prompts, [sel('/home/anas/ws/src/main.cpp'), sel('/srv/elsewhere/x.cpp'), 'explain', 'explain', 'explain'], folder ? 'with folder' : 'no folder');
    vscode.window.activeTextEditor = { document: { uri: uri('vscode-remote', 'ssh-remote+contabo', '/srv/elsewhere/x.cpp') }, selection: { isEmpty: true } };
    chat.postActiveFile();
    assert.equal(panel.filter(m => m.type === 'activeFile').at(-1).name, 'x.cpp');
    ext.deactivate();
  }
});

test('selection chip, extension side (webview "send", toggle off): local window sends a local selection; Remote-SSH only this host; removed chip; ranges', async () => {
  const bundle = await buildExtension();
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selchip-ws-'));
  const run = async ({ folder, remoteName, remoteSsh, hostInfo }, cases) => {
    const { ext, vscode } = loadExtension(bundle, { folder, remoteName, remoteSsh, hostInfo });
    const { chat } = ext.activate(makeContext(fs.mkdtempSync(path.join(os.tmpdir(), 'selchip-'))));
    const panel = [];
    chat.view = { webview: { postMessage: async m => { panel.push(m); return true; } } };
    const prompts = [];
    chat.scheduler.requestSend = (_s, a) => { prompts.push(a.prompt); return 'op'; };
    const out = [];
    for (const { doc, sel, attach = false, selection } of cases) {
      vscode.window.activeTextEditor = { document: { uri: doc, getText: () => 'code();' }, selection: sel ?? { isEmpty: true } };
      chat.postActiveFile();
      const posted = panel.filter(m => m.type === 'activeFile').at(-1);
      chat.newChat();
      await chat.onMessage({ type: 'send', conversationId: chat.active.conversationId, text: 'q', attach, images: [], refs: [], ...(selection === undefined ? {} : { selection }) });
      out.push([posted.name, posted.lines, prompts.at(-1)]);
    }
    ext.deactivate();
    return out;
  };
  const sel = (a, b, endChar = 4) => ({ isEmpty: false, start: { line: a, character: 0 }, end: { line: b, character: endChar } });
  const block = (ref, a, b) => `q\n\n(Selection in ${ref} lines ${a}-${b}:)\n\`\`\`\ncode();\n\`\`\``;

  // Local window: local files only, "@" relative reference.
  const local = await run({ folder: uri('file', '', wsDir) }, [
    { doc: uri('file', '', path.join(wsDir, 'src/main.cpp')), sel: sel(52, 63) },
    { doc: uri('file', '', path.join(wsDir, 'src/main.cpp')), sel: sel(52, 64, 0) },             // ends at column 0 of line 65
    { doc: uri('file', '', path.join(wsDir, 'src/main.cpp')), sel: sel(52, 63), selection: false }, // chip removed
    { doc: uri('file', '', path.join(wsDir, 'src/main.cpp')), attach: true },                      // no selection: toggle as before
    { doc: uri('file', '', path.join(wsDir, 'src/main.cpp')) },
    { doc: uri('vscode-remote', 'ssh-remote+contabo', '/home/anas/x.cpp'), sel: sel(1, 2) },      // never in a local window
    { doc: uri('untitled', '', 'Untitled-1'), sel: sel(1, 2) },
  ]);
  assert.deepEqual(local, [
    ['main.cpp', [53, 64], block('@src/main.cpp', 53, 64)],
    ['main.cpp', [53, 64], block('@src/main.cpp', 53, 64)],
    ['main.cpp', [53, 64], 'q'],
    ['main.cpp', null, 'q\n\n(Current file: @src/main.cpp)'],
    ['main.cpp', null, 'q'],
    ['', null, 'q'],
    ['', null, 'q'],
  ]);

  // Remote-SSH window: documents of this host only (absolute remote path); local files and other hosts never.
  const remote = await run({ folder: uri('vscode-remote', 'ssh-remote+contabo', '/home/anas/ws'), remoteName: 'ssh-remote', remoteSsh: true,
    hostInfo: { hostname: 'h', platform: 'linux', arch: 'x64', workspaceRoot: '/home/anas/ws', apiVersion: 6, homeDirectory: '/home/anas' } }, [
    { doc: uri('vscode-remote', 'ssh-remote+contabo', '/home/anas/ws/a.cpp'), sel: sel(9, 11) },
    { doc: uri('vscode-remote', 'ssh-remote+contabo', '/home/anas/ws/a.cpp'), sel: sel(9, 11), selection: false },
    { doc: uri('vscode-remote', 'ssh-remote+other', '/home/anas/ws/a.cpp'), sel: sel(9, 11) },
    { doc: uri('file', '', path.join(wsDir, 'local.cpp')), sel: sel(9, 11) },
  ]);
  assert.deepEqual(remote, [
    ['a.cpp', [10, 12], block('/home/anas/ws/a.cpp', 10, 12)],
    ['a.cpp', [10, 12], 'q'],
    ['', null, 'q'],
    ['', null, 'q'],
  ]);
});

test('selection changes in the active editor update the chip (debounced); other editors are ignored', async () => {
  const bundle = await buildExtension();
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selchg-ws-'));
  const { ext, vscode } = loadExtension(bundle, { folder: uri('file', '', wsDir) });
  let onSel;
  vscode.window.onDidChangeTextEditorSelection = fn => { onSel = fn; return { dispose() { } }; };
  const { chat } = ext.activate(makeContext(fs.mkdtempSync(path.join(os.tmpdir(), 'selchg-'))));
  const panel = [];
  chat.view = { webview: { postMessage: async m => { panel.push(m); return true; } } };
  const active = { document: { uri: uri('file', '', path.join(wsDir, 'a.cpp')) }, selection: { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 2, character: 1 } } };
  vscode.window.activeTextEditor = active;
  onSel({ textEditor: { document: { uri: uri('file', '', path.join(wsDir, 'b.cpp')) } } });   // not the active editor
  for (let i = 0; i < 5; i++) onSel({ textEditor: active });                                    // a drag: one update
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(panel.filter(m => m.type === 'activeFile').map(m => [m.name, m.lines]), [['a.cpp', [1, 3]]]);
  ext.deactivate();
});
