const test = require('node:test');
const assert = require('node:assert/strict');
const pt = require('../ptbox');
const orientation = (t = 20) => ({ type: 'orientation', t, timeStamp: 1.25, screenAngle: 90,
  alpha: 0, beta: -25.125, gamma: null, absolute: false, webkitCompassHeading: 359.5, webkitCompassAccuracy: -1 });
const motion = () => ({ type: 'motion', t: 21, timeStamp: 2.5, screenAngle: 90,
  accelerationX: 0, accelerationY: -1.25, accelerationZ: null,
  gravityX: 0.5, gravityY: 9.81, gravityZ: -0,
  rotationAlpha: 12, rotationBeta: null, rotationGamma: -2, interval: 16.6667 });
const fixture = () => ({ version: 4, exportedAt: 100, dayKey: '1970-01-01', timeZone: 'UTC',
  dayStart: 0, dayEnd: 100, accumulatedMs: 20, fragments: [{
    session: { id: 'sensor-session', previousSessionId: null, a: 10, z: 30, r: 'restarted', q: 'UTC', o: 0, x: 'target' },
    fragmentStart: 10, fragmentEnd: 30, initialValue: '', events: [{ t: 11, p: 0, d: 0, i: '\ud800', s: 1, e: 1 }],
    samples: [orientation(), motion(), { ...orientation(22), type: 'orientationabsolute', absolute: true }]
  }] });

test('v4 roundtrips every sensor field, missing axes, zero, linkage and lone surrogates', () => {
  const record = fixture(), bytes = pt.encode(record, 4), decoded = pt.decode(bytes);
  assert.deepEqual(decoded, record);
  assert.deepEqual(pt.encode(decoded, 4), bytes);
  assert.deepEqual(pt.audit(decoded).errors, []);
  for (const version of [1, 2, 3]) assert.throws(() => pt.encode(record, version), /sensor samples/);
  record.version = 3;
  assert.equal(pt.decode(pt.encode(record)).version, 5);
});
test('v4 accepts empty sample streams and upgrades legacy sessions without invented linkage', () => {
  const record = fixture(); delete record.fragments[0].session.previousSessionId;
  record.fragments[0].samples = [];
  assert.deepEqual(pt.decode(pt.encode(record)), record);
});
test('v4 validates sample values, kinds, timestamps and fragment boundaries', () => {
  for (const mutate of [s => s.alpha = Infinity, s => s.type = 'bogus', s => s.absolute = 3, s => s.timeStamp = undefined]) {
    const record = fixture(); mutate(record.fragments[0].samples[0]);
    assert.throws(() => pt.encode(record), /sensor|absolute/);
    assert(pt.audit(record).errors.length);
  }
  for (const t of [9, 31, 100]) {
    const record = fixture(); record.fragments[0].samples[0].t = t;
    assert(pt.audit(record).errors.some(e => e.includes('sensor time')));
  }
});
test('v4 rejects every truncated prefix and malformed binary sample tags/flags', () => {
  const record = fixture(); record.fragments[0].samples = [orientation()];
  const bytes = pt.encode(record, 4);
  for (let n = 0; n < bytes.length; n++) assert.throws(() => pt.decode(bytes.slice(0, n)));
  const badFlag = bytes.slice(); badFlag[badFlag.length - 1] = 3;
  assert.throws(() => pt.decode(badFlag), /absolute flag/);
  // Orientation entry: tag + timestamp + seven nullable Float64 fields + flag.
  const badTag = bytes.slice(); badTag[badTag.length - 66] = 255;
  assert.throws(() => pt.decode(badTag), /sensor type/);
});

test('v5 preserves interleaved streams, repeats, null transitions and signed zeros exactly', () => {
  const record = fixture(); record.version = 5;
  for (let i = 0; i < 100; i++) record.fragments[0].samples.push(
    { ...motion(), t: 22 + i / 100, gravityZ: i % 2 ? -0 : 0 },
    { ...orientation(), t: 22 + i / 100, alpha: i % 2 ? null : Math.sin(i), absolute: i % 2 ? null : true }
  );
  // Each fragment starts with independent predictors.
  record.fragments.push(structuredClone(record.fragments[0]));
  const bytes = pt.encode(record);
  assert.deepEqual(pt.decode(bytes), record);
  assert.deepEqual(pt.encode(pt.decode(bytes)), bytes);
  assert(bytes.length < pt.encode(record, 4).length * 0.4);
  const samples = record.fragments[0].samples;
  assert.deepEqual(pt.decodeSamples(pt.encodeSamples(samples)), samples);
});

test('v5 roundtrips arbitrary finite Float64 bit patterns without arithmetic rounding', () => {
  let seed = 12345;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const view = new DataView(new ArrayBuffer(8)), samples = [];
  for (let i = 0; i < 1000; i++) {
    view.setUint32(0, next()); view.setUint32(4, next());
    const value = view.getFloat64(0);
    if (Number.isFinite(value)) samples.push({ ...orientation(), alpha: value });
  }
  assert.deepEqual(pt.decodeSamples(pt.encodeSamples(samples)), samples);
});

test('v5 rejects truncated files, invalid masks, flags, blocks and trailing bytes', () => {
  const record = fixture(); record.version = 5;
  const bytes = pt.encode(record);
  for (let n = 0; n < bytes.length; n++) assert.throws(() => pt.decode(bytes.slice(0, n)));
  const block = pt.encodeSamples([orientation()]);
  for (let n = 0; n < block.length; n++) assert.throws(() => pt.decodeSamples(block.slice(0, n)));
  assert.throws(() => pt.decodeSamples(Uint8Array.of(6, 0)), /version/);
  assert.throws(() => pt.decodeSamples(Uint8Array.of(5, 1, 2, 128, 2)), /field mask/);
  assert.throws(() => pt.decodeSamples(Uint8Array.of(5, 1, 2, 1, 0)), /byte mask/);
  const badFlag = block.slice(); badFlag[badFlag.length - 1] = 3;
  assert.throws(() => pt.decodeSamples(badFlag), /absolute flag/);
  assert.throws(() => pt.decodeSamples(Uint8Array.from([...block, 0])), /Trailing/);
  assert.deepEqual(pt.decodeSamples(pt.encodeSamples([])), []);
});
