import { randomUUID } from 'node:crypto';
import { atomic } from './sqlite.js';

export const CLERK_SOURCE = 'https://clerk.house.gov/xml/lists/MemberData.xml';
const instant = value => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid evidence date.');
  return new Date(value).toISOString();
};
const identifier = value => typeof value === 'string' && /^[A-Z]\d{6}$/.test(value);
function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || instant(`${value}T00:00:00Z`).slice(0, 10) !== value) throw new Error('Invalid calendar date.');
  return value;
}

export function importRoster(db, snapshot, { now = Date.now() } = {}) {
  if (snapshot?.schemaVersion !== 1 || snapshot.sourceUrl !== CLERK_SOURCE || !/^[a-f0-9]{64}$/.test(snapshot.id ?? '') || !/^\d{3}$/.test(snapshot.congress ?? '')) throw new Error('Invalid Clerk snapshot provenance.');
  const retrieved = instant(snapshot.retrievedAt);
  const published = instant(`${calendarDate(snapshot.publishedOn)}T00:00:00Z`);
  if (Date.parse(retrieved) > now || Date.parse(published) > Date.parse(retrieved) || Date.parse(retrieved) - Date.parse(published) > 14 * 86_400_000) throw new Error('Roster snapshot is stale or future dated.');
  if (!Array.isArray(snapshot.members) || !snapshot.members.length || snapshot.members.length > 441) throw new Error('Invalid roster members.');
  if (new Set(snapshot.members.map(m => m.memberId)).size !== snapshot.members.length) throw new Error('Duplicate member identity.');
  if (new Set(snapshot.members.map(m => m.district)).size !== snapshot.members.length) throw new Error('Duplicate occupied district.');
  for (const m of snapshot.members) {
    if (!identifier(m.memberId) || typeof m.name !== 'string' || !m.name.trim() || m.name.length > 200 || !/^[A-Z]{2}$/.test(m.state) || !new RegExp(`^${m.state}\\d{2}$`).test(m.district) || m.caucus !== 'D' || typeof m.party !== 'string') throw new Error('Invalid roster member.');
    if (m.swornOn && instant(`${calendarDate(m.swornOn)}T00:00:00Z`) > retrieved) throw new Error('Invalid sworn date.');
  }
  // A dated source observation supports a limited operational window, not an inferred full term.
  const validUntil = new Date(Date.parse(retrieved) + 86_400_000).toISOString();
  const id = `${snapshot.id}:${retrieved}`;
  return atomic(db, () => {
    const existing = db.prepare('SELECT * FROM roster_snapshots WHERE id=?').get(id);
    if (existing) {
      const saved = db.prepare('SELECT * FROM roster_members WHERE snapshot_id=? ORDER BY member_id').all(id);
      const normalized = snapshot.members.map(m => ({ snapshot_id: id, member_id: m.memberId, member_name: m.name,
        state: m.state, district: m.district, party: m.party, caucus: m.caucus, sworn_on: m.swornOn ?? null }))
        .sort((a, b) => a.member_id.localeCompare(b.member_id));
      if (existing.published_on !== snapshot.publishedOn || existing.congress !== snapshot.congress || JSON.stringify(saved) !== JSON.stringify(normalized)) throw new Error('Existing source observation cannot be rewritten.');
      return { snapshotId: id, members: saved.length, validUntil: existing.valid_until };
    }
    const latest = db.prepare('SELECT published_on FROM roster_snapshots ORDER BY retrieved_at DESC LIMIT 1').get();
    if (latest && snapshot.publishedOn < latest.published_on) throw new Error('Cannot replace the current roster with an older publication.');
    db.prepare(`INSERT OR IGNORE INTO roster_snapshots(id, published_on, retrieved_at, source_url, congress, member_count, valid_until)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, snapshot.publishedOn, retrieved, snapshot.sourceUrl, snapshot.congress, snapshot.members.length, validUntil);
    for (const m of snapshot.members) db.prepare(`INSERT OR IGNORE INTO roster_members(snapshot_id, member_id, member_name, state, district, party, caucus, sworn_on)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, m.memberId, m.name, m.state, m.district, m.party, m.caucus, m.swornOn ?? null);
    return { snapshotId: id, members: snapshot.members.length, validUntil };
  });
}

export function verifyAccountBinding(db, binding, { now = Date.now() } = {}) {
  if (!binding || !identifier(binding.memberId) || !/^\d+$/.test(binding.authorId ?? '') || !/^[A-Za-z0-9_]{1,15}$/.test(binding.handle ?? '') || !['official','personal','campaign'].includes(binding.accountType)) throw new Error('Invalid account binding.');
  const start = instant(binding.validFrom); const end = instant(binding.validUntil);
  if (end <= start) throw new Error('Invalid ownership interval.');
  const proof = binding.evidence;
  let official, profile;
  try { official = new URL(proof.officialPage); profile = new URL(proof.linkedProfile); } catch { throw new Error('Missing source evidence.'); }
  const handle = profile.pathname.replace(/^\//, '').replace(/\/$/, '');
  if (official.protocol !== 'https:' || !official.hostname.endsWith('.house.gov') || official.username || official.password ||
      !['x.com','www.x.com','twitter.com','www.twitter.com'].includes(profile.hostname) || profile.protocol !== 'https:' || profile.username || profile.password || handle.toLowerCase() !== binding.handle.toLowerCase()) throw new Error('Account ownership needs an official House page linking the exact profile.');
  if (proof.xUser?.id !== binding.authorId || proof.xUser?.username?.toLowerCase() !== binding.handle.toLowerCase() || typeof proof.explanation !== 'string' || !proof.explanation.trim()) throw new Error('Account identity needs matching X profile evidence and a source explanation.');
  const observed = instant(proof.xUser.retrievedAt);
  if (Date.parse(observed) > now || now - Date.parse(observed) > 7 * 86_400_000) throw new Error('X profile evidence is stale.');
  return atomic(db, () => {
    if (!db.prepare('SELECT 1 FROM roster_members WHERE member_id=?').get(binding.memberId)) throw new Error('Member is not in the imported roster.');
    if (db.prepare(`SELECT 1 FROM account_bindings WHERE author_id=? AND valid_from<? AND valid_until>?`).get(binding.authorId, end, start)) throw new Error('Overlapping account ownership intervals require review.');
    const id = randomUUID();
    db.prepare(`INSERT INTO account_bindings(id, author_id, member_id, handle, account_type, valid_from, valid_until, verified_at, evidence_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, binding.authorId, binding.memberId, binding.handle, binding.accountType, start, end, new Date(now).toISOString(), JSON.stringify(proof));
    return id;
  });
}

export function resolveAttribution(db, post, { now = Date.now() } = {}) {
  if (!Number.isFinite(Date.parse(post.createdAt)) || Date.parse(post.createdAt) > now) return { status: 'invalid-source-date' };
  const binding = db.prepare(`SELECT * FROM account_bindings WHERE author_id=? AND valid_from<=? AND valid_until>?`).get(post.authorId, post.createdAt, post.createdAt);
  if (!binding) return { status: 'awaiting-account-verification' };
  // A newer snapshot takes precedence, including when it no longer contains the member.
  const snapshot = db.prepare(`SELECT * FROM roster_snapshots WHERE published_on<=? AND retrieved_at<=?
    AND valid_until>? ORDER BY retrieved_at DESC LIMIT 1`).get(post.createdAt.slice(0,10), new Date(now).toISOString(), post.createdAt);
  if (!snapshot) return { status: 'outside-roster-observation' };
  const member = db.prepare('SELECT * FROM roster_members WHERE snapshot_id=? AND member_id=?').get(snapshot.id, binding.member_id);
  if (!member || (member.sworn_on && post.createdAt.slice(0,10) < member.sworn_on)) return { status: 'outside-verified-membership' };
  return { status: 'verified', attribution: {
    memberId: member.member_id, memberName: member.member_name, handle: binding.handle,
    accountType: binding.account_type, state: member.state, district: member.district,
    rosterSnapshotId: snapshot.id, rosterSource: snapshot.source_url,
    rosterPublishedOn: snapshot.published_on, accountBindingId: binding.id,
    identityNote: 'Account binding verified against official-link and X profile evidence; membership follows the dated Clerk observation.'
  } };
}

export function promoteCaptured(store, { limit = 100, now = Date.now() } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid promotion limit.');
  const rows = store.db.prepare("SELECT id FROM captured_posts WHERE status<>'promoted' ORDER BY COALESCE(promotion_attempted_at,''),created_at,id LIMIT ?").all(limit);
  const results = { promoted: 0, awaitingVerification: 0 };
  for (const row of rows) {
    atomic(store.db, () => {
      // Read the actual payload after acquiring the write lock: capture may have edited it since selection.
      const current = store.db.prepare("SELECT normalized_json FROM captured_posts WHERE id=? AND status<>'promoted'").get(row.id);
      if (!current) return;
      const post = JSON.parse(current.normalized_json);
      if (store.db.prepare('SELECT 1 FROM tombstones WHERE post_id=?').get(post.id)) {
        store.db.prepare('DELETE FROM captured_posts WHERE id=?').run(post.id); return;
      }
      const resolved = resolveAttribution(store.db, post, { now });
      if (resolved.status !== 'verified') {
        store.db.prepare('UPDATE captured_posts SET status=?, promotion_attempted_at=? WHERE id=?').run(resolved.status, new Date(now).toISOString(), post.id);
        results.awaitingVerification++; return;
      }
      const a = resolved.attribution;
      store.upsertAccount({ authorId: post.authorId, ...a });
      store.ingest(post);
      store.db.prepare('UPDATE posts SET attribution_json=? WHERE id=?').run(JSON.stringify(a), post.id);
      store.db.prepare("UPDATE captured_posts SET status='promoted', promotion_attempted_at=? WHERE id=?").run(new Date(now).toISOString(), post.id);
      results.promoted++;
    });
  }
  return results;
}

export function rosterStatus(db, { now = Date.now() } = {}) {
  const snapshot = db.prepare('SELECT * FROM roster_snapshots ORDER BY retrieved_at DESC LIMIT 1').get();
  const at = new Date(now).toISOString();
  return { snapshot: snapshot ? { sourceUrl: snapshot.source_url, publishedOn: snapshot.published_on,
    retrievedAt: snapshot.retrieved_at, memberCount: snapshot.member_count, validUntil: snapshot.valid_until,
    fresh: snapshot.retrieved_at <= at && at < snapshot.valid_until } : null,
    accountBindings: db.prepare('SELECT COUNT(*) AS n FROM account_bindings').get().n,
    activeAccountBindings: db.prepare('SELECT COUNT(*) AS n FROM account_bindings WHERE valid_from<=? AND valid_until>?').get(at, at).n,
    verificationQueue: db.prepare("SELECT status,COUNT(*) AS count FROM captured_posts WHERE status<>'promoted' GROUP BY status ORDER BY status").all() };
}
