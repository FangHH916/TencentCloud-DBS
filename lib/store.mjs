import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createMockAuthenticator, appendAudit, verifyAudit } from './security.mjs';

export function copySession(session) {
  const { authenticator, ...data } = session;
  return { ...structuredClone(data), authenticator };
}
export class SessionStore {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, version INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;');
  }
  load(id) {
    const row = this.db.prepare('SELECT version, payload FROM sessions WHERE id=?').get(id);
    if (!row) return null;
    const data = JSON.parse(row.payload);
    if (!verifyAudit(data.audit, data.auditCheckpoint).ok) throw new Error('Saved audit integrity check failed');
    const session = { ...data, drafts: new Map(data.drafts), approvals: new Map(), authenticator: createMockAuthenticator(), storeVersion: row.version };
    appendAudit(session, 'SESSION_RESTORED', { authorization: 'Pending signatures invalidated; confirm again', storage: 'sqlite' });
    return session;
  }
  save(session, replacedSession = null) {
    const { authenticator, approvals, storeVersion = 0, ...data } = session;
    const payload = JSON.stringify({ ...data, drafts: [...session.drafts] });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (replacedSession) {
        const deleted = this.db.prepare('DELETE FROM sessions WHERE id=? AND version=?').run(replacedSession.id, replacedSession.storeVersion);
        if (deleted.changes !== 1) throw new Error('Session changed during reset');
      }
      if (storeVersion === 0) {
        this.db.prepare('INSERT INTO sessions VALUES (?, 1, ?, ?)').run(session.id, payload, new Date().toISOString());
      } else {
        const updated = this.db.prepare('UPDATE sessions SET version=version+1, payload=?, updated_at=? WHERE id=? AND version=?').run(payload, new Date().toISOString(), session.id, storeVersion);
        if (updated.changes !== 1) throw new Error('Session changed in another process');
      }
      this.db.exec('COMMIT'); session.storeVersion = storeVersion + 1;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
