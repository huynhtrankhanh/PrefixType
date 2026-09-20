# PrefixType

PrefixType is a local typing practice app with a canvas editor, EditContext input, Unicode-aware selection, and downloadable daily typing records. The practice-text entry field remains a normal textarea. All runtime assets are included; the app needs no build step or backend.

## Run

Serve this directory and open `http://localhost:8000/PrefixType.html`:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Use a browser with `EditContext` for the canvas editor. Browsers without it automatically use a native textarea. **Native input** also lets you switch to a textarea for assistive technology or native platform editing. Clipboard access requires a browser context that allows it, such as localhost or HTTPS.

Choose **Practice text**, paste your text, and select **Use text**. **Restart** clears the current attempt. **Records** shows daily accumulated time and downloads `.ptbox` files. Practice text, typed text, and records are processed locally. The app makes no network requests.

## Editing behavior

The canvas displays the longest correct prefix in green, mistakes in red with a red background, and the remaining practice text in gray. Mistakes occupy space and push the remaining text forward. The next expected grapheme is underlined. Input is not capped at the target's length, so mistakes and pasted text can be edited normally.

| Action | Controls |
| --- | --- |
| Move the caret | Left/Right by grapheme; Up/Down by visual line |
| Extend selection | Shift with any movement key |
| Move/select by word | Ctrl+Left/Right; Ctrl+Shift+Left/Right; Option on macOS |
| Line/document edges | Home/End; Ctrl+Home/End; Command+Left/Right and Command+Up/Down on macOS |
| Move by page | PageUp/PageDown, optionally with Shift |
| Select all | Ctrl+A or Command+A |
| Copy, cut, paste | Ctrl/Command+C, X, V; clipboard events; touch selection menu |
| Delete | Backspace/Delete by grapheme; Ctrl/Option by word |
| New line | Enter |
| Undo/redo | Ctrl/Command+Z; Ctrl/Command+Shift+Z; Ctrl+Y |
| Mouse selection | Click, Shift+click, drag, double-click a word, triple-click a visual line |
| Touch selection | Tap for a caret, long press for a word, drag either selection handle |
| Scroll | Mouse wheel, touch swipe, or edge scrolling while dragging a selection |

Tab retains normal browser focus navigation. A complete IME composition is one undo group. Other edits are individual undo steps, with up to 1,000 groups retained.

On touch screens, selection handles use 44-pixel touch targets. Long press opens the Copy/Cut/Paste/Select all menu; an insertion selection offers Paste. The editor follows visual-viewport changes when the software keyboard appears. These controls approximate Android Chrome's behavior using application-drawn handles and menus.

### Completion and session boundaries

Completion happens as soon as the current input exactly equals the practice text, including an active IME composition. It stops the timer and recorder and shows **Complete**. Further edits do **not** change that completed attempt's statistics or append events to its record. **Restart** or **Use text** begins another attempt. The matching IME update is recorded before the session closes; subsequent composition updates, cancellation, confirmation, and editing commands leave that completed attempt unchanged.

A `pagehide` ends the recording session, but a restored editor can retain its text. Its next edit starts a new session with an explicit `previousSessionId` pointing to the session closed by pagehide. The new session also stores `initialText`, so its deltas can replay independently. Repeated pagehide events without an intervening edit do not create empty sessions. Restarting or changing the practice text clears the pending link; independent attempts have `previousSessionId: null`.

Crossing midnight does **not** start a new session. Daily exports clip that session into fragments with the **same session ID**, which is sufficient to correlate them. No predecessor link is added for a day boundary. A continued session's existing predecessor ID stays the same in each of its daily fragments. Legacy records lacking linkage metadata remain readable using the older inference rule.

Accuracy counts inserted graphemes, including replacements of the same length. Deletions do not increase the insertion count. WPM and progress retain the original UTF-16 length convention: WPM uses five code units per word, and progress uses correct-prefix code units divided by target length. Elapsed practice time uses the monotonic performance clock; record timestamps use Unix milliseconds.

## Unicode and IME

`Intl.Segmenter` supplies grapheme and word boundaries. Arrow movement, deletion, mouse selection, and touch selection keep surrogate pairs, combining sequences, emoji modifiers, flags, and ZWJ emoji together. Unicode normalization is deliberately not applied: composed and decomposed spellings must match the supplied target exactly. Pasted CRLF and CR line endings become LF.

EditContext replacement ranges and all stored offsets remain **UTF-16 code-unit offsets**. IME replacements may temporarily fall inside a grapheme or surrogate pair; those edits are preserved exactly. User navigation then uses grapheme boundaries. The renderer keeps the mistake/expected-text boundary separate so a trailing ZWJ in a mistake cannot absorb an expected glyph.

The editor handles `textupdate`, composition start/end, IME formatting, control/selection bounds, and character-bound requests. Recognized editing commands commit the displayed IME draft, then perform their normal action: Enter/Shift+Enter insert a newline, arrows and word-selection shortcuts move or extend selection, and deletion and undo act immediately. Named commands remain actionable when the event carries `isComposing` or key code 229; unrecognized IME/Process events remain available to the input method. Enter keydown is canceled to prevent duplicate browser insertion. Software keyboards can also request a newline through `beforeinput`'s `insertLineBreak`/`insertParagraph`, including during composition. An IME text commit without a newline command adds no newline.

Moving EditContext selection alone leaves Chromium's composition range active. Detaching and reattaching the context clears that range, but can leave the operating system's IME preedit buffer alive, so continued typing duplicates the old draft. Before a command, the editor briefly blurs and synchronously refocuses the canvas with `preventScroll`: this commits the displayed draft and tells Chromium to reset the platform IME before updating text/selection. Focus is restored before the command returns, and the painted canvas is retained. Pointer selection, programmatic edits, and reset use the same mechanism; an inactive editor does not take focus. Completion does not wait for composition confirmation or an editing command: an exact draft match immediately ends the attempt. This behavior is verified with both Chromium's CDP composition API and a live Linux IBus/Pinyin engine under Xvfb; mobile software keyboard visibility still requires device testing. Both halves of a surrogate pair receive the same character rectangle. Canvas draws complete directional runs to preserve shaping, with clipped colors and selection backgrounds. The included `bidi-js` library supplies embedding levels and run ordering.

## Implementation and performance

| File | Responsibility |
| --- | --- |
| `PrefixType.html` | App structure and styles; canvas, touch controls, and textareas |
| `editor.js` | Text model, EditContext, editing commands, canvas layout, rendering, and interaction |
| `app.js` | Practice lifecycle, statistics, IndexedDB recording, daily records, and downloads |
| `ptbox.js` | Binary encoder/decoder, strict range validation, and trace auditing |
| `vendor/bidi.js` | Vendored `bidi-js` 1.0.3; license in `vendor/bidi-LICENSE.txt` |
| `scripts/` | Trace download and validation tools |
| `tests/` | Model fuzzing, real-browser checks, replay, and benchmarks |
| `tests/fixtures/PrefixType-original.html` | Unmodified original app used as the benchmark/reference baseline |
| `tests/fixtures/trace-manifest.json` | Download names, Drive IDs, sizes, and pinned SHA-256 hashes |

The canvas path consumes exact EditContext deltas instead of comparing two whole textarea values. Prefix matching resumes at the earliest changed position. Correct appends and suffix deletions can reuse the displayed layout entirely. Other edits invalidate layout from one visual line before the change. Grapheme iteration and line layout proceed only as far as the viewport or requested caret position, and painting visits visible lines. Glyph-width caching is bounded, and paints are coalesced with `requestAnimationFrame`. Canvas bitmap dimensions change only inside the paint callback, immediately before redrawing, and only if their pixel dimensions changed. Repeated geometry notifications therefore preserve the existing picture instead of clearing it between frames. Width, font, line height, padding, and pixel-ratio changes are tracked; one observer watches the containing editor area.

This removes the per-input mirror/probe DOM reconstruction. Text is still held in JavaScript strings: a large replacement, a distant caret jump, selecting a large document, or a resize can require substantial string/layout work. The native textarea mode uses a full-value diff because it does not receive EditContext deltas.

### Measurements

The following historical measurements precede the IME and session-linkage fixes; the revoked trace corpus was not accessed or replayed for those fixes. Measured in real headless Chromium **145.0.7632.6**, Linux x64, with a 1100 × 760 viewport. The baseline fixture's SHA-256 is `2c686ea5161bcbe10dc72dea4870031786e35895740478eebe9e9f53c357fcd6`.

The synthetic benchmark types near the end of each target, warms up for 20 edits, then measures 100 edits. Each sample includes the input handler, queued animation callbacks, and forced DOM layout. It measures synchronous CPU work, including canvas drawing commands; asynchronous IndexedDB commits, GPU presentation, and display latency are excluded.

| Target UTF-16 units | Original median / p95 | Canvas median / p95 | Median speedup |
| ---: | ---: | ---: | ---: |
| 1,000 | 0.70 / 1.20 ms | 0.60 / 1.10 ms | 1.2× |
| 10,000 | 3.80 / 5.40 ms | 0.50 / 1.40 ms | 7.6× |
| 50,000 | 21.50 / 24.40 ms | 0.70 / 1.90 ms | 30.7× |
| 200,000 | 95.00 / 115.50 ms | 0.90 / 1.90 ms | 105.6× |

The same method also replays 120 consecutive events from each of three supplied trace sessions, discarding the first 20 timings. Both implementations must produce the exact expected final text.

| Trace file | Target units | Original median / p95 | Canvas median / p95 | Median speedup |
| --- | ---: | ---: | ---: | ---: |
| `PrefixType-2026-09-17.ptbox` | 43,321 | 8.40 / 14.50 ms | 0.30 / 1.30 ms | 28.0× |
| `PrefixType-2026-09-12.ptbox` | 34,403 | 7.20 / 13.50 ms | 0.40 / 1.40 ms | 18.0× |
| `PrefixType-2026-09-02.ptbox` | 33,126 | 8.80 / 11.90 ms | 0.30 / 1.10 ms | 29.3× |

Separately, the canvas editor replayed all **187,436 events** across **203 session fragments** in **28 files**, with EditContext synchronization and a paint every 64 events plus every final state. That run took **33.41 seconds**, about **5,610 events/second**. This is a batched replay throughput result, not interactive latency. The corpus includes overlapping exports; fragment totals are not a count of unique attempts. Timings vary with hardware and system load.

## Database and trace format

The existing IndexedDB database remains `prefixtype-blackbox`, schema version **1**. Existing records remain readable.

| Store | Fields |
| --- | --- |
| `sessions`, key `id` | `a`: start; `z`: end or null; `c`: checkpoint; `r`: end reason; `x`: practice text; `q`: time zone; `o`: UTC offset minutes; optional `owner`: live-tab identity; `previousSessionId`: pagehide predecessor or null; `initialText`: session starting text |
| `events`, auto-increment key `k` | `sid`: session ID; `t`: timestamp; `p`: replacement offset; `d`: deleted code units; `i`: inserted string; `s`, `e`: resulting selection start/end |

Session metadata and its deltas are written in the same transaction. Writes queued together are batched, and daily exports read sessions and events in one consistent transaction. Checkpoints occur every five seconds. Interrupted sessions recover to their last checkpoint. Where Web Locks are available, recovery skips sessions owned by a live tab; the tab releases its lock on pagehide and reacquires it on restoration. Storage failures are reported and prevent a misleading successful export.

Daily records use browser-local midnight boundaries, including 23- or 25-hour DST days. Today's export ends at its snapshot time. A fragment includes edits in that day window and its state reconstructed from `initialText` plus earlier edits. Day windows are half-open: an edit exactly at midnight belongs only to the next day's file, retaining the same session ID. Session reasons remain `completed`, `restarted`, `practice-text-changed`, `pagehide`, and `recovered`.

### PTBOX encoding

The binary codec is available as `window.Ptbox` in the browser and `require('./ptbox.js')` in Node.

All timestamps are little-endian Float64 Unix epoch milliseconds. Integers are unsigned LEB128-style varints, bounded to JavaScript safe integers. Each string starts with its **byte** length.

- **Version 1:** strings use UTF-8, preserving compatibility with the supplied files and existing readers.
- **Version 2:** strings use UTF-16LE, preserving unpaired surrogates that UTF-8/TextEncoder would replace with U+FFFD. Other fields match v1.
- **Version 3:** current app exports use UTF-16LE and add explicit session linkage after each session ID. Fragment initial text makes new continuation sessions independently replayable. Readers limited to v1/v2 must add v3 support.

The decoder accepts all three versions. The codec preserves the version of decoded legacy records unless linkage is added; it refuses to export explicit linkage as v1/v2 rather than silently discarding it. Old sessions mixed into a v3 export retain an explicit "linkage unknown" tag, so no predecessor is fabricated.

Header field order:

1. Five ASCII bytes `PTBOX`, then one version byte.
2. Export timestamp; local day string (`YYYY-MM-DD`); time-zone string.
3. Day start, record end, accumulated milliseconds, fragment count.

For each fragment:

1. Session ID; **v3 only:** one linkage byte (`0`: legacy/unknown, `1`: independent session, `2`: continuation). For tag `2`, a nonempty predecessor-ID string follows. Then original start and original end (`NaN` while open).
2. Clipped fragment start/end; end reason; session time zone; offset minutes.
3. Practice text; initial fragment text; delta count.
4. For each delta: timestamp, replacement offset, deletion count, inserted string, selection start, selection end.

Apply a delta to a JavaScript string as:

```js
value = value.slice(0, event.p) + event.i + value.slice(event.p + event.d);
```

New v3 session fragments replay directly from `fragment.initialValue`; use `session.previousSessionId` for linkage, even when the predecessor is in a different file. `Ptbox.initialState(fragment, previous)` retains inference for legacy records only; explicit linkage never depends on file ordering. The validator checks signatures, versions, truncation, varint overflow, UTF encoding, trailing bytes, edit/selection ranges, event ordering, fragment intervals, accumulated durations, completed text, invalid/cyclic predecessor links, and predecessor/initial-text agreement when both complete fragments are available. A trace is a sequence of text changes; it does not contain raw key, pointer, or OS candidate-window events.

## Tests and reproduction

Node.js 22 and Python 3 were used for development. Install the pinned test dependencies and Chromium:

```sh
npm ci
npx playwright install --with-deps chromium
npm test
npm run test:ime
npm run test:browser
```

On the Ubuntu 26.04 sandbox used for these measurements, Playwright 1.58.2 did not recognize the OS. Its Ubuntu 24.04 browser/dependency package was installed using:

```sh
PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 npx playwright install --with-deps chromium
```

To test an actual OS IME buffer (which CDP composition injection does not maintain), install the Linux dependencies and run:

```sh
sudo apt-get install ibus ibus-libpinyin libglib2.0-bin dbus-x11 xvfb xauth xdotool
npm run test:ime:native
```

This suite runs headed Chromium in Xvfb with an isolated D-Bus/IBus session. X11 typing creates real Pinyin compositions; Playwright injects navigation commands so the editor receives them even when Pinyin would consume a physical arrow for candidate navigation. Eight cases cover Left/Right with no modifier, Shift, Ctrl, and Ctrl+Shift, followed by more native IME typing, native confirmation, and undo/redo. They catch the duplicated preedit that the old detach/reattach implementation produced. Candidate ranking is learned from a fresh composition rather than hard-coded.

Normal tests use synthetic text and records and do not access trace files or the network. The historical corpus replay in the unit suite is now opt-in (`PREFIXTYPE_TRACE_TESTS=1 npm test`). `npm run test:traces` and `npm run benchmark` also require a separately authorized corpus; they are not part of the regression verification.

Earlier validation used 28 supplied files totaling **7,467,919 bytes**, compared with pinned hashes. Those files round-tripped byte for byte, with legacy continuation inferred from prior session state. These are historical results; the revoked corpus was not reopened for the current changes.

The checked suite covers:

- 20,000 deterministic Unicode mutations against an independent whole-string reference.
- Grapheme movement/deletion; UTF-8 and lossless UTF-16 round trips; every truncated prefix of a fixture; 5,000 malformed binary cases.
- Historical validation of every supplied trace delta through the text model and real Chromium canvas editor; this check is skipped unless explicitly enabled.
- 1,200 browser mutations comparing incremental canvas layout with a fresh layout, plus long lines, resize, and Unicode rendering seams.
- Native Chromium textarea comparisons for keyboard movement and Shift/Ctrl selection.
- Real clipboard commands, mouse selection, undo/redo, and CDP-driven IME composition, commit, cancellation, and character bounds.
- Mobile-emulated long press, selection handles, dragging, scrolling, menu visibility, and paste into an empty editor.
- IndexedDB replay/export, replacement statistics, terminal completion, pagehide continuation, concurrent tabs, interrupted-session recovery, midnight/DST clipping, and native fallback.

The main browser suite contains **14 test groups**, including explicit pagehide linkage and shared IDs across daily exports. A separate IME regression suite contains **26 checks** for keyboard-free newline intents, native confirmation, commands during active composition (including arrows, Ctrl+arrows, Ctrl+Shift+arrows, deletion, and undo), composing/key-code-229 events, subsequent IME replacement ranges, selection/reset, completion timing, focus retention, repeated geometry notifications, and atomic resize/line-height changes. Seven synthetic codec tests cover v3 linkage, legacy compatibility, lone surrogates, standalone continuation replay, midnight fragments, cycles, malformed linkage tags, and truncation. These checks pass in Chromium 145.0.7632.6 without the trace corpus. Generated reports and screenshots go to ignored `test-results/`: `trace-audit.json`, `browser.json`, `benchmark.json`, `trace-benchmark.json`, `desktop-editor.png`, and `mobile-selection.png`. The test server uses a random local port and the preserved original fixture, so future commits do not change the benchmark baseline.

### Practical limits

Desktop Chromium, Linux IBus/Pinyin under Xvfb, and Chromium mobile emulation were tested. Physical Android devices, Gboard/vendor keyboards, iOS, macOS shortcut behavior, and screen readers were not directly tested. Mobile emulation cannot validate a real software keyboard or OS IME candidate window. Use Native input for a browser-managed accessibility and editing surface; its text is plain rather than canvas-highlighted.

Canvas word wrapping, complex-script caret geometry, and the application touch menu can differ from native platform widgets. The editor uses grapheme boundaries, directional runs, and canvas font measurements, but does not implement every platform-specific textarea editing convention. Clipboard denial is reported; Native input supplies browser-native clipboard behavior in that case.

## References and licenses

The implementation follows the [EditContext specification](https://www.w3.org/TR/edit-context/) and [Chrome's EditContext integration guidance](https://developer.chrome.com/blog/introducing-editcontext-api), including application-managed selection and IME bounds. Lock lifecycle handling follows [Chrome's page lifecycle guidance](https://developer.chrome.com/docs/web-platform/page-lifecycle-api).

PrefixType uses the license in [LICENSE](LICENSE). The vendored bidirectional-text implementation is covered by [its MIT license](vendor/bidi-LICENSE.txt).
