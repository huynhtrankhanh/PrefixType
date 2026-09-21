const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const serve = require('./server.cjs');
const ptbox = require('../ptbox.js');
(async () => {
  const server = await serve();
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--no-sandbox'] });
  const results = [], errors = [];
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1100, height: 760 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  async function run(name, fn) { const start = Date.now(); await fn(); results.push({ name, ms: Date.now() - start }); console.log('PASS', name); }
  const reset = (target, value = '') => page.evaluate(({ target, value }) => { PrefixType.reset(target); if (value) PrefixType.editor.insert(value); PrefixType.editor.focus(); }, { target, value });
  const state = () => page.evaluate(() => { const e = PrefixType.editor; return { text: e.value, start: e.selectionStart, end: e.selectionEnd, anchor: e.model.anchor, focus: e.model.focus, context: e.editContext.text }; });
  try {
    await page.goto(server.url);
    await run('real EditContext typing, wrong-text displacement, completion remains terminal', async () => {
      assert.equal(await page.locator('#typingInput').evaluate(el => el.tagName), 'CANVAS');
      assert.equal(await page.locator('#customText').evaluate(el => el.tagName), 'TEXTAREA');
      await reset('abc'); await page.keyboard.type('abX');
      assert.deepEqual(await page.evaluate(() => ({ text: PrefixType.editor.displayText(), prefix: PrefixType.editor.prefix })), { text: 'abXc', prefix: 2 });
      await page.keyboard.press('Backspace'); await page.keyboard.type('c');
      assert.equal(await page.locator('#status').textContent(), 'Complete');
      const before = await page.evaluate(async () => { await PrefixType.flush(); return { sessions: await PrefixType.getAllSessions(), stats: PrefixType.stats }; });
      await page.keyboard.type('more');
      await page.evaluate(() => PrefixType.flush());
      const after = await page.evaluate(async () => ({ sessions: await PrefixType.getAllSessions(), stats: PrefixType.stats }));
      assert.deepEqual(after, before);
      assert.equal((await state()).text, 'abcmore');
    });
    await run('keyboard movement and shift selection agree with native Chromium textarea', async () => {
      const value = 'one two\nA👨‍👩‍👧‍👦e\u0301🇰🇷\nlast line';
      await reset(value + ' target', value);
      await page.evaluate(value => {
        const input = document.createElement('textarea'); input.id = 'probe'; input.value = value;
        input.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:200px;font:22px monospace;z-index:100';
        document.body.append(input);
      }, value);
      const cases = ['ArrowLeft', 'ArrowRight', 'Control+ArrowLeft', 'Control+ArrowRight', 'Shift+ArrowLeft',
        'Shift+ArrowRight', 'Control+Shift+ArrowLeft', 'Control+Shift+ArrowRight', 'Home', 'End', 'Control+Home', 'Control+End',
        'Shift+ArrowUp', 'Shift+ArrowDown', 'ArrowUp', 'ArrowDown'];
      for (const key of cases) {
        const start = value.indexOf('e\u0301') + 2;
        await page.locator('#probe').evaluate((input, start) => { input.focus(); input.setSelectionRange(start, start); }, start);
        await page.keyboard.press(key);
        const expected = await page.locator('#probe').evaluate(input => ({ start: input.selectionStart, end: input.selectionEnd }));
        await page.evaluate(start => { PrefixType.editor.focus(); PrefixType.editor.select(start); }, start);
        await page.keyboard.press(key);
        const actual = await state();
        assert.deepEqual({ start: actual.start, end: actual.end }, expected, key);
      }
      await page.locator('#probe').evaluate(input => input.remove());
      await page.evaluate(() => PrefixType.editor.select(1, 8));
      await page.keyboard.press('Shift+ArrowLeft');
      assert.equal((await state()).anchor, 1);
    });
    await run('grapheme deletion, multiline edits, undo and redo', async () => {
      await reset('extra target', 'A👨‍👩‍👧‍👦e\u0301🇰🇷');
      await page.keyboard.press('Backspace'); assert.equal((await state()).text, 'A👨‍👩‍👧‍👦e\u0301');
      await page.keyboard.press('Backspace'); assert.equal((await state()).text, 'A👨‍👩‍👧‍👦');
      await page.keyboard.press('Control+z'); assert.equal((await state()).text, 'A👨‍👩‍👧‍👦e\u0301');
      await page.keyboard.press('Control+Shift+z'); assert.equal((await state()).text, 'A👨‍👩‍👧‍👦');
      await page.keyboard.press('Enter'); await page.keyboard.type('next');
      assert.equal((await state()).text, 'A👨‍👩‍👧‍👦\nnext');
      await page.keyboard.press('Control+Home'); await page.keyboard.press('Delete');
      assert.equal((await state()).text, '👨‍👩‍👧‍👦\nnext');
      await page.keyboard.press('Delete'); assert.equal((await state()).text, '\nnext');
    });
    await run('real clipboard copy, cut and paste normalize line endings', async () => {
      await reset('target', 'alpha 👋 omega');
      await page.evaluate(() => PrefixType.editor.select(6, 8));
      await page.keyboard.press('Control+c');
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '👋');
      await page.keyboard.press('Control+x'); await page.waitForFunction(() => PrefixType.editor.value === 'alpha  omega'); assert.equal((await state()).text, 'alpha  omega');
      await page.keyboard.press('Control+v'); await page.waitForFunction(() => PrefixType.editor.value === 'alpha 👋 omega'); assert.equal((await state()).text, 'alpha 👋 omega');
      await page.evaluate(() => navigator.clipboard.writeText('hello\r\n世界\r!'));
      await page.keyboard.press('Control+a'); await page.keyboard.press('Control+v'); await page.waitForFunction(() => PrefixType.editor.value === 'hello\n世界\n!');
      assert.equal((await state()).text, 'hello\n世界\n!');
    });
    await run('CDP IME composition updates, commit, cancellation and character bounds', async () => {
      await reset('日本語😀 finish');
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
      assert.equal((await state()).text, 'に');
      await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
      assert.equal((await state()).text, '日本');
      await cdp.send('Input.insertText', { text: '日本' });
      assert.equal((await state()).text, '日本');
      await page.keyboard.press('Control+z'); assert.equal((await state()).text, '');
      await page.keyboard.press('Control+Shift+z'); assert.equal((await state()).text, '日本');
      await cdp.send('Input.imeSetComposition', { text: '😀', selectionStart: 2, selectionEnd: 2 });
      const bounds = await page.evaluate(() => {
        const e = PrefixType.editor;
        e.editContext.dispatchEvent(new CharacterBoundsUpdateEvent('characterboundsupdate', { rangeStart: 2, rangeEnd: 4 }));
        return e.editContext.characterBounds().map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
      });
      assert.equal(bounds.length, 2); assert.deepEqual(bounds[0], bounds[1]); assert(bounds[0].width > 0);
      await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
      assert.equal((await state()).text, '日本');
      await cdp.detach();
    });
    await run('mouse hit testing, drag selection and word selection', async () => {
      await reset('hello world next target', 'hello world next');
      const points = await page.evaluate(() => {
        const e = PrefixType.editor; e.paint(); const rect = e.element.getBoundingClientRect();
        return [0, 5, 8].map(i => { const p = e.point(i); return { x: rect.x + p.x, y: rect.y + p.y + e.lineHeight / 2 }; });
      });
      await page.mouse.move(points[0].x, points[0].y); await page.mouse.down();
      await page.mouse.move(points[1].x, points[1].y, { steps: 5 }); await page.mouse.up();
      assert.equal((await state()).start, 0); assert.equal((await state()).end, 5);
      await page.mouse.dblclick(points[2].x, points[2].y);
      assert.equal((await state()).start, 6); assert.equal((await state()).end, 11);
    });
    await run('incremental layout equals a fresh layout after 1,200 Unicode mutations', async () => {
      await reset('line 👨‍👩‍👧‍👦 e\u0301 العربية 中文\n'.repeat(30));
      await page.evaluate(() => {
        const e = PrefixType.editor;
        let seed = 553; const rnd = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
        const samples = ['a', ' ', '\n', '\t', '👨‍👩‍👧‍👦', 'e\u0301', '\u0301', 'العربية', '中文', '🇰🇷', '\ud800', '\udfff'];
        for (let i = 0; i < 1200; i++) {
          const p = rnd(e.value.length + 1), d = rnd(e.value.length - p + 1);
          e.replace(p, d, samples[rnd(samples.length)]); e.paint();
          const snapshot = () => JSON.stringify(e.lines.map(l => [l.start, l.end, l.cells.map(c => [c.text, c.x, c.width])]));
          const incremental = snapshot();
          const count = e.lines.length;
          e.lines = []; e.iterator = null; e.done = false; e.ensureLayout(-1, e.padding + (count - 1) * e.lineHeight); e.paint();
          if (snapshot() !== incremental) throw new Error('Layout mismatch at mutation ' + i);
          if (e.editContext.text !== e.value) throw new Error('EditContext divergence');
          for (const pos of [0, e.value.length]) {
            const point = e.point(pos);
            if (!Number.isFinite(point.x + point.y)) throw new Error('Non-finite caret');
          }
        }
      });
    });
    await run('database snapshots, exported deltas and equal-length correction statistics', async () => {
      await reset('abc'); await page.keyboard.type('ax');
      await page.evaluate(() => PrefixType.editor.select(1, 2)); await page.keyboard.type('b'); await page.keyboard.type('c');
      assert.deepEqual(await page.evaluate(() => PrefixType.stats), { totalInserted: 4, correctInserted: 3, finished: true });
      const record = await page.evaluate(async () => {
        await PrefixType.flush();
        const now = new Date(), day = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
        return PrefixType.buildDailyRecord(day);
      });
      assert.deepEqual(ptbox.audit(record).errors, []);
      const final = record.fragments.at(-1); let value = final.initialValue;
      for (const event of final.events) value = ptbox.apply(value, event);
      assert.equal(value, 'abc'); assert.equal(final.session.r, 'completed');
      const bytes = await page.evaluate(record => Array.from(PrefixType.encodePtbox(record)), record);
      assert.deepEqual(ptbox.audit(ptbox.decode(Uint8Array.from(bytes))).errors, []);
      await reset('unpaired test'); await page.evaluate(() => PrefixType.editor.insert('\ud800'));
      const lossless = await page.evaluate(async () => {
        await PrefixType.flush(); const s = (await PrefixType.getAllSessions()).at(-1);
        return { session: s, events: await PrefixType.getEventsForSession(s.id) };
      });
      assert.equal(lossless.events.at(-1).i, '\ud800');
    });
    await run('pagehide continuation and concurrent-tab recovery preserve session semantics', async () => {
      await reset('abcdef'); await page.keyboard.type('abc');
      await page.evaluate(async () => { await PrefixType.flush(); window.dispatchEvent(new PageTransitionEvent('pagehide')); await PrefixType.flush(); });
      await page.keyboard.type('def');
      const sessions = await page.evaluate(async () => { await PrefixType.flush(); return PrefixType.getAllSessions(); });
      assert.equal(sessions.at(-2).r, 'pagehide'); assert.equal(sessions.at(-1).r, 'completed');
      assert.equal(sessions.at(-1).previousSessionId, sessions.at(-2).id);
      assert.equal(sessions.at(-1).initialText, 'abc');
      const events = await page.evaluate(id => PrefixType.getEventsForSession(id), sessions.at(-1).id);
      assert.equal(events[0].p, 3); assert.equal(events[0].i, 'd');
      const exported = await page.evaluate(async () => {
        const now = new Date(), day = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
        return Array.from(PrefixType.encodePtbox(await PrefixType.buildDailyRecord(day)));
      });
      const record = ptbox.decode(Uint8Array.from(exported));
      assert.equal(record.version, 4);
      const continued = record.fragments.find(f => f.session.id === sessions.at(-1).id);
      assert.equal(continued.session.previousSessionId, sessions.at(-2).id);
      assert.equal(continued.initialValue, 'abc');
      assert.equal(continued.events.reduce(ptbox.apply, continued.initialValue), 'abcdef');
      assert.deepEqual(ptbox.audit(record).errors, []);
      await reset('restart parent target'); await page.keyboard.type('foo');
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      await reset('restart parent target'); await page.keyboard.type('bar');
      const restarted = await page.evaluate(async () => { await PrefixType.flush(); return (await PrefixType.getAllSessions()).at(-1); });
      assert.equal(restarted.previousSessionId, null); assert.equal(restarted.initialText, '');
      await reset('continue target'); await page.keyboard.type('c'); await page.evaluate(() => PrefixType.flush());
      const other = await context.newPage(); await other.goto(server.url);
      const latest = await other.evaluate(async () => (await PrefixType.getAllSessions()).at(-1));
      assert.equal(latest.z, null); await other.close();
    });
    await run('Unicode rendering seams, RTL navigation, resize and long-line reflow', async () => {
      await reset('👩👩 target', '👨‍');
      assert(await page.evaluate(() => {
        const e = PrefixType.editor; e.paint();
        return e.lines.every(line => line.cells.every(cell => !(cell.start < e.value.length && cell.end > e.value.length)));
      }));
      await reset('abc target', 'אבג');
      await page.evaluate(() => PrefixType.editor.select(1));
      await page.keyboard.press('ArrowLeft'); assert.equal((await state()).focus, 0);
      await page.keyboard.press('ArrowRight'); assert.equal((await state()).focus, 1);
      await reset('x'.repeat(16000), 'x'.repeat(8000));
      await page.evaluate(() => { const e = PrefixType.editor; e.select(7500); e.insert('👨‍👩‍👧‍👦wrong'); e.paint(); });
      await page.setViewportSize({ width: 420, height: 400 });
      await page.waitForTimeout(80);
      assert(await page.evaluate(() => {
        const e = PrefixType.editor, caret = e.point(e.model.focus);
        return caret.y >= e.scroll && caret.y + e.lineHeight <= e.scroll + e.height + 1;
      }));
      await page.evaluate(() => {
        const e = PrefixType.editor; e.paint(); const lines = JSON.stringify(e.lines.map(l => [l.start, l.end]));
        const count = e.lines.length; e.lines = []; e.iterator = null; e.done = false;
        e.ensureLayout(-1, e.padding + (count - 1) * e.lineHeight); e.paint();
        if (lines !== JSON.stringify(e.lines.map(l => [l.start, l.end]))) throw new Error('Long line cache mismatch');
      });
      await page.setViewportSize({ width: 1100, height: 760 });
    });
    await run('IME draft match immediately completes and later updates preserve the session', async () => {
      await reset('日本'); const cdp = await context.newCDPSession(page);
      await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
      assert.equal(await page.evaluate(() => PrefixType.editor.composing), true);
      assert.equal(await page.evaluate(() => PrefixType.stats.finished), true);
      const snapshot = () => page.evaluate(async () => {
        await PrefixType.flush();
        const sessions = await PrefixType.getAllSessions();
        const session = sessions.at(-1);
        return { session, events: await PrefixType.getEventsForSession(session.id), stats: PrefixType.stats };
      });
      const completed = await snapshot();
      assert.equal(completed.session.r, 'completed');
      assert(completed.session.z);
      let replay = completed.session.initialText || '';
      for (const e of completed.events) replay = replay.slice(0, e.p) + e.i + replay.slice(e.p + e.d);
      assert.equal(replay, '日本');
      await cdp.send('Input.imeSetComposition', { text: '日本語', selectionStart: 3, selectionEnd: 3 });
      await cdp.send('Input.insertText', { text: '日本語' });
      assert.deepEqual(await snapshot(), completed);
      assert.equal(await page.locator('#status').textContent(), 'Complete');
      assert.equal(await page.locator('#finished').evaluate(el => el.classList.contains('show')), true);
      await cdp.detach();
    });
    await run('daily export clips midnight/DST and recovery closes interrupted sessions', async () => {
      const zone = await browser.newContext({ timezoneId: 'America/New_York' });
      const tab = await zone.newPage(); await tab.goto(server.url);
      const result = await tab.evaluate(async () => {
        const dayStart = new Date(2026, 2, 8).getTime(), dayEnd = new Date(2026, 2, 9).getTime();
        const db = await new Promise((resolve, reject) => { const r = indexedDB.open('prefixtype-blackbox', 2); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        const tx = db.transaction(['sessions', 'events'], 'readwrite');
        tx.objectStore('sessions').put({ id: 'dst-session', previousSessionId: null, initialText: '', a: dayStart - 1000, c: dayEnd + 1000, z: dayEnd + 1000, r: 'completed', x: 'abc', q: 'America/New_York', o: 300 });
        for (const [t, p, i] of [[dayStart - 500, 0, 'a'], [dayStart + 1000, 1, 'b'], [dayEnd, 2, 'c']]) tx.objectStore('events').add({ sid: 'dst-session', t, p, d: 0, i, s: p + 1, e: p + 1 });
        tx.objectStore('sessions').put({ id: 'interrupted', a: dayStart, c: dayStart + 5000, z: null, r: null, x: 'test', owner: 'absent-owner' });
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
        return { record: await PrefixType.buildDailyRecord('2026-03-08'),
          adjacentDays: [await PrefixType.buildDailyRecord('2026-03-07'), await PrefixType.buildDailyRecord('2026-03-09')], dayStart, dayEnd };
      });
      assert.equal(result.dayEnd - result.dayStart, 23 * 3600000);
      const f = result.record.fragments.find(f => f.session.id === 'dst-session');
      assert.equal(f.initialValue, 'a'); assert.deepEqual(f.events.map(e => e.i), ['b']);
      assert.equal(f.fragmentEnd - f.fragmentStart, 23 * 3600000);
      assert.deepEqual(ptbox.audit(result.record).errors, []);
      for (const record of result.adjacentDays) {
        const fragment = ptbox.decode(ptbox.encode(record)).fragments.find(f => f.session.id === 'dst-session');
        assert.equal(fragment.session.id, f.session.id);
        assert.equal(fragment.session.previousSessionId, null);
        assert.deepEqual(ptbox.audit(record).errors, []);
      }
      await tab.reload();
      const interrupted = await tab.evaluate(async () => (await PrefixType.getAllSessions()).find(s => s.id === 'interrupted'));
      assert.equal(interrupted.r, 'recovered'); assert.equal(interrupted.z, interrupted.c);
      await zone.close();
    });
    await run('native fallback remains editable and uses the same recorder', async () => {
      await reset('fallback target'); await page.locator('#nativeMode').click();
      await page.keyboard.type('fallback'); assert.equal((await state()).text, 'fallback');
      await page.locator('#nativeMode').click(); assert.equal((await state()).context, 'fallback');
      const fallback = await browser.newContext();
      await fallback.addInitScript(() => { delete window.EditContext; });
      const tab = await fallback.newPage(); await tab.goto(server.url);
      await tab.locator('#nativeInput').fill('native');
      assert.equal(await tab.evaluate(() => PrefixType.editor.value), 'native'); await fallback.close();
    });
    await run('mobile long press, selection handles, dragging and touch scroll', async () => {
      const mobile = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
        userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/145.0.0.0 Mobile Safari/537.36' });
      const tab = await mobile.newPage(); tab.on('pageerror', error => errors.push(error.message)); await tab.goto(server.url);
      await tab.evaluate(() => { PrefixType.reset('hello world '.repeat(120)); PrefixType.editor.insert('hello world '.repeat(40)); PrefixType.editor.select(0); PrefixType.editor.paint(); });
      const cdp = await mobile.newCDPSession(tab);
      const point = await tab.evaluate(() => { const e = PrefixType.editor, r = e.element.getBoundingClientRect(), p = e.point(2); return { x: r.x + p.x, y: r.y + p.y + e.lineHeight / 2 }; });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point }] });
      await tab.waitForTimeout(520);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      assert.deepEqual(await tab.evaluate(() => {
        const e = PrefixType.editor;
        return [e.selectionStart, e.selectionEnd, e.nativeInput.selectionStart, e.nativeInput.selectionEnd,
          e.textareaInput, e.nativeMode, e.hasFocus];
      }), [0, 5, 0, 5, true, false, true]);
      assert.equal(await tab.locator('.selection-handle:visible').count(), 2);
      assert(await tab.locator('#selectionToolbar').isVisible());
      const handle = await tab.locator('.selection-handle').nth(1).boundingBox();
      const destination = await tab.evaluate(() => { const e = PrefixType.editor, r = e.element.getBoundingClientRect(), p = e.point(11); return { x: r.x + p.x, y: r.y + p.y + 16 + e.lineHeight / 2 }; });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: handle.x + handle.width / 2, y: handle.y + 16 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [destination] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      assert.equal(await tab.evaluate(() => PrefixType.editor.selectionEnd), 11);
      assert(await tab.evaluate(() => document.querySelector('.topbar').scrollWidth <= innerWidth));
      await tab.screenshot({ path: 'test-results/mobile-selection.png' });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: 600 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 300, y: 250 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      assert(await tab.evaluate(() => PrefixType.editor.scroll) > 100);
      await tab.evaluate(async () => { PrefixType.reset('empty target'); PrefixType.editor.paint(); await navigator.clipboard.writeText('touch paste'); });
      const emptyPoint = await tab.evaluate(() => { const e = PrefixType.editor, r = e.element.getBoundingClientRect(), p = e.point(0); return { x: r.x + p.x, y: r.y + p.y + e.lineHeight / 2 }; });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [emptyPoint] });
      await tab.waitForTimeout(520);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await tab.locator('#selectionToolbar [data-action="paste"]').waitFor({ state: 'visible', timeout: 2000 });
      await tab.locator('#selectionToolbar [data-action="paste"]').click();
      await tab.waitForFunction(() => PrefixType.editor.value === 'touch paste');
      await mobile.close();
    });
    await reset('The quick brown fox 👋\ne\u0301 🇰🇷 العربية 中文'.repeat(5), 'The quick wrong');
    await page.screenshot({ path: 'test-results/desktop-editor.png' });
    assert.deepEqual(errors, []);
    fs.writeFileSync('test-results/browser.json', JSON.stringify({ browser: browser.version(), results }, null, 2));
    console.log('All browser checks passed:', results.length);
  } finally { await browser.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
