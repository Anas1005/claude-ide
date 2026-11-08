// Tests the compiled remote extension's command handlers against a real filesystem, real processes and real git
// on this host. VS Code is replaced by a stub that only supplies the workspace folder and command registration.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';

const require = createRequire(import.meta.url);
const Module = require('module');
const OUT = new URL('../out/extension.js', import.meta.url).pathname;

const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-outside-')));   // a second project, outside the workspace
const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-ws-')));
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-home-')));   // the OS user's home, for credential locations
process.env.HOME = home;
const abs = rel => path.join(ws, rel);
fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE\n');

const handlers = new Map();
const vscode = {
    workspace: { workspaceFolders: [{ uri: { fsPath: ws } }] },
    window: { createOutputChannel: () => ({ appendLine() { }, clear() { }, show() { }, dispose() { } }) },
    commands: { registerCommand: (id, fn) => { handlers.set(id, fn); return { dispose() { } }; } }
};
const load = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : load.call(this, req, ...rest); };
const ext = require(OUT);
Module._load = load;
ext.activate({ subscriptions: [] });

const call = (id, arg) => handlers.get(`claudeIde.remote.${id}`)(arg);
const ok = async (id, arg) => { const r = await call(id, arg); assert.equal(r.success, true, JSON.stringify(r)); return r.data; };
const code = async (id, arg) => { const r = await call(id, arg); assert.equal(r.success, false, `${id} unexpectedly succeeded: ${JSON.stringify(r)}`); return r.error.code; };
const file = (rel, content) => { fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true }); fs.writeFileSync(path.join(ws, rel), content); };
const read = rel => fs.readFileSync(path.join(ws, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(ws, rel));
async function waitFor(sessionId, ms = 10000) {
    const end = Date.now() + ms;
    for (; ;) {
        const s = await ok('exec.status', { sessionId });
        if (s.state !== 'running' || Date.now() > end) { return s; }
        await new Promise(r => setTimeout(r, 50));
    }
}

before(() => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(ws, 'link-out.txt'));
    fs.symlinkSync(outside, path.join(ws, 'linkdir'));
});
after(() => {
    ext.deactivate();
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
});

// ---------------- filesystem ----------------

test('getInfo reports apiVersion 6, the workspace root and the home directory', async () => {
    const info = await handlers.get('claudeIde.remote.getInfo')();
    assert.deepEqual([info.apiVersion, info.platform, info.workspaceRoot, info.homeDirectory], [6, process.platform, ws, home]);
});

test('read and write: create, report, hash check, create-only; any path; symbolic links resolved to their target', async () => {
    const created = await ok('fs.writeFile', { path: 'a/b/new.txt', content: 'one\ntwo\n', createParents: true });
    assert.deepEqual([created.path, created.created, created.lines, created.previousSha256], [abs('a/b/new.txt'), true, 3, null]);
    const r = await ok('fs.readFile', { path: 'a/b/new.txt' });
    assert.equal(r.sha256, created.sha256);
    const replaced = await ok('fs.writeFile', { path: 'a/b/new.txt', content: 'three\n', expectedSha256: r.sha256 });
    assert.deepEqual([replaced.created, replaced.previousSha256, replaced.previousLines], [false, r.sha256, 3]);
    assert.equal(await code('fs.writeFile', { path: 'a/b/new.txt', content: 'x', expectedSha256: r.sha256 }), 'CONFLICT');
    assert.equal(await code('fs.writeFile', { path: 'a/b/new.txt', content: 'x', mustNotExist: true }), 'ALREADY_EXISTS');
    // Outside the workspace: an absolute path, a relative path with "..", "~", and through symbolic links.
    const out = await ok('fs.writeFile', { path: path.join(outside, 'proj/new.txt'), content: 'o\n', createParents: true });
    assert.deepEqual([out.path, out.created], [path.join(outside, 'proj/new.txt'), true]);
    assert.equal((await ok('fs.readFile', { path: `../${path.basename(outside)}/proj/new.txt` })).content, 'o\n');
    await ok('fs.writeFile', { path: '~/notes.txt', content: 'h\n' });
    assert.equal(fs.readFileSync(path.join(home, 'notes.txt'), 'utf8'), 'h\n');
    const viaLink = await ok('fs.readFile', { path: 'link-out.txt' });
    assert.deepEqual([viaLink.content, viaLink.path], ['OUTSIDE\n', path.join(outside, 'secret.txt')]);   // canonical path reported
    await ok('fs.writeFile', { path: 'linkdir/x.txt', content: 'x' });
    assert.equal(fs.readFileSync(path.join(outside, 'x.txt'), 'utf8'), 'x');
    await ok('fs.writeFile', { path: 'link-out.txt', content: 'CHANGED\n', expectedSha256: viaLink.sha256 });
    assert.deepEqual([fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), fs.lstatSync(abs('link-out.txt')).isSymbolicLink()], ['CHANGED\n', true]);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE\n');
    assert.equal(await code('fs.readFile', { path: 'missing.txt' }), 'NOT_FOUND');
    assert.equal(await code('fs.writeFile', { path: 'a/b/new.txt/child', content: 'x' }), 'NOT_A_DIRECTORY');
    // The OS user's permissions are the boundary.
    const locked = path.join(outside, 'locked.txt');
    fs.writeFileSync(locked, 'L');
    fs.chmodSync(locked, 0o000);
    if (process.getuid?.() !== 0) { assert.equal(await code('fs.readFile', { path: locked }), 'PERMISSION_DENIED'); }
    fs.chmodSync(locked, 0o600);
    assert.equal(read('a/b/new.txt'), 'three\n');
});

test('credential locations need the user\'s approval (allowSensitive), also through symbolic links; searches skip them', async () => {
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ssh/id_test'), 'PRIVATE KEY\n');
    const innocent = path.join(outside, 'innocent.txt');
    fs.symlinkSync(path.join(home, '.ssh/id_test'), innocent);
    assert.equal(await code('fs.readFile', { path: '~/.ssh/id_test' }), 'SENSITIVE_PATH_NOT_APPROVED');
    assert.equal(await code('fs.readFile', { path: innocent }), 'SENSITIVE_PATH_NOT_APPROVED');   // canonicalized before the check
    assert.equal(await code('fs.writeFile', { path: innocent, content: 'x' }), 'SENSITIVE_PATH_NOT_APPROVED');
    assert.equal(await code('fs.writeFile', { path: path.join(home, '.ssh/authorized_keys'), content: 'x' }), 'SENSITIVE_PATH_NOT_APPROVED');
    assert.equal(await code('fs.applyPatch', { files: [{ path: innocent, edits: [{ oldString: 'PRIVATE', newString: 'x' }] }] }), 'SENSITIVE_PATH_NOT_APPROVED');
    assert.equal(await code('fs.fileOperation', { operation: 'delete_file', path: path.join(home, '.ssh/id_test') }), 'SENSITIVE_PATH_NOT_APPROVED');
    assert.equal(await code('fs.fileOperation', { operation: 'move', path: path.join(outside, 'x.txt'), destination: '~/.ssh/x' }), 'SENSITIVE_PATH_NOT_APPROVED');
    assert.equal(await code('fs.listDirectory', { path: '~/.ssh' }), 'SENSITIVE_PATH_NOT_APPROVED');
    assert.equal((await ok('fs.readFile', { path: '~/.ssh/id_test', allowSensitive: true })).content, 'PRIVATE KEY\n');
    assert.deepEqual((await ok('fs.searchContent', { path: home, pattern: 'PRIVATE' })).matches, []);
    assert.equal((await ok('fs.searchContent', { path: home, pattern: 'PRIVATE', allowSensitive: true })).matches.length, 1);
    assert.deepEqual(await ok('fs.searchFiles', { path: home, query: 'id_test' }), []);
    assert.deepEqual([fs.readFileSync(path.join(home, '.ssh/id_test'), 'utf8'), fs.existsSync(path.join(home, '.ssh/x'))], ['PRIVATE KEY\n', false]);
    fs.unlinkSync(innocent);
});

test('apply_patch: multi-edit, ambiguity, not found, all-or-nothing across files', async () => {
    file('p/one.ts', 'const a = 1;\nconst b = 2;\nconst a2 = 1;\n');
    file('p/two.ts', 'hello world\n');
    const res = await ok('fs.applyPatch', { files: [
        { path: 'p/one.ts', edits: [{ oldString: 'const b = 2;', newString: 'const b = 3;' }, { oldString: '= 1;', newString: '= 9;', replaceAll: true }] },
        { path: 'p/two.ts', edits: [{ oldString: 'world', newString: 'there' }] }
    ] });
    assert.deepEqual(res.files.map(f => [f.path, f.editsApplied]), [[abs('p/one.ts'), 2], [abs('p/two.ts'), 1]]);
    assert.equal(read('p/one.ts'), 'const a = 9;\nconst b = 3;\nconst a2 = 9;\n');
    assert.equal(await code('fs.applyPatch', { files: [{ path: 'p/one.ts', edits: [{ oldString: '= 9;', newString: '= 0;' }] }] }), 'CONFLICT');   // ambiguous
    // second file fails → first file must not be written
    assert.equal(await code('fs.applyPatch', { files: [
        { path: 'p/one.ts', edits: [{ oldString: 'const b = 3;', newString: 'const b = 4;' }] },
        { path: 'p/two.ts', edits: [{ oldString: 'NOT THERE', newString: 'x' }] }
    ] }), 'CONFLICT');
    assert.equal(read('p/one.ts'), 'const a = 9;\nconst b = 3;\nconst a2 = 9;\n');
    assert.equal(await code('fs.applyPatch', { files: [{ path: 'p/missing.ts', edits: [{ oldString: 'a', newString: 'b' }] }] }), 'NOT_FOUND');
    fs.writeFileSync(path.join(outside, 'patch.txt'), 'alpha\n');   // a file of another project
    const outsidePatch = await ok('fs.applyPatch', { files: [{ path: path.join(outside, 'patch.txt'), edits: [{ oldString: 'alpha', newString: 'beta' }] }] });
    assert.deepEqual([outsidePatch.files[0].path, fs.readFileSync(path.join(outside, 'patch.txt'), 'utf8')], [path.join(outside, 'patch.txt'), 'beta\n']);
    const stale = (await ok('fs.readFile', { path: 'p/two.ts' })).sha256;
    file('p/two.ts', 'changed by someone else\n');
    assert.equal(await code('fs.applyPatch', { files: [{ path: 'p/two.ts', expectedSha256: stale, edits: [{ oldString: 'changed', newString: 'x' }] }] }), 'CONFLICT');
});

test('file operations: create, rename, move, conflicts, deletes, symlinks, other projects, protected directories', async () => {
    assert.equal((await ok('fs.fileOperation', { operation: 'create_directory', path: 'ops/x/y' })).created, true);
    assert.equal((await ok('fs.fileOperation', { operation: 'create_directory', path: 'ops/x/y' })).created, false);
    file('ops/f.txt', 'F');
    file('ops/g.txt', 'G');
    await ok('fs.fileOperation', { operation: 'rename', path: 'ops/f.txt', destination: 'f2.txt' });
    assert.ok(exists('ops/f2.txt') && !exists('ops/f.txt'));
    assert.equal(await code('fs.fileOperation', { operation: 'rename', path: 'ops/f2.txt', destination: '../f3.txt' }), 'INVALID_REQUEST');
    assert.equal(await code('fs.fileOperation', { operation: 'move', path: 'ops/f2.txt', destination: 'ops/g.txt' }), 'ALREADY_EXISTS');
    assert.equal((await ok('fs.fileOperation', { operation: 'move', path: 'ops/f2.txt', destination: 'ops/g.txt', overwrite: true })).replaced, true);
    assert.equal(read('ops/g.txt'), 'F');
    await ok('fs.fileOperation', { operation: 'move', path: 'ops/g.txt', destination: 'moved/deep/g.txt', createParents: true });
    assert.equal(read('moved/deep/g.txt'), 'F');
    assert.equal(await code('fs.fileOperation', { operation: 'move', path: 'ops/x', destination: 'moved/deep', overwrite: true }), 'CONFLICT');
    assert.equal(await code('fs.fileOperation', { operation: 'move', path: 'ops', destination: 'ops/x/inside' }), 'INVALID_REQUEST');
    // To another project and back; into a symbolic link to a directory (lands in its target).
    const away = await ok('fs.fileOperation', { operation: 'move', path: 'moved/deep/g.txt', destination: path.join(outside, 'moved-g.txt') });
    assert.deepEqual([away.path, away.destination, fs.readFileSync(path.join(outside, 'moved-g.txt'), 'utf8')], [abs('moved/deep/g.txt'), path.join(outside, 'moved-g.txt'), 'F']);
    assert.equal((await ok('fs.fileOperation', { operation: 'move', path: path.join(outside, 'moved-g.txt'), destination: 'linkdir/g.txt' })).destination, path.join(outside, 'g.txt'));
    await ok('fs.fileOperation', { operation: 'move', path: path.join(outside, 'g.txt'), destination: 'moved/deep/g.txt' });
    assert.equal(read('moved/deep/g.txt'), 'F');
    await ok('fs.fileOperation', { operation: 'create_directory', path: path.join(outside, 'tree/a/b') });
    fs.writeFileSync(path.join(outside, 'tree/a/b/f'), 'f');
    assert.equal((await ok('fs.fileOperation', { operation: 'delete_directory', path: path.join(outside, 'tree'), recursive: true })).entriesDeleted, 3);
    assert.equal(fs.existsSync(path.join(outside, 'tree')), false);
    // OS permissions: a file in a read-only directory cannot be deleted.
    fs.mkdirSync(path.join(outside, 'ro'));
    fs.writeFileSync(path.join(outside, 'ro/f'), 'f');
    fs.chmodSync(path.join(outside, 'ro'), 0o555);
    if (process.getuid?.() !== 0) { assert.equal(await code('fs.fileOperation', { operation: 'delete_file', path: path.join(outside, 'ro/f') }), 'PERMISSION_DENIED'); }
    fs.chmodSync(path.join(outside, 'ro'), 0o755);
    // Never deleted or moved away: the filesystem root, the home directory, the workspace root, or what contains them.
    for (const p of ['/', home, '.', path.dirname(ws)]) {
        assert.equal(await code('fs.fileOperation', { operation: 'delete_directory', path: p }), 'INVALID_REQUEST', p);
    }
    assert.equal(await code('fs.fileOperation', { operation: 'move', path: '.', destination: path.join(outside, 'ws') }), 'INVALID_REQUEST');
    assert.equal(await code('fs.fileOperation', { operation: 'delete_file', path: 'ops/missing' }), 'NOT_FOUND');
    assert.equal(await code('fs.fileOperation', { operation: 'delete_file', path: 'ops' }), 'NOT_A_FILE');
    assert.equal(await code('fs.fileOperation', { operation: 'delete_directory', path: 'ops' }), 'CONFLICT');   // not empty
    assert.equal(await code('fs.fileOperation', { operation: 'delete_directory', path: '.', recursive: true }), 'INVALID_REQUEST');
    assert.equal(await code('fs.fileOperation', { operation: 'delete_directory', path: 'linkdir', recursive: true }), 'NOT_A_DIRECTORY');   // a link: delete_file removes it
    assert.equal(await code('fs.fileOperation', { operation: 'format_disk', path: 'ops' }), 'INVALID_REQUEST');
    // a symlink inside a deleted tree is removed, its target is untouched
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(ws, 'ops/x/link'));
    assert.equal((await ok('fs.fileOperation', { operation: 'delete_directory', path: 'ops', recursive: true })).entriesDeleted, 3);
    assert.ok(!exists('ops'));
    // deleting a symlink removes the link only
    assert.equal((await ok('fs.fileOperation', { operation: 'delete_file', path: 'link-out.txt' })).wasSymlink, true);
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'OUTSIDE\n');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(ws, 'link-out.txt'));
});

test('search_content: literal, regex, case, globs, context, binary and symlink skipping, bounds', async () => {
    file('s/src/a.cpp', 'int main() {\n  return Foo(1);\n}\n');
    file('s/src/b.h', '// foo bar\nint Foo(int);\n');
    file('s/docs/readme.md', 'Foo is documented\n');
    file('s/bin.dat', Buffer.from([0x46, 0x6f, 0x6f, 0, 1, 2]));
    file('s/build/gen.cpp', 'Foo generated\n');
    const q = async args => (await ok('fs.searchContent', { path: 's', ...args })).matches.map(m => `${path.relative(ws, m.path)}:${m.line}`);
    assert.deepEqual((await q({ pattern: 'Foo' })).sort(), ['s/docs/readme.md:1', 's/src/a.cpp:2', 's/src/b.h:2']);
    assert.deepEqual((await q({ pattern: 'foo', caseSensitive: false })).length, 4);
    assert.deepEqual(await q({ pattern: 'Foo\\(\\d\\)', regex: true }), ['s/src/a.cpp:2']);
    assert.deepEqual((await q({ pattern: 'Foo', include: ['*.{cpp,h}'] })).sort(), ['s/src/a.cpp:2', 's/src/b.h:2']);
    assert.deepEqual(await q({ pattern: 'Foo', exclude: ['src/**', 's/src/**'] }), ['s/docs/readme.md:1']);
    const ctx = await ok('fs.searchContent', { path: 's', pattern: 'return', contextLines: 1 });
    assert.deepEqual([ctx.matches[0].before, ctx.matches[0].after, ctx.matches[0].column], [['int main() {'], ['}'], 3]);
    assert.equal((await ok('fs.searchContent', { path: 's', pattern: 'Foo', maxResults: 1 })).truncated, true);
    assert.deepEqual(await q({ pattern: 'OUTSIDE' }), []);
    assert.deepEqual((await ok('fs.searchContent', { pattern: 'OUTSIDE' })).matches, []);   // symlinks never followed
    assert.equal(await code('fs.searchContent', { pattern: '(', regex: true }), 'INVALID_REQUEST');
    const other = await ok('fs.searchContent', { pattern: 'OUTSIDE', path: outside });   // another project
    assert.deepEqual(other.matches.map(m => m.path), [path.join(outside, 'secret.txt')]);
});

// ---------------- execution ----------------

test('exec: success, non-zero exit, stderr, args without a shell, command not found', async () => {
    const s1 = await waitFor((await ok('exec.start', { command: 'echo hello && echo oops >&2' })).sessionId);
    assert.deepEqual([s1.state, s1.exitCode, s1.stdout.text, s1.stderr.text], ['exited', 0, 'hello\n', 'oops\n']);
    const s2 = await waitFor((await ok('exec.start', { command: 'exit 3' })).sessionId);
    assert.equal(s2.exitCode, 3);
    const s3 = await waitFor((await ok('exec.start', { command: 'printf', args: ['%s|', 'a; rm -rf /', '$(id)'] })).sessionId);
    assert.equal(s3.stdout.text, 'a; rm -rf /|$(id)|');   // no shell interpretation
    assert.equal(await code('exec.start', { command: 'definitely-not-a-command-xyz', args: [] }), 'NOT_FOUND');
    assert.equal((await waitFor((await ok('exec.start', { command: 'definitely-not-a-command-xyz' })).sessionId)).exitCode, 127);
});

test('exec: cwd defaults to the workspace; any existing directory works (canonical)', async () => {
    file('sub/marker', '');
    assert.equal((await waitFor((await ok('exec.start', { command: 'pwd' })).sessionId)).stdout.text.trim(), fs.realpathSync(ws));
    assert.equal((await waitFor((await ok('exec.start', { command: 'ls', cwd: 'sub' })).sessionId)).stdout.text.trim(), 'marker');
    const pwd = async cwd => { const s = await waitFor((await ok('exec.start', { command: 'pwd', cwd })).sessionId); return [s.cwd, s.stdout.text.trim()]; };
    assert.deepEqual(await pwd(outside), [outside, outside]);
    assert.deepEqual(await pwd('../'), [path.dirname(ws), path.dirname(ws)]);
    assert.deepEqual(await pwd('linkdir'), [outside, outside]);
    assert.deepEqual(await pwd('~'), [home, home]);
    assert.equal(await code('exec.start', { command: 'pwd', cwd: path.join(outside, 'missing') }), 'NOT_FOUND');
    assert.equal(await code('exec.start', { command: 'pwd', cwd: 'sub/marker' }), 'NOT_A_DIRECTORY');
});

test('exec: timeout, background session, status, graceful and forced termination, process group', async () => {
    const t = await waitFor((await ok('exec.start', { command: 'sleep 30', timeoutMs: 300 })).sessionId);
    assert.deepEqual([t.state, t.timedOut, t.terminated], ['exited', true, true]);

    const bg = await ok('exec.start', { command: 'for i in 1 2 3; do echo tick $i; sleep 0.1; done; sleep 30', background: true });
    await new Promise(r => setTimeout(r, 500));
    const running = await ok('exec.status', { sessionId: bg.sessionId });
    assert.deepEqual([running.state, running.stdout.text], ['running', 'tick 1\ntick 2\ntick 3\n']);
    const incremental = await ok('exec.status', { sessionId: bg.sessionId, stdoutOffset: 7 });
    assert.equal(incremental.stdout.text, 'tick 2\ntick 3\n');
    assert.ok((await ok('exec.status', {})).sessions.some(s => s.sessionId === bg.sessionId));
    const stopped = await ok('exec.terminate', { sessionId: bg.sessionId });
    assert.deepEqual([stopped.wasRunning, stopped.state, stopped.signal], [true, 'exited', 'SIGTERM']);

    // ignores SIGTERM → killed after the grace period; its child process dies with the group
    const pidFile = path.join(ws, 'child.pid');
    const stubborn = await ok('exec.start', { command: `trap '' TERM; sleep 60 & echo $! > child.pid; wait`, background: true });
    await new Promise(r => setTimeout(r, 300));
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    const killed = await ok('exec.terminate', { sessionId: stubborn.sessionId, graceMs: 200 });
    assert.equal(killed.signal, 'SIGKILL');
    await new Promise(r => setTimeout(r, 200));
    assert.throws(() => process.kill(childPid, 0), /ESRCH/);
    assert.equal(await code('exec.terminate', { sessionId: 'not-a-session' }), 'PROCESS_NOT_FOUND');
    assert.equal(await code('exec.status', { sessionId: String(process.pid) }), 'PROCESS_NOT_FOUND');   // PIDs are not session IDs
});

test('exec: commands are owned: an owner sees and stops only its own; other owners are separate', async () => {
    const a = await ok('exec.start', { command: 'sleep 30', background: true, owner: 'conv-A', correlationId: 'call-1' });
    const b = await ok('exec.start', { command: 'sleep 30', background: true, owner: 'conv-B', correlationId: 'call-2' });
    assert.deepEqual([a.owner, a.correlationId, b.owner], ['conv-A', 'call-1', 'conv-B']);
    const listA = (await ok('exec.status', { owner: 'conv-A' })).sessions.map(s => s.sessionId);
    assert.deepEqual(listA, [a.sessionId]);
    // B cannot read or stop A's command, even knowing its session ID.
    assert.equal(await code('exec.status', { sessionId: a.sessionId, owner: 'conv-B' }), 'PROCESS_NOT_FOUND');
    assert.equal(await code('exec.terminate', { sessionId: a.sessionId, owner: 'conv-B' }), 'PROCESS_NOT_FOUND');
    assert.equal((await ok('exec.status', { sessionId: a.sessionId, owner: 'conv-A' })).state, 'running');
    // Stopping B's command leaves A's running (separate process groups).
    await ok('exec.terminate', { sessionId: b.sessionId, owner: 'conv-B' });
    assert.deepEqual([(await ok('exec.status', { sessionId: b.sessionId, owner: 'conv-B' })).state, (await ok('exec.status', { sessionId: a.sessionId, owner: 'conv-A' })).state], ['exited', 'running']);
    await ok('exec.terminate', { sessionId: a.sessionId, owner: 'conv-A', force: true });
    assert.equal(await code('exec.start', { command: 'true', owner: 'bad owner!' }), 'INVALID_REQUEST');
});

test('exec: requests without an owner (older clients) are legacy-owned: they never see or stop a conversation\'s commands', async () => {
    const a = await ok('exec.start', { command: 'sleep 30', background: true, owner: 'conv-A' });
    const b = await ok('exec.start', { command: 'sleep 30', background: true, owner: 'conv-B' });
    const legacy = await ok('exec.start', { command: 'sleep 30', background: true });
    assert.equal(legacy.owner, 'legacy:unscoped');
    for (const owned of [a, b]) {
        assert.equal(await code('exec.status', { sessionId: owned.sessionId }), 'PROCESS_NOT_FOUND');
        assert.equal(await code('exec.terminate', { sessionId: owned.sessionId }), 'PROCESS_NOT_FOUND');
        assert.equal(await code('exec.terminate', { sessionId: owned.sessionId, force: true }), 'PROCESS_NOT_FOUND');
    }
    const unscopedList = (await ok('exec.status', {})).sessions.map(s => s.sessionId);
    assert.ok(unscopedList.includes(legacy.sessionId));
    assert.ok(!unscopedList.includes(a.sessionId) && !unscopedList.includes(b.sessionId));
    // A and B are untouched; conversations cannot reach legacy commands either; nobody can claim the legacy namespace.
    assert.deepEqual([(await ok('exec.status', { sessionId: a.sessionId, owner: 'conv-A' })).state, (await ok('exec.status', { sessionId: b.sessionId, owner: 'conv-B' })).state], ['running', 'running']);
    assert.equal(await code('exec.status', { sessionId: legacy.sessionId, owner: 'conv-A' }), 'PROCESS_NOT_FOUND');
    for (const owner of ['legacy:unscoped', 'legacy:x']) {
        assert.equal(await code('exec.status', { sessionId: legacy.sessionId, owner }), 'INVALID_REQUEST');
        assert.equal(await code('exec.start', { command: 'true', owner }), 'INVALID_REQUEST');
    }
    // A legacy client still manages its own commands.
    assert.equal((await ok('exec.terminate', { sessionId: legacy.sessionId, force: true })).wasRunning, true);
    await ok('exec.terminate', { sessionId: a.sessionId, owner: 'conv-A', force: true });
    await ok('exec.terminate', { sessionId: b.sessionId, owner: 'conv-B', force: true });
});

test('exec: privilege escalation needs approval; env validated; editor variables removed; secrets redacted', async () => {
    for (const command of ['sudo ls', 'bash -c "sudo id"', 'echo x | doas tee y', 'env FOO=1 pkexec id']) {
        assert.equal(await code('exec.start', { command }), 'PRIVILEGE_NOT_APPROVED', command);
    }
    assert.equal(await code('exec.start', { command: 'sudo', args: ['-n', 'true'] }), 'PRIVILEGE_NOT_APPROVED');
    const approved = await waitFor((await ok('exec.start', { command: 'sudo -n true', allowPrivileged: true })).sessionId);
    assert.equal(approved.state, 'exited');   // ran (succeeds or fails depending on sudoers; never prompts)
    assert.equal(await code('exec.start', { command: 'true', env: { LD_PRELOAD: '/x.so' } }), 'INVALID_REQUEST');
    assert.equal(await code('exec.start', { command: 'true', env: { 'BAD NAME': 'x' } }), 'INVALID_REQUEST');
    process.env.VSCODE_IPC_HOOK_CLI = '/tmp/vscode-ipc.sock';
    process.env.TEST_API_TOKEN = 'super-secret-token-value-123';
    const env = await waitFor((await ok('exec.start', { command: 'echo "$MY_VAR|$VSCODE_IPC_HOOK_CLI|$TEST_API_TOKEN|sk-ant-abcdefghijklmnop"', env: { MY_VAR: 'set' } })).sessionId);
    assert.equal(env.stdout.text, 'set||[REDACTED]|[REDACTED]\n');
    delete process.env.TEST_API_TOKEN;
});

// ---------------- git ----------------

test('git: status, diff, log, branches, stage, unstage, commit, validation', async () => {
    const g = (...a) => execFileSync('git', a, { cwd: path.join(ws, 'repo') });
    fs.mkdirSync(path.join(ws, 'repo'));
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'agent@example.com');
    g('config', 'user.name', 'Agent Test');
    file('repo/a.txt', 'one\n');
    g('add', 'a.txt');
    g('commit', '-q', '-m', 'first');
    file('repo/a.txt', 'one\ntwo\n');
    file('repo/new.txt', 'new\n');

    const st = await ok('git.status', { repository: 'repo' });
    assert.deepEqual([st.branch, st.repositoryRoot, st.unstaged, st.untracked, st.staged, st.clean],
        ['main', abs('repo'), [{ path: 'a.txt', status: 'M' }], ['new.txt'], [], false]);
    assert.match((await ok('git.diff', { repository: 'repo' })).text, /\+two/);
    assert.equal((await ok('git.diff', { repository: 'repo', staged: true })).text, '');

    await ok('git.operation', { repository: 'repo', operation: 'stage', paths: ['repo/a.txt', 'repo/new.txt'] });
    const staged = await ok('git.status', { repository: 'repo' });
    assert.deepEqual(staged.staged.map(s => s.path).sort(), ['a.txt', 'new.txt']);
    assert.match((await ok('git.diff', { repository: 'repo', staged: true, paths: ['repo/a.txt'] })).text, /\+two/);
    await ok('git.operation', { repository: 'repo', operation: 'unstage', paths: ['repo/new.txt'] });
    assert.deepEqual((await ok('git.status', { repository: 'repo' })).untracked, ['new.txt']);
    const commit = await ok('git.operation', { repository: 'repo', operation: 'commit', message: 'second' });
    assert.match(commit.commit, /^[0-9a-f]{40}$/);
    const log = await ok('git.log', { repository: 'repo', maxCount: 5, paths: ['repo/a.txt'] });
    assert.deepEqual(log.commits.map(c => [c.subject, c.author]), [['second', 'Agent Test'], ['first', 'Agent Test']]);

    await ok('git.operation', { repository: 'repo', operation: 'branch_create', name: 'feature/x' });
    await ok('git.operation', { repository: 'repo', operation: 'branch_switch', name: 'feature/x' });
    const branches = await ok('git.operation', { repository: 'repo', operation: 'branch_list' });
    assert.deepEqual(branches.branches.map(b => [b.name, b.current]).sort(), [['feature/x', true], ['main', false]]);

    assert.equal(await code('git.operation', { repository: 'repo', operation: 'branch_create', name: '--force' }), 'INVALID_REQUEST');
    assert.equal(await code('git.operation', { repository: 'repo', operation: 'branch_create', name: 'bad..name' }), 'INVALID_REQUEST');
    assert.equal(await code('git.operation', { repository: 'repo', operation: 'branch_switch', name: 'nope' }), 'GIT_ERROR');
    assert.equal(await code('git.operation', { repository: 'repo', operation: 'reset_hard' }), 'INVALID_REQUEST');
    assert.equal(await code('git.operation', { repository: 'repo', operation: 'stage', paths: [path.join(outside, 'x.txt')] }), 'GIT_ERROR');   // git: outside the repository
    assert.equal(await code('git.operation', { repository: 'repo', operation: 'commit', message: '' }), 'INVALID_REQUEST');
    // A repository of another project, by absolute path.
    const other = path.join(outside, 'repo2');
    fs.mkdirSync(other);
    execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: other });
    fs.writeFileSync(path.join(other, 'b.txt'), 'b\n');
    await ok('git.operation', { repository: other, operation: 'stage', paths: [path.join(other, 'b.txt')] });
    const otherStatus = await ok('git.status', { repository: other });
    assert.deepEqual([otherStatus.branch, otherStatus.repositoryRoot, otherStatus.staged.map(f => f.path)], ['trunk', other, ['b.txt']]);
    fs.mkdirSync(path.join(ws, 'notrepo'));
    const outsideRepo = await call('git.status', { repository: 'notrepo' });   // parent is not a repo either
    assert.ok(outsideRepo.success === false ? outsideRepo.error.code === 'GIT_ERROR' : outsideRepo.data.repositoryRoot !== 'notrepo');
});

// ---------------- change review support ----------------

test('review: writeFile and applyPatch return before/after text only when asked', async () => {
    const created = await ok('fs.writeFile', { path: 'rv/a.txt', content: 'one\n', createParents: true, returnContent: true });
    assert.deepEqual([created.previousContent, created.content], [null, 'one\n']);
    const plain = await ok('fs.writeFile', { path: 'rv/a.txt', content: 'two\n', expectedSha256: created.sha256 });
    assert.equal('previousContent' in plain, false);
    const patched = await ok('fs.applyPatch', { returnContent: true, files: [{ path: 'rv/a.txt', edits: [{ oldString: 'two', newString: 'three' }] }] });
    assert.deepEqual([patched.files[0].previousContent, patched.files[0].content], ['two\n', 'three\n']);
    file('rv/bin.dat', Buffer.from([1, 0, 2]));
    const bin = await ok('fs.writeFile', { path: 'rv/bin.dat', content: 'text now', returnContent: true, mustNotExist: false, expectedSha256: undefined });
    assert.equal(bin.reviewSkipped, true);   // previous content was binary
});

test('review: workspace snapshots report created, modified and deleted files with before/after text', async () => {
    file('snap/keep.txt', 'same\n');
    file('snap/edit.txt', 'old\n');
    file('snap/gone.txt', 'bye\n');
    file('snap/big.bin', Buffer.from([0, 1, 2, 3]));
    file('build/ignored.o', 'x');
    const begin = await ok('fs.snapshotBegin', {});
    assert.ok(begin.files >= 4);
    await waitFor((await ok('exec.start', { command: 'echo new > snap/new.txt && sed -i s/old/new/ snap/edit.txt && rm snap/gone.txt && printf "\\x00\\x09" > snap/big.bin && echo y > build/ignored.o && touch snap/keep.txt' })).sessionId);
    const diff = await ok('fs.snapshotDiff', { snapshotId: begin.snapshotId });
    const byPath = Object.fromEntries(diff.changes.filter(c => c.path.startsWith(abs('snap/'))).map(c => [path.relative(ws, c.path), [c.status, c.before, c.after]]));
    assert.deepEqual(byPath, {
        'snap/new.txt': ['A', null, 'new\n'],
        'snap/edit.txt': ['M', 'old\n', 'new\n'],
        'snap/gone.txt': ['D', 'bye\n', null],
    });
    assert.deepEqual(diff.skipped.filter(c => c.path.startsWith(abs('snap/'))).map(c => [path.relative(ws, c.path), c.status]), [['snap/big.bin', 'M']]);
    assert.ok(!diff.changes.some(c => c.path.startsWith(abs('build/'))));   // build output is not reviewed
    assert.ok(!diff.changes.some(c => c.path === abs('link-out.txt')));     // symlinks are not followed
    assert.deepEqual(diff.roots, [ws]);
    assert.match(diff.changes.find(c => c.path === abs('snap/edit.txt')).afterSha, /^[0-9a-f]{64}$/);
    assert.equal(await code('fs.snapshotDiff', { snapshotId: begin.snapshotId }), 'NOT_FOUND');   // consumed
    const kept = await ok('fs.snapshotBegin', {});
    assert.deepEqual((await ok('fs.snapshotDiff', { snapshotId: kept.snapshotId, keep: true })).changes, []);
    assert.equal((await ok('fs.snapshotDiscard', { snapshotId: kept.snapshotId })).discarded, true);
});

test('review: snapshots of chosen roots: another project, a single file, nested roots merged; credential locations never captured', async () => {
    fs.mkdirSync(path.join(outside, 'proj3'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'proj3/c.txt'), 'c\n');
    fs.mkdirSync(path.join(home, '.aws'), { recursive: true });
    fs.writeFileSync(path.join(home, '.aws/credentials'), 'key\n');
    const begin = await ok('fs.snapshotBegin', { roots: [path.join(outside, 'proj3'), path.join(outside, 'proj3/c.txt'), ws, home] });
    assert.deepEqual(begin.roots.sort(), [path.join(outside, 'proj3'), ws, home].sort());
    await waitFor((await ok('exec.start', { command: 'echo C > c.txt && echo new > d.txt && echo k2 > ~/.aws/credentials', cwd: path.join(outside, 'proj3') })).sessionId);
    const diff = await ok('fs.snapshotDiff', { snapshotId: begin.snapshotId });
    assert.deepEqual(diff.changes.map(c => [c.path, c.status, c.after]).sort(), [[path.join(outside, 'proj3/c.txt'), 'M', 'C\n'], [path.join(outside, 'proj3/d.txt'), 'A', 'new\n']]);
    assert.equal(await code('fs.snapshotBegin', { roots: [] }), 'INVALID_REQUEST');
});

test('v6 base64 read: exact bytes, canonical path through links, 5 MB limit, credential approval; utf8 unchanged', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);
    fs.writeFileSync(path.join(outside, 'img.png'), png);
    fs.symlinkSync(path.join(outside, 'img.png'), abs('img-link.png'));
    const r = await ok('fs.readFile', { path: 'img-link.png', encoding: 'base64' });
    assert.deepEqual([r.path, r.encoding, r.size, Buffer.from(r.content, 'base64').equals(png)], [path.join(outside, 'img.png'), 'base64', png.length, true]);
    file('t.txt', 'héllo\n');
    const t = await ok('fs.readFile', { path: 't.txt' });
    assert.deepEqual([t.content, t.encoding], ['héllo\n', undefined]);
    fs.writeFileSync(path.join(outside, 'big.png'), Buffer.alloc(5 * 1024 * 1024 + 1));
    assert.equal(await code('fs.readFile', { path: path.join(outside, 'big.png'), encoding: 'base64' }), 'LIMIT_EXCEEDED');
    assert.equal(await code('fs.readFile', { path: 't.txt', encoding: 'hex' }), 'INVALID_REQUEST');
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ssh/key.png'), png);
    fs.symlinkSync(path.join(home, '.ssh/key.png'), abs('innocent.png'));
    assert.equal(await code('fs.readFile', { path: '~/.ssh/key.png', encoding: 'base64' }), 'SENSITIVE_PATH_NOT_APPROVED');
    assert.equal(await code('fs.readFile', { path: 'innocent.png', encoding: 'base64' }), 'SENSITIVE_PATH_NOT_APPROVED');
    assert.equal((await ok('fs.readFile', { path: '~/.ssh/key.png', encoding: 'base64', allowSensitive: true })).size, png.length);
});

test('v6 glob file search: patterns relative to the searched directory, files only, exclusions, credential skips, limits', async () => {
    const g = fs.realpathSync(fs.mkdtempSync(path.join(outside, 'glob-')));
    for (const f of ['a.ts', 'src/b.ts', 'src/deep/c.ts', 'src/d.js', 'node_modules/x.ts', '.git/y.ts', 'src.ts/e.txt']) {
        fs.mkdirSync(path.dirname(path.join(g, f)), { recursive: true }); fs.writeFileSync(path.join(g, f), 'x');
    }
    const names = async req => (await ok('fs.searchFiles', { path: g, ...req })).map(e => path.relative(g, e.path)).sort();
    assert.deepEqual(await names({ pattern: '**/*.ts' }), ['a.ts', 'src/b.ts', 'src/deep/c.ts']);
    assert.deepEqual(await names({ pattern: '*.ts' }), ['a.ts', 'src/b.ts', 'src/deep/c.ts']);   // no '/': any depth, as include globs
    assert.deepEqual(await names({ pattern: 'src/*.{ts,js}' }), ['src/b.ts', 'src/d.js']);
    assert.deepEqual(await names({ pattern: './src/**/*.ts', query: 'c' }), ['src/deep/c.ts']);
    assert.deepEqual(await names({ query: 'src' }), ['src', 'src.ts']);   // v5 behaviour unchanged
    assert.equal((await ok('fs.searchFiles', { path: g, pattern: '**/*', maxResults: 2 })).length, 2);
    assert.equal(await code('fs.searchFiles', { path: g }), 'INVALID_REQUEST');
    assert.equal(await code('fs.searchFiles', { path: g, pattern: 5 }), 'INVALID_REQUEST');
    fs.mkdirSync(path.join(home, '.aws'), { recursive: true });
    fs.writeFileSync(path.join(home, '.aws/conf.ts'), 'k');
    fs.writeFileSync(path.join(home, 'ok.ts'), 'k');
    const inHome = (await ok('fs.searchFiles', { path: home, pattern: '**/*.ts' })).map(e => e.path);
    assert.deepEqual(inHome, [path.join(home, 'ok.ts')]);
});
