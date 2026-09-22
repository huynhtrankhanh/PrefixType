const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const serve = require('./server.cjs');
const pt = require('../ptbox');
const fs = require('node:fs');
(async () => {
  const server = await serve();
  const browser = await chromium.launch({ channel: 'chromium', args: ['--no-sandbox'] });
  const errors = [];
  async function pageFor(init) {
    const context = await browser.newContext({ timezoneId: 'UTC' });
    if (init) await context.addInitScript(init);
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(server.url);
    return page;
  }
  const start = page => page.evaluate(() => { PrefixType.reset('abcdef'); PrefixType.editor.focus(); PrefixType.editor.insert('a'); });
  const emit = page => page.evaluate(() => {
    window.dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: 0, y: -2.5, z: null },
      accelerationIncludingGravity: { x: 0, y: 9.81, z: 1 }, rotationRate: { alpha: 3, beta: 0, gamma: -1 }, interval: 16 }));
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: -15, gamma: 20, absolute: false }));
    const absolute = new DeviceOrientationEvent('deviceorientationabsolute', { alpha: 90, beta: 10, gamma: null, absolute: true });
    Object.defineProperties(absolute, { webkitCompassHeading: { value: 270 }, webkitCompassAccuracy: { value: 5 } });
    window.dispatchEvent(absolute);
  });
  const samples = page => page.evaluate(async () => {
    const sessions = await PrefixType.getAllSessions();
    return sessions.length ? PrefixType.getSensorSamplesForSession(sessions.at(-1).id) : [];
  });
  try {
    const page = await pageFor();
    await emit(page); assert.deepEqual(await samples(page), []);
    await start(page);
    await page.evaluate(() => window.dispatchEvent(new DeviceMotionEvent('devicemotion')));
    assert.equal(await page.locator('#sensorIndicator').isVisible(), false);
    await emit(page);
    const saved = await samples(page);
    assert.equal(saved.length, 3);
    const stored = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open('prefixtype-blackbox');
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
      });
      const rows = await new Promise(resolve => {
        const r = db.transaction('sensors').objectStore('sensors').getAll();
        r.onsuccess = () => resolve(r.result);
      });
      db.close();
      return rows.map(row => ({ bytes: row.data?.byteLength, samples: Ptbox.decodeSamples(row.data).length }));
    });
    assert.equal(stored.reduce((sum, row) => sum + row.samples, 0), 3);
    assert(stored.every(row => row.bytes > 0));
    assert.equal(saved[0].accelerationX, 0); assert.equal(saved[0].accelerationZ, null);
    assert.equal(saved[0].gravityY, 9.81); assert.equal(saved[1].alpha, 0);
    assert.equal(saved[2].webkitCompassHeading, 270); assert.equal(saved[2].absolute, true);
    assert.equal(await page.locator('#sensorIndicator').getAttribute('data-recording'), 'true');
    assert.deepEqual(await page.evaluate(() => PrefixType.stats), { totalInserted: 1, correctInserted: 1, finished: false });
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await emit(page); assert.equal((await samples(page)).length, 3);
    assert.equal(await page.locator('#sensorIndicator').isVisible(), false);
    await page.evaluate(() => {
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // Completion is terminal for sensors too; export flushes the pending batch.
    await page.evaluate(() => PrefixType.editor.insert('bcdef'));
    await emit(page); assert.equal((await samples(page)).length, 3);
    assert.equal(await page.locator('#sensorIndicator').isVisible(), false);
    const bytes = await page.evaluate(async () => {
      const key = new Date().toISOString().slice(0, 10);
      return Array.from(PrefixType.encodePtbox(await PrefixType.buildDailyRecord(key)));
    });
    const record = pt.decode(Uint8Array.from(bytes));
    assert.equal(record.version, 5); assert.equal(record.fragments[0].samples.length, 3);
    assert.deepEqual(pt.audit(record).errors, []);
    assert.equal(record.fragments[0].events.reduce(pt.apply, ''), 'abcdef');
    await page.locator('#records').click();
    const downloadReady = page.waitForEvent('download');
    await page.locator('#recordsList button').first().click();
    const download = await downloadReady;
    const downloaded = pt.decode(fs.readFileSync(await download.path()));
    assert.equal(downloaded.fragments[0].samples.length, 3);
    assert.deepEqual(pt.audit(downloaded).errors, []);
    await page.reload(); assert.equal((await samples(page)).length, 3);
    console.log('PASS sensor persistence, v5 export, text replay, missing values, completion and reload');

    await start(page); await emit(page);
    await page.evaluate(() => dispatchEvent(new Event('pagehide')));
    const before = await samples(page); await emit(page);
    assert.deepEqual(await samples(page), before);
    await page.evaluate(() => PrefixType.editor.insert('b')); await emit(page);
    const linked = await page.evaluate(async () => {
      const sessions = await PrefixType.getAllSessions();
      return sessions.filter(s => s.previousSessionId !== null);
    });
    assert.equal(linked.length, 1); assert.equal((await samples(page)).length, 3);
    console.log('PASS pagehide stops sensor recording and continuation has its own samples');

    const permitted = await pageFor(() => {
      window.permissionCalls = [];
      DeviceMotionEvent.requestPermission = () => { permissionCalls.push(['motion', navigator.userActivation.isActive]); return Promise.resolve('granted'); };
      DeviceOrientationEvent.requestPermission = () => { permissionCalls.push(['orientation', navigator.userActivation.isActive]); return Promise.resolve('denied'); };
    });
    assert.deepEqual(await permitted.evaluate(() => permissionCalls), []);
    await permitted.locator('#sensorIndicator').click();
    assert.deepEqual(await permitted.evaluate(() => permissionCalls), [['motion', true], ['orientation', true]]);
    await start(permitted); await emit(permitted); assert.equal((await samples(permitted)).length, 3);
    console.log('PASS permission requests require a tap, both run during activation, partial grant works');
    const denied = await pageFor(() => {
      DeviceMotionEvent.requestPermission = () => Promise.resolve('denied');
      DeviceOrientationEvent.requestPermission = () => Promise.reject(new Error('blocked'));
    });
    await denied.locator('#sensorIndicator').click();
    await denied.waitForFunction(() => document.getElementById('sensorIndicator').textContent.includes('denied'));
    await start(denied); assert.equal((await denied.evaluate(() => PrefixType.editor.value)), 'a');
    assert.deepEqual(await samples(denied), []);
    console.log('PASS denial/rejection retains typing and never claims recording');

    const unsupported = await pageFor(() => { delete window.DeviceMotionEvent; delete window.DeviceOrientationEvent; });
    await start(unsupported);
    assert.equal(await unsupported.locator('#sensorIndicator').isVisible(), false);
    assert.deepEqual(await samples(unsupported), []);
    console.log('PASS devices without sensor APIs remain usable without a recording indicator');

    const failing = await pageFor(); await start(failing); await failing.evaluate(() => PrefixType.flush());
    await failing.evaluate(() => {
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function(stores, mode, ...rest) {
        if (mode === 'readwrite') throw new DOMException('Test quota exhaustion', 'QuotaExceededError');
        return transaction.call(this, stores, mode, ...rest);
      };
    });
    await emit(failing);
    assert.equal(await failing.evaluate(async () => {
      try { await PrefixType.flush(); return false; } catch { return true; }
    }), true);
    assert.equal(await failing.locator('#sensorIndicator').isVisible(), false);
    await emit(failing);
    assert.equal(await failing.locator('#sensorIndicator').isVisible(), false);
    console.log('PASS storage failures stop sensor recording and fail the flush');

    const simulated = await pageFor();
    const cdp = await simulated.context().newCDPSession(simulated);
    // These are real browser-generated events from Chromium's virtual sensors.
    for (const type of ['accelerometer', 'linear-acceleration', 'gyroscope']) {
      await cdp.send('Emulation.setSensorOverrideEnabled', { type, enabled: true });
    }
    await start(simulated);
    for (const type of ['accelerometer', 'linear-acceleration', 'gyroscope']) {
      await cdp.send('Emulation.setSensorOverrideReadings', { type, reading: { xyz: { x: 1, y: 2, z: 3 } } });
    }
    await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 12, beta: 23, gamma: 34 });
    await simulated.waitForFunction(async () => {
      const s = await PrefixType.getAllSessions();
      const data = await PrefixType.getSensorSamplesForSession(s[0].id);
      return data.some(d => d.type === 'motion' && d.accelerationX === 1 && d.gravityZ === 3) &&
        data.some(d => d.type === 'orientation' && d.alpha === 12);
    });
    assert.equal(await simulated.locator('#sensorIndicator').getAttribute('data-recording'), 'true');
    await simulated.screenshot({ path: 'test-results/sensor-strip.png' });
    console.log('PASS Chromium virtual accelerometer/gyroscope and orientation delivery');

    // Seed schema v1 before loading the app, then verify its records survive v2.
    const migrationContext = await browser.newContext();
    const migration = await migrationContext.newPage();
    await migration.goto(server.url + '/original.html');
    await migration.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open('prefixtype-blackbox', 1);
        r.onupgradeneeded = () => {
          const db = r.result;
          db.createObjectStore('sessions', { keyPath: 'id' });
          const events = db.createObjectStore('events', { keyPath: 'k', autoIncrement: true });
          events.createIndex('sid', 'sid'); events.createIndex('t', 't');
        };
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
      });
      const tx = db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').put({ id: 'legacy', a: 1, c: 2, z: 2, r: 'restarted', x: 'abc' });
      await new Promise(resolve => tx.oncomplete = resolve); db.close();
    });
    await migration.goto(server.url);
    assert.equal(await migration.evaluate(async () => (await PrefixType.getAllSessions())[0].id), 'legacy');
    await start(migration); await emit(migration); assert.equal((await samples(migration)).length, 3);
    console.log('PASS database v1 upgrade preserves legacy sessions and accepts sensor samples');

    const oldSamples = Array.from({ length: 390 }, (_, i) => ({
      ...saved[i % saved.length], sid: i < 260 ? 'old-a' : 'old-b', t: 1000 + Math.floor(i / 3)
    })).map(({ k, ...sample }) => sample);
    const v2Context = await browser.newContext();
    const v2 = await v2Context.newPage();
    await v2.route('**/seed.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await v2.goto(server.url + '/seed.html');
    await v2.evaluate(async samples => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open('prefixtype-blackbox', 2);
        r.onupgradeneeded = () => {
          const store = r.result.createObjectStore('sensors', { keyPath: 'k', autoIncrement: true });
          store.createIndex('sid', 'sid'); store.createIndex('t', 't');
          r.result.createObjectStore('sessions', { keyPath: 'id' });
          const events = r.result.createObjectStore('events', { keyPath: 'k', autoIncrement: true });
          events.createIndex('sid', 'sid'); events.createIndex('t', 't');
        };
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
      });
      const tx = db.transaction(['sensors', 'sessions', 'events'], 'readwrite');
      for (const sample of samples) tx.objectStore('sensors').add(sample);
      const before = 'context '.repeat(1000) + 'old tail', after = 'context '.repeat(1000) + 'new tail';
      tx.objectStore('sessions').put({ id: 'draft', initialText: before, a: 1, z: 3, c: 3, r: 'restarted', x: '' });
      tx.objectStore('events').add({ sid: 'draft', t: 2, p: 0, d: before.length, i: after, s: 8003, e: 8005 });
      tx.objectStore('events').add({ sid: 'draft', t: 3, p: 0, d: after.length, i: after, s: 1, e: 2 });
      tx.objectStore('sessions').put({ id: 'unknown', a: 1, z: 3, c: 3, r: 'pagehide', x: '' });
      tx.objectStore('events').add({ sid: 'unknown', t: 2, p: 0, d: before.length, i: after, s: 8003, e: 8005 });
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
      db.close();
    }, oldSamples);
    await v2.goto(server.url);
    const migrated = await v2.evaluate(async () => {
      const a = await PrefixType.getSensorSamplesForSession('old-a');
      const b = await PrefixType.getSensorSamplesForSession('old-b');
      const db = await new Promise(resolve => {
        const r = indexedDB.open('prefixtype-blackbox'); r.onsuccess = () => resolve(r.result);
      });
      const rows = await new Promise(resolve => {
        const r = db.transaction('sensors').objectStore('sensors').getAll(); r.onsuccess = () => resolve(r.result);
      });
      const result = { version: db.version, rows: rows.length, compressed: rows.every(row => row.data instanceof Uint8Array),
        samples: [...a, ...b].map(({ k, ...sample }) => sample) };
      db.close(); return result;
    });
    assert.equal(migrated.version, 3); assert.equal(migrated.rows, 5); assert(migrated.compressed);
    assert.deepEqual(migrated.samples, oldSamples);
    const edits = await v2.evaluate(async () => ({
      known: await PrefixType.getEventsForSession('draft'), unknown: await PrefixType.getEventsForSession('unknown')
    }));
    assert.deepEqual(edits.known.map(({ p, d, i, s, e }) => [p, d, i, s, e]),
      [[8000, 3, 'new', 8003, 8005], [8008, 0, '', 1, 2]]);
    assert.equal(edits.unknown[0].d, 8008); assert.equal(edits.unknown[0].i.length, 8008);
    await v2.reload();
    assert.equal(await v2.evaluate(async () => (await PrefixType.getSensorSamplesForSession('old-a')).length), 260);
    console.log('PASS schema v2 sensor rows compact to bounded lossless blocks and survive reload');

    const midnight = await page.evaluate(async () => {
      const start = Date.UTC(2026, 0, 2), end = start + 86400000;
      const db = await new Promise(resolve => {
        const r = indexedDB.open('prefixtype-blackbox', 3); r.onsuccess = () => resolve(r.result);
      });
      const tx = db.transaction(['sessions', 'sensors', 'events'], 'readwrite');
      tx.objectStore('sessions').put({ id: 'midnight-sensors', previousSessionId: null, initialText: '',
        a: start - 1000, z: end + 1000, c: end + 1000, r: 'restarted', x: 'abc', q: 'UTC', o: 0 });
      const samples = [start - 1, start, end - 1, end].map(t => ({
        sid: 'midnight-sensors', type: 'orientation', t, timeStamp: 1, screenAngle: 0,
        alpha: 1, beta: null, gamma: 0, absolute: false, webkitCompassHeading: null, webkitCompassAccuracy: null
      }));
      // A legacy row and a compressed block spanning midnight coexist.
      tx.objectStore('sensors').add(samples[0]);
      tx.objectStore('sensors').add({ sid: 'midnight-sensors', t: start, data: Ptbox.encodeSamples(samples.slice(1)) });
      tx.objectStore('events').add({ sid: 'midnight-sensors', t: start - 1, p: 0, d: 0, i: 'context old tail', s: 16, e: 16 });
      tx.objectStore('events').add({ sid: 'midnight-sensors', t: start, p: 0, d: 16, i: 'context new tail', s: 11, e: 15 });
      await new Promise(resolve => tx.oncomplete = resolve); db.close();
      return { start, end, records: await Promise.all(['2026-01-01', '2026-01-02', '2026-01-03'].map(PrefixType.buildDailyRecord)) };
    });
    assert.deepEqual(midnight.records.map(r => r.fragments.find(f => f.session.id === 'midnight-sensors').samples.map(s => s.t)),
      [[midnight.start - 1], [midnight.start, midnight.end - 1], [midnight.end]]);
    const secondDay = midnight.records[1].fragments.find(f => f.session.id === 'midnight-sensors');
    assert.equal(secondDay.initialValue, 'context old tail');
    assert.deepEqual(secondDay.events.map(({ p, d, i, s, e }) => [p, d, i, s, e]), [[8, 3, 'new', 11, 15]]);
    for (const record of midnight.records) assert.deepEqual(pt.audit(pt.decode(pt.encode(record))).errors, []);
    console.log('PASS sensor exports use half-open midnight boundaries without duplicate samples');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
