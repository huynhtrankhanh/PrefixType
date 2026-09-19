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
        editor.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }));
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
      await page.keyboard.press('Enter');
      assert.equal(await value(), '日本');
      await cdp.send('Input.insertText', { text: '日本' });
      await page.keyboard.press('Enter'); assert.equal(await value(), '日本\n');
      await page.keyboard.press('Shift+Enter'); assert.equal(await value(), '日本\n\n');
      await page.evaluate(() => PrefixType.editor.select(2, 4));
      await page.keyboard.press('Enter'); assert.equal(await value(), '日本\n');
      await page.keyboard.press('Control+z'); assert.equal(await value(), '日本\n\n');
      assert.equal(await page.evaluate(() => PrefixType.editor.editContext.text), await value());
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
    assert.deepEqual(errors, []);
    assert.deepEqual(failures, []);
  } finally { await browser.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
