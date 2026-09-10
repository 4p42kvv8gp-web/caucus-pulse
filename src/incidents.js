// Incident desk backend. The classifier (nightly batch + poll-time live
// pass) flags posts that respond to breaking district emergencies with
// {kind, place}; this module groups those flags into incidents with the
// lifecycle the desk shows: active (posts within 12h) → monitoring (12-36h
// quiet) → resolved (36h with no member posts), dropped after 7 quiet days.
//
// Intel panels (confirmed / circulating-unverified / what's new) are an
// optional Claude extraction over the incident's member posts — everything
// there is attributed to the member post it came from; the pipeline only
// captures list members, so official-source rows arrive when X search is
// connected, not before. Runs with withIntel:false at poll time (grouping
// only, free) and withIntel:true in the nightly chain.
import { p, readJSON, writeJSON, daysAgoEt, settings } from './util.js';
import { anthropicConfigured } from './anthropic-auth.js';
import { loadDay, topicsPath, loadState } from './store.js';
import { liveTopicsPath } from './classify-live.js';
import { loadAuthors } from './authors.js';

export const incidentsPath = p('data', 'incidents.json');

const HOUR = 3_600_000;

export function incidentKey(kind, place) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().replace(/\s+/g, '-');
  return `${norm(place)}--${norm(kind)}`;
}

export function statusOf(lastPostAt, now = Date.now()) {
  const quiet = now - new Date(lastPostAt).getTime();
  if (quiet <= 12 * HOUR) return 'active';
  if (quiet <= 36 * HOUR) return 'monitoring';
  return 'resolved';
}

// Collect {tweetId: {kind, place}} across nightly + live files for a window
// of days. Nightly wins on conflict (it re-reads the whole day).
export function collectFlags(days = 8) {
  const flags = {};
  for (let d = days - 1; d >= 0; d--) {
    const date = daysAgoEt(d);
    for (const file of [readJSON(liveTopicsPath(date), null), readJSON(topicsPath(date), null)]) {
      if (file?.incidents) Object.assign(flags, file.incidents);
    }
  }
  return flags;
}

export function groupIncidents(flags, postsById, authorsById, { now = Date.now(), lastPollAt = null } = {}) {
  const groups = new Map();
  for (const [tweetId, flag] of Object.entries(flags)) {
    const post = postsById.get(tweetId);
    if (!post) continue;
    const key = incidentKey(flag.kind, flag.place);
    const g = groups.get(key) || { id: key, kind: flag.kind, place: flag.place, posts: [] };
    g.posts.push(post);
    groups.set(key, g);
  }

  const incidents = [];
  for (const g of groups.values()) {
    g.posts.sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
    const lead = g.posts[0];
    const leadAuthor = authorsById[lead.authorId] || {};
    const last = g.posts[g.posts.length - 1];
    const status = statusOf(last.createdAt, now);
    if (status === 'resolved' && now - new Date(last.createdAt).getTime() > 7 * 24 * HOUR) continue;
    const memberHandles = [...new Set(g.posts.map((t) => authorsById[t.authorId]?.handle).filter(Boolean))];
    const engN = g.posts.reduce((a, t) => a + (t.engN || 0), 0);
    incidents.push({
      id: g.id,
      kind: g.kind,
      status,
      place: g.place + (leadAuthor.stateDistrict ? ` · ${leadAuthor.stateDistrict}` : ''),
      handle: leadAuthor.handle ? `@${leadAuthor.handle}` : lead.authorId,
      member: leadAuthor.member || leadAuthor.name || '',
      since: lead.createdAt,
      last: last.createdAt,
      updates: g.posts.length,
      engN,
      amplifiers: g.posts.reduce((a, t) => a + (t.amplifiers || 0), 0),
      others: memberHandles.slice(1).map((h) => `@${h}`),
      title: `${g.kind.charAt(0).toUpperCase()}${g.kind.slice(1)} · ${g.place}`,
      timeline: g.posts.map((t) => ({
        time: t.createdAt,
        who: authorsById[t.authorId]?.handle ? `@${authorsById[t.authorId].handle}` : t.authorId,
        tag: 'member',
        text: t.text,
        engN: t.engN || 0,
        isNew: Boolean(lastPollAt && t.capturedAt === lastPollAt)
      })),
      tweetIds: g.posts.map((t) => t.id)
    });
  }
  return incidents.sort((a, b) => (a.status === 'active' ? 0 : a.status === 'monitoring' ? 1 : 2) - (b.status === 'active' ? 0 : b.status === 'monitoring' ? 1 : 2) || (a.last < b.last ? 1 : -1));
}

// HOOK(night-incident-corroboration): when the corroboration pass lands
// ("same event, different words/places"), give its prompt the dossiers'
// Memory block — memoryForStories(keys of the stories these incidents are
// tagged with) from src/memory.js — and write its verdicts to this file as
//   merges: [{story?, from, into, reason}] and, per incident,
//   corroboration: [{id, reason, story?}]
// so src/dossiers.js records them as "corroboration" judgments.
async function extractIntel(incident, model) {
  const { anthropicClient } = await import('./anthropic-auth.js');
  const client = await anthropicClient();
  const posts = incident.timeline.map((e) => `[${e.time}] ${e.who}: ${e.text}`).join('\n');
  const res = await client.messages.create({
    model,
    max_tokens: 2000,
    system: 'You summarize a breaking district incident from a House member\'s X posts for a communications team. Only state what the posts themselves say; attribute every item to the post ("per @handle, <time>"). Facts the member states from officials (police, OEM, fire) go in "confirmed"; things the member frames as reports/claims/unconfirmed go in "unverified"; "whatsNew" is 2-4 short bullets on the latest developments, newest first. Reply with ONLY JSON: {"confirmed":[{"text":"...","src":"..."}],"unverified":[{"text":"...","src":"..."}],"whatsNew":["..."]}',
    messages: [{ role: 'user', content: `Incident: ${incident.kind} — ${incident.place}\nPosts:\n${posts}` }]
  });
  if (res.stop_reason === 'refusal') return null;
  const textBlock = res.content.find((b) => b.type === 'text');
  const { parseJsonLoose } = await import('./taxonomy.js');
  const parsed = textBlock && parseJsonLoose(textBlock.text);
  if (!parsed) return null;
  return {
    confirmed: (parsed.confirmed || []).slice(0, 5),
    unverified: (parsed.unverified || []).slice(0, 5),
    whatsNew: (parsed.whatsNew || []).slice(0, 5),
    extractedAt: new Date().toISOString(),
    posts: incident.updates
  };
}

export async function buildIncidents({ withIntel = false } = {}) {
  const authorsById = loadAuthors().byId;
  const state = loadState();
  const flags = collectFlags();

  // Hydrate flagged posts (plus amplifier counts) from the archive window.
  const postsById = new Map();
  const retweetsOf = new Map();
  for (let d = 7; d >= 0; d--) {
    for (const t of loadDay(daysAgoEt(d))) {
      if (flags[t.id]) {
        const m = t.metricsAtCapture || {};
        postsById.set(t.id, { ...t, engN: (m.likes || 0) + (m.retweets || 0) + (m.replies || 0) + (m.quotes || 0) });
      }
      if (t.type === 'retweet' && t.refId) retweetsOf.set(t.refId, (retweetsOf.get(t.refId) || 0) + 1);
    }
  }
  // Prefer refreshed 24h metrics where they exist.
  for (let d = 7; d >= 1; d--) {
    const metrics = readJSON(p('data', 'metrics', `${daysAgoEt(d)}.json`), {});
    for (const [id, m] of Object.entries(metrics)) {
      const post = postsById.get(id);
      if (post && !m.unavailable) post.engN = (m.likes || 0) + (m.retweets || 0) + (m.replies || 0) + (m.quotes || 0);
    }
  }
  for (const post of postsById.values()) post.amplifiers = retweetsOf.get(post.id) || 0;

  const prev = readJSON(incidentsPath, { incidents: [] });
  const prevById = new Map(prev.incidents.map((i) => [i.id, i]));
  const incidents = groupIncidents(flags, postsById, authorsById, { lastPollAt: state.lastPollAt });

  const model = process.env.CLASSIFY_MODEL || settings.classify.model;
  for (const incident of incidents) {
    const old = prevById.get(incident.id);
    incident.intel = old?.intel || null;
    const stale = !incident.intel || incident.intel.posts < incident.updates;
    if (withIntel && stale && anthropicConfigured()) {
      try {
        incident.intel = await extractIntel(incident, model) || incident.intel;
      } catch (e) {
        console.warn(`[incidents] intel extraction failed for ${incident.id}: ${e.message}`);
      }
    }
  }

  writeJSON(incidentsPath, { generatedAt: new Date().toISOString(), incidents });
  return incidents;
}

async function main() {
  const incidents = await buildIncidents({ withIntel: true });
  const counts = { active: 0, monitoring: 0, resolved: 0 };
  for (const i of incidents) counts[i.status]++;
  console.log(`[incidents] ${incidents.length} incident(s): ${counts.active} active, ${counts.monitoring} monitoring, ${counts.resolved} resolved`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
