require('dotenv').config();
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const prettier = require('prettier');
const db = require('./db');

const app = express();
const validLanguages = ['JavaScript', 'TypeScript', 'Python', 'Java', 'C', 'C++', 'C#', 'PHP', 'HTML', 'CSS', 'SQL', 'JSON', 'Bash', 'Markdown'];
const alphabet = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';
const now = () => new Date().toISOString();
const maxNoteSize = Number(process.env.MAX_NOTE_SIZE || 200000);

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: `${maxNoteSize + 10000}b` }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/vendor/highlight', express.static(path.join(__dirname, '..', 'node_modules', '@highlightjs', 'cdn-assets')));

function apiError(res, status, message, code = undefined) { return res.status(status).json({ error: message, code }); }
function code() { return Array.from(crypto.randomBytes(8), byte => alphabet[byte % alphabet.length]).join(''); }
function token() { return crypto.randomBytes(32).toString('base64url'); }
function workspaceByCode(workspaceCode) {
  const workspace = db.prepare('SELECT * FROM workspaces WHERE code = ?').get(workspaceCode);
  if (!workspace) return { error: 'Workspace not found. Please check the code and try again.', status: 404 };
  if (workspace.status !== 'active') return { error: 'This workspace has been closed by the host.', status: 410 };
  if (new Date(workspace.expires_at) <= new Date()) {
    db.prepare("UPDATE workspaces SET status = 'expired' WHERE id = ?").run(workspace.id);
    return { error: 'This workspace has expired.', status: 410 };
  }
  return { workspace };
}
function sessionFor(req, workspace) {
  const value = req.get('X-Session-Token');
  if (!value) return null;
  return db.prepare('SELECT * FROM sessions WHERE connection_token = ? AND workspace_id = ? AND revoked_at IS NULL').get(value, workspace.id) || null;
}
function needWorkspace(req, res, next) {
  const result = workspaceByCode(String(req.params.code || '').toUpperCase());
  if (result.error) return apiError(res, result.status, result.error);
  const session = sessionFor(req, result.workspace);
  if (!session) return apiError(res, 401, 'A valid workspace session is required.');
  req.workspace = result.workspace; req.session = session; next();
}
function canEdit(session) { return session.role === 'host' || session.role === 'editor'; }
function needEditor(req, res, next) {
  if (!canEdit(req.session)) return apiError(res, 403, 'You do not have permission to perform this action.');
  next();
}
function cleanName(name) {
  const value = String(name || '').trim().replace(/[<>]/g, '');
  return value.slice(0, 40) || `Guest-${crypto.randomInt(1000, 10000)}`;
}
function safeWorkspace(workspace) { return { code: workspace.code, permissionMode: workspace.permission_mode, status: workspace.status, createdAt: workspace.created_at, expiresAt: workspace.expires_at }; }
function noteDto(note) { return { id: note.id, title: note.title, language: note.language, content: note.content, createdBy: note.created_by, updatedBy: note.updated_by, createdAt: note.created_at, updatedAt: note.updated_at, version: note.version }; }
function touch(id) { db.prepare('UPDATE workspaces SET last_activity_at = ? WHERE id = ?').run(now(), id); }

app.post('/api/workspaces', (req, res) => {
  const permissionMode = req.body.permissionMode === 'view_only' ? 'view_only' : 'collaborative';
  const hours = Math.max(1, Math.min(Number(process.env.WORKSPACE_EXPIRATION_HOURS || 24), 168));
  let workspaceCode; do { workspaceCode = code(); } while (db.prepare('SELECT 1 FROM workspaces WHERE code = ?').get(workspaceCode));
  const created = now(); const expires = new Date(Date.now() + hours * 3600000).toISOString();
  const workspace = db.prepare('INSERT INTO workspaces (code, permission_mode, status, created_at, expires_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *').get(workspaceCode, permissionMode, 'active', created, expires, created);
  const session = db.prepare('INSERT INTO sessions (workspace_id, display_name, role, connection_token, connected_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *').get(workspace.id, cleanName(req.body.displayName || 'Host'), 'host', token(), created, created);
  res.status(201).json({ workspace: safeWorkspace(workspace), session: { token: session.connection_token, displayName: session.display_name, role: session.role } });
});

app.post('/api/workspaces/join', rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.RATE_LIMIT || 30), standardHeaders: true, legacyHeaders: false, message: { error: 'Too many connection attempts. Please try again later.' } }), (req, res) => {
  const result = workspaceByCode(String(req.body.code || '').trim().toUpperCase());
  if (result.error) return apiError(res, result.status, result.error);
  const workspace = result.workspace; const created = now();
  const role = workspace.permission_mode === 'view_only' ? 'viewer' : 'editor';
  const session = db.prepare('INSERT INTO sessions (workspace_id, display_name, role, connection_token, connected_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *').get(workspace.id, cleanName(req.body.displayName), role, token(), created, created);
  touch(workspace.id);
  res.json({ workspace: safeWorkspace(workspace), session: { token: session.connection_token, displayName: session.display_name, role: session.role } });
});

app.get('/api/workspaces/:code', needWorkspace, (req, res) => res.json({ workspace: safeWorkspace(req.workspace), session: { displayName: req.session.display_name, role: req.session.role } }));
app.get('/api/workspaces/:code/notes', needWorkspace, (req, res) => {
  const query = String(req.query.search || '').trim(); const sort = String(req.query.sort || 'updated');
  const order = { updated: 'updated_at DESC', created: 'created_at DESC', title: 'title COLLATE NOCASE ASC', language: 'language COLLATE NOCASE ASC' }[sort] || 'updated_at DESC';
  const rows = query ? db.prepare(`SELECT * FROM notes WHERE workspace_id = ? AND (title LIKE ? COLLATE NOCASE OR language LIKE ? COLLATE NOCASE OR content LIKE ? COLLATE NOCASE) ORDER BY ${order}`).all(req.workspace.id, `%${query}%`, `%${query}%`, `%${query}%`) : db.prepare(`SELECT * FROM notes WHERE workspace_id = ? ORDER BY ${order}`).all(req.workspace.id);
  res.json({ notes: rows.map(noteDto) });
});
app.post('/api/workspaces/:code/notes', needWorkspace, needEditor, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120); const language = String(req.body.language || 'JavaScript'); const content = String(req.body.content || '');
  if (!title) return apiError(res, 422, 'A note title is required.');
  if (!validLanguages.includes(language)) return apiError(res, 422, 'Please choose a supported language.');
  if (content.length > maxNoteSize) return apiError(res, 413, 'This note is larger than the configured limit.');
  const stamp = now(); const note = db.prepare('INSERT INTO notes (workspace_id, title, language, content, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *').get(req.workspace.id, title, language, content, req.session.display_name, req.session.display_name, stamp, stamp);
  touch(req.workspace.id); req.app.get('io')?.to(`workspace:${req.workspace.id}`).emit('note:created', noteDto(note));
  res.status(201).json({ note: noteDto(note) });
});
app.patch('/api/workspaces/:code/notes/:id', needWorkspace, needEditor, (req, res) => {
  const note = db.prepare('SELECT * FROM notes WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspace.id);
  if (!note) return apiError(res, 404, 'Note not found.');
  if (Number(req.body.version) !== note.version) return res.status(409).json({ error: 'This note was changed by another user. Reload the latest version before saving.', note: noteDto(note) });
  const title = String(req.body.title ?? note.title).trim().slice(0, 120); const language = String(req.body.language ?? note.language); const content = String(req.body.content ?? note.content);
  if (!title || !validLanguages.includes(language)) return apiError(res, 422, 'Enter a title and supported language.');
  if (content.length > maxNoteSize) return apiError(res, 413, 'This note is larger than the configured limit.');
  const updated = db.prepare('UPDATE notes SET title = ?, language = ?, content = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? RETURNING *').get(title, language, content, req.session.display_name, now(), note.id);
  touch(req.workspace.id); req.app.get('io')?.to(`workspace:${req.workspace.id}`).emit('note:updated', noteDto(updated)); res.json({ note: noteDto(updated) });
});
app.delete('/api/workspaces/:code/notes/:id', needWorkspace, needEditor, (req, res) => {
  const removed = db.prepare('DELETE FROM notes WHERE id = ? AND workspace_id = ? RETURNING id').get(req.params.id, req.workspace.id);
  if (!removed) return apiError(res, 404, 'Note not found.');
  touch(req.workspace.id); req.app.get('io')?.to(`workspace:${req.workspace.id}`).emit('note:deleted', { id: removed.id }); res.status(204).end();
});
app.get('/api/workspaces/:code/users', needWorkspace, (req, res) => {
  const online = req.app.get('presence')?.get(req.workspace.id) || new Set();
  const users = db.prepare('SELECT id, display_name, role FROM sessions WHERE workspace_id = ? AND revoked_at IS NULL ORDER BY role = \'host\' DESC, connected_at').all(req.workspace.id).map(user => ({ id: user.id, displayName: user.display_name, role: user.role, online: online.has(user.id) }));
  res.json({ users });
});
app.delete('/api/workspaces/:code/users/:sessionId', needWorkspace, (req, res) => {
  if (req.session.role !== 'host') return apiError(res, 403, 'Only the host can remove participants.');
  const removed = db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND role != 'host' AND revoked_at IS NULL RETURNING id").get(now(), req.params.sessionId, req.workspace.id);
  if (!removed) return apiError(res, 404, 'Participant not found.');
  req.app.get('io')?.to(`workspace:${req.workspace.id}`).emit('workspace:user_removed', { id: removed.id });
  req.app.get('disconnectSession')?.(removed.id);
  res.status(204).end();
});
app.patch('/api/workspaces/:code/settings', needWorkspace, (req, res) => {
  if (req.session.role !== 'host') return apiError(res, 403, 'Only the host can change workspace settings.');
  const mode = req.body.permissionMode;
  if (!['collaborative', 'view_only'].includes(mode)) return apiError(res, 422, 'Invalid permission setting.');
  const workspace = db.prepare('UPDATE workspaces SET permission_mode = ?, last_activity_at = ? WHERE id = ? RETURNING *').get(mode, now(), req.workspace.id);
  db.prepare("UPDATE sessions SET role = ? WHERE workspace_id = ? AND role != 'host'").run(mode === 'view_only' ? 'viewer' : 'editor', req.workspace.id);
  req.app.get('io')?.to(`workspace:${req.workspace.id}`).emit('workspace:permission_changed', safeWorkspace(workspace)); res.json({ workspace: safeWorkspace(workspace) });
});
app.post('/api/workspaces/:code/regenerate-code', needWorkspace, (req, res) => {
  if (req.session.role !== 'host') return apiError(res, 403, 'Only the host can regenerate the workspace code.');
  let newCode; do { newCode = code(); } while (db.prepare('SELECT 1 FROM workspaces WHERE code = ?').get(newCode));
  const workspace = db.prepare('UPDATE workspaces SET code = ?, last_activity_at = ? WHERE id = ? RETURNING *').get(newCode, now(), req.workspace.id);
  req.app.get('io')?.to(`workspace:${req.workspace.id}`).emit('workspace:code_regenerated', safeWorkspace(workspace)); res.json({ workspace: safeWorkspace(workspace) });
});
app.post('/api/workspaces/:code/close', needWorkspace, (req, res) => {
  if (req.session.role !== 'host') return apiError(res, 403, 'Only the host can close the workspace.');
  db.prepare("UPDATE workspaces SET status = 'closed' WHERE id = ?").run(req.workspace.id);
  req.app.get('disconnectWorkspace')?.(req.workspace.id, 'workspace:closed'); res.status(204).end();
});
const formatters = { JavaScript: 'babel', TypeScript: 'typescript', JSON: 'json', HTML: 'html', CSS: 'css', Markdown: 'markdown' };
app.post('/api/format', (req, res) => {
  const parser = formatters[req.body.language]; if (!parser) return apiError(res, 422, `Formatting is not available for ${req.body.language || 'this language'} yet. Your original code is unchanged.`);
  const content = String(req.body.content || ''); if (content.length > maxNoteSize) return apiError(res, 413, 'This note is larger than the configured limit.');
  Promise.resolve(prettier.format(content, { parser, tabWidth: 2, singleQuote: true })).then(formatted => res.json({ content: formatted })).catch(() => apiError(res, 422, 'This code could not be formatted safely. The original code has been preserved.'));
});
app.use('/api', (req, res) => apiError(res, 404, 'API route not found.'));
app.use((err, req, res, next) => { console.error(err); apiError(res, err.type === 'entity.too.large' ? 413 : 500, err.type === 'entity.too.large' ? 'This note is larger than the configured limit.' : 'Something went wrong. Please try again.'); });
module.exports = { app, db, workspaceByCode, safeWorkspace };
