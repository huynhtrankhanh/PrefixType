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
    assert.equal(record.version, 4); assert.equal(record.fragments[0].samples.length, 3);
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
    console.log('PASS sensor persistence, v4 export, text replay, missing values, completion and reload');

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

    const midnight = await page.evaluate(async () => {
      const start = Date.UTC(2026, 0, 2), end = start + 86400000;
      const db = await new Promise(resolve => {
        const r = indexedDB.open('prefixtype-blackbox', 2); r.onsuccess = () => resolve(r.result);
      });
      const tx = db.transaction(['sessions', 'sensors'], 'readwrite');
      tx.objectStore('sessions').put({ id: 'midnight-sensors', previousSessionId: null, initialText: '',
        a: start - 1000, z: end + 1000, c: end + 1000, r: 'restarted', x: 'abc', q: 'UTC', o: 0 });
      for (const t of [start - 1, start, end - 1, end]) tx.objectStore('sensors').add({
        sid: 'midnight-sensors', type: 'orientation', t, timeStamp: 1, screenAngle: 0,
        alpha: 1, beta: null, gamma: 0, absolute: false, webkitCompassHeading: null, webkitCompassAccuracy: null
      });
      await new Promise(resolve => tx.oncomplete = resolve); db.close();
      return { start, end, records: await Promise.all(['2026-01-01', '2026-01-02', '2026-01-03'].map(PrefixType.buildDailyRecord)) };
    });
    assert.deepEqual(midnight.records.map(r => r.fragments.find(f => f.session.id === 'midnight-sensors').samples.map(s => s.t)),
      [[midnight.start - 1], [midnight.start, midnight.end - 1], [midnight.end]]);
    for (const record of midnight.records) assert.deepEqual(pt.audit(pt.decode(pt.encode(record))).errors, []);
    console.log('PASS sensor exports use half-open midnight boundaries without duplicate samples');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
