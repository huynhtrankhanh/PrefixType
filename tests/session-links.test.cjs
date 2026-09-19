const test = require('node:test');
const assert = require('node:assert/strict');
const pt = require('../ptbox');
function fixture() {
  return { exportedAt: 100, dayKey: '1970-01-01', timeZone: 'UTC', dayStart: 0, dayEnd: 100, accumulatedMs: 40,
    fragments: [
      { session: { id: 'root-session', previousSessionId: null, a: 10, z: 30, r: 'pagehide', q: 'UTC', o: 0, x: 'abcdef' },
        fragmentStart: 10, fragmentEnd: 30, initialValue: '', events: [{ t: 20, p: 0, d: 0, i: 'abc', s: 3, e: 3 }] },
      { session: { id: 'child-session', previousSessionId: 'root-session', a: 40, z: 60, r: 'completed', q: 'UTC', o: 0, x: 'abcdef' },
        fragmentStart: 40, fragmentEnd: 60, initialValue: 'abc', events: [{ t: 50, p: 3, d: 0, i: 'def', s: 6, e: 6 }] }
    ] };
}
test('v3 preserves predecessor IDs and independently replayable initial text', () => {
  const record = fixture(), bytes = pt.encode(record), decoded = pt.decode(bytes);
  assert.equal(decoded.version, 3);
  assert.deepEqual(decoded.fragments, record.fragments);
  assert.deepEqual(pt.encode(decoded), bytes);
  assert.deepEqual(pt.audit(decoded).errors, []);
  assert.equal(pt.audit(decoded).continuations, 1);
  const child = decoded.fragments[1];
  assert.equal(child.events.reduce(pt.apply, child.initialValue), 'abcdef');
  decoded.fragments = [child]; decoded.accumulatedMs = 20;
  assert.deepEqual(pt.audit(decoded).errors, [], 'Predecessor may be in a different daily file');
  for (const version of [1, 2]) assert.throws(() => pt.encode(record, version), /linkage/);
});
test('explicit linkage uses IDs, not fragment ordering', () => {
  const record = fixture(); record.fragments.reverse();
  assert.deepEqual(pt.audit(pt.decode(pt.encode(record))).errors, []);
});
test('midnight fragments share an ID, with the boundary edit only in the next day', () => {
  const session = { id: 'spans-midnight', previousSessionId: null, a: 10, z: 50, r: 'completed', q: 'UTC', o: 0, x: 'ab' };
  const first = { exportedAt: 100, dayKey: 'day-one', timeZone: 'UTC', dayStart: 0, dayEnd: 50, accumulatedMs: 40,
    fragments: [{ session, fragmentStart: 10, fragmentEnd: 50, initialValue: '', events: [{ t: 20, p: 0, d: 0, i: 'a', s: 1, e: 1 }] }] };
  const second = { exportedAt: 100, dayKey: 'day-two', timeZone: 'UTC', dayStart: 50, dayEnd: 100, accumulatedMs: 0,
    fragments: [{ session, fragmentStart: 50, fragmentEnd: 50, initialValue: 'a', events: [{ t: 50, p: 1, d: 0, i: 'b', s: 2, e: 2 }] }] };
  for (const record of [first, second]) {
    const decoded = pt.decode(pt.encode(record));
    assert.equal(decoded.fragments[0].session.id, 'spans-midnight');
    assert.equal(decoded.fragments[0].session.previousSessionId, null);
    assert.deepEqual(pt.audit(decoded).errors, []);
  }
});
test('v3 retains legacy unknown linkage when exporting a mixture of record generations', () => {
  const record = fixture(); delete record.fragments[0].session.previousSessionId;
  const decoded = pt.decode(pt.encode(record));
  assert(!Object.hasOwn(decoded.fragments[0].session, 'previousSessionId'));
  assert.equal(decoded.fragments[1].session.previousSessionId, 'root-session');
  assert.deepEqual(pt.audit(decoded).errors, []);
  const legacy = fixture(); legacy.fragments.forEach(f => delete f.session.previousSessionId);
  legacy.fragments[1].initialValue = '';
  for (const version of [1, 2]) {
    const bytes = pt.encode(legacy, version), decoded = pt.decode(bytes);
    assert.deepEqual(pt.encode(decoded), bytes);
    assert.deepEqual(pt.audit(decoded).errors, []);
  }
});
test('v3 preserves unpaired UTF-16, empty continuation state, and explicit roots', () => {
  const record = fixture(), [parent, child] = record.fragments;
  parent.session.x = child.session.x = '\ud800x'; parent.events[0].i = '\ud800'; parent.events[0].s = parent.events[0].e = 1;
  child.initialValue = '\ud800'; Object.assign(child.events[0], { p: 1, i: 'x', s: 2, e: 2 });
  const decoded = pt.decode(pt.encode(record));
  assert.equal(decoded.fragments[1].initialValue, '\ud800');
  assert.deepEqual(pt.audit(decoded).errors, []);
  parent.events = []; child.initialValue = ''; child.session.r = 'pagehide'; child.events = [];
  assert.equal(pt.initialState(child, { session: parent.session, text: 'unrelated' }).text, '');
});
test('audit rejects broken links, mismatched starting text and cycles', () => {
  for (const mutate of [
    r => r.fragments[1].session.previousSessionId = 'child-session',
    r => r.fragments[0].session.r = 'restarted',
    r => r.fragments[1].initialValue = 'xyz',
    r => r.fragments[0].session.previousSessionId = 'child-session'
  ]) { const record = fixture(); mutate(record); assert(pt.audit(record).errors.length); }
});
test('v3 parser rejects invalid linkage tags and every truncated prefix', () => {
  const bytes = pt.encode(fixture());
  for (let n = 0; n < bytes.length; n++) assert.throws(() => pt.decode(bytes.slice(0, n)));
  const bad = Buffer.from(bytes), id = Buffer.from('root-session', 'utf16le');
  const at = bad.indexOf(id); assert(at > 0); bad[at + id.length] = 99;
  assert.throws(() => pt.decode(bad), /linkage kind/);
});
