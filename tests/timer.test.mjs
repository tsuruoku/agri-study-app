import { test } from "node:test";
import assert from "node:assert/strict";
import { createStudyTimer } from "../web/timer.js";

// Fake environment: manual clock, scripted visibility/lock behaviour.
function fakeEnv({ locked = true, visible = true, focused = true } = {}) {
  const listeners = {};
  const env = {
    locks: locked === null ? undefined : {
      async request(_name, _opts, cb) {
        if (!locked) return cb(null);
        let release;
        const held = new Promise(r => (release = r));
        env._release = release;
        return cb({ release: () => release() });
      },
    },
    doc: {
      visibilityState: visible ? "visible" : "hidden",
      hasFocus: () => focused,
      addEventListener: (t, fn) => ((listeners["doc:" + t] ??= []).push(fn)),
    },
    win: {
      addEventListener: (t, fn) => ((listeners["win:" + t] ??= []).push(fn)),
    },
    _fire(name) {
      for (const fn of listeners[name] || []) fn();
    },
  };
  return env;
}

function fakeClock() {
  let mono = 0;
  let wall = 1_700_000_000_000;
  const tickFns = [];
  return {
    mono: () => mono,
    wall: () => wall,
    elapse(ms, wallMs = ms) {
      mono += ms;
      wall += wallMs;
    },
    setTick: fn => {
      tickFns.push(fn);
      return { cancel: () => tickFns.splice(tickFns.indexOf(fn), 1) };
    },
    async advance(ms) {
      mono += ms;
      wall += ms;
      for (const fn of [...tickFns]) fn();
      await new Promise(r => setTimeout(r, 0)); // flush async emit/save work
    },
  };
}

function makeTimer(opts = {}) {
  const clock = fakeClock();
  const env = opts.env ?? fakeEnv(opts);
  const segments = [];
  const failedIds = opts.failIds ?? new Set();
  const states = [];
  const timer = createStudyTimer({
    clock,
    env,
    onState: s => states.push(s),
    onSegment: async seg => {
      if (failedIds.has(seg.id)) throw new Error("save failed");
      segments.push(seg);
    },
  });
  return { timer, clock, env, segments, states };
}

function totalSaved(segments) {
  return segments.reduce((n, s) => n + s.seconds, 0);
}

test("2 seconds visible produces 2 seconds of saved time", async () => {
  const t = makeTimer();
  await t.timer.ready;
  t.timer.setMode("lesson");
  await t.clock.advance(2000);
  assert.ok(totalSaved(t.segments) >= 2 - 0.001 && totalSaved(t.segments) <= 2.001,
    `expected ~2s, got ${totalSaved(t.segments)}`);
});

test("a 1-hour suspended callback counts at most 5 seconds", async () => {
  const t = makeTimer();
  await t.timer.ready;
  t.timer.setMode("lesson");
  await t.clock.advance(60 * 60 * 1000);
  assert.ok(totalSaved(t.segments) <= 5.001, `expected <=5s, got ${totalSaved(t.segments)}`);
});

test("hidden time is not counted; resume starts a fresh interval", async () => {
  const t = makeTimer();
  await t.timer.ready;
  t.timer.setMode("quiz");
  await t.clock.advance(2000);
  const before = totalSaved(t.segments);
  // Go hidden for a long wall time.
  t.env.doc.visibilityState = "hidden";
  t.env._fire("doc:visibilitychange");
  await t.clock.advance(60000);
  assert.equal(totalSaved(t.segments), before, "hidden duration must not be counted");
  // Resume: no catch-up, only new visible time counts.
  t.env.doc.visibilityState = "visible";
  t.env._fire("doc:visibilitychange");
  await t.clock.advance(2000);
  assert.ok(totalSaved(t.segments) <= before + 5.001);
});

test("without the timing lock nothing is counted", async () => {
  const t = makeTimer({ locked: false });
  await t.timer.ready;
  t.timer.setMode("lesson");
  await t.clock.advance(5000);
  assert.equal(totalSaved(t.segments), 0);
  assert.ok(t.states.includes("blocked"));
});

test("pause stops counting", async () => {
  const t = makeTimer();
  await t.timer.ready;
  t.timer.setMode("lesson");
  await t.clock.advance(2000);
  t.timer.setPaused(true);
  const before = totalSaved(t.segments);
  await t.clock.advance(4000);
  assert.equal(totalSaved(t.segments), before);
});

test("failed segment saves retry with the same stable id", async () => {
  const t = makeTimer();
  await t.timer.ready;
  const attempted = [];
  let fails = 1;
  const timer2 = createStudyTimer({
    clock: t.clock,
    env: t.env,
    onState: () => {},
    onSegment: async seg => {
      attempted.push(seg.id);
      if (fails-- > 0) throw new Error("boom");
    },
  });
  await timer2.ready;
  timer2.setMode("lesson");
  await t.clock.advance(2000); // first emit fails
  await t.clock.advance(2000); // retry emits the same id again
  assert.ok(attempted.length >= 2, `expected a retry, got ${JSON.stringify(attempted)}`);
  assert.equal(attempted[0], attempted[1], "retry must reuse the stable segment id");
});

test("mode null produces no segments; stop flushes and halts", async () => {
  const t = makeTimer();
  await t.timer.ready;
  await t.clock.advance(3000);
  assert.equal(t.segments.length, 0);
  t.timer.setMode("lesson");
  await t.clock.advance(2000);
  const saved = totalSaved(t.segments);
  t.timer.stop();
  await t.clock.advance(5000);
  assert.ok(totalSaved(t.segments) <= saved + 5.001);
});

test("leaving a lesson captures its final second under the old mode", async () => {
  const t = makeTimer();
  await t.timer.ready;
  t.timer.setMode("lesson");
  t.clock.elapse(1000);
  t.timer.setMode(null);
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(t.segments.map(s => [s.mode, s.seconds]), [["lesson", 1]]);
});

test("mode changes split lesson and quiz intervals before asynchronous saving", async () => {
  const t = makeTimer();
  await t.timer.ready;
  t.timer.setMode("lesson");
  t.clock.elapse(1000);
  t.timer.setMode("quiz");
  await t.clock.advance(2000);
  assert.deepEqual(t.segments.map(s => [s.mode, s.seconds]), [["lesson", 1], ["quiz", 2]]);
});

test("time after a capped suspension uses current wall time, not a stale date", async () => {
  const t = makeTimer();
  await t.timer.ready;
  t.timer.setMode("lesson");
  await t.clock.advance(86_400_000);
  await t.clock.advance(2000);
  assert.equal(totalSaved(t.segments), 7);
  assert.equal(t.segments.at(-1).end, 1_700_086_402_000);
  assert.equal(t.segments.at(-1).start, 1_700_086_400_000);
});

test("clock rollback does not assign new time to a future calendar date", async () => {
  const t = makeTimer();
  await t.timer.ready;
  t.timer.setMode("lesson");
  t.clock.elapse(2000, -86_400_000);
  await t.clock.advance(0);
  assert.equal(totalSaved(t.segments), 2);
  assert.equal(t.segments[0].end, 1_699_913_600_000);
});

test("initially unfocused pages do not count study time", async () => {
  const t = makeTimer({ focused: false });
  await t.timer.ready;
  t.timer.setMode("lesson");
  await t.clock.advance(2000);
  assert.equal(totalSaved(t.segments), 0);
});

test("flush persists the current partial interval before creating a backup", async () => {
  const t = makeTimer();
  await t.timer.ready;
  t.timer.setMode("lesson");
  t.clock.elapse(750);
  assert.equal(typeof t.timer.flush, "function");
  await t.timer.flush();
  assert.equal(totalSaved(t.segments), 0.75);
});

test("explicit retry works while no learning screen is active", async () => {
  const clock = fakeClock();
  const env = fakeEnv();
  let fail = true;
  const saved = [];
  const timer = createStudyTimer({
    clock, env,
    onSegment: async s => {
      if (fail) throw new Error("disk full");
      saved.push(s);
    },
  });
  await timer.ready;
  timer.setMode("quiz");
  await clock.advance(2000);
  timer.setMode(null);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(timer.pendingCount(), 1);
  fail = false;
  assert.equal(typeof timer.retry, "function");
  await timer.retry();
  assert.equal(timer.pendingCount(), 0);
  assert.equal(totalSaved(saved), 2);
});

test("slow persistence cannot relabel elapsed lesson time after navigation", async () => {
  const clock = fakeClock();
  let release;
  const gate = new Promise(r => { release = r; });
  const saved = [];
  const timer = createStudyTimer({
    clock, env: fakeEnv(),
    onSegment: async s => { await gate; saved.push(s); },
  });
  await timer.ready;
  timer.setMode("lesson");
  await clock.advance(2000);
  clock.elapse(1000);
  timer.setMode(null);
  release();
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(saved.map(s => [s.mode, s.seconds]), [["lesson", 2], ["lesson", 1]]);
});

test("first state during pending lock acquisition is not 'blocked'", async () => {
  const env = fakeEnv();
  const deferred = [];
  env.locks = {
    request: (_n, _o, cb) => { deferred.push(cb); return new Promise(() => {}); },
  };
  const t = makeTimer({ env });
  await t.timer.ready;
  assert.ok(t.states.length >= 1);
  assert.notEqual(t.states[0], "blocked",
    `pre-acquisition state must not blame another tab, got ${t.states[0]}`);
});

test("after blur a counting tab reports 'idle', not 'blocked'", async () => {
  const t = makeTimer();
  await t.timer.ready;
  t.timer.setMode("lesson");
  await t.clock.advance(1000);
  t.env._fire("win:blur");
  await new Promise(r => setTimeout(r, 0));
  assert.equal(t.states.at(-1), "idle",
    `blur must not claim another tab is timing, got ${t.states.at(-1)}`);
});

test("lock denied → 'blocked'; reacquired after refocus → 'counting'", async () => {
  const env = fakeEnv();
  let grant = false;
  env.locks = {
    request: (_n, _o, cb) => Promise.resolve().then(() => cb(grant ? {} : null)),
  };
  const t = makeTimer({ env });
  await t.timer.ready;
  t.timer.setMode("lesson");
  await t.clock.advance(100);
  assert.equal(t.states.at(-1), "blocked",
    `denied lock must report 'blocked', got ${t.states.at(-1)}`);
  // Other holder released: this tab blurs then refocuses and acquires.
  grant = true;
  t.env._fire("win:blur");
  await new Promise(r => setTimeout(r, 0));
  t.env._fire("win:focus");
  await t.clock.advance(500);
  assert.equal(t.states.at(-1), "counting",
    `reacquired lock must report 'counting', got ${t.states.at(-1)}`);
});
