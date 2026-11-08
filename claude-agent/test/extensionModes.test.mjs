// Activates the production bundle of the extension (SDK included) under a stub `vscode`, sends one prompt, and
// captures what the installed SDK actually hands the Claude CLI: arguments, working directory and the initialize
// request. The CLI itself is never started (child_process.spawn is intercepted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import { buildExtension } from './helpers/build.mjs';
import { loadExtension as loadWith, makeContext, uri } from './helpers/vscodeStub.mjs';

const require = createRequire(import.meta.url);
const Module = require('module');
const cp = require('child_process');
const bundle = await buildExtension();
const loadExtension = options => loadWith(bundle, options);

/** Runs one `send()` and captures the CLI launch; the fake process exits when the SDK aborts it. */
async function captureLaunch(chat) {
  const launches = [];
  const real = cp.spawn;
  cp.spawn = (command, args, opts) => {
    const stdin = [];
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 4242, killed: false, exitCode: null });
    const exit = () => { if (proc.killed) return; proc.killed = true; proc.exitCode = 0; setImmediate(() => { proc.stdout.end(); proc.stderr.end(); proc.emit('exit', 0, null); proc.emit('close', 0, null); }); };
    proc.kill = () => { exit(); return true; };
    proc.stdin = new Writable({ write(c, _e, cb) { stdin.push(c.toString()); cb(); }, final(cb) { exit(); cb(); } });
    opts?.signal?.addEventListener('abort', exit);
    launches.push({ command, args, cwd: opts?.cwd, stdin });
    return proc;
  };
  try {
    const sent = chat.send(chat.active, 'hello', false);
    for (let i = 0; i < 100 && !launches[0]?.stdin.some(l => l.includes('"initialize"')); i++) await new Promise(r => setTimeout(r, 20));
    chat.stopSession(chat.active);
    await Promise.race([sent, new Promise((_, rej) => setTimeout(() => rej(new Error('send() did not finish')), 10000))]);
  } finally { cp.spawn = real; }
  assert.equal(launches.length, 1, 'exactly one CLI launch');
  const l = launches[0];
  const init = l.stdin.flatMap(s => s.split('\n')).filter(Boolean).map(s => JSON.parse(s)).find(m => m.request?.subtype === 'initialize')?.request;
  const flag = name => { const i = l.args.indexOf(name); return i < 0 ? undefined : l.args[i + 1]; };
  return { ...l, init, flag, has: name => l.args.some(a => a === name || a.startsWith(name + '=')) };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-test-'));

test('local window: unchanged options (no tool restrictions, no MCP, project settings, workspace cwd)', async () => {
  const work = tmp(), storage = tmp();
  for (const remoteSsh of [false, true]) {   // the flag has no effect on local windows
    const { ext, bridgeCalls } = loadExtension({ remoteName: undefined, remoteSsh, folder: uri('file', '', work) });
    const { chat } = ext.activate(makeContext(storage));
    const l = await captureLaunch(chat);
    assert.equal(l.cwd, work);
    assert.ok(l.args.includes('--setting-sources=user,project,local'));
    assert.deepEqual(['--tools', '--allowedTools', '--disallowedTools', '--strict-mcp-config', '--mcp-config'].filter(l.has), []);
    assert.equal(l.flag('--permission-mode'), 'acceptEdits');
    assert.deepEqual(l.init?.sdkMcpServers ?? [], []);
    assert.equal(bridgeCalls.filter(c => c.startsWith('claudeIde.remote.')).length, 0);
    assert.deepEqual(await chat.active.preToolUse({ tool_name: 'Read', tool_input: {}, tool_use_id: 't' }), { continue: true });
    assert.ok(!fs.existsSync(path.join(storage, 'remote-workspaces')));
  }
});

test('Remote-SSH window, flag off (default): the guard, no agent', () => {
  const { ext } = loadExtension({ remoteName: 'ssh-remote', remoteSsh: false, folder: uri('vscode-remote', 'ssh-remote+contabo', '/home/anas/ws') });
  assert.equal(ext.activate(makeContext(tmp())), undefined);
});

test('other remote types keep the guard even with the flag on', () => {
  const { ext } = loadExtension({ remoteName: 'wsl', remoteSsh: true, folder: uri('vscode-remote', 'wsl+Ubuntu', '/home/anas/ws') });
  assert.equal(ext.activate(makeContext(tmp())), undefined);
});

test('Remote-SSH window, flag on: placeholder cwd, remote-only options, in-process MCP server, local tools denied', async () => {
  const storage = tmp();
  const hostInfo = { hostname: 'contabo', platform: 'linux', arch: 'x64', workspaceRoot: '/home/anas/ws' };
  const { ext, bridgeCalls } = loadExtension({ remoteName: 'ssh-remote', remoteSsh: true, folder: uri('vscode-remote', 'ssh-remote+contabo', '/home/anas/ws'), hostInfo });
  const { chat, store } = ext.activate(makeContext(storage));
  const l = await captureLaunch(chat);

  assert.equal(path.dirname(l.cwd), path.join(storage, 'remote-workspaces'));
  assert.ok(fs.statSync(l.cwd).isDirectory());
  assert.notEqual(l.cwd, '/home/anas/ws');
  assert.deepEqual({
    settingSources: l.args.find(a => a.startsWith('--setting-sources')),
    tools: l.flag('--tools'),
    disallowed: l.flag('--disallowedTools'),
    allowed: l.flag('--allowedTools'),
    strict: l.has('--strict-mcp-config'),
    mcpConfig: l.has('--mcp-config'),
  }, {
    settingSources: '--setting-sources=user',
    tools: 'AskUserQuestion,TodoWrite,EnterPlanMode,ExitPlanMode,WebFetch,WebSearch,Agent,Task',
    disallowed: 'Read,Write,Edit,MultiEdit,NotebookEdit,Glob,Grep,Bash,Monitor,EnterWorktree,ExitWorktree,Skill,Workflow',
    allowed: ['read_file', 'list_directory', 'stat', 'search_files', 'search_content', 'git_status', 'git_diff', 'git_log', 'process_status'].map(t => `mcp__remote__${t}`).join(','),
    strict: true,
    mcpConfig: false,   // in-process servers are not passed as CLI config...
  });
  // ...they are declared in the initialize request, with a manifest of their tools.
  assert.deepEqual(l.init.sdkMcpServers, ['remote']);
  assert.equal(l.init.sdkMcpServerManifests.remote.toolsListResult.tools.length, 15);
  assert.match(l.init.appendSystemPrompt ?? l.flag('--append-system-prompt') ?? '', /workspace root is \/home\/anas\/ws/);
  // Host facts once, then the three project instruction files (CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md).
  assert.deepEqual(bridgeCalls.filter(c => c.startsWith('claudeIde.remote.')), ['claudeIde.remote.getInfo', ...Array(3).fill('claudeIde.remote.fs.readFile')]);
  assert.ok(l.init.agents && Object.keys(l.init.agents).includes('remote-general'), 'remote sub-agents are declared to the CLI');

  // Enforcement independent of the CLI's own tool filtering: local tools are denied by the hook and canUseTool.
  const hook = (n, input = {}) => chat.active.preToolUse({ tool_name: n, tool_input: input, tool_use_id: 't' });
  const decision = async (n, input) => { const r = await hook(n, input); return r.hookSpecificOutput?.permissionDecision ?? 'continue'; };
  for (const n of ['Read', 'Bash', 'Write', 'mcp__remote__nope', 'mcp__evil__x']) {
    assert.equal(await decision(n), 'deny', n);
    assert.equal((await chat.active.canUseTool(n, {}, { signal: new AbortController().signal })).behavior, 'deny', n);
  }
  assert.equal(await decision('WebSearch'), 'continue');

  // The approval policy per mode, as the real hook applies it.
  const calls = {
    read: ['mcp__remote__read_file', { file_path: 'a' }],
    write: ['mcp__remote__write_file', { file_path: 'a', content: 'x' }],
    build: ['mcp__remote__execute_command', { command: 'cmake --build build -j4 && ctest' }],
    sudo: ['mcp__remote__execute_command', { command: 'sudo apt-get install -y ninja-build' }],
    rmrf: ['mcp__remote__file_operation', { operation: 'delete_directory', path: 'build', recursive: true }],
    commit: ['mcp__remote__git_operation', { operation: 'commit', message: 'm' }],
    branches: ['mcp__remote__git_operation', { operation: 'branch_list' }],
  };
  const matrix = {};
  for (const m of ['auto', 'ask', 'askBeforeEach', 'plan']) {
    chat.active.mode = m;
    matrix[m] = {};
    for (const [k, [n, input]] of Object.entries(calls)) matrix[m][k] = await decision(n, input);
  }
  assert.deepEqual(matrix, {
    auto: { read: 'allow', write: 'allow', build: 'allow', sudo: 'ask', rmrf: 'ask', commit: 'allow', branches: 'allow' },
    ask: { read: 'allow', write: 'allow', build: 'ask', sudo: 'ask', rmrf: 'ask', commit: 'ask', branches: 'allow' },
    askBeforeEach: { read: 'allow', write: 'ask', build: 'ask', sudo: 'ask', rmrf: 'ask', commit: 'ask', branches: 'allow' },
    plan: { read: 'allow', write: 'deny', build: 'deny', sudo: 'deny', rmrf: 'deny', commit: 'deny', branches: 'allow' },
  });

  // canUseTool shows the approval prompt for "ask" decisions; approving a privileged command records that exact call.
  chat.active.mode = 'ask';
  const asked = [];
  chat.ask = async (_s, title, detail, choices) => { asked.push({ title, choices }); return 'Allow'; };
  const sudoResult = await chat.active.canUseTool(...calls.sudo, { signal: new AbortController().signal });
  assert.equal(sudoResult.behavior, 'allow');
  assert.deepEqual(asked[0].choices, ['Allow', 'Deny']);   // risky: no "Always allow"
  assert.equal(chat.active.remoteSession.approvals.size, 1);
  chat.ask = async (_s, title, detail, choices) => { asked.push({ title, choices }); return 'Always allow'; };
  assert.equal((await chat.active.canUseTool(...calls.build, { signal: new AbortController().signal })).behavior, 'allow');
  assert.deepEqual(asked[1].choices, ['Allow once', 'Always allow', 'Deny']);
  assert.equal(await decision(...calls.build), 'allow');   // remembered for this conversation
  assert.equal(await decision(...calls.sudo), 'ask');      // never for risky commands
  chat.newChat();
  assert.equal(await decision(...calls.build), 'ask');     // a new conversation forgets it
  chat.active.mode = 'plan';
  assert.equal((await chat.active.canUseTool(...calls.write, { signal: new AbortController().signal })).behavior, 'deny');
  assert.deepEqual(store.pending(), []);   // in-memory review store: nothing staged, nothing read from disk
});

test('Remote-SSH window: a remote host that cannot answer stops the turn without launching the CLI', async () => {
  const { ext } = loadExtension({ remoteName: 'ssh-remote', remoteSsh: true, folder: uri('vscode-remote', 'ssh-remote+contabo', '/home/anas/ws'), hostInfo: undefined });
  const { chat } = ext.activate(makeContext(tmp()));
  const real = cp.spawn; let launched = 0;
  cp.spawn = (...a) => { launched++; return real(...a); };
  try {
    await assert.rejects(chat.send(chat.active, 'hello', false), /MALFORMED_RESPONSE|getInfo/);
  } finally { cp.spawn = real; }
  assert.equal(launched, 0);
});
