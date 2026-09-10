// The 24-hour volume measurement — first act of the build. Run this after
// the poller has been live for a day or more; it turns the archive + usage
// ledger into the real budget numbers (the brief's cost table was an
// estimate — this is the measurement that replaces it).
import fs from 'node:fs';
import { p, readJSONL } from './util.js';
import { loadState, estCost, dailyBudget } from './store.js';

function main() {
  const dir = p('data', 'archive');
  const dates = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)).sort()
    : [];
  if (!dates.length) {
    console.log('No archive yet — set the list id, run `npm run poll` a few times (or let the cron run for a day), then re-run.');
    return;
  }
  const state = loadState();
  console.log('date        tweets  originals  retweets  X reads   est cost');
  let totTweets = 0, totCost = 0, fullDays = 0, fullDayTweets = 0, fullDayOriginals = 0;
  for (const date of dates) {
    const tweets = readJSONL(p('data', 'archive', `${date}.jsonl`));
    const originals = tweets.filter((t) => t.type !== 'retweet').length;
    const u = state.usage[date] || { posts: 0, users: 0 };
    const cost = estCost(u);
    console.log(
      `${date}  ${String(tweets.length).padStart(6)}  ${String(originals).padStart(9)}  ${String(tweets.length - originals).padStart(8)}  ${String(u.posts + u.users).padStart(7)}   $${cost.toFixed(2)}`
    );
    totTweets += tweets.length; totCost += cost;
    // First and last dates are partial days; only interior days project cleanly.
    if (date !== dates[0] && date !== dates[dates.length - 1]) {
      fullDays++; fullDayTweets += tweets.length; fullDayOriginals += originals;
    }
  }
  console.log(`\nTotal: ${totTweets} tweets, ~$${totCost.toFixed(2)} in X reads. Daily budget: ${dailyBudget()} reads.`);
  if (fullDays) {
    const perDay = fullDayTweets / fullDays;
    // capture + 24h refresh of the originals share, using the measured mix
    const origShare = fullDayTweets ? fullDayOriginals / fullDayTweets : 0.65;
    const daily = perDay * 0.005 * (1 + origShare);
    console.log(`Measured volume: ~${Math.round(perDay)} tweets/day over ${fullDays} full day(s).`);
    console.log(`Projected X spend: ~$${daily.toFixed(2)}/day, ~$${(daily * 30).toFixed(0)}/month (capture + 24h refresh).`);
  } else {
    console.log('Fewer than one full interior day captured so far — projections firm up after ~48h of polling.');
  }
}

main();
