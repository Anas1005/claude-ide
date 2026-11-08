import * as vscode from 'vscode';

/** Commands registered outside `contributes.commands` that other parts of the IDE may call. */
const UNCONTRIBUTED_COMMANDS = ['claudeIde.open', 'claudeIde.dropResources'];

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

function explain(remoteName: string) {
  const title = remoteName === 'ssh-remote'
    ? 'Claude Agent does not support Remote-SSH workspaces yet'
    : `Claude Agent does not support "${remoteName}" remote workspaces`;
  const detail = remoteName === 'ssh-remote'
    ? 'Claude runs on this computer, and support for working on files on the SSH host is still being built. ' +
      'Until then nothing is started here: no Claude process, no sessions, and no access to files on either machine.'
    : 'Claude runs on this computer and only works with folders opened locally. ' +
      'Nothing is started here: no Claude process, no sessions, and no access to files on either machine.';
  return { title, detail, action: 'To use Claude now, open a local folder in a new window.' };
}

/**
 * Remote windows: Claude runs on this machine with this machine's credentials, but the project lives on another
 * one. Until remote tools exist, start nothing that could act on local files in its place. The panel, the changes
 * view and every command only explain why.
 */
export function registerRemoteGuard(ctx: vscode.ExtensionContext, remoteName: string) {
  const { title, detail, action } = explain(remoteName);

  const panel: vscode.WebviewViewProvider = {
    resolveWebviewView(view) {
      view.webview.options = { enableScripts: false };
      view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:16px;line-height:1.5}
h2{font-size:1.1em;margin:0 0 8px}p{margin:0 0 8px;color:var(--vscode-descriptionForeground)}</style></head>
<body><h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p><p>${escapeHtml(action)}</p></body></html>`;
    },
  };

  const changes = vscode.window.createTreeView('claudeIde.changes', {
    treeDataProvider: { getChildren: () => [], getTreeItem: (item: vscode.TreeItem) => item },
  });
  changes.message = title;

  const notify = () => void vscode.window.showInformationMessage(`${title}. ${action}`);
  const contributed: { command: string }[] = ctx.extension.packageJSON.contributes?.commands ?? [];
  const commands = [...contributed.map(c => c.command), ...UNCONTRIBUTED_COMMANDS];

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeIde.chat', panel),
    changes,
    ...commands.map(id => vscode.commands.registerCommand(id, notify)),
  );
}
