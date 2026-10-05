const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const location = process.env.DATABASE_URL || path.join('data', 'copypastepyon.db');
if (location !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(location)), { recursive: true });
const db = new DatabaseSync(location);
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    permission_mode TEXT NOT NULL DEFAULT 'collaborative',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    connection_token TEXT NOT NULL UNIQUE,
    connected_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    language TEXT NOT NULL,
    content TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS notes_workspace_updated ON notes(workspace_id, updated_at DESC);
`);
const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all().map(column => column.name);
if (!sessionColumns.includes('revoked_at')) db.exec('ALTER TABLE sessions ADD COLUMN revoked_at TEXT');

module.exports = db;
