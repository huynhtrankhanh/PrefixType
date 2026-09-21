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
  const record = fixture(), bytes = pt.encode(record), decoded = pt.decode(bytes);
  assert.deepEqual(decoded, record);
  assert.deepEqual(pt.encode(decoded), bytes);
  assert.deepEqual(pt.audit(decoded).errors, []);
  for (const version of [1, 2, 3]) assert.throws(() => pt.encode(record, version), /sensor samples/);
  record.version = 3;
  assert.equal(pt.decode(pt.encode(record)).version, 4);
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
  const bytes = pt.encode(record);
  for (let n = 0; n < bytes.length; n++) assert.throws(() => pt.decode(bytes.slice(0, n)));
  const badFlag = bytes.slice(); badFlag[badFlag.length - 1] = 3;
  assert.throws(() => pt.decode(badFlag), /absolute flag/);
  // Orientation entry: tag + timestamp + seven nullable Float64 fields + flag.
  const badTag = bytes.slice(); badTag[badTag.length - 66] = 255;
  assert.throws(() => pt.decode(badTag), /sensor type/);
});
