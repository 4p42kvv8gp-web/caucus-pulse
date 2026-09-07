import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/db.js';
import { normalizePost } from '../src/normalize.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const input = process.argv[2];
if (!input) throw new Error('Provide the path to the existing calibration JSON. Source content is not bundled in Git.');
const session = JSON.parse(readFileSync(resolve(input), 'utf8'));
process.umask(0o077);
const store = openStore(process.env.CAUCUS_DB_PATH ?? resolve(root, 'data/pulse.sqlite'));
try {
  let imported = 0;
  for (const example of session.examples) {
    if (!example.source.freshly_verified_on_x || !example.text || !example.author_id) {
      throw new Error('Only previously API-verified full-text examples with author IDs can be imported here.');
    }
    store.upsertAccount({ authorId: example.author_id, memberId: `calibration:${example.author_id}`,
      memberName: example.author, handle: example.handle, identityNote: example.source.author_identity_note,
      accountType: 'unverified' });
    const post = normalizePost({ id: example.post_id, author_id: example.author_id,
      created_at: example.posted_at_utc, text: example.text }, {
      kind: 'historical-calibration', retrievedAt: example.source.retrieved_at, fullTextVerified: true,
      contextCoverage: 'Media, external links, and surrounding conversation not reviewed',
      source: example.source, exerciseId: example.id, assistantProposal: example.assistant_proposal,
      reviewPrompt: example.review_prompt
    });
    if (store.ingest(post).inserted) imported++;
  }
  store.analyzePending();
  console.log(`Imported ${imported} historical examples. No live requests made; no feedback marked approved.`);
} finally { store.close(); }
