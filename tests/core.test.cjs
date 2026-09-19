const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('../editor.js');
const { TextModel, boundary, adjacent } = global.PrefixEditor;
const ptbox = require('../ptbox.js');
function random(seed) { return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; }; }
const samples = ['a', ' ', '\n', '\t', 'é', 'e\u0301', '🇰🇷', '👨‍👩‍👧‍👦', '👍🏽', '한', '中文', 'क्‍ष', 'العربية', '\ud800', '\udfff', '\u200d', '\u0301', '\r'];
function oraclePrefix(text, target) {
  let p = 0;
  while (p < text.length && p < target.length && text[p] === target[p]) p++;
  const boundaries = value => new Set([0, ...Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value), x => x.index + x.segment.length)]);
  const a = boundaries(text), b = boundaries(target);
  while (p && (!a.has(p) || !b.has(p))) p--;
  return p;
}
test('20,000 deterministic Unicode edits agree with a whole-string reference', () => {
  const rng = random(0x7012026), pick = n => Math.floor(rng() * n);
  let text = '', target = samples.join('') + 'abc'.repeat(20), model = new TextModel(target);
  for (let n = 0; n < 20000; n++) {
    if (n % 100 === 0) { target = Array.from({ length: 25 }, () => samples[pick(samples.length)]).join(''); text = ''; model.reset(target); }
    let p = pick(text.length + 1), d = pick(text.length - p + 1), i = samples[pick(samples.length)];
    if (n % 3 === 0) { p = text.length; d = 0; i = target.slice(p, p + 1 + pick(4)); }
    const expected = text.slice(0, p) + i + text.slice(p + d);
    const oldDisplay = text + target.slice(oraclePrefix(text, target));
    const result = model.replace(p, d, i);
    assert.equal(model.text, expected); assert.equal(model.prefix, oraclePrefix(expected, target));
    if (result.stable) assert.equal(oldDisplay, expected + target.slice(model.prefix));
    assert.equal(model.focus, p + i.length);
    text = expected;
  }
});
test('navigation never splits extended graphemes', () => {
  const text = 'A👨‍👩‍👧‍👦🇰🇷e\u0301👍🏽क्‍षB';
  let pos = 0; const stops = [0];
  while (pos < text.length) { pos = adjacent(text, pos, 1); stops.push(pos); }
  assert.equal(stops.length, 8);
  for (let i = stops.length - 1; i > 0; i--) assert.equal(adjacent(text, stops[i], -1), stops[i - 1]);
  for (let i = 0; i <= text.length; i++) assert(stops.includes(boundary(text, i)));
});
function record(text) {
  return { exportedAt: 100, dayKey: '1970-01-01', timeZone: 'UTC', dayStart: 0, dayEnd: 100, accumulatedMs: 20,
    fragments: [{ session: { id: 'sample', a: 10, z: 30, r: 'completed', q: 'UTC', o: 0, x: text },
      fragmentStart: 10, fragmentEnd: 30, initialValue: '', events: [{ t: 20, p: 0, d: 0, i: text, s: text.length, e: text.length }] }] };
}
test('PTBOX v1 and lossless v2 roundtrip, including lone surrogates and BOM', () => {
  for (const text of ['abc🇰🇷e\u0301', '\ufeffstart', '\ud800', 'a\udfffz', '']) {
    const input = record(text), bytes = ptbox.encode(input), output = ptbox.decode(bytes);
    assert.equal(output.version, ptbox.wellFormed(text) ? 1 : 2);
    assert.equal(output.fragments[0].events[0].i, text);
    assert.deepEqual(ptbox.encode(output), bytes);
    assert.deepEqual(ptbox.audit(output).errors, []);
  }
  assert.throws(() => ptbox.encode(record('\ud800'), 1));
});
test('binary truncation and 5,000 malformed inputs terminate with bounded reads', () => {
  const valid = ptbox.encode(record('こんにちは👋'));
  for (let n = 0; n < valid.length; n++) assert.throws(() => ptbox.decode(valid.slice(0, n)));
  const rng = random(2026);
  for (let n = 0; n < 5000; n++) {
    const bytes = new Uint8Array(valid);
    for (let j = 0; j < 1 + n % 6; j++) bytes[Math.floor(rng() * bytes.length)] = Math.floor(rng() * 256);
    try { const decoded = ptbox.decode(bytes); ptbox.audit(decoded); } catch (error) { assert(error instanceof Error); }
  }
});
test('all supplied trace deltas replay, preserving legacy pagehide continuation', { skip: process.env.PREFIXTYPE_TRACE_TESTS !== '1' }, () => {
  let events = 0, continuations = 0;
  for (const file of fs.readdirSync('traces').filter(f => f.endsWith('.ptbox'))) {
    const bytes = fs.readFileSync('traces/' + file), record = ptbox.decode(bytes);
    assert.deepEqual(Buffer.from(ptbox.encode(record)), bytes);
    const audit = ptbox.audit(record); assert.deepEqual(audit.errors, [], file); continuations += audit.continuations;
    let previous;
    for (const f of record.fragments) {
      let text = ptbox.initialState(f, previous).text;
      const model = new TextModel(f.session.x); model.reset(f.session.x, text);
      for (const e of f.events) {
        text = ptbox.apply(text, e); model.replace(e.p, e.d, e.i, [e.s, e.e]);
        assert.equal(model.text, text); assert(model.prefix <= model.rawPrefix);
        events++;
      }
      previous = { session: f.session, text };
    }
  }
  assert.equal(events, 187436); assert.equal(continuations, 1);
});
