const DAY_MS = 86_400_000;

function activeQuestions(questions) {
  return [...new Map(questions.filter(q => q.verified === true).map(q => [q.id, q])).values()];
}

export function mastery(question, attempts) {
  if (!question.verified) return 'unseen';
  const history = attempts.filter(a => a.questionId === question.id &&
    a.revision === question.revision && Number.isFinite(a.at) && a.at >= 0)
    .slice().sort((a, b) => a.at - b.at);
  let state = 'unseen';
  let anchor = null;
  for (const attempt of history) {
    if (!attempt.correct) {
      state = 'review';
      anchor = null;
    } else if (anchor === null) {
      anchor = attempt.at;
      state = 'learning';
    } else if (attempt.at - anchor >= DAY_MS) {
      state = 'mastered';
    }
  }
  return state;
}

export function progress(questions, attempts) {
  const counts = { total: 0, mastered: 0, unseen: 0, review: 0, percent: null };
  for (const q of activeQuestions(questions)) {
    counts.total++;
    const state = mastery(q, attempts);
    if (state !== 'learning') counts[state]++;
  }
  if (counts.total) counts.percent = Math.floor(counts.mastered * 100 / counts.total);
  return counts;
}

export function pickQuestions(questions, attempts, filters, rng = Math.random) {
  const selected = activeQuestions(questions).filter(q =>
    (filters.categoryId === 'all' || q.categoryId === filters.categoryId) &&
    (filters.kind === 'all' || q.kind === filters.kind) &&
    (filters.state === 'all' || mastery(q, attempts) === filters.state));
  for (let i = selected.length - 1; i > 0; i--) {
    const value = rng();
    const unit = Number.isFinite(value) ? Math.max(0, Math.min(1 - Number.EPSILON, value)) : 0;
    const j = Math.floor(unit * (i + 1));
    [selected[i], selected[j]] = [selected[j], selected[i]];
  }
  return selected.slice(0, 5);
}

// Small per-lesson quiz: verified questions of that lesson only, priority
// 要復習 → 未確認 → 学習中 → 定着, shuffled inside each priority tier by rand.
const LESSON_QUIZ_PRIORITY = { review: 0, unseen: 1, learning: 2, mastered: 3 };

export function pickLessonQuiz(questions, attempts, lessonId, n = 3, rand = Math.random) {
  const picked = activeQuestions(questions)
    .filter(q => q.lessonId === lessonId)
    .map(q => {
      const value = rand();
      return {
        q,
        tier: LESSON_QUIZ_PRIORITY[mastery(q, attempts)] ?? 4,
        key: Number.isFinite(value) ? value : 0,
      };
    });
  picked.sort((a, b) => a.tier - b.tier || a.key - b.key);
  return picked.slice(0, n).map(d => d.q);
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function validDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function splitSegment(start, end, seconds, mode, id, zone) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(seconds) ||
      seconds <= 0 || !Number.isFinite(new Date(start).getTime()) ||
      !Number.isFinite(new Date(end).getTime())) return [];
  // Wall-clock changes must not manufacture elapsed study time.
  const finish = Math.max(start, end);
  if (finish === start) {
    return [{ id: `${id}:0`, start, end: finish, seconds, date: dateKey(new Date(finish)), zone, mode }];
  }
  const pieces = [];
  let cursor = start;
  let assigned = 0;
  while (cursor < finish) {
    const date = new Date(cursor);
    const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
    const boundary = Math.min(midnight, finish);
    const duration = boundary === finish ? seconds - assigned : seconds * (boundary - cursor) / (finish - start);
    pieces.push({ id: `${id}:${pieces.length}`, start: cursor, end: boundary,
      seconds: duration, date: dateKey(date), zone, mode });
    assigned += duration;
    cursor = boundary;
  }
  return pieces;
}

export function timeTotals(segments, now = Date.now()) {
  const date = new Date(now);
  const today = dateKey(date);
  const month = today.slice(0, 7);
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - (date.getDay() + 6) % 7);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const weekStart = dateKey(monday);
  const weekEnd = dateKey(sunday);
  const days = new Map();
  const seen = new Set();
  let total = 0;
  let weekly = 0;
  let monthly = 0;
  for (const segment of segments) {
    if (seen.has(segment.id) || !validDateKey(segment.date) ||
        !Number.isFinite(segment.seconds) || segment.seconds < 0) continue;
    seen.add(segment.id);
    days.set(segment.date, (days.get(segment.date) || 0) + segment.seconds);
    total += segment.seconds;
    if (segment.date >= weekStart && segment.date <= weekEnd) weekly += segment.seconds;
    if (segment.date.slice(0, 7) === month) monthly += segment.seconds;
  }
  return { today: days.get(today) || 0, week: weekly, month: monthly, total,
    daily: [...days].sort(([a], [b]) => b.localeCompare(a)).map(([day, seconds]) => ({ date: day, seconds })) };
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0分';
  if (seconds < 60) return '1分未満';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分`;
  return `${Math.floor(minutes / 60)}時間${minutes % 60 ? `${minutes % 60}分` : ''}`;
}

export function examLabel(value, now = Date.now()) {
  if (!validDateKey(value)) return '試験日：未設定';
  const current = new Date(now);
  const [year, month, day] = value.split('-').map(Number);
  // Calendar dates, not 24-hour intervals: DST does not change the days remaining.
  const target = new Date(0);
  target.setUTCFullYear(year, month - 1, day);
  target.setUTCHours(0, 0, 0, 0);
  const today = new Date(0);
  today.setUTCFullYear(current.getFullYear(), current.getMonth(), current.getDate());
  today.setUTCHours(0, 0, 0, 0);
  const days = Math.round((target - today) / DAY_MS);
  return days === 0 ? '試験当日' : days < 0 ? '試験日を過ぎています' : `試験まであと${days}日`;
}
