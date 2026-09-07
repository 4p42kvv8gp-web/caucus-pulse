import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { baselineClassify, validateFeedback } from './classify.js';

export function openStore(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
    CREATE TABLE IF NOT EXISTS accounts (
      author_id TEXT PRIMARY KEY, member_id TEXT NOT NULL, member_name TEXT NOT NULL,
      handle TEXT NOT NULL, identity_note TEXT NOT NULL, account_type TEXT NOT NULL DEFAULT 'unverified'
    );
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES accounts(author_id),
      created_at TEXT NOT NULL, captured_at TEXT NOT NULL, text TEXT NOT NULL,
      type TEXT NOT NULL, content_hash TEXT NOT NULL, normalized_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS posts_created ON posts(created_at DESC);
    CREATE TABLE IF NOT EXISTS analyses (
      post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
      source_hash TEXT NOT NULL, analysis_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analysis_jobs (
      post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS feedback (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      source_hash TEXT NOT NULL, created_at TEXT NOT NULL, reviewer TEXT NOT NULL,
      feedback_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS feedback_post ON feedback(post_id, sequence DESC);
    CREATE TABLE IF NOT EXISTS tombstones (post_id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL);
  `);

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function upsertAccount(account) {
    db.prepare(`INSERT INTO accounts(author_id, member_id, member_name, handle, identity_note, account_type)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(author_id) DO UPDATE SET
      member_id=excluded.member_id, member_name=excluded.member_name, handle=excluded.handle,
      identity_note=excluded.identity_note, account_type=excluded.account_type`).run(
      account.authorId, account.memberId, account.memberName, account.handle,
      account.identityNote ?? 'Unverified mapping', account.accountType ?? 'unverified');
  }

  function ingest(post) {
    if (db.prepare('SELECT 1 FROM tombstones WHERE post_id=?').get(post.id)) return { inserted: false, removed: true };
    const current = db.prepare('SELECT content_hash FROM posts WHERE id=?').get(post.id);
    if (current?.content_hash === post.contentHash) return { inserted: false, duplicate: true };
    return transaction(() => {
      db.prepare(`INSERT INTO posts(id, author_id, created_at, captured_at, text, type, content_hash, normalized_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        author_id=excluded.author_id, created_at=excluded.created_at, captured_at=excluded.captured_at,
        text=excluded.text, type=excluded.type, content_hash=excluded.content_hash, normalized_json=excluded.normalized_json`).run(
        post.id, post.authorId, post.createdAt, post.capturedAt, post.text, post.type, post.contentHash, JSON.stringify(post));
      db.prepare('DELETE FROM analyses WHERE post_id=?').run(post.id);
      db.prepare(`INSERT INTO analysis_jobs(post_id, status) VALUES (?, 'pending')
        ON CONFLICT(post_id) DO UPDATE SET status='pending', attempts=0, last_error=NULL`).run(post.id);
      return { inserted: !current, updated: Boolean(current) };
    });
  }

  function analyzePending({ limit = 100, classifier = baselineClassify } = {}) {
    const jobs = db.prepare(`SELECT p.normalized_json FROM analysis_jobs j JOIN posts p ON j.post_id=p.id
      WHERE j.status='pending' ORDER BY p.created_at LIMIT ?`).all(limit);
    for (const row of jobs) {
      const post = JSON.parse(row.normalized_json);
      try {
        const analysis = classifier(post);
        transaction(() => {
          db.prepare(`INSERT INTO analyses(post_id, source_hash, analysis_json) VALUES (?, ?, ?)
            ON CONFLICT(post_id) DO UPDATE SET source_hash=excluded.source_hash, analysis_json=excluded.analysis_json`).run(
            post.id, post.contentHash, JSON.stringify(analysis));
          db.prepare("UPDATE analysis_jobs SET status='completed', attempts=attempts+1, last_error=NULL WHERE post_id=?").run(post.id);
        });
      } catch {
        db.prepare("UPDATE analysis_jobs SET status='failed', attempts=attempts+1, last_error='Classification failed; source post retained' WHERE post_id=?").run(post.id);
      }
    }
    return jobs.length;
  }

  function hydrate(row) {
    const post = JSON.parse(row.normalized_json);
    delete post.raw; // The browser receives preserved text/provenance, not the provider payload.
    const analysis = row.analysis_json ? JSON.parse(row.analysis_json) : {
      version: null, method: 'Awaiting analysis', status: 'pending', labels: [], entities: [], events: [],
      explanation: 'Source post is saved. Analysis has not completed.', limitations: [post.contextCoverage]
    };
    const history = db.prepare('SELECT * FROM feedback WHERE post_id=? ORDER BY sequence DESC').all(post.id).map(f => ({
      id: f.id, createdAt: f.created_at, reviewer: f.reviewer, appliesToCurrentText: f.source_hash === post.contentHash,
      ...JSON.parse(f.feedback_json)
    }));
    const accepted = history.find(f => f.appliesToCurrentText);
    return { ...post, memberId: row.member_id, memberName: row.member_name, handle: row.handle,
      identityNote: row.identity_note, accountType: row.account_type, analysis,
      labels: accepted?.labels ?? analysis.labels, reviewStatus: accepted ? 'reviewed' : 'awaiting-review', feedback: history };
  }

  const select = `SELECT p.*, a.member_id, a.member_name, a.handle, a.identity_note, a.account_type, n.analysis_json
    FROM posts p JOIN accounts a ON a.author_id=p.author_id LEFT JOIN analyses n ON n.post_id=p.id`;
  function getPost(id) { const row = db.prepare(`${select} WHERE p.id=?`).get(id); return row ? hydrate(row) : null; }
  function listPosts({ query = '', memberId = '', topic = '', type = '', since = '', until = '' } = {}) {
    // Local pilot dataset. Replace this bounded scan with indexed search/pagination before full-roster launch.
    const posts = db.prepare(`${select} ORDER BY p.created_at DESC, p.id DESC`).all().map(hydrate);
    const needle = query.toLocaleLowerCase();
    return posts.filter(p => (!query || p.text.toLocaleLowerCase().includes(needle)) &&
      (!memberId || p.memberId === memberId) && (!type || p.type === type) &&
      (!topic || p.labels.some(l => l.topic === topic)) &&
      (!since || p.createdAt >= since) && (!until || p.createdAt < until));
  }
  function saveFeedback(postId, value, reviewer = 'local-user') {
    const post = getPost(postId);
    if (!post) throw new Error('Post not found.');
    const feedback = validateFeedback(value);
    const id = randomUUID();
    db.prepare(`INSERT INTO feedback(id, post_id, source_hash, created_at, reviewer, feedback_json)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, postId, post.contentHash, new Date().toISOString(), reviewer, JSON.stringify(feedback));
    return getPost(postId);
  }
  function removePost(id) {
    transaction(() => {
      db.prepare('INSERT OR IGNORE INTO tombstones(post_id, deleted_at) VALUES (?, ?)').run(id, new Date().toISOString());
      db.prepare('DELETE FROM posts WHERE id=?').run(id);
    });
  }
  return { db, upsertAccount, ingest, analyzePending, getPost, listPosts, saveFeedback, removePost, close: () => db.close() };
}
