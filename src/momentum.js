// Momentum 0-100: how hard a topic is moving relative to its own 7-day
// baseline. 50 = steady. Ported exactly from the design handoff's momentum()
// (DashboardV3.dc.html) — the dashboard's tooltip documents the weights:
// 40% volume lift · 20% acceleration · 20% member adoption · 10% caucus
// spread · 10% engagement lift.
//
// Input shape (per topic): {
//   c:     [cpc, newdem, cbc] posts today
//   trend: posts/day for the last 7 days (oldest first)
//   d:     % vs 7-day average (today)
//   m:     distinct members today
//   mAvg:  distinct members, 7-day daily average
//   eng:   engagement in the window
//   epAvg: engagement per post, 7-day baseline
// }
const clamp = (x) => Math.max(-1, Math.min(1, x));
const half = (x) => 0.5 + 0.5 * clamp(x);

export function momentum(t) {
  const tr = t.trend;
  const avg = tr.reduce((a, b) => a + b, 0) / tr.length;
  const tot = t.c[0] + t.c[1] + t.c[2];
  const volume = half(t.d / 50);                                                // today vs 7-day average (±50% saturates)
  const accel = half(((tr[6] - tr[4]) / 2 - (tr[4] - tr[0]) / 4) / ((avg || 1) * 0.1)); // is the slope steepening?
  const adoption = half((t.m - t.mAvg) / (t.mAvg || 1) / 0.5);                  // distinct members vs baseline
  const eff = tot ? 1 / t.c.reduce((a, n) => a + Math.pow(n / tot, 2), 0) : 1;  // effective caucuses, 1-3
  const spread = (eff - 1) / 2;
  const engLift = half(((tot ? t.eng / tot : 0) / (t.epAvg || 1) - 1) / 0.5);   // engagement per post vs baseline
  const score = Math.round(100 * (0.4 * volume + 0.2 * accel + 0.2 * adoption + 0.1 * spread + 0.1 * engLift));
  return {
    score, volume, accel, adoption, spread, engLift, eff,
    drivers: [['volume', volume], ['acceleration', accel], ['adoption', adoption], ['caucus spread', spread], ['engagement', engLift]]
      .sort((a, b) => b[1] - a[1])
  };
}
