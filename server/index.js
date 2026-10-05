const http = require('node:http');
const { Server } = require('socket.io');
const { app, db, workspaceByCode, safeWorkspace } = require('./app');

function createServer() {
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
const presence = new Map();
const sessionSockets = new Map();
app.set('io', io); app.set('presence', presence);
function broadcastUsers(workspaceId) { io.to(`workspace:${workspaceId}`).emit('workspace:users_changed'); }
function disconnectWorkspace(workspaceId, event) {
  io.to(`workspace:${workspaceId}`).emit(event);
  setTimeout(() => io.in(`workspace:${workspaceId}`).disconnectSockets(true), 100).unref();
}
function disconnectSession(sessionId) {
  for (const socketId of sessionSockets.get(sessionId) || []) {
    const socket = io.sockets.sockets.get(socketId);
    socket?.emit('session:removed');
    setTimeout(() => socket?.disconnect(true), 100).unref();
  }
}
app.set('disconnectWorkspace', disconnectWorkspace); app.set('disconnectSession', disconnectSession);
io.use((socket, next) => {
  const result = workspaceByCode(String(socket.handshake.auth.code || '').toUpperCase());
  if (result.error) return next(new Error(result.error));
  const session = db.prepare('SELECT * FROM sessions WHERE connection_token = ? AND workspace_id = ? AND revoked_at IS NULL').get(socket.handshake.auth.token, result.workspace.id);
  if (!session) return next(new Error('Invalid workspace session.'));
  socket.workspace = result.workspace; socket.session = session; next();
});
io.on('connection', socket => {
  const { workspace, session } = socket; socket.join(`workspace:${workspace.id}`);
  const sockets = sessionSockets.get(session.id) || new Set(); sockets.add(socket.id); sessionSockets.set(session.id, sockets);
  const connected = presence.get(workspace.id) || new Set(); connected.add(session.id); presence.set(workspace.id, connected);
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), session.id);
  socket.emit('workspace:ready', safeWorkspace(workspace)); broadcastUsers(workspace.id);
  socket.on('disconnect', () => { const sessionSet = sessionSockets.get(session.id); if (sessionSet) { sessionSet.delete(socket.id); if (!sessionSet.size) sessionSockets.delete(session.id); } const users = presence.get(workspace.id); if (users) { users.delete(session.id); if (!users.size) presence.delete(workspace.id); } broadcastUsers(workspace.id); });
});
const expiryTimer = setInterval(() => {
  const expired = db.prepare("SELECT id FROM workspaces WHERE status = 'active' AND expires_at <= ?").all(new Date().toISOString());
  for (const workspace of expired) { db.prepare("UPDATE workspaces SET status = 'expired' WHERE id = ?").run(workspace.id); disconnectWorkspace(workspace.id, 'workspace:expired'); }
}, 60_000);
expiryTimer.unref();
return { server, io };
}

if (require.main === module) {
  const { server } = createServer();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => console.log(`CopyPastePyon is running at http://localhost:${port}`));
}
module.exports = { createServer };
