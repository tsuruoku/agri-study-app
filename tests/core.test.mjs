import test from 'node:test';
import assert from 'node:assert/strict';
import { mastery, progress, pickQuestions, pickLessonQuiz, splitSegment, timeTotals, formatTime, examLabel } from '../web/core.js';

const DAY = 86_400_000;
const q = { id: 'q1', revision: 1, categoryId: 'tomato', kind: 'original', verified: true };
const attempt = (at, correct = true, revision = 1) => ({ questionId: q.id, revision, correct, at });
const local = (year, month, day, hour = 0, minute = 0, second = 0) =>
  new Date(year, month - 1, day, hour, minute, second).getTime();

test('mastery requires a separated second correct answer', () => {
  assert.equal(mastery(q, []), 'unseen');
  assert.equal(mastery(q, [attempt(0)]), 'learning');
  assert.equal(mastery(q, [attempt(0), attempt(DAY - 1)]), 'learning');
  assert.equal(mastery(q, [attempt(0), attempt(DAY)]), 'mastered');
});

test('early repeats do not shift anchor and unsorted history is sorted', () => {
  assert.equal(mastery(q, [attempt(DAY), attempt(0), attempt(100)]), 'mastered');
});

test('wrong answers reset even mastered questions', () => {
  assert.equal(mastery(q, [attempt(0), attempt(DAY), attempt(DAY + 1, false)]), 'review');
  assert.equal(mastery(q, [attempt(0), attempt(DAY - 1, false), attempt(DAY)]), 'learning');
  assert.equal(mastery(q, [attempt(0, false), attempt(10), attempt(DAY + 10)]), 'mastered');
});

test('revision and question identity isolate history without mutating it', () => {
  const history = [attempt(0), attempt(DAY)];
  const frozen = Object.freeze(history.map(Object.freeze));
  assert.equal(mastery({ ...q, revision: 2 }, frozen), 'unseen');
  assert.equal(mastery({ ...q, id: 'other' }, frozen), 'unseen');
  assert.equal(mastery({ ...q, verified: false }, frozen), 'unseen');
});

test('equal-timestamp attempts keep input order and invalid clocks are ignored', () => {
  assert.equal(mastery(q, [attempt(0), attempt(DAY), attempt(DAY, false)]), 'review');
  assert.equal(mastery(q, [attempt(NaN), attempt(-1), attempt(Infinity)]), 'unseen');
});

test('progress counts every verified question once, truncates and handles zero', () => {
  const questions = [q, { ...q, id: 'q2' }, { ...q, id: 'q3' }, { ...q, id: 'draft', verified: false }];
  assert.deepEqual(progress(questions, [attempt(0), attempt(DAY)]),
    { total: 3, mastered: 1, unseen: 2, review: 0, percent: 33 });
  assert.deepEqual(progress([], []),
    { total: 0, mastered: 0, unseen: 0, review: 0, percent: null });
  assert.equal(progress([q, q], []).total, 1);
});

test('sampling intersects filters, excludes drafts, has no duplicates or input mutation', () => {
  const questions = Array.from({ length: 9 }, (_, i) => ({ ...q, id: `q${i}` }));
  const original = JSON.stringify(questions);
  const all = { categoryId: 'all', state: 'all', kind: 'all' };
  const picked = pickQuestions([...questions, questions[0], { ...q, verified: false }], [], all, () => 0);
  assert.equal(picked.length, 5);
  assert.equal(new Set(picked.map(item => item.id)).size, 5);
  assert.equal(JSON.stringify(questions), original);
  assert.deepEqual(pickQuestions(questions, [], { ...all, categoryId: 'eggplant' }), []);
  assert.deepEqual(pickQuestions([q], [attempt(0, false)], { ...all, state: 'review', kind: 'original' }), [q]);
  assert.deepEqual(pickQuestions([q], [attempt(0, false)], { ...all, state: 'unseen' }), []);
  assert.deepEqual(pickQuestions([q], [], { ...all, kind: 'example' }), []);
  assert.deepEqual(pickQuestions([q], [], all, () => 1), [q]);
});

test('segments split at local midnight, preserving bounded accepted seconds', () => {
  const start = local(2026, 11, 16, 23, 59, 58);
  const end = local(2026, 11, 17, 0, 0, 3);
  const segments = splitSegment(start, end, 5, 'lesson', 's1', 'local');
  assert.equal(segments.length, 2);
  assert.deepEqual(segments.map(s => [s.date, s.seconds]), [['2026-11-16', 2], ['2026-11-17', 3]]);
  assert.equal(segments[0].end, segments[1].start);
  assert.equal(new Set(segments.map(s => s.id)).size, 2);
  assert.equal(segments[0].zone, 'local');
  assert.equal(segments.reduce((sum, s) => sum + s.seconds, 0), 5);
});

test('clock rollback still records accepted monotonic time on the current date', () => {
  const segments = splitSegment(local(2026, 11, 17, 10), local(2026, 11, 17, 9), 2, 'quiz', 'rollback', 'local');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].seconds, 2);
  assert.ok(segments[0].end >= segments[0].start);
  assert.deepEqual(splitSegment(0, 1000, 0, 'quiz', 'zero', 'UTC'), []);
});

test('totals use saved calendar labels and deduplicate IDs before summing', () => {
  const segments = [
    { id: 'old', date: '2026-10-31', seconds: 10 },
    { id: 'sun', date: '2026-11-15', seconds: 20 },
    { id: 'mon', date: '2026-11-16', seconds: 30 },
    { id: 'tue', date: '2026-11-17', seconds: 40 },
    { id: 'tue', date: '2026-11-17', seconds: 40 },
  ];
  const t = timeTotals(segments, local(2026, 11, 17, 12));
  assert.equal(t.total, 100);
  assert.equal(t.today, 40);
  assert.equal(t.week, 70);
  assert.equal(t.month, 90);
  assert.deepEqual(t.daily[0], { date: '2026-11-17', seconds: 40 });
  assert.equal(timeTotals(segments, local(2026, 11, 15, 12)).week, 20);
});

test('formatting floors only the combined seconds and never implies a completed minute', () => {
  assert.equal(formatTime(0), '0分');
  assert.equal(formatTime(59.999), '1分未満');
  assert.equal(formatTime(60), '1分');
  assert.equal(formatTime(3599), '59分');
  assert.equal(formatTime(3600), '1時間');
  assert.equal(formatTime(3660), '1時間1分');
  assert.equal(formatTime(30.5 + 30.5), '1分');
});

test('exam date uses calendar-day arithmetic, including DST boundaries and invalid dates', () => {
  assert.equal(examLabel(null, local(2026, 11, 17)), '試験日：未設定');
  assert.equal(examLabel('2026-11-17', local(2026, 11, 17, 23)), '試験当日');
  assert.equal(examLabel('2026-11-18', local(2026, 11, 17, 23)), '試験まであと1日');
  assert.equal(examLabel('2026-11-16', local(2026, 11, 17)), '試験日を過ぎています');
  assert.equal(examLabel('2026-02-30', local(2026, 1, 1)), '試験日：未設定');
  assert.equal(examLabel('2026-03-09', local(2026, 3, 8, 23)), '試験まであと1日');
});

test('pickLessonQuiz orders review → unseen → learning → mastered, lesson-scoped, verified only', () => {
  const questions = [
    { ...q, id: 'm', lessonId: 'l1' },
    { ...q, id: 'r', lessonId: 'l1' },
    { ...q, id: 'u', lessonId: 'l1' },
    { ...q, id: 'g', lessonId: 'l1' },
    { ...q, id: 'other', lessonId: 'l2' },
    { ...q, id: 'draft', lessonId: 'l1', verified: false },
  ];
  const attempts = [
    { questionId: 'm', revision: 1, correct: true, at: 0 },
    { questionId: 'm', revision: 1, correct: true, at: DAY },
    { questionId: 'r', revision: 1, correct: false, at: 10 },
    { questionId: 'g', revision: 1, correct: true, at: 0 },
  ];
  const picked = pickLessonQuiz(questions, attempts, 'l1', 4, () => 0.5);
  assert.deepEqual(picked.map(x => x.id), ['r', 'u', 'g', 'm']);
});

test('pickLessonQuiz caps at n and returns all when fewer', () => {
  const questions = [0, 1, 2, 3].map(i => ({ ...q, id: `a${i}`, lessonId: 'l1' }));
  assert.equal(pickLessonQuiz(questions, [], 'l1', 3, () => 0).length, 3);
  assert.equal(pickLessonQuiz(questions.slice(0, 2), [], 'l1', 3, () => 0).length, 2);
  assert.equal(pickLessonQuiz(questions, [], 'l1', 1, () => 0).length, 1);
  assert.deepEqual(pickLessonQuiz(questions, [], 'nope', 3), []);
});

test('pickLessonQuiz is deterministic for a given rand and random within priority', () => {
  const questions = [0, 1, 2, 3].map(i => ({ ...q, id: `a${i}`, lessonId: 'l1' }));
  const mk = vals => () => vals[(mk.i = (mk.i ?? -1) + 1) % vals.length];
  const seqA = [0.9, 0.1, 0.5, 0.3];
  const first = pickLessonQuiz(questions, [], 'l1', 4, mk(seqA));
  const second = pickLessonQuiz(questions, [], 'l1', 4, mk(seqA));
  assert.deepEqual(first.map(x => x.id), second.map(x => x.id));
  // A different rand sequence may reorder within the same (all-unseen) priority.
  const reseq = pickLessonQuiz(questions, [], 'l1', 4, mk([0.3, 0.9, 0.1, 0.5]));
  assert.deepEqual(new Set(reseq.map(x => x.id)), new Set(first.map(x => x.id)));
});
