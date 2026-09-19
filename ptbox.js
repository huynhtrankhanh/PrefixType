/* PTBOX v1: UTF-8 strings. v2: UTF-16LE strings (byte lengths), lossless even
 * for transient IME lone surrogates. v3 uses UTF-16LE and adds explicit
 * session linkage immediately after each session ID: u8 0=legacy unknown,
 * 1=independent session, 2=continued session followed by predecessor ID string.
 * Offsets/deletion counts are UTF-16 code units in all versions. */
(function (root) {
  'use strict';
  function wellFormed(text) {
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = text.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    }
    return true;
  }
  class Writer {
    constructor(version) { this.version = version; this.parts = []; }
    bytes(value) { this.parts.push(Uint8Array.from(value)); }
    u8(value) { this.bytes([value]); }
    f64(value) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, value, true); this.parts.push(b); }
    uint(value) {
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid unsigned integer');
      const bytes = [];
      while (value >= 128) { bytes.push(value % 128 + 128); value = Math.floor(value / 128); }
      bytes.push(value); this.bytes(bytes);
    }
    string(value = '') {
      let bytes;
      if (this.version === 1) bytes = new TextEncoder().encode(value);
      else {
        bytes = new Uint8Array(value.length * 2);
        for (let i = 0; i < value.length; i++) { const unit = value.charCodeAt(i); bytes[i * 2] = unit & 255; bytes[i * 2 + 1] = unit >>> 8; }
      }
      this.uint(bytes.length); this.parts.push(bytes);
    }
    finish() {
      const out = new Uint8Array(this.parts.reduce((sum, b) => sum + b.length, 0));
      let at = 0; for (const part of this.parts) { out.set(part, at); at += part.length; } return out;
    }
  }
  class Reader {
    constructor(bytes) {
      this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength); this.at = 0;
    }
    take(count) {
      if (!Number.isSafeInteger(count) || count < 0 || count > this.bytes.length - this.at) throw new Error('Truncated PTBOX');
      const bytes = this.bytes.subarray(this.at, this.at + count); this.at += count; return bytes;
    }
    u8() { return this.take(1)[0]; }
    f64() { const at = this.at; this.take(8); return this.view.getFloat64(at, true); }
    uint() {
      let value = 0, factor = 1;
      for (let i = 0; i < 8; i++) {
        const byte = this.u8(); value += (byte & 127) * factor;
        if (!Number.isSafeInteger(value)) throw new Error('PTBOX integer overflow');
        if (byte < 128) { if (i && byte === 0) throw new Error('Noncanonical PTBOX integer'); return value; }
        factor *= 128;
      }
      throw new Error('PTBOX integer overflow');
    }
    string() {
      const bytes = this.take(this.uint());
      if (this.version === 1) return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (bytes.length % 2) throw new Error('Odd UTF-16 byte count');
      const parts = [];
      for (let start = 0; start < bytes.length; start += 8192) {
        const units = [];
        for (let i = start; i < Math.min(start + 8192, bytes.length); i += 2) units.push(bytes[i] | bytes[i + 1] << 8);
        parts.push(String.fromCharCode(...units));
      }
      return parts.join('');
    }
    count() {
      const n = this.uint();
      if (n > this.bytes.length - this.at) throw new Error('Impossible PTBOX item count');
      return n;
    }
  }
  function strings(record) {
    const all = [record.dayKey, record.timeZone];
    for (const f of record.fragments) {
      const s = f.session; all.push(s.id, s.r || '', s.q || '', s.x || '', f.initialValue);
      for (const event of f.events) all.push(event.i);
    }
    return all;
  }
  const hasLinkage = session => Object.hasOwn(session, 'previousSessionId');
  function encode(record, version = record.fragments.some(f => hasLinkage(f.session)) ? 3 :
    record.version ?? (strings(record).every(wellFormed) ? 1 : 2)) {
    if (![1, 2, 3].includes(version)) throw new Error('Unsupported PTBOX version');
    if (version < 3 && record.fragments.some(f => hasLinkage(f.session))) throw new Error('PTBOX v1/v2 cannot preserve session linkage');
    if (version === 1 && !strings(record).every(wellFormed)) throw new Error('PTBOX v1 cannot preserve lone surrogates');
    const w = new Writer(version); w.bytes([80, 84, 66, 79, 88]); w.u8(version);
    w.f64(record.exportedAt); w.string(record.dayKey); w.string(record.timeZone);
    w.f64(record.dayStart); w.f64(record.dayEnd); w.f64(record.accumulatedMs); w.uint(record.fragments.length);
    for (const f of record.fragments) {
      const s = f.session;
      w.string(s.id);
      if (version === 3) {
        if (!hasLinkage(s)) w.u8(0);
        else if (s.previousSessionId === null) w.u8(1);
        else {
          if (typeof s.previousSessionId !== 'string' || !s.previousSessionId) throw new Error('Invalid predecessor ID');
          w.u8(2); w.string(s.previousSessionId);
        }
      }
      w.f64(s.a); w.f64(s.z == null ? NaN : s.z); w.f64(f.fragmentStart); w.f64(f.fragmentEnd);
      w.string(s.r || ''); w.string(s.q || ''); w.f64(Number.isFinite(s.o) ? s.o : NaN);
      w.string(s.x || ''); w.string(f.initialValue); w.uint(f.events.length);
      for (const e of f.events) { w.f64(e.t); w.uint(e.p); w.uint(e.d); w.string(e.i); w.uint(e.s); w.uint(e.e); }
    }
    return w.finish();
  }
  function decode(bytes) {
    const r = new Reader(bytes);
    if (String.fromCharCode(...r.take(5)) !== 'PTBOX') throw new Error('Invalid PTBOX signature');
    r.version = r.u8(); if (![1, 2, 3].includes(r.version)) throw new Error('Unsupported PTBOX version');
    const record = { version: r.version, exportedAt: r.f64(), dayKey: r.string(), timeZone: r.string(),
      dayStart: r.f64(), dayEnd: r.f64(), accumulatedMs: r.f64(), fragments: [] };
    const count = r.count();
    for (let i = 0; i < count; i++) {
      const session = { id: r.string() };
      if (r.version === 3) {
        const kind = r.u8();
        if (kind === 1) session.previousSessionId = null;
        else if (kind === 2) {
          session.previousSessionId = r.string();
          if (!session.previousSessionId) throw new Error('Empty predecessor ID');
        } else if (kind !== 0) throw new Error('Invalid session linkage kind');
      }
      session.a = r.f64(); session.z = r.f64();
      if (Number.isNaN(session.z)) session.z = null;
      const f = { session, fragmentStart: r.f64(), fragmentEnd: r.f64() };
      session.r = r.string(); session.q = r.string(); session.o = r.f64(); session.x = r.string();
      f.initialValue = r.string(); f.events = [];
      const n = r.count();
      for (let j = 0; j < n; j++) f.events.push({ t: r.f64(), p: r.uint(), d: r.uint(), i: r.string(), s: r.uint(), e: r.uint() });
      record.fragments.push(f);
    }
    if (r.at !== r.bytes.length) throw new Error('Trailing PTBOX bytes');
    return record;
  }
  function apply(value, event) {
    if (!Number.isSafeInteger(event.p) || !Number.isSafeInteger(event.d) || event.p < 0 || event.d < 0 || event.p + event.d > value.length) {
      throw new Error('Delta outside text');
    }
    const next = value.slice(0, event.p) + event.i + value.slice(event.p + event.d);
    if (!Number.isSafeInteger(event.s) || !Number.isSafeInteger(event.e) || event.s < 0 || event.s > event.e || event.e > next.length) {
      throw new Error('Selection outside text');
    }
    return next;
  }
  // New sessions carry a self-contained initial state and explicit linkage.
  // Retain inference only for legacy records without linkage metadata.
  function initialState(fragment, previous) {
    if (hasLinkage(fragment.session)) {
      return { text: fragment.initialValue, continued: fragment.session.previousSessionId !== null };
    }
    const first = fragment.events[0];
    if (!fragment.initialValue && first && first.p + first.d > 0 &&
        previous?.session.r === 'pagehide' && previous.session.x === fragment.session.x) {
      return { text: previous.text, continued: true };
    }
    return { text: fragment.initialValue, continued: false };
  }
  function audit(record) {
    const errors = [], warnings = [];
    const finite = (value, name) => { if (!Number.isFinite(value)) errors.push('Non-finite ' + name); };
    for (const key of ['exportedAt', 'dayStart', 'dayEnd', 'accumulatedMs']) finite(record[key], key);
    if (record.dayEnd < record.dayStart || record.exportedAt < record.dayEnd || record.accumulatedMs < 0) errors.push('Invalid day interval');
    let accumulated = 0, eventCount = 0, continuations = 0, previous;
    const ids = new Set();
    const fragments = new Map(record.fragments.map(f => [f.session.id, f]));
    const finalStates = new Map();
    for (const f of record.fragments) {
      const s = f.session;
      if (ids.has(s.id)) errors.push('Duplicate session ' + s.id); ids.add(s.id);
      if (hasLinkage(s) && s.previousSessionId !== null) {
        if (typeof s.previousSessionId !== 'string' || !s.previousSessionId || s.previousSessionId === s.id) {
          errors.push('Invalid predecessor ID ' + s.id);
        }
        const parent = fragments.get(s.previousSessionId)?.session;
        if (parent && (parent.r !== 'pagehide' || parent.z === null || parent.z > s.a || parent.x !== s.x)) {
          errors.push('Invalid pagehide predecessor ' + s.id);
        }
      }
      for (const key of ['a']) finite(s[key], key);
      if (s.z !== null) finite(s.z, 'session end');
      finite(f.fragmentStart, 'fragment start'); finite(f.fragmentEnd, 'fragment end');
      if (f.fragmentEnd < f.fragmentStart || f.fragmentStart < record.dayStart || f.fragmentStart < s.a ||
          f.fragmentEnd > record.dayEnd || (s.z !== null && (s.z < s.a || f.fragmentEnd > s.z))) errors.push('Invalid fragment interval ' + s.id);
      accumulated += f.fragmentEnd - f.fragmentStart;
      eventCount += f.events.length;
      const initial = initialState(f, previous);
      if (initial.continued) continuations++;
      let text = initial.text, lastTime = f.fragmentStart, replayValid = true;
      for (const [index, e] of f.events.entries()) {
        if (!Number.isFinite(e.t) || e.t < lastTime || e.t > f.fragmentEnd || e.t >= record.dayEnd) errors.push('Invalid event time ' + s.id + ':' + index);
        lastTime = e.t;
        try { text = apply(text, e); } catch (error) { errors.push(s.id + ':' + index + ': ' + error.message); replayValid = false; break; }
        if (!wellFormed(text)) warnings.push('Lone surrogate in state ' + s.id + ':' + index);
      }
      if (replayValid) { previous = { session: s, text }; finalStates.set(s.id, text); }
      // A commit at the exclusive midnight boundary belongs to the next file.
      if (replayValid && s.r === 'completed' && s.z < record.dayEnd && text !== s.x) errors.push('Completed text differs from target ' + s.id);
    }
    const checked = new Set();
    for (const f of record.fragments) {
      const parent = fragments.get(f.session.previousSessionId);
      if (parent && f.fragmentStart === f.session.a && parent.fragmentEnd === parent.session.z &&
          finalStates.has(parent.session.id) && f.initialValue !== finalStates.get(parent.session.id)) {
        errors.push('Continuation initial text differs from predecessor ' + f.session.id);
      }
      const path = new Set();
      let cursor = f.session.id;
      while (fragments.has(cursor) && !checked.has(cursor)) {
        if (path.has(cursor)) { errors.push('Cyclic session linkage ' + cursor); break; }
        path.add(cursor); cursor = fragments.get(cursor).session.previousSessionId;
      }
      for (const id of path) checked.add(id);
    }
    if (Math.abs(accumulated - record.accumulatedMs) > .01) errors.push('Accumulated duration mismatch');
    return { errors, warnings, fragments: record.fragments.length, events: eventCount, continuations };
  }
  const api = { encode, decode, apply, audit, wellFormed, initialState };
  root.Ptbox = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
