const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const serve = require('./server.cjs');
const ptbox = require('../ptbox.js');
const percentile = (array, p) => { const sorted = [...array].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) * p)]; };
(async () => {
  const server = await serve();
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--no-sandbox'] });
  const output = { browser: browser.version(), platform: process.platform + ' ' + process.arch,
    method: 'Per edit synchronous CPU, including input handler, queued animation callbacks and forced layout. GPU presentation and asynchronous IndexedDB commit excluded. 20 warmup / 100 measured edits. Same Chromium and viewport.', synthetic: [], traces: {} };
  try {
    for (const length of [1000, 10000, 50000, 200000]) {
      const result = { targetUTF16: length };
      for (const kind of ['original', 'canvas']) {
        const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
        const page = await context.newPage(); await page.goto(server.url + (kind === 'original' ? '/original.html' : '/PrefixType.html'));
        const target = 'The quick brown fox jumps over the lazy dog. '.repeat(Math.ceil(length / 44)).slice(0, length);
        const samples = await page.evaluate(async ({ target, kind }) => {
          const el = document.getElementById('typingInput');
          if (kind === 'original') {
            document.getElementById('customText').value = target; document.getElementById('applyText').click();
          } else { PrefixType.reset(target); PrefixType.editor.focus(); }
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const originalRAF = window.requestAnimationFrame, originalCancel = window.cancelAnimationFrame;
          const callbacks = new Map(); let id = 100000;
          window.requestAnimationFrame = callback => { callbacks.set(++id, callback); return id; };
          window.cancelAnimationFrame = id => callbacks.delete(id);
          const flush = () => {
            for (let n = 0; callbacks.size && n < 5; n++) {
              const batch = [...callbacks.values()]; callbacks.clear(); for (const callback of batch) callback(performance.now());
            }
            void document.body.offsetHeight;
          };
          const start = target.length - 250;
          const change = (p, d, i) => {
            if (kind === 'original') {
              el.value = el.value.slice(0, p) + i + el.value.slice(p + d); el.setSelectionRange(p + i.length, p + i.length);
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: i, inputType: 'insertText' }));
            } else PrefixType.editor.replace(p, d, i);
          };
          change(0, 0, target.slice(0, start)); flush();
          const values = [];
          for (let n = 0; n < 120; n++) {
            const begin = performance.now(); change(start + n, 0, target[start + n]); flush();
            if (n >= 20) values.push(performance.now() - begin);
          }
          window.requestAnimationFrame = originalRAF; window.cancelAnimationFrame = originalCancel;
          return values;
        }, { target, kind });
        result[kind] = { medianMs: percentile(samples, .5), p95Ms: percentile(samples, .95), meanMs: samples.reduce((a, b) => a + b, 0) / samples.length };
        await context.close();
      }
      result.medianSpeedup = result.original.medianMs / Math.max(.001, result.canvas.medianMs);
      output.synthetic.push(result); console.log(JSON.stringify(result));
    }
    // Replay every original event through the actual canvas editor in Chromium.
    // Render every 64 events plus the final state. This is a throughput/robustness
    // test, separate from the one-edit/one-frame measurements above.
    const context = await browser.newContext(); const page = await context.newPage();
    await page.goto(server.url);
    let eventCount = 0, sessionCount = 0, milliseconds = 0;
    for (const file of fs.readdirSync('traces').filter(f => f.endsWith('.ptbox')).sort()) {
      const record = ptbox.decode(fs.readFileSync('traces/' + file));
      let previous;
      const fragments = record.fragments.map(f => {
        const initial = ptbox.initialState(f, previous).text;
        let text = initial; for (const e of f.events) text = ptbox.apply(text, e);
        previous = { text, session: f.session };
        return { target: f.session.x, initial, events: f.events, final: text };
      });
      const replay = await page.evaluate(fragments => {
        // Isolated editor: exercise real EditContext synchronization, layout,
        // grapheme selection and rendering without generating duplicate records.
        const host = document.createElement('div'); host.style.cssText = 'position:fixed;inset:0;width:1000px;height:700px';
        host.innerHTML = '<canvas class="typing-input" tabindex="0"></canvas><textarea hidden></textarea><div></div>';
        document.body.append(host);
        const editor = new PrefixEditor.CanvasEditor(host.children[0], host.children[1], host.children[2]);
        let count = 0; const start = performance.now();
        for (const f of fragments) {
          editor.reset(f.target, f.initial);
          for (let i = 0; i < f.events.length; i++) {
            const e = f.events[i]; editor.replace(e.p, e.d, e.i, [e.s, e.e]);
            if (i % 64 === 0) editor.paint(); count++;
          }
          editor.paint();
          if (editor.value !== f.final || editor.editContext.text !== f.final) throw new Error('Trace replay diverged');
        }
        const ms = performance.now() - start;
        host.remove(); return { count, ms };
      }, fragments);
      eventCount += replay.count; sessionCount += fragments.length; milliseconds += replay.ms;
      console.log('REPLAY', file, replay.count, Math.round(replay.ms) + 'ms');
      // Release editors, observers and their cached layouts between trace files.
      await page.reload();
    }
    assert.equal(eventCount, 187436);
    output.traces = { files: 28, sessions: sessionCount, events: eventCount, milliseconds, eventsPerSecond: eventCount / milliseconds * 1000 };
    await context.close();
    fs.mkdirSync('test-results', { recursive: true });
    fs.writeFileSync('test-results/benchmark.json', JSON.stringify(output, null, 2));
    console.log(output.traces);
  } finally { await browser.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
