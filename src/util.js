// Shared helpers. All paths resolve against the package root so every script
// works no matter what the current working directory is.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const p = (...parts) => path.join(ROOT, ...parts);

export const settings = JSON.parse(fs.readFileSync(p('config', 'settings.json'), 'utf8'));
const TZ = settings.timezone || 'America/New_York';

// Calendar date (YYYY-MM-DD) in the reporting timezone. en-CA formats as ISO.
export function etDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d instanceof Date ? d : new Date(d));
}

export function daysAgoEt(n) {
  return etDate(new Date(Date.now() - n * 86_400_000));
}

// YYYY-MM-DD ± n days, pure calendar arithmetic (no timezone involved).
export function addDays(date, n) {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

export function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 1) + '\n');
}

export function appendJSONL(file, records) {
  if (!records.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

export function readJSONL(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* tolerate a torn tail line */ }
  }
  return out;
}

// Tweet ids are snowflakes: numeric strings too large for Number.
export function idGt(a, b) {
  if (a == null) return false;
  if (b == null) return true;
  return BigInt(a) > BigInt(b);
}
export function maxId(a, b) { return idGt(a, b) ? a : b; }

// Minimal RFC-4180 CSV parser (quotes, embedded commas/newlines).
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

// Roster status, from the optional `status` column. Only `house` accounts
// count toward the numbers; senators, former members and stray non-member
// accounts stay on the List for context (docs/ROSTER_COVERAGE.md). Blank
// means house — the column is optional and most rows never need it.
export const ACCOUNT_STATUSES = ['house', 'senate', 'former', 'org'];

// accounts.csv text → [{handle, member, accountType, caucuses: [..], stateDistrict, status}]
export function parseAccounts(text) {
  const [header, ...body] = parseCSV(text);
  const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  return body.map((r, i) => {
    // A typo here would silently count a senator as a House member, so
    // refuse the whole file rather than default it.
    const status = (r[col.status] || '').trim().toLowerCase() || 'house';
    if (!ACCOUNT_STATUSES.includes(status)) {
      throw new Error(`accounts.csv row ${i + 2}: unknown status "${status}" (expected one of ${ACCOUNT_STATUSES.join(', ')})`);
    }
    return {
      handle: (r[col.handle] || '').trim().replace(/^@/, ''),
      member: (r[col.member] || '').trim(),
      accountType: (r[col.account_type] || '').trim(),
      caucuses: (r[col.caucuses] || '').split('|').map((c) => c.trim()).filter(Boolean),
      stateDistrict: (r[col.state_district] || '').trim(),
      status
    };
  }).filter((a) => a.handle);
}

export function loadAccounts() {
  return parseAccounts(fs.readFileSync(p('config', 'accounts.csv'), 'utf8'));
}
