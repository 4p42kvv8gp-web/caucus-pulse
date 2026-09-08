// A visible, deterministic baseline for exercising review. Semantic inference is a later adapter.
export const BASELINE_VERSION = 'local-evidence-baseline-v2';

const rules = [
  { topic: 'Immigration', subtopic: 'Dilley detention facility', terms: ['Dilley', 'South Texas Family Residential Center'] },
  { topic: 'Immigration', subtopic: 'Delaney Hall detention facility', terms: ['Delaney Hall'] },
  { topic: 'Immigration', subtopic: null, terms: ['immigration', 'deportation', 'asylum', 'DACA', 'immigrant'] },
  { topic: 'Health care', subtopic: 'Medicaid', terms: ['Medicaid'] },
  { topic: 'Health care', subtopic: 'Medicare', terms: ['Medicare'] },
  { topic: 'Health care', subtopic: null, terms: ['health care', 'healthcare', 'hospital'] },
  { topic: 'Economy & cost of living', subtopic: null, terms: ['inflation', 'cost of living', 'grocery prices', 'tariffs'] },
  { topic: 'Education', subtopic: null, terms: ['public schools', 'student debt', 'Department of Education'] },
  { topic: 'Labor & workers', subtopic: null, terms: ['minimum wage', 'collective bargaining', 'labor union'] },
  { topic: 'Disaster response', subtopic: null, terms: ['evacuation', 'tornado', 'wildfire', 'flooding', 'hurricane'] },
  { topic: 'Congress & politics', subtopic: null, terms: ['Trump Cartel', 'House floor', 'town hall'] }
];

function evidenceFor(text, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
  return [...text.matchAll(pattern)].map(m => ({ start: m.index, end: m.index + m[0].length, text: m[0] }));
}

export function baselineClassify(post) {
  const labels = [];
  for (const rule of rules) {
    const evidence = rule.terms.flatMap(term => evidenceFor(post.text, term));
    if (!evidence.length) continue;
    labels.push({ topic: rule.topic, subtopic: rule.subtopic, evidence,
      explanation: `The available text contains “${evidence[0].text}”. This literal match suggests a subject; it does not establish stance, novelty, or event location.` });
  }
  const usefulLabels = labels.filter(label => label.subtopic || !labels.some(other => other.topic === label.topic && other.subtopic));
  return {
    version: BASELINE_VERSION, method: 'Literal evidence baseline', status: 'provisional',
    labels: usefulLabels, entities: [], events: [],
    explanation: usefulLabels.length ? 'Provisional subjects based on exact words in the available post.'
      : 'This baseline found no supported subject. Keep this post available for semantic analysis and human review.',
    limitations: ['These labels use literal wording; this baseline does not interpret events or intent.', post.contextCoverage,
      ...(post.type === 'repost' ? ['These are amplified words; they must not be counted as newly authored wording.'] : []),
      ...(post.type === 'quote' ? ['Quoted context has not been analyzed.'] : [])]
  };
}

export function feedbackDecision(review){
  return review?.decision??(review?.labels?.length?'classified':'needs-context');
}

export function effectiveLabels(analysis,review){
  if(!review)return analysis.labels;
  return feedbackDecision(review)==='needs-context'?[]:review.labels;
}

export function validateFeedback(value) {
  if (!value || !Array.isArray(value.labels) || value.labels.length > 12) throw new Error('Provide up to 12 topic labels.');
  function clean(value, field, max, required = true) {
    if (!required && (value == null || value === '')) return null;
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`Invalid ${field}.`);
    return value.trim();
  }
  const labels = value.labels.map(label => ({
    topic: clean(label.topic, 'topic', 100), subtopic: clean(label.subtopic, 'subtopic', 160, false)
  }));
  if (new Set(labels.map(l => JSON.stringify(l))).size !== labels.length) throw new Error('Remove duplicate labels.');
  const reason = clean(value.reason, 'reason', 2000);
  const ruleProposal = clean(value.ruleProposal, 'rule proposal', 2000, false);
  const decision = value.decision ?? (labels.length ? 'classified' : 'needs-context');
  if (!['classified','no-supported-topic','needs-context'].includes(decision) ||
    (decision === 'classified' && !labels.length) || (decision === 'no-supported-topic' && labels.length)) throw new Error('Invalid review decision.');
  return { labels, reason, ruleProposal, decision };
}
