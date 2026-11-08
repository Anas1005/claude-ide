#!/usr/bin/env node
// Turns a Code - OSS checkout into Claude IDE: branding, icons, default layout and theme, the inline review UI,
// and the built-in claude-agent extension. Runs on macOS, Windows and Linux. Safe to re-run.
// Usage: node scripts/apply-fork.mjs [path-to-vscode-checkout]
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORK = path.resolve(process.argv[2] ?? path.join(ROOT, 'vscode-fork'));
const EXT = path.join(ROOT, 'claude-agent');
const BRAND = path.join(ROOT, 'fork-patches', 'brand');
const f = rel => path.join(FORK, rel);

/**
 * Replace `from` (string or regex) with `to` in a file, unless `applied` (regex) shows it was already done.
 * Fails loudly if the target text changed upstream, instead of silently skipping.
 */
function patch(rel, from, to, label, applied) {
  const file = f(rel);
  const src = fs.readFileSync(file, 'utf8');
  if (applied.test(src)) return;
  const hit = typeof from === 'string' ? src.includes(from) : from.test(src);
  if (!hit) throw new Error(`apply-fork: could not apply "${label}" in ${rel}; the VS Code source changed.`);
  fs.writeFileSync(file, src.replace(from, to));
}
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };

if (!fs.existsSync(f('product.json'))) throw new Error(`No Code - OSS checkout at ${FORK}`);

// 0. Build the extension bundle.
execSync('npm run build', { cwd: EXT, stdio: 'inherit' });

// 1. Branding: Claude IDE (no Microsoft names or marketplace; Open VSX like VSCodium).
{
  const product = JSON.parse(fs.readFileSync(f('product.json'), 'utf8'));
  Object.assign(product, {
    nameShort: 'Claude IDE', nameLong: 'Claude IDE', applicationName: 'claude-ide',
    dataFolderName: '.claude-ide', sharedDataFolderName: '.claude-ide-shared',
    serverApplicationName: 'claude-ide-server', serverDataFolderName: '.claude-ide-server', tunnelApplicationName: 'claude-ide-tunnel',
    darwinBundleIdentifier: 'dev.local.claude-ide', linuxDesktopName: 'dev.local.ClaudeIDE', linuxIconName: 'claude-ide', urlProtocol: 'claude-ide',
    // Windows: fixed IDs so installs, updates and uninstall recognise Claude IDE (never reuse Code - OSS IDs).
    win32DirName: 'Claude IDE', win32NameVersion: 'Claude IDE', win32RegValueName: 'ClaudeIDE', win32AppUserModelId: 'Local.ClaudeIDE',
    win32ShellNameShort: 'Claude &IDE', win32MutexName: 'claudeide', win32TunnelServiceMutex: 'claudeide-tunnelservice', win32TunnelMutex: 'claudeide-tunnel',
    win32x64AppId: '{{9BD24168-5CB6-428A-8C08-85F57DDE103B}', win32arm64AppId: '{{C4D5519B-63A8-4862-8439-CD8A77817F7C}',
    win32x64UserAppId: '{{21B95B1A-8A5C-4F7F-A7C8-D026986005B4}', win32arm64UserAppId: '{{647CAD24-8854-429F-988F-BB077A73AA89}',
    // Microsoft Remote-SSH 0.113.1 is not built in: without this its resolver is refused ("CANNOT use API proposal").
    extensionEnabledApiProposals: { 'ms-vscode-remote.remote-ssh': ['resolvers', 'tunnels', 'terminalDataWriteEvent', 'contribViewsRemote', 'telemetry', 'contribRemoteHelp'] },
    extensionsGallery: {
      serviceUrl: 'https://open-vsx.org/vscode/gallery', itemUrl: 'https://open-vsx.org/vscode/item',
      extensionUrlTemplate: 'https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest', resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
    },
  });
  delete product.reportIssueUrl;
  fs.writeFileSync(f('product.json'), JSON.stringify(product, null, '\t') + '\n');
}

// 1a. Skip an optional Microsoft-internal download (on-device dictation runtime) that fails outside their network.
{
  const pkg = f('package.json'), s = fs.readFileSync(pkg, 'utf8');
  fs.writeFileSync(pkg, s.replace(/"foundry-local-sdk@([0-9.]+)": true/, '"foundry-local-sdk@$1": false'));
}

// 1b. Icons (macOS, Windows, Linux), installer images, editor watermark.
copy(path.join(BRAND, 'claude-ide.icns'), f('resources/darwin/code.icns'));
for (const file of fs.readdirSync(path.join(BRAND, 'win32'))) copy(path.join(BRAND, 'win32', file), f(`resources/win32/${file}`));
if (fs.existsSync(f('resources/linux'))) copy(path.join(BRAND, 'linux-code.png'), f('resources/linux/code.png'));
for (const file of fs.readdirSync(BRAND).filter(n => n.startsWith('letterpress-'))) copy(path.join(BRAND, file), f(`src/vs/workbench/browser/parts/editor/media/${file}`));

// 1c. Default theme: Claude IDE Dark (shipped by the extension).
patch('src/vs/workbench/services/themes/common/workbenchThemeService.ts',
  /export const COLOR_THEME_DARK = '[^']*';/, "export const COLOR_THEME_DARK = 'Claude IDE Dark';", 'default dark theme',
  /export const COLOR_THEME_DARK = 'Claude IDE Dark';/);

// 2. Layout: secondary side bar (the Claude panel) visible on the right by default.
patch('src/vs/workbench/browser/workbench.contribution.ts',
  /('workbench\.secondarySideBar\.defaultVisibility': \{[\s\S]*?'default': )'visibleInWorkspace'/, "$1'visible'", 'secondary side bar visible',
  /'workbench\.secondarySideBar\.defaultVisibility': \{[^{}]*?'default': 'visible',/);

// 2a. No Copilot / GitHub sign-in onboarding by default.
patch('src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts',
  /(\[ChatAIDisabledSettingId\]: \{[\s\S]*?default: )false/, '$1true', 'disable built-in AI features',
  /\[ChatAIDisabledSettingId\]: \{[^{}]*?default: true/);
// Copilot is disabled, so don't fail packaging when its SDK wasn't bundled.
patch('build/lib/copilot.ts',
  'throw new Error(`[prepareBuiltInCopilotRipgrepShim] Copilot SDK directory not found at ${copilotSdkBase}`);', 'return;', 'copilot shim',
  /if \(!fs\.existsSync\(copilotSdkBase\)\) \{\s*return;/);

// 2b. Open-source builds don't ship Microsoft's extension-signature tool, so the check can't run ("Cannot verify the
// extension signature"). Turn it off by default, like VSCodium.
patch('src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts',
  /(localize\('extensions\.verifySignature'[\s\S]*?default: )true/, '$1false', 'extension signature check',
  /localize\('extensions\.verifySignature'[^\n]*\n\s*default: false/);

// 2b2. Windows packaging asks Microsoft's signtool whether files are already signed. Our builds are unsigned and signtool
// is often not on PATH (e.g. GitHub runners), which crashed the build; treat "no signtool" as "not signed".
patch('build/gulpfile.vscode.ts',
  "const proc = cp.spawn('signtool.exe', ['verify', '/pa', filePath]);\n\t\tproc.on('error', reject);",
  "const proc = cp.spawn('signtool.exe', ['verify', '/pa', filePath]);\n\t\tproc.on('error', () => resolve(false)); // Claude IDE: unsigned build without signtool",
  'signtool check', /Claude IDE: unsigned build without signtool/);

// 2b3. App metadata (Windows file properties, macOS "Get Info"): Claude IDE is not a Microsoft product.
// VS Code's MIT license file, which credits Microsoft for the underlying editor, still ships with the app.
patch('build/lib/electron.ts',
  "companyName: 'Microsoft Corporation',\n\tcopyright: 'Copyright (C) 2026 Microsoft. All rights reserved',",
  "companyName: 'error404sushant',\n\tcopyright: 'Copyright (C) 2026 error404sushant',",
  'app company and copyright', /companyName: 'error404sushant'/);
patch('build/gulpfile.vscode.ts',
  "'CompanyName': 'Microsoft Corporation',",
  "'CompanyName': 'error404sushant',",
  'Windows file company name', /'CompanyName': 'error404sushant'/);
patch('build/gulpfile.vscode.ts',
  "'LegalCopyright': 'Copyright (C) 2026 Microsoft. All rights reserved',",
  "'LegalCopyright': 'Copyright (C) 2026 error404sushant',",
  'Windows file copyright', /'LegalCopyright': 'Copyright \(C\) 2026 error404sushant'/);

// 2c. Inline review UI (removed-line zones, per-change Accept/Reject, floating review bar) and chat drop handling.
copy(path.join(ROOT, 'fork-patches', 'claudeReview.contribution.ts'), f('src/vs/workbench/contrib/claudeReview/browser/claudeReview.contribution.ts'));
patch('src/vs/workbench/workbench.common.main.ts',
  "import './contrib/chat/browser/chat.contribution.js';",
  "import './contrib/chat/browser/chat.contribution.js';\nimport './contrib/claudeReview/browser/claudeReview.contribution.js';", 'register review UI',
  /claudeReview\.contribution\.js/);

// 2d. Remote-SSH: when the host can't download the server (Microsoft has none for this build), Remote-SSH asks the client
// through _workbench.downloadResource and copies the file over with scp. Answer with the server inside this app.
{
  const rel = 'src/vs/workbench/api/node/extHostDownloadService.ts';
  patch(rel, "import { tmpdir } from 'os';", "import { tmpdir } from 'os';\nimport { copyFile, existsSync } from 'fs';\nimport { promisify } from 'util';\nimport { IExtHostInitDataService } from '../common/extHostInitDataService.js';", 'server download imports', /IExtHostInitDataService/);
  patch(rel, '@IExtHostCommands commands: IExtHostCommands\n', '@IExtHostCommands commands: IExtHostCommands,\n\t\t@IExtHostInitDataService initData: IExtHostInitDataService\n', 'server download service', /initData: IExtHostInitDataService/);
  patch(rel, "const location = URI.file(join(tmpdir(), generateUuid()));\n",
    "const location = URI.file(join(tmpdir(), generateUuid()));\n"
    + "\t\t\tconst bundledServer = initData.environment.appRoot && join(initData.environment.appRoot.fsPath, 'server', 'vscode-server-linux-x64.tar.gz');\n"
    + "\t\t\tif (bundledServer && initData.commit && resource.authority === 'update.code.visualstudio.com'\n"
    + "\t\t\t\t&& new RegExp(`^/commit:${initData.commit}/server-linux-(legacy-)?x64/`).test(resource.path) && existsSync(bundledServer)) {\n"
    + "\t\t\t\tawait promisify(copyFile)(bundledServer, location.fsPath); // a copy: Remote-SSH moves the file it gets\n"
    + "\t\t\t\treturn location;\n"
    + "\t\t\t}\n",
    'serve bundled server', /bundledServer/);
  // Remote-SSH treats bin/<server> as "installed" and moves bin/ first: repair an install interrupted during that move.
  patch('resources/server/bin/code-server-linux.sh', 'ROOT="$(dirname "$(dirname "$(readlink -f "$0")")")"\n',
    'ROOT="$(dirname "$(dirname "$(readlink -f "$0")")")"\n\n'
    + '# Claude IDE: an install interrupted while being moved into place is removed, so the next connection reinstalls it.\n'
    + 'if [ ! -x "$ROOT/node" ] || [ ! -d "$ROOT/node_modules" ] || [ ! -f "$ROOT/out/server-main.js" ] || [ ! -f "$ROOT/product.json" ]; then\n'
    + '\techo "Incomplete Claude IDE server at $ROOT. Removing it; reconnect to install it again." >&2\n'
    + '\tif basename "$ROOT" | grep -Eq "^[0-9a-f]{40}\\$" && [ "$(basename "$(dirname "$ROOT")")" = bin ]; then rm -rf "$ROOT"; fi\n'
    + '\texit 1\n'
    + 'fi\n',
    'server install guard', /Incomplete Claude IDE server/);
}

// 3. Ship the extension built-in (prebuilt bundle, no runtime dependencies).
{
  const dest = f('extensions/claude-agent');
  fs.rmSync(dest, { recursive: true, force: true });
  for (const dir of ['out', 'media', 'themes']) fs.cpSync(path.join(EXT, dir), path.join(dest, dir), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
  for (const k of ['scripts', 'dependencies', 'devDependencies']) delete pkg[k];
  fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify(pkg, null, 2));
}

console.log(`Applied Claude IDE to ${FORK}`);
