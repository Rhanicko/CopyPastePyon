process.env.DATABASE_URL = ':memory:';
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { io: socketClient } = require('socket.io-client');
const { app } = require('../server/app');
const { createServer } = require('../server');

test('host, connect, permissions, notes, conflicts, and workspace closure', async () => {
  const host = await request(app).post('/api/workspaces').send({ displayName: 'Rhanley' }).expect(201);
  assert.match(host.body.workspace.code, /^[A-Z0-9]{8}$/); assert.equal(host.body.session.role, 'host');
  const code = host.body.workspace.code, hostToken = host.body.session.token;
  const joined = await request(app).post('/api/workspaces/join').send({ code, displayName: 'Mark' }).expect(200);
  const viewerWorkspace = await request(app).post('/api/workspaces').send({ permissionMode: 'view_only' }).expect(201);
  const viewer = await request(app).post('/api/workspaces/join').send({ code: viewerWorkspace.body.workspace.code, displayName: 'Viewer' }).expect(200);
  await request(app).post(`/api/workspaces/${viewerWorkspace.body.workspace.code}/notes`).set('X-Session-Token', viewer.body.session.token).send({ title: 'Blocked', language: 'JavaScript', content: '' }).expect(403);
  const note = await request(app).post(`/api/workspaces/${code}/notes`).set('X-Session-Token', hostToken).send({ title: 'Python Student Logger', language: 'Python', content: 'students=[]' }).expect(201);
  await request(app).get(`/api/workspaces/${code}/notes?search=student`).set('X-Session-Token', joined.body.session.token).expect(200).expect(response => assert.equal(response.body.notes.length, 1));
  await request(app).patch(`/api/workspaces/${code}/settings`).set('X-Session-Token', hostToken).send({ permissionMode: 'view_only' }).expect(200);
  await request(app).post(`/api/workspaces/${code}/notes`).set('X-Session-Token', joined.body.session.token).send({ title: 'No access', language: 'JavaScript', content: '' }).expect(403);
  await request(app).patch(`/api/workspaces/${code}/settings`).set('X-Session-Token', hostToken).send({ permissionMode: 'collaborative' }).expect(200);
  await request(app).patch(`/api/workspaces/${code}/notes/${note.body.note.id}`).set('X-Session-Token', joined.body.session.token).send({ ...note.body.note, content: 'students = []', version: 1 }).expect(200);
  const users = await request(app).get(`/api/workspaces/${code}/users`).set('X-Session-Token', hostToken).expect(200);
  const mark = users.body.users.find(user => user.displayName === 'Mark');
  await request(app).delete(`/api/workspaces/${code}/users/${mark.id}`).set('X-Session-Token', hostToken).expect(204);
  await request(app).get(`/api/workspaces/${code}/notes`).set('X-Session-Token', joined.body.session.token).expect(401);
  await request(app).patch(`/api/workspaces/${code}/notes/${note.body.note.id}`).set('X-Session-Token', hostToken).send({ ...note.body.note, content: 'stale', version: 1 }).expect(409);
  await request(app).post(`/api/workspaces/${code}/close`).set('X-Session-Token', hostToken).expect(204);
  await request(app).post('/api/workspaces/join').send({ code }).expect(410);
});

test('a connected collaborator receives note changes in real time', async () => {
  const host = await request(app).post('/api/workspaces').send({ displayName: 'Host' });
  const joiner = await request(app).post('/api/workspaces/join').send({ code: host.body.workspace.code, displayName: 'Mark' });
  const { server, io } = createServer();
  await new Promise(resolve => server.listen(0, resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  const client = socketClient(address, { auth: { code: host.body.workspace.code, token: joiner.body.session.token }, transports: ['websocket'] });
  await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
  const received = new Promise(resolve => client.once('note:created', resolve));
  await request(app).post(`/api/workspaces/${host.body.workspace.code}/notes`).set('X-Session-Token', host.body.session.token).send({ title: 'Shared note', language: 'JavaScript', content: 'const shared = true;' }).expect(201);
  const note = await received;
  assert.equal(note.title, 'Shared note');
  client.disconnect(); io.close(); await new Promise(resolve => server.close(resolve));
});
