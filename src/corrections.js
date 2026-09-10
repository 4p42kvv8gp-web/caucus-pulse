// Human correction loop for classification. config/corrections.yaml is the
// editors' list of posts the classifier got wrong, each with the right topics
// and a note saying why. This module:
//   - loads and validates the file against the taxonomy (a typo in a topic id
//     is an error, never a silently dropped label);
//   - resolves handle + date + match entries to tweet ids via the archive and
//     data/authors.json, so a staffer can file one without looking up ids;
//   - applies corrections onto data/topics/<date>.json (the authoritative
//     nightly output), marking each under "corrected" so a reader can tell a
//     human label from a model one;
//   - renders the most recent corrections as few-shot precedents for the
//     classifier prompt (see taxonomy.js systemPrompt).
//
// Corrections are re-applied by the nightly after classification, so they
// survive a re-classify; applying is idempotent (no write when nothing changes).
//
//   node src/corrections.js apply [--dry-run]     # npm run corrections [-- --dry-run]
//   node src/corrections.js examples [--n=8]      # print the prompt block
import fs from 'node:fs';
import yaml from 'js-yaml';
import { p, etDate, readJSON, writeJSON, settings } from './util.js';
import { loadDay, topicsPath } from './store.js';
import { loadAuthors } from './authors.js';
import { loadTaxonomy, renderExamples } from './taxonomy.js';

export const correctionsPath = p('config', 'corrections.yaml');

// Strings-only YAML plus null/bool: tweet ids exceed 2^53, so a bare id must
// not be read as a Number (it would lose its last digits), and `on:
// 2026-09-10` must stay a string rather than becoming a Date object.
const SCHEMA = yaml.FAILSAFE_SCHEMA.extend({ implicit: [yaml.types.null, yaml.types.bool] });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TWITTER_EPOCH = 1288834974657n;

const str = (v) => (v == null ? '' : String(v).trim());

// [[macro, sub|null], "macro/sub", [macro]] → [[macro, sub|null]], validated.
export function normalizeTopics(topics, tax, where = 'correction') {
  if (!Array.isArray(topics)) throw new Error(`${where}: topics must be a list of [macro, subtopic] pairs`);
  const out = [];
  for (const t of topics) {
    let macro, sub;
    if (typeof t === 'string') [macro, sub] = t.split('/');
    else if (Array.isArray(t)) [macro, sub] = t;
    else throw new Error(`${where}: bad topic ${JSON.stringify(t)}`);
    macro = str(macro);
    sub = str(sub) || null;
    if (!tax[macro]) throw new Error(`${where}: unknown macro "${macro}" (see config/taxonomy.yaml)`);
    if (sub && !tax[macro].subtopics?.[sub]) throw new Error(`${where}: unknown subtopic "${macro}/${sub}" (see config/taxonomy.yaml)`);
    out.push([macro, sub]);
  }
  return out;
}

function normalizeEntry(raw, i, tax) {
  const where = `corrections.yaml entry #${i + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where}: expected a mapping`);
  const e = { topics: normalizeTopics(raw.topics, tax, where), note: str(raw.note), by: str(raw.by), on: str(raw.on) };
  if (raw.id != null) e.id = str(raw.id);
  if (raw.date != null) e.date = str(raw.date);
  if (raw.handle != null) e.handle = str(raw.handle).replace(/^@/, '');
  if (raw.match != null) e.match = str(raw.match);
  if (!e.id && !(e.handle && e.date && e.match)) throw new Error(`${where}: give an id, or handle + date + match`);
  if (e.id && !/^\d+$/.test(e.id)) throw new Error(`${where}: id "${e.id}" is not a tweet id`);
  if (e.date && !DATE_RE.test(e.date)) throw new Error(`${where}: date "${e.date}" must be YYYY-MM-DD (the ET archive day)`);
  if (!DATE_RE.test(e.on)) throw new Error(`${where}: "on" must be the YYYY-MM-DD the correction was filed`);
  return e;
}

export function parseCorrections(text, tax) {
  const doc = yaml.load(text, { schema: SCHEMA }) || [];
  if (!Array.isArray(doc)) throw new Error('config/corrections.yaml must be a list of corrections');
  return doc.map((raw, i) => normalizeEntry(raw, i, tax));
}

export function loadCorrections(tax = loadTaxonomy()) {
  if (!fs.existsSync(correctionsPath)) return [];
  return parseCorrections(fs.readFileSync(correctionsPath, 'utf8'), tax);
}

// Match text the way a staffer copies it from X: entities decoded, curly
// quotes straightened, whitespace collapsed, case ignored.
export function normText(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Tweet ids are snowflakes: the ET archive day is within a day of the id's
// own timestamp, so an id-only entry needs at most three archive files.
export function snowflakeDates(id) {
  const ms = Number((BigInt(id) >> 22n) + TWITTER_EPOCH);
  return [...new Set([etDate(ms - 86_400_000), etDate(ms), etDate(ms + 86_400_000)])];
}

function archiveDates() {
  const dir = p('data', 'archive');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)).sort();
}

function locate(e, { day, authorsById, dates }) {
  if (e.id) {
    const first = e.date ? [e.date] : snowflakeDates(e.id);
    const rest = e.date ? [] : dates().filter((d) => !first.includes(d));
    for (const d of [...first, ...rest]) {
      const t = day(d).find((x) => x.id === e.id);
      if (t) return { id: e.id, date: d, text: t.text, authorId: t.authorId };
    }
    throw new Error(`id ${e.id} is not in data/archive${e.date ? ` for ${e.date}` : ''}`);
  }
  const ids = new Set(Object.entries(authorsById).filter(([, a]) => a.handle?.toLowerCase() === e.handle.toLowerCase()).map(([id]) => id));
  if (!ids.size) throw new Error(`@${e.handle} is not in data/authors.json`);
  const needle = normText(e.match);
  const hits = day(e.date).filter((t) => t.type !== 'retweet' && ids.has(t.authorId) && normText(t.text).includes(needle));
  if (!hits.length) throw new Error(`no original post by @${e.handle} on ${e.date} containing "${e.match}"`);
  if (hits.length > 1) throw new Error(`"${e.match}" matches ${hits.length} posts by @${e.handle} on ${e.date} (${hits.map((t) => t.id).join(', ')}) — use a longer excerpt or the id`);
  const t = hits[0];
  return { id: t.id, date: e.date, text: t.text, authorId: t.authorId };
}

// Entries → {resolved: [{...entry, id, date, text}], unresolved: [{entry, reason}]}.
// deps (tests): loadDay(date), authorsById, archiveDates().
export function resolveIds(entries, deps = {}) {
  const loadDayFn = deps.loadDay || loadDay;
  const authorsById = deps.authorsById || loadAuthors().byId;
  const dates = deps.archiveDates || archiveDates;
  const cache = new Map();
  const day = (d) => { if (!cache.has(d)) cache.set(d, loadDayFn(d)); return cache.get(d); };
  const resolved = [];
  const unresolved = [];
  for (const e of entries) {
    try { resolved.push({ ...e, ...locate(e, { day, authorsById, dates }) }); }
    catch (err) { unresolved.push({ entry: e, reason: err.message }); }
  }
  return { resolved, unresolved };
}

const cmpId = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
// Newest filing first; for the same day the newer post first; then file order.
const byRecency = (a, b) => (a.on < b.on ? 1 : a.on > b.on ? -1 : cmpId(b.id, a.id));

// Several entries for one post: the most recently filed wins.
export function latestPerId(resolved) {
  const byId = new Map();
  for (const c of resolved) {
    const prev = byId.get(c.id);
    if (!prev || byRecency(c, prev) <= 0) byId.set(c.id, c);
  }
  return [...byId.values()];
}

const nextDay = (date) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Overwrite assignments in data/topics/<date>.json. Retweets of a corrected
// post (same day and the two after, the window classify.js inherits across)
// get the same topics, so rollups don't count the amplification under the
// old label. Returns what changed; writes nothing with dryRun.
// deps (tests): loadDay(date), topicsPathFor(date).
export function applyCorrections(resolved, { dryRun = false, loadDay: loadDayFn = loadDay, topicsPathFor = topicsPath } = {}) {
  const files = new Map(); // date → {data, dirty} | null when the day isn't classified yet
  const file = (date) => {
    if (!files.has(date)) {
      const data = readJSON(topicsPathFor(date), null);
      files.set(date, data ? { data, dirty: false } : null);
    }
    return files.get(date);
  };
  const changes = [];
  const pending = [];
  let unchanged = 0;

  for (const c of latestPerId(resolved)) {
    if (!file(c.date)) { pending.push({ id: c.id, date: c.date }); continue; }
    const record = { note: c.note, by: c.by, on: c.on };
    const targets = [{ date: c.date, id: c.id, record }];
    for (let d = c.date, i = 0; i < 3; d = nextDay(d), i++) {
      if (!file(d)) continue;
      for (const t of loadDayFn(d)) {
        if (t.type === 'retweet' && t.refId === c.id) targets.push({ date: d, id: t.id, record: { ...record, via: c.id } });
      }
    }
    for (const t of targets) {
      const f = file(t.date);
      const { data } = f;
      const before = data.assignments[t.id];
      if (same(before, c.topics) && same(data.corrected?.[t.id], t.record)) { unchanged++; continue; }
      data.assignments[t.id] = c.topics;
      (data.corrected ||= {})[t.id] = t.record;
      // A corrected post is classified by definition, and no longer "fits nothing".
      if (Array.isArray(data.unclassified)) data.unclassified = data.unclassified.filter((id) => id !== t.id);
      if (Array.isArray(data.emerging)) {
        for (const e of data.emerging) e.ids = (e.ids || []).filter((id) => id !== t.id);
        data.emerging = data.emerging.filter((e) => e.ids.length);
      }
      f.dirty = true;
      changes.push({ date: t.date, id: t.id, via: t.record.via || null, from: before ?? null, to: c.topics, note: c.note });
    }
  }

  const written = [];
  for (const [date, f] of files) {
    if (!f?.dirty) continue;
    if (!dryRun) writeJSON(topicsPathFor(date), f.data);
    written.push(date);
  }
  return { changes, unchanged, pending, written };
}

// The N most recently filed corrections as few-shot precedents:
// [{text, topics, why}]. Rendered in id order so the prompt block is
// byte-identical between runs whatever order the file is in (prompt cache).
export function correctionExamples(n = 8, deps = {}) {
  if (!(n > 0)) return [];
  const entries = deps.entries || loadCorrections(deps.tax);
  const { resolved } = resolveIds(entries, deps);
  return latestPerId(resolved)
    .sort(byRecency)
    .slice(0, n)
    .sort((a, b) => cmpId(a.id, b.id))
    .map((e) => ({ text: e.text.length > 600 ? `${e.text.slice(0, 600)}…` : e.text, topics: e.topics, why: e.note }));
}

const fmtTopics = (topics) => (topics?.length ? topics.map(([m, s]) => (s ? `${m}/${s}` : m)).join(', ') : '[]');

function main() {
  const cmd = process.argv[2] || 'apply';
  const dryRun = process.argv.includes('--dry-run');
  const tax = loadTaxonomy();
  const entries = loadCorrections(tax);

  if (cmd === 'examples') {
    const nArg = process.argv.find((a) => a.startsWith('--n='));
    const n = nArg ? Number(nArg.split('=')[1]) : (settings.classify.correction_examples ?? 8);
    console.log(renderExamples(correctionExamples(n, { entries, tax })));
    return;
  }
  if (cmd !== 'apply') throw new Error(`unknown command "${cmd}" (apply | examples)`);

  const { resolved, unresolved } = resolveIds(entries);
  for (const u of unresolved) {
    const who = u.entry.id ? `id ${u.entry.id}` : `@${u.entry.handle} ${u.entry.date} "${u.entry.match}"`;
    console.warn(`[corrections] skipped ${who}: ${u.reason}`);
  }
  const r = applyCorrections(resolved, { dryRun });
  for (const ch of r.changes) {
    const via = ch.via ? ` (retweet of ${ch.via})` : '';
    console.log(`  ${ch.date} ${ch.id}${via}: ${fmtTopics(ch.from)} → ${fmtTopics(ch.to)}${ch.via || !ch.note ? '' : `  — ${ch.note}`}`);
  }
  for (const pnd of r.pending) console.log(`  ${pnd.date} ${pnd.id}: no data/topics file yet (nightly hasn't classified that day) — re-run after it does`);
  const verb = dryRun ? 'dry run —' : 'applied:';
  console.log(`[corrections] ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}; ${verb} ${r.changes.length} change(s) across ${r.written.length} day file(s), ${r.unchanged} already applied, ${r.pending.length} pending, ${unresolved.length} unresolved`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  try { main(); } catch (e) { console.error(e); process.exit(1); }
}
