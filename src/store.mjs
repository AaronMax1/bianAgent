import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { check, id, json } from './util.mjs';

export class Store {
  constructor(path,scope={}) {
    this.scope=scope;
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL, body TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT, body TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, body TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, body TEXT NOT NULL);');
  }
  get(id) { const row = this.db.prepare('SELECT body FROM operations WHERE id=?').get(id); check(row, 'NOT_FOUND', 'Operation not found'); return JSON.parse(row.body); }
  byKey(key) { const row = this.db.prepare('SELECT body FROM operations WHERE idem=?').get(key); return row && JSON.parse(row.body); }
  all() { return this.db.prepare('SELECT body FROM operations ORDER BY rowid DESC LIMIT 200').all().map(r => JSON.parse(r.body)); }
  scan() { return this.db.prepare('SELECT body FROM operations ORDER BY rowid').all().map(r=>JSON.parse(r.body)); }
  save(op, event = true) {
    if(this.scope.accountId){
      check(!op.accountId||op.accountId===this.scope.accountId,'ACCOUNT_MISMATCH','Operation belongs to another account');
      op.accountId=this.scope.accountId;
      op.deviceProfileVersion ??= this.scope.deviceProfileVersion;
    }
    op.updatedAt = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO operations(id,idem,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(op.id, op.idempotencyKey, json(op));
      if (event) this.db.prepare('INSERT INTO events(operation_id,body) VALUES(?,?)').run(op.id, json({ at: op.updatedAt, state: op.state }));
      this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
    return op;
  }
  events(after = 0) { return this.db.prepare('SELECT seq,operation_id,body FROM events WHERE seq>? ORDER BY seq LIMIT 200').all(after).map(r => ({ seq: r.seq, operationId: r.operation_id, ...JSON.parse(r.body) })); }
  kv(key, value) {
    if (value !== undefined) this.db.prepare('INSERT INTO kv(key,body) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(key, json(value));
    const r = this.db.prepare('SELECT body FROM kv WHERE key=?').get(key); return r && JSON.parse(r.body);
  }
  project(p) { p = { ...p, id: p.id || id(), updatedAt: Date.now() }; this.db.prepare('INSERT INTO projects(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(p.id, json(p)); return p; }
  projects() { return this.db.prepare('SELECT body FROM projects ORDER BY rowid DESC LIMIT 100').all().map(r => JSON.parse(r.body)); }
  close() { this.db.close(); }
}
