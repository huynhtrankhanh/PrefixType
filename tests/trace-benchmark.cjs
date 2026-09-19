const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const serve = require('./server.cjs');
const ptbox = require('../ptbox');
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
(async () => {
  const candidates = [];
  for (const file of fs.readdirSync('traces').filter(f => f.endsWith('.ptbox'))) {
    const record = ptbox.decode(fs.readFileSync('traces/' + file)); let previous;
    for (const f of record.fragments) {
      const initial = ptbox.initialState(f, previous).text;
      let text = initial; for (const e of f.events) text = ptbox.apply(text, e);
      previous = { text, session: f.session };
      if (f.events.length > 300) candidates.push({ file, target: f.session.x, initial, events: f.events });
    }
  }
  candidates.sort((a, b) => b.target.length - a.target.length);
  const chosen = [], files = new Set();
  for (const candidate of candidates) {
    if (files.has(candidate.file)) continue; files.add(candidate.file); chosen.push(candidate);
    if (chosen.length === 3) break;
  }
  const server = await serve(), browser = await chromium.launch({ channel: 'chromium', args: ['--no-sandbox'] });
  const results = [];
  try {
    for (const trace of chosen) {
      const offset = Math.floor(trace.events.length * .7); let initial = trace.initial;
      for (const event of trace.events.slice(0, offset)) initial = ptbox.apply(initial, event);
      const events = trace.events.slice(offset, offset + 120);
      let final = initial; for (const event of events) final = ptbox.apply(final, event);
      const row = { file: trace.file, targetUTF16: trace.target.length, initialUTF16: initial.length, firstEvent: offset, events: events.length };
      for (const mode of ['original', 'canvas']) {
        const context = await browser.newContext({ viewport: { width: 1100, height: 760 } }), page = await context.newPage();
        await page.goto(server.url + (mode === 'original' ? '/original.html' : '/PrefixType.html'));
        const result = await page.evaluate(async ({ mode, target, initial, events }) => {
          const input = document.getElementById('typingInput');
          if (mode === 'original') {
            document.getElementById('customText').value = target; document.getElementById('applyText').click();
            input.value = initial; input.setSelectionRange(initial.length, initial.length); input.dispatchEvent(new InputEvent('input'));
          } else { PrefixType.reset(target); PrefixType.editor.insert(initial); PrefixType.editor.focus(); }
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const raf = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
          const queue = new Map(); let id = 10000;
          window.requestAnimationFrame = fn => { queue.set(++id, fn); return id; }; window.cancelAnimationFrame = id => queue.delete(id);
          const timings = [];
          for (const [index, e] of events.entries()) {
            const start = performance.now();
            if (mode === 'original') {
              input.value = input.value.slice(0, e.p) + e.i + input.value.slice(e.p + e.d);
              input.setSelectionRange(e.s, e.e); input.dispatchEvent(new InputEvent('input', { bubbles: true, data: e.i }));
            } else PrefixType.editor.replace(e.p, e.d, e.i, [e.s, e.e]);
            for (let n = 0; n < 5 && queue.size; n++) {
              const jobs = [...queue.values()]; queue.clear(); for (const fn of jobs) fn(performance.now());
            }
            void document.body.offsetHeight;
            if (index >= 20) timings.push(performance.now() - start);
          }
          window.requestAnimationFrame = raf; window.cancelAnimationFrame = cancel;
          return { timings, final: mode === 'original' ? input.value : PrefixType.editor.value };
        }, { mode, target: trace.target, initial, events });
        assert.equal(result.final, final);
        row[mode] = { medianMs: median(result.timings), p95Ms: [...result.timings].sort((a, b) => a - b)[Math.floor(result.timings.length * .95)] };
        await context.close();
      }
      row.medianSpeedup = row.original.medianMs / Math.max(.001, row.canvas.medianMs);
      results.push(row); console.log(row);
    }
    fs.writeFileSync('test-results/trace-benchmark.json', JSON.stringify({ browser: browser.version(), results }, null, 2));
  } finally { await browser.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
