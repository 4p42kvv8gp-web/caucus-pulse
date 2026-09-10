// Strategic-syntax detection — no LLM needed. Message discipline shows up
// as the same 2-4 word phrase appearing across DISTINCT members on the same
// day. We count member spread (not tweet count, which one prolific account
// could game), keep phrases over the threshold, and maintain a first-seen
// ledger so the dashboard can draw adoption curves:
// "Trump Cartel: first used Aug 24 by @RepJeffries, 31 members within 48h".
import { settings, daysAgoEt, readJSON, writeJSON, p } from './util.js';
import { loadDay, syntaxPath } from './store.js';
import { loadAuthors, splitByRoster } from './authors.js';

export const phrasesPath = p('data', 'phrases.json');

const STOP = new Set(`a an and are as at be been but by for from had has have he her his i if in is it its me my not of on or our so that the their them they this to was we were will with you your today just amp rt via more all can out now new one get make than about what when who how why up down over under after before during their there here going day says said join watch live tune proud great thank thanks happy im dont its lets us do does did done shall would could should might must
`.trim().split(/\s+/));

// Tokenize tweet text for phrase mining: strip links, mentions, and
// punctuation; keep hashtag words (minus the #) since slogans live there.
export function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@\w+/g, ' ')
    .replace(/#/g, '')
    // X text carries curly quotes: "Trump’s" must not become "trump s".
    // Possessives drop to the bare noun; other apostrophes collapse so
    // "don't" → "dont" (a stopword) instead of "don" + "t".
    .replace(/[‘’`]/g, "'")
    .replace(/\b(won't|can't|shan't)\b/g, (m) => ({ "won't": 'will not', "can't": 'can not', "shan't": 'shall not' })[m])
    .replace(/n't\b/g, ' not')            // don't → do not (both stopwords)
    .replace(/'(s|ll|re|ve|d|m)\b/g, '')  // Trump's → trump, I'll → i, we're → we
    .replace(/'/g, '')
    .replace(/\b([a-z])\.([a-z])\.?/g, '$1$2') // U.S. → us, D.C. → dc
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// N-grams that don't start or end on a stopword (interior stopwords are
// fine: "state of the union" should survive).
export function ngrams(tokens, min, max) {
  const out = [];
  for (let n = min; n <= max; n++) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const gram = tokens.slice(i, i + n);
      if (STOP.has(gram[0]) || STOP.has(gram[n - 1])) continue;
      if (gram.every((w) => STOP.has(w) || /^\d+$/.test(w))) continue;
      out.push(gram.join(' '));
    }
  }
  return out;
}

// One day's tweets → phrases used by >= minMembers distinct authors.
// Retweets excluded: retweeting is amplification, not adoption of phrasing.
export function minePhrases(tweets, { minMembers, minNgram, maxNgram }) {
  const byPhrase = new Map(); // phrase → {authors: Set, tweets: Set, earliest: record}
  for (const t of tweets) {
    if (t.type === 'retweet') continue;
    const grams = new Set(ngrams(tokenize(t.text), minNgram, maxNgram));
    for (const g of grams) {
      const e = byPhrase.get(g) || { authors: new Set(), tweets: new Set(), earliest: t };
      e.authors.add(t.authorId);
      e.tweets.add(t.id);
      if (t.createdAt < e.earliest.createdAt) e.earliest = t;
      byPhrase.set(g, e);
    }
  }
  const kept = [];
  for (const [phrase, e] of byPhrase) {
    if (e.authors.size < minMembers) continue;
    kept.push({ phrase, members: e.authors.size, tweets: e.tweets.size, earliest: e.earliest });
  }
  // Drop phrases fully contained in a kept longer phrase with the same
  // spread — "trump cartel" beats "trump" + "cartel" fragments.
  const bySpread = kept.sort((a, b) => b.phrase.length - a.phrase.length);
  const final = [];
  for (const c of bySpread) {
    if (final.some((k) => k.phrase.includes(c.phrase) && k.members >= c.members)) continue;
    final.push(c);
  }
  return final.sort((a, b) => b.members - a.members || b.tweets - a.tweets);
}

async function main() {
  const dateArg = process.argv.find((a) => a.startsWith('--date='));
  const date = dateArg ? dateArg.split('=')[1] : daysAgoEt(1);
  const cfg = {
    minMembers: settings.syntax.min_members,
    minNgram: settings.syntax.min_ngram,
    maxNgram: settings.syntax.max_ngram
  };
  const authors = loadAuthors().byId;
  // Roster filter: a senator repeating a line is not House message discipline.
  const tweets = splitByRoster(loadDay(date), authors).house;
  const phrases = minePhrases(tweets, cfg).slice(0, settings.syntax.top_phrases);

  // Update the first-seen ledger (adoption curves). memberFirst records the
  // first day each member used the phrase — that's what "New 48h" counts.
  const ledger = readJSON(phrasesPath, {});
  const authorsOf = new Map();
  for (const t of tweets) {
    if (t.type === 'retweet') continue;
    const grams = new Set(ngrams(tokenize(t.text), cfg.minNgram, cfg.maxNgram));
    for (const g of grams) {
      if (!authorsOf.has(g)) authorsOf.set(g, new Set());
      authorsOf.get(g).add(t.authorId);
    }
  }
  for (const ph of phrases) {
    const entry = ledger[ph.phrase] || {
      firstSeen: date,
      firstAuthorId: ph.earliest.authorId,
      firstAuthor: authors[ph.earliest.authorId]?.handle || ph.earliest.authorId,
      byDay: {},
      memberFirst: {}
    };
    entry.memberFirst ||= {};
    for (const authorId of authorsOf.get(ph.phrase) || []) {
      if (!entry.memberFirst[authorId] || entry.memberFirst[authorId] > date) entry.memberFirst[authorId] = date;
    }
    entry.byDay[date] = { members: ph.members, tweets: ph.tweets };
    ledger[ph.phrase] = entry;
  }
  writeJSON(phrasesPath, ledger);

  writeJSON(syntaxPath(date), {
    date,
    phrases: phrases.map((ph) => ({
      phrase: ph.phrase,
      members: ph.members,
      tweets: ph.tweets,
      firstSeen: ledger[ph.phrase].firstSeen,
      firstAuthor: ledger[ph.phrase].firstAuthor,
      isNew: ledger[ph.phrase].firstSeen === date
    }))
  });
  console.log(`[syntax] ${date}: ${phrases.length} phrase(s) over the ${cfg.minMembers}-member threshold${phrases[0] ? `; top: "${phrases[0].phrase}" (${phrases[0].members} members)` : ''}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
