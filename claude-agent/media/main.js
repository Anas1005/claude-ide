// @ts-check
const vscode = acquireVsCodeApi();
const $ = (sel, root = document) => root.querySelector(sel);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
};
// Every message names the conversation shown when it was sent (the extension acts on that one, not on whichever is shown later).
const send = (type, extra = {}) => vscode.postMessage({ type, conversationId: S.conversationId, ...extra });
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- Markdown (small subset: fences, inline code, bold, italic, headings, lists, links) ----------
const FILE_RE = /^[\w@./-]+\.[A-Za-z0-9]{1,8}(:\d+)?$/;
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, (_, c) => FILE_RE.test(c) ? `<a class="chip" data-file="${c.replace(/:\d+$/, '')}">📄 ${c}</a>` : `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>');
}
const cells = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
const isTableSep = line => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const NUMERIC = /^[-+]?[\d.,]+\s*[kKmMbB%]?\b|^\$[\d.,]+/;
function table(lines) {
  const head = cells(lines[0]), body = lines.slice(2).map(cells);
  // Right-align columns whose body cells are all numbers (token counts, percentages, sizes).
  const num = head.map((_, i) => body.length > 0 && body.every(r => !r[i] || NUMERIC.test(r[i])));
  const td = (tag, c, i) => `<${tag}${num[i] ? ' class="num"' : ''}>${inline(c ?? '')}</${tag}>`;
  return `<div class="mdtable"><table><thead><tr>${head.map((c, i) => td('th', c, i)).join('')}</tr></thead><tbody>${body.map(r => `<tr>${head.map((_, i) => td('td', r[i], i)).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function md(src) {
  const out = [];
  const parts = src.split(/^```[^\n]*\n([\s\S]*?)^```\s*$/m);
  parts.forEach((part, i) => {
    if (i % 2) { out.push(`<div class="code"><button class="copy" title="Copy">⧉</button><pre><code>${esc(part)}</code></pre></div>`); return; }
    let list = '';
    const lines = part.split('\n');
    for (let j = 0; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim().startsWith('|') && isTableSep(lines[j + 1] ?? '')) {
        if (list) { out.push('</ul>'); list = ''; }
        let end = j + 2;
        while (end < lines.length && lines[end].trim().startsWith('|')) end++;
        out.push(table(lines.slice(j, end)));
        j = end - 1;
        continue;
      }
      const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
      if (li && !/^\s*[-*]{3,}\s*$/.test(line)) { if (!list) out.push('<ul>'); list = 'ul'; out.push(`<li>${inline(li[1])}</li>`); continue; }
      if (list) { out.push('</ul>'); list = ''; }
      const hd = line.match(/^(#{1,4})\s+(.*)/);
      if (hd) out.push(`<h${hd[1].length + 2}>${inline(hd[2])}</h${hd[1].length + 2}>`);
      else if (/^\s*([-*_])\s*\1\s*\1[-*_\s]*$/.test(line)) out.push('<hr>');
      else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    if (list) out.push('</ul>');
  });
  return out.join('');
}

// ---------- State ----------
const S = { commands: [], cmdIdx: 0, cmdMatches: [], refs: [], attach: false, activeFile: '', selLines: null, selRemoved: '', images: [], busy: false, files: [], stripOpen: false, stripIdx: 0, turn: null, stream: null, started: 0, sessions: [], models: [], showHistory: false, conversationId: undefined, seq: 0, replaying: false, activity: [] };

// ---------- Icons (inline SVG, follow currentColor) ----------
const ICONS = {
  plus: '<path d="M8 3v10M3 8h10"/>',
  history: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2.2 1.3"/>',
  more: '<circle cx="3.5" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="12.5" cy="8" r="1" fill="currentColor"/>',
  attach: '<path d="M11 6.5 6.8 10.7a1.6 1.6 0 0 1-2.3-2.3l4.6-4.6a2.8 2.8 0 0 1 4 4l-4.8 4.8a4 4 0 0 1-5.7-5.7L7 2.5"/>',
  mic: '<rect x="6" y="2" width="4" height="8" rx="2"/><path d="M3.8 8a4.2 4.2 0 0 0 8.4 0M8 12.2V14"/>',
  recording: '<circle cx="8" cy="8" r="4" fill="currentColor"/>',
  wait: '<circle cx="4" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="12" cy="8" r="1" fill="currentColor"/>',
  send: '<path d="M8 13V3.5M4 7.5 8 3.5l4 4"/>',
  stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none"/>',
  file: '<path d="M4.5 2h4.5l3 3v9h-7.5z"/><path d="M9 2v3h3"/>',
};
const icon = name => { const i = h('span', { class: 'ico' }); i.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`; return i; };
const setIcon = (el, name) => el.replaceChildren(icon(name));
const LOGO = '<svg viewBox="0 0 100 100" width="56" height="56"><g>' + [[0, 0, '#E8895A'], [1, 0, '#F2B06A'], [2, 0, '#D9774B'], [0, 1, '#E07B4C'], [0, 2, '#C0582F'], [1, 2, '#D9774B'], [2, 2, '#E8895A']].map(([c, r, f]) => `<rect x="${7 + c * 30}" y="${7 + r * 30}" width="26" height="26" rx="6" fill="${f}"/>`).join('') + '</g></svg>';

// ---------- Layout ----------
const app = $('#app');
const iconBtn = (name, title, onclick, id) => { const b = h('button', { class: 'icon', title, onclick, id }); setIcon(b, name); return b; };
app.append(
  h('header', {},
    h('div', { class: 'title', id: 'title' }, 'New chat'),
    h('select', { id: 'folder', title: 'Project folder', onchange: e => send('setFolder', { value: e.target.value }) }),
    iconBtn('plus', 'New chat', () => send('newChat')),
    iconBtn('history', 'History', () => toggleHistory()),
    iconBtn('more', 'More', () => $('#menu').classList.toggle('open'), 'moreBtn'),
    h('div', { id: 'menu', class: 'menu' },
      h('button', { onclick: () => { send('signIn'); $('#menu').classList.remove('open'); } }, 'Sign in with Claude Code'),
      h('button', { onclick: () => { send('setApiKey'); $('#menu').classList.remove('open'); } }, 'Use an API key…'),
      h('button', { onclick: () => { send('checkAuth'); $('#menu').classList.remove('open'); } }, 'Re-check sign-in'))),
  h('div', { id: 'trust', class: 'auth hidden' },
    h('div', { class: 'logo' }),
    h('h2', {}, 'Trust this folder?'),
    h('p', { class: 'muted' }, 'This folder is open in Restricted Mode. Claude reads, edits and runs code, so it only works in folders you trust.'),
    h('button', { class: 'primary', onclick: () => send('trust') }, 'Trust folder…')),
  h('div', { id: 'auth', class: 'auth hidden' },
    h('div', { class: 'logo' }),
    h('h2', {}, 'Sign in to Claude'),
    h('p', { id: 'authDetail', class: 'muted' }, ''),
    h('button', { class: 'primary', onclick: () => send('signIn') }, 'Sign in to Claude'),
    h('p', { class: 'muted' }, 'Opens a terminal running `claude /login`. Come back when done.'),
    h('button', { onclick: () => send('checkAuth') }, "I've signed in"),
    h('button', { class: 'link', onclick: () => send('setApiKey') }, 'Use an API key instead')),
  h('div', { id: 'history', class: 'history hidden' },
    h('input', { id: 'search', placeholder: 'Search conversations…', oninput: () => renderHistory() }),
    h('div', { id: 'sessions' })),
  h('div', { id: 'activity', class: 'activity hidden' }),
  h('main', { id: 'log' }),
  h('div', { id: 'strip', class: 'strip hidden' }),
  h('footer', {},
    h('div', { id: 'cmdmenu', class: 'cmdmenu hidden' }),
    h('div', { class: 'composer' },
      h('div', { id: 'attachments', class: 'attachments hidden' }),
      h('textarea', { id: 'input', rows: 1, placeholder: 'Ask Claude to build, fix or explain…', onkeydown: onKey, oninput: e => { onInput(e); autosize(); }, onpaste: onPaste }),
      h('div', { class: 'toolbar' },
        h('button', { id: 'ctx', class: 'chip-toggle hidden', onclick: () => { S.attach = !S.attach; renderCtx(); } }),
        iconBtn('attach', 'Attach files (or drag them here)', () => send('pickFile', { inline: false })),
        iconBtn('mic', 'Voice input (click to start, click again to stop)', () => send(S.mic === 'recording' ? 'micStop' : 'micStart'), 'mic'),
        h('span', { class: 'spacer' }),
        iconBtn('send', 'Send (Enter)', () => (S.busy ? send('stop') : submit()), 'go'))),
    h('div', { class: 'row selects' },
      h('select', { id: 'model', title: 'Model', onchange: e => send('setModel', { value: e.target.value }) }),
      h('select', { id: 'effort', title: 'Thinking effort', onchange: e => send('setEffort', { value: e.target.value }) },
        ...['low', 'medium', 'high', 'xhigh', 'max'].map(v => h('option', { value: v }, v))),
      h('select', { id: 'mode', title: 'Permission mode', onchange: e => send('setMode', { value: e.target.value }) },
        h('option', { value: 'auto', title: 'Apply changes immediately (Undo per file)' }, 'Auto'), h('option', { value: 'ask', title: 'Stage every change for review' }, 'Ask'),
        h('option', { value: 'askBeforeEach', title: 'Approve each edit before it is written' }, 'Ask each edit'), h('option', { value: 'plan', title: 'Read and propose only' }, 'Plan')))),
);
$('#go').classList.add('send');
$('#auth .logo').innerHTML = LOGO;
$('#trust .logo').innerHTML = LOGO;

function autosize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 220) + 'px';
}

// Welcome screen for an empty chat.
const SUGGESTIONS = ['Explain how this project is structured', 'Find and fix a bug in the current file', 'Write tests for the current file'];
function showEmpty() {
  if (log.querySelector('.turn, .empty')) return;
  const e = h('div', { class: 'empty' }, h('div', { class: 'logo' }), h('h2', {}, 'What are we building?'),
    h('p', { class: 'muted' }, 'Claude Code works in this folder. Every change waits for your review.'),
    h('div', { class: 'suggestions' }, ...SUGGESTIONS.map(t => h('button', { class: 'suggestion', onclick: () => { $('#input').value = t; autosize(); submit(); } }, t))));
  $('.logo', e).innerHTML = LOGO;
  log.append(e);
}

const log = $('#log');
const scroll = () => { if (log.scrollHeight - log.scrollTop - log.clientHeight < 200) log.scrollTop = log.scrollHeight; };

function submit() {
  const input = $('#input');
  const text = input.value.trim();
  if ((!text && !S.images.length && !S.refs.length) || S.busy) return;
  send('send', { text: text || (S.images.length ? 'See the attached image.' : 'See the attached files.'), attach: S.attach, images: S.images, refs: S.refs.map(r => r.path), selection: selShown() });
  input.value = '';
  autosize();
  S.images = [];
  S.refs = [];
  renderAttachments();
}
function onKey(e) {
  if (menuOpen()) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); S.cmdIdx = (S.cmdIdx + (e.key === 'ArrowDown' ? 1 : -1) + S.cmdMatches.length) % S.cmdMatches.length; renderMenu(); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) { e.preventDefault(); chooseCommand(S.cmdMatches[S.cmdIdx], e.key === 'Enter'); return; }
    if (e.key === 'Escape') { e.preventDefault(); S.menuClosedFor = $('#input').value; hideMenu(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
}

// ---------- "/" command menu (built-in commands, custom commands, skills, plugins) ----------
const menuOpen = () => !$('#cmdmenu').classList.contains('hidden');
const hideMenu = () => $('#cmdmenu').classList.add('hidden');
function updateMenu() {
  const t = $('#input'), v = t.value, head = v.slice(0, t.selectionStart);
  // Only while typing the command name: "/" at the start and no space yet.
  if (!v.startsWith('/') || /\s/.test(head) || !S.commands.length || S.menuClosedFor === v) { hideMenu(); return; }
  const q = head.slice(1).toLowerCase();
  const score = c => {
    const names = [c.name, ...c.aliases].map(n => n.toLowerCase());
    if (names.some(n => n.startsWith(q))) return 0;
    if (names.some(n => n.split(/[:-]/).some(part => part.startsWith(q)))) return 1;
    return names.some(n => n.includes(q)) || c.description.toLowerCase().includes(q) ? 2 : -1;
  };
  S.cmdMatches = S.commands.map(c => [score(c), c]).filter(([sc]) => sc >= 0).sort((a, b) => a[0] - b[0]).map(([, c]) => c).slice(0, 60);
  if (!S.cmdMatches.length) { hideMenu(); return; }
  S.cmdIdx = Math.min(S.cmdIdx, S.cmdMatches.length - 1);
  renderMenu();
}
function renderMenu() {
  const menu = $('#cmdmenu');
  menu.classList.remove('hidden');
  menu.replaceChildren(...S.cmdMatches.map((c, i) => {
    const tag = c.name.includes(':') ? c.name.split(':')[0] : c.builtin ? '' : 'skill';
    const alias = c.aliases.find(a => a.toLowerCase().startsWith($('#input').value.slice(1).toLowerCase()) && !c.name.startsWith($('#input').value.slice(1)));
    const row = h('div', { class: 'cmd' + (i === S.cmdIdx ? ' on' : ''), onmousedown: e => { e.preventDefault(); chooseCommand(c, false); } },
      h('div', { class: 'cmdtop' }, h('span', { class: 'cmdname' }, '/' + c.name), c.hint ? h('span', { class: 'cmdhint' }, c.hint) : null, alias ? h('span', { class: 'cmdhint' }, `(${alias})`) : null, h('span', { class: 'spacer' }), tag ? h('span', { class: 'cmdtag' }, tag) : null),
      c.description ? h('div', { class: 'cmddesc' }, c.description) : null);
    return row;
  }));
  menu.children[S.cmdIdx]?.scrollIntoView({ block: 'nearest' });
}
function chooseCommand(c, enter) {
  const t = $('#input');
  const rest = t.value.slice(t.selectionStart).replace(/^\S*/, '').trimStart();
  t.value = '/' + c.name + ' ' + rest;
  hideMenu();
  t.focus();
  t.selectionStart = t.selectionEnd = t.value.length;
  autosize();
  // Enter on a command that takes no arguments runs it right away, like the CLI.
  if (enter && !c.hint && !rest) submit();
}
let draftTimer;
function saveDraft() { clearTimeout(draftTimer); draftTimer = setTimeout(() => send('draft', { text: $('#input').value }), 300); }
function onInput(e) {
  saveDraft();
  S.cmdIdx = 0;
  updateMenu();
  if (e.inputType === 'insertText' && e.data === '@') {
    const t = e.target; t.value = t.value.slice(0, t.selectionStart - 1) + t.value.slice(t.selectionStart);
    send('pickFile');
  }
}
// ---------- Image attachments (paste or drop screenshots) ----------
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
function addImage(img) { S.images.push(img); renderAttachments(); }
function readImage(file) {
  if (!IMAGE_TYPES.includes(file.type)) return false;
  if (file.size > 5 * 1024 * 1024) { log.append(h('div', { class: 'step error' }, `${file.name}: images must be under 5 MB`)); return true; }
  const r = new FileReader();
  r.onload = () => addImage({ name: file.name || 'screenshot.png', mediaType: file.type, data: String(r.result).split(',')[1] });
  r.readAsDataURL(file);
  return true;
}
/** The editor selection chip: shown for a non-empty selection until removed (a new selection brings it back). */
const selKey = () => (S.selLines ? `${S.activeFile}:${S.selLines[0]}-${S.selLines[1]}` : '');
const selShown = () => !!S.selLines && S.selRemoved !== selKey();
function renderAttachments() {
  const el = $('#attachments');
  const sel = selShown();
  el.classList.toggle('hidden', !sel && !S.images.length && !S.refs.length);
  el.replaceChildren(
    ...(sel ? [h('span', { class: 'ref sel', title: `Selected code in ${S.activeFile} is sent with your message` },
      `📄 ${S.activeFile} · ${S.selLines[0] === S.selLines[1] ? `Line ${S.selLines[0]}` : `Lines ${S.selLines[0]}–${S.selLines[1]}`}`,
      h('button', { class: 'icon', title: 'Remove selection', onclick: () => { S.selRemoved = selKey(); renderAttachments(); renderCtx(); } }, '✕'))] : []),
    ...S.refs.map((r, i) => h('span', { class: 'ref', title: r.path }, (r.isDir ? '📁 ' : '📄 ') + r.name,
      h('button', { class: 'icon', title: 'Remove', onclick: () => { S.refs.splice(i, 1); renderAttachments(); } }, '✕'))),
    ...S.images.map((img, i) => h('span', { class: 'thumb', title: img.name },
      h('img', { src: `data:${img.mediaType};base64,${img.data}` }),
      h('button', { class: 'icon', title: 'Remove', onclick: () => { S.images.splice(i, 1); renderAttachments(); } }, '✕'))));
}
function addRef(ref) {
  if (!S.refs.some(r => r.path === ref.path)) S.refs.push(ref);
  renderAttachments();
  $('#input').focus();
}
function onPaste(e) {
  const files = [...(e.clipboardData?.files ?? [])].filter(f => IMAGE_TYPES.includes(f.type));
  if (!files.length) return;
  e.preventDefault();
  files.forEach(readImage);
}

function renderCtx() {
  const b = $('#ctx');
  b.classList.toggle('hidden', !S.activeFile || selShown());   // a selection chip replaces the toggle
  b.classList.toggle('on', S.attach);
  b.replaceChildren(icon(S.attach ? 'file' : 'plus'), h('span', {}, S.activeFile));
  b.title = S.attach ? 'Current file is included — click to exclude' : 'Click to include the current file (and selection)';
}

function toggleHistory(show = !S.showHistory) {
  S.showHistory = show;
  $('#history').classList.toggle('hidden', !show);
  log.classList.toggle('hidden', show);
  if (show) { send('history'); $('#search').focus(); }
}

// ---------- Turn rendering ----------
function newTurn(text, turn, images = [], refs = []) {
  log.querySelector('.empty')?.remove();
  const t = h('section', { class: 'turn' });
  const msg = h('div', { class: 'user' }, h('div', { class: 'bubble' }, text,
    refs.length ? h('div', { class: 'thumbs' }, ...refs.map(r => h('a', { class: 'chip', 'data-file': r.replace(/\/$/, '') }, (r.endsWith('/') ? '📁 ' : '📄 ') + r))) : null,
    images.length ? h('div', { class: 'thumbs' }, ...images.map(i => h('img', { src: `data:${i.mediaType};base64,${i.data}` }))) : null));
  if (turn) {
    t.dataset.turn = turn;
    t.prompt = { text, images, refs };
    msg.append(h('button', { class: 'link restore', title: 'Undo file changes from this message on and edit this message again', onclick: () => {
      const all = [...log.querySelectorAll('section.turn')];
      send('restore', { turns: all.slice(all.indexOf(t)).map(s => s.dataset.turn).filter(Boolean) });
    } }, '↺ Restore to here'));
  }
  t.append(msg, h('div', { class: 'steps' }));
  log.append(t);
  S.turn = t; S.stream = null;
  return t;
}
const steps = () => $('.steps', S.turn ?? newTurn(''));

const EXPLORE = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch']);
const toolEls = new Map();

function addTool(m) {
  const verb = { Read: 'Read', Grep: 'Searched', Glob: 'Searched', LS: 'Listed', Bash: 'Ran', Edit: 'Edited', MultiEdit: 'Edited', Write: 'Wrote', NotebookEdit: 'Edited', WebFetch: 'Fetched', WebSearch: 'Searched web', Task: 'Agent', Agent: 'Agent', TodoWrite: 'Updated' }[m.name] ?? m.name;
  const target = m.path
    ? h('a', { class: 'chip', onclick: e => { e.preventDefault(); send('open', { path: m.path }); } }, '📄 ' + m.summary.split('/').pop())
    : h(m.name === 'Bash' ? 'code' : 'span', {}, m.summary);
  const stats = m.stats ? h('span', { class: 'stats' }, h('span', { class: 'add' }, `+${m.stats.add}`), ' ', h('span', { class: 'del' }, `−${m.stats.del}`)) : null;
  const el = h('details', { class: 'step tool' + (m.sub ? ' sub' : '') }, h('summary', {}, h('span', { class: 'verb' }, verb), ' ', target, ' ', stats), h('pre', { class: m.name === 'Bash' ? 'term' : '' }, '…'));
  toolEls.set(m.id, el);
  const st = steps();
  // Collapse consecutive exploration into one "Explored …" line.
  if (EXPLORE.has(m.name)) {
    let group = st.lastElementChild?.classList.contains('explore') ? st.lastElementChild : null;
    if (!group) st.append(group = h('details', { class: 'step explore' }, h('summary', {}), h('div', { class: 'inner' })));
    $('.inner', group).append(el);
    const tools = [...group.querySelectorAll('.tool .verb')].map(v => v.textContent);
    const files = tools.filter(v => v === 'Read').length, searches = tools.length - files;
    $('summary', group).textContent = `Explored ${[files && `${files} file${files > 1 ? 's' : ''}`, searches && `${searches} search${searches > 1 ? 'es' : ''}`].filter(Boolean).join(', ')}`;
  } else st.append(el);
  S.stream = null;
  scroll();
}

function setText(el, text) { el.dataset.raw = text; el.innerHTML = md(text); }
function delta(text) {
  if (!S.stream) steps().append(S.stream = h('div', { class: 'step text' }));
  setText(S.stream, (S.stream.dataset.raw ?? '') + text);
  scroll();
}
function assistantText(text) {
  if (S.stream) setText(S.stream, text);
  else { const el = h('div', { class: 'step text' }); setText(el, text); steps().append(el); }
  S.stream = null;
  scroll();
}

function done(m) {
  const st = S.turn && $('.steps', S.turn);
  if (!st) return;
  $('.working', S.turn)?.remove();
  // Fold everything before the final answer into "Worked for …".
  const kids = [...st.children];
  const lastText = [...kids].reverse().find(k => k.classList.contains('text'));
  const fold = kids.slice(0, lastText ? kids.indexOf(lastText) : kids.length).filter(k => !k.classList.contains('perm') || k.dataset.done);
  if (fold.length) {
    const secs = Math.max(1, Math.round((m.durationMs ?? Date.now() - S.started) / 1000));
    const label = m.replay ? `Worked (${fold.length} steps)` : `Worked for ${secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`}`;
    const box = h('details', { class: 'step worked' }, h('summary', {}, label), h('div', { class: 'inner' }));
    st.insertBefore(box, fold[0]);
    $('.inner', box).append(...fold);
  }
  if (m.error) st.append(h('div', { class: 'step error' }, m.error));
  if (!m.replay && S.replaying) {
    // Rebuilding from a snapshot: keep the cost line, not the (stale) review buttons.
    const meta = [m.cost != null && `$${m.cost.toFixed(4)}`, m.tokens && `${(m.tokens / 1000).toFixed(1)}k tokens`].filter(Boolean).join(' · ');
    if (meta) st.append(h('div', { class: 'meta' }, meta));
  }
  if (!m.replay && !S.replaying) {
    const meta = [m.cost != null && `$${m.cost.toFixed(4)}`, m.tokens && `${(m.tokens / 1000).toFixed(1)}k tokens`].filter(Boolean).join(' · ');
    if (meta) st.append(h('div', { class: 'meta' }, meta));
    if (S.files.length) {
      const add = S.files.reduce((a, f) => a + f.add, 0), del = S.files.reduce((a, f) => a + f.del, 0);
      refreshCards(true);
      st.append(h('div', { class: 'card live' }, h('span', { class: 'summary' }, `${S.files.length} file${S.files.length > 1 ? 's' : ''} changed `, h('span', { class: 'add' }, `+${add}`), ' ', h('span', { class: 'del' }, `−${del}`)),
        h('span', { class: 'actions' }, h('button', { onclick: () => send('review') }, 'Review'), h('button', { onclick: () => send('rejectAll') }, 'Reject All'), h('button', { class: 'primary', onclick: () => send('acceptAll') }, 'Accept All'))));
    }
  }
  S.stream = null;
  scroll();
}

function answerCard(card, choice) {
  card.dataset.done = '1';
  card.querySelector('.row')?.replaceWith(h('div', { class: 'muted' }, `→ ${choice}`));
}
function permission(m) {
  const card = h('div', { class: 'step perm ' + (m.kind ?? ''), 'data-id': m.id },
    h('div', { class: 'ptitle' }, m.kind === 'bash' ? 'Run command?' : m.kind === 'edit' ? `Apply ${m.title}?` : m.title),
    m.kind === 'plan' ? h('div', { class: 'text', innerHTML: '' }) : h('pre', { class: m.kind === 'bash' ? 'term' : '' }, m.detail),
    h('div', { class: 'row' }, ...m.choices.map((c, i) => h('button', {
      class: i === 0 ? 'primary' : '', onclick: () => {
        send('permission', { id: m.id, choice: c });
        answerCard(card, c);
      },
    }, c)), m.path ? h('button', { class: 'link', onclick: () => send('openDiff', { path: m.path }) }, 'Open diff') : null));
  if (m.kind === 'plan') card.children[1].innerHTML = md(m.detail);
  if (m.answered !== undefined) answerCard(card, m.answered || 'dismissed');
  steps().append(card);
  S.stream = null;
  scroll();
}

// Cards are only actionable while their changes are still pending.
// The newest card tracks the live stack; older ones and fully-reviewed ones become static.
function refreshCards(supersede = false) {
  for (const c of document.querySelectorAll('.card.live')) {
    if (supersede || !S.files.length) {
      c.classList.remove('live');
      c.querySelector('.actions')?.remove();
      if (c.dataset.orig) c.firstElementChild.innerHTML = c.dataset.orig;
      c.append(h('span', { class: 'muted' }, S.files.length ? '' : ' ✓ Reviewed'));
    } else {
      const add = S.files.reduce((a, f) => a + f.add, 0), del = S.files.reduce((a, f) => a + f.del, 0);
      c.dataset.orig ??= c.firstElementChild.innerHTML;
      c.firstElementChild.replaceChildren(`${S.files.length} file${S.files.length > 1 ? 's' : ''} pending `, h('span', { class: 'add' }, `+${add}`), ' ', h('span', { class: 'del' }, `−${del}`));
    }
  }
}

// ---------- Questions from Claude (AskUserQuestion) ----------
function question(m) {
  const picked = m.questions.map(() => new Set());
  const other = m.questions.map(() => '');
  const card = h('div', { class: 'step perm question', 'data-id': m.id });
  const answerOf = i => [...picked[i]].map(k => k === '__other' ? other[i].trim() : k).filter(Boolean).join(', ');
  const submit = h('button', { class: 'primary', disabled: true, onclick: () => finish(true) }, 'Submit');
  const refresh = () => { submit.disabled = !m.questions.every((_, i) => answerOf(i)); };
  const finish = ok => {
    const answers = Object.fromEntries(m.questions.map((q, i) => [q.question, answerOf(i)]));
    send('permission', { id: m.id, choice: ok ? JSON.stringify(answers) : 'deny' });
    showAnswers(ok ? answers : undefined);
  };
  const showAnswers = answers => {
    card.dataset.done = '1';
    card.replaceChildren(...m.questions.map(q => h('div', {}, h('span', { class: 'muted' }, q.header + ': '), answers ? answers[q.question] : '(skipped)')));
  };
  card.answer = choice => { let a; try { a = JSON.parse(choice); } catch { a = undefined; } showAnswers(a && typeof a === 'object' ? a : undefined); };
  m.questions.forEach((q, i) => {
    const opts = h('div', { class: 'options' });
    const paint = () => opts.querySelectorAll('.opt').forEach(b => {
      const on = picked[i].has(b.dataset.key);
      b.classList.toggle('on', on);
      b.querySelector('.check').textContent = on ? (q.multiSelect ? '☑' : '●') : (q.multiSelect ? '☐' : '○');
    });
    for (const o of q.options) {
      const b = h('button', { class: 'opt', title: o.description ?? '', 'data-key': o.label }, h('span', { class: 'check' }, q.multiSelect ? '☐' : '○'), h('span', {}, h('b', {}, o.label), o.description ? h('div', { class: 'muted' }, o.description) : null));
      b.onclick = () => {
        if (q.multiSelect) picked[i].has(o.label) ? picked[i].delete(o.label) : picked[i].add(o.label);
        else { picked[i].clear(); picked[i].add(o.label); custom.value = ''; other[i] = ''; }
        paint(); refresh();
      };
      opts.append(b);
    }
    // Custom answer, always visible: replaces the choice for single-select, adds to the ticks for multi-select.
    const custom = h('input', { class: 'other', placeholder: q.multiSelect ? 'Add your own answer…' : 'Or type your own answer…', oninput: e => {
      other[i] = e.target.value;
      if (!q.multiSelect && other[i].trim()) picked[i].clear();
      other[i].trim() ? picked[i].add('__other') : picked[i].delete('__other');
      paint(); refresh();
    }, onkeydown: e => { if (e.key === 'Enter' && !submit.disabled) finish(true); } });
    opts.append(custom);
    card.append(h('div', { class: 'qhead' }, h('span', { class: 'badge' }, q.header), q.multiSelect ? h('span', { class: 'muted' }, ' · pick any') : null), h('div', { class: 'ptitle' }, q.question), opts);
  });
  card.append(h('div', { class: 'row' }, submit, h('button', { class: 'link', onclick: () => finish(false) }, 'Skip')));
  if (m.answered !== undefined) card.answer(m.answered);
  steps().append(card);
  S.stream = null;
  scroll();
}

// ---------- Changed files strip ----------
function renderStrip() {
  const el = $('#strip');
  el.replaceChildren();
  el.classList.toggle('hidden', !S.files.length);
  if (!S.files.length) return;
  const n = S.files.length;
  el.append(h('div', { class: 'strip-head' },
    h('button', { class: 'link title', title: `${n} file(s) with changes`, onclick: () => { S.stripOpen = !S.stripOpen; renderStrip(); } }, `${S.stripOpen ? '▾' : '▸'} ${n} File${n > 1 ? 's' : ''}`, h('span', { class: 'wide' }, ' With Changes')),
    h('span', { class: 'actions' },
      h('button', { class: 'icon', title: 'Previous file', onclick: () => stepFile(-1) }, '←'),
      h('button', { class: 'icon', title: 'Next file', onclick: () => stepFile(1) }, '→'),
      h('button', { class: 'link', onclick: () => send('rejectAll') }, 'Reject all'),
      h('button', { class: 'primary', onclick: () => send('acceptAll') }, 'Accept all'))));
  if (!S.stripOpen) return;
  el.append(h('div', { class: 'strip-list' }, ...S.files.map(f => h('div', { class: 'file', title: f.path, onclick: () => send('open', { path: f.path }) },
    h('span', { class: 'status s' + f.status }, f.status),
    h('span', { class: 'add' }, `+${f.add}`), h('span', { class: 'del' }, `−${f.del}`),
    h('span', { class: 'name' }, f.name), h('span', { class: 'dir' }, f.dir),
    h('span', { class: 'spacer' }),
    h('button', { class: 'icon', title: 'Reject', onclick: e => { e.stopPropagation(); send('reject', { path: f.path }); } }, '✗'),
    h('button', { class: 'icon', title: 'Accept', onclick: e => { e.stopPropagation(); send('accept', { path: f.path }); } }, '✓')))));
}
function stepFile(d) {
  S.stripIdx = (S.stripIdx + d + S.files.length) % S.files.length;
  send('open', { path: S.files[S.stripIdx].path });
}

// ---------- History ----------
function ago(t) {
  const s = (Date.now() - t) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}
function fmtSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}
function renderHistory() {
  const q = $('#search').value.toLowerCase();
  const list = S.sessions.filter(s => s.title.toLowerCase().includes(q));
  $('#sessions').replaceChildren(...(list.length ? list.map(s => h('div', { class: 'session' + (s.current ? ' current' : ''), onclick: () => { toggleHistory(false); send('openSession', { id: s.id }); } },
    h('div', { class: 'stitle' }, s.running ? h('span', { class: 'badge running', title: 'Claude is working in this conversation' }, '● ') : null, s.title),
    h('div', { class: 'muted' }, [ago(s.time), s.branch && `⎇ ${s.branch}`, s.size && fmtSize(s.size)].filter(Boolean).join(' · ')))) : [h('div', { class: 'muted pad' }, 'No conversations for this folder yet.')]));
}

// ---------- Messages from extension ----------
function setBusy(b, quiet = false) {
  S.busy = b;
  const go = $('#go');
  setIcon(go, b ? 'stop' : 'send');
  go.classList.toggle('busy', b);
  go.title = b ? 'Stop' : 'Send (Enter)';
  if (b && !quiet) { S.started = Date.now(); steps().append(h('div', { class: 'working' }, h('span', { class: 'dot' }), ' Working…')); }
  if (!b) $('.working', log)?.remove();
}

// ---------- Conversations: snapshot + numbered deltas, background activity ----------
/** Replaces the view with one conversation's state (on switching, or when the panel was recreated). */
function applySnapshot(m) {
  const switched = m.conversationId !== S.conversationId;
  if (switched && S.conversationId) { clearTimeout(draftTimer); send('draft', { text: $('#input').value }); }   // keep the unsent text of the one we leave
  S.conversationId = m.conversationId;
  S.seq = m.seq;
  const st = m.state;
  log.replaceChildren();
  toolEls.clear();
  S.turn = null; S.stream = null;
  setBusy(false, true);
  $('#title').textContent = st.title;
  $('#mode').value = st.mode;
  $('#effort').value = st.effort;
  if ([...$('#model').options].some(o => o.value === st.model)) $('#model').value = st.model;
  toggleHistory(false);
  S.replaying = true;
  try { for (const ev of st.events) handle(ev); } finally { S.replaying = false; }
  if (!log.querySelector('section.turn')) showEmpty();
  if (switched) { const t = $('#input'); t.value = st.draft ?? ''; autosize(); }
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
  renderActivity();
}

/** Other conversations that are working, waiting for approval, or were interrupted: click one to show it. */
function renderActivity(m) {
  if (m) S.activity = m.conversations;
  const list = S.activity.filter(c => c.conversationId !== S.conversationId);
  const el = $('#activity');
  el.classList.toggle('hidden', !list.length);
  el.replaceChildren(...list.map(c => h('button', {
    class: 'act ' + c.status + (c.pendingApprovals ? ' approval' : ''),
    title: c.pendingApprovals ? `${c.title}: waiting for your approval` : `${c.title}: ${c.status}`,
    onclick: () => send('switchTo', { conversationId: c.conversationId }),
  }, h('span', { class: 'dot' }), h('span', { class: 'name' }, c.title || 'New chat'),
    c.pendingApprovals ? h('span', { class: 'count' }, String(c.pendingApprovals)) : null)));
}

window.addEventListener('message', ({ data: m }) => {
  if (m.type === 'snapshot') return applySnapshot(m);
  if (m.type === 'activity') return renderActivity(m);
  if (m.type === 'delta') {
    if (m.conversationId !== S.conversationId) return;                                     // not the conversation shown
    if (m.seq !== S.seq + 1) return send('resync', { conversationId: m.conversationId }); // a gap: ask for a snapshot
    S.seq = m.seq;
    return handle(m.event);
  }
  handle(m);
});

function handle(m) {
  switch (m.type) {
    case 'init': {
      S.models = m.models;
      const models = m.models.includes(m.model) ? m.models : [m.model, ...m.models];
      $('#model').replaceChildren(...models.map(id => h('option', { value: id, selected: id === m.model }, id.replace(/^claude-/, '').replace(/-\d{8}$/, ''))));
      $('#mode').value = m.mode;
      $('#effort').value = m.effort;
      const folder = $('#folder');
      folder.replaceChildren(...m.folders.map(f => h('option', { value: f.path, selected: f.path === m.folder }, f.name)));
      folder.classList.toggle('hidden', m.folders.length < 2);
      $('#title').textContent = m.title;
      break;
    }
    case 'trust':
      $('#trust').classList.toggle('hidden', m.ok);
      for (const id of ['#log', 'footer', '#strip']) $(id).classList.toggle('untrusted', !m.ok);
      break;
    case 'auth':
      $('#auth').classList.toggle('hidden', m.ok);
      $('#authDetail').textContent = m.detail;
      break;
    case 'reset': log.replaceChildren(); S.turn = null; S.stream = null; $('#title').textContent = m.title; toggleHistory(false); showEmpty(); break;
    case 'title': $('#title').textContent = m.text; break;
    case 'user': newTurn(m.text, m.turn, m.images, m.refs); if (m.title) $('#title').textContent = m.title; scroll(); break;
    case 'rewound': {
      // Drop the restored message and everything after it; put the message back in the input to edit and resend.
      const t = [...log.querySelectorAll('section.turn')].find(s => s.dataset.turn === m.turn);
      if (!t) break;
      const { text, images, refs } = t.prompt;
      while (t.nextSibling) t.nextSibling.remove();
      t.remove();
      S.turn = null; S.stream = null;
      const input = $('#input');
      input.value = text;
      autosize();
      S.images = [...images];
      S.refs = refs.map(r => ({ path: r, name: r.replace(/\/$/, '').split('/').pop(), isDir: r.endsWith('/') }));
      renderAttachments();
      input.focus();
      if (log.querySelector('section.turn')) log.append(h('div', { class: 'step muted note' }, m.files ? `Restored ${m.files} file${m.files > 1 ? 's' : ''}.` : 'No files needed restoring.'));
      else showEmpty();
      break;
    }
    case 'busy': setBusy(m.value); break;
    case 'textDelta': delta(m.text); break;
    case 'answered': {
      const card = log.querySelector(`.perm[data-id="${CSS.escape(m.id)}"]`);
      if (card && !card.dataset.done) { if (card.answer) card.answer(m.choice); else answerCard(card, m.choice || 'dismissed'); }
      break;
    }
    case 'assistantText': assistantText(m.text); break;
    case 'tool': addTool(m); break;
    case 'toolResult': {
      const el = toolEls.get(m.id);
      if (el) { $('pre', el).textContent = m.output || '(no output)'; if (m.isError) el.classList.add('failed'); }
      break;
    }
    case 'permission': permission(m); break;
    case 'question': question(m); break;
    case 'done': done(m); break;
    case 'scrollBottom': requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; }); break;
    case 'note': log.append(h('div', { class: 'step muted note' }, m.text)); break;
    case 'changes': S.files = m.files; S.stripIdx = 0; renderStrip(); refreshCards(); break;
    case 'history': S.sessions = m.sessions; renderHistory(); break;
    case 'insert': { const t = $('#input'); const i = t.selectionStart; t.value = t.value.slice(0, i) + m.text + t.value.slice(i); t.focus(); break; }
    case 'mode': $('#mode').value = m.value; break;
    case 'attachImage': addImage(m.image); break;
    case 'addRef': addRef(m.ref); break;
    case 'commands': S.commands = m.commands.sort((a, b) => a.name.localeCompare(b.name)); updateMenu(); break;
    case 'activeFile': if (m.name !== S.activeFile) S.attach = false; S.activeFile = m.name; S.selLines = m.lines ?? null; renderCtx(); renderAttachments(); break;
    case 'mic': {
      S.mic = m.state;
      const b = $('#mic');
      setIcon(b, { recording: 'recording', transcribing: 'wait', idle: 'mic' }[m.state]);
      b.classList.toggle('recording', m.state === 'recording');
      b.title = { recording: 'Listening… click to stop', transcribing: 'Transcribing…', idle: 'Voice input (click to start, click again to stop)' }[m.state];
      if (m.error) (S.turn ? steps() : log).append(h('div', { class: 'step error' }, m.error));
      break;
    }
    case 'error': (S.turn ? steps() : log).append(h('div', { class: 'step error' }, m.text)); scroll(); break;
  }
}

document.addEventListener('click', e => {
  const t = /** @type {HTMLElement} */ (e.target);
  if (t.classList.contains('copy')) { navigator.clipboard.writeText(t.nextElementSibling.textContent); t.textContent = '✓'; setTimeout(() => (t.textContent = '⧉'), 1000); }
  const chip = t.closest('[data-file]');
  if (chip) { e.preventDefault(); send('openFileRef', { path: chip.getAttribute('data-file') }); }
  if (!t.closest('#menu') && !t.closest('#moreBtn')) $('#menu').classList.remove('open');
});

// Drag files (Explorer, editor tabs, Finder) onto the panel → @mentions. VS Code needs Shift held while dropping into webviews.
window.addEventListener('dragover', e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('drop', e => {
  e.preventDefault();
  const dt = e.dataTransfer;
  if (!dt) return;
  const files = [...(dt.files ?? [])];
  if (files.length && files.every(readImage)) return;
  const raw = dt.getData('application/vnd.code.uri-list') || dt.getData('text/uri-list') || dt.getData('resourceurls') || dt.getData('text/plain');
  let uris = [];
  try { const j = JSON.parse(raw); uris = Array.isArray(j) ? j : [j]; } catch { uris = raw.split(/\r?\n/).filter(l => l && !l.startsWith('#')); }
  if (!uris.length && files.length) uris = files.filter(f => !IMAGE_TYPES.includes(f.type)).map(f => f.path || f.name);
  if (uris.length) send('dropFiles', { uris });
});

showEmpty();
$('#input').addEventListener('blur', () => setTimeout(hideMenu, 100));
$('#input').addEventListener('click', updateMenu);

send('ready');
