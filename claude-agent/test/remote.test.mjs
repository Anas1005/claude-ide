// Remote-SSH mode (Stage 2A): path boundary, client error mapping and timeout, MCP tool registration and behaviour
// against the real installed SDK, remote query options, and the default-off feature flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { readFileSync } from 'fs';
import { loadModules, ROOT } from './helpers/build.mjs';

const [paths, clientMod, serverMod, mode] = await loadModules(
  'src/remote/remotePaths.ts', 'src/remote/remoteFilesystemClient.ts', 'src/remote/remoteWorkspaceServer.ts', 'src/remote/remoteMode.ts');
const sdk = await import('@anthropic-ai/claude-agent-sdk');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

const { RemoteFilesystemError, createRemoteFilesystemClient } = clientMod;

// ---- remote path boundary ----

test('remote paths (API v5): absolute paths anywhere, relative to the workspace root, ~ as the remote home', () => {
  const conv = p => paths.toRemotePath(p, '/home/anas/ws', 'linux', '/home/anas');
  assert.deepEqual(
    ['/home/anas/ws/src/a.ts', 'src/a.ts', './src//a.ts', '/home/anas/ws', '/home/anas/ws/', '', undefined, '.', 'a/../b',
     '../other/x', '/etc/hosts', '/home/anas/ws-other/x', '~', '~/proj/y', '/'].map(conv),
    ['/home/anas/ws/src/a.ts', '/home/anas/ws/src/a.ts', '/home/anas/ws/src/a.ts', '/home/anas/ws', '/home/anas/ws', '/home/anas/ws', '/home/anas/ws',
     '/home/anas/ws', '/home/anas/ws/b', '/home/anas/other/x', '/etc/hosts', '/home/anas/ws-other/x', '/home/anas', '/home/anas/proj/y', '/']
      .map(p => ({ ok: true, path: p })));
  assert.deepEqual([conv('a\0b').ok, paths.toRemotePath('~/x', '/srv/ws', 'linux').ok], [false, false]);   // NUL; ~ without a known home
  assert.deepEqual([paths.isUnder('/srv/ws/a', '/srv/ws', 'linux'), paths.isUnder('/srv/ws', '/srv/ws', 'linux'), paths.isUnder('/srv/ws-x', '/srv/ws', 'linux')], [true, true, false]);
});

test('remote paths follow the platform the remote host reports, not this machine', () => {
  const win = p => paths.toRemotePath(p, 'C:\\work\\ws', 'win32');
  assert.deepEqual([win('C:\\work\\ws\\src\\a.ts'), win('D:\\x'), win('..\\x'), win('src/a.ts')],
    [{ ok: true, path: 'C:\\work\\ws\\src\\a.ts' }, { ok: true, path: 'D:\\x' }, { ok: true, path: 'C:\\work\\x' }, { ok: true, path: 'C:\\work\\ws\\src\\a.ts' }]);
  // A Windows-looking path on a Linux host is just a relative name, never a local drive.
  assert.deepEqual(paths.toRemotePath('C:\\x', '/srv/ws', 'linux'), { ok: true, path: '/srv/ws/C:\\x' });
  assert.equal(paths.toRemoteAbsolute('src/a.ts', '/srv/ws', 'linux'), '/srv/ws/src/a.ts');
  assert.equal(paths.toRemoteAbsolute('/elsewhere/a.ts', '/srv/ws', 'linux'), '/elsewhere/a.ts');
  assert.equal(paths.toRemoteAbsolute('src/a.ts', 'C:\\ws', 'win32'), 'C:\\ws\\src\\a.ts');
});

// ---- client: error mapping and timeout ----

const env = (respond, extra = {}) => {
  const calls = [];
  return { calls, env: { getRemoteName: () => 'ssh-remote', executeCommand: async (c, r) => { calls.push([c, r]); return respond(c, r); }, timeoutMs: 1000, ...extra } };
};
const errorOf = async promise => { try { await promise; return 'resolved'; } catch (e) { return e instanceof RemoteFilesystemError ? [e.operation, e.code, e.remoteCode] : String(e); } };

test('client maps every failure to a typed error and never treats one as success', async () => {
  const fail = code => () => ({ success: false, error: { code, message: 'm' } });
  const results = await Promise.all([
    errorOf(createRemoteFilesystemClient(env(fail('NOT_FOUND')).env).readFile('x')),
    errorOf(createRemoteFilesystemClient(env(fail('SOMETHING_NEW')).env).readFile('x')),
    errorOf(createRemoteFilesystemClient(env(() => undefined).env).listDirectory()),
    errorOf(createRemoteFilesystemClient(env(() => ({ entries: [] })).env).listDirectory()),
    errorOf(createRemoteFilesystemClient(env(() => ({ success: true, data: [{ name: 1 }] })).env).listDirectory()),
    errorOf(createRemoteFilesystemClient(env(() => { throw new Error("command 'claudeIde.remote.fs.stat' not found"); }).env).stat('.')),
    errorOf(createRemoteFilesystemClient(env(() => { throw new Error('host crashed'); }).env).stat('.')),
    errorOf(createRemoteFilesystemClient(env(() => ({ hostname: 'h', platform: 'linux' })).env).getInfo()),
  ]);
  assert.deepEqual(results, [
    ['readFile', 'NOT_FOUND', 'NOT_FOUND'],
    ['readFile', 'MALFORMED_RESPONSE', 'SOMETHING_NEW'],
    ['listDirectory', 'MALFORMED_RESPONSE', undefined],
    ['listDirectory', 'MALFORMED_RESPONSE', undefined],
    ['listDirectory', 'MALFORMED_RESPONSE', undefined],
    ['stat', 'REMOTE_NOT_AVAILABLE', undefined],
    ['stat', 'REMOTE_COMMAND_FAILED', undefined],
    ['getInfo', 'MALFORMED_RESPONSE', undefined],
  ]);
});

test('client times out a hanging bridge call', async () => {
  const started = Date.now();
  const result = await errorOf(createRemoteFilesystemClient(env(() => new Promise(() => { }), { timeoutMs: 50 }).env).readFile('x'));
  assert.deepEqual(result, ['readFile', 'REMOTE_TIMEOUT', undefined]);
  assert.ok(Date.now() - started < 1000);
});

test('client refuses to run outside Remote-SSH and never calls the bridge then', async () => {
  for (const remoteName of [undefined, 'wsl']) {
    const e = env(() => ({ success: true, data: [] }), { getRemoteName: () => remoteName });
    assert.deepEqual(await errorOf(createRemoteFilesystemClient(e.env).listDirectory()), ['listDirectory', 'REMOTE_NOT_AVAILABLE', undefined]);
    assert.equal(e.calls.length, 0);
  }
});

// ---- MCP server: registration and behaviour through a real MCP client ----

/** A fake RemoteFilesystemClient recording what the tools asked for; `results` overrides a method's result (a function is called). */
function fakeClient(results = {}) {
  const calls = [];
  const defaults = {
    getInfo: { hostname: 'contabo', platform: 'linux', arch: 'x64', workspaceRoot: '/home/anas/ws' },
    readFile: 'l1\nl2\nl3\nl4\n',
    readFileDetails: { content: 'l1\nl2\nl3\nl4\n', sha256: 'h1' },
    writeFile: () => { throw new Error('must never be called'); },
    listDirectory: [{ name: 'src', path: '/home/anas/ws/src', type: 'directory' }],
    stat: { path: '/home/anas/ws/a.ts', name: 'a.ts', type: 'file', size: 3, modifiedAt: 't', createdAt: 't' },
    searchFiles: [{ name: 'a.ts', path: '/home/anas/ws/src/a.ts', type: 'file' }],
  };
  const client = {};
  for (const [name, value] of Object.entries({ ...defaults, ...results })) {
    client[name] = async (...args) => { calls.push([name, ...args]); return typeof value === 'function' ? value(...args) : value; };
  }
  return { calls, client };
}
const HOST = { hostname: 'contabo', platform: 'linux', root: '/home/anas/ws', apiVersion: 5, home: '/home/anas' };

async function connect(client) {
  const server = serverMod.createRemoteWorkspaceServer(sdk, client, HOST);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const mcp = new Client({ name: 'test', version: '1' });
  await mcp.connect(b);
  return { server, mcp };
}
const text = r => ({ isError: !!r.isError, text: r.content[0].text });

test('MCP server registers the 15 remote tools, always loaded, read-only ones marked', async () => {
  const { server, mcp } = await connect(fakeClient().client);
  assert.equal(server.type, 'sdk');
  assert.equal(server.name, 'remote');
  const { tools } = await mcp.listTools();
  assert.deepEqual(tools.map(t => [t.name, t.annotations?.readOnlyHint, t._meta?.['anthropic/alwaysLoad']]).sort(), [
    ['apply_patch', false, true], ['execute_command', false, true], ['file_operation', false, true],
    ['git_diff', true, true], ['git_log', true, true], ['git_operation', false, true], ['git_status', true, true],
    ['list_directory', true, true], ['process_status', true, true], ['read_file', true, true], ['search_content', true, true],
    ['search_files', true, true], ['stat', true, true], ['terminate_process', false, true], ['write_file', false, true]]);
  assert.deepEqual(Object.keys(tools.find(t => t.name === 'read_file').inputSchema.properties).sort(), ['file_path', 'limit', 'offset']);
  await mcp.close();
});

test('MCP tools convert paths, call the client, and return absolute remote paths', async () => {
  const f = fakeClient();
  const { mcp } = await connect(f.client);
  const call = (name, args) => mcp.callTool({ name, arguments: args }).then(text);
  const results = [
    await call('read_file', { file_path: '/home/anas/ws/src/a.ts' }),
    await call('read_file', { file_path: 'src/a.ts', offset: 2, limit: 2 }),
    await call('list_directory', {}),
    await call('stat', { file_path: 'a.ts' }),
    await call('search_files', { query: 'a.ts', path: '/home/anas/ws/src', max_results: 5 }),
  ];
  assert.deepEqual(results.map(r => r.isError), [false, false, false, false, false]);
  assert.equal(results[0].text, 'l1\nl2\nl3\nl4\n');
  assert.equal(results[1].text, 'l2\nl3');
  assert.deepEqual(JSON.parse(results[2].text), [{ name: 'src', path: '/home/anas/ws/src', type: 'directory' }]);
  assert.equal(JSON.parse(results[3].text).path, '/home/anas/ws/a.ts');
  assert.deepEqual(f.calls, [
    ['readFileDetails', '/home/anas/ws/src/a.ts', { allowSensitive: false }], ['readFileDetails', '/home/anas/ws/src/a.ts', { allowSensitive: false }],
    ['listDirectory', '/home/anas/ws', { allowSensitive: false }], ['stat', '/home/anas/ws/a.ts', { allowSensitive: false }],
    ['searchFiles', 'a.ts', { path: '/home/anas/ws/src', maxResults: 5, allowSensitive: false, pattern: undefined }],
  ]);
  await mcp.close();
});

test('MCP tools reach paths outside the workspace; credential locations need an approval; remote errors are tool errors', async () => {
  const f = fakeClient({ stat: () => { throw new RemoteFilesystemError('NOT_FOUND', 'stat', 'Path does not exist.', 'NOT_FOUND'); } });
  const { mcp } = await connect(f.client);
  const call = (name, args) => mcp.callTool({ name, arguments: args }).then(text);
  const results = [
    await call('read_file', { file_path: '../../etc/hosts' }),
    await call('read_file', { file_path: '/etc/hosts' }),
    await call('list_directory', { path: '/home/anas/ws/../other' }),
    await call('stat', { file_path: 'missing.txt' }),
    await call('read_file', { file_path: '~/.ssh/id_ed25519' }),   // not approved: never sent
  ];
  assert.deepEqual(results.map(r => [r.isError, r.text.split(':')[0]]),
    [[false, 'l1\nl2\nl3\nl4\n'], [false, 'l1\nl2\nl3\nl4\n'], [false, '[\n {\n  "name"'], [true, 'NOT_FOUND'], [true, 'SENSITIVE_PATH_NOT_APPROVED']]);
  assert.deepEqual(f.calls.map(c => c.slice(0, 2)), [['readFileDetails', '/home/etc/hosts'], ['readFileDetails', '/etc/hosts'], ['listDirectory', '/home/anas/other'], ['stat', '/home/anas/ws/missing.txt']]);
  await mcp.close();
});

test('MCP tools refuse clearly when the remote extension is older than API v5', async () => {
  const f = fakeClient();
  const server = serverMod.createRemoteWorkspaceServer(sdk, f.client, { ...HOST, apiVersion: 4 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const mcp = new Client({ name: 'test', version: '1' });
  await mcp.connect(b);
  const r = text(await mcp.callTool({ name: 'read_file', arguments: { file_path: 'a.ts' } }));
  assert.deepEqual([r.isError, r.text.split(':')[0], /claude-agent-remote 0\.5\.0/.test(r.text), f.calls], [true, 'UNSUPPORTED', true, []]);
  await mcp.close();
});

test('a new MCP server instance is created for every call', () => {
  const a = serverMod.createRemoteWorkspaceServer(sdk, fakeClient().client, HOST);
  const b = serverMod.createRemoteWorkspaceServer(sdk, fakeClient().client, HOST);
  assert.notEqual(a.instance, b.instance);
});

// ---- remote mode policy ----

test('feature flag: on by default; only Remote-SSH can enable remote mode; other remotes keep the guard', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const setting = pkg.contributes.configuration.properties['claudeIde.experimental.remoteSsh'];
  assert.deepEqual([setting.default, setting.scope], [true, 'application']);
  assert.deepEqual([
    mode.workspaceMode(undefined, false), mode.workspaceMode(undefined, true),
    mode.workspaceMode('ssh-remote', false), mode.workspaceMode('ssh-remote', true),
    mode.workspaceMode('wsl', true), mode.workspaceMode('dev-container', true),
  ], ['local', 'local', 'guard', 'remoteSsh', 'guard', 'guard']);
});

test('remote query options: only safe built-ins, local file/shell tools removed, read-only remote tools auto-allowed, strict MCP', () => {
  const server = serverMod.createRemoteWorkspaceServer(sdk, fakeClient().client, HOST);
  const { mcpServers, systemPrompt, agents, ...rest } = mode.remoteQueryOptions(server, HOST);
  assert.deepEqual(Object.keys(agents), ['remote-general', 'remote-explore']);
  assert.deepEqual(rest, {
    settingSources: ['user'],
    tools: ['AskUserQuestion', 'TodoWrite', 'EnterPlanMode', 'ExitPlanMode', 'WebFetch', 'WebSearch', 'Agent', 'Task'],
    disallowedTools: ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'Bash', 'Monitor', 'EnterWorktree', 'ExitWorktree', 'Skill', 'Workflow'],
    allowedTools: ['read_file', 'list_directory', 'stat', 'search_files', 'search_content', 'git_status', 'git_diff', 'git_log', 'process_status'].map(t => `mcp__remote__${t}`),
    strictMcpConfig: true,
  });
  assert.deepEqual(Object.keys(mcpServers), ['remote']);
  assert.equal(mcpServers.remote, server);
  assert.equal(systemPrompt.preset, 'claude_code');
  assert.match(systemPrompt.append, /remote linux host \("contabo"\).*root is \/home\/anas\/ws.*home directory is \/home\/anas.*other projects.*execute_command/s);
  assert.ok(!rest.tools.some(t => rest.disallowedTools.includes(t)));
  assert.deepEqual(['Read', 'Bash', 'Write', 'mcp__remote__write_file', 'mcp__remote__execute_command', 'mcp__other__x', 'WebSearch', 'mcp__remote__nope'].map(mode.isToolAllowedInRemoteMode),
    [false, false, false, true, true, false, true, false]);
  assert.equal(mode.REMOTE_TOOLS.length, 15);
});

test('placeholder cwd: local path under global storage, separate per remote authority and workspace', () => {
  const storage = path.join(os.tmpdir(), 'claude-agent-storage');
  const a = mode.remotePlaceholderDir(storage, 'ssh-remote+contabo', '/home/anas/ws');
  assert.equal(path.dirname(a), path.join(storage, 'remote-workspaces'));
  assert.match(path.basename(a), /^[0-9a-f]{32}$/);
  assert.equal(mode.remotePlaceholderDir(storage, 'ssh-remote+contabo', '/home/anas/ws'), a);
  assert.notEqual(mode.remotePlaceholderDir(storage, 'ssh-remote+office', '/home/anas/ws'), a);
  assert.notEqual(mode.remotePlaceholderDir(storage, 'ssh-remote+contabo', '/home/anas/other'), a);
  assert.ok(!a.includes('/home/anas/ws'));
});


test('client: a missing remote extension (or a non-SSH window) is reported, so cached remote facts are dropped', async () => {
  let dropped = 0;
  const env = (remoteName, executeCommand) => createRemoteFilesystemClient({ getRemoteName: () => remoteName, executeCommand, timeoutMs: 1000, onRemoteNotAvailable: () => { dropped++; } });
  const missing = env('ssh-remote', async () => { throw new Error("command 'claudeIde.remote.getInfo' not found"); });
  await assert.rejects(missing.getInfo(), e => e instanceof RemoteFilesystemError && e.code === 'REMOTE_NOT_AVAILABLE');
  await assert.rejects(env(undefined, async () => ({})).readFile('a'), e => e.code === 'REMOTE_NOT_AVAILABLE');
  await assert.rejects(env('ssh-remote', async () => { throw new Error('boom'); }).readFile('a'), e => e.code === 'REMOTE_COMMAND_FAILED');
  assert.equal(dropped, 2);   // not for other failures
});
