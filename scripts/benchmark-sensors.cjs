// Synthetic 60 Hz motion + orientation, one minute per scenario.
// Serialized payload sizes approximate IndexedDB values, not database disk usage.
const assert = require('node:assert/strict');
const { serialize } = require('node:v8');
const pt = require('../ptbox');
const results = [];
for (const scenario of ['stationary', 'smooth', 'noisy']) {
  let seed = 42;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32 - 0.5);
  const samples = [];
  for (let i = 0; i < 3600; i++) {
    const value = phase => scenario === 'stationary' ? 0 : Math.sin(i / 60 + phase) + (scenario === 'noisy' ? random() * 0.01 : 0);
    const common = { t: 1700000000000 + Math.round(i * 1000 / 60), timeStamp: i * 1000 / 60, screenAngle: 0 };
    samples.push({ ...common, type: 'motion', accelerationX: value(0), accelerationY: value(1), accelerationZ: value(2),
      gravityX: value(0), gravityY: 9.81 + value(1), gravityZ: value(2),
      rotationAlpha: value(0), rotationBeta: value(1), rotationGamma: value(2), interval: 1000 / 60 });
    samples.push({ ...common, type: 'orientation', alpha: value(0) * 180, beta: value(1) * 90, gamma: value(2) * 45,
      webkitCompassHeading: null, webkitCompassAccuracy: null, absolute: false });
  }
  const record = { version: 5, exportedAt: 1700000060000, dayKey: '2023-11-14', timeZone: 'UTC',
    dayStart: 1699920000000, dayEnd: 1700000060000, accumulatedMs: 60000, fragments: [{
      session: { id: 'benchmark-session', previousSessionId: null, a: 1700000000000, z: 1700000060000,
        r: 'restarted', q: 'UTC', o: 0, x: '' },
      fragmentStart: 1700000000000, fragmentEnd: 1700000060000, initialValue: '', events: [], samples
    }] };
  const start = performance.now();
  const compressed = pt.encode(record);
  const encodeMs = performance.now() - start;
  assert.deepEqual(pt.decode(compressed), record);
  const oldBytes = pt.encode(record, 4).length;
  let rawStored = 0, compressedStored = 0;
  // 100 ms batches contain six samples from each stream.
  for (let i = 0; i < samples.length; i += 12) {
    const batch = samples.slice(i, i + 12);
    for (let j = 0; j < batch.length; j++) rawStored += serialize({ ...batch[j], sid: 'benchmark-session', k: i + j + 1 }).length;
    const data = pt.encodeSamples(batch);
    assert.deepEqual(pt.decodeSamples(data), batch);
    compressedStored += serialize({ sid: 'benchmark-session', k: i + 1, t: batch[0].t, data }).length;
  }
  results.push({ scenario, samples: samples.length, v4Bytes: oldBytes, v5Bytes: compressed.length,
    fileReduction: `${(100 * (1 - compressed.length / oldBytes)).toFixed(1)}%`,
    rawSerializedStorage: rawStored, compressedSerializedStorage: compressedStored,
    storagePayloadReduction: `${(100 * (1 - compressedStored / rawStored)).toFixed(1)}%`, encodeMs: +encodeMs.toFixed(1) });
}
console.table(results);

// Whole-draft IME updates with a changing word inside an otherwise stable draft.
const events = [], compact = [];
let value = '';
for (let n = 0; n < 1000; n++) {
  const next = 'context '.repeat(1000) + String(n).padStart(4, '0') + ' tail';
  const event = { t: n, p: 0, d: value.length, i: next, s: 8004, e: 8004 };
  events.push(event); compact.push(pt.compactEdit(event, value));
  assert.equal(pt.apply(value, compact.at(-1)), next);
  value = next;
}
const draft = { version: 5, exportedAt: 1000, dayKey: '1970-01-01', timeZone: 'UTC',
  dayStart: 0, dayEnd: 1000, accumulatedMs: 1000, fragments: [{
    session: { id: 'draft', previousSessionId: null, a: 0, z: 1000, r: 'restarted', q: 'UTC', o: 0, x: '' },
    fragmentStart: 0, fragmentEnd: 1000, initialValue: '', events, samples: []
  }] };
const rawDraftBytes = pt.encode(draft).length;
draft.fragments[0].events = compact;
const compactDraftBytes = pt.encode(draft).length;
assert.equal(pt.decode(pt.encode(draft)).fragments[0].events.reduce(pt.apply, ''), value);
console.log({ wholeDraftUpdates: events.length, rawDraftBytes, compactDraftBytes,
  textReduction: `${(100 * (1 - compactDraftBytes / rawDraftBytes)).toFixed(1)}%` });
