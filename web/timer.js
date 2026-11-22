// Browser lifecycle + Web Locks adapter for study-time measurement.
// Rules (from the design): count only visible+focused+unpaused lesson/quiz
// screens owned by a single Web Lock; monotonic elapsed per callback capped
// at 5,000 ms; hidden/suspended time is never backfilled; wall clock supplies
// date labels only. Failed segment saves retry with the same stable id.

import { splitSegment } from "./core.js";

const LOCK_NAME = "agri-study-timer";
const TICK_MS = 2000;
const CAP_MS = 5000;

function defaultEnv() {
  return {
    locks: globalThis.navigator?.locks,
    doc: globalThis.document,
    win: globalThis.window,
  };
}

export function createStudyTimer({ onSegment, onState, clock, env } = {}) {
  const mono = clock?.mono ?? (() => performance.now());
  const wall = clock?.wall ?? (() => Date.now());
  const makeTick =
    clock?.setTick ??
    (fn => {
      const h = setInterval(fn, TICK_MS);
      return { cancel: () => clearInterval(h) };
    });
  const e = env ?? defaultEnv();
  const instance = `t${Math.floor(wall()).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  let mode = null;
  let paused = false;
  let stopped = false;
  let locked = false;
  let deniedByOther = false;
  let releaseHeld = null;
  let acquiring = false;
  let focused = e.doc?.hasFocus?.() ?? true;
  let tickHandle = null;
  let lastMono = 0;
  let emitWall = 0;
  let seq = 0;
  const pending = new Map(); // stable segment id -> segment awaiting retry
  let lastState = null;
  let lastPending = 0;
  let writes = Promise.resolve();

  const visible = () => (e.doc ? e.doc.visibilityState !== "hidden" : true);

  const active = () => mode !== null && !paused && locked && visible() && focused && !stopped;

  function report() {
    let s;
    if (!e.locks || !e.locks.request) s = "unsupported";
    else if (deniedByOther) s = "blocked";
    else if (paused && mode) s = "paused";
    else if (active()) s = "counting";
    else s = "idle";
    if (s !== lastState || pending.size !== lastPending) {
      lastState = s;
      lastPending = pending.size;
      onState?.(s);
    }
  }

  function startClock() {
    if (tickHandle) return;
    lastMono = mono();
    emitWall = wall();
    tickHandle = makeTick(() => {
      void emit();
    });
  }

  function stopClock() {
    if (tickHandle) {
      tickHandle.cancel();
      tickHandle = null;
    }
  }

  async function drainPending() {
    for (const seg of [...pending.values()]) {
      try {
        await onSegment(seg);
        if (pending.get(seg.id) === seg) pending.delete(seg.id);
      } catch {
        /* stays queued for the next retry */
      }
    }
    report();
  }

  function queueDrain() {
    writes = writes.then(drainPending);
    return writes;
  }

  // Capture mode and clocks synchronously: navigation or slow storage must
  // not relabel an already measured interval.
  function capture() {
    if (!tickHandle) return;
    const now = mono();
    const end = wall();
    const accepted = Math.max(0, Math.min(now - lastMono, CAP_MS)) / 1000;
    lastMono = now;
    const start = Math.min(end, Math.max(emitWall, end - accepted * 1000));
    emitWall = end;
    if (!(accepted > 0)) return;
    const id = `${instance}-${seq++}`;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    for (const seg of splitSegment(start, end, accepted, mode, id, zone)) {
      pending.set(seg.id, seg);
    }
  }

  function emit() {
    if (active()) capture();
    return queueDrain();
  }

  function deactivate() {
    // Close the current interval: elapsed since the last tick was visible time
    // and counts; time after deactivation never does.
    capture();
    stopClock();
    void queueDrain();
  }

  function update() {
    if (active()) startClock();
    else deactivate();
    report();
  }

  function acquire() {
    if (!e.locks || !e.locks.request || acquiring || locked || stopped || !visible() || !focused) return;
    acquiring = true;
    e.locks
      .request(LOCK_NAME, { ifAvailable: true }, lock => {
        acquiring = false;
        if (!lock) {
          locked = false;
          deniedByOther = true;
          report(); // 'blocked' — another tab owns timing
          return;
        }
        deniedByOther = false;
        if (stopped || !visible() || !focused) return;
        locked = true;
        update();
        return new Promise(resolve => {
          releaseHeld = resolve;
        });
      })
      .catch(() => {
        acquiring = false;
        locked = false;
        deniedByOther = false;
        report();
      });
  }

  function release() {
    deactivate();
    if (releaseHeld) {
      const r = releaseHeld;
      releaseHeld = null;
      locked = false;
      deniedByOther = false;
      r();
    }
    report();
  }

  const onVis = () => {
    if (visible()) acquire();
    else release();
  };
  const onBlur = () => {
    focused = false;
    release();
  };
  const onFocus = () => {
    focused = true;
    acquire();
  };
  const onHide = () => release();

  e.doc?.addEventListener?.("visibilitychange", onVis);
  e.win?.addEventListener?.("blur", onBlur);
  e.win?.addEventListener?.("focus", onFocus);
  e.win?.addEventListener?.("pagehide", onHide);

  const ready = Promise.resolve().then(() => {
    acquire();
    report();
  });

  return {
    ready,
    setMode(next) {
      const normalized = next === "lesson" || next === "quiz" ? next : null;
      if (normalized !== mode) deactivate();
      mode = normalized;
      update();
    },
    setPaused(value) {
      paused = !!value;
      update();
    },
    stop() {
      stopped = true;
      release();
      e.doc?.removeEventListener?.("visibilitychange", onVis);
      e.win?.removeEventListener?.("blur", onBlur);
      e.win?.removeEventListener?.("focus", onFocus);
      e.win?.removeEventListener?.("pagehide", onHide);
    },
    pendingCount() {
      return pending.size;
    },
    retry() {
      return queueDrain();
    },
    flush() {
      if (active()) capture();
      return queueDrain();
    },
  };
}
