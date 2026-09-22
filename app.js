(() => {
      "use strict";

      const typingInput = new PrefixEditor.CanvasEditor(
        document.getElementById("typingInput"), document.getElementById("nativeInput"),
        document.getElementById("selectionToolbar"));
      const customText = document.getElementById("customText");
      const editorDrawer = document.getElementById("editorDrawer");
      const recordsDrawer = document.getElementById("recordsDrawer");
      const recordsList = document.getElementById("recordsList");
      const status = document.getElementById("status");
      const finishedBadge = document.getElementById("finished");

      const wpmEl = document.getElementById("wpm");
      const accuracyEl = document.getElementById("accuracy");
      const timeEl = document.getElementById("time");
      const progressTextEl = document.getElementById("progressText");
      const progressBar = document.getElementById("progressBar");

      const DB_NAME = "prefixtype-blackbox";
      const DB_VERSION = 3;
      const SESSION_STORE = "sessions";
      const EVENT_STORE = "events";
      const SENSOR_STORE = "sensors";

      let practiceText = customText.value.replace(/\r\n/g, "\n");
      let startedAt = null;
      let finishedAt = null;
      let timerId = null;
      let totalInserted = 0;
      let correctInserted = 0;
      let recordsRefreshId = null;
      let recorderCheckpointId = null;
      let activeSession = null;
      let pagehideContinuation = null;
      let writeChain = Promise.resolve();
      let pendingWrites = [];
      let writeTimer = null;
      let storageError = null;
      // A live tab holds this lock. Recovery must not close another tab's session.
      const owner = makeSessionId(Date.now());
      let releaseOwner;
      function holdOwnerLock() {
        if (!navigator.locks) return Promise.resolve();
        let unlock, released = false;
        releaseOwner = () => { released = true; unlock?.(); releaseOwner = null; };
        return new Promise(resolve => {
          navigator.locks.request(`prefixtype-owner-${owner}`, () => {
            resolve();
            if (released) return;
            return new Promise(release => { unlock = release; });
          });
        });
      }
      let ownerReady = holdOwnerLock();
      let initialViewportHeight = Math.max(
        window.innerHeight,
        window.visualViewport ? window.visualViewport.height : 0
      );

      const sensors = new DeviceRecorder(document.getElementById('sensorIndicator'), sample => {
        if (!activeSession || storageError) return false;
        activeSession.c = Math.max(activeSession.c, Date.now());
        queueRecord(activeSession, { ...sample, sid: activeSession.id, t: activeSession.c }, true);
        return true;
      });

      const dbPromise = openBlackBoxDb().then(async (db) => {
        await recoverInterruptedSessions(db);
        return db;
      }).catch((error) => {
        console.error("Black box storage unavailable", error);
        status.textContent = "Storage unavailable";
        return null;
      });

      function openBlackBoxDb() {
        return new Promise((resolve, reject) => {
          const request = indexedDB.open(DB_NAME, DB_VERSION);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(SESSION_STORE)) {
              db.createObjectStore(SESSION_STORE, { keyPath: "id" });
            }
            if (!db.objectStoreNames.contains(EVENT_STORE)) {
              const events = db.createObjectStore(EVENT_STORE, {
                keyPath: "k",
                autoIncrement: true
              });
              events.createIndex("sid", "sid", { unique: false });
              events.createIndex("t", "t", { unique: false });
            }
            if (!db.objectStoreNames.contains(SENSOR_STORE)) {
              const samples = db.createObjectStore(SENSOR_STORE, { keyPath: 'k', autoIncrement: true });
              samples.createIndex('sid', 'sid', { unique: false });
              samples.createIndex('t', 't', { unique: false });
            } else {
              // Replace legacy rows in bounded blocks within the atomic upgrade.
              // Retain the first key so delivery order survives interleaved sessions.
              const store = request.transaction.objectStore(SENSOR_STORE);
              let block = [];
              const save = () => {
                if (block.length) store.put({ ...sensorBlock(block), k: block[0].k });
                block = [];
              };
              const cursorRequest = store.openCursor();
              cursorRequest.onsuccess = () => {
                try {
                  const cursor = cursorRequest.result;
                  if (!cursor) { save(); return; }
                  const row = cursor.value;
                  if (row.data || (block.length && (block[0].sid !== row.sid || block.length >= 128))) save();
                  if (!row.data) { block.push(row); cursor.delete(); }
                  cursor.continue();
                } catch (error) { request.transaction.abort(); }
              };
            }
            // Compact existing replacements only when their initial text is known.
            // Legacy continuation records without it must retain their raw deltas.
            const upgrade = request.transaction;
            const sessionsRequest = upgrade.objectStore(SESSION_STORE).getAll();
            sessionsRequest.onsuccess = () => {
              const sessions = new Map(sessionsRequest.result.map(session => [session.id, session]));
              let sid, value;
              const edits = upgrade.objectStore(EVENT_STORE).index('sid').openCursor();
              edits.onsuccess = () => {
                try {
                  const cursor = edits.result;
                  if (!cursor) return;
                  const event = cursor.value;
                  if (sid !== event.sid) { sid = event.sid; value = sessions.get(sid)?.initialText; }
                  if (typeof value === 'string') {
                    const next = Ptbox.apply(value, event);
                    const compact = Ptbox.compactEdit(event, value.slice(event.p, event.p + event.d));
                    if (compact.p !== event.p || compact.d !== event.d || compact.i !== event.i) cursor.update(compact);
                    value = next;
                  }
                  cursor.continue();
                } catch (error) { upgrade.abort(); }
              };
            };
          };
          request.onblocked = () => { status.textContent = 'Close other PrefixType tabs to update storage'; };
          request.onsuccess = () => {
            request.result.onversionchange = () => request.result.close();
            resolve(request.result);
          };
          request.onerror = () => reject(request.error);
        });
      }

      function requestResult(request) {
        return new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      }

      function transactionDone(tx) {
        return new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
          tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
        });
      }

      async function recoverInterruptedSessions(db) {
        const readTx = db.transaction(SESSION_STORE, "readonly");
        const sessions = await requestResult(readTx.objectStore(SESSION_STORE).getAll());
        await transactionDone(readTx);

        const interrupted = sessions.filter((session) => session.z == null);
        if (!interrupted.length) return;

        for (const session of interrupted) {
          const recover = async () => {
            const tx = db.transaction(SESSION_STORE, "readwrite");
            const done = transactionDone(tx);
            session.z = session.c || session.a;
            session.c = session.z;
            session.r = "recovered";
            tx.objectStore(SESSION_STORE).put(session);
            await done;
          };
          if (session.owner && navigator.locks) {
            await navigator.locks.request(`prefixtype-owner-${session.owner}`, { ifAvailable: true }, lock => lock ? recover() : undefined);
          } else await recover();
        }
      }

      function queueRecord(session, event, sensor = false) {
        pendingWrites.push({ session: { ...session }, event: event && { ...event }, sensor });
        // Batch sensor streams instead of opening a transaction for every axis update.
        if (writeTimer === null) writeTimer = window.setTimeout(flushPending, 100);
        return writeChain;
      }
      function sensorBlock(samples) {
        return { sid: samples[0].sid, t: samples[0].t, data: Ptbox.encodeSamples(samples) };
      }
      function* unpackSensors(rows) {
        for (const row of rows) {
          if (!row.data) { yield row; continue; }
          for (const sample of Ptbox.decodeSamples(row.data)) yield { ...sample, sid: row.sid, k: row.k };
        }
      }
      function flushPending() {
        if (writeTimer !== null) window.clearTimeout(writeTimer);
        writeTimer = null;
        if (!pendingWrites.length) return;
        const batch = pendingWrites; pendingWrites = [];
        writeChain = writeChain.then(async () => {
          const db = await dbPromise;
          await ownerReady;
          if (!db) throw new Error('Storage unavailable');
          const sessions = new Map(), blocks = [], events = [];
          let samples = [];
          const save = () => { if (samples.length) blocks.push(sensorBlock(samples)); samples = []; };
          for (const item of batch) {
            sessions.set(item.session.id, item.session);
            if (!item.event) continue;
            if (!item.sensor) { events.push(item.event); continue; }
            if (samples.length && (samples[0].sid !== item.event.sid || samples.length >= 128)) save();
            samples.push(item.event);
          }
          save();
          const tx = db.transaction([SESSION_STORE, EVENT_STORE, SENSOR_STORE], 'readwrite');
          const done = transactionDone(tx);
          for (const event of events) tx.objectStore(EVENT_STORE).add(event);
          for (const block of blocks) tx.objectStore(SENSOR_STORE).add(block);
          for (const session of sessions.values()) tx.objectStore(SESSION_STORE).put(session);
          await done;
        }).catch(error => {
          storageError = error; sensors.setActive(false);
          console.error('Black box write failed', error);
          status.textContent = 'Storage error';
        });
      }
      const putSession = session => queueRecord(session);
      const putDelta = (session, event) => queueRecord(session, event);
      async function flushWrites() {
        // Flush through this call's boundary; a continuous sensor stream must
        // not keep exports waiting forever for the next sample.
        flushPending();
        await writeChain;
        if (storageError) throw storageError;
      }

      async function getAllSessions() {
        await flushWrites();
        const db = await dbPromise;
        if (!db) return [];
        const tx = db.transaction(SESSION_STORE, "readonly");
        const result = await requestResult(tx.objectStore(SESSION_STORE).getAll());
        await transactionDone(tx);
        return result;
      }

      async function getEventsForSession(sessionId) {
        await flushWrites();
        const db = await dbPromise;
        if (!db) return [];
        const tx = db.transaction(EVENT_STORE, "readonly");
        const index = tx.objectStore(EVENT_STORE).index("sid");
        const result = await requestResult(index.getAll(IDBKeyRange.only(sessionId)));
        await transactionDone(tx);
        result.sort((a, b) => a.t - b.t || a.k - b.k);
        return result;
      }

      async function getSensorSamplesForSession(sessionId) {
        await flushWrites();
        const db = await dbPromise;
        if (!db) return [];
        const tx = db.transaction(SENSOR_STORE, 'readonly');
        const done = transactionDone(tx);
        const samples = await requestResult(tx.objectStore(SENSOR_STORE).index('sid').getAll(IDBKeyRange.only(sessionId)));
        await done;
        return [...unpackSensors(samples.sort((a, b) => a.k - b.k))];
      }

      function makeSessionId(now) {
        if (crypto.randomUUID) return `${now.toString(36)}-${crypto.randomUUID()}`;
        const bytes = crypto.getRandomValues(new Uint32Array(4));
        return `${now.toString(36)}-${Array.from(bytes, (n) => n.toString(36)).join("-")}`;
      }

      function beginRecordingSession(at) {
        if (activeSession) return;
        if (!releaseOwner) ownerReady = holdOwnerLock();
        activeSession = {
          id: makeSessionId(at),
          previousSessionId: pagehideContinuation?.id ?? null,
          initialText: pagehideContinuation?.text ?? "",
          owner,
          a: at,
          z: null,
          c: at,
          r: null,
          x: practiceText,
          q: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
          o: new Date(at).getTimezoneOffset()
        };
        pagehideContinuation = null;
        sensors.setActive(!storageError);
        putSession(activeSession);
        recorderCheckpointId = window.setInterval(() => {
          if (!activeSession) return;
          activeSession.c = Math.max(activeSession.c, Date.now());
          putSession(activeSession);
        }, 5000);
      }

      function finalizeRecording(reason, at = Date.now()) {
        if (reason !== "pagehide") pagehideContinuation = null;
        if (!activeSession) return;
        activeSession.z = Math.max(activeSession.a, activeSession.c, at);
        activeSession.c = activeSession.z;
        activeSession.r = reason;
        if (reason === "pagehide") {
          pagehideContinuation = { id: activeSession.id, text: typingInput.value };
        }
        putSession(activeSession);
        activeSession = null;
        sensors.setActive(false);
        if (recorderCheckpointId !== null) {
          window.clearInterval(recorderCheckpointId);
          recorderCheckpointId = null;
        }
      }

      function recordEdit(delta, at) {
        beginRecordingSession(at);
        activeSession.c = Math.max(activeSession.c, at);
        putDelta(activeSession, Ptbox.compactEdit({
          sid: activeSession.id, t: activeSession.c,
          p: delta.p, d: delta.d, i: delta.i,
          s: typingInput.selectionStart, e: typingInput.selectionEnd
        }, delta.removed));
      }

      function applyDelta(value, event) {
        return value.slice(0, event.p) + event.i + value.slice(event.p + event.d);
      }
      function syncGeometry() { typingInput.resize(); }
      function ensureCaretVisible() { typingInput.reveal(); typingInput.invalidate(); }

      function elapsedSeconds() {
        if (!startedAt) return 0;
        return ((finishedAt || performance.now()) - startedAt) / 1000;
      }

      function updateStats() {
        const typed = typingInput.value;
        const prefix = typingInput.prefix;
        const seconds = Math.max(0, elapsedSeconds());
        const minutes = seconds / 60;
        const wpm = minutes > 0 ? Math.round((typed.length / 5) / minutes) : 0;
        const accuracy = totalInserted
          ? Math.round((correctInserted / totalInserted) * 100)
          : 100;
        const progress = practiceText.length
          ? Math.min(100, Math.round((prefix / practiceText.length) * 100))
          : 0;

        wpmEl.textContent = Number.isFinite(wpm) ? wpm : 0;
        accuracyEl.textContent = `${accuracy}%`;
        timeEl.textContent = `${seconds.toFixed(1)}s`;
        progressTextEl.textContent = `${progress}%`;
        progressBar.style.width = `${progress}%`;
      }

      function startTimer() {
        if (startedAt || typingInput.value.length === 0) return;
        startedAt = performance.now();
        status.textContent = "Typing";
        timerId = window.setInterval(updateStats, 100);
      }

      function stopTimer() {
        if (timerId !== null) {
          window.clearInterval(timerId);
          timerId = null;
        }
      }

      function recordInsertions(delta) {
        // Count replacement insertions too, including equal-length corrections.
        for (const part of PrefixEditor.graphemes.segment(delta.i)) {
          totalInserted++;
          const offset = delta.p + part.index;
          if (practiceText.slice(offset, offset + part.segment.length) === part.segment) correctInserted++;
        }
      }

      function checkFinished() {
        // Completion is terminal, including a match in an active IME draft.
        if (finishedAt) return;
        const complete = practiceText.length > 0 && typingInput.value === practiceText;

        if (!complete) {
          finishedBadge.classList.remove("show");
          return;
        }

        if (!finishedAt) {
          finishedAt = performance.now();
          stopTimer();
          finalizeRecording("completed");
          status.textContent = "Complete";
          finishedBadge.classList.add("show");
          updateStats();
          if (recordsDrawer.classList.contains("open")) renderDailyRecords();
        }
      }

      function updateVisualViewport() {
        const viewport = window.visualViewport;
        const height = viewport ? viewport.height : window.innerHeight;
        const offsetTop = viewport ? viewport.offsetTop : 0;
        const activeTypingField =
          typingInput.hasFocus ||
          document.activeElement === customText;

        const layoutHeight = Math.max(
          document.documentElement.clientHeight,
          window.innerHeight,
          initialViewportHeight
        );

        const keyboardLikelyOpen =
          activeTypingField &&
          (layoutHeight - height > 110 || height < initialViewportHeight * 0.76);

        document.documentElement.style.setProperty(
          "--vv-height",
          `${Math.max(260, Math.round(height))}px`
        );
        document.documentElement.style.setProperty(
          "--vv-top",
          `${Math.max(0, Math.round(offsetTop))}px`
        );
        document.body.classList.toggle("keyboard-open", keyboardLikelyOpen);
        syncGeometry();
      }

      function localDayKey(ms) {
        const date = new Date(ms);
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, "0");
        const d = String(date.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
      }

      function dayBounds(dayKey) {
        const [y, m, d] = dayKey.split("-").map(Number);
        const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
        const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime();
        return { start, end };
      }

      function effectiveSessionEnd(session, now) {
        if (activeSession && session.id === activeSession.id) return now;
        return session.z ?? session.c ?? session.a;
      }

      function enumerateSessionDays(session, now) {
        const end = Math.max(session.a, effectiveSessionEnd(session, now));
        const finalInstant = end > session.a ? end - 1 : session.a;
        const keys = [];
        let cursor = new Date(session.a);
        cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate());
        while (cursor.getTime() <= finalInstant) {
          keys.push(localDayKey(cursor.getTime()));
          cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
        }
        return keys;
      }

      function accumulatedForDay(sessions, dayKey, now) {
        const bounds = dayBounds(dayKey);
        const today = localDayKey(now);
        const windowEnd = dayKey === today ? Math.min(now, bounds.end) : bounds.end;
        let total = 0;
        let count = 0;
        for (const session of sessions) {
          const sessionEnd = effectiveSessionEnd(session, now);
          const from = Math.max(bounds.start, session.a);
          const to = Math.min(windowEnd, sessionEnd);
          const startsInside = session.a >= bounds.start && session.a < windowEnd;
          if (to > from || startsInside) count += 1;
          if (to > from) total += to - from;
        }
        return { total, count };
      }

      function formatDuration(ms) {
        const seconds = Math.max(0, Math.floor(ms / 1000));
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        if (h) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
        if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
        return `${s}s`;
      }

      async function renderDailyRecords() {
        const now = Date.now();
        const sessions = await getAllSessions();
        const keys = new Set([localDayKey(now)]);
        for (const session of sessions) {
          for (const key of enumerateSessionDays(session, now)) keys.add(key);
        }
        const sorted = Array.from(keys).sort().reverse();
        recordsList.replaceChildren();

        for (const key of sorted) {
          const { total, count } = accumulatedForDay(sessions, key, now);
          const row = document.createElement("div");
          row.className = "record-row";

          const day = document.createElement("div");
          day.className = "record-day";
          const title = document.createElement("strong");
          title.textContent = key === localDayKey(now) ? `${key} · Live` : key;
          if (key === localDayKey(now)) title.classList.add("record-live");
          const sub = document.createElement("span");
          sub.textContent = `${count} session${count === 1 ? "" : "s"}`;
          day.append(title, sub);

          const duration = document.createElement("div");
          duration.className = "record-total";
          duration.textContent = formatDuration(total);
          duration.title = "Accumulated session time";

          const button = document.createElement("button");
          button.type = "button";
          button.textContent = "Download";
          button.dataset.day = key;
          button.addEventListener("click", () => downloadBlackBox(key, button));

          row.append(day, duration, button);
          recordsList.appendChild(row);
        }
      }

      async function buildDailyRecord(dayKey) {
        await flushWrites();
        const db = await dbPromise;
        if (!db) throw new Error("Storage unavailable");
        // Sessions and events must come from the same IndexedDB snapshot.
        const tx = db.transaction([SESSION_STORE, EVENT_STORE, SENSOR_STORE], "readonly");
        const done = transactionDone(tx);
        const sessionRequest = requestResult(tx.objectStore(SESSION_STORE).getAll());
        const eventRequest = requestResult(tx.objectStore(EVENT_STORE).getAll());
        const sensorRequest = requestResult(tx.objectStore(SENSOR_STORE).getAll());
        const [sessions, allEvents, allSamples] = await Promise.all([sessionRequest, eventRequest, sensorRequest]);
        await done;
        const snapshotAt = Date.now();
        const eventsBySession = new Map();
        for (const event of allEvents) {
          if (!eventsBySession.has(event.sid)) eventsBySession.set(event.sid, []);
          eventsBySession.get(event.sid).push(event);
        }
        const samplesBySession = new Map();
        for (const sample of unpackSensors(allSamples)) {
          if (!samplesBySession.has(sample.sid)) samplesBySession.set(sample.sid, []);
          samplesBySession.get(sample.sid).push(sample);
        }
        const bounds = dayBounds(dayKey);
        const today = localDayKey(snapshotAt);
        const recordEnd = dayKey === today ? Math.min(snapshotAt, bounds.end) : bounds.end;
        const fragments = [];
        let accumulatedMs = 0;

        for (const session of sessions) {
          const sessionEnd = effectiveSessionEnd(session, snapshotAt);
          const fragmentStart = Math.max(bounds.start, session.a);
          const fragmentEnd = Math.max(
            fragmentStart,
            Math.min(recordEnd, sessionEnd)
          );
          const events = eventsBySession.get(session.id) || [];
          events.sort((a, b) => a.k - b.k);
          let initialValue = session.initialText ?? "";
          let value = initialValue;
          const fragmentEvents = [];
          for (const event of events) {
            if (event.t < fragmentStart) {
              initialValue = applyDelta(initialValue, event);
            } else if (event.t >= bounds.start && event.t < recordEnd && event.t <= fragmentEnd) {
              fragmentEvents.push(typeof session.initialText === 'string' ?
                Ptbox.compactEdit(event, value.slice(event.p, event.p + event.d)) : event);
            }
            value = applyDelta(value, event);
          }

          const samples = (samplesBySession.get(session.id) || []).filter(sample =>
            sample.t >= fragmentStart && sample.t < recordEnd && sample.t <= fragmentEnd).sort((a, b) => a.k - b.k);
          const startsInside = session.a >= bounds.start && session.a < recordEnd;
          if (fragmentEnd <= fragmentStart && !startsInside && !fragmentEvents.length && !samples.length) continue;

          fragments.push({
            session,
            fragmentStart,
            fragmentEnd,
            initialValue,
            events: fragmentEvents,
            samples
          });
          accumulatedMs += Math.max(0, fragmentEnd - fragmentStart);
        }

        return {
          version: 5,
          dayKey,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
          dayStart: bounds.start,
          dayEnd: recordEnd,
          exportedAt: snapshotAt,
          accumulatedMs,
          fragments
        };
      }

      const encodePtbox = Ptbox.encode;

      function currentClockFileSuffix(ms) {
        const date = new Date(ms);
        return [date.getHours(), date.getMinutes(), date.getSeconds()]
          .map((n) => String(n).padStart(2, "0"))
          .join("");
      }

      async function downloadBlackBox(dayKey, button) {
        const oldText = button.textContent;
        button.disabled = true;
        button.textContent = "Packing…";
        try {
          const record = await buildDailyRecord(dayKey);
          const bytes = encodePtbox(record);
          const blob = new Blob([bytes], { type: "application/octet-stream" });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          const liveSuffix = dayKey === localDayKey(record.exportedAt)
            ? `-${currentClockFileSuffix(record.exportedAt)}`
            : "";
          link.href = url;
          link.download = `PrefixType-${dayKey}${liveSuffix}.ptbox`;
          document.body.appendChild(link);
          link.click();
          link.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) {
          console.error("Black box export failed", error);
          status.textContent = "Export failed";
        } finally {
          button.disabled = false;
          button.textContent = oldText;
        }
      }

      function startRecordsRefresh() {
        if (recordsRefreshId !== null) return;
        recordsRefreshId = window.setInterval(() => {
          if (recordsDrawer.classList.contains("open")) renderDailyRecords();
        }, 1000);
      }

      function stopRecordsRefresh() {
        if (recordsRefreshId !== null) {
          window.clearInterval(recordsRefreshId);
          recordsRefreshId = null;
        }
      }

      function resetSession({ focus = true, reason = "restarted" } = {}) {
        finalizeRecording(reason);
        stopTimer();
        startedAt = null;
        finishedAt = null;
        totalInserted = 0;
        correctInserted = 0;
        typingInput.reset(practiceText);
        finishedBadge.classList.remove("show");
        status.textContent = "Ready";
        syncGeometry();
        updateStats();
        if (recordsDrawer.classList.contains("open")) renderDailyRecords();
        if (focus) {
          typingInput.focus({ preventScroll: true });
          ensureCaretVisible();
        }
      }

      typingInput.addEventListener("input", (event) => {
        // Completion is terminal for timing/recording until Restart or Use text.
        if (finishedAt) return;
        const at = Date.now();
        recordInsertions(event.detail);
        startTimer();
        recordEdit(event.detail, at);
        updateStats();
        checkFinished();
      });
      typingInput.addEventListener("compositioncommit", checkFinished);
      typingInput.addEventListener("notice", event => { status.textContent = event.detail; });
      const nativeModeButton = document.getElementById("nativeMode");
      nativeModeButton.setAttribute("aria-pressed", String(typingInput.nativeMode));
      nativeModeButton.addEventListener("click", () => {
        typingInput.setNativeMode(!typingInput.nativeMode);
        nativeModeButton.setAttribute("aria-pressed", String(typingInput.nativeMode));
      });

      typingInput.addEventListener("focus", () => {
        editorDrawer.classList.remove("open");
        recordsDrawer.classList.remove("open");
        stopRecordsRefresh();
        updateVisualViewport();
        ensureCaretVisible();
      });
      typingInput.addEventListener("click", ensureCaretVisible);
      typingInput.addEventListener("keyup", ensureCaretVisible);
      typingInput.addEventListener("select", ensureCaretVisible);

      document.addEventListener("selectionchange", () => {
        if (typingInput.hasFocus) ensureCaretVisible();
      });

      document.getElementById("restart").addEventListener("click", () => {
        resetSession({ reason: "restarted" });
      });

      document.getElementById("records").addEventListener("click", async () => {
        const opening = !recordsDrawer.classList.contains("open");
        recordsDrawer.classList.toggle("open", opening);
        editorDrawer.classList.remove("open");
        if (opening) {
          await renderDailyRecords();
          startRecordsRefresh();
        } else {
          stopRecordsRefresh();
          typingInput.focus({ preventScroll: true });
          ensureCaretVisible();
        }
        updateVisualViewport();
      });

      document.getElementById("editText").addEventListener("click", () => {
        const opening = !editorDrawer.classList.contains("open");
        editorDrawer.classList.toggle("open", opening);
        recordsDrawer.classList.remove("open");
        stopRecordsRefresh();

        if (opening) {
          customText.focus({ preventScroll: true });
          customText.select();
        } else {
          typingInput.focus({ preventScroll: true });
          ensureCaretVisible();
        }
        updateVisualViewport();
      });

      document.getElementById("cancelEdit").addEventListener("click", () => {
        customText.value = practiceText;
        editorDrawer.classList.remove("open");
        typingInput.focus({ preventScroll: true });
        updateVisualViewport();
        ensureCaretVisible();
      });

      document.getElementById("applyText").addEventListener("click", () => {
        const nextText = customText.value.replace(/\r\n/g, "\n");
        if (!nextText.trim()) {
          customText.focus({ preventScroll: true });
          customText.setCustomValidity("Enter some practice text.");
          customText.reportValidity();
          return;
        }

        customText.setCustomValidity("");
        practiceText = PrefixEditor.normalize(nextText);
        editorDrawer.classList.remove("open");
        resetSession({ reason: "practice-text-changed" });
        updateVisualViewport();
      });

      window.addEventListener("pagehide", () => {
        finalizeRecording("pagehide");
        flushPending();
        releaseOwner?.();
      });
      window.addEventListener("pageshow", event => {
        if (event.persisted && !releaseOwner) ownerReady = holdOwnerLock();
      });

      window.addEventListener("resize", updateVisualViewport);
      window.addEventListener("orientationchange", () => {
        window.setTimeout(() => {
          initialViewportHeight = Math.max(
            window.innerHeight,
            window.visualViewport ? window.visualViewport.height : 0
          );
          updateVisualViewport();
        }, 250);
      });

      if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", updateVisualViewport);
        window.visualViewport.addEventListener("scroll", updateVisualViewport);
      }

      window.PrefixType = {
        editor: typingInput,
        flush: flushWrites,
        getAllSessions, getEventsForSession, getSensorSamplesForSession, buildDailyRecord, encodePtbox,
        reset: (text = practiceText) => { practiceText = text; customText.value = text; resetSession({ focus: false }); },
        finalize: finalizeRecording,
        get stats() { return { totalInserted, correctInserted, finished: finishedAt !== null }; }
      };
      updateVisualViewport();
      resetSession({ focus: false, reason: "initialization" });
    })();
