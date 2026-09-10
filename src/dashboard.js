export {phraseData} from './phrase-search.js';
import { createBudget } from './budget.js';
import { collectionState } from './collect.js';
import { rosterStatus } from './roster.js';
import { inventoryState } from './list-inventory.js';
import { learningStatus } from './learning-context.js';
import { explorerPage, explorerSummary } from './explorer.js';
import { atomic } from './sqlite.js';

export function dashboardData(store, filters, settings, options = {}) {
  return atomic(store.db, () => {
  const result = explorerPage(store, filters, options);
  const summary = explorerSummary(store, result.filters);
  const budgetState = settings.budget.resourcePricesUsd ? createBudget(store.db, settings.budget).state() : null;
  const operations = {
    sources: collectionState(store.db),
    roster: rosterStatus(store.db),
    inventory: settings.listId ? inventoryState(store.db, settings.listId) : null,
    learning: learningStatus(store),
    awaitingRoster: store.db.prepare("SELECT COUNT(*) AS n FROM captured_posts WHERE status<>'promoted'").get().n,
    analysisPending: store.db.prepare("SELECT COUNT(*) AS n FROM analysis_jobs WHERE status='pending'").get().n,
    analysisFailed: store.db.prepare("SELECT COUNT(*) AS n FROM analysis_jobs WHERE status='failed'").get().n
  };
  const semanticPosts=store.db.prepare(`SELECT COUNT(*) AS n FROM analyses n JOIN posts p ON p.id=n.post_id AND p.content_hash=n.source_hash WHERE json_extract(n.analysis_json,'$.provider') IS NOT NULL`).get().n;
  return {
    generatedAt: new Date().toISOString(), mode: settings.mode, filters: result.filters,
    coverage: {
      ...summary.coverage,
      rosterStatus: operations.roster.snapshot ? `${operations.roster.snapshot.memberCount} names in dated Clerk inventory; ${operations.roster.activeAccountBindings} active X account bindings.`
        : 'Calibration accounts only; supplied List not yet synchronized',
      collectionStatus: operations.sources.length ? 'Bounded collection passes recorded; automatic polling is not configured' : 'No collection pass recorded; automatic polling is off',
      analysisStatus: `${semanticPosts} posts have semantic model output. Other automatic labels use the literal baseline; human topic corrections take precedence.`
    },
    budget: { ...settings.budget, verifiedBalance: budgetState?.balanceFresh ?? false, state: budgetState,
      usageStatus: budgetState?.requestCount ? 'Conservative local accounting; provider charges may differ'
        : 'No collector requests recorded; paid reads require a fresh provider balance check' },
    operations,
    members:summary.members, availableTopics:summary.availableTopics,availableSubtopics:summary.availableSubtopics,
    topics:summary.topics, posts:result.posts, page:result.page, searchNote:result.searchNote
  };
  });
}
