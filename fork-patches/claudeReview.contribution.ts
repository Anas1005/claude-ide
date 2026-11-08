/*---------------------------------------------------------------------------------------------
 *  Claude IDE: Cursor/Antigravity-style inline review UI.
 *  The claude-agent extension owns the review state and pushes hunks here via `_claudeIde.setReview`;
 *  this file only renders: removed lines as view zones, a per-hunk Accept/Reject widget and a floating review bar.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, isHTMLElement } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { ICodeEditor, IOverlayWidget, IOverlayWidgetPosition } from '../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { IEditorContribution } from '../../../../editor/common/editorCommon.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { extractEditorsDropData } from '../../../../platform/dnd/browser/dnd.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

interface Hunk { start: number; added: number; removed: number; removedText: string }
interface Review { hunks: Hunk[]; fileIndex: number; fileCount: number }

const reviews = new ResourceMap<Review>();
const onDidChange = new Emitter<URI>();

CommandsRegistry.registerCommand('_claudeIde.setReview', (_accessor, uri: UriComponents, hunks: Hunk[], fileIndex = 0, fileCount = 1) => {
	const resource = URI.revive(uri);
	if (hunks?.length) {
		reviews.set(resource, { hunks, fileIndex, fileCount });
	} else {
		reviews.delete(resource);
	}
	onDidChange.fire(resource);
	return true;
});

const css = `
.claude-removed { background: rgba(220, 53, 69, 0.14); border-left: 3px solid rgba(220, 53, 69, 0.8); box-sizing: border-box; overflow: hidden; }
.claude-removed div { white-space: pre; text-decoration: line-through; text-decoration-color: rgba(220, 53, 69, 0.55); opacity: 0.85; padding-left: 4px; }
.claude-hunk { padding: 2px; border-radius: 6px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border)); box-shadow: 0 2px 8px var(--vscode-widget-shadow); }
.claude-hunk, .claude-bar { display: flex; gap: 4px; align-items: center; z-index: 10; font-family: var(--vscode-font-family); font-size: 12px; }
.claude-hunk button, .claude-bar button { border: none; border-radius: 4px; padding: 2px 8px; cursor: pointer; font: inherit; color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.2)); white-space: nowrap; }
.claude-hunk button:hover, .claude-bar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
.claude-hunk button.primary, .claude-bar button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
.claude-hunk button.primary:hover, .claude-bar button.primary:hover { background: var(--vscode-button-hoverBackground); }
.claude-hunk kbd, .claude-bar kbd { opacity: 0.7; margin-left: 4px; font-family: inherit; }
.claude-bar { padding: 5px 6px; border-radius: 8px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border)); box-shadow: 0 4px 16px var(--vscode-widget-shadow); }
.claude-bar .count { padding: 0 6px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.claude-bar button.icon { background: none; color: var(--vscode-foreground); padding: 2px 6px; }
`;
let styleInjected = false;

class Widget implements IOverlayWidget {
	allowEditorOverflow = false;
	constructor(private readonly id: string, readonly domNode: HTMLElement, public position: IOverlayWidgetPosition['preference'] = null) { }
	getId() { return this.id; }
	getDomNode() { return this.domNode; }
	getPosition(): IOverlayWidgetPosition | null { return { preference: this.position }; }
}

class ClaudeReviewController extends Disposable implements IEditorContribution {
	static readonly ID = 'editor.contrib.claudeReview';
	private readonly rendered = this._register(new DisposableStore());
	private zoneIds: string[] = [];
	private hunkWidgets: { widget: Widget; hunk: Hunk; zoneLines: number }[] = [];
	private bar?: Widget;

	constructor(
		private readonly editor: ICodeEditor,
		@ICommandService private readonly commands: ICommandService,
	) {
		super();
		if (!styleInjected) {
			styleInjected = true;
			append(editor.getContainerDomNode().ownerDocument.head, $('style')).textContent = css;
		}
		this._register(onDidChange.event(uri => { if (uri.toString() === editor.getModel()?.uri.toString()) { this.render(); } }));
		this._register(editor.onDidChangeModel(() => this.render()));
		this._register(editor.onDidScrollChange(() => this.layout()));
		this._register(editor.onDidLayoutChange(() => this.layout()));
		this._register(editor.onDidChangeCursorPosition(() => this.updateCount()));
		this.render();
	}

	private get review() {
		const uri = this.editor.getModel()?.uri;
		return uri && reviews.get(uri);
	}

	private run(id: string, ...args: unknown[]) {
		this.commands.executeCommand(id, ...args);
	}

	private button(label: string, kbd: string | undefined, cls: string, onClick: () => void) {
		const b = $('button' + (cls ? '.' + cls : ''));
		b.textContent = label;
		if (kbd) { append(b, $('kbd')).textContent = kbd; }
		b.onmousedown = e => { e.preventDefault(); e.stopPropagation(); };
		b.onclick = e => { e.preventDefault(); e.stopPropagation(); onClick(); };
		return b;
	}

	private clear() {
		this.editor.changeViewZones(a => this.zoneIds.forEach(id => a.removeZone(id)));
		this.zoneIds = [];
		for (const { widget } of this.hunkWidgets) { this.editor.removeOverlayWidget(widget); }
		this.hunkWidgets = [];
		if (this.bar) { this.editor.removeOverlayWidget(this.bar); this.bar = undefined; }
		this.rendered.clear();
	}

	private render() {
		this.clear();
		const review = this.review, model = this.editor.getModel();
		if (!review || !model) { return; }
		const path = model.uri.fsPath;
		const fontInfo = this.editor.getOption(EditorOption.fontInfo);
		const lineHeight = this.editor.getOption(EditorOption.lineHeight);
		const lineCount = model.getLineCount();

		review.hunks.forEach((hunk, i) => {
			// Removed lines, rendered above the new code like Cursor/Antigravity.
			let zoneLines = 0;
			if (hunk.removed > 0) {
				const lines = hunk.removedText.replace(/\n$/, '').split('\n');
				zoneLines = lines.length;
				const node = $('div.claude-removed');
				node.style.fontFamily = fontInfo.fontFamily;
				node.style.fontSize = `${fontInfo.fontSize}px`;
				node.style.lineHeight = `${lineHeight}px`;
				for (const line of lines) { append(node, $('div')).textContent = line || ' '; }
				this.editor.changeViewZones(a => this.zoneIds.push(a.addZone({ afterLineNumber: Math.min(hunk.start, lineCount), heightInLines: zoneLines, domNode: node })));
			}
			const dom = $('div.claude-hunk');
			append(dom, this.button('Reject', '⇧⌥⌫', '', () => this.run('claudeIde.rejectHunk', path, i)));
			append(dom, this.button('Accept', '⌥⏎', 'primary', () => this.run('claudeIde.acceptHunk', path, i)));
			const widget = new Widget(`claude.hunk.${i}`, dom);
			this.editor.addOverlayWidget(widget);
			this.hunkWidgets.push({ widget, hunk, zoneLines });
		});

		const bar = $('div.claude-bar');
		append(bar, this.button('↑', undefined, 'icon', () => this.run('claudeIde.prevHunk')));
		append(bar, $('span.count'));
		append(bar, this.button('↓', undefined, 'icon', () => this.run('claudeIde.nextHunk')));
		append(bar, this.button('Reject File', '⌘⌫', '', () => this.run('claudeIde.rejectFile', path)));
		append(bar, this.button('Accept File', '⌘⏎', 'primary', () => this.run('claudeIde.acceptFile', path)));
		if (review.fileCount > 1) {
			append(bar, this.button(`File ${review.fileIndex + 1}/${review.fileCount} ›`, undefined, 'icon', () => this.run('claudeIde.nextFile')));
		}
		this.bar = new Widget('claude.bar', bar);
		this.editor.addOverlayWidget(this.bar);
		this.rendered.add(this.editor.onDidChangeViewZones(() => this.layout()));
		this.updateCount();
		this.layout();
		this.rendered.add(disposableTimeout(() => this.layout(), 0)); // widths are known only after first paint
	}

	private updateCount() {
		const review = this.review, count = this.bar?.domNode.querySelector('.count');
		if (!review || !count) { return; }
		const line = (this.editor.getPosition()?.lineNumber ?? 1) - 1;
		let idx = review.hunks.findIndex(h => line < h.start + Math.max(1, h.added));
		if (idx < 0) { idx = review.hunks.length - 1; }
		clearNode(count);
		count.textContent = `${idx + 1} of ${review.hunks.length}`;
	}

	private layout() {
		const info = this.editor.getLayoutInfo();
		const scrollTop = this.editor.getScrollTop();
		const right = info.width - info.verticalScrollbarWidth - info.minimap.minimapWidth - 12;
		for (const { widget, hunk, zoneLines } of this.hunkWidgets) {
			const lineNumber = Math.min(hunk.start + 1, this.editor.getModel()?.getLineCount() ?? 1);
			// Sit on the first line of the hunk (or on the removed block for pure deletions), right-aligned.
			let top = this.editor.getTopForLineNumber(lineNumber) - scrollTop;
			if (zoneLines) { top -= zoneLines * this.editor.getOption(EditorOption.lineHeight); }
			const width = widget.domNode.offsetWidth || 150;
			const visible = top >= 0 && top < info.height - 60;
			widget.domNode.style.visibility = visible ? 'visible' : 'hidden';
			widget.position = { top: Math.max(0, top), left: Math.max(info.contentLeft, right - width) };
			this.editor.layoutOverlayWidget(widget);
		}
		if (this.bar) {
			const width = this.bar.domNode.offsetWidth || 420;
			this.bar.position = { top: info.height - 52, left: Math.max(0, info.contentLeft + (info.contentWidth - width) / 2) };
			this.editor.layoutOverlayWidget(this.bar);
		}
	}

	override dispose() {
		this.clear();
		super.dispose();
	}
}

registerEditorContribution(ClaudeReviewController.ID, ClaudeReviewController, EditorContributionInstantiation.AfterFirstRender);

/**
 * Lets the Claude chat panel accept files, folders and images dragged from the Explorer, editor tabs or Finder,
 * like the built-in Chat view. During a drag VS Code disables pointer events on webviews, so the drop lands on the
 * webview's overlay element in the workbench; we recognise the Claude one by its iframe and hand the resources over.
 */
class ClaudeDropContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeDrop';

	constructor(@ICommandService commands: ICommandService) {
		super();
		const claudeOverlay = (target: EventTarget | null) => {
			const overlay = isHTMLElement(target) ? target.closest<HTMLElement>('.webview-overlay-content') : null;
			return overlay?.querySelector('iframe[src*="extensionId=local.claude-agent"]') ? overlay : undefined;
		};
		let clearHighlight: ReturnType<typeof setTimeout> | undefined;
		this._register({ dispose: () => clearTimeout(clearHighlight) });
		this._register(addDisposableListener(mainWindow.document, EventType.DRAG_OVER, e => {
			const overlay = claudeOverlay(e.target);
			if (!overlay) {
				return;
			}
			e.preventDefault();
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = 'copy';
			}
			overlay.style.outline = '2px dashed var(--vscode-focusBorder)';
			overlay.style.outlineOffset = '-4px';
			clearTimeout(clearHighlight);
			clearHighlight = setTimeout(() => overlay.style.outline = '', 250);
		}, true));
		this._register(addDisposableListener(mainWindow.document, EventType.DROP, e => {
			const overlay = claudeOverlay(e.target);
			if (!overlay) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			overlay.style.outline = '';
			let uris = extractEditorsDropData(e).map(d => d.resource?.toString()).filter((u): u is string => !!u);
			if (!uris.length && e.dataTransfer) {
				// Fallback for sources that only provide a standard URI list (other apps, browsers).
				const list = e.dataTransfer.getData('application/vnd.code.uri-list') || e.dataTransfer.getData('text/uri-list');
				uris = list.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
			}
			if (uris.length) {
				commands.executeCommand('claudeIde.dropResources', uris);
			}
		}, true));
	}
}

registerWorkbenchContribution2(ClaudeDropContribution.ID, ClaudeDropContribution, WorkbenchPhase.AfterRestored);

// Remote-SSH's Exec Server path needs a CLI that only Microsoft publishes; legacy mode installs the server this app bundles.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{ overrides: { 'remote.SSH.useExecServer': false } }]);
