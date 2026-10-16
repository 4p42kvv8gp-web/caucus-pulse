// Nightly reporting targets one closed Eastern calendar day, not the entire
// unfinished archive. Historical catch-up remains an explicit operation.
import { pathToFileURL } from 'node:url';

export function classificationDate({ now = new Date(), override = '' } = {}) {
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error('Invalid current time');
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(instant);
  if (override !== '') {
    if (typeof override !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(override)) {
      throw new Error('NIGHTLY_CLASSIFY_DATE must be YYYY-MM-DD');
    }
    const parsed = new Date(`${override}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== override || override >= today) {
      throw new Error('NIGHTLY_CLASSIFY_DATE must be a valid, closed Eastern calendar day');
    }
    return override;
  }
  // Subtract a calendar day after resolving Eastern today. Subtracting 24 hours
  // from the current instant is wrong near midnight at daylight-saving changes.
  const previous = new Date(`${today}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(classificationDate({ override: process.env.NIGHTLY_CLASSIFY_DATE ?? '' }));
  } catch (error) {
    console.error(`[nightly] ${error.message}`);
    process.exitCode = 1;
  }
}
