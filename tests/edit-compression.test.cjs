const test = require('node:test');
const assert = require('node:assert/strict');
const pt = require('../ptbox');

test('whole-draft replacements retain only changed UTF-16 units and preserve selections', () => {
  const before = 'context '.repeat(1000) + 'old tail';
  const after = 'context '.repeat(1000) + 'new tail';
  const event = { t: 123, p: 0, d: before.length, i: after, s: 8003, e: 8005 };
  const compact = pt.compactEdit(event, before);
  assert.deepEqual(compact, { ...event, p: 8000, d: 3, i: 'new' });
  assert.equal(pt.apply(before, compact), after);
  const repeated = pt.compactEdit({ ...event, i: before }, before);
  assert.equal(repeated.d, 0); assert.equal(repeated.i, '');
  assert.equal(pt.apply(before, repeated), before);
});

test('compacted edits replay every Unicode state, including partial ranges and lone surrogates', () => {
  let seed = 1234, before = '';
  const pick = n => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n);
  const values = ['a', '\ud800', '\udfff', '😀', 'e\u0301', '한', '\n', '', 'العربية'];
  for (let n = 0; n < 5000; n++) {
    if (n % 100 === 0) before = '';
    const p = pick(before.length + 1), d = pick(before.length - p + 1);
    const after = before.slice(0, p) + values[pick(values.length)] + before.slice(p + d);
    const s = pick(after.length + 1), e = s + pick(after.length - s + 1);
    const event = { t: n, p: 0, d: before.length, i: after, s, e };
    const compact = pt.compactEdit(event, before);
    assert.equal(pt.apply(before, compact), after);
    assert.deepEqual([compact.t, compact.s, compact.e], [n, s, e]);
    assert.deepEqual(pt.compactEdit(compact, before.slice(compact.p, compact.p + compact.d)), compact);
    const partial = { ...event, p, d, i: after.slice(p, after.length - (before.length - p - d)) };
    assert.equal(pt.apply(before, pt.compactEdit(partial, before.slice(p, p + d))), after);
    before = after;
  }
});
