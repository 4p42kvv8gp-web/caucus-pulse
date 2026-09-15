// Exact current-week bill references from captured posts, independent of
// classification. A reference is not endorsement, a vote or a shared stance.
import { floorEvidenceForPost } from './floor-context.js';

export function buildFloorDisplay({ agenda, posts = [], authors = {}, personKey = () => null, now = Date.now() }) {
  const rows = [];
  const addRows = (items, parentWithdrawn = false) => {
    for (const item of items) {
      const withdrawn = parentWithdrawn || item.withdrawn;
      if (!item.parentId || item.billId) rows.push({ ...item, withdrawn });
      addRows(item.subitems || [], withdrawn);
    }
  };
  addRows(agenda.items);
  const references = new Map();
  const seen = new Set();
  for (const post of posts) {
    if (seen.has(post.id) || typeof post.id !== 'string' || !/^\d+$/.test(post.id)) continue;
    seen.add(post.id);
    const author = authors[post.authorId];
    const person = personKey(author);
    const seenBills = new Set();
    for (const source of floorEvidenceForPost(post, { agenda, now: new Date(now).toISOString() })) {
      if (seenBills.has(source.billId)) continue;
      seenBills.add(source.billId);
      const entry = references.get(source.billId) || { posts: [], members: new Set(), accounts: new Set() };
      const originals = new Map();
      for (const original of [post.quoting, post.quoted, post.reposted, post.reposting]) {
        if (typeof original?.id === 'string' && /^\d+$/.test(original.id) && typeof original.text === 'string') {
          originals.set(original.id, { id: original.id, handle: original.handle ?? null,
            text: original.text, createdAt: original.createdAt ?? null });
        }
      }
      entry.posts.push({ id: post.id, handle: author?.handle || post.handle || null,
        member: author?.member || null, createdAt: post.createdAt, type: post.type,
        text: post.text, referencedSources: [...originals.values()], sourceUrl: `https://x.com/i/web/status/${post.id}` });
      if (person) entry.members.add(person);
      if (post.authorId) entry.accounts.add(post.authorId);
      references.set(source.billId, entry);
    }
  }
  return { ...agenda, referenceMethod: 'Exact bill identifiers in captured posts and available referenced originals; references do not establish endorsement or a shared position.',
    referencesAvailable: Boolean(agenda.current && !agenda.stale && agenda.status?.ok),
    referenceAsOf: new Date(now).toISOString(),
    items: rows.map((item) => {
      const entry = references.get(item.billId);
      return { ...item, references: (entry?.posts || []).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        membersReferencing: entry?.members.size || 0, accountsReferencing: entry?.accounts.size || 0 };
    }) };
}
