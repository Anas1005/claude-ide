// Phase 0 gate (b), opt-in live check (not part of `npm test`): a slow PreToolUse hook blocks the tool — the tool body
// does not start until the hook has resolved — and a "deny" from the hook prevents the body entirely.
// The tool is an in-process MCP tool that only records when it ran. Small real model calls.
// Usage: node test/e2e/phase0-pretooluse-blocks.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ROOT } from '../helpers/build.mjs';

const sdk = await import(path.join(ROOT, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'));
const { z } = await import(path.join(ROOT, 'node_modules/zod/index.js'));
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-hook-')));
const projectDir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
const HOOK_DELAY_MS = 3000;

async function trial(decision) {
  const log = [];
  const server = sdk.createSdkMcpServer({ name: 'gate', version: '1.0.0', tools: [
    sdk.tool('mark', 'Records a mark. Call it once.', { label: z.string() }, async () => { log.push({ at: Date.now(), what: 'tool-body' }); return { content: [{ type: 'text', text: 'marked' }] }; }),
  ] });
  const preToolUse = async input => {
    if (input.tool_name !== 'mcp__gate__mark') return {};
    log.push({ at: Date.now(), what: 'hook-start' });
    await new Promise(r => setTimeout(r, HOOK_DELAY_MS));
    log.push({ at: Date.now(), what: 'hook-resolved' });
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: `gate ${decision}` } };
  };
  const q = sdk.query({ prompt: 'Call the mcp__gate__mark tool once with label "x", then reply DONE.', options: {
    cwd, model: 'claude-haiku-4-5-20251001', mcpServers: { gate: server }, strictMcpConfig: true, tools: [],
    permissionMode: 'default', canUseTool: async () => ({ behavior: 'deny', message: 'not expected' }),
    hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
  } });
  let result;
  for await (const m of q) if (m.type === 'result') result = m.subtype;
  return { decision, result, log: log.map(e => e.what) , timing: log };
}

const allow = await trial('allow');
const deny = await trial('deny');
const resolvedAt = allow.timing.find(e => e.what === 'hook-resolved')?.at;
const bodyAt = allow.timing.find(e => e.what === 'tool-body')?.at;
const report = {
  allow: { log: allow.log, bodyStartedMsAfterHookResolved: bodyAt - resolvedAt },
  deny: { log: deny.log },
};
console.log(JSON.stringify(report, null, 1));
const pass = allow.log.join(',') === 'hook-start,hook-resolved,tool-body' && bodyAt >= resolvedAt
  && deny.log.includes('hook-resolved') && !deny.log.includes('tool-body');
console.log(pass ? 'GATE B: PASS' : 'GATE B: FAIL');
fs.rmSync(cwd, { recursive: true, force: true });
fs.rmSync(projectDir, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
