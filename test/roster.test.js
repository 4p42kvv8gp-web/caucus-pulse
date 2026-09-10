import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAccounts, loadAccounts, ACCOUNT_STATUSES } from '../src/util.js';
import { mergeAuthors, isHouse, splitByRoster } from '../src/authors.js';

const HEADER = 'handle,member,account_type,caucuses,state_district,status';

test('parseAccounts: status column is optional and blank means house', () => {
  const noColumn = parseAccounts('handle,member,account_type,caucuses,state_district\nRepX,X,official,cbc,GA-13\n');
  assert.equal(noColumn[0].status, 'house');
  const rows = parseAccounts([
    HEADER,
    'RepX,X,official,cbc,GA-13,',
    'SenY,Y,official,,,Senate',
    'OldZ,Z,personal,,,former',
    'SomeOrg,Org,official,,,org',
    'RepQ,Q,official,progressive|chc,AZ-07' // ragged row: no status field at all
  ].join('\n'));
  assert.deepEqual(rows.map((a) => a.status), ['house', 'senate', 'former', 'org', 'house']);
  assert.deepEqual(rows[0].caucuses, ['cbc']);
  assert.deepEqual(rows[4].caucuses, ['progressive', 'chc']);
});

test('parseAccounts rejects an unknown status instead of counting it as House', () => {
  assert.throws(() => parseAccounts(`${HEADER}\nRepX,X,official,,,retired\n`), /row 2.*"retired"/);
});

test('config/accounts.csv parses: unique handles, valid statuses', () => {
  const accounts = loadAccounts();
  assert.ok(accounts.length > 400);
  const handles = accounts.map((a) => a.handle.toLowerCase());
  assert.equal(new Set(handles).size, handles.length, 'duplicate handle in accounts.csv');
  for (const a of accounts) assert.ok(ACCOUNT_STATUSES.includes(a.status), `${a.handle}: ${a.status}`);
  // A non-House row must not carry caucus tags: it would count toward a
  // caucus while being filtered out of the numbers, and the mismatch
  // would be invisible.
  for (const a of accounts.filter((x) => x.status !== 'house')) assert.deepEqual(a.caucuses, [], `${a.handle} is ${a.status} but tagged`);
});

test('mergeAuthors carries status; List members without a CSV row default to house', () => {
  const users = [{ id: '1', username: 'SenY', name: 'Y' }, { id: '2', username: 'RepNew', name: 'New' }];
  const accounts = parseAccounts(`${HEADER}\nseny,Y,official,,,senate\n`);
  const { byId, untagged } = mergeAuthors({ users, accounts });
  assert.equal(byId['1'].status, 'senate');
  assert.equal(byId['2'].status, 'house');
  assert.deepEqual(untagged.map((u) => u.username), ['RepNew']);
});

test('isHouse / splitByRoster: only House (or unknown) authors count', () => {
  const authorsById = {
    h: { status: 'house' }, s: { status: 'senate' }, f: { status: 'former' }, o: { status: 'org' },
    legacy: { handle: 'Old' } // author table written before the status column existed
  };
  assert.ok(isHouse(authorsById.h));
  assert.ok(isHouse(authorsById.legacy));
  assert.ok(isHouse(undefined)); // an author the table doesn't know
  for (const k of ['s', 'f', 'o']) assert.ok(!isHouse(authorsById[k]), k);
  const posts = ['h', 's', 'f', 'o', 'legacy', 'nobody'].map((authorId, i) => ({ id: String(i), authorId }));
  const { house, excluded } = splitByRoster(posts, authorsById);
  assert.deepEqual(house.map((x) => x.authorId), ['h', 'legacy', 'nobody']);
  assert.deepEqual(excluded.map((x) => x.authorId), ['s', 'f', 'o']);
});
