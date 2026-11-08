#!/usr/bin/env node
// Builds Claude IDE for the current platform: macOS (.app + .dmg/.zip) or Windows (installer .exe + .zip).
// First run downloads the pinned Code - OSS source into vscode-fork/ and installs dependencies.
//
// Usage: node scripts/build.mjs [--arch x64|arm64] [--package]
//   --package   also create the release files in release/ (DMG + ZIP on macOS, Setup.exe + ZIP on Windows)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, execSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORK = path.join(ROOT, 'vscode-fork');
// The patches in scripts/apply-fork.mjs and fork-patches/ target this exact Code - OSS version (1.140.0).
const VSCODE_COMMIT = 'ca1020a2710357004a97608f712a937968a3c433';

const args = process.argv.slice(2);
const platform = process.platform;                      // darwin | win32 | linux
const arch = args.includes('--arch') ? args[args.indexOf('--arch') + 1] : process.arch;
const doPackage = args.includes('--package');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'claude-agent', 'package.json'), 'utf8')).version;
const isWin = platform === 'win32';

const run = (cmd, cwd = ROOT, env = {}) => { console.log(`\n> ${cmd}`); execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, ...env } }); };

// Node 24 is required by Code - OSS 1.140.
if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error(`Node 24 is required (found ${process.version}). ${platform === 'darwin' ? 'brew install node@24' : 'Install Node 24 from https://nodejs.org'}`);
  process.exit(1);
}
// Avoid slow IPv6 fallbacks on some networks when downloading dependencies.
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=5000'].filter(Boolean).join(' ');

// 1. Code - OSS source at the pinned commit (Git LFS files are only test fixtures; skip them).
// An existing checkout is only inspected, never fetched, reset or replaced: it must already be at VSCODE_COMMIT.
if (fs.existsSync(path.join(FORK, '.git'))) {
  let head = '';
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: FORK, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* reported below */ }
  if (head !== VSCODE_COMMIT) {
    console.error(`${FORK} is at ${head || 'an unreadable commit'}, but this build needs Code - OSS ${VSCODE_COMMIT}.\n`
      + 'Check it out there yourself (git -C vscode-fork checkout <commit>), or move vscode-fork/ away so the build downloads the pinned version.');
    process.exit(1);
  }
} else if (fs.existsSync(FORK) && fs.readdirSync(FORK).length) {
  console.error(`${FORK} exists but is not a git checkout. Move it away so the build can download Code - OSS ${VSCODE_COMMIT}.`);
  process.exit(1);
} else {
  console.log(`Downloading Code - OSS (${VSCODE_COMMIT})…`);
  const git = (...a) => execFileSync('git', a, { cwd: FORK, stdio: 'inherit', env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } });
  fs.mkdirSync(FORK, { recursive: true });
  git('init', '-q');
  if (isWin) git('config', 'core.longpaths', 'true');
  git('remote', 'add', 'origin', 'https://github.com/microsoft/vscode.git');
  git('fetch', '--depth', '1', 'origin', VSCODE_COMMIT);
  git('-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', 'checkout', '-q', 'FETCH_HEAD');
}

// 2. Dependencies, patches (before the fork's npm ci: it disables a download that fails outside Microsoft), build.
if (!fs.existsSync(path.join(ROOT, 'claude-agent', 'node_modules'))) run('npm ci', path.join(ROOT, 'claude-agent'));
run(`node "${path.join(ROOT, 'scripts', 'apply-fork.mjs')}" "${FORK}"`);
const archEnv = { npm_config_arch: arch };
if (!fs.existsSync(path.join(FORK, 'node_modules'))) run('npm ci', FORK, archEnv);
run(`npm run gulp vscode-${platform}-${arch}-min`, FORK, archEnv);

// 3. Locate the built app and drop Microsoft's Copilot pieces (disabled in Claude IDE, ~500 MB).
const outDir = path.join(ROOT, `VSCode-${platform}-${arch}`);
const appBundle = path.join(outDir, 'Claude IDE.app');
const findResources = dir => {
  for (const cand of [path.join(dir, 'Claude IDE.app', 'Contents', 'Resources', 'app'), path.join(dir, 'resources', 'app')]) if (fs.existsSync(path.join(cand, 'product.json'))) return cand;
  for (const sub of fs.readdirSync(dir)) {             // Windows versioned layout: <commit>/resources/app
    const cand = path.join(dir, sub, 'resources', 'app');
    if (fs.existsSync(path.join(cand, 'product.json'))) return cand;
  }
  throw new Error(`Could not find the built app in ${dir}`);
};
const RES = findResources(outDir);
fs.rmSync(path.join(RES, 'extensions', 'copilot'), { recursive: true, force: true });
fs.rmSync(path.join(RES, 'out', 'vs', 'sessions'), { recursive: true, force: true });
const ghDir = path.join(RES, 'node_modules.asar.unpacked', '@github');
if (fs.existsSync(ghDir)) for (const d of fs.readdirSync(ghDir)) if (d.startsWith('copilot')) fs.rmSync(path.join(ghDir, d), { recursive: true, force: true });
{
  const productFile = path.join(RES, 'product.json');
  const product = JSON.parse(fs.readFileSync(productFile, 'utf8'));
  for (const k of Object.keys(product.checksums ?? {})) if (k.startsWith('vs/sessions/')) delete product.checksums[k];
  fs.writeFileSync(productFile, JSON.stringify(product, null, '\t'));
}

// 4. Platform finishing + release files.
const release = path.join(ROOT, 'release');
const base = `Claude-IDE-v${version}`;
if (platform === 'darwin') {
  const now = new Date();
  fs.utimesSync(appBundle, now, now);                  // the build stamps files with 1980; give the app today's date
  // Ad-hoc sign so macOS knows it as "Claude IDE" and can grant it microphone access.
  run(`codesign --force --deep --sign - "${appBundle}"`);
  console.log(`\nBuilt ${appBundle}`);
  if (doPackage) {
    fs.mkdirSync(release, { recursive: true });
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ide-dmg-'));
    run(`ditto "${appBundle}" "${path.join(stage, 'Claude IDE.app')}"`);
    fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
    run(`hdiutil create -quiet -volname "Claude IDE" -srcfolder "${stage}" -ov -format UDZO "${path.join(release, `${base}-macOS-${arch}.dmg`)}"`);
    fs.rmSync(stage, { recursive: true, force: true });
    run(`ditto -c -k --sequesterRsrc --keepParent "${appBundle}" "${path.join(release, `${base}-macOS-${arch}.zip`)}"`);
  }
} else if (isWin) {
  console.log(`\nBuilt ${outDir}`);
  if (doPackage) {
    fs.mkdirSync(release, { recursive: true });
    // Per-user installer (no admin rights needed): Start menu entry, "Open with Claude IDE", uninstaller.
    run(`npm run gulp vscode-win32-${arch}-inno-updater`, FORK, archEnv);
    run(`npm run gulp vscode-win32-${arch}-user-setup`, FORK, archEnv);
    const setupDir = path.join(FORK, '.build', `win32-${arch}`, 'user-setup');
    const setup = fs.readdirSync(setupDir).find(n => n.toLowerCase().endsWith('.exe'));
    fs.copyFileSync(path.join(setupDir, setup), path.join(release, `${base}-Windows-${arch}-Setup.exe`));
    // Portable ZIP (Windows 10+ ships bsdtar, which writes zip files).
    const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');   // Windows' bsdtar (not Git's GNU tar)
    run(`"${tar}" -a -c -f "${path.join(release, `${base}-Windows-${arch}-portable.zip`)}" -C "${ROOT}" "VSCode-win32-${arch}"`);
  }
} else {
  console.log(`\nBuilt ${outDir}`);
  if (doPackage) {
    // The matching Remote-SSH server (with the Remote Agent built in), served to Remote-SSH from inside the app.
    if (arch === 'x64') {
      run(`npm run gulp vscode-reh-linux-${arch}-min`, FORK, archEnv);
      const agent = path.join(ROOT, 'claude-agent-remote');
      if (!fs.existsSync(path.join(agent, 'node_modules'))) run('npm ci', agent);
      run('npm run compile', agent);
      const reh = `vscode-reh-linux-${arch}`, server = `vscode-server-linux-${arch}`;   // Remote-SSH unpacks vscode-server*/
      const dest = path.join(ROOT, reh, 'extensions', 'claude-agent-remote');
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(path.join(agent, 'out'), path.join(dest, 'out'), { recursive: true, filter: src => !src.endsWith('.map') });
      const pkg = JSON.parse(fs.readFileSync(path.join(agent, 'package.json'), 'utf8'));
      for (const k of ['scripts', 'devDependencies']) delete pkg[k];
      fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify(pkg, null, 2));
      fs.rmSync(path.join(ROOT, reh, 'extensions', 'copilot'), { recursive: true, force: true });
      fs.mkdirSync(path.join(RES, 'server'), { recursive: true });
      fs.rmSync(path.join(ROOT, server), { recursive: true, force: true });
      fs.renameSync(path.join(ROOT, reh), path.join(ROOT, server));
      run(`tar -czf "${path.join(RES, 'server', `${server}.tar.gz`)}" -C "${ROOT}" "${server}"`);
      fs.renameSync(path.join(ROOT, server), path.join(ROOT, reh));
    }
    fs.mkdirSync(release, { recursive: true });
    run(`tar -czf "${path.join(release, `${base}-Linux-${arch}.tar.gz`)}" -C "${ROOT}" "VSCode-linux-${arch}"`);
  }
}
if (doPackage) console.log(`\nRelease files:\n${fs.readdirSync(release).map(n => '  ' + path.join(release, n)).join('\n')}`);
