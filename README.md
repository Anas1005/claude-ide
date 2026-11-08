<p align="center">
  <img src="docs/images/icon.png" width="120" alt="Claude IDE icon">
</p>

<h1 align="center">Claude IDE</h1>

<p align="center">
  <b>Review Claude Code's changes inline, on local projects and on remote Linux machines over SSH.</b><br>
  A Code - OSS fork with the real Claude Code agent built in.<br>
  <a href="https://github.com/Anas1005/claude-ide/releases/tag/v0.6.3">Download for Linux x64</a> · Based on <a href="https://github.com/error404sushant/claude-ide">Claude IDE by Sushant</a>
</p>

<p align="center">
  <img src="docs/claude-ide-demo.gif" width="880" alt="Claude IDE demo: inline review of a JavaScript change, drag and drop into chat, and multiple-choice questions"><br>
  <sub>🔊 <a href="docs/claude-ide-demo.mp4">Demo video with sound (MP4, 21 s)</a></sub>
</p>

---

**Contents:** [Overview](#overview) · [Installation and usage](#installation-and-usage) · [Architecture](#architecture) · [Remote development](#remote-development) · [Repository structure](#repository-structure) · [Build](#build-and-compilation) · [CI and distribution](#github-actions-and-distribution) · [Testing](#testing-and-compatibility) · [Limitations](#limitations) · [Acknowledgements](#acknowledgements)

## Overview

Claude IDE is a fork of Code - OSS (the open-source core of VS Code) with a Claude panel that runs the **real Claude Code agent** through the Claude Agent SDK. It uses the same agent loop, sign-in, `CLAUDE.md` files and session history as the `claude` CLI.

[Sushant's original project](https://github.com/error404sushant/claude-ide) created the editor fork and its inline review workflow. This repository is a maintained fork of it that adds Claude-driven development on remote Linux machines over SSH, concurrent conversations, and a Linux x64 build and release pipeline.

| Area | From the original project | Added or extended in this fork |
|---|---|---|
| **Editor** | Code - OSS fork, branding, default layout and theme, Open VSX gallery, the patch-based build | Remote-SSH compatibility patches (proposed API allowlist, server download, install repair, legacy mode default) |
| **Local agent** | Agent SDK integration, chat panel, four permission modes, history and resume, checkpoints, questions, attachments, voice input | Concurrent conversations and scheduling; safe review when conversations change the same files; more robust Claude CLI discovery on Windows; Remote-SSH mode |
| **Review** | Review stack, snapshots, per-change accept and reject, inline removed lines, floating review bar, shell-command change detection | A review backend for remote files, including changes made by remote commands |
| **Remote development** | Local projects only | The Remote Agent, 15 remote MCP tools, the cross-host bridge, the approval policy, and automatic server provisioning |
| **Builds** | macOS and Windows packaging, Windows CI, launch test, basic Linux output | Linux x64 CI on the pinned Code - OSS toolchain, the bundled matching server, the verified Electron mirror, checks of the checkout commit |
| **Tests** | Per-change logic tests and the original end-to-end suite | Remote tools, approval policy, remote review, concurrency and live CLI tests |

### What inline review looks like

Claude works freely, and every file it touches, including files changed by shell commands, lands in a review stack. Old code stays visible in red inside the file, and you accept or reject each change, each file, or everything at once.

<p align="center"><img src="docs/inline-review.gif" width="820" alt="Inline review: Claude's change to total() shown with the old line in red, the cursor clicks Accept"></p>

| | Claude Code extension | Claude IDE |
|---|---|---|
| **Reviewing edits** | *Manual* mode pauses on each edit; *Auto / Edit automatically* applies without review | Claude keeps working and edits collect in a **review stack** you go through afterwards |
| **Where you review** | A separate diff view per proposed edit | **Inside the real file**, with per-change **Accept / Reject** and a floating bar |
| **Scope of review** | The edit being proposed | Every file changed across the turn, including by **shell commands** |
| **Undo** | Reject the proposed edit; checkpoints to rewind | Reject restores **byte-identical** originals; per-change undo; **Restore to here** on any message |
| **Attaching files** | Hold **Shift** while dragging; paste images | **Drag** files, folders or screenshots onto the chat; paste images too |
| **Voice** | None | Offline dictation with ffmpeg and whisper.cpp |
| **The editor** | Your VS Code | A dedicated app with the Claude panel on the right, no Copilot sign-in prompts, and Open VSX extensions |

![cart.js with Claude's changes highlighted and Accept/Reject buttons on each change](docs/images/02-review.png)

Other features:

- **Four permission modes:** *Auto* (apply now, undo per file), *Ask* (stage everything for review), *Ask each edit* (approve before writing), *Plan* (read-only until you approve the plan).
- **Several conversations at once:** switching chats never stops another conversation, and Stop only stops the one shown. Up to `claudeIde.maxConcurrentRunning` (default 4) run at the same time; the rest wait in a queue. Two conversations editing the same file take turns.
- **Past conversations** for the open folder, searchable, resumable and shared with the `claude` CLI.
- **Model and effort pickers**, cost and token count per turn, and Stop at any time.
- **Question cards** when Claude needs a decision, and a current-file chip that includes the open file and selection.
- **Keyboard** (`Cmd` on macOS): `Ctrl+Enter` accept file · `Ctrl+Backspace` reject file · `Alt+Enter` accept change · `Shift+Alt+Backspace` reject change · `Alt+]` / `Alt+[` next or previous change · `Ctrl+Shift+Enter` accept all.
- **Restricted Mode aware:** untrusted folders show a *Trust folder* prompt instead of running the agent.

## Installation and usage

This fork publishes a Linux x64 build. Upstream's [macOS and Windows releases](https://github.com/error404sushant/claude-ide/releases/latest) come from the original project and don't include this fork's remote development features.

### 1. Install Claude Code

Install [Claude Code](https://code.claude.com/docs/en/setup) on the computer that runs Claude IDE, then run `claude` and `/login` once. Claude IDE uses that login. You can also use an API key with *Claude: Set API Key*, or set `claudeIde.claudePath` if the CLI is in an unusual location. The remote machine doesn't need Claude Code.

### 2. Download and launch

```sh
curl -fLO https://github.com/Anas1005/claude-ide/releases/download/v0.6.3/Claude-IDE-v0.6.3-Linux-x64.tar.gz
tar -xzf Claude-IDE-v0.6.3-Linux-x64.tar.gz
./VSCode-linux-x64/claude-ide
```

The release is a plain archive and needs the usual Electron libraries. On Debian or Ubuntu:

```sh
sudo apt-get install libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libatk-bridge2.0-0 libsecret-1-0
```

### 3. Install Microsoft Remote-SSH 0.113.1

Remote-SSH isn't bundled or installed automatically, and it isn't available from Open VSX. Install it once on each client, from Microsoft's VSIX (`--compressed` is required because the Marketplace sends it gzip-encoded):

```sh
curl -fL --compressed -o ms-vscode-remote.remote-ssh-0.113.1.vsix \
  https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-vscode-remote/vsextensions/remote-ssh/0.113.1/vspackage
./VSCode-linux-x64/bin/claude-ide --install-extension ms-vscode-remote.remote-ssh-0.113.1.vsix
```

*Extensions: Install from VSIX…* also works. Stay on 0.113.1: later versions refuse to run in non-Microsoft builds. Microsoft's license terms for the extension still apply, so review them before installing it.

### 4. Configure SSH

Add the host to `~/.ssh/config` and check that a plain `ssh` connection works:

```text
Host my-server
    HostName 203.0.113.10
    User alice
    IdentityFile ~/.ssh/id_ed25519
```

| Requirement | Why it's needed |
|---|---|
| `ssh` and `scp` clients on the local machine | Remote-SSH connects with your OpenSSH client and copies the server with `scp` |
| SSH authentication (keys recommended; Remote-SSH prompts for passwords and passphrases) | Claude IDE uses your existing SSH configuration and doesn't store credentials |
| SCP accepted by the host | The server archive is sent from your computer |
| `AllowTcpForwarding yes` in the host's `sshd_config` | The editor reaches the remote server through an SSH tunnel |
| A Linux x64 host with `bash` and `tar`, and write access to the home directory | The install script runs there and installs under `~/.claude-ide-server` |

### 5. Connect

Run **Remote-SSH: Connect to Host** from the Command Palette and choose your host. **Add New SSH Host** and the usual SSH config files work as normal. Then open a folder on the remote machine and use the Claude panel.

The first connection provisions the host automatically, without manual staging or settings: the app copies the server that matches its build, with the Remote Agent inside. See [automatic provisioning](#automatic-server-provisioning) for how. Open only one window for a host's first connection.

To turn remote mode off, set `"claudeIde.experimental.remoteSsh": false`. Remote windows then show a notice and the agent doesn't start.

## Architecture

```text
┌─ Your computer ─────────────────────────────────────────────────────────┐
│ Claude IDE desktop app                                                  │
│                                                                         │
│  Local Agent: claude-agent          SDK query    Claude Code CLI        │
│  (UI extension host)              ────────────▶  (child process)        │
│   chat panel, approvals,                         agent loop, sign-in,   │
│   review stack                                   transcripts            │
│                                                       │        │        │
│  In-process MCP server "remote"    tool calls         │        ▼        │
│   15 tools, path conversion,     ◀────────────────────┘    Anthropic    │
│   approval enforcement           mcp__remote__*               API       │
│      │                                                                  │
│      │ vscode.commands.executeCommand('claudeIde.remote.*')             │
└──────┼──────────────────────────────────────────────────────────────────┘
       │ VS Code cross-host RPC, over the Remote-SSH connection
┌──────┼──────────────────────────────────────────────────────────────────┐
│      ▼                                                                  │
│  Remote Agent: claude-agent-remote (workspace extension host)           │
│   path and credential checks, atomic writes, bounded output             │
│      │                                                                  │
│      ▼                                                                  │
│  Remote files, search, processes, git                                   │
│                                                                         │
│ Claude IDE server: ~/.claude-ide-server/bin/<commit>                    │
└─ Remote Linux host ─────────────────────────────────────────────────────┘
```

| Component | Runs on | Responsibilities |
|---|---|---|
| **Local Agent** `local.claude-agent` | Your computer (`extensionKind: ui`) | Chat panel, Agent SDK sessions, scheduling, approvals, the review stack, and the choice between local and remote mode |
| **Claude Agent SDK and CLI** | Your computer | Agent loop, Anthropic API calls, sign-in, transcripts |
| **MCP server `remote`** | Inside the Local Agent | Defines the tools Claude sees, converts paths using the remote platform's rules, enforces approvals, and records changes for review. A new server is created for each query |
| **Remote Agent** `claude-ide.claude-agent-remote` | Remote host (`extensionKind: workspace`) | Registers 19 `claudeIde.remote.*` commands and does the actual work. It contains no Claude code and holds no Claude credentials |
| **Claude IDE server** | Remote host | The matching Code - OSS remote server, which hosts the Remote Agent |

**A remote tool call:**

1. Claude calls a tool such as `mcp__remote__read_file`. The CLI passes it to the MCP server inside the Local Agent.
2. The approval hook and policy decide whether it runs, asks you, or is refused. The tool then resolves the path.
3. The Local Agent calls `vscode.commands.executeCommand('claudeIde.remote.fs.readFile', request)`. VS Code routes it through its RPC channel to the remote extension host.
4. The Remote Agent validates the request and runs it on the host. It returns a typed result or a typed error. Client calls time out after 30 seconds by default, and long commands are started and then polled.
5. The result returns as an ordinary MCP tool result.

### Local and remote boundaries

| On your computer | On the remote host |
|---|---|
| Claude Code CLI, sign-in, API traffic, transcripts, user settings | Project files, searches, commands, processes, git |
| The chat panel, approvals, and the review stack's state | The content of files under review and change snapshots |
| A placeholder working directory, separate for each remote workspace | The Remote Agent and Claude IDE server |

In remote mode the CLI loses every native tool that touches the local machine (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash` and others). Only `AskUserQuestion`, `TodoWrite`, the plan-mode tools, `WebFetch`, `WebSearch` and the sub-agent tools remain alongside the remote tools. Local `.mcp.json`, plugin and project settings aren't loaded, and an allowlist in the hook and permission callback refuses anything else.

### Design decisions

- **Claude runs locally** so credentials and transcripts stay on your computer. The remote host needs neither Claude Code nor an API key.
- **Remote operations use VS Code's command bridge** because Remote-SSH has already authenticated that channel. It adds no port, daemon or credential to manage.
- **The Remote Agent enforces its own safety checks**, because only the host can canonicalize paths and resolve symbolic links reliably.
- **Remote-SSH is pinned to 0.113.1** because later versions reject non-Microsoft builds, and this keeps the normal **Connect to Host** workflow. `extensionEnabledApiProposals` in the product configuration grants it the proposed APIs it needs, including the remote resolver.
- **The matching server is bundled** because a Remote-SSH server must have the same commit as the client, and Microsoft publishes no server for this fork's builds.
- **Remote-SSH runs in legacy mode** (`remote.SSH.useExecServer` defaults to `false`) because Exec Server needs a CLI that only Microsoft publishes.

## Remote development

Everything in this section was added by this fork.

### The 15 remote tools

| Group | Tools |
|---|---|
| **Files** | `read_file` (text, and PNG/JPEG/GIF/WebP up to 5 MB), `list_directory`, `stat`, `write_file`, `apply_patch`, `file_operation` |
| **Search** | `search_files` (name and glob), `search_content` (literal or regular expression) |
| **Commands and processes** | `execute_command` (foreground or background), `process_status`, `terminate_process` |
| **Git** | `git_status`, `git_diff`, `git_log`, `git_operation` (branch list, create and switch; stage; unstage; commit) |

Claude can reach any path the remote user can: absolute paths, paths relative to the workspace root, and `~`. The remote user's OS permissions are the boundary.

### Safety and approvals

- **Enforced on the remote host:** atomic writes, bounded output and timeouts, and symbolic links resolved before checks. `/`, your home directory and the workspace root are never deleted or moved.
- **Credential locations** (`~/.ssh`, `~/.aws`, `~/.gnupg`, `/etc/shadow` and others) need your approval for that call. Privilege escalation needs your approval of the exact command.
- **Git** runs fixed argument lists without a shell. No force, reset, clean, amend or branch deletion is offered through `git_operation`.
- **Stale writes are refused:** `write_file` and `apply_patch` reject a file that changed since Claude read it.
- **Commands are per conversation:** a conversation can only inspect or stop processes it started.
- **Approval modes match local mode:** *Auto* asks only for risky operations, *Ask* asks for commands, deletes and git changes, *Ask each edit* asks for every change, and *Plan* changes nothing.

### Review and context

- **Review** works as it does locally: edits, created, deleted and moved files, and files changed by commands all appear inline, with per-change Accept and Reject. Pending reviews survive a reload. Rejecting checks the remote file first and doesn't discard later edits without asking.
- **Command review** covers the workspace root and the command's working folder. If a command names other paths, the tool result says their changes weren't recorded.
- **Project instructions:** `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` from the remote workspace (40 KB each, trusted workspaces only) are given to Claude.
- **Sub-agents** (`remote-general`, `remote-explore`) only get remote and web tools and go through the same approvals and review.
- **Editor context:** *Include current file* sends the active remote file and selection. Remote files can be attached from anywhere on the host.
- **Versions:** Local Agent 0.6.x needs Remote Agent 0.6.0 (API 6) for images and glob search. With 0.5.0 everything else works and those two features say so. Older remotes are refused with a message.

### Automatic server provisioning

1. On first connection, Remote-SSH finds no server at `~/.claude-ide-server/bin/<commit>` and asks the host to download it from Microsoft. No such build exists, so the download fails.
2. Remote-SSH (with `remote.SSH.localServerDownload` at its default, `auto`) falls back to downloading on the client through `_workbench.downloadResource`.
3. A patch in `extHostDownloadService.ts` recognizes a request for this app's own commit and Linux x64 server, and answers it with a copy of the server inside the app. Any other request behaves normally.
4. Remote-SSH copies the archive over `scp`, extracts it and starts the server.
5. `claude-agent-remote` is a built-in extension of that server, so it's available straight away.

Each CI build gets its own commit identity, so an upgraded client installs a new server beside the old one. A patch to the server launcher detects an install that was interrupted while being moved into place, removes it, and lets the next connection reinstall it.

The release also includes `claude-agent-remote-0.6.0.vsix`. Automatic provisioning doesn't need it: it's only for a Claude IDE server that wasn't provisioned from this build. Install it with *Install from VSIX* in a Remote-SSH window.

## Repository structure

```text
claude-agent/                    Local Agent (also built in to the desktop app)
  src/extension.ts               agent sessions, permissions, chat panel, history, attachments
  src/review.ts, hunks.ts        review stack, snapshots, checkpoints, per-change accept and reject
  src/session.ts, presentation.ts  concurrent conversations, scheduling, per-conversation UI state
  src/claudeCli.ts               finding and launching the Claude Code CLI
  src/remoteGuard.ts             the notice shown when remote support is off or the remote isn't SSH
  src/voice.ts                   offline dictation
  src/remote/remoteMode.ts       when remote mode applies; its tools, prompt and query options
  src/remote/remoteWorkspaceServer.ts, remoteFileTools.ts, remoteExecTools.ts, remoteGitTools.ts
                                 the in-process MCP server and its 15 tools
  src/remote/remoteFilesystemClient.ts  typed client for the claudeIde.remote.* bridge
  src/remote/permissions.ts      approval policy for the remote tools
  src/remote/remotePaths.ts      remote path rules
  src/remote/remoteReviewFiles.ts  review backend for remote files
  media/, themes/                chat panel UI, Claude IDE Dark theme
  test/                          unit, integration and live end-to-end tests
claude-agent-remote/             Remote Agent
  src/extension.ts               command handlers (claudeIde.remote.*), API version
  src/core.ts                    path resolution, credential checks, typed errors
  src/files.ts, patch.ts, fileOps.ts  atomic reads and writes, patches, deletes and moves
  src/content.ts                 content search
  src/exec.ts                    process groups, background commands, output paging
  src/git.ts                     git operations
  src/snapshot.ts                before-and-after snapshots for review
fork-patches/
  claudeReview.contribution.ts   inline review UI, chat drop handling, legacy Remote-SSH default
  brand/                         icons and watermark
scripts/
  build.mjs                      pinned checkout, patches, build, server packaging, release files
  apply-fork.mjs                 all patches to Code - OSS (fails if the target text has changed)
  smoke-test.mjs                 launch test
apply-fork.sh, build-app.sh      macOS shortcuts for the scripts
.github/workflows/               build-linux.yml, build-windows.yml
docs/                            screenshots, demo video, the original project's website
```

`vscode-fork/` is a git-ignored checkout of the pinned Code - OSS source. The repository holds the recipe for the app rather than the VS Code source.

## Build and compilation

| Input | Value |
|---|---|
| Code - OSS | 1.140.0, commit `ca1020a2710357004a97608f712a937968a3c433` |
| Electron | 43.7.3 |
| Node | 24 (required by `build.mjs`) |
| Native compiler | Chromium Clang from Chromium 150.0.7871.250, with Electron's libc++ |
| Desktop sysroot | glibc 2.28, GCC 10.5.0 |
| Server sysroot | glibc 2.28, GCC 8.5.0 |
| CI runner | Ubuntu 22.04 |

### What `scripts/build.mjs` does

1. Fetches the pinned commit into `vscode-fork/`, or refuses an existing checkout at any other commit. It never resets or replaces one.
2. Runs `apply-fork.mjs`, which builds the Local Agent and applies the branding, patches and built-in extension. It can be re-run, and it fails loudly if a patch target has changed.
3. Runs `npm ci` in the fork, then `npm run gulp vscode-linux-x64-min` for the desktop app.
4. Removes the unused Copilot components.
5. With `--package` on Linux x64: runs `npm run gulp vscode-reh-linux-x64-min`, compiles the Remote Agent, adds it to the server's `extensions/`, and writes `resources/app/server/vscode-server-linux-x64.tar.gz` inside the app.
6. Writes `release/Claude-IDE-v<version>-Linux-x64.tar.gz`.

### Native toolchain

Native modules, including `native-keymap`, must compile against Electron's V8 headers. The Linux build therefore uses the same setup as Microsoft's Linux pipeline, all from the pinned source:

- `build/azure-pipelines/linux/setup-env.sh` downloads the sysroots, Chromium Clang and Electron's libc++ objects and headers, then exports `CC`, `CXX`, `CXXFLAGS` and `LDFLAGS`, plus the `VSCODE_REMOTE_*` equivalents for the server. It also writes `~/.gyp/include.gypi`.
- `build/npm/preinstall.ts` installs the Electron headers and applies Code - OSS's header overlay.

Both must run before `npm ci`, in the same shell as the build. With the overlay and this toolchain, `native-keymap` builds unmodified, and no patch to the module is needed.

### Building on Linux x64

Install Node 24, Python 3 available as `python`, Git, and the development packages listed in `build-linux.yml`: `build-essential g++ make pkg-config libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev`.

```sh
git clone https://github.com/Anas1005/claude-ide.git
cd claude-ide
COMMIT=$(grep -o "VSCODE_COMMIT = '[0-9a-f]\{40\}'" scripts/build.mjs | grep -o '[0-9a-f]\{40\}')
mkdir vscode-fork && cd vscode-fork
git init -q
git remote add origin https://github.com/microsoft/vscode.git
GIT_LFS_SKIP_SMUDGE=1 git fetch --depth 1 origin "$COMMIT"
git -c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false checkout -q FETCH_HEAD
(cd build && npm ci)
(
  export VSCODE_ARCH=x64 npm_config_arch=x64
  source build/azure-pipelines/linux/setup-env.sh
  node build/npm/preinstall.ts
  cd ..
  node scripts/build.mjs --arch x64 --package
)
```

The output is in `VSCode-linux-x64/` and `release/`. `setup-env.sh` overwrites `~/.gyp/include.gypi`, so back up your own copy if you have one.

To give a local build its own identity on remote hosts, set `BUILD_SOURCEVERSION` to a 40-character hash and `VSCODE_QUALITY=stable`. Without it, the build uses the pinned Code - OSS commit.

### Electron download mirror

The Linux build downloads several Electron release assets, and GitHub's release-download route has returned repeated 504 errors for this release. CI therefore doesn't depend on that route:

1. It fetches `libcxx-objects-v<V>-linux-x64.zip`, `libcxx_headers.zip`, `libcxxabi_headers.zip`, `electron.d.ts`, `electron-v<V>-linux-x64.zip` and `SHASUMS256.txt` through the GitHub API, with retries.
2. It verifies each file against the pinned `build/checksums/electron.txt`, and caches them across runs.
3. It serves them from `127.0.0.1:8597` and sets `ELECTRON_MIRROR`. Both `@electron/get` versions in the build use it, and they still check every file against the served checksums.

A local build only needs this if direct downloads fail.

### macOS, Windows and the extension alone

These build paths come from the original project. This fork doesn't publish or validate them.

```sh
./build-app.sh                       # macOS on Apple silicon: Xcode Command Line Tools, Node 24, Python 3, Git
node scripts/build.mjs --package     # Windows: Visual Studio 2022 with C++ tools, Node 24, Python 3, Git

cd claude-agent && npm install && npm run package   # only the extension: claude-agent.vsix
```

In stock VS Code the extension's review UI uses CodeLens and decorations. The full inline experience needs the Claude IDE app.

## GitHub Actions and distribution

`.github/workflows/build-linux.yml` runs on Ubuntu 22.04, when started by hand (`workflow_dispatch`) or on a `v*` tag.

| Stage | What it does |
|---|---|
| **Extension tests** | Remote Agent tests; Local Agent type check and tests |
| **Pinned source** | Fetches and verifies the Code - OSS commit |
| **Electron assets** | Restores the cache, prefetches anything missing, verifies checksums |
| **Build** | Starts the local mirror, sets up the native toolchain, runs `build.mjs --arch x64 --package` with `BUILD_SOURCEVERSION` set to the workflow commit |
| **Server check** | Confirms that the archive contains the Remote Agent, that its commit matches the app's, and that the server starts |
| **Launch test** | Runs `smoke-test.mjs` under Xvfb: the window opens, the Claude panel loads, and there's no corrupt-installation warning |
| **Remote Agent VSIX** | Packages it and checks its contents and version |
| **Upload** | Publishes the Actions artifact, and attaches files to a release if one is requested |

| | GitHub Actions artifact | GitHub Release |
|---|---|---|
| **Name** | `Claude-IDE-Linux-x64` | A tag such as `v0.6.3` |
| **Contains** | Linux tarball, Remote Agent VSIX, launch screenshot | Linux tarball, Remote Agent VSIX |
| **Created by** | Every run | A `v*` tag, or a run with the `release_tag` input; the release must already exist |
| **Audience** | Maintainers; needs a GitHub sign-in and expires | Public, stable download |

The current public release is [**v0.6.3**](https://github.com/Anas1005/claude-ide/releases/tag/v0.6.3), containing `Claude-IDE-v0.6.3-Linux-x64.tar.gz` and `claude-agent-remote-0.6.0.vsix`. A `v*` tag also triggers the Windows workflow inherited from the original project.

## Testing and compatibility

| Scope | Validation | Run |
|---|---|---|
| Remote Agent on real files, processes and git | `npm test` in `claude-agent-remote` | Every CI build |
| Local Agent: review logic, remote tools, approval policy, remote review, concurrency | `npm run typecheck` and `npm test` in `claude-agent` | Every CI build |
| Bundled server: Remote Agent present, commit matches, starts | CI server check | Every CI build |
| Linux x64 desktop launch and Claude panel | `scripts/smoke-test.mjs` | Every CI build |
| Real CLI and model with the remote tools | `test/e2e/remote-*-live.mjs` | Manually; makes small model calls |
| Concurrent conversations with the real CLI | `test/e2e/multi-conversation-live.mjs` | Manually; makes small model calls |
| Office VM to remote Linux: local Claude Agent, Remote-SSH connection, server provisioning, Remote Agent 0.6.0, the 15 remote MCP tools, 8/8 acceptance scenarios | Manual integration test by the maintainer | Manually |

```sh
cd claude-agent-remote && npm install && npm test   # run first: the Local Agent's remote tests use its out/
cd ../claude-agent && npm install && npm test
node test/e2e/remote-parity-live.mjs                # or any other *-live.mjs test
```

**Not validated for this release:** macOS and Windows clients, arm64 and Alpine hosts, the oldest glibc 2.28 distributions, and voice input on Linux. The original `npm run e2e` suite isn't part of CI and hasn't been re-validated against this fork.

## Limitations

- **Supported remote scope:** Linux x64 client to Linux x64 host. The server is only bundled in the Linux x64 build; arm64 and Alpine hosts, and Windows and macOS clients, aren't provisioned automatically.
- **Remote-SSH is a separate install.** Version 0.113.1 is installed by hand on each client, isn't shipped with Claude IDE, and remains under Microsoft's license terms.
- **Legacy mode only:** Remote-SSH's Exec Server path isn't available.
- **One window for first connection:** the legacy install script has no lock.
- **Larger download:** the Linux release is about 150 MB larger because it carries the server.
- **Remote project configuration:** only the three `CLAUDE.md` locations are read. `@imports`, parent folders, and remote project settings, hooks, commands and skills aren't loaded. MCP servers aren't available in remote mode, apart from the built-in remote tools.
- **Packaging:** Linux ships as an unsigned `.tar.gz`, with no `.deb`, `.rpm` or desktop launcher entry.

## Acknowledgements

Claude IDE was created by **[Sushant (error404sushant)](https://github.com/error404sushant)**. The [original repository](https://github.com/error404sushant/claude-ide) and [website](https://error404sushant.github.io/claude-ide/) cover the project this fork builds on, including the editor fork, inline review experience and original agent integration.

Built on [Code - OSS](https://github.com/microsoft/vscode) (MIT) and the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). Remote connections use Microsoft's [Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) extension, which isn't part of this project. Claude and Claude Code are trademarks of Anthropic; this is an independent project, not affiliated with or endorsed by Anthropic.
