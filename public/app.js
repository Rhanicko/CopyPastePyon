const root = document.querySelector('#app');
const toast = document.querySelector('#toast');
const languages = ['JavaScript', 'TypeScript', 'Python', 'Java', 'C', 'C++', 'C#', 'PHP', 'HTML', 'CSS', 'SQL', 'JSON', 'Bash', 'Markdown'];
const state = { workspace: null, session: null, notes: [], users: [], editing: null, originalContent: null, socket: null, pollTimer: null, query: '', sort: 'updated', theme: localStorage.getItem('cpp-theme') || 'dark' };
document.documentElement.dataset.theme = state.theme;
function finishLoading() { document.body.classList.remove('booting'); root.setAttribute('aria-busy', 'false'); }
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const highlightNames = { JavaScript: 'javascript', TypeScript: 'typescript', Python: 'python', Java: 'java', C: 'c', 'C++': 'cpp', 'C#': 'csharp', PHP: 'php', HTML: 'xml', CSS: 'css', SQL: 'sql', JSON: 'json', Bash: 'bash', Markdown: 'markdown' };
function codeEsc(value, language) { try { return window.hljs.highlight(String(value), { language: highlightNames[language] || 'plaintext' }).value; } catch { return esc(value); } }
const tokenFor = code => localStorage.getItem(`cpp-token:${code}`);
const savedWorkspaceKey = 'cpp-last-workspace';
function forgetWorkspace() { const code = state.workspace?.code || localStorage.getItem(savedWorkspaceKey); if (code) localStorage.removeItem(`cpp-token:${code}`); localStorage.removeItem(savedWorkspaceKey); }
const setSession = (workspace, session) => { state.workspace = workspace; state.session = session; localStorage.setItem(`cpp-token:${workspace.code}`, session.token); localStorage.setItem(savedWorkspaceKey, workspace.code); };
function message(text, tone = '') { toast.textContent = text; toast.className = `show ${tone}`; clearTimeout(message.timer); message.timer = setTimeout(() => toast.className = '', 3400); }
async function api(url, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  if (state.workspace && state.session) headers['X-Session-Token'] = state.session.token || tokenFor(state.workspace.code);
  const response = await fetch(url, { ...options, headers });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'Request failed.'), { status: response.status, data });
  return data;
}
function landing() {
  stopSocket(); state.workspace = null; state.session = null; state.notes = [];
  root.innerHTML = `<section class="landing"><div class="brand-mark">&lt;/&gt;</div><p class="eyebrow">COPY. PASTE. CONNECT.</p><h1>CopyPastePyon</h1><p class="lead">A simple shared workspace for moving and sharing code between devices.</p><div class="landing-actions"><button class="primary" id="host">Host a workspace</button><button class="secondary" id="connect">Connect</button></div><p class="quiet">No account or installation needed for your collaborators.</p></section>`;
  finishLoading();
  document.querySelector('#host').onclick = hostForm; document.querySelector('#connect').onclick = () => connectForm();
}
function formShell(title, content) { root.innerHTML = `<section class="form-page"><button class="text-button back" id="back">← Back</button><div class="panel"><p class="eyebrow">COPYPASTEPYON</p><h1>${title}</h1>${content}</div></section>`; document.querySelector('#back').onclick = landing; }
async function withButton(button, busyLabel, work) { const label = button.innerHTML; button.disabled = true; button.setAttribute('aria-busy', 'true'); button.innerHTML = `<span class="button-spinner" aria-hidden="true"></span>${busyLabel}`; try { return await work(); } finally { button.disabled = false; button.removeAttribute('aria-busy'); button.innerHTML = label; } }
function hostForm() {
  formShell('Create your workspace', `<p class="muted setup-intro">Create a private code for sharing across devices.</p><form id="host-form" class="setup-form simple-setup-form"><label>Display name <span>optional</span><input name="displayName" maxlength="40" placeholder="Your name" autocomplete="name"></label><label>Access<select name="permissionMode"><option value="collaborative">Collaborative</option><option value="view_only">View only</option></select></label><button class="primary wide create-workspace-button" aria-label="Create workspace"><span>Create workspace</span></button></form>`);
  document.querySelector('#host-form').onsubmit = async event => { event.preventDefault(); const button = event.currentTarget.querySelector('button'); const data = Object.fromEntries(new FormData(event.currentTarget)); try { await withButton(button, 'Creating workspace…', async () => { const result = await api('/api/workspaces', { method: 'POST', body: JSON.stringify(data) }); setSession(result.workspace, result.session); await openWorkspace(); }); } catch (error) { message(error.message, 'error'); } };
}
function connectForm(inviteCode = '') {
  formShell('Join workspace', `<p class="muted setup-intro">Enter the code shared with you.</p><form id="connect-form" class="setup-form simple-setup-form join-form"><label>Workspace code<input name="code" required autocomplete="one-time-code" maxlength="8" pattern="[A-Za-z0-9]{8}" value="${esc(inviteCode)}" placeholder="A7K9P2XM" class="code-input"></label><label>Display name <span>optional</span><input name="displayName" maxlength="40" placeholder="Your name" autocomplete="name"></label><button class="primary wide create-workspace-button" aria-label="Connect"><span>Connect</span></button></form>`);
  document.querySelector('#connect-form').onsubmit = async event => { event.preventDefault(); const button = event.currentTarget.querySelector('button'); const data = Object.fromEntries(new FormData(event.currentTarget)); data.code = data.code.trim().toUpperCase(); try { await withButton(button, 'Connecting…', async () => { const result = await api('/api/workspaces/join', { method: 'POST', body: JSON.stringify(data) }); setSession(result.workspace, result.session); await openWorkspace(); }); } catch (error) { message(error.message, 'error'); } };
}
function isEditor() { return state.session?.role === 'host' || state.session?.role === 'editor'; }
function time(value) { const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000); if (seconds < 60) return 'just now'; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`; return new Date(value).toLocaleDateString(); }
function remaining(value) { const ms = new Date(value) - Date.now(); if (ms <= 0) return 'expired'; const hours = Math.floor(ms / 3600000), minutes = Math.floor((ms % 3600000) / 60000); return `${hours}h ${minutes}m`; }
async function openWorkspace() {
  try { const current = await api(`/api/workspaces/${state.workspace.code}`); state.workspace = current.workspace; state.session = { ...state.session, ...current.session, token: state.session.token || tokenFor(state.workspace.code) }; localStorage.setItem(savedWorkspaceKey, state.workspace.code); await refreshNotes(); await refreshUsers(); renderWorkspace(); connectSocket(); } catch (error) { forgetWorkspace(); message(error.message, 'error'); landing(); }
}
async function refreshNotes() { const data = await api(`/api/workspaces/${state.workspace.code}/notes?search=${encodeURIComponent(state.query)}&sort=${state.sort}`); state.notes = data.notes; }
async function refreshUsers() { const data = await api(`/api/workspaces/${state.workspace.code}/users`); state.users = data.users; }
function header() { return `<header><button class="logo" id="home" aria-label="Return to the workspace home">&lt;/&gt; <span>CopyPastePyon</span></button><div class="header-actions"><span class="connection" id="connection" aria-live="polite"><i></i> Connected</span><button class="icon-button" id="theme" aria-label="Toggle color theme">◐</button><button class="secondary compact" id="share">Share</button>${state.session?.role === 'host' ? '<button class="danger-button compact" data-close>End share</button>' : '<button class="secondary compact" data-leave>Leave</button>'}</div></header>`; }
function participantsView() { return `<div class="people"><h2>Connected users <small>${state.users.filter(user => user.online).length} online</small></h2>${state.users.map(user => `<div class="user"><i class="${user.online ? 'online' : ''}"></i><span>${esc(user.displayName)}</span><small>${user.role}</small>${state.session.role === 'host' && user.role !== 'host' ? `<button class="remove-user" data-remove="${user.id}" aria-label="Remove ${esc(user.displayName)}">Remove</button>` : ''}</div>`).join('')}</div>`; }
function hostControlsView() { return state.session.role === 'host' ? `<div class="settings"><h2>Host controls</h2><label>New connections<select data-permission><option value="collaborative" ${state.workspace.permissionMode === 'collaborative' ? 'selected' : ''}>Can collaborate</option><option value="view_only" ${state.workspace.permissionMode === 'view_only' ? 'selected' : ''}>View only</option></select></label><button class="control-card" data-regenerate><span>Regenerate code<small>Replace the current code</small></span><b aria-hidden="true">↻</b></button></div>` : ''; }
function workspaceView() {
  const editable = isEditor(); const noteCards = state.notes.length ? state.notes.map(note => { const content = note.content || '// Empty note'; const lines = content.split('\n').length; const numbers = Array.from({ length: lines }, (_, index) => index + 1).join('\n'); return `<article class="note-card"><div class="note-head"><div><h3>${esc(note.title)}</h3><div class="note-meta"><span class="tag">${esc(note.language)}</span><span class="line-count">${lines} ${lines === 1 ? 'line' : 'lines'}</span></div></div><span class="updated">${esc(note.updatedBy)} · ${time(note.updatedAt)}</span></div><div class="note-preview"><pre class="note-line-numbers" aria-hidden="true">${numbers}</pre><pre class="note-source"><code>${codeEsc(content, note.language)}</code></pre></div><div class="note-actions"><button class="secondary compact" data-copy="${note.id}">Copy code</button>${editable ? `<button class="text-button" data-edit="${note.id}">Edit</button><button class="danger-link" data-delete="${note.id}">Delete</button>` : ''}</div></article>`; }).join('') : `<div class="empty"><div class="empty-mark" aria-hidden="true">&lt;/&gt;</div><h3>No notes yet</h3><p>${editable ? 'Create your first note to start sharing code.' : 'The host has not added any notes.'}</p>${editable ? '<button class="primary compact" data-new-note>+ New note</button>' : ''}</div>`;
  return `${header()}<div class="workspace-shell"><aside aria-label="Workspace details"><div class="workspace-code"><span>WORKSPACE</span><button class="workspace-copy" data-copy-workspace aria-label="Copy workspace code ${esc(state.workspace.code)}"><strong>${esc(state.workspace.code)}</strong><b aria-hidden="true">⧉</b></button><small>Expires in ${remaining(state.workspace.expiresAt)}</small></div><div class="desktop-workspace-tools">${participantsView()}${hostControlsView()}</div><details class="mobile-workspace-tools"><summary>Workspace controls <span>${state.users.filter(user => user.online).length} online</span></summary><div class="mobile-workspace-tools-content">${participantsView()}${hostControlsView()}</div></details></aside><section class="notes"><div class="workspace-title"><div><p class="eyebrow">WORKSPACE</p><h1>${esc(state.workspace.code)}</h1></div>${editable && state.notes.length ? '<button class="primary" data-new-note>+ New note</button>' : (!editable ? '<span class="view-only">View-only</span>' : '')}</div><div class="toolbar"><div class="search-field"><span aria-hidden="true">⌕</span><input id="search" type="search" value="${esc(state.query)}" placeholder="Search notes" aria-label="Search notes"></div><select id="sort" aria-label="Sort notes"><option value="updated">Recently updated</option><option value="created">Recently created</option><option value="title">Title</option><option value="language">Language</option></select></div><div class="notes-list">${noteCards}</div></section></div>`; }
function renderWorkspace() { root.innerHTML = workspaceView(); bindWorkspace(); }
function bindHeader() {
  document.querySelector('#home').onclick = () => { if (confirm('Return to the start page? Your connection will be kept until you choose Leave.')) landing(); };
  document.querySelector('#theme').onclick = () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = state.theme; localStorage.setItem('cpp-theme', state.theme); };
  document.querySelector('#share').onclick = shareWorkspace;
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', closeWorkspace));
  document.querySelectorAll('[data-leave]').forEach(button => button.addEventListener('click', leaveWorkspace));
}
function bindWorkspace() {
  bindHeader();
  document.querySelector('#search').oninput = debounce(async event => { state.query = event.target.value; await refreshNotes(); renderWorkspace(); }, 250);
  document.querySelector('#sort').value = state.sort; document.querySelector('#sort').onchange = async event => { state.sort = event.target.value; await refreshNotes(); renderWorkspace(); };
  document.querySelectorAll('[data-new-note]').forEach(button => button.addEventListener('click', () => editor()));
  document.querySelectorAll('[data-copy-workspace]').forEach(button => button.onclick = () => copyText(state.workspace.code, 'Workspace code copied'));
  document.querySelectorAll('[data-copy]').forEach(button => button.onclick = () => copyText(state.notes.find(note => note.id === Number(button.dataset.copy)).content, 'Code copied'));
  document.querySelectorAll('[data-edit]').forEach(button => button.onclick = () => editor(state.notes.find(note => note.id === Number(button.dataset.edit))));
  document.querySelectorAll('[data-delete]').forEach(button => button.onclick = async () => { const note = state.notes.find(item => item.id === Number(button.dataset.delete)); if (!confirm(`Delete “${note.title}”? This action cannot be undone.`)) return; try { await api(`/api/workspaces/${state.workspace.code}/notes/${note.id}`, { method: 'DELETE' }); } catch (error) { message(error.message, 'error'); } });
  document.querySelectorAll('[data-remove]').forEach(button => button.onclick = async () => { const user = state.users.find(item => item.id === Number(button.dataset.remove)); if (!confirm(`Remove ${user.displayName} from this workspace? They can only return with a new invitation.`)) return; try { await api(`/api/workspaces/${state.workspace.code}/users/${user.id}`, { method: 'DELETE' }); await refreshUsers(); renderWorkspace(); message(`${user.displayName} was removed`); } catch (error) { message(error.message, 'error'); } });
  document.querySelectorAll('[data-permission]').forEach(select => select.addEventListener('change', async event => { try { const data = await api(`/api/workspaces/${state.workspace.code}/settings`, { method: 'PATCH', body: JSON.stringify({ permissionMode: event.target.value }) }); state.workspace = data.workspace; message('Permission updated'); } catch (error) { message(error.message, 'error'); } }));
  document.querySelectorAll('[data-regenerate]').forEach(button => button.addEventListener('click', async () => { if (!confirm('Regenerate this workspace code? The old code will immediately stop accepting new connections.')) return; try { await withButton(button, 'Regenerating…', async () => { const oldCode = state.workspace.code; const data = await api(`/api/workspaces/${oldCode}/regenerate-code`, { method: 'POST' }); state.workspace = data.workspace; localStorage.removeItem(`cpp-token:${oldCode}`); localStorage.setItem(`cpp-token:${data.workspace.code}`, state.session.token); localStorage.setItem(savedWorkspaceKey, data.workspace.code); renderWorkspace(); message('Workspace code regenerated'); }); } catch (error) { message(error.message, 'error'); } }));
}
async function shareWorkspace() { const url = `${location.origin}${location.pathname}?join=${encodeURIComponent(state.workspace.code)}`; try { if (navigator.share) { await navigator.share({ title: 'Join my CopyPastePyon workspace', text: 'Open this link to join my shared code workspace.', url }); message('Share link opened'); } else { await copyText(url, 'Workspace link copied'); } } catch (error) { if (error.name !== 'AbortError') await copyText(url, 'Workspace link copied'); } }
async function closeWorkspace() { if (!confirm('End sharing this workspace? All users will be disconnected and the link will stop working immediately.')) return; try { await api(`/api/workspaces/${state.workspace.code}/close`, { method: 'POST' }); forgetWorkspace(); message('Workspace sharing ended'); landing(); } catch (error) { message(error.message, 'error'); } }
async function leaveWorkspace() { if (!confirm('Leave this workspace? You will need a new connection to return.')) return; try { await api(`/api/workspaces/${state.workspace.code}/leave`, { method: 'POST' }); forgetWorkspace(); stopSocket(); message('You left the workspace'); landing(); } catch (error) { message(error.message, 'error'); } }
function draftKey(note) { return `cpp-draft:${state.workspace.code}:${note?.id || 'new'}`; }
function detectLanguage(content) {
  const value = String(content || '').trim();
  if (!value) return null;
  if (/^[\[{]/.test(value)) { try { JSON.parse(value); return 'JSON'; } catch {} }
  if (/^<!doctype\b|^<\/?[a-z][\s\S]*>/i.test(value)) return 'HTML';
  if (/^\s*(?:#{1,6}\s|[-*+]\s|\d+\.\s|```)/m.test(value)) return 'Markdown';
  if (/^#!.*\b(?:ba)?sh\b|^\s*(?:if|for|while)\b.*\b(?:then|do)\b|^\s*(?:echo|export|fi|done|esac)\b/m.test(value)) return 'Bash';
  if (/^\s*(?:select|insert|update|delete|create|alter|with)\b[\s\S]*\b(?:from|into|table|set)\b/i.test(value)) return 'SQL';
  if (/<\?php|\$[A-Za-z_]\w*\s*(?:=|->)|\bnamespace\s+\w+;/i.test(value)) return 'PHP';
  if (/^\s*(?:def|class)\s+\w+.*:|^\s*(?:from\s+\w+\s+import|import\s+\w+)\b|^\s*if\s+__name__\s*==/m.test(value)) return 'Python';
  if (/^\s*(?:using\s+System|namespace\s+\w+|public\s+(?:static\s+)?class\s+\w+).*$/m.test(value)) return 'C#';
  if (/^\s*(?:package\s+[\w.]+;|import\s+java\.|public\s+(?:final\s+)?class\s+\w+)/m.test(value)) return 'Java';
  if (/^\s*#include\s*<(?:(?:iostream|vector|string|memory|map)|[\w/]+\.h)>|\bstd::|\busing\s+namespace\s+std/m.test(value)) return 'C++';
  if (/^\s*#include\s*[<\"]|\b(?:printf|scanf|malloc|free)\s*\(|\bint\s+main\s*\(/m.test(value)) return 'C';
  if (/(?:^|\n)\s*(?:[.#]?[\w-]+(?:\s*,\s*[.#]?[\w-]+)*)\s*\{[^}]*[\w-]+\s*:/m.test(value)) return 'CSS';
  if (/\b(?:interface|type)\s+\w+\s*(?:=|\{)|:\s*(?:string|number|boolean|unknown|never)\b|\bas\s+\w+/m.test(value)) return 'TypeScript';
  if (/\b(?:const|let|var|function|import|export|async|await)\b|=>/m.test(value)) return 'JavaScript';
  return null;
}
function codeMirrorMarkup(value, language) {
  return value.split('\n').map(line => {
    const leading = (line.match(/^[ \t]*/) || [''])[0]; const visualIndent = leading.replace(/\t/g, '  ');
    const guides = Array.from({ length: Math.floor(visualIndent.length / 2) }, () => '<i class="indent-guide"></i>').join('');
    const remainder = '&nbsp;'.repeat(visualIndent.length % 2); const text = codeEsc(line.slice(leading.length), language) || '&nbsp;';
    return `<span class="code-line">${guides}<span class="indent-remainder">${remainder}</span>${text}</span>`;
  }).join('');
}
function updateEditorChrome() {
  const content = document.querySelector('#note-content'); const gutter = document.querySelector('#line-numbers'); const mirror = document.querySelector('#code-mirror');
  if (!content || !gutter || !mirror) return;
  gutter.textContent = Array.from({ length: content.value.split('\n').length }, (_, index) => index + 1).join('\n');
  gutter.scrollTop = content.scrollTop;
  const language = document.querySelector('#note-language')?.value || 'plaintext'; const source = `${language}\u0000${content.value}`;
  if (mirror.dataset.value !== source) { mirror.innerHTML = codeMirrorMarkup(content.value, language); mirror.dataset.value = source; }
  mirror.style.transform = `translate(${-content.scrollLeft}px, ${-content.scrollTop}px)`;
}
function insertIndentation(event) {
  if (event.key !== 'Tab') return;
  event.preventDefault();
  const field = event.currentTarget; const start = field.selectionStart;
  if (event.shiftKey) {
    const lineStart = field.value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    const removable = field.value.slice(lineStart, lineStart + 2).match(/^ {1,2}|^\t/);
    if (removable) field.setRangeText('', lineStart, lineStart + removable[0].length, 'preserve');
  } else field.setRangeText('  ', start, field.selectionEnd, 'end');
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
function editor(note = null) {
  const current = { ...(note || { title: '', language: 'JavaScript', content: '', version: null }) }; const savedDraft = localStorage.getItem(draftKey(note)); if (savedDraft) { try { const draft = JSON.parse(savedDraft); if (confirm('Restore your unsaved draft for this note?')) Object.assign(current, draft); } catch { localStorage.removeItem(draftKey(note)); } } state.editing = current; state.originalContent = current.content;
  root.innerHTML = `<section class="editor-page">${header()}<main class="editor-shell"><div class="editor"><button class="text-button back-to-workspace" id="cancel">&larr; Workspace</button><div class="editor-title"><div><p class="eyebrow">${note ? 'EDIT NOTE' : 'NEW NOTE'}</p><h1>${note ? esc(note.title) : 'New code note'}</h1></div><div class="editor-actions"><button class="secondary" id="format">Format code</button><button class="primary" id="save">Save note</button></div></div><div id="format-notice" class="format-notice" hidden>Formatting preview is not saved yet. <button class="text-button" id="revert">Revert</button></div><div class="editor-card"><label>Title<input id="note-title" maxlength="120" value="${esc(current.title)}" placeholder="Untitled note"></label><label class="language-field"><span>Language</span><span class="select-control"><select id="note-language">${languages.map(lang => `<option ${lang === current.language ? 'selected' : ''}>${lang}</option>`).join('')}</select></span><small id="language-status" aria-live="polite">Auto-detects pasted code</small></label><label class="code-field"><span>Code</span><div class="code-editor"><pre id="line-numbers" aria-hidden="true"></pre><div class="code-stage"><pre id="code-mirror" aria-hidden="true"></pre><textarea id="note-content" spellcheck="false" placeholder="Paste or write code here..."></textarea></div></div></label></div><p class="muted editor-help">Formatting is a preview until you save.</p></div></main></section>`;
  bindHeader();
  document.querySelector('#cancel').onclick = renderWorkspace;
  document.querySelector('#save').onclick = event => withButton(event.currentTarget, 'Saving…', () => saveNote(note));
  document.querySelector('#format').onclick = formatCurrent;
  const persistDraft = debounce(() => localStorage.setItem(draftKey(note), JSON.stringify({ title: document.querySelector('#note-title').value, language: document.querySelector('#note-language').value, content: document.querySelector('#note-content').value })), 300);
  const language = document.querySelector('#note-language'); const content = document.querySelector('#note-content');
  content.value = current.content;
  document.querySelector('#note-title').addEventListener('input', persistDraft); language.addEventListener('change', () => { updateEditorChrome(); persistDraft(); }); content.addEventListener('input', () => { updateEditorChrome(); persistDraft(); }); content.addEventListener('scroll', updateEditorChrome); content.addEventListener('keydown', insertIndentation);
  content.addEventListener('paste', event => { const detected = detectLanguage(event.clipboardData?.getData('text/plain')); if (!detected) return; language.value = detected; document.querySelector('#language-status').textContent = `Detected ${detected}`; persistDraft(); });
  document.querySelector('#revert').onclick = () => { content.value = state.originalContent; updateEditorChrome(); document.querySelector('#format-notice').hidden = true; message('Original code restored'); };
  updateEditorChrome();
}
async function formatCurrent() { const content = document.querySelector('#note-content'); const language = document.querySelector('#note-language').value; try { const data = await api('/api/format', { method: 'POST', body: JSON.stringify({ content: content.value, language }) }); content.value = data.content; updateEditorChrome(); document.querySelector('#format-notice').hidden = false; message(data.formattingAvailable === false ? 'Formatting is unavailable on this host; your code is unchanged.' : 'Formatting preview ready'); } catch (error) { message(error.message, 'error'); } }
async function saveNote(existing) { const payload = { title: document.querySelector('#note-title').value, language: document.querySelector('#note-language').value, content: document.querySelector('#note-content').value }; try { let result; if (existing) { result = await api(`/api/workspaces/${state.workspace.code}/notes/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ ...payload, version: existing.version }) }); } else { result = await api(`/api/workspaces/${state.workspace.code}/notes`, { method: 'POST', body: JSON.stringify(payload) }); } localStorage.removeItem(draftKey(existing)); updateNote(result.note); renderWorkspace(); message('Note saved'); } catch (error) { if (error.status === 409 && error.data.note && confirm(`${error.message}\n\nReload the latest version?`)) editor(error.data.note); else message(error.message, 'error'); } }
function updateNote(note) { const index = state.notes.findIndex(item => item.id === note.id); if (index >= 0) state.notes[index] = note; else state.notes.unshift(note); }
async function copyText(value, success) { try { await navigator.clipboard.writeText(value); message(success); } catch { const area = document.createElement('textarea'); area.value = value; document.body.append(area); area.select(); const copied = document.execCommand('copy'); area.remove(); copied ? message(success) : message('Clipboard access was blocked. Select the code and copy it manually.', 'error'); } }
function connectSocket() { stopSocket(); if (typeof window.io !== 'function') return startPolling(); state.socket = window.io({ auth: { code: state.workspace.code, token: state.session.token } }); const status = () => document.querySelector('#connection'); state.socket.on('connect', () => { const el = status(); if (el) el.innerHTML = '<i></i> Connected'; }); state.socket.on('disconnect', () => { const el = status(); if (el) el.innerHTML = '<i class="offline"></i> Reconnecting…'; }); state.socket.on('connect_error', error => message(error.message || 'Connection lost.', 'error')); state.socket.on('note:created', note => { updateNote(note); renderWorkspace(); message(`New note: ${note.title}`); }); state.socket.on('note:updated', note => { updateNote(note); renderWorkspace(); }); state.socket.on('note:deleted', ({ id }) => { state.notes = state.notes.filter(note => note.id !== id); renderWorkspace(); }); state.socket.on('workspace:users_changed', async () => { try { await refreshUsers(); renderWorkspace(); } catch {} }); state.socket.on('workspace:user_removed', ({ id }) => { state.users = state.users.filter(user => user.id !== id); renderWorkspace(); }); state.socket.on('session:removed', () => { forgetWorkspace(); message('You were removed from this workspace.', 'error'); landing(); }); state.socket.on('workspace:permission_changed', async workspace => { try { const current = await api(`/api/workspaces/${workspace.code}`); state.workspace = current.workspace; state.session = { ...state.session, ...current.session }; await refreshUsers(); renderWorkspace(); message('Workspace permission changed'); } catch (error) { message(error.message, 'error'); } }); state.socket.on('workspace:code_regenerated', workspace => { if (workspace.code !== state.workspace.code) { const old = state.workspace.code; state.workspace = workspace; state.socket.auth = { code: workspace.code, token: state.session.token }; localStorage.removeItem(`cpp-token:${old}`); localStorage.setItem(`cpp-token:${workspace.code}`, state.session.token); localStorage.setItem(savedWorkspaceKey, workspace.code); renderWorkspace(); message(`New workspace code: ${workspace.code}`); } }); state.socket.on('workspace:closed', () => { forgetWorkspace(); message('This workspace has been closed.', 'error'); landing(); }); state.socket.on('workspace:expired', () => { forgetWorkspace(); message('This workspace has expired.', 'error'); landing(); }); }
function startPolling() { const status = document.querySelector('#connection'); if (status) status.innerHTML = '<i></i> Synced'; state.pollTimer = setInterval(async () => { if (!state.workspace || !document.querySelector('.workspace-shell')) return; try { await refreshNotes(); await refreshUsers(); renderWorkspace(); } catch (error) { if ([401, 410].includes(error.status)) { forgetWorkspace(); landing(); } } }, 5000); }
function stopSocket() { if (state.socket) { state.socket.disconnect(); state.socket = null; } if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; } }
function debounce(fn, wait) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); }; }
async function resumeWorkspace() {
  const code = localStorage.getItem(savedWorkspaceKey) || Object.keys(localStorage).find(key => /^cpp-token:[A-Z0-9]{8}$/.test(key))?.slice('cpp-token:'.length); const token = code && tokenFor(code);
  if (!code || !token || !/^[A-Z0-9]{8}$/.test(code)) return landing();
  state.workspace = { code }; state.session = { token };
  await openWorkspace();
}
const inviteCode = new URLSearchParams(location.search).get('join');
if (inviteCode && /^[A-Za-z0-9]{8}$/.test(inviteCode)) connectForm(inviteCode.toUpperCase()); else resumeWorkspace();
