const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { decode, encode, audit } = require('../ptbox.js');
const folder = process.argv[2] || 'traces';
const files = fs.readdirSync(folder).filter(f => f.endsWith('.ptbox')).sort();
if (!files.length) throw new Error('Download traces first: python3 scripts/download-traces.py');
const manifest = JSON.parse(fs.readFileSync('tests/fixtures/trace-manifest.json'));
let total = { files: files.length, fragments: 0, events: 0, bytes: 0, errors: 0, warnings: 0 };
const results = [];
for (const file of files) {
  const bytes = fs.readFileSync(path.join(folder, file));
  const pinned = manifest.find(item => item.name === file);
  if (pinned) assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), pinned.sha256, 'Downloaded file hash: ' + file);
  const record = decode(bytes), result = audit(record);
  assert.deepEqual(Buffer.from(encode(record, record.version)), bytes, 'Byte-for-byte roundtrip: ' + file);
  total.fragments += result.fragments; total.events += result.events; total.bytes += bytes.length;
  total.errors += result.errors.length; total.warnings += result.warnings.length;
  results.push({ file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), ...result });
  console.log(file, result.fragments, 'sessions,', result.events, 'events,', result.errors.length, 'errors');
}
fs.mkdirSync('test-results', { recursive: true });
fs.writeFileSync('test-results/trace-audit.json', JSON.stringify({ total, results }, null, 2));
console.log(total);
if (total.errors) process.exitCode = 1;
