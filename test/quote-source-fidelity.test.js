import test from 'node:test';
import assert from 'node:assert/strict';
import { quotedContext, quotedResolver, quotingFor } from '../src/quoted.js';
import { classifierLine, withQuoting } from '../src/classify.js';
import { loadDay } from '../src/store.js';

const refId = '2092248359880802504';
const wrapper = { id: '2099572340568776885', type: 'quote', refId,
  text: 'A new report about local costs.', createdAt: '2026-09-14T18:53:48.000Z' };
const fullText = 'Preserve this wording exactly.\n' + 'Quoted reporting continues… '.repeat(50) + '\nFINAL CONDITION: the report describes an earlier event.';
const original = { id: refId, authorId: '12345', handle: 'Source', text: fullText,
  createdAt: '2026-08-25T13:50:55.000Z', metrics: { impressions: 70 },
  source: { raw: { id: refId, text: fullText } }, privatePayload: 'omit from input' };
const deps = (extra = {}) => ({ quoted: {}, archive: () => null, authorsById: {}, metricsFor: () => ({}), ...extra });

test('embedded, cached and archived quote sources keep full wording, source identity and original date', () => {
  const variants = [
    { post: { ...wrapper, quoted: original }, options: deps() },
    { post: wrapper, options: deps({ quoted: { [refId]: original } }) },
    { post: wrapper, options: deps({ archive: () => original, metricsFor: () => original.metrics }) }
  ];
  const before = JSON.stringify({ wrapper, original });
  for (const { post, options } of variants) {
    const [item] = withQuoting([post], quotedResolver(options));
    const input = JSON.parse(classifierLine(item));
    assert.equal(input.text, wrapper.text);
    assert.equal(input.createdAt, wrapper.createdAt);
    assert.deepEqual(input.quoting, { id: refId, authorId: '12345', handle: 'Source',
      text: fullText, createdAt: original.createdAt, impressions: 70 });
    assert.ok(input.quoting.text.endsWith('the report describes an earlier event.'));
    assert.ok(!('source' in input.quoting));
    assert.ok(!JSON.stringify(input).includes('privatePayload'));
  }
  assert.equal(JSON.stringify({ wrapper, original }), before);
});

test('invalid embedded or cache context falls through instead of hiding valid archived source wording', () => {
  const invalid = [
    { ...original, id: '999' }, { ...original, id: 2092248359880802504 },
    { ...original, text: '' }, { ...original, text: ' \n ' },
    { ...original, text: 123 }, { ...original, unavailable: true }, []
  ];
  for (const value of invalid) {
    const cached = quotedContext({ ...wrapper, quoted: value }, deps({ quoted: { [refId]: original } }));
    assert.equal(cached.id, refId); assert.equal(cached.text, fullText);
    const archived = quotedContext({ ...wrapper, quoted: value }, deps({ quoted: { [refId]: value }, archive: () => original }));
    assert.equal(archived.id, refId); assert.equal(archived.createdAt, original.createdAt);
    assert.equal(quotedContext({ ...wrapper, quoted: value }, deps({ quoted: { [refId]: value } })), null);
  }
  assert.equal(quotedContext(wrapper, deps({ archive: () => ({ ...original, id: '999' }) })), null,
    'an archive lookup cannot relabel a conflicting source ID');
});

test('legacy source IDs may come from the reference, while unknown dates stay unknown', () => {
  const { id, createdAt, ...legacy } = original;
  for (const options of [deps(), deps({ quoted: { [refId]: legacy } })]) {
    const context = quotedContext({ ...wrapper, quoted: options.quoted[refId] ? undefined : legacy }, options);
    assert.equal(context.id, refId);
    assert.equal(context.createdAt, null);
    assert.equal(quotingFor(context).createdAt, null);
  }
  assert.equal(quotingFor({ ...original, createdAt: 'invalid' }).createdAt, null);
  assert.equal(quotingFor({ ...original, authorId: 12345 }).authorId, null);
});

test('missing quote or reply context does not by itself change the member post or force interpretation uncertainty', () => {
  for (const type of ['quote', 'reply']) {
    const post = { ...wrapper, type, topics: [['economy', 'prices-inflation']], needsContext: false };
    const [result] = withQuoting([post], quotedResolver(deps()));
    assert.equal(result, post);
    assert.equal(result.needsContext, false);
    assert.ok(!('quoting' in result));
  }
  for (const ctx of [null, {}, { ...original, text: '' }, { ...original, unavailable: true }]) {
    assert.equal(quotingFor(ctx), null);
  }
  const noReads = deps({ archive: () => { throw new Error('must not look up an invalid reference'); } });
  for (const refId of [null, 'invalid', 123]) assert.equal(quotedContext({ ...wrapper, refId }, noReads), null);
});

// Source-backed regressions from the selected public archive review. The
// general tests above remain authoritative if source-retention changes later
// remove these historical public records.
const publicArchive = new Map(loadDay('2026-09-14').map((post) => [post.id, post]));
for (const example of [
  { id: '2099577178576884201', refId: '2099553201636642890', date: '2026-09-14T17:37:45.000Z', tailAnchor: 'Finland' },
  { id: '2099572340568776885', refId: '2092248359880802504', date: '2026-08-25T13:50:55.000Z', tailAnchor: 'childcare' }
]) {
  const post = publicArchive.get(example.id);
  test(`public quote ${example.id} retains the source tail and its own publication date`,
    { skip: !post?.quoted && 'historical public source not retained' }, () => {
      const [item] = withQuoting([post], quotedResolver(deps()));
      const input = JSON.parse(classifierLine(item));
      assert.ok(post.quoted.text.length > 400);
      assert.ok(post.quoted.text.indexOf(example.tailAnchor) >= 400);
      assert.equal(input.quoting.text, post.quoted.text);
      assert.equal(input.quoting.id, example.refId);
      assert.equal(input.quoting.createdAt, example.date);
      assert.equal(input.createdAt, post.createdAt);
    });
}
