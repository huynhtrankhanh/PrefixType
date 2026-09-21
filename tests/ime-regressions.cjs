// Synthetic text only. This suite never opens or downloads trace files.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const serve = require('./server.cjs');
(async () => {
  const server = await serve();
  const browser = await chromium.launch({ channel: 'chromium', args: ['--no-sandbox'] });
  const failures = [];
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.url);
    const cdp = await page.context().newCDPSession(page);
    const reset = () => page.evaluate(() => {
      PrefixType.reset('日本\nnext\nmore'); PrefixType.editor.focus(); PrefixType.editor.paint();
    });
    const value = () => page.evaluate(() => PrefixType.editor.value);
    async function check(name, fn) {
      try { await reset(); await fn(); console.log('PASS', name); }
      catch (error) { failures.push(name); console.error('FAIL', name, error.message); }
      finally { await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }); }
    }
    await check('Enter is a browser line-break intent, including keyboard-free IME input', async () => {
      await page.evaluate(() => {
        const editor = PrefixType.editor;
        editor.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true }));
        editor.element.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true }));
      });
      assert.equal(await value(), '\n');
      await page.evaluate(() => PrefixType.editor.element.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertLineBreak', bubbles: true, cancelable: true
      })));
      assert.equal(await value(), '\n\n');
      await page.keyboard.press('Control+z'); assert.equal(await value(), '\n');
      await page.keyboard.press('Control+z'); assert.equal(await value(), '');
    });
    await check('composition confirmation does not insert Enter; subsequent Enter inserts exactly once', async () => {
      await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
      await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
      assert.equal(await value(), '日本');
      await cdp.send('Input.insertText', { text: '日本' });
      await page.keyboard.press('Enter'); assert.equal(await value(), '日本\n');
      await page.keyboard.press('Shift+Enter'); assert.equal(await value(), '日本\n\n');
      await page.evaluate(() => PrefixType.editor.select(2, 4));
      await page.keyboard.press('Enter'); assert.equal(await value(), '日本\n');
      await page.keyboard.press('Control+z'); assert.equal(await value(), '日本\n\n');
      assert.equal(await page.evaluate(() => PrefixType.editor.editContext.text), await value());
    });
    const compose = (text, caret = text.length) => cdp.send('Input.imeSetComposition', {
      text, selectionStart: caret, selectionEnd: caret
    });
    const state = () => page.evaluate(() => {
      const e = PrefixType.editor;
      return { text: e.value, anchor: e.model.anchor, focus: e.model.focus,
        composing: e.composing, context: e.editContext.text, focused: e.hasFocus };
    });
    await check('Enter resets platform focus and inserts once without clearing pixels', async () => {
      await compose('日本');
      await page.evaluate(() => {
        const e = PrefixType.editor; e.paint(); window.editorBlurs = 0;
        e.element.addEventListener('blur', () => window.editorBlurs++);
      });
      await page.keyboard.press('Enter');
      assert.deepEqual(await state(), { text: '日本\n', anchor: 3, focus: 3,
        composing: false, context: '日本\n', focused: true });
      assert.deepEqual(await page.evaluate(() => {
        const e = PrefixType.editor;
        return [window.editorBlurs, e.ctx.getImageData(0, 0, e.element.width, e.element.height).data.some((v, i) => i % 4 === 3 && v)];
      }), [1, true]);
      await compose('語');
      assert.equal(await value(), '日本\n語');
    });
    for (const key of ['ArrowLeft', 'ArrowRight', 'Control+ArrowLeft', 'Control+ArrowRight',
      'Control+Shift+ArrowLeft', 'Control+Shift+ArrowRight', 'Shift+ArrowLeft', 'Shift+ArrowRight',
      'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Backspace', 'Delete', 'Control+z']) {
      await check(`active composition executes ${key} like committed text`, async () => {
        const text = 'first line\n日本 words';
        await compose(text, 14);
        await cdp.send('Input.insertText', { text });
        await page.evaluate(() => PrefixType.editor.select(14));
        await page.keyboard.press(key);
        const expected = await state();
        await reset();
        await compose(text, 14);
        await page.keyboard.press(key);
        assert.deepEqual(await state(), expected);
        const start = Math.min(expected.anchor, expected.focus), end = Math.max(expected.anchor, expected.focus);
        await compose('語');
        assert.equal(await value(), expected.text.slice(0, start) + '語' + expected.text.slice(end));
      });
    }
    await check('named composing keys act; unknown IME keys retain the draft', async () => {
      await compose('日本');
      for (const key of ['Process', 'Unidentified', 'a']) {
        assert.equal(await page.evaluate(key => PrefixType.editor.element.dispatchEvent(new KeyboardEvent('keydown', {
          key, keyCode: 229, isComposing: true, bubbles: true, cancelable: true
        })), key), true);
        assert.equal((await state()).composing, true);
      }
      assert.equal(await page.evaluate(() => PrefixType.editor.element.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true
      }))), false);
      assert.equal(await value(), '日本\n');
      assert.equal((await state()).composing, false);
    });
    await check('software newline commits composition before insertion', async () => {
      await compose('日本');
      await page.evaluate(() => PrefixType.editor.element.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertParagraph', isComposing: true, bubbles: true, cancelable: true
      })));
      assert.equal(await value(), '日本\n');
      assert.equal((await state()).composing, false);
    });
    await check('selection and reset discard stale native composition ranges', async () => {
      await compose('日本');
      await page.evaluate(() => PrefixType.editor.select(1));
      await compose('語');
      assert.equal(await value(), '日語本');
      await reset();
      await compose('new');
      assert.equal(await value(), 'new');
    });
    await check('matching draft completes immediately and Enter preserves terminal completion', async () => {
      await page.evaluate(() => { PrefixType.reset('日本'); PrefixType.editor.focus(); });
      await compose('日本');
      assert.equal(await page.evaluate(() => PrefixType.stats.finished), true);
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => PrefixType.stats.finished), true);
      await page.keyboard.press('Backspace');
      assert.equal(await page.evaluate(() => PrefixType.stats.finished), true);
    });
    await check('repeated geometry notifications never clear the painted composition', async () => {
      await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
      const result = await page.evaluate(async () => {
        const e = PrefixType.editor; e.paint();
        const pixels = () => e.ctx.getImageData(0, 0, e.element.width, e.element.height).data.some((v, i) => i % 4 === 3 && v);
        let blanks = 0, mutations = 0;
        const observer = new MutationObserver(records => mutations += records.length);
        observer.observe(e.element, { attributes: true, attributeFilter: ['width', 'height'] });
        for (let i = 0; i < 8; i++) { e.resize(); if (!pixels()) blanks++; }
        await new Promise(resolve => requestAnimationFrame(resolve));
        observer.disconnect();
        return { blanks, mutations, painted: pixels(), composing: e.composing };
      });
      assert.deepEqual(result, { blanks: 0, mutations: 0, painted: true, composing: true });
      await cdp.send('Input.insertText', { text: '日本' });
    });
    await check('real resize and line-height changes paint atomically during composition', async () => {
      await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
      const result = await page.evaluate(async () => {
        const e = PrefixType.editor; e.paint();
        const pixels = () => e.ctx.getImageData(0, 0, e.element.width, e.element.height).data.some((v, i) => i % 4 === 3 && v);
        const oldWidth = e.element.width;
        e.element.parentElement.style.width = '550px'; e.resize();
        const beforePaint = { width: e.element.width, painted: pixels() };
        await new Promise(resolve => requestAnimationFrame(resolve));
        const afterPaint = { width: e.element.width, painted: pixels() };
        const beforeY = e.point(e.value.length + 1).y;
        e.element.style.lineHeight = '60px'; e.resize(); e.paint();
        return { oldWidth, beforePaint, afterPaint, lineHeight: e.lineHeight, beforeY, afterY: e.point(e.value.length + 1).y,
          text: e.value, context: e.editContext.text };
      });
      assert.equal(result.beforePaint.width, result.oldWidth);
      assert(result.beforePaint.painted && result.afterPaint.painted);
      assert.equal(result.afterPaint.width, 550);
      assert.equal(result.lineHeight, 60);
      assert(result.afterY > result.beforeY);
      assert.equal(result.text, '日本'); assert.equal(result.context, '日本');
      await cdp.send('Input.insertText', { text: '日本' });
    });
    // Android platform selection, using real Chromium textarea composition.
    // CDP supplies the setComposingText-style resend V7 makes when selection
    // changes; it does not simulate an Android InputConnection or OS keyboard.
    const android = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/145.0.0.0 Mobile Safari/537.36',
      viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true
    });
    try {
      const tab = await android.newPage();
      tab.on('pageerror', error => errors.push(error.message));
      await tab.goto(server.url);
      const ime = await android.newCDPSession(tab);
      const androidState = () => tab.evaluate(() => {
        const e = PrefixType.editor, n = e.nativeInput;
        return { text: e.value, start: e.selectionStart, end: e.selectionEnd,
          native: n.value, nativeStart: n.selectionStart, nativeEnd: n.selectionEnd };
      });
      for (const key of ['ArrowLeft', 'ArrowRight', 'Shift+ArrowLeft', 'Control+ArrowLeft']) {
        const run = async native => {
          await tab.evaluate(native => {
            const e = PrefixType.editor;
            PrefixType.reset('unused target'); e.setNativeMode(native);
            e.insert('before  after'); e.select(7); e.focus();
            window.androidBlurs = 0;
            e.nativeInput.onblur = () => window.androidBlurs++;
          }, native);
          await ime.send('Input.imeSetComposition', { text: 'tiếng', selectionStart: 5, selectionEnd: 5 });
          await tab.keyboard.press(key);
          await tab.waitForFunction(() => {
            const e = PrefixType.editor;
            return e.selectionStart === e.nativeInput.selectionStart && e.selectionEnd === e.nativeInput.selectionEnd;
          });
          const moved = await androidState();
          // Resending the whole Telex preedit must replace its existing range,
          // including when it is surrounded by other text.
          await ime.send('Input.imeSetComposition', { text: 'tiếng', selectionStart: 5, selectionEnd: 5 });
          await ime.send('Input.insertText', { text: 'tiếng' });
          const committed = await androidState();
          assert.equal(committed.text, 'before tiếng after');
          assert.equal(committed.native, committed.text);
          assert.equal(await tab.evaluate(() => window.androidBlurs), 0);
          await tab.keyboard.press('ArrowLeft');
          await ime.send('Input.imeSetComposition', { text: 'á', selectionStart: 1, selectionEnd: 1 });
          await ime.send('Input.insertText', { text: 'á' });
          const continued = await androidState();
          assert.equal(continued.text, 'before tiếnág after');
          await tab.keyboard.press('Control+z');
          assert.equal((await androidState()).text, 'before tiếng after');
          return { moved, committed, continued };
        };
        assert.deepEqual(await run(false), await run(true), key);
        console.log('PASS Android textarea-backed canvas matches native Telex resend:', key);
      }
      await tab.evaluate(() => {
        const e = PrefixType.editor;
        e.setNativeMode(false); PrefixType.reset('tiếng'); e.focus();
      });
      await ime.send('Input.imeSetComposition', { text: 'tiếng', selectionStart: 5, selectionEnd: 5 });
      assert.equal(await tab.evaluate(() => PrefixType.stats.finished), true);
      assert.deepEqual(await tab.evaluate(() => {
        const e = PrefixType.editor; e.paint();
        return [e.nativeMode, e.element.hidden, e.hasFocus,
          e.ctx.getImageData(0, 0, e.element.width, e.element.height).data.some((v, i) => i % 4 === 3 && v)];
      }), [false, false, true, true]);
      await ime.send('Input.insertText', { text: 'tiếng' });
      await tab.keyboard.press('Enter');
      assert.equal((await androidState()).text, 'tiếng\n');
      assert.equal(await tab.evaluate(() => PrefixType.stats.finished), true);
      console.log('PASS Android canvas retains highlighting, draft completion and native Enter');
    } finally { await android.close(); }
    assert.deepEqual(errors, []);
    assert.deepEqual(failures, []);
  } finally { await browser.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
