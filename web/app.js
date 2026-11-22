// Agri study PWA — DOM rendering and event orchestration.
// All imported (pack / record) strings are rendered via textContent only.
// No HTML is ever built from imported content.

import { openStore } from "./storage.js";
import { readPackage, serializeBackup, validateStoredPack } from "./package.js";
import {
  mastery,
  progress,
  pickQuestions,
  pickLessonQuiz,
  timeTotals,
  formatTime,
  examLabel,
} from "./core.js";
import { createStudyTimer } from "./timer.js";
import { el, t, card } from "./dom.js";

const $app = document.getElementById("app");
const $nav = document.getElementById("nav");

// ---------- app state ----------
const state = {
  store: null,
  pack: null,
  attempts: [],
  segments: [],
  sessions: [],
  settings: { examDate: null, resumeLessonId: null, resumeScroll: 0, lastBackupAt: null },
  view: "home",
  lessonId: null,
  lessonCat: "all",
  quiz: null, // {session, selected, answered, lastCorrect, saving, saveError, attempt}
  timerState: "idle",
  paused: false,
  reg: null,
  updateWaiting: false,
  expectingReload: false,
  swReady: false,
  cacheOk: false,
  packCorrupt: false,
  blobs: new Map(), // assetId -> objectURL
  notice: null,
};

const timer = createStudyTimer({
  onState: s => {
    state.timerState = s;
    if (state.view === "home" || state.view === "settings") render();
  },
  onSegment: async seg => {
    await state.store.saveSegment(seg);
    state.segments = dedupeById([...state.segments, seg]);
  },
});

function dedupeById(list) {
  return [...new Map(list.map(x => [x.id, x])).values()];
}

async function refresh() {
  const snap = await state.store.load();
  state.pack = snap.pack;
  state.attempts = snap.attempts;
  state.segments = dedupeById(snap.segments);
  state.sessions = snap.sessions;
  state.settings = snap.settings;
}

function setView(view, extra = {}) {
  // Notices deliberately survive view changes so import/validation errors and
  // empty-filter messages are still visible on the destination screen; they
  // are replaced by the next notice or dismissed by the user.
  Object.assign(state, extra, { view });
  timer.setMode(view === "lesson" ? "lesson" : view === "quiz-question" ? "quiz" : null);
  maybeOfferUpdate();
  render();
}

function questionsById() {
  return new Map((state.pack?.questions ?? []).map(q => [q.id, q]));
}

function currentQuestion() {
  if (!state.quiz) return null;
  const qref = state.quiz.session.questions[state.quiz.session.index];
  return questionsById().get(qref?.id) ?? null;
}

function assetsUrl(assetId) {
  const a = (state.pack?.assets ?? []).find(x => x.id === assetId);
  if (!a) return null;
  if (!state.blobs.has(assetId)) {
    const bin = atob(a.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    state.blobs.set(assetId, URL.createObjectURL(new Blob([bytes], { type: a.mime })));
  }
  return state.blobs.get(assetId);
}

function releaseBlobs() {
  for (const url of state.blobs.values()) URL.revokeObjectURL(url);
  state.blobs.clear();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function verifiedQuestions() {
  return (state.pack?.questions ?? []).filter(q => q.verified);
}

function openSession() {
  return state.sessions.find(s => !s.finished) ?? null;
}

// ---------- import / restore ----------
function filePicker(accept, onFile) {
  const input = el("input", { type: "file", accept, style: "display:none" });
  input.addEventListener("change", () => {
    const f = input.files[0];
    if (f) onFile(f);
  });
  document.body.append(input);
  input.click();
  setTimeout(() => input.remove(), 60000);
}

async function importPack(file) {
  try {
    const validated = await readPackage(file);
    if (validated.kind !== "content" && validated.kind !== "backup") throw new Error("kind");
    showImportPreview(validated, file.name);
  } catch (e) {
    state.notice = { kind: "error", text: `ファイルを読み込めませんでした：${e.message}` };
    render();
  }
}

function showImportPreview(validated, filename) {
  const p = validated.pack;
  const verifiedQ = p.questions.filter(q => q.verified).length;
  const pendingLessons = p.lessons.filter(l => !l.verified).length +
    p.coverage.pages.filter(x => x.status === "pending").length;
  dialog([
    el("h2", { text: "教材を取り込みます" }),
    el("p", { class: "muted", text: filename ?? "" }),
    el("p", { text: `${p.title}（版 ${p.version}）` }),
    el("p", { class: "small", text: `節 ${p.lessons.length} / 問題 ${p.questions.length}（有効 ${verifiedQ}）/ 画像 ${p.assets.length}件` }),
    pendingLessons ? el("p", { class: "small", text: `未整備 ${pendingLessons}件（演習の対象外として表示します）` }) : null,
    el("p", { class: "small", text: "現在の学習記録は残ります。教材だけが置き換わります。" }),
    el("div", { class: "row" }, [
      el("button", { class: "primary", onclick: async () => {
        try {
          await state.store.install(p);
          releaseBlobs();
          await refresh();
          closeDialog();
          state.notice = { kind: "ok", text: "教材を取り込みました" };
          setView("home");
        } catch (e) {
          closeDialog();
          state.notice = {
            kind: "error",
            text: /installed pack differs/.test(e.message)
              ? "別の教材パックなので取り込めません（記録が混ざるのを防ぐため）。現在のデータをバックアップしてから「復元」で切り替えてください。"
              : `保存に失敗しました：${e.message}`,
          };
          render();
        }
      } }, "取り込む"),
      el("button", { class: "ghost", onclick: closeDialog }, "やめる"),
    ]),
  ]);
}

function showRestorePreview(validated, filename) {
  const r = validated.records;
  dialog([
    el("h2", { text: "バックアップから復元します" }),
    el("p", { class: "muted", text: filename ?? "" }),
    el("p", { class: "small", text: `教材 ${validated.pack.title} / 回答 ${r.attempts.length}件 / 区間 ${r.segments.length}件 / 演習 ${r.sessions.length}件` }),
    el("p", { class: "notice", text: "現在の記録はすべて置き換わります。実行前に現在のバックアップを保存することをおすすめします。" }),
    el("div", { class: "row" }, [
      el("button", { class: "accent", onclick: async () => {
        try {
          const sessions = r.sessions.map(s => ({ ...s, finished: true }));
          await state.store.replace({ pack: validated.pack, attempts: r.attempts, segments: r.segments, sessions, settings: r.settings });
          releaseBlobs();
          await refresh();
          closeDialog();
          state.notice = { kind: "ok", text: "バックアップから復元しました" };
          setView("home");
        } catch (e) {
          state.notice = { kind: "error", text: `復元に失敗しました：${e.message}` };
          closeDialog();
          render();
        }
      } }, "すべて置き換えて復元"),
      el("button", { class: "ghost", onclick: closeDialog }, "やめる"),
    ]),
  ]);
}

async function downloadBackup() {
  // Capture any partial in-flight interval and drain queued writes first so
  // the snapshot reflects the newest measurable time.
  try {
    await timer.flush();
  } catch {
    /* flush resolves even when writes fail — pendingCount below is authoritative */
  }
  const pending = timer.pendingCount();
  let snap;
  try {
    snap = await state.store.load();
  } catch (e) {
    state.notice = { kind: "error", text: `記録を読み出せずバックアップできません：${e.message}` };
    render();
    return;
  }
  const text = serializeBackup({
    pack: snap.pack,
    attempts: snap.attempts,
    segments: snap.segments,
    sessions: snap.sessions,
    settings: snap.settings,
  });
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `agri-study-backup-${new Date().toISOString().slice(0, 10)}.agristudy` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  // Triggering a download does not prove the file was kept — say so plainly.
  if (pending > 0) {
    state.notice = { kind: "error", text: `バックアップを開始しましたが、保存できていない計測が${pending}件あります。「再送」で保存してから取り直してください。` };
  } else {
    state.notice = { kind: "ok", text: "バックアップのダウンロードを開始しました。ファイルが保存されたか確認してください。" };
  }
  try {
    const settings = { ...state.settings, lastBackupAt: Date.now() };
    state.settings = settings;
    await state.store.saveSettings(settings);
  } catch (e) {
    state.notice = { kind: "error", text: `バックアップ時刻の記録に失敗しました：${e.message}` };
  }
  render();
}

// ---------- dialog ----------
// Native <dialog>: modal focus trapping and Escape-to-close come for free.
function dialog(children) {
  closeDialog();
  const box = el("dialog", { class: "dialog", id: "overlay" }, children);
  box.addEventListener("click", e => {
    if (e.target === box) box.close();
  });
  document.body.append(box);
  box.showModal();
  const first = box.querySelector("button");
  if (first) first.focus();
}
function closeDialog() {
  const d = document.getElementById("overlay");
  if (d?.open) d.close();
  d?.remove();
}

function openImageOverlay(title, urls, note) {
  dialog([
    el("h2", { text: title }),
    note ? el("p", { class: "notice", text: note }) : null,
    ...urls.map(u => el("img", { src: u, alt: title })),
    el("button", { class: "ghost", onclick: closeDialog }, "閉じる"),
  ]);
}

// ---------- home ----------
function viewHome() {
  const kids = [];
  const totals = timeTotals(state.segments);
  const prog = progress(state.pack?.questions ?? [], state.attempts);
  const open = openSession();

  if (!state.pack) {
    kids.push(card([
      el("h2", { text: "はじめに" }),
      el("p", { text: "教材パック（.agristudy）を読み込むと学習を始められます。ファイルはこの端末の中だけで使われ、送信されません。" }),
      el("button", { class: "primary", onclick: () => filePicker(".agristudy,application/json", importPack) }, "教材ファイルを読み込む"),
    ]));
  }

  if (open && state.pack) {
    kids.push(card([
      el("h2", { text: "途中の演習" }),
      el("p", { class: "muted", text: `${open.index + 1}問目まで進んでいます` }),
      el("button", { class: "primary", onclick: () => resumeQuiz(open) }, "続きから解く"),
    ]));
  }

  if (state.pack) {
    const cta = el("button", { class: "primary", disabled: !verifiedQuestions().length, onclick: () => startQuiz({ categoryId: "all", state: "all", kind: "all" }) }, "ランダムに5問解く");
    const resume = state.settings.resumeLessonId
      ? el("button", { class: "list-item", onclick: () => openLesson(state.settings.resumeLessonId, state.settings.resumeScroll) }, [
          el("span", { class: "muted", text: "続きから学ぶ" }),
          el("br"),
          el("span", { class: "title", text: lessonTitle(state.settings.resumeLessonId) }),
        ])
      : null;
    const quick = verifiedQuestions().length
      ? el("div", { class: "row" }, [
          el("button", { onclick: () => startQuiz({ categoryId: "all", state: "review", kind: "all" }) }, "要復習だけ"),
          el("button", { onclick: () => startQuiz({ categoryId: "all", state: "unseen", kind: "all" }) }, "未確認だけ"),
        ])
      : null;
    kids.push(card([el("h2", { text: "学習" }), cta, resume, quick]));
  }

  if (state.pack) {
    const pct = prog.percent === null ? "対象問題なし" : `${prog.percent}%`;
    kids.push(card([
      el("div", { class: "row between" }, [
        el("h2", { text: "知識の定着" }),
        el("span", { class: "small", text: "このアプリの登録問題が対象" }),
      ]),
      el("div", { class: "kv" }, [
        cell("定着", `${prog.mastered}問`),
        cell("登録", `${prog.total}問`),
        cell("未確認", `${prog.unseen}問`),
        cell("要復習", `${prog.review}問`),
      ]),
      el("p", { class: "small", text: `定着度 ${pct}（定着 ${prog.mastered}問 / 登録 ${prog.total}問）` }),
      el("div", { class: "bar" }, [el("span", { style: `width:${prog.percent ?? 0}%` })]),
    ]));
  }

  kids.push(card([
    el("div", { class: "row between" }, [
      el("h2", { text: "学習時間" }),
      el("button", { class: "ghost", onclick: togglePause, text: state.paused ? "計測を再開" : "計測を一時停止" }),
    ]),
    el("div", { class: "kv" }, [
      cell("今日", formatTime(totals.today)),
      cell("累計", formatTime(totals.total)),
      cell("今週", formatTime(totals.week)),
      cell("今月", formatTime(totals.month)),
    ]),
    el("p", { class: "small", text: timerLabel() }),
  ]));

  kids.push(card([
    el("h2", { text: "試験日" }),
    el("p", { text: examLabel(state.settings.examDate) }),
    state.settings.examDate ? el("p", { class: "small", text: "試験日は設定画面で変更できます" }) : null,
  ]));

  if (state.cacheOk && state.pack && !state.packCorrupt) {
    kids.push(card([el("span", { class: "badge-off", text: "オフライン準備完了" })]));
  }
  return kids;
}

function timerLabel() {
  switch (state.timerState) {
    case "counting": return "計測中（この端末で計測できた学習時間）";
    case "paused": return "一時停止中";
    case "blocked": return "他の画面で計測中";
    case "unsupported": return "このブラウザでは計測できません";
    default: return "学習画面を表示すると計測します";
  }
}

async function togglePause() {
  state.paused = !state.paused;
  timer.setPaused(state.paused);
  render();
}

function cell(lbl, num) {
  return el("div", { class: "cell" }, [
    el("div", { class: "num", text: num }),
    el("div", { class: "lbl", text: lbl }),
  ]);
}

function catTitle(id) {
  return (state.pack?.categories ?? []).find(c => c.id === id)?.title ?? id;
}

function lessonTitle(id) {
  return (state.pack?.lessons ?? []).find(l => l.id === id)?.title ?? "（見つかりません）";
}

// ---------- lessons ----------
function viewLessons() {
  const kids = [];
  if (!state.pack) {
    kids.push(card([
      el("p", { text: "教材がまだ読み込まれていません。" }),
      el("button", { class: "primary", onclick: () => filePicker(".agristudy,application/json", importPack) }, "教材ファイルを読み込む"),
    ]));
    return kids;
  }
  const cats = [{ id: "all", title: "すべて" }, ...state.pack.categories];
  kids.push(el("div", { class: "row", role: "tablist", "aria-label": "カテゴリ" }, cats.map(c =>
    el("button", {
      class: c.id === state.lessonCat ? "" : "ghost",
      onclick: () => { state.lessonCat = c.id; render(); },
    }, c.title)
  )));

  const lessons = state.pack.lessons.filter(l => state.lessonCat === "all" || l.categoryId === state.lessonCat);
  kids.push(el("div", { class: "list" }, lessons.map(l => {
    const qCount = state.pack.questions.filter(q => q.lessonId === l.id && q.verified).length;
    return el("button", { class: "list-item", onclick: () => openLesson(l.id) }, [
      el("span", { class: "title", text: l.title }),
      t(" "),
      l.verified ? null : el("span", { class: "tag pending", text: "未整備" }),
      el("br"),
      el("span", { class: "muted", text: `教材 p.${l.page} / 確認問題 ${qCount}問` }),
    ]);
  })));

  const pendingPages = state.pack.coverage.pages.filter(p => p.status === "pending");
  if (pendingPages.length) {
    kids.push(card([
      el("h3", { text: "未整備の範囲" }),
      el("p", { class: "small", text: "照合が終わっていないページです。問題には出題されません。" }),
      el("ul", {}, pendingPages.map(p => el("li", { class: "small", text: `p.${p.page}${p.note ? `：${p.note}` : ""}` }))),
    ]));
  }
  return kids;
}

async function openLesson(id, scroll = 0) {
  state.lessonId = id;
  // Persist the resume target immediately — leaving without scrolling must
  // still restore this lesson.
  const s = { ...state.settings, resumeLessonId: id, resumeScroll: scroll };
  state.settings = s;
  void state.store.saveSettings(s);
  setView("lesson");
  if (scroll) requestAnimationFrame(() => window.scrollTo(0, scroll));
}

function viewLesson() {
  const l = (state.pack?.lessons ?? []).find(x => x.id === state.lessonId);
  if (!l) return [card([el("p", { text: "節が見つかりません。" })])];
  const kids = [
    el("button", { class: "ghost", onclick: () => setView("lessons") }, "← 一覧へ"),
    card([
      el("p", { class: "muted", text: `${catTitle(l.categoryId)} / 教材 p.${l.page}` }),
      el("h2", { text: l.title }),
      l.verified ? null : el("p", {}, [el("span", { class: "tag pending", text: "未整備（照合中）" })]),
    ]),
  ];
  const body = card([]);
  for (const b of l.blocks) {
    if (b.type === "text") {
      body.append(el("p", { class: "lesson-text", text: b.text }));
    } else if (b.type === "image") {
      const url = assetsUrl(b.assetId);
      body.append(el("figure", { class: "figure" }, [
        url ? el("img", { src: url, alt: b.alt }) : el("p", { class: "muted", text: "画像データがありません" }),
        el("figcaption", { text: b.alt }),
      ]));
    }
  }
  const srcImgs = sourceImages(l);
  if (srcImgs.length) {
    body.append(el("button", {
      class: "ghost",
      onclick: () => dialog([
        el("h2", { text: "原本ページを開く" }),
        el("p", { class: "notice", text: "このページには例題の答えが含まれる場合があります。演習の回答前には開かないでください。" }),
        el("div", { class: "row" }, [
          el("button", { class: "primary", onclick: () => openImageOverlay(`教材 p.${l.page}（原本）`, srcImgs, null) }, "開く"),
          el("button", { class: "ghost", onclick: closeDialog }, "やめる"),
        ]),
      ]),
    }, "原本ページを開く"));
  }
  kids.push(body);
  kids.push(timerRow());

  const related = state.pack.questions.filter(q => q.lessonId === l.id && q.verified);
  kids.push(card([
    related.length
      ? el("button", { class: "primary", onclick: () => startLessonQuiz(l) }, `この節の小テストを解く（${Math.min(3, related.length)}問）`)
      : el("p", { class: "muted", text: "この節の確認問題はまだありません。" }),
  ]));
  return kids;
}

// Lesson source images come from sourceAssetIds (full original pages, opened
// only behind the warning dialog). Older packs without the field fall back to
// inline image blocks so fixtures/legacy data still work.
function sourceImages(lesson) {
  const ids = lesson?.sourceAssetIds;
  if (ids?.length) return ids.map(aid => assetsUrl(aid)).filter(Boolean);
  return (lesson?.blocks ?? []).filter(b => b.type === "image").map(b => assetsUrl(b.assetId)).filter(Boolean);
}

function lessonImages(lessonId) {
  const l = (state.pack?.lessons ?? []).find(x => x.id === lessonId);
  return l ? sourceImages(l) : [];
}

let scrollSaveTimer = null;
window.addEventListener("scroll", () => {
  if (state.view !== "lesson" || !state.lessonId) return;
  // Capture the lesson and position now; the debounced write must not read
  // whatever view is current when it fires.
  const id = state.lessonId;
  const y = window.scrollY;
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(() => {
    const s = { ...state.settings, resumeLessonId: id, resumeScroll: y };
    state.settings = s;
    void state.store.saveSettings(s);
  }, 400);
});

// Small timer status row shown inside learning screens so the user can see
// whether time is being counted — and that unsaved segments still exist.
function timerRow() {
  const pending = timer.pendingCount();
  return el("p", { class: "small", role: "status" }, [
    t(timerLabel()),
    t(" "),
    el("button", { class: "ghost", onclick: togglePause, text: state.paused ? "再開" : "一時停止" }),
    pending > 0
      ? el("button", {
          class: "ghost",
          onclick: async () => {
            await timer.retry();
            render();
          },
        }, `未保存 ${pending}件 — 再送`)
      : null,
  ]);
}

// ---------- quiz ----------
function quizSetup() {
  const kids = [];
  const open = openSession();
  if (open) {
    kids.push(card([
      el("h2", { text: "途中の演習" }),
      el("button", { class: "primary", onclick: () => resumeQuiz(open) }, `${open.index + 1}問目から再開`),
      el("button", { class: "ghost", onclick: async () => {
        await state.store.saveSession({ ...open, finished: true });
        await refresh();
        render();
      } }, "この演習を終了する"),
    ]));
  }
  const cats = [{ id: "all", title: "すべて" }, ...(state.pack?.categories ?? [])];
  kids.push(card([
    el("h2", { text: "条件を選ぶ" }),
    field("カテゴリ", cats.map(c => [c.id, c.title]), state.quizCat ?? "all", v => (state.quizCat = v)),
    field("対象", [["all", "すべて"], ["unseen", "未確認"], ["review", "要復習"]], state.quizState ?? "all", v => (state.quizState = v)),
    field("種別", [["all", "すべて"], ["example", "教材の例題"], ["original", "オリジナル確認問題"], ["past", "過去問"]], state.quizKind ?? "all", v => (state.quizKind = v)),
    el("button", { class: "primary", disabled: !state.pack || !verifiedQuestions().length, onclick: () =>
      startQuiz({ categoryId: state.quizCat ?? "all", state: state.quizState ?? "all", kind: state.quizKind ?? "all" }) }, "5問はじめる"),
    state.pack ? null : el("p", { class: "muted", text: "教材を読み込むと演習できます。" }),
  ]));
  return kids;
}

function field(label, options, current, onChange) {
  const sel = el("select", {}, options.map(([v, lbl]) =>
    el("option", { value: v, selected: v === current || undefined }, lbl)));
  sel.addEventListener("change", () => onChange(sel.value));
  return el("div", { class: "field" }, [el("label", { text: label }), sel]);
}

async function startQuiz(filters, subset = null) {
  const pool = subset ?? verifiedQuestions();
  const picked = pickQuestions(pool, state.attempts, filters);
  if (!picked.length) {
    state.notice = { kind: "error", text: "条件に合う問題がありません。条件を変えてください。" };
    setView("quiz-setup");
    return;
  }
  await launchSession(picked);
}

// Small per-lesson quiz: 3 questions from that lesson, picked by mastery
// priority (要復習 → 未確認 → 学習中 → 定着). The session carries lessonId so
// the result screen can offer section navigation.
async function startLessonQuiz(lesson) {
  const picked = pickLessonQuiz(state.pack?.questions ?? [], state.attempts, lesson.id);
  if (!picked.length) {
    state.notice = { kind: "error", text: "この節の小テストを開始できませんでした。" };
    render();
    return;
  }
  await launchSession(picked, lesson.id);
}

async function launchSession(picked, lessonId = null) {
  const ses = {
    id: newId("ses"),
    ...(lessonId ? { lessonId } : {}),
    questions: picked.map(q => ({ id: q.id, revision: q.revision })),
    index: 0,
    answers: [],
    finished: false,
  };
  try {
    await state.store.saveSession(ses);
  } catch (e) {
    state.notice = { kind: "error", text: `演習を開始できませんでした：${e.message}` };
    render();
    return;
  }
  state.sessions = dedupeById([...state.sessions, ses]);
  state.quiz = { session: ses, selected: null, answered: false, lastCorrect: null, saveError: false };
  setView("quiz-question");
}

function resumeQuiz(ses) {
  const saved = ses.answers.find(a => a.instanceId === `${ses.id}:${ses.index}`);
  const qref = ses.questions[ses.index];
  const question = questionsById().get(qref?.id);
  state.quiz = {
    session: ses,
    selected: saved?.optionId ?? null,
    answered: !!saved,
    // Derive correctness from the saved choice vs the question's key — never
    // from the UI path that produced it.
    lastCorrect: saved && question ? saved.optionId === question.correctId : null,
    saveError: false,
  };
  setView("quiz-question");
}

function viewQuizQuestion() {
  const q = state.quiz;
  const ses = q.session;
  const qid = ses.questions[ses.index];
  const question = questionsById().get(qid.id);
  const kids = [];
  if (!question) {
    return [card([el("p", { text: "問題が見つかりません（教材が更新された可能性があります）。" }),
      el("button", { class: "ghost", onclick: () => setView("quiz-setup") }, "演習に戻る")])];
  }
  const tag = question.kind === "example" ? "教材の例題" : question.kind === "past" ? "過去問" : "オリジナル確認問題";
  kids.push(card([
    el("div", { class: "row between" }, [
      el("h2", { text: ses.lessonId ? `小テスト：${lessonTitle(ses.lessonId)}` : `ミックス演習` }),
      el("span", { class: "muted", text: `${ses.index + 1}問目 / ${ses.questions.length}問` }),
    ]),
    el("p", {}, [
      el("span", { class: "tag", text: `${catTitle(question.categoryId)}・${tag}` }),
      el("span", { class: "small", text: `　教材 p.${question.page}` }),
    ]),
    el("p", { class: "lesson-text", text: question.prompt }),
  ]));
  // imageId is an answer-free crop prepared for the question — it is shown
  // BEFORE answering, always with the neutral alt text (never source
  // captions, which could leak the answer).
  if (question.imageId) {
    const url = assetsUrl(question.imageId);
    kids.push(el("figure", { class: "figure" }, [
      url ? el("img", { src: url, alt: "問題の図" }) : el("p", { class: "muted", text: "図を読み込めませんでした" }),
    ]));
  }

  const opts = el("div", { role: "group", "aria-label": "選択肢" },
    question.options.map(o => {
      const pressed = q.selected === o.id;
      const cls = q.answered
        ? o.id === question.correctId ? "opt correct" : o.id === q.selected ? "opt wrong" : "opt"
        : "opt";
      const b = el("button", { class: cls, "aria-pressed": pressed, disabled: q.answered || q.saving }, o.text);
      b.addEventListener("click", () => {
        if (q.answered || q.saving) return;
        q.selected = o.id;
        render();
      });
      return b;
    }));

  kids.push(card([opts]));

  if (!q.answered) {
    kids.push(el("button", {
      class: "primary",
      disabled: !q.selected || q.saving,
      onclick: () => submitAnswer(question),
    }, q.saving ? "保存中…" : "回答する"));
  }

  if (q.saveError) {
    kids.push(card([
      el("p", { class: "error-text", text: "回答を保存できませんでした。選択を保ったまま再試行できます。" }),
      el("button", { class: "accent", disabled: q.saving, onclick: () => submitAnswer(question) }, "保存を再試行"),
    ]));
  }

  if (q.answered) {
    const last = q.lastCorrect;
    kids.push(card([
      el("div", { class: `answer-box ${last ? "" : "wrong"}` }, [
        el("p", { text: last ? "正解です" : `不正解。正解：${question.options.find(o => o.id === question.correctId)?.text}` }),
        el("p", { class: "lesson-text", text: question.explanation }),
        el("p", { class: "small", text: `根拠：教材 p.${question.page}` }),
        lessonImages(question.lessonId).length
          ? el("button", { class: "ghost", onclick: () =>
              openImageOverlay(`教材 p.${question.page}（原本）`, lessonImages(question.lessonId), null) }, "原本ページを開く")
          : null,
      ]),
      el("button", { class: "primary", disabled: q.saving, onclick: () => nextQuestion() },
        ses.index + 1 < ses.questions.length ? "次の問題へ" : "結果を見る"),
    ]));
  }
  kids.push(timerRow());
  return kids;
}

async function submitAnswer(question) {
  const q = state.quiz;
  // Synchronous re-entry guard: a double-tap or a stray retry while a save
  // is in flight must never create a second in-flight attempt.
  if (!q || q.answered || q.saving || !q.selected) return;
  const ses = q.session;
  const instanceId = `${ses.id}:${ses.index}`;
  // Stable across retries — the same attempt object (and id) is reused so a
  // retried save can never mint a second record.
  if (!q.attempt) {
    q.attempt = {
      id: newId("att"),
      sessionId: ses.id,
      instanceId,
      questionId: question.id,
      revision: question.revision,
      optionId: q.selected,
      correct: q.selected === question.correctId,
      at: Date.now(),
    };
  }
  const newSession = {
    ...ses,
    answers: [...ses.answers.filter(a => a.instanceId !== instanceId), { instanceId, optionId: q.selected }],
  };
  q.saving = true;
  q.saveError = false;
  render();
  try {
    // Canonical record: on a duplicate the store returns what is actually
    // saved, not what we tried to write.
    const saved = await state.store.answer(q.attempt, newSession);
    // A stale save resolving after the quiz moved on must not mutate state.
    if (state.quiz !== q) return;
    q.answered = true;
    q.saving = false;
    q.lastCorrect = saved.correct;
    q.session = newSession;
    state.sessions = dedupeById([...state.sessions, newSession]);
    state.attempts = dedupeById([...state.attempts, saved]);
  } catch (e) {
    if (state.quiz !== q) return;
    // Storage failure: stay on the question with the selection intact.
    q.saving = false;
    q.saveError = true;
  }
  render();
}

async function nextQuestion() {
  const q = state.quiz;
  if (!q || q.saving) return;
  const ses = q.session;
  const next = { ...ses, index: ses.index + 1 };
  const done = next.index >= ses.questions.length ? { ...ses, finished: true } : next;
  q.saving = true;
  render();
  try {
    await state.store.saveSession(done);
  } catch (e) {
    if (state.quiz !== q) return;
    q.saving = false;
    q.saveError = false;
    state.notice = { kind: "error", text: `進行状態を保存できませんでした：${e.message}` };
    render();
    return;
  }
  if (state.quiz !== q) return;
  state.sessions = dedupeById([...state.sessions, done]);
  if (done.finished) {
    state.quiz = { session: done, selected: null, answered: true, saveError: false };
    setView("quiz-result");
    return;
  }
  state.quiz = { session: done, selected: null, answered: false, saveError: false };
  setView("quiz-question");
}

function viewQuizResult() {
  const ses = state.quiz.session;
  const qById = questionsById();
  const attemptsNow = state.attempts;
  const rows = ses.questions.map(qref => {
    const question = qById.get(qref.id);
    const inst = `${ses.id}:${ses.questions.indexOf(qref)}`;
    const att = attemptsNow.find(a => a.instanceId === inst);
    const st = question ? mastery(question, attemptsNow) : "unseen";
    return { question, correct: att?.correct, state: st };
  });
  const correctCount = rows.filter(r => r.correct).length;
  const stateLabel = { unseen: "未確認", review: "要復習", learning: "学習中", mastered: "定着" };
  const isLessonQuiz = !!ses.lessonId;
  const lessonIdx = isLessonQuiz ? (state.pack?.lessons ?? []).findIndex(l => l.id === ses.lessonId) : -1;
  const lesson = lessonIdx >= 0 ? state.pack.lessons[lessonIdx] : null;
  const nextLesson = lessonIdx >= 0 ? state.pack.lessons[lessonIdx + 1] : null;
  return [
    card([
      el("h2", { text: "この回の結果" }),
      el("p", { text: `正解 ${correctCount} / ${rows.length}問` }),
      el("p", { class: "small", text: "この回の正解数と定着の状態は別のものです。" }),
    ]),
    card([
      el("h3", { text: "問題ごとの状態" }),
      el("ul", {}, rows.map(r => el("li", { class: "small" }, [
        t(`${r.question ? r.question.prompt.slice(0, 24) : "（不明）"}… `),
        el("span", { class: "tag", text: stateLabel[r.state] ?? r.state }),
        r.correct === true ? t(" ○") : r.correct === false ? t(" ×") : null,
        isLessonQuiz && r.correct === false && r.question?.lessonId
          ? el("button", { class: "ghost", onclick: () => openLesson(r.question.lessonId) }, "解説を確認")
          : null,
      ]))),
    ]),
    ...(isLessonQuiz && lesson ? [
      el("button", { class: "primary", onclick: () => openLesson(lesson.id) }, "解説に戻る"),
      el("button", { class: "ghost", onclick: () => startLessonQuiz(lesson) }, "この節の小テストをもう一度"),
      nextLesson
        ? el("button", { class: "primary", onclick: () => openLesson(nextLesson.id) }, `次の節へ：${nextLesson.title}`)
        : null,
    ] : [
      el("button", { class: "primary", onclick: () => startQuiz({ categoryId: "all", state: "all", kind: "all" }) }, "もう5問解く"),
    ]),
    el("button", { class: "ghost", onclick: () => setView("home") }, "ホームへ"),
  ];
}

// ---------- records ----------
function viewRecords() {
  const totals = timeTotals(state.segments);
  const prog = progress(state.pack?.questions ?? [], state.attempts);
  const kids = [
    card([
      el("h2", { text: "学習時間（このアプリで計測できた時間）" }),
      el("div", { class: "kv" }, [
        cell("今日", formatTime(totals.today)),
        cell("累計", formatTime(totals.total)),
        cell("今週", formatTime(totals.week)),
        cell("今月", formatTime(totals.month)),
      ]),
    ]),
    card([
      el("h3", { text: "日別の記録" }),
      totals.daily.length
        ? el("ul", {}, totals.daily.map(d => el("li", { class: "small", text: `${d.date}：${formatTime(d.seconds)}` })))
        : el("p", { class: "muted", text: "まだ記録がありません。" }),
    ]),
    card([
      el("h3", { text: "カテゴリ別の定着" }),
      state.pack
        ? el("ul", {}, state.pack.categories.map(c => {
            const qs = verifiedQuestions().filter(q => q.categoryId === c.id);
            const p = progress(qs, state.attempts);
            return el("li", { class: "small", text: `${c.title}：定着 ${p.mastered} / ${p.total}問（${p.percent === null ? "対象なし" : p.percent + "%"}）` });
          }))
        : el("p", { class: "muted", text: "教材が未登録です。" }),
    ]),
  ];
  return kids;
}

// ---------- settings ----------
function viewSettings() {
  const kids = [];
  kids.push(card([
    el("h2", { text: "試験日" }),
    examField(),
    el("p", { class: "small", text: "定着度とは別の指標として表示します。" }),
  ]));

  kids.push(card([
    el("h2", { text: "学習時間の計測" }),
    el("button", { onclick: togglePause, text: state.paused ? "計測を再開する" : "計測を一時停止する" }),
    el("p", { class: "small", text: timerLabel() }),
  ]));

  kids.push(card([
    el("h2", { text: "教材" }),
    state.pack
      ? [
          el("p", { text: `${state.pack.title}（版 ${state.pack.version}）` }),
          el("p", { class: "small", text: `節 ${state.pack.lessons.length} / 問題 ${state.pack.questions.length} / 画像 ${state.pack.assets.length}件` }),
          coverageDetails(),
        ]
      : el("p", { class: "muted", text: "教材がまだ読み込まれていません。" }),
    el("button", { onclick: () => filePicker(".agristudy,application/json", importPack) }, "教材ファイルを取り込む"),
    el("p", { class: "small", text: "ファイルは端末内だけで使われ、送信されません。" }),
  ]));

  kids.push(card([
    el("h2", { text: "バックアップと復元" }),
    el("button", { class: state.pack ? "primary" : "", disabled: !state.pack, onclick: downloadBackup }, "バックアップを保存"),
    state.settings.lastBackupAt
      ? el("p", { class: "small", text: `前回：${new Date(state.settings.lastBackupAt).toLocaleString("ja-JP")}` })
      : el("p", { class: "small", text: "まだバックアップがありません。" }),
    el("hr", { class: "divider" }),
    el("button", { onclick: () => filePicker(".agristudy,application/json", restoreFile) }, "バックアップから復元"),
    el("p", { class: "small", text: "復元は現在の記録をすべて置き換えます。確認画面で内容を確かめてから実行します。ファイルは暗号化されていません。著作物と学習記録を含むため、保存先に注意してください。" }),
  ]));

  kids.push(card([
    el("h2", { text: "端末内の保存" }),
    storageInfo(),
    el("button", { class: "ghost", onclick: persistStorage }, "ブラウザに削除されにくい保存を要求"),
    el("p", { class: "small", text: "ブラウザのデータ消去や容量不足で記録が失われる場合があります。定期的なバックアップをおすすめします。" }),
  ]));
  return kids;
}

function coverageDetails() {
  const pages = state.pack.coverage.pages;
  const pending = pages.filter(p => p.status === "pending");
  const det = el("details", { class: "details-block" }, [
    el("summary", { text: `収録範囲と照合状況（未整備 ${pending.length}件）` }),
    el("p", { class: "small", text: state.pack.coverage.note }),
    el("ul", {}, pages.map(p =>
      el("li", { class: "small" }, [
        t(`p.${p.page} `),
        el("span", { class: `tag ${p.status === "pending" ? "pending" : ""}`, text: p.status === "pending" ? "未整備" : "照合済み" }),
        p.note ? t(` ${p.note}`) : null,
      ]))),
  ]);
  return det;
}

function examField() {
  const input = el("input", { type: "date", value: state.settings.examDate ?? "" });
  input.addEventListener("change", async () => {
    const v = input.value || null;
    const s = { ...state.settings, examDate: v };
    state.settings = s;
    await state.store.saveSettings(s);
    render();
  });
  return el("div", { class: "field" }, [input]);
}

function storageInfo() {
  const node = el("p", { class: "small", text: "確認中…" });
  navigator.storage?.estimate?.().then(e => {
    const used = e.usage ? `${Math.round(e.usage / 1024 / 1024)}MB` : "不明";
    const quota = e.quota ? `${Math.round(e.quota / 1024 / 1024)}MB` : "不明";
    node.textContent = `使用量の目安：${used} / 空きの目安：${quota}`;
  }).catch(() => {
    node.textContent = "容量情報を取得できませんでした";
  });
  return node;
}

async function persistStorage() {
  try {
    const ok = await navigator.storage.persist();
    state.notice = { kind: ok ? "ok" : "error", text: ok ? "永続化が許可されました" : "永続化は許可されませんでした" };
  } catch {
    state.notice = { kind: "error", text: "永続化を要求できませんでした" };
  }
  render();
}

async function restoreFile(file) {
  try {
    // Never overwrite records while measured time is still unsaved — flush
    // first, then refuse if the queue could not be drained.
    try { await timer.flush(); } catch { /* pendingCount is authoritative */ }
    const pending = timer.pendingCount();
    if (pending > 0) {
      state.notice = { kind: "error", text: `保存できていない計測が${pending}件あります。記録画面の「再送」で保存してから復元してください。` };
      render();
      return;
    }
    const validated = await readPackage(file);
    if (validated.kind !== "backup" || !validated.records) {
      state.notice = { kind: "error", text: "このファイルはバックアップではありません。" };
      render();
      return;
    }
    showRestorePreview(validated, file.name);
  } catch (e) {
    state.notice = { kind: "error", text: `ファイルを読み込めませんでした：${e.message}` };
    render();
  }
}

// ---------- service worker ----------
async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register("sw.js");
    state.reg = reg;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      // A reload only happens for an activation this page itself requested
      // (the user pressed 更新する outside a quiz). Any other controller
      // change just re-verifies the shell cache.
      if (state.expectingReload && state.view !== "quiz-question") {
        location.reload();
        return;
      }
      void refreshCacheCheck();
    });
    const watch = worker => {
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller && reg.waiting) {
          state.updateWaiting = true;
          maybeOfferUpdate();
          render();
        }
      });
    };
    reg.addEventListener("updatefound", () => watch(reg.installing));
    if (reg.waiting && navigator.serviceWorker.controller) {
      state.updateWaiting = true;
      maybeOfferUpdate();
      render();
    }
    await refreshCacheCheck();
  } catch {
    /* offline preview without SW support */
  }
}

async function refreshCacheCheck() {
  if (!navigator.serviceWorker.controller) return;
  const ok = await checkShellCache();
  if (ok === state.cacheOk && state.swReady) return;
  state.cacheOk = ok;
  state.swReady = true;
  if (state.view === "home") render();
}

function checkShellCache() {
  return new Promise(resolve => {
    if (!navigator.serviceWorker.controller) return resolve(false);
    const ch = new MessageChannel();
    const timeout = setTimeout(() => resolve(false), 3000);
    ch.port1.onmessage = e => {
      clearTimeout(timeout);
      resolve(!!e.data?.ok);
    };
    navigator.serviceWorker.controller.postMessage({ type: "CHECK_CACHE" }, [ch.port2]);
  });
}

// Offer the update through a notice with an explicit action. Never activated
// automatically — and never while a quiz question is on screen.
function maybeOfferUpdate() {
  if (!state.updateWaiting || !state.reg?.waiting) return;
  if (state.view === "quiz-question") {
    state.notice = { kind: "ok", text: "新しい版があります。演習終了後に更新できます。" };
    return;
  }
  state.notice = {
    kind: "ok",
    text: "新しい版があります。",
    action: { label: "更新する", onclick: applyUpdate },
  };
}

function applyUpdate() {
  const waiting = state.reg?.waiting;
  if (!waiting) return;
  if (state.view === "quiz-question") {
    state.notice = { kind: "error", text: "演習中は更新できません。終了してから更新してください。" };
    render();
    return;
  }
  state.expectingReload = true;
  waiting.postMessage({ type: "SKIP_WAITING" });
}

// ---------- render ----------
const VIEWS = [
  ["home", "ホーム"],
  ["lessons", "教材"],
  ["quiz-setup", "演習"],
  ["records", "記録"],
  ["settings", "設定"],
];

function render() {
  $app.textContent = "";
  const view = state.view;
  let kids;
  if (view === "home") kids = viewHome();
  else if (view === "lessons") kids = viewLessons();
  else if (view === "lesson") kids = viewLesson();
  else if (view === "quiz-setup") kids = quizSetup();
  else if (view === "quiz-question") kids = viewQuizQuestion();
  else if (view === "quiz-result") kids = viewQuizResult();
  else if (view === "records") kids = viewRecords();
  else if (view === "settings") kids = viewSettings();
  else kids = viewHome();

  const head = el("header", {}, [
    el("h1", { text: "野菜の学習" }),
  ]);
  $app.append(head);
  if (state.notice) {
    const n = state.notice;
    $app.append(el("div", { class: `notice-row ${n.kind === "error" ? "is-error" : ""}` }, [
      el("span", { class: n.kind === "error" ? "error-text" : "ok-text", text: n.text }),
      n.action ? el("button", { class: "ghost", onclick: () => { n.action.onclick(); } }, n.action.label) : null,
      el("button", {
        class: "ghost", "aria-label": "通知を閉じる",
        onclick: () => { state.notice = null; render(); },
      }, "閉じる"),
    ]));
  }
  for (const k of kids) $app.append(k);

  $nav.textContent = "";
  $nav.hidden = false;
  for (const [v, label] of VIEWS) {
    const navTo = v === "quiz-setup" ? "quiz-setup" : v;
    const active = (v === "quiz-setup" && (view === "quiz-setup" || view === "quiz-question" || view === "quiz-result")) ||
      view === v || (v === "lessons" && view === "lesson");
    $nav.append(el("button", {
      "aria-current": active ? "page" : null,
      onclick: () => {
        if (v === "quiz-setup") setView(state.quiz?.session && !state.quiz.session.finished && view.startsWith("quiz") ? view : "quiz-setup");
        else setView(v);
      },
    }, label));
  }
}

// ---------- boot ----------
async function boot() {
  state.store = await openStore();
  await refresh();
  // Re-validate the stored pack before offering it as ready: a corrupted
  // asset or structure must never render an "all good" state.
  if (state.pack) {
    try {
      await validateStoredPack(state.pack);
    } catch (e) {
      state.packCorrupt = true;
      state.notice = { kind: "error", text: `保存されている教材を検証できませんでした：${e.message}` };
    }
  }
  await registerSW();
  render();
  // Test/inspection handle: read-mostly access for automated checks.
  window.__agri = {
    store: state.store,
    state: () => ({
      view: state.view,
      pack: state.pack ? { id: state.pack.id, version: state.pack.version } : null,
      packCorrupt: state.packCorrupt,
      attempts: state.attempts.length,
      segments: state.segments.length,
      sessions: state.sessions.map(s => ({ id: s.id, index: s.index, finished: s.finished })),
      timerState: state.timerState,
      timerPending: timer.pendingCount(),
      quiz: state.quiz
        ? { index: state.quiz.session.index, answered: state.quiz.answered, saving: !!state.quiz.saving,
            currentImageId: currentQuestion()?.imageId ?? null }
        : null,
    }),
    importFile: f => importPack(f),
    exportBackup: async () => serializeBackup(await state.store.load()),
  };
}

boot().catch(e => {
  $app.textContent = "";
  $app.append(el("p", { class: "error-text", text: `起動できませんでした：${e.message}` }));
});
