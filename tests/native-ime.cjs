// Run via npm run test:ime:native. Unlike CDP composition injection, IBus keeps
// a real preedit buffer outside the renderer. Compare against a native textarea
// rather than assuming an arrow must commit the OS-owned composition.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const serve = require('./server.cjs');

(async () => {
  const server = await serve();
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chromium', headless: false,
      args: ['--no-sandbox', '--ozone-platform=x11'],
      env: { ...process.env, GTK_IM_MODULE: 'ibus', XMODIFIERS: '@im=ibus' } });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.url);
    const windows = execFileSync('xdotool', ['search', '--onlyvisible', '--class', 'chromium'])
      .toString().trim().split('\n');
    execFileSync('xdotool', ['windowfocus', windows.at(-1)]);
    await page.evaluate(() => {
      const e = PrefixType.editor;
      for (const input of [e.editContext, e.nativeInput]) {
        input.addEventListener('compositionstart', () => window.imeComposing = true);
        input.addEventListener('compositionend', () => window.imeComposing = false);
        input.addEventListener(input === e.editContext ? 'textupdate' : 'input', () => window.imeUpdates++);
      }
      e.element.addEventListener('blur', () => window.imeBlurs++);
      e.nativeInput.addEventListener('blur', () => window.imeBlurs++);
    });
    const state = () => page.evaluate(() => {
      const e = PrefixType.editor;
      if (!e.nativeMode && e.editContext.text !== e.value) throw new Error('EditContext divergence');
      return { text: e.value,
        start: e.nativeMode ? e.nativeInput.selectionStart : e.selectionStart,
        end: e.nativeMode ? e.nativeInput.selectionEnd : e.selectionEnd,
        composing: window.imeComposing, focused: e.hasFocus };
    });
    const reset = native => page.evaluate(native => {
      const e = PrefixType.editor;
      document.activeElement.blur();
      PrefixType.reset('unused target'); e.setNativeMode(native);
      e.insert('before  after'); e.select(7);
      if (native) e.nativeInput.setSelectionRange(7, 7);
      e.focus();
      window.imeUpdates = 0; window.imeBlurs = 0; window.imeComposing = false;
    }, native);
    const type = async text => {
      const count = await page.evaluate(() => window.imeUpdates);
      execFileSync('xdotool', ['type', '--clearmodifiers', '--delay', '80', text]);
      await page.waitForFunction(count => window.imeUpdates >= count && window.imeComposing, count + text.length);
    };
    const commit = async () => {
      execFileSync('xdotool', ['key', 'space']);
      await page.waitForFunction(() => !window.imeComposing);
    };
    for (const key of ['ArrowLeft', 'ArrowRight', 'Control+ArrowLeft', 'Control+ArrowRight',
      'Shift+ArrowLeft', 'Shift+ArrowRight', 'Control+Shift+ArrowLeft', 'Control+Shift+ArrowRight']) {
      const run = async native => {
        await reset(native); await type('nihao');
        const before = await state();
        // Physical arrows may be consumed by Pinyin for candidate navigation.
        // Inject the same editing command into each host while IBus owns preedit.
        await page.keyboard.press(key);
        const moved = await state();
        assert.equal(moved.text, before.text, `${key}: draft preserved`);
        assert.equal(moved.composing, true, `${key}: IME still owns composition`);
        assert.equal(moved.focused, true);
        assert.equal(await page.evaluate(() => window.imeBlurs), 0);
        await type('ni');
        const continued = await state();
        await commit();
        const committed = await state();
        assert.equal(committed.text, continued.text);
        // After a real IME commit, further typing starts a separate group at
        // the moved caret. This distinguishes a resend from fresh input.
        await page.keyboard.press('ArrowLeft');
        await type('ni'); await commit();
        const next = await state();
        if (!native) {
          await page.keyboard.press('Control+z');
          assert.equal((await state()).text, committed.text);
          await page.keyboard.press('Control+z');
          assert.equal((await state()).text, 'before  after');
          await page.keyboard.press('Control+Shift+z');
          await page.keyboard.press('Control+Shift+z');
          assert.equal((await state()).text, next.text);
        }
        return { before, moved, continued, committed, next };
      };
      const expected = await run(true);
      assert.deepEqual(await run(false), expected, key);
      console.log('PASS live IBus navigation, continued composition and commit match native textarea:', key);
    }
    assert.deepEqual(errors, []);
    console.log('Chromium', browser.version());
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
