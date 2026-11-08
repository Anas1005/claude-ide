// Opt-in live check of Remote-SSH mode (not part of `npm test`): runs the real Claude CLI with the remote-mode
// options and the in-process MCP server over a stub remote, with a decoy file in the local placeholder cwd.
// Makes one small real model call with this machine's Claude sign-in. Usage: node test/e2e/remote-tools-live.mjs
import fs from 'fs'; import os from 'os'; import path from 'path'; import { fileURLToPath, pathToFileURL } from 'url';
const A = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { loadModules } = await import(pathToFileURL(`${A}/test/helpers/build.mjs`).href);
const [mode, serverMod] = await loadModules('src/remote/remoteMode.ts', 'src/remote/remoteWorkspaceServer.ts');
const sdk = await import(pathToFileURL(`${A}/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`).href);

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-placeholder-'));
fs.writeFileSync(path.join(cwd, 'notes.txt'), 'LOCAL-DECOY-0042\n');           // must never be read
const bridge = [];
const client = {
  getInfo: async () => ({ hostname: 'test-remote', platform: 'linux', arch: 'x64', workspaceRoot: '/srv/remote-ws', apiVersion: 5, homeDirectory: '/home/remote' }),
  readFileDetails: async p => { bridge.push(['readFile', p]); if (p === '/srv/remote-ws/notes.txt') return { content: 'REMOTE-CONTENT-7731\n', sha256: 'h', path: p }; throw new Error('NOT_FOUND'); },
  writeFile: async () => { throw new Error('write must not exist'); },
  listDirectory: async p => { bridge.push(['listDirectory', p]); return [{ name: 'notes.txt', path: '/srv/remote-ws/notes.txt', type: 'file' }]; },
  stat: async p => { bridge.push(['stat', p]); return { path: p, name: p, type: 'file', size: 20, modifiedAt: 't', createdAt: 't' }; },
  searchFiles: async q => { bridge.push(['searchFiles', q]); return []; },
};
const host = { hostname: 'test-remote', platform: 'linux', root: '/srv/remote-ws', apiVersion: 5, home: '/home/remote' };
const permissionAsks = [], hookSeen = [], toolUses = [], toolResults = [];
const q = sdk.query({
  prompt: 'Do these steps and report results exactly. 1) Use the Read tool on notes.txt in your current working directory. '
    + '2) Use the Bash tool to run: cat notes.txt  3) Read /srv/remote-ws/notes.txt with the remote read tool. '
    + 'For each step say whether the tool existed and quote any file content returned.',
  options: {
    cwd, model: 'claude-haiku-4-5-20251001', maxTurns: 6, persistSession: false,
    permissionMode: 'default',
    canUseTool: async (name, input) => { permissionAsks.push(name); return { behavior: 'deny', message: 'denied by test' }; },
    hooks: { PreToolUse: [{ hooks: [async i => { hookSeen.push(i.tool_name); return { continue: true }; }] }] },
    ...mode.remoteQueryOptions(serverMod.createRemoteWorkspaceServer(sdk, client, host), host),
  },
});
let init, final = '';
for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') init = m;
  if (m.type === 'assistant') for (const b of m.message.content) { if (b.type === 'tool_use') toolUses.push(b.name); if (b.type === 'text') final += b.text + '\n'; }
  if (m.type === 'user') for (const b of [].concat(m.message?.content ?? [])) if (b.type === 'tool_result') toolResults.push([b.is_error ?? false, JSON.stringify(b.content).slice(0, 140)]);
  if (m.type === 'result') { console.log('RESULT', m.subtype, 'cost $' + m.total_cost_usd); break; }
}
console.log(JSON.stringify({
  cliVersion: init?.claude_code_version, initCwdIsPlaceholder: init?.cwd === cwd, initTools: init?.tools, mcpServers: init?.mcp_servers,
  toolUsesAttempted: toolUses, permissionAsks, preToolUseHookSaw: hookSeen, bridgeCalls: bridge, toolResults,
  decoyLeaked: (final + JSON.stringify(toolResults)).includes('LOCAL-DECOY-0042'), remoteContentSeen: final.includes('REMOTE-CONTENT-7731'),
}, null, 1));
console.log('--- final text ---\n' + final.trim());
fs.rmSync(cwd, { recursive: true, force: true });
