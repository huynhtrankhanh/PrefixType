// Run via npm run test:ime:native. Unlike CDP composition injection, IBus keeps
// a real preedit buffer outside the renderer, exposing incomplete IME resets.
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
    const state = () => page.evaluate(() => {
      const e = PrefixType.editor;
      return { text: e.value, start: e.selectionStart, end: e.selectionEnd,
        composing: e.composing, context: e.editContext.text, focused: e.hasFocus };
    });
    const reset = () => page.evaluate(() => {
      const e = PrefixType.editor;
      e.element.blur();
      PrefixType.reset('unused target');
      e.insert('before  after'); e.select(7); e.focus();
      window.imeUpdates = [];
      if (!window.imeTracing) {
        e.editContext.addEventListener('textupdate', event => window.imeUpdates.push(event.text));
        window.imeTracing = true;
      }
    });
    const type = async text => {
      const count = await page.evaluate(() => window.imeUpdates.length);
      execFileSync('xdotool', ['type', '--clearmodifiers', '--delay', '80', text]);
      await page.waitForFunction(count => window.imeUpdates.length >= count && PrefixType.editor.composing, count + text.length);
    };
    // Learn the IME's fresh result rather than depending on candidate ranking.
    await reset(); await type('ni');
    const fresh = await page.evaluate(() => window.imeUpdates.at(-1));
    assert(fresh.length > 0);
    execFileSync('xdotool', ['key', 'Escape']);
    await page.waitForFunction(() => !PrefixType.editor.composing);

    for (const key of ['ArrowLeft', 'ArrowRight', 'Control+ArrowLeft', 'Control+ArrowRight',
      'Shift+ArrowLeft', 'Shift+ArrowRight', 'Control+Shift+ArrowLeft', 'Control+Shift+ArrowRight']) {
      await reset(); await type('nihao');
      const before = await state();
      assert.equal(before.composing, true);
      // Inject the editor command while the OS still owns a live composition.
      // Physical arrows may be consumed by Pinyin for candidate navigation.
      await page.keyboard.press(key);
      const moved = await state();
      assert.equal(moved.text, before.text, `${key}: draft preserved`);
      assert.equal(moved.composing, false, `${key}: composition ended`);
      assert.equal(moved.focused, true, `${key}: focus restored`);
      await type('ni');
      const expected = moved.text.slice(0, moved.start) + fresh + moved.text.slice(moved.end);
      assert.equal((await state()).text, expected, `${key}: old preedit must not be inserted again`);
      assert.equal((await state()).context, expected);
      // Commit via the actual IME, then verify the two compositions are separate
      // undo groups and that replacement selections are restored by undo.
      execFileSync('xdotool', ['key', 'space']);
      await page.waitForFunction(() => !PrefixType.editor.composing);
      assert.equal((await state()).text, expected);
      await page.keyboard.press('Control+z');
      assert.equal((await state()).text, before.text);
      await page.keyboard.press('Control+z');
      assert.equal((await state()).text, 'before  after');
      await page.keyboard.press('Control+Shift+z');
      await page.keyboard.press('Control+Shift+z');
      assert.equal((await state()).text, expected);
      console.log('PASS live IBus composition, navigation, continued typing, commit, undo/redo:', key);
    }
    assert.deepEqual(errors, []);
    console.log('Chromium', browser.version());
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
