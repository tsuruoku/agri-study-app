# Agri Study Web App Implementation Plan

> **For agentic workers:** Use the persistent implementation assistant for hands-on implementation and verification. Lead authors and checks mastery, sampling, study-time calculations, and textbook facts. Steps use checkbox syntax.

**Goal:** Build the approved Japanese, private-content, offline Android study Web app without custom certificates.
**Architecture:** Dependency-free static ES modules; only an allowlisted shell is deployable. Local `.agristudy` JSON packages contain textbook material and are imported into IndexedDB. No uploads, analytics, account, or cloud sync.
**Tech Stack:** JavaScript, CSS, IndexedDB, Service Worker, Node built-in tests, locally installed Chrome.
**Spec:** `docs/superpowers/specs/2026-11-17-agri-study-pwa-design.md` (simplified hosting revision).

## Global Constraints
- 教材・学習記録をサーバーへ送信しない。
- 外部解析SDK・広告・外部フォントは使用しない。
- 1回5問を基本とし、未確認・要復習・カテゴリを絞って演習できる。
- 正解や内容に意味のある修正をした問題は改訂番号を上げ、新版では未確認から判定する。
- `dist/` contains shell assets only. Never serve the project root containing the PDF.
- No network, deployment, certificate installation, git initialization or commit without the applicable approval.
- Use the new empty `web/` as the product boundary in this non-repository workspace; do not modify source scans or brainstorm artifacts.
- Study timing and retention are app-scoped measurements, not proof of attention or exam readiness.

## Review Focus
- Malicious imports: reject unknown schemas, oversized payloads, duplicate IDs, invalid answer references and non-image URLs without changing current data (Task 1).
- Storage failure during answer submission: remain on current question with selection intact and retry; do not silently advance (Task 3).
- Duplicate tabs and suspension: one timing owner, no catch-up interval after resume, retry stable segment IDs (Tasks 2 and 3).
- Interrupted service-worker update: keep old working shell, do not mix shell versions or activate during a quiz (Task 4).
- Deployment leakage: no source scans, textbook strings, packages, tests or backup files in shell build or shell fetch requests (Task 4).

## Files and Contracts

All paths are relative to `testapp/`.
- `web/index.html`, `web/style.css`: approved paper/leaf visual style, Japanese navigation, responsive application shell.
- `web/app.js`: DOM rendering and event orchestration. Safe text nodes, no HTML from imported content.
- `web/storage.js`: IndexedDB transactions, atomic answer/session writes, complete snapshot import/export.
- `web/package.js`: validation for the exact schema below; no executable markup.
- `web/core.js`: lead-owned pure mastery, selection and time aggregation functions.
- `web/timer.js`: browser lifecycle / Web Locks adapter using lead-owned timing rules.
- `web/sw.js`, `web/manifest.webmanifest`, `web/icons/*.svg`: offline shell and install assets.
- `scripts/build.mjs`, `scripts/serve.mjs`: allowlisted shell build, loopback-only preview.
- `tests/*.test.mjs`: Node tests; `tests/browser-check.mjs`: Chrome smoke evidence.
- `private-content/`: excluded from shell distribution; locally prepared textbook package and verification notes.
- `README.md`, `.gitignore`, `package.json`: run/test/deploy instructions, no dependencies.

Package JSON schema:
`{format:"agri-study", schema:1, kind:"content"|"backup", pack:{id,version,title,categories,lessons,questions,assets,coverage}, records?:{attempts,segments,sessions,settings}}`.
Category: `{id,title}`.
Lesson: `{id,categoryId,title,page,blocks:[{type:"text",text}|{type:"image",assetId,alt}],verified:boolean}`.
Question: `{id,revision:1,categoryId,lessonId,kind:"example"|"original",prompt,options:[{id,text}],correctId,explanation,page,imageId?:string,verified:boolean}`.
Asset: `{id,mime:"image/jpeg"|"image/png",data:base64,sha256:hex}`. Do not allow SVG or remote URLs in imported assets.
Coverage: `{pages:[{page:number,status:"verified"|"pending",note:string}],note:string}`. Pending content must be visible in UI and excluded from quiz/mastery.
Attempt: `{id,sessionId,instanceId,questionId,revision,optionId,correct:boolean,at:number}` UTC milliseconds.
Segment: `{id,start:number,end:number,seconds:number,date:"YYYY-MM-DD",zone:string,mode:"lesson"|"quiz"}`.
Session: `{id,questions:[{id,revision}],index:number,answers:[{instanceId,optionId}],finished:boolean}`.
Settings: `{examDate:string|null,resumeLessonId:string|null,resumeScroll:number,lastBackupAt:number|null}`.

Storage API: `openStore():Promise<Store>`; Store methods:
`load():Promise<{pack:null|Pack,attempts:Attempt[],segments:Segment[],sessions:Session[],settings:Settings}>`,
`install(pack):Promise<void>` (preserve records, finish existing sessions on changed pack),
`answer(attempt,session):Promise<void>` atomic and idempotent by instanceId,
`saveSession(session)`, `saveSegment(segment)`, `saveSettings(settings)`,
`replace(snapshot):Promise<void>` atomic full restore with old state retained on abort.
All methods return promises; validation occurs before mutation.

Core API (lead authored): `mastery(question,attempts)` returns `"unseen"|"review"|"learning"|"mastered"`;
`progress(questions,attempts)` returns `{total,mastered,unseen,review,percent:null|number}`;
`pickQuestions(questions,attempts,{categoryId:"all"|string,state:"all"|"unseen"|"review",kind:"all"|"example"|"original"},rng=Math.random)` returns up to five unique verified questions;
`splitSegment(start,end,seconds,mode,id,zone)` returns Segment[];
`timeTotals(segments,now)` returns `{today,week,month,total,daily:[{date,seconds}]}`;
`formatTime(seconds)` returns Japanese duration; `examLabel(date,now)` returns Japanese days label.

## Task 1: Local Content and Persistence
- [x] Write `tests/package.test.mjs` and `tests/storage.test.mjs` first. Verify a valid fixture imports; malformed/duplicate IDs, 4 or 6 options, missing correctId, unknown refs, HTTP images, invalid base64/hash, format/schema errors, >100 MiB file and >80 MiB decoded image total reject. No more than 2,000 questions/500 lessons/200 assets; any data string max 100,000 characters; payload parse cannot execute markup.
- [x] Run `node --test tests/package.test.mjs tests/storage.test.mjs`; capture expected red.
- [x] Implement `validatePackage(value):Promise<ValidatedPackage>` and `readPackage(file):Promise<ValidatedPackage>` in package.js; checksum via Web Crypto. Validate attempts and session references against the relevant question revision; preserve old-revision historical attempts with valid field types. Bounds for timestamps/durations must be finite and nonnegative.
- [x] Implement storage.js using one IndexedDB database and transactions. Inject IDB factory for browser test if necessary, not a fake production database. Test atomic rollback, duplicate answers and segments in real Chrome.
- [x] Implement `serializeBackup(snapshot):string` and download via user action; preview restore counts and require explicit replacement confirmation. Validate first; never use innerHTML for imported strings.
- [x] Re-run narrow tests; record evidence. No git actions.

## Task 2: Mastery, Sampling and Time Semantics (Lead)
- [x] Author tests first for exact 24h boundary, early repeats preserving anchor, wrong-answer reset, wrong revision ignored, no answers, inactive questions excluded, percentage truncation and empty denominator.
- [x] Run tests red before core implementation. Exact algorithm: sort relevant attempts by at then stable input order; for each incorrect set anchor=null and status=review; for correct set anchor if null and status=learning, else if at-anchor >= 86,400,000 set mastered. No expiry. Invalid/unverified question never contributes.
- [x] Define filtered sampling as full Fisher-Yates shuffle with injected rng, then slice(0,5); intersect category, state, kind and verified filters first; do not mutate input.
- [x] Author time tests for summed-before-floor formatting, midnight split, Monday/Sunday and calendar month boundaries, saved historical date labels, duplicate segment IDs, zero durations, DST/local dates. Time totals use segment.date and current local calendar dates, not UTC dates.
- [x] Implement core.js and run targeted tests. Timing adapter instructions: monotonic elapsed per tick capped at 5,000 ms; no backfill; wall clock supplies date labels only. Split a bounded accepted interval at local midnight proportionally. Persist fraction seconds; format after summing.
- [x] Author and check exact timing tests: 2s visible -> 2s; 1h suspension callback -> at most 5s; hidden/resume -> hidden duration 0; duplicate ID -> no increase; no lock -> no timing.

## Task 3: Learning UI and Browser Timer
- [x] Write browser checks for empty initial screen, import fixture, lesson display, selected answer hidden until submit, submit once, retry failed storage without advancing, reload/resume and review filter.
- [x] Implement app.js with bottom navigation Home/教材/演習/記録/設定; home CTA random 5; clear no-content import CTA. Preserve approved palette, typography and paper texture; mobile single-screen navigation, desktop centered readable content.
- [x] Use Task 1 Store and Task 2 core APIs unchanged. Show source page, question provenance, counts, current session result; read-only images use Blob URLs, revoke when replaced. Full source-page images only in reading mode with answer warning or after submission.
- [x] Implement timer.js `createStudyTimer({onSegment,onState,clock})` exposing `setMode(null|"lesson"|"quiz")`, `setPaused(bool)`, `stop()`. Use Web Locks with ifAvailable, release on hidden/blur/pagehide, reacquire on visible/focus; one owner, warning elsewhere. Queue failed segments by stable IDs and expose retry; never report unsaved seconds as saved.
- [x] Persist settings/exam date and scroll resume; no dummy user statistics. Show explanation and all images offline. Dialogs accessible, buttons >=44px, no horizontal overflow at 320/380/1280.
- [x] Run narrow browser flow and timer tests; save screenshots and console output.

## Task 4: Offline Shell, Build Safety and Final App Gate
- [x] Write tests that shell distribution has only allowlisted web files and contains no private content or source PDF. Build must fail for missing allowlisted files.
- [x] Implement build.mjs copying explicit shell allowlist into dist without traversing project root. Do not delete unknown files from existing dist; fail on unexpected preexisting entries. Serve only dist bound to 127.0.0.1:4173.
- [x] Implement sw.js versioned cache with atomic install, offline navigation fallback, explicit `SKIP_WAITING` message only outside active quiz, no automatic in-quiz reload. Cache shell assets only; never cache or request imported package over HTTP. Expose a message channel checking every shell cache entry before UI marks shell ready.
- [x] Add manifest and local icons; no network dependencies. Offline ready requires controlling worker, complete shell cache and fully validated installed pack.
- [ ] Chrome smoke: install SW, import fixture, offline reload, lesson image and question answer, local save and backup, second tab timer ownership, failed import preserves existing pack, offline relaunch; capture logs. Test update with active quiz and failed new worker install retaining old version.
- [x] Run one final complete `node --test tests/*.test.mjs`, `node scripts/build.mjs` and browser flow. Record actual results and remaining Android-only checks, never claim Android hardware verification.
- [x] README documents local preview, file import, backup safety, same-origin updates, browser data loss, and separate opt-in HTTPS publication. No hosting side effects.

## Task 5: Private Textbook Package (Lead Facts / Mechanical Preparation)
- [ ] Preserve PDF untouched; use existing local page renders. Local OCR may prepare drafts; lead checks textbook facts and question keys against scans.
- [ ] Package verified lessons/questions with exact page references and separate original/example labels. Include only answer-free question crops; full page images must never be quiz illustrations.
- [ ] Coverage lists every paper page p.105–137; pending material clearly labeled. No false complete-material claim. Do not place any private artifacts in web/ or dist/.
- [ ] Build private package locally, validate through application validator, import in browser and verify representative images and answers. Report separately if full content verification is still outstanding.

## Self-Review and Execution

Coverage: Spec 1–5 -> Tasks 1/3/5; Spec 6 -> Task 2; Spec 7 -> Tasks 2/3;
Spec 8/10 -> Task 1; Spec 9 -> Task 4; Spec 11–13 -> all task constraints.
Interfaces above are authoritative. All five Review Focus items have tests assigned.
No independent infrastructure project is required; deploy only app shell after approval.
Proceed within the current new product directory, using delegated implementation and lead review.
User requested fewer process stops; do not add another implementation-method question.
