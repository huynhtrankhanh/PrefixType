/* Canvas editor. Public offsets, EditContext offsets and recording offsets are UTF-16.
 * Grapheme boundaries are used only for user navigation/deletion and painting. */
(function (root) {
  'use strict';
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const words = new Intl.Segmenter(undefined, { granularity: 'word' });
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const normalize = text => text.replace(/\r\n?/g, '\n');
  function boundary(text, offset, direction = -1) {
    offset = clamp(offset, 0, text.length);
    if (!offset || offset === text.length) return offset;
    const part = graphemes.segment(text).containing(offset);
    return part.index === offset ? offset : part.index + (direction > 0 ? part.segment.length : 0);
  }
  function adjacent(text, offset, direction) {
    if (direction < 0) return offset ? graphemes.segment(text).containing(offset - 1).index : 0;
    if (offset >= text.length) return text.length;
    const part = graphemes.segment(text).containing(offset);
    return part.index + part.segment.length;
  }
  function wordMove(text, offset, direction) {
    const segments = words.segment(text);
    if (direction < 0) {
      while (offset > 0) {
        const part = segments.containing(offset - 1);
        if (part.segment.includes('\n')) return offset;
        offset = part.index;
        if (!/^\s+$/u.test(part.segment)) break;
      }
    } else {
      while (offset < text.length) {
        const part = segments.containing(offset);
        offset = part.index + part.segment.length;
        if (part.segment.includes('\n') || !/^\s+$/u.test(part.segment)) break;
      }
    }
    return offset;
  }
  // Only used by the native textarea fallback. EditContext supplies exact deltas.
  function diff(before, after) {
    let p = 0, suffix = 0;
    while (p < before.length && p < after.length && before[p] === after[p]) p++;
    while (suffix < before.length - p && suffix < after.length - p &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
    return { p, d: before.length - p - suffix, i: after.slice(p, after.length - suffix) };
  }
  class TextModel {
    constructor(target = '') { this.reset(target); }
    reset(target, text = '') {
      this.target = target; this.text = text; this.anchor = this.focus = text.length;
      this.rawPrefix = 0; this.reconcilePrefix(0);
    }
    get start() { return Math.min(this.anchor, this.focus); }
    get end() { return Math.max(this.anchor, this.focus); }
    select(anchor, focus = anchor, snap = true) {
      this.anchor = snap ? boundary(this.text, anchor) : clamp(anchor, 0, this.text.length);
      this.focus = snap ? boundary(this.text, focus) : clamp(focus, 0, this.text.length);
    }
    reconcilePrefix(from) {
      let p = Math.min(from, this.text.length, this.target.length);
      while (p < this.text.length && p < this.target.length && this.text[p] === this.target[p]) p++;
      this.rawPrefix = p;
      this.prefix = Math.min(boundary(this.text, p), boundary(this.target, p));
    }
    replace(p, d, i, selection) {
      if (!Number.isSafeInteger(p) || !Number.isSafeInteger(d) || p < 0 || d < 0 || p + d > this.text.length || typeof i !== 'string') {
        throw new RangeError('Invalid replacement range');
      }
      const oldPrefix = this.prefix, oldLength = this.text.length;
      const removed = this.text.slice(p, p + d);
      const beforeSelection = [this.anchor, this.focus];
      this.text = this.text.slice(0, p) + i + this.text.slice(p + d);
      this.reconcilePrefix(Math.min(p, this.rawPrefix));
      this.select(...(selection || [p + i.length, p + i.length]), false);
      // Correct appends/deletions leave the displayed text identical.
      const stable = oldPrefix === oldLength && this.prefix === this.text.length && p + d === oldLength;
      return { p, d, i, removed, oldPrefix, oldLength, stable, beforeSelection, selection: [this.anchor, this.focus] };
    }
  }

  class CanvasEditor extends EventTarget {
    constructor(canvas, nativeInput, toolbar) {
      super();
      this.element = canvas; this.nativeInput = nativeInput; this.toolbar = toolbar;
      this.model = new TextModel(); this.ctx = canvas.getContext('2d');
      this.lines = []; this.widths = new Map(); this.scroll = 0; this.frame = 0;
      this.undoStack = []; this.redoStack = []; this.formats = []; this.composing = false; this.revision = 0;
      this.commandDepth = 0; this.pendingCompositionCommit = false;
      this.nativeMode = !('EditContext' in root); this.touchMode = false; this.touchMenu = false;
      this.bidi = root.bidi_js();
      if (!this.nativeMode) {
        this.editContext = new EditContext();
        canvas.editContext = this.editContext;
        this.editContext.addEventListener('textupdate', event => {
          this.replace(event.updateRangeStart, event.updateRangeEnd - event.updateRangeStart,
            event.text, [event.selectionStart, event.selectionEnd], { fromContext: true });
        });
        this.editContext.addEventListener('compositionstart', () => {
          this.composing = true; this.compositionGroup = Symbol('composition');
        });
        this.editContext.addEventListener('compositionend', () => {
          this.compositionEnded();
        });
        this.editContext.addEventListener('textformatupdate', event => {
          this.formats = event.getTextFormats(); this.invalidate();
        });
        this.editContext.addEventListener('characterboundsupdate', event => {
          const rects = [];
          for (let i = event.rangeStart; i < Math.min(event.rangeEnd, this.value.length); i++) rects.push(this.characterRect(i));
          this.editContext.updateCharacterBounds(event.rangeStart, rects);
        });
      }
      nativeInput.addEventListener('input', () => {
        const delta = diff(this.value, nativeInput.value);
        this.replace(delta.p, delta.d, delta.i,
          nativeInput.selectionDirection === 'backward' ? [nativeInput.selectionEnd, nativeInput.selectionStart] :
            [nativeInput.selectionStart, nativeInput.selectionEnd], { fromNative: true });
      });
      nativeInput.addEventListener('select', () => {
        if (this.nativeMode) {
          this.model.select(nativeInput.selectionDirection === 'backward' ? nativeInput.selectionEnd : nativeInput.selectionStart,
            nativeInput.selectionDirection === 'backward' ? nativeInput.selectionStart : nativeInput.selectionEnd, false);
          this.invalidate();
        }
      });
      for (const el of [canvas, nativeInput]) {
        el.addEventListener('focus', () => { this.dispatchEvent(new Event('focus')); this.invalidate(); });
        el.addEventListener('blur', () => this.invalidate());
      }
      canvas.addEventListener('keydown', event => this.keydown(event));
      canvas.addEventListener('beforeinput', event => {
        if (event.inputType !== 'insertParagraph' && event.inputType !== 'insertLineBreak') return;
        // Software keyboards can send a newline intent without a named key.
        // An active composition must not swallow an explicit editing command.
        event.preventDefault();
        this.runCommand(() => this.insert('\n'));
      });
      canvas.addEventListener('copy', event => this.clipboard(event, false));
      canvas.addEventListener('cut', event => this.clipboard(event, true));
      canvas.addEventListener('paste', event => {
        if (!event.clipboardData) return;
        event.preventDefault(); this.insert(normalize(event.clipboardData.getData('text/plain')));
      });
      canvas.addEventListener('wheel', event => {
        event.preventDefault(); this.scrollBy(event.deltaY * (event.deltaMode === 1 ? this.lineHeight : event.deltaMode === 2 ? this.height : 1));
      }, { passive: false });
      canvas.addEventListener('dblclick', event => {
        event.preventDefault(); this.selectWord(this.hit(event.clientX, event.clientY));
      });
      canvas.addEventListener('click', event => {
        if (event.detail >= 3) {
          const pos = this.hit(event.clientX, event.clientY);
          this.select(this.lineEdge(pos, -1), this.lineEdge(pos, 1));
        }
      });
      canvas.addEventListener('pointerdown', event => this.pointerDown(event));
      canvas.addEventListener('pointermove', event => this.pointerMove(event));
      canvas.addEventListener('pointerup', event => this.pointerUp(event));
      canvas.addEventListener('pointercancel', () => this.cancelPointer());
      canvas.addEventListener('lostpointercapture', () => this.cancelPointer());
      canvas.addEventListener('contextmenu', event => {
        if (this.touchMode) { event.preventDefault(); this.selectWord(this.model.focus); }
      });
      this.handles = [...canvas.parentElement.querySelectorAll('.selection-handle')];
      this.handles.forEach((handle, index) => {
        handle.addEventListener('pointerdown', event => {
          event.preventDefault(); this.focus(); handle.setPointerCapture(event.pointerId);
          this.drag = { id: event.pointerId, handle: index, fixed: index === 0 ? this.model.end : this.model.start, x: event.clientX, y: event.clientY };
          this.startAutoScroll();
        });
        handle.addEventListener('pointermove', event => {
          if (this.drag?.id !== event.pointerId) return;
          this.drag.x = event.clientX; this.drag.y = event.clientY - 16;
          this.select(this.drag.fixed, this.hit(event.clientX, event.clientY - 16), false);
        });
        handle.addEventListener('pointerup', () => this.cancelPointer());
        handle.addEventListener('pointercancel', () => this.cancelPointer());
      });
      toolbar.addEventListener('pointerdown', event => event.preventDefault());
      toolbar.addEventListener('click', event => {
        const action = event.target.dataset.action;
        if (!action) return;
        if (action === 'all') this.select(0, this.value.length);
        else this.clipboardCommand({ copy: 'c', cut: 'x', paste: 'v' }[action]);
        this.focus();
      });
      this.setNativeMode(this.nativeMode, false);
      new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
      this.resize();
      document.fonts.ready.then(() => { this.widths.clear(); this.lines = []; this.invalidate(); });
    }
    get value() { return this.model.text; }
    get selectionStart() { return this.model.start; }
    get selectionEnd() { return this.model.end; }
    get prefix() { return this.model.prefix; }
    get hasFocus() { return document.activeElement === (this.nativeMode ? this.nativeInput : this.element); }
    focus(options = { preventScroll: true }) { (this.nativeMode ? this.nativeInput : this.element).focus(options); }
    compositionEnded() {
      if (!this.composing) return;
      this.composing = false; this.compositionGroup = null; this.formats = []; this.invalidate();
      if (this.commandDepth) this.pendingCompositionCommit = true;
      else this.dispatchEvent(new Event('compositioncommit'));
    }
    runCommand(action) {
      this.commandDepth++;
      try {
        if (this.composing) {
          // Detaching EditContext only clears the renderer's composition. The
          // OS IME can retain its preedit and insert it again at the new caret.
          // A DOM focus change also tells Chromium to reset the platform IME.
          // Blur commits the displayed draft; restore focus synchronously so
          // the command and subsequent input still target this editor.
          if (document.activeElement === this.element) {
            this.element.blur();
            this.element.focus({ preventScroll: true });
          } else {
            // Do not steal focus for a programmatic edit of an inactive editor.
            try { this.element.editContext = null; }
            finally { this.element.editContext = this.editContext; }
          }
          this.compositionEnded();
        }
        return action();
      } finally {
        this.commandDepth--;
        if (!this.commandDepth && this.pendingCompositionCommit) {
          this.pendingCompositionCommit = false;
          // Notify observers after the command has updated text and selection.
          this.dispatchEvent(new Event('compositioncommit'));
        }
      }
    }
    setNativeMode(enabled, focus = true) {
      this.nativeMode = enabled || !this.editContext;
      this.nativeInput.hidden = !this.nativeMode; this.element.hidden = this.nativeMode;
      this.nativeInput.value = this.value;
      this.nativeInput.setSelectionRange(this.model.start, this.model.end, this.model.anchor > this.model.focus ? 'backward' : 'forward');
      if (focus) this.focus();
      this.invalidate();
    }
    reset(target, value = '') {
      if (this.composing) return this.runCommand(() => this.reset(target, value));
      this.revision++;
      this.model.reset(target, value); this.lines = []; this.scroll = 0;
      this.undoStack = []; this.redoStack = []; this.formats = [];
      if (this.editContext) {
        this.editContext.updateText(0, this.editContext.text.length, value);
        this.editContext.updateSelection(value.length, value.length);
      }
      this.nativeInput.value = value;
      this.invalidate();
    }
    replace(p, d, i, selection, options = {}) {
      if (this.composing && !options.fromContext) return this.runCommand(() => this.replace(p, d, i, selection, options));
      const delta = this.model.replace(p, d, i, selection);
      this.revision++; this.touchMenu = false;
      if (!options.history && (d || i.length)) {
        const group = this.compositionGroup;
        const previous = this.undoStack.at(-1);
        if (group && previous?.group === group) previous.edits.push(delta);
        else this.undoStack.push({ group, edits: [delta] });
        if (this.undoStack.length > 1000) this.undoStack.shift();
        this.redoStack = [];
      }
      if (!options.fromContext && this.editContext) {
        this.editContext.updateText(p, p + d, i);
        this.editContext.updateSelection(this.model.start, this.model.end);
      }
      if (this.nativeMode && !options.fromNative) {
        this.nativeInput.value = this.value;
        this.nativeInput.setSelectionRange(this.model.start, this.model.end);
      }
      if (!delta.stable) {
        // Restart one visual line before the edit to include joining/combining context.
        const changed = delta.oldPrefix === this.prefix ? p : Math.min(p, delta.oldLength, this.value.length);
        const index = Math.max(0, this.lineIndex(changed) - 1);
        this.lines.length = index;
        this.iterator = null; this.done = false;
      }
      this.goalX = null;
      this.dispatchEvent(new CustomEvent('input', { detail: delta }));
      this.reveal(); this.invalidate();
      return delta;
    }
    insert(text) {
      if (this.composing) return this.runCommand(() => this.insert(text));
      this.replace(this.model.start, this.model.end - this.model.start, text);
    }
    history(redo) {
      if (this.composing) return this.runCommand(() => this.history(redo));
      const from = redo ? this.redoStack : this.undoStack, to = redo ? this.undoStack : this.redoStack;
      const entry = from.pop(); if (!entry) return;
      const edits = redo ? entry.edits : [...entry.edits].reverse();
      for (const edit of edits) this.replace(edit.p, redo ? edit.d : edit.i.length,
        redo ? edit.i : edit.removed, redo ? edit.selection : edit.beforeSelection, { history: true });
      to.push(entry);
    }
    select(anchor, focus = anchor, reveal = true) {
      // Selection changes must leave the IME's replacement range alive.
      // The IME may resend its full draft before ending composition in response
      // to the new selection; blurring here would turn that into an insertion.
      this.model.select(anchor, focus);
      this.editContext?.updateSelection(this.model.start, this.model.end);
      if (reveal) this.reveal();
      this.invalidate();
    }
    clipboard(event, cut) {
      if (this.model.start === this.model.end || !event.clipboardData) return;
      event.preventDefault(); event.clipboardData.setData('text/plain', this.value.slice(this.model.start, this.model.end));
      if (cut) this.insert('');
    }
    async clipboardCommand(command) {
      if (this.composing) return this.runCommand(() => this.clipboardCommand(command));
      const revision = this.revision, start = this.model.start, end = this.model.end;
      try {
        if (command === 'v') {
          const text = normalize(await navigator.clipboard.readText());
          if (revision === this.revision) this.replace(start, end - start, text);
        } else if (start !== end) {
          await navigator.clipboard.writeText(this.value.slice(start, end));
          if (command === 'x' && revision === this.revision) this.replace(start, end - start, '');
        }
      } catch {
        this.dispatchEvent(new CustomEvent('notice', { detail: 'Clipboard access was denied. Use Native input for browser clipboard commands.' }));
      }
    }
    keydown(event) {
      // IMEs often mark even named navigation keys as composing/keyCode 229.
      // Dispatch commands by key; leave unrecognized Process/typing events to
      // the IME instead of disabling every command while a draft is active.
      const key = event.key;
      const command = event.ctrlKey || event.metaKey;
      const navigation = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
      const shortcut = command && ['a', 'z', 'y', 'c', 'x', 'v'].includes(key.toLowerCase());
      const newline = key === 'Enter' && !command && !event.altKey;
      if (!shortcut && !navigation.includes(key) && !['Backspace', 'Delete'].includes(key) && !newline) return;
      event.preventDefault();
      if (navigation.includes(key) || (command && key.toLowerCase() === 'a')) {
        this.editingKey(event, newline);
      } else {
        this.runCommand(() => this.editingKey(event, newline));
      }
    }
    editingKey(event, newline) {
      if (newline) { this.insert('\n'); return; }
      const command = event.ctrlKey || event.metaKey;
      const mac = /Mac|iPhone|iPad/.test(navigator.platform);
      const byWord = mac ? event.altKey : event.ctrlKey;
      const key = event.key;
      if (command && key.toLowerCase() === 'a') { event.preventDefault(); this.select(0, this.value.length); return; }
      if (command && ['z', 'y'].includes(key.toLowerCase())) {
        event.preventDefault(); this.history(key.toLowerCase() === 'y' || event.shiftKey); return;
      }
      // Chromium does not dispatch clipboard events for every canvas shortcut.
      // Use the trusted key gesture for the Clipboard API; paste/copy events also
      // remain supported for platform menus and integrations.
      if (command && ['c', 'x', 'v'].includes(key.toLowerCase())) {
        event.preventDefault(); this.clipboardCommand(key.toLowerCase()); return;
      }
      let position = this.model.focus;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(key)) {
        event.preventDefault();
        const direction = ['ArrowLeft', 'ArrowUp', 'Home', 'PageUp'].includes(key) ? -1 : 1;
        if (key === 'ArrowLeft' || key === 'ArrowRight') {
          if (!event.shiftKey && this.model.start !== this.model.end) position = direction < 0 ? this.model.start : this.model.end;
          else if (mac && event.metaKey) position = this.lineEdge(position, direction);
          else position = byWord ? wordMove(this.value, position, direction) : adjacent(this.value, position, direction);
          this.goalX = null;
        } else if (key === 'Home' || key === 'End') {
          position = command ? (direction < 0 ? 0 : this.value.length) : this.lineEdge(position, direction);
          this.goalX = null;
        } else if (mac && event.metaKey) position = direction < 0 ? 0 : this.value.length;
        else {
          const point = this.point(position); this.goalX ??= point.x;
          const count = key.startsWith('Page') ? Math.max(1, Math.floor(this.height / this.lineHeight) - 1) : 1;
          position = this.hitLocal(this.goalX, point.y + direction * count * this.lineHeight + this.lineHeight / 2);
        }
        this.select(event.shiftKey ? this.model.anchor : position, position); return;
      }
      if (key === 'Backspace' || key === 'Delete') {
        event.preventDefault();
        let start = this.model.start, end = this.model.end;
        if (start === end) {
          const direction = key === 'Backspace' ? -1 : 1;
          const dest = byWord ? wordMove(this.value, start, direction) : adjacent(this.value, start, direction);
          start = Math.min(start, dest); end = Math.max(end, dest);
        }
        if (start !== end) this.replace(start, end - start, '');
      }
    }
    resize() {
      const rect = this.element.parentElement.getBoundingClientRect();
      const style = getComputedStyle(this.element);
      const width = rect.width, height = rect.height, ratio = devicePixelRatio || 1;
      const font = `${style.fontSize} ${style.fontFamily}`;
      const lineHeight = parseFloat(style.lineHeight);
      const padding = innerWidth <= 620 ? 16 : Math.max(18, Math.min(34, innerWidth * .03));
      const changed = width !== this.width || height !== this.height || font !== this.font ||
        lineHeight !== this.lineHeight || padding !== this.padding || ratio !== this.ratio;
      if (width !== this.width || font !== this.font || lineHeight !== this.lineHeight || padding !== this.padding) {
        this.lines = []; this.iterator = null; this.done = false;
      }
      if (font !== this.font) this.widths.clear();
      this.width = width; this.height = height; this.font = font;
      this.fontSize = parseFloat(style.fontSize); this.lineHeight = lineHeight;
      this.padding = padding; this.ratio = ratio;
      // Measurements need the new font immediately, but changing canvas width
      // or height clears its pixels. Defer those assignments to the paint frame.
      this.ctx.font = font;
      if (changed && this.hasFocus) this.reveal();
      this.invalidate();
    }
    displayText() { return this.value + this.model.target.slice(this.prefix); }
    lineIndex(offset) {
      let low = 0, high = this.lines.length;
      while (low < high) { const mid = (low + high) >>> 1; if (this.lines[mid].start <= offset) low = mid + 1; else high = mid; }
      return Math.max(0, low - 1);
    }
    measure(text) {
      if (this.widths.has(text)) return this.widths.get(text);
      const width = this.ctx.measureText(text).width;
      if (this.widths.size > 4096) this.widths.clear();
      this.widths.set(text, width); return width;
    }
    ensureLayout(offset = -1, bottom = this.scroll + this.height) {
      if (!this.width || this.nativeMode) return;
      if (!this.lines.length) { this.iterator = null; this.done = false; }
      if (!this.iterator && !this.done) {
        const from = this.lines.at(-1)?.end || 0;
        this.layoutText = this.displayText(); this.iteratorBase = from;
        this.layoutTypedLength = this.value.length;
        const text = this.layoutText, split = this.layoutTypedLength;
        // The wrong-text/expected-text seam is a rendering boundary: a trailing
        // ZWJ or combining mark in a mistake must not absorb the expected glyph.
        this.iterator = (function* () {
          let base = from;
          for (const chunk of from < split ? [text.slice(from, split), text.slice(split)] : [text.slice(from)]) {
            for (const part of graphemes.segment(chunk)) yield { segment: part.segment, index: base - from + part.index };
            base += chunk.length;
          }
        })();
        this.pending = [];
      }
      while (!this.done && (!this.lines.length ||
        (offset >= 0 ? this.lines.at(-1).end <= offset : this.padding + this.lines.length * this.lineHeight < bottom + this.lineHeight))) {
        const start = this.lines.at(-1)?.end || 0;
        let end = start, width = 0, cells = [], newline = false, lastBreak = 0;
        const available = Math.max(1, this.width - this.padding * 2);
        while (true) {
          const next = this.pending.length ? this.pending.shift() : this.iterator.next();
          if (next.done) { this.done = true; break; }
          const text = next.value.segment, index = this.iteratorBase + next.value.index;
          const cellWidth = text === '\n' ? 0 : text === '\t' ? this.measure(' ') * 4 - width % (this.measure(' ') * 4) : this.measure(text);
          if (cells.length && text !== '\n' && width + cellWidth > available) {
            this.pending.unshift(next);
            if (lastBreak) {
              const tail = cells.splice(lastBreak);
              this.pending.unshift(...tail.map(cell => ({ done: false, value: { segment: cell.text, index: cell.start - this.iteratorBase } })));
              end = cells.at(-1).end;
            }
            break;
          }
          cells.push({ start: index, end: index + text.length, text, width: cellWidth });
          end = index + text.length; width += cellWidth;
          if (/[\s\-\u2010\u2013]$|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(text)) lastBreak = cells.length;
          if (text === '\n') { newline = true; break; }
        }
        const line = { start, end, cells, newline, runs: [] };
        this.shapeLine(line); this.lines.push(line);
      }
    }
    shapeLine(line) {
      const cells = line.cells;
      const text = this.layoutText.slice(line.start, line.end);
      const levels = this.bidi.getEmbeddingLevels(text, 'ltr');
      let runs = [], current;
      for (const cell of cells) {
        const level = levels.levels[cell.start - line.start] || 0;
        if (!current || current.level !== level || (cell.start === this.layoutTypedLength && this.prefix < this.layoutTypedLength) || cell.text === '\t' || cell.text === '\n' || current.special) {
          current = { level, cells: [], special: cell.text === '\t' || cell.text === '\n' }; runs.push(current);
        }
        current.cells.push(cell);
      }
      const max = Math.max(0, ...runs.map(run => run.level));
      const odd = Math.min(Infinity, ...runs.filter(run => run.level % 2).map(run => run.level));
      for (let level = max; level >= odd; level--) {
        for (let i = 0; i < runs.length;) {
          if (runs[i].level < level) { i++; continue; }
          let j = i + 1; while (j < runs.length && runs[j].level >= level) j++;
          runs.splice(i, j - i, ...runs.slice(i, j).reverse()); i = j;
        }
      }
      let x = this.padding;
      for (const run of runs) {
        run.text = run.cells.map(cell => cell.text).join(''); run.rtl = !!(run.level % 2);
        run.x = x; run.width = run.special ? run.cells[0].width : this.measure(run.text);
        let consumed = 0, prefix = '';
        for (const cell of run.cells) {
          prefix += cell.text;
          const next = run.special ? run.width : this.measure(prefix);
          cell.width = Math.max(0, next - consumed);
          cell.x = run.rtl ? x + run.width - next : x + consumed;
          cell.rtl = run.rtl; consumed = next;
        }
        x += run.width;
      }
      line.runs = runs; line.right = x;
    }
    point(offset) {
      this.ensureLayout(offset);
      const row = this.lineIndex(offset), line = this.lines[row];
      if (!line) return { x: this.padding, y: this.padding, row: 0 };
      const cell = line.cells.find(cell => offset >= cell.start && offset < cell.end);
      const typedEnd = offset === this.value.length && offset > 0 ? line.cells.find(cell => cell.end === offset && cell.rtl) : null;
      let x = cell ? cell.x + (cell.rtl ? cell.width : 0) : line.right;
      if (!cell && line.cells.length) {
        const last = line.cells.at(-1); x = last.x + (last.rtl ? 0 : last.width);
      }
      if (typedEnd) x = typedEnd.x;
      return { x, y: this.padding + row * this.lineHeight, row };
    }
    characterRect(offset) {
      const point = this.point(offset), rect = this.element.getBoundingClientRect();
      const cell = this.lines[point.row]?.cells.find(cell => offset >= cell.start && offset < cell.end);
      return new DOMRect(rect.left + (cell?.x ?? point.x), rect.top + point.y - this.scroll,
        Math.max(1, cell?.width || 0), this.lineHeight);
    }
    hit(clientX, clientY) {
      const rect = this.element.getBoundingClientRect();
      return this.hitLocal(clientX - rect.left, clientY - rect.top + this.scroll);
    }
    hitLocal(x, y) {
      this.ensureLayout(-1, y + this.lineHeight);
      const row = clamp(Math.floor((y - this.padding) / this.lineHeight), 0, this.lines.length - 1);
      const line = this.lines[row]; if (!line) return 0;
      let best = line.start, distance = Infinity;
      for (const cell of line.cells) {
        for (const [pos, at] of [[cell.start, cell.x + (cell.rtl ? cell.width : 0)], [cell.end, cell.x + (cell.rtl ? 0 : cell.width)]]) {
          if (cell.text === '\n' && pos === cell.end) continue;
          const d = Math.abs(x - at);
          if (d < distance) { best = pos; distance = d; }
        }
      }
      return boundary(this.value, Math.min(best, this.value.length));
    }
    lineEdge(offset, direction) {
      const point = this.point(offset), line = this.lines[point.row];
      return Math.min(this.value.length, direction < 0 ? line.start : line.end - (line.newline ? 1 : 0));
    }
    reveal() {
      if (this.nativeMode || !this.width) return;
      const point = this.point(this.model.focus), guard = this.lineHeight;
      if (point.y < this.scroll + guard) this.scroll = Math.max(0, point.y - guard);
      if (point.y + this.lineHeight > this.scroll + this.height - guard) this.scroll = Math.max(0, point.y + this.lineHeight - this.height + guard);
    }
    scrollBy(amount) {
      this.ensureLayout(-1, this.scroll + amount + this.height);
      const max = Math.max(0, this.padding * 2 + this.lines.length * this.lineHeight - this.height);
      this.scroll = clamp(this.scroll + amount, 0, max); this.invalidate();
    }
    invalidate() {
      if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.paint(); });
    }
    paint() {
      if (this.nativeMode) { this.handles.forEach(handle => handle.hidden = true); this.toolbar.hidden = true; return; }
      this.ensureLayout();
      const pixelWidth = Math.max(1, Math.round(this.width * this.ratio));
      const pixelHeight = Math.max(1, Math.round(this.height * this.ratio));
      if (this.element.width !== pixelWidth) this.element.width = pixelWidth;
      if (this.element.height !== pixelHeight) this.element.height = pixelHeight;
      const ctx = this.ctx;
      ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
      ctx.font = this.font; ctx.textBaseline = 'alphabetic';
      ctx.clearRect(0, 0, this.width, this.height);
      const first = Math.max(0, Math.floor((this.scroll - this.padding) / this.lineHeight));
      const last = Math.min(this.lines.length, Math.ceil((this.scroll + this.height - this.padding) / this.lineHeight));
      for (let row = first; row < last; row++) {
        const line = this.lines[row], y = this.padding + row * this.lineHeight - this.scroll;
        const baseline = y + (this.lineHeight - this.fontSize) / 2 + this.fontSize * .82;
        for (const cell of line.cells) {
          const wrong = cell.start >= this.prefix && cell.start < this.value.length;
          const selected = cell.end > this.model.start && cell.start < this.model.end;
          if (wrong || selected) {
            ctx.fillStyle = selected ? '#bdc6ff' : '#ffe3e3';
            ctx.fillRect(cell.x, y, Math.max(cell.width, this.measure(' ') * .5), this.lineHeight);
          }
          if (cell.start === this.value.length) {
            ctx.fillStyle = '#5362e8'; ctx.fillRect(cell.x, y + this.lineHeight - 3, Math.max(3, cell.width), 2);
          }
        }
        // Shape complete direction runs, then clip colors; Arabic joins and ligatures survive.
        for (const run of line.runs) {
          if (run.special) continue;
          const colors = new Map();
          for (const cell of run.cells) {
            const color = cell.end <= this.prefix ? '#0d8b50' : cell.start < this.value.length ? '#d43f3f' : '#9299aa';
            if (!colors.has(color)) colors.set(color, []);
            colors.get(color).push(cell);
          }
          for (const [color, cells] of colors) {
            ctx.save(); ctx.beginPath();
            for (const cell of cells) ctx.rect(cell.x - .15, y, cell.width + .3, this.lineHeight);
            ctx.clip(); ctx.direction = run.rtl ? 'rtl' : 'ltr'; ctx.textAlign = run.rtl ? 'right' : 'left'; ctx.fillStyle = color;
            ctx.fillText(run.text, run.x + (run.rtl ? run.width : 0), baseline); ctx.restore();
          }
        }
        for (const cell of line.cells) {
          const format = this.formats.find(f => cell.end > f.rangeStart && cell.start < f.rangeEnd);
          if (!format || format.underlineStyle === 'none' || format.underlineThickness === 'none') continue;
          ctx.save(); ctx.strokeStyle = '#172033'; ctx.lineWidth = format.underlineThickness === 'thick' ? 2 : 1;
          if (format.underlineStyle === 'dotted' || format.underlineStyle === 'dashed') ctx.setLineDash([2, 2]);
          ctx.beginPath(); ctx.moveTo(cell.x, y + this.lineHeight - 4); ctx.lineTo(cell.x + cell.width, y + this.lineHeight - 4); ctx.stroke(); ctx.restore();
        }
      }
      const caret = this.point(this.model.focus);
      if (this.hasFocus && this.model.start === this.model.end) {
        ctx.fillStyle = '#172033'; ctx.fillRect(caret.x, caret.y - this.scroll + 3, 1.5, this.lineHeight - 6);
      }
      this.updateBounds(); this.positionHandles();
    }
    updateBounds() {
      if (!this.editContext || this.nativeMode) return;
      this.editContext.updateControlBounds(this.element.getBoundingClientRect());
      this.editContext.updateSelectionBounds(this.characterRect(this.model.focus));
    }
    positionHandles() {
      const show = this.touchMode && this.hasFocus;
      const positions = [this.model.start, this.model.end];
      this.handles.forEach((handle, index) => {
        const point = this.point(positions[index]), y = point.y - this.scroll + this.lineHeight;
        handle.hidden = !show || (index === 0 && positions[0] === positions[1]) || y < 0 || y > this.height;
        handle.style.left = `${point.x}px`; handle.style.top = `${y}px`;
      });
      this.toolbar.hidden = !show || !this.touchMenu || !!this.drag;
      for (const button of this.toolbar.querySelectorAll('[data-action="copy"], [data-action="cut"]')) button.hidden = positions[0] === positions[1];
      if (!this.toolbar.hidden) {
        const point = this.point(this.model.start);
        this.toolbar.style.left = `${clamp(point.x - 80, 4, Math.max(4, this.width - 260))}px`;
        const top = point.y - this.scroll;
        this.toolbar.style.top = `${clamp(top < 48 ? top + this.lineHeight + 28 : top - 44, 4, this.height - 44)}px`;
      }
    }
    selectWord(offset) {
      const segment = words.segment(this.value).containing(Math.min(offset, Math.max(0, this.value.length - 1)));
      if (segment) this.select(segment.index, segment.index + segment.segment.length);
      else this.select(offset);
      if (this.touchMode) this.touchMenu = true;
      this.invalidate();
    }
    pointerDown(event) {
      if (event.button !== 0) return;
      event.preventDefault(); this.touchMode = event.pointerType === 'touch'; this.touchMenu = false; this.focus();
      const pos = this.hit(event.clientX, event.clientY);
      this.element.setPointerCapture(event.pointerId);
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: event.clientX, originY: event.clientY,
        scroll: this.scroll, touch: this.touchMode, fixed: event.shiftKey ? this.model.anchor : pos };
      if (this.touchMode) {
        this.longPress = setTimeout(() => {
          if (!this.drag) return;
          this.drag.selecting = true; this.selectWord(pos); this.drag.fixed = this.model.anchor; this.startAutoScroll();
        }, 450);
      } else {
        if (event.detail >= 3) this.select(this.lineEdge(pos, -1), this.lineEdge(pos, 1));
        else if (event.detail === 2) this.selectWord(pos);
        else this.select(this.drag.fixed, pos);
        this.drag.fixed = this.model.anchor; this.startAutoScroll();
      }
    }
    pointerMove(event) {
      if (this.drag?.id !== event.pointerId) return;
      const drag = this.drag; drag.x = event.clientX; drag.y = event.clientY;
      if (drag.touch && !drag.selecting) {
        if (Math.hypot(event.clientX - drag.originX, event.clientY - drag.originY) > 8) {
          clearTimeout(this.longPress); drag.scrolling = true;
        }
        if (drag.scrolling) this.scrollBy(drag.scroll + drag.originY - event.clientY - this.scroll);
      } else this.select(drag.fixed, this.hit(event.clientX, event.clientY), false);
    }
    pointerUp(event) {
      if (this.drag?.id === event.pointerId && this.drag.touch && !this.drag.scrolling && !this.drag.selecting) {
        this.select(this.hit(event.clientX, event.clientY));
      }
      this.cancelPointer();
    }
    cancelPointer() {
      if (this.drag && (this.drag.handle !== undefined || this.drag.selecting)) this.touchMenu = true;
      clearTimeout(this.longPress); cancelAnimationFrame(this.autoFrame); this.drag = null; this.invalidate();
    }
    startAutoScroll() {
      cancelAnimationFrame(this.autoFrame);
      const tick = () => {
        if (!this.drag) return;
        const rect = this.element.getBoundingClientRect(), y = this.drag.y;
        const delta = y < rect.top + 24 ? -10 : y > rect.bottom - 24 ? 10 : 0;
        if (delta) { this.scrollBy(delta); this.select(this.drag.fixed, this.hit(this.drag.x, y), false); }
        this.autoFrame = requestAnimationFrame(tick);
      };
      this.autoFrame = requestAnimationFrame(tick);
    }
  }
  root.PrefixEditor = { TextModel, CanvasEditor, boundary, adjacent, wordMove, diff, normalize, graphemes };
})(typeof window === 'undefined' ? globalThis : window);
