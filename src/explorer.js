import { createHash } from 'node:crypto';
import { atomic } from './sqlite.js';

export const EXPLORER_VERSION = 'indexed-explorer-v1';
export const SEARCH_NOTE = 'Literal substring search with Unicode lowercase matching. Punctuation, spacing and accents are preserved; no stemming, word removal, or semantic interpretation.';

// These projections are disposable indexes. Source text and review history remain authoritative.
export function migrateExplorer(db) {
  db.function('search_lower', { deterministic: true }, value => value.toLowerCase());
  if (db.prepare('SELECT version FROM schema_version').get().version >= 6) return;
  const columns = ['post_id','created_at','captured_at','member_id','member_name','account_type','type','provenance_kind','search_text','labels_json','reviewed','rule_proposals'];
  const refresh = where => `INSERT INTO post_search(${columns.join(',')}) SELECT ${columns.join(',')} FROM post_search_source WHERE ${where}
    ON CONFLICT(post_id) DO UPDATE SET ${columns.slice(1).map(c => `${c}=excluded.${c}`).join(',')};`;
  atomic(db, () => {
    db.exec(`
      CREATE INDEX feedback_current_source ON feedback(post_id,source_hash,sequence DESC);
      CREATE TABLE explorer_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      INSERT INTO explorer_revision VALUES (1,0);
      CREATE VIEW post_search_source AS SELECT p.id AS post_id,p.created_at,p.captured_at,
        COALESCE(json_extract(p.attribution_json,'$.memberId'),a.member_id) AS member_id,
        COALESCE(json_extract(p.attribution_json,'$.memberName'),a.member_name) AS member_name,
        COALESCE(json_extract(p.attribution_json,'$.accountType'),a.account_type) AS account_type,
        p.type,COALESCE(json_extract(p.normalized_json,'$.provenance.kind'),'unresolved') AS provenance_kind,
        search_lower(p.text) AS search_text,
        COALESCE(json_extract(f.feedback_json,'$.labels'),json_extract(n.analysis_json,'$.labels'),'[]') AS labels_json,
        (f.sequence IS NOT NULL) AS reviewed,
        (SELECT COUNT(*) FROM feedback r WHERE r.post_id=p.id AND json_extract(r.feedback_json,'$.ruleProposal') IS NOT NULL) AS rule_proposals
      FROM posts p JOIN accounts a ON a.author_id=p.author_id
      LEFT JOIN analyses n ON n.post_id=p.id AND n.source_hash=p.content_hash
      LEFT JOIN feedback f ON f.sequence=(SELECT sequence FROM feedback WHERE post_id=p.id AND source_hash=p.content_hash ORDER BY sequence DESC LIMIT 1);
      CREATE TABLE post_search (
        search_id INTEGER PRIMARY KEY,
        post_id TEXT UNIQUE NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,captured_at TEXT NOT NULL,member_id TEXT NOT NULL,member_name TEXT NOT NULL,
        account_type TEXT NOT NULL,type TEXT NOT NULL,provenance_kind TEXT NOT NULL,search_text TEXT NOT NULL,
        labels_json TEXT NOT NULL,reviewed INTEGER NOT NULL,rule_proposals INTEGER NOT NULL
      );
      CREATE INDEX explorer_chronology ON post_search(created_at DESC,post_id DESC);
      CREATE INDEX explorer_member ON post_search(member_id,created_at DESC,post_id DESC);
      CREATE INDEX explorer_type ON post_search(type,created_at DESC,post_id DESC);
      CREATE INDEX explorer_account_type ON post_search(account_type,created_at DESC,post_id DESC);
      CREATE TABLE post_search_labels (
        post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, topic TEXT NOT NULL,subtopic TEXT NOT NULL,
        PRIMARY KEY(post_id,topic,subtopic)
      );
      CREATE INDEX explorer_topic ON post_search_labels(topic,subtopic,post_id);
      CREATE INDEX explorer_subtopic ON post_search_labels(subtopic,post_id);
      CREATE VIRTUAL TABLE post_search_fts USING fts5(search_text,content='post_search',content_rowid='rowid',tokenize='trigram case_sensitive 1');
      CREATE TRIGGER explorer_index_insert AFTER INSERT ON post_search BEGIN
        INSERT INTO post_search_fts(rowid,search_text) VALUES(new.rowid,new.search_text);
        INSERT OR IGNORE INTO post_search_labels SELECT new.post_id,json_extract(value,'$.topic'),COALESCE(json_extract(value,'$.subtopic'),'') FROM json_each(new.labels_json);
        UPDATE explorer_revision SET revision=revision+1 WHERE id=1;
      END;
      CREATE TRIGGER explorer_index_delete AFTER DELETE ON post_search BEGIN
        INSERT INTO post_search_fts(post_search_fts,rowid,search_text) VALUES('delete',old.rowid,old.search_text);
        DELETE FROM post_search_labels WHERE post_id=old.post_id;
        UPDATE explorer_revision SET revision=revision+1 WHERE id=1;
      END;
      CREATE TRIGGER explorer_index_update AFTER UPDATE ON post_search BEGIN
        INSERT INTO post_search_fts(post_search_fts,rowid,search_text) VALUES('delete',old.rowid,old.search_text);
        INSERT INTO post_search_fts(rowid,search_text) VALUES(new.rowid,new.search_text);
        DELETE FROM post_search_labels WHERE post_id=old.post_id;
        INSERT OR IGNORE INTO post_search_labels SELECT new.post_id,json_extract(value,'$.topic'),COALESCE(json_extract(value,'$.subtopic'),'') FROM json_each(new.labels_json);
        UPDATE explorer_revision SET revision=revision+1 WHERE id=1;
      END;
      CREATE TRIGGER explorer_post_insert AFTER INSERT ON posts BEGIN ${refresh('post_id=new.id')} END;
      CREATE TRIGGER explorer_post_update AFTER UPDATE ON posts BEGIN ${refresh('post_id=new.id')} END;
      CREATE TRIGGER explorer_account_update AFTER UPDATE ON accounts BEGIN
        ${refresh('post_id IN (SELECT id FROM posts WHERE author_id=new.author_id)')}
      END;
    `);
    for (const table of ['analyses','feedback']) for (const event of ['INSERT','UPDATE','DELETE']) {
      const row = event === 'DELETE' ? 'old' : 'new';
      db.exec(`CREATE TRIGGER explorer_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN
        ${refresh(`post_id=${row}.post_id`)} ${event === 'UPDATE' ? refresh('post_id=old.post_id AND old.post_id<>new.post_id') : ''} END;`);
    }
    db.exec(`${refresh('1=1')} UPDATE schema_version SET version=6;`);
  });
}

export function migrateStableExplorerRowids(db) {
  if(db.prepare('SELECT version FROM schema_version').get().version>=10)return;
  atomic(db,()=>{
    if(!db.prepare('PRAGMA table_info(post_search)').all().some(c=>c.name==='search_id'&&c.type==='INTEGER'&&c.pk===1)){
      const columns=['post_id','created_at','captured_at','member_id','member_name','account_type','type','provenance_kind','search_text','labels_json','reviewed','rule_proposals'];
      const triggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name LIKE 'explorer_%'").all();
      const indexes=db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='post_search' AND sql IS NOT NULL").all();
      for(const trigger of triggers)db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"','""')}"`);
      db.exec(`CREATE TABLE post_search_stable (
        search_id INTEGER PRIMARY KEY,post_id TEXT UNIQUE NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,captured_at TEXT NOT NULL,member_id TEXT NOT NULL,member_name TEXT NOT NULL,
        account_type TEXT NOT NULL,type TEXT NOT NULL,provenance_kind TEXT NOT NULL,search_text TEXT NOT NULL,
        labels_json TEXT NOT NULL,reviewed INTEGER NOT NULL,rule_proposals INTEGER NOT NULL);
        INSERT INTO post_search_stable(search_id,${columns.join(',')}) SELECT rowid,${columns.join(',')} FROM post_search;
        DROP TABLE post_search;
        ALTER TABLE post_search_stable RENAME TO post_search;`);
      for(const index of indexes)db.exec(index.sql);
      for(const trigger of triggers)db.exec(trigger.sql);
      db.exec("INSERT INTO post_search_fts(post_search_fts) VALUES ('rebuild')");
    }
    db.exec('UPDATE explorer_revision SET revision=revision+1 WHERE id=1; UPDATE schema_version SET version=10');
  });
}

export function searchFilters(input = {}) {
  const result = {};
  const bounds = { query:2000,memberId:150,topic:100,subtopic:160,type:20,accountType:30,since:40,until:40 };
  for (const [key,max] of Object.entries(bounds)) {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('Invalid explorer filter.');
    result[key] = value;
  }
  for (const key of ['since','until']) if (result[key]) {
    if (!Number.isFinite(Date.parse(result[key]))) throw new Error('Invalid date filter.');
    result[key] = new Date(result[key]).toISOString();
  }
  if (result.since && result.until && result.since >= result.until) throw new Error('Invalid date window.');
  if (result.type && !['original','reply','quote','repost'].includes(result.type)) throw new Error('Invalid post type.');
  if (result.accountType && !['official','personal','campaign','unverified'].includes(result.accountType)) throw new Error('Invalid account type.');
  return result;
}

export function searchSelection(input = {}) {
  const filters = searchFilters(input); const where = []; const values = [];
  const needle = filters.query.toLowerCase();
  const indexed = [...needle].length >= 3;
  if (needle) {
    if (indexed) {
      where.push('s.rowid IN (SELECT rowid FROM post_search_fts WHERE post_search_fts MATCH ?)');
      values.push(`"${needle.replaceAll('"','""')}"`);
    }
    // The index supplies candidates; this check preserves literal substring semantics.
    where.push('instr(s.search_text,?)>0'); values.push(needle);
  }
  for (const [key,column] of [['memberId','member_id'],['accountType','account_type'],['type','type']]) if (filters[key]) {
    where.push(`s.${column}=?`); values.push(filters[key]);
  }
  if (filters.since) { where.push('s.created_at>=?'); values.push(filters.since); }
  if (filters.until) { where.push('s.created_at<?'); values.push(filters.until); }
  if (filters.topic || filters.subtopic) {
    const labelWhere = [];
    for (const key of ['topic','subtopic']) if (filters[key]) { labelWhere.push(`${key}=?`); values.push(filters[key]); }
    where.push(`s.post_id IN (SELECT post_id FROM post_search_labels WHERE ${labelWhere.join(' AND ')})`);
  }
  return { filters,values,from:`FROM post_search s WHERE ${where.length ? where.join(' AND ') : '1=1'}`,
    queryMode: !needle ? 'structured-indexes' : indexed ? 'trigram-with-literal-check' : 'short-substring-scan' };
}

function cursorData(cursor, filters, revision) {
  if (typeof cursor !== 'string' || cursor.length > 1500 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Invalid page cursor.');
  let data;
  try { data = JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')); }
  catch { throw new Error('Invalid page cursor.'); }
  if (!data || data.v !== 1 || !Number.isSafeInteger(data.revision) || data.filters !== filterKey(filters) ||
      typeof data.id !== 'string' || !/^\d{1,100}$/.test(data.id) || typeof data.at !== 'string' ||
      !Number.isFinite(Date.parse(data.at)) || new Date(data.at).toISOString() !== data.at) throw new Error('Invalid page cursor for these filters.');
  if (data.revision !== revision) {
    const error = new Error('The archive changed. Refresh the results before loading another page.');
    error.code = 'EXPLORER_CHANGED'; throw error;
  }
  return data;
}
function filterKey(filters) { return createHash('sha256').update(JSON.stringify(filters)).digest('hex'); }

export function explorerPage(store, filters = {}, { limit = 50,cursor = '' } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid page size: choose 1 to 100 posts.');
  const selection = searchSelection(filters);
  return atomic(store.db, () => {
    const revision = store.db.prepare('SELECT revision FROM explorer_revision WHERE id=1').get().revision;
    const after = cursor ? cursorData(cursor,selection.filters,revision) : null;
    const totalPosts = store.db.prepare(`SELECT COUNT(*) AS n ${selection.from}`).get(...selection.values).n;
    const keyset = after ? ' AND (s.created_at,s.post_id)<(?,?)' : '';
    const values = [...selection.values,...(after ? [after.at,after.id] : [])];
    const rows = store.db.prepare(`SELECT s.post_id,s.created_at ${selection.from}${keyset} ORDER BY s.created_at DESC,s.post_id DESC LIMIT ?`).all(...values,limit + 1);
    const selected = rows.slice(0,limit); const last = selected.at(-1);
    const nextCursor = rows.length > limit ? Buffer.from(JSON.stringify({v:1,revision,filters:filterKey(selection.filters),at:last.created_at,id:last.post_id})).toString('base64url') : null;
    return { version:EXPLORER_VERSION,filters:selection.filters,posts:selected.map(r => store.getPost(r.post_id)),
      page:{ limit,totalPosts,returnedPosts:selected.length,hasMore:Boolean(nextCursor),nextCursor,revision,queryMode:selection.queryMode },
      searchNote:SEARCH_NOTE };
  });
}

export function reviewQueue(store, filters = {}) {
  const selection = searchSelection(filters);
  return atomic(store.db,()=>({
    total:store.db.prepare(`SELECT COUNT(*) AS n ${selection.from} AND s.reviewed=0`).get(...selection.values).n,
    posts:store.db.prepare(`SELECT s.post_id AS id,s.member_name AS memberName,s.created_at AS createdAt ${selection.from} AND s.reviewed=0 ORDER BY s.created_at DESC,s.post_id DESC LIMIT 100`).all(...selection.values),
    note:'Up to 100 newest posts without a saved topic review in this selection. Source event reviews are separate.'
  }));
}

export function explorerSummary(store, filters = {}) {
  const db = store.db; const selection = searchSelection(filters);
  const coverage = db.prepare(`SELECT COUNT(*) AS postCount,COUNT(DISTINCT member_id) AS memberCount,
    COALESCE(SUM(provenance_kind='historical-calibration'),0) AS historicalPostCount,
    COALESCE(SUM(provenance_kind='x-list-capture'),0) AS collectedPostCount,
    MIN(created_at) AS firstPostAt,MAX(created_at) AS lastPostAt,MAX(captured_at) AS lastImportedAt,
    COALESCE(SUM(reviewed),0) AS reviewedPosts,COALESCE(SUM(rule_proposals),0) AS pendingRuleProposals FROM post_search`).get();
  const members = db.prepare(`SELECT member_id AS id,MIN(member_name) AS name FROM post_search GROUP BY member_id ORDER BY name COLLATE NOCASE,id`).all();
  const availableTopics = db.prepare('SELECT DISTINCT topic FROM post_search_labels ORDER BY topic').all().map(r => r.topic);
  const availableSubtopics = db.prepare(`SELECT DISTINCT subtopic FROM post_search_labels WHERE subtopic<>''${selection.filters.topic?' AND topic=?':''} ORDER BY subtopic`).all(...(selection.filters.topic?[selection.filters.topic]:[])).map(r=>r.subtopic);
  const cte = `WITH selected AS (SELECT s.post_id,s.member_id ${selection.from})`;
  const topics = db.prepare(`${cte} SELECT l.topic,COUNT(DISTINCT p.post_id) AS posts,COUNT(DISTINCT p.member_id) AS members
    FROM selected p JOIN post_search_labels l ON l.post_id=p.post_id GROUP BY l.topic ORDER BY l.topic`).all(...selection.values);
  const subtopics = db.prepare(`${cte} SELECT l.topic,l.subtopic AS label,COUNT(DISTINCT p.post_id) AS posts
    FROM selected p JOIN post_search_labels l ON l.post_id=p.post_id WHERE l.subtopic<>'' GROUP BY l.topic,l.subtopic ORDER BY l.topic,l.subtopic`).all(...selection.values);
  return { coverage,members,availableTopics,availableSubtopics,topics:topics.map(t => ({...t,subtopics:subtopics.filter(s => s.topic === t.topic).map(({topic,...s}) => s)})) };
}
