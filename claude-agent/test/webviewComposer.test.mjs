// The chat webview's composer (media/main.js) in a minimal DOM stand-in: the editor selection chip (file name, line
// range, remove) and what the "send" message carries. The extension side of that message is tested in parity.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import vm from 'vm';

/** Just enough DOM for main.js: elements, text nodes, classes, events, and simple selectors (#id .class tag, descendant, lists). */
function makeDom() {
  class Node { constructor() { this.parentNode = null; this.childNodes = []; } }
  class Text extends Node { constructor(t) { super(); this.data = String(t); } get textContent() { return this.data; } }
  const listeners = new WeakMap();
  class Element extends Node {
    constructor(tag) {
      super(); this.tagName = tag.toUpperCase(); this.attrs = {}; this.style = {}; this.dataset = {}; this.value = ''; this.className = '';
      this.scrollHeight = 0; this.scrollTop = 0; this.clientHeight = 0;
      const self = this;
      this.classList = {
        add: (...c) => { self.className = [...new Set([...self.classes(), ...c])].join(' '); },
        remove: (...c) => { self.className = self.classes().filter(x => !c.includes(x)).join(' '); },
        toggle: (c, on = !self.classes().includes(c)) => { on ? self.classList.add(c) : self.classList.remove(c); return on; },
        contains: c => self.classes().includes(c),
      };
    }
    classes() { return this.className.split(/\s+/).filter(Boolean); }
    get id() { return this.attrs.id; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    get title() { return this.attrs.title; } set title(v) { this.attrs.title = v; }
    append(...kids) { for (const k of kids) { const n = typeof k === 'string' ? new Text(k) : k; n.parentNode = this; this.childNodes.push(n); } }
    appendChild(k) { this.append(k); return k; }
    prepend(...kids) { this.append(...kids); }
    replaceChildren(...kids) { this.childNodes = []; this.append(...kids); }
    remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(c => c !== this); }
    get children() { return this.childNodes.filter(c => c instanceof Element); }
    get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
    set textContent(v) { this.replaceChildren(new Text(v)); }
    set innerHTML(v) { this.childNodes = []; this._html = v; }
    get innerHTML() { return this._html ?? ''; }
    addEventListener(type, fn) { const m = listeners.get(this) ?? {}; (m[type] ??= []).push(fn); listeners.set(this, m); }
    dispatch(type, ev = {}) { for (const fn of listeners.get(this)?.[type] ?? []) fn({ preventDefault() { }, stopPropagation() { }, target: this, ...ev }); }
    click() { this.dispatch('click'); }
    focus() { } blur() { } scrollIntoView() { } select() { }
    descendants() { return this.children.flatMap(c => [c, ...c.descendants()]); }
    matches(simple) {
      return simple.split(/(?=[#.])/).every(p => (p[0] === '#' ? this.id === p.slice(1) : p[0] === '.' ? this.classList.contains(p.slice(1)) : this.tagName === p.toUpperCase()));
    }
    querySelectorAll(sel) {
      const out = new Set();
      for (const alt of sel.split(',').map(s => s.trim().split(/\s+/))) {
        let scope = [this];
        alt.forEach((part, i) => { scope = scope.flatMap(e => e.descendants()).filter(e => e.matches(part)); if (i < alt.length - 1) scope = [...new Set(scope)]; });
        scope.forEach(e => out.add(e));
      }
      return [...out];
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  }
  const root = new Element('html');
  const app = new Element('div'); app.setAttribute('id', 'app'); root.append(app);
  const document = { createElement: t => new Element(t), createTextNode: t => new Text(t), querySelector: s => root.querySelector(s), querySelectorAll: s => root.querySelectorAll(s),
    addEventListener() { }, body: root };
  return { Node, document, root };
}

function loadWebview() {
  const { Node, document } = makeDom();
  const posted = [];
  const windowListeners = {};
  const context = {
    document, Node, console, setTimeout, clearTimeout, Math, JSON, Date, Map, Set, Object, Array, String, Number, Promise, encodeURIComponent,
    acquireVsCodeApi: () => ({ postMessage: m => posted.push(m), getState: () => undefined, setState() { } }),
    window: { addEventListener: (t, fn) => { (windowListeners[t] ??= []).push(fn); } },
    navigator: { clipboard: { writeText: async () => { } } }, requestAnimationFrame: fn => fn(), FileReader: class { },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL('../media/main.js', import.meta.url), 'utf8'), context);
  const receive = m => windowListeners.message.forEach(fn => fn({ data: m }));
  const $ = s => document.querySelector(s);
  const send = text => { $('#input').value = text; vm.runInContext('submit()', context); return posted.filter(m => m.type === 'send').at(-1); };
  return { $, receive, send, posted };
}

test('composer: a selection shows a chip with file name and line range, replaces the file toggle, and is sent', () => {
  const { $, receive, send } = loadWebview();
  receive({ type: 'activeFile', name: 'main.cpp', lines: null });
  assert.ok($('#attachments').classList.contains('hidden'));
  assert.ok(!$('#ctx').classList.contains('hidden'));                         // no selection: the existing toggle

  receive({ type: 'activeFile', name: 'main.cpp', lines: [53, 64] });
  const chip = $('#attachments .sel');
  assert.ok(chip && !$('#attachments').classList.contains('hidden'));
  assert.equal(chip.childNodes[0].textContent, '📄 main.cpp · Lines 53–64');
  assert.ok($('#ctx').classList.contains('hidden'));                          // the chip replaces the toggle
  const m = send('explain this');
  assert.deepEqual([m.text, m.selection, m.attach], ['explain this', true, false]);

  receive({ type: 'activeFile', name: 'main.cpp', lines: [7, 7] });            // selection changed: chip follows
  assert.equal($('#attachments .sel').childNodes[0].textContent, '📄 main.cpp · Line 7');
});

test('composer: removing the chip sends without the selection until the selection changes; no selection keeps the toggle', () => {
  const { $, receive, send } = loadWebview();
  receive({ type: 'activeFile', name: 'util.h', lines: [3, 9] });
  $('#attachments .sel button').click();
  assert.equal($('#attachments .sel'), null);
  assert.ok(!$('#ctx').classList.contains('hidden'));                         // toggle back
  assert.equal(send('q1').selection, false);
  receive({ type: 'activeFile', name: 'util.h', lines: [3, 9] });              // same selection re-posted: stays removed
  assert.equal(send('q2').selection, false);
  receive({ type: 'activeFile', name: 'util.h', lines: [4, 9] });              // a new selection: chip again
  assert.ok($('#attachments .sel'));
  assert.equal(send('q3').selection, true);

  receive({ type: 'activeFile', name: 'other.h', lines: null });               // no selection: existing toggle behaviour
  assert.equal($('#attachments .sel'), null);
  $('#ctx').click();
  const m = send('q4');
  assert.deepEqual([m.selection, m.attach], [false, true]);
});
