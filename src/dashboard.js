import { exactOccurrences } from './normalize.js';

export function dashboardData(store, filters, settings) {
  const allPosts = store.listPosts();
  const posts = store.listPosts(filters);
  const byTopic = new Map();
  for (const post of posts) {
    for (const label of post.labels) {
      let bucket = byTopic.get(label.topic);
      if (!bucket) {
        bucket = { topic: label.topic, postIds: new Set(), memberIds: new Set(), subtopics: new Map() };
        byTopic.set(label.topic, bucket);
      }
      bucket.postIds.add(post.id); bucket.memberIds.add(post.memberId);
      if (label.subtopic) {
        const ids = bucket.subtopics.get(label.subtopic) ?? new Set();
        ids.add(post.id); bucket.subtopics.set(label.subtopic, ids);
      }
    }
  }
  const topics = [...byTopic.values()].sort((a, b) => a.topic.localeCompare(b.topic)).map(t => ({
    topic: t.topic, posts: t.postIds.size, members: t.memberIds.size,
    subtopics: [...t.subtopics.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, ids]) => ({ label, posts: ids.size }))
  }));
  const members = [...new Map(allPosts.map(p => [p.memberId, { id: p.memberId, name: p.memberName }])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    generatedAt: new Date().toISOString(), mode: settings.mode, filters,
    coverage: {
      postCount: allPosts.length, memberCount: members.length,
      firstPostAt: allPosts.at(-1)?.createdAt ?? null, lastPostAt: allPosts[0]?.createdAt ?? null,
      lastImportedAt: allPosts.map(p => p.capturedAt).sort().at(-1) ?? null,
      rosterStatus: 'Calibration accounts only; supplied List not yet synchronized',
      collectionStatus: 'Live collection is not enabled',
      analysisStatus: 'Literal evidence baseline; semantic analysis not connected',
      reviewedPosts: allPosts.filter(p => p.reviewStatus === 'reviewed').length,
      pendingRuleProposals: allPosts.flatMap(p => p.feedback).filter(f => f.ruleProposal).length
    },
    budget: { ...settings.budget, usageStatus: 'Provider balance and usage have not been verified; no collector requests made' },
    members, availableTopics: [...new Set(allPosts.flatMap(p => p.labels.map(l => l.topic)))].sort(),
    topics, posts
  };
}

export function phraseData(store, phrase, filters = {}) {
  if (typeof phrase !== 'string' || !phrase.trim() || phrase.length > 2000) throw new Error('Enter an exact phrase, up to 2,000 characters.');
  const posts = store.listPosts(filters).filter(p => p.type !== 'repost');
  const occurrences = posts.flatMap(post => exactOccurrences(post.text, phrase).map(span => ({
    postId: post.id, memberId: post.memberId, memberName: post.memberName,
    createdAt: post.createdAt, sourceUrl: post.sourceUrl, postType: post.type, span, text: post.text
  }))).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.postId.localeCompare(b.postId));
  return { phrase, matchingPosts: new Set(occurrences.map(o => o.postId)).size,
    distinctMembers: new Set(occurrences.map(o => o.memberId)).size,
    firstObservedInSelection: occurrences[0]?.createdAt ?? null, occurrences,
    note: 'Exact, case-sensitive text matches in the current selection. Reposts excluded. Quoted wording is not yet distinguished inside the caption. Shared words alone do not establish coordination.' };
}
