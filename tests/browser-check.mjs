// Chrome smoke check via CDP (Node 25 WebSocket, no dependencies).
// Drives the real app served at http://127.0.0.1:4173/ — requires
// `node scripts/serve.mjs` running and a built dist/.
// Usage: node tests/browser-check.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePackage } from "./fixture.mjs";

const APP = "http://127.0.0.1:4173/";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = 9223;
const results = [];
const ok = (name, pass, extra = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wsFor(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pend = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  return (method, params = {}) => new Promise(res => {
    const i = ++id;
    pend.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}

async function pageWs() {
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const page = list.find(t => t.type === "page");
  return { call: await wsFor(page.webSocketDebuggerUrl), targetId: page.id };
}

async function evaljs(call, expr) {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description ?? "eval error" };
  return r.result?.result?.value;
}

const profile = mkdtempSync(join(tmpdir(), "agri-chrome-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`, "--no-first-run", "about:blank",
], { stdio: "ignore" });

try {
  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    await sleep(250);
    try { page = await pageWs(); } catch {}
  }
  const call = page.call;
  await call("Page.enable");
  await call("Runtime.enable");

  // 0. Responsive: no horizontal overflow at 320/380/1280
  for (const w of [320, 380, 1280]) {
    await call("Emulation.setDeviceMetricsOverride", { width: w, height: 1200, deviceScaleFactor: 1, mobile: w < 500 });
    await call("Page.navigate", { url: APP });
    await sleep(1400);
    const m = await evaljs(call, `({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth})`);
    ok(`no horizontal overflow at ${w}px`, m && m.sw <= m.cw, JSON.stringify(m));
  }

  await call("Emulation.setDeviceMetricsOverride", { width: 380, height: 1400, deviceScaleFactor: 1, mobile: true });
  await call("Page.navigate", { url: APP });
  await sleep(2500);

  // 1. Empty state renders, no fake counts
  const empty = await evaljs(call, `document.getElementById('app').innerText`);
  ok("empty state shows import CTA", /教材ファイルを読み込む/.test(empty) && !/42%|12分|8時間/.test(empty));

  // 2. SW registered
  const swState = await evaljs(call, `navigator.serviceWorker.getRegistration().then(r => ({has: !!r, scope: r && r.scope}))`);
  ok("service worker registered", !!swState?.has);

  // 3. Import fixture pack through the real file flow
  const pkgJson = JSON.stringify(await makePackage());
  const importOk = await evaljs(call, `(async () => {
    const f = new File([${JSON.stringify(pkgJson)}], 'fixture.agristudy', { type: 'application/json' });
    await window.__agri.importFile(f);
    await new Promise(r => setTimeout(r, 400));
    const dlg = document.querySelector('dialog#overlay');
    if (!dlg) return 'no-dialog';
    const btn = [...dlg.querySelectorAll('button')].find(b => b.textContent === '取り込む');
    if (!btn) return 'no-confirm-button';
    btn.click();
    await new Promise(r => setTimeout(r, 800));
    return window.__agri.state();
  })()`);
  ok("pack imported via file flow (native dialog)", importOk?.pack?.id === "fixture-pack", JSON.stringify(importOk?.pack ?? importOk));

  // 4. Home shows the real fixture counts (6 verified questions)
  const homeText = await evaljs(call, `document.getElementById('app').innerText`);
  ok("home shows concrete real stats", /登録 6問/.test(homeText) && /定着 0問/.test(homeText));

  // 5. Double-submit must record exactly one attempt; figure pre-answer if imageId
  const answered = await evaljs(call, `(async () => {
    const cta = [...document.querySelectorAll('button')].find(b => b.textContent === 'ランダムに5問解く');
    if (!cta) return 'no-cta';
    cta.click();
    await new Promise(r => setTimeout(r, 700));
    const st0 = window.__agri.state();
    const fig = !!document.querySelector('figure img[alt="問題の図"]');
    const figExpected = st0.quiz && st0.quiz.currentImageId !== null;
    if (fig !== figExpected) return 'figure-mismatch:' + JSON.stringify(st0.quiz);
    const opt = document.querySelector('.opt');
    if (!opt) return 'no-options';
    opt.click();
    await new Promise(r => setTimeout(r, 150));
    const submit = [...document.querySelectorAll('button')].find(b => b.textContent === '回答する');
    submit.click();
    submit.click(); // double-tap must not double-record
    await new Promise(r => setTimeout(r, 700));
    const s = window.__agri.state();
    const revealed = document.getElementById('app').innerText.includes('正解');
    return { attempts: s.attempts, revealed, saving: s.quiz?.saving };
  })()`);
  ok("double-submit records exactly one attempt + reveals key", answered?.attempts === 1 && answered?.revealed === true, JSON.stringify(answered));

  // 5b. Lesson small-quiz flow: lesson → 小テスト → answer all → result → 次の節へ
  const lessonQuiz = await evaljs(call, `(async () => {
    const log = {};
    const nav = [...document.querySelectorAll('#nav button')].find(b => /演習/.test(b.textContent));
    nav?.click(); await new Promise(r => setTimeout(r, 400));
    [...document.querySelectorAll('#app button')].find(b => /この演習を終了する/.test(b.textContent))?.click();
    await new Promise(r => setTimeout(r, 400));
    const navL = [...document.querySelectorAll('#nav button')].find(b => /教材|学習/.test(b.textContent));
    navL?.click(); await new Promise(r => setTimeout(r, 500));
    const item = [...document.querySelectorAll('button.list-item')].find(b => b.textContent.includes('テスト節A1'));
    if (!item) return 'no-lesson';
    item.click(); await new Promise(r => setTimeout(r, 600));
    const cta = [...document.querySelectorAll('#app button')].find(b => /この節の小テストを解く/.test(b.textContent));
    if (!cta) return 'no-cta:' + document.getElementById('app').innerText.slice(0, 120);
    log.cta = cta.textContent;
    cta.click(); await new Promise(r => setTimeout(r, 800));
    log.header = /小テスト：テスト節A1/.test(document.getElementById('app').innerText);
    for (let i = 0; i < 5; i++) {
      const st = window.__agri.state();
      if (!st.quiz) break;
      if (!st.quiz.answered) {
        document.querySelector('#app button.opt')?.click();
        await new Promise(r => setTimeout(r, 200));
        [...document.querySelectorAll('#app button')].find(b => /回答する/.test(b.textContent))?.click();
        await new Promise(r => setTimeout(r, 500));
      }
      const next = [...document.querySelectorAll('#app button')].find(b => /次の問題へ|結果を見る/.test(b.textContent));
      if (!next) break;
      next.click();
      await new Promise(r => setTimeout(r, 500));
    }
    const res = document.getElementById('app').innerText;
    log.result = { back: /解説に戻る/.test(res), again: /この節の小テストをもう一度/.test(res),
                   next: /次の節へ：テスト節A2/.test(res), home: /ホームへ/.test(res) };
    const nextBtn = [...document.querySelectorAll('#app button')].find(b => /次の節へ/.test(b.textContent));
    if (!nextBtn) return { ...log, error: 'no next button' };
    nextBtn.click(); await new Promise(r => setTimeout(r, 700));
    log.nextLesson = document.getElementById('app').innerText.includes('テスト節A2');
    return log;
  })()`);
  ok("lesson 小テスト: header → answer all → result nav → 次の節へ opens next lesson",
    lessonQuiz?.header === true && lessonQuiz?.result?.back === true && lessonQuiz?.result?.again === true &&
    lessonQuiz?.result?.next === true && lessonQuiz?.result?.home === true && lessonQuiz?.nextLesson === true,
    JSON.stringify(lessonQuiz));

  // 6. Backup roundtrip: export → replace with same data → records survive
  const roundtrip = await evaljs(call, `(async () => {
    const backup = await window.__agri.exportBackup();
    const parsed = JSON.parse(backup);
    const expected = window.__agri.state().attempts;
    if (parsed.kind !== 'backup' || parsed.records.attempts.length !== expected) return 'bad-export';
    await window.__agri.store.replace({
      pack: parsed.pack, attempts: parsed.records.attempts,
      segments: parsed.records.segments, sessions: parsed.records.sessions.map(x => ({...x, finished: true})),
      settings: parsed.records.settings,
    });
    const snap = await window.__agri.store.load();
    return { attempts: snap.attempts.length, expected, pack: snap.pack.id };
  })()`);
  ok("backup export→restore roundtrip keeps records", roundtrip?.attempts === roundtrip?.expected && roundtrip?.attempts >= 1 && roundtrip?.pack === "fixture-pack", JSON.stringify(roundtrip));

  // 7. Bad import must leave current pack untouched
  const badImport = await evaljs(call, `(async () => {
    const f = new File(['{"format":"agri-study","schema":1,"kind":"content","pack":{"id":"x"}}'], 'bad.agristudy', { type: 'application/json' });
    await window.__agri.importFile(f);
    await new Promise(r => setTimeout(r, 400));
    return { state: window.__agri.state(), notice: document.getElementById('app').innerText.includes('読み込めません') };
  })()`);
  ok("bad import preserves installed pack + shows error", badImport?.state?.pack?.id === "fixture-pack" && badImport?.notice === true, JSON.stringify(badImport?.state?.pack));

  // 8. Records view renders totals
  const rec = await evaljs(call, `(async () => {
    [...document.querySelectorAll('#nav button')].find(b => b.textContent === '記録').click();
    await new Promise(r => setTimeout(r, 400));
    const txt = document.getElementById('app').innerText;
    return { hasTotals: /今日/.test(txt) && /累計/.test(txt) && /今週/.test(txt) && /今月/.test(txt) };
  })()`);
  ok("records view shows all time totals", rec?.hasTotals === true);

  // 9. Settings view renders real nodes (regression: no [object …] text)
  const settings = await evaljs(call, `(async () => {
    [...document.querySelectorAll('#nav button')].find(b => b.textContent === '設定').click();
    await new Promise(r => setTimeout(r, 400));
    const txt = document.getElementById('app').innerText;
    return { bad: txt.includes('[object'), hasPack: txt.includes('テスト用教材パック'), hasCoverage: txt.includes('収録範囲') };
  })()`);
  ok("settings renders real content (no stringified nodes)", settings?.bad === false && settings?.hasPack === true, JSON.stringify(settings));

  // 10. Offline reload boots from SW cache
  await call("Network.enable");
  await call("Network.emulateNetworkConditions", { offline: true, latency: 0, throughput: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await call("Page.navigate", { url: APP });
  await sleep(3000);
  const off = await evaljs(call, `({ text: document.getElementById('app').innerText.slice(0, 200), state: window.__agri ? window.__agri.state() : null })`);
  ok("offline reload boots app + saved pack", !!off?.state?.pack && /定着|学習時間/.test(off?.text ?? ""), JSON.stringify(off?.state?.pack));
  await call("Network.emulateNetworkConditions", { offline: false, latency: 0, throughput: -1, downloadThroughput: -1, uploadThroughput: -1 });

  // 11. Screenshot evidence
  const shot = await call("Page.captureScreenshot", { format: "png" });
  if (shot.result?.data) writeFileSync("artifacts/browser-check-home.png", Buffer.from(shot.result.data, "base64"));

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
  process.exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error("browser-check error:", e);
  process.exitCode = 1;
} finally {
  chrome.kill("SIGTERM");
}
