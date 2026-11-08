// Opt-in live check (not part of `npm test`) of the original bug: switching conversations must not interrupt another
// conversation's running request, and Stop must touch only its own. Real Claude CLI through the production bundle,
// local window on a scratch folder, auto mode. Small real model calls (Haiku) with this machine's Claude sign-in.
// Usage: node test/e2e/multi-conversation-live.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildExtension, ROOT } from '../helpers/build.mjs';
import { loadExtension, makeContext, uri } from '../helpers/vscodeStub.mjs';

const CLI = path.join(ROOT, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude');
const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multi-live-')));
const projectDir = path.join(os.homedir(), '.claude', 'projects', ws.replace(/[^a-zA-Z0-9]/g, '-'));
const bundle = await buildExtension();
const { ext } = loadExtension(bundle, { remoteName: undefined, remoteSsh: false, folder: uri('file', '', ws),
  settings: { claudePath: CLI, permissionMode: 'auto', defaultModel: 'claude-haiku-4-5-20251001', resumeLastConversation: false } });
const { chat } = ext.activate(makeContext(fs.mkdtempSync(path.join(os.tmpdir(), 'multi-live-state-'))));
const panel = [];
chat.view = { webview: { postMessage: async m => { panel.push(m); return true; } } };
const until = async (cond, ms = 120000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await new Promise(r => setTimeout(r, 100)); return cond(); };
const transcript = s => { try { return fs.readFileSync(path.join(projectDir, `${s.sdkSessionId}.jsonl`), 'utf8'); } catch { return ''; } };
const text = s => s.presentation.events.filter(e => e.type === 'assistantText' || e.type === 'textDelta').map(e => e.text).join('');

// 1) A runs a slow command; while it runs we open a new chat (B), send there, switch back and forth.
const A = chat.active;
const sentA = chat.send(A, 'Run this exact Bash command and then reply with only its output: sleep 12 && echo ALPHA-DONE', false);
await until(() => A.status === 'running' && A.sdkSessionId);
chat.newChat();
const B = chat.active;
const sentB = chat.send(B, 'Reply with exactly the word BRAVO and nothing else.', false);
await until(() => B.status === 'running');
await chat.onMessage({ type: 'switchTo', conversationId: A.conversationId });
await chat.onMessage({ type: 'switchTo', conversationId: B.conversationId });
const bothRunning = A.busy && B.busy;
await Promise.all([sentA, sentB]);

// 2) Stop only C while D keeps going.
chat.newChat();
const C = chat.active;
const sentC = chat.send(C, 'Run this exact Bash command and then reply with only its output: sleep 30 && echo CHARLIE-DONE', false);
chat.newChat();
const D = chat.active;
const sentD = chat.send(D, 'Run this exact Bash command and then reply with only its output: sleep 6 && echo DELTA-DONE', false);
await until(() => C.status === 'running' && D.status === 'running');
await new Promise(r => setTimeout(r, 3000));
chat.stopSession(C);
await Promise.all([sentC, sentD]);

const report = {
  scenario1: { bothRunningWhileSwitching: bothRunning, A: { status: A.status, saidDone: text(A).includes('ALPHA-DONE'), interruptedInTranscript: transcript(A).includes('Request interrupted') },
    B: { status: B.status, said: text(B).trim(), interruptedInTranscript: transcript(B).includes('Request interrupted') } },
  scenario2: { C: { status: C.status }, D: { status: D.status, saidDone: text(D).includes('DELTA-DONE'), interruptedInTranscript: transcript(D).includes('Request interrupted') } },
};
console.log(JSON.stringify(report, null, 1));
const pass = bothRunning && A.status === 'completed' && report.scenario1.A.saidDone && !report.scenario1.A.interruptedInTranscript
  && B.status === 'completed' && /BRAVO/.test(report.scenario1.B.said) && !report.scenario1.B.interruptedInTranscript
  && C.status === 'interrupted' && D.status === 'completed' && report.scenario2.D.saidDone && !report.scenario2.D.interruptedInTranscript;
console.log(pass ? 'LIVE MULTI-CONVERSATION: PASS' : 'LIVE MULTI-CONVERSATION: FAIL');
ext.deactivate();
fs.rmSync(ws, { recursive: true, force: true });
fs.rmSync(projectDir, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
