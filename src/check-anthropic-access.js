// Sanitized Anthropic credential check. Prints the auth mode, which env var
// supplied the key, and the result of one tiny request — never the key.
//
//   node --use-env-proxy src/check-anthropic-access.js   # or: npm run check-anthropic
//
// Auth resolution (src/anthropic-auth.js): CLASSIFIER_ANTHROPIC_API_KEY, then
// ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN, then workload identity
// federation (GitHub Actions only). Exit 2 when nothing is configured, 1 when
// the credential is rejected.
import { anthropicClient, anthropicConfigured, authMode, apiKeySource, budgetExhausted } from './anthropic-auth.js';
import { budgetStatus, formatStatus } from './anthropic-usage.js';
import { settings } from './util.js';

async function main() {
  if (budgetExhausted()) {
    console.log(`RESULT: daily budget reached — ${formatStatus(budgetStatus())}`);
    process.exit(3);
  }
  if (!anthropicConfigured()) {
    console.log('RESULT: no Anthropic credential — set CLASSIFIER_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY locally); in Actions, federation needs id-token: write');
    process.exit(2);
  }
  const mode = authMode();
  const src = apiKeySource();
  console.log(`AUTH MODE: ${mode}${src ? ` (from ${src}, ${process.env[src].length} chars)` : ''}`);

  const model = process.env.CLASSIFY_MODEL || settings.classify.model;
  const client = await anthropicClient();
  try {
    const res = await client.messages.create({
      model,
      max_tokens: 5,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }]
    });
    console.log(`POST /v1/messages (${model}) → ok`, JSON.stringify({
      stop_reason: res.stop_reason,
      input_tokens: res.usage?.input_tokens,
      output_tokens: res.usage?.output_tokens
    }));
    console.log('RESULT: credential authenticates and the classifier model is reachable.');
  } catch (e) {
    const status = e?.status ?? 'n/a';
    console.log(`POST /v1/messages (${model}) → ${status}: ${String(e?.message || e).slice(0, 200)}`);
    console.log(status === 401 || status === 403
      ? 'RESULT: credential rejected — check the key / federation rule'
      : 'RESULT: request failed — see status above');
    process.exit(1);
  }
}

main().catch((e) => { console.error('check failed:', e.message); process.exit(1); });
