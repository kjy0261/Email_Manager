'use strict';

// Rule-based extraction of dates/times from Korean business mail.
// Everything here works in the machine's local time zone: the widget runs on
// the user's own PC, so "오후 2시" should mean 2pm wherever that PC is.

const WEEKDAY_CHARS = '일월화수목금토'; // index === Date#getDay()
const WEEKDAY_SUFFIX = '(?:\\s*\\(\\s*[월화수목금토일](?:요일)?\\s*\\))?';

const DEADLINE_RE = /(까지|마감|기한|제출|due|deadline)/i;
const MEETING_RE = /(회의|미팅|meeting|면담|세미나|워크숍|워크샵|교육|발표|간담회|콜|call|인터뷰|면접)/i;
// "금일 중 회신 부탁드립니다": a request makes a relative day a deadline.
// Past tense ("오늘 확인했습니다") is a report, not a request.
const REQUEST_RE = /(부탁|요청|회신|확인|공유|검토|제출|보내|전달|바랍니다|바람|주세요|주시기|주십시오)/;
const PAST_RE = /(했습니다|하였습니다|되었습니다|됐습니다|했어요|완료)/;
// Urgent wording without a date means "today".
const URGENT_RE = /(asap|a\.s\.a\.p|긴급|급히|급한|시급|가능한\s*한?\s*빨리|가능한\s*빠르게|최대한\s*빨리|최대한\s*빠르게|빠른\s*시일|조속히|\beod\b|end of (the )?day|금일\s*중|오늘\s*중)/i;

function pad(n) {
  return String(n).padStart(2, '0');
}

function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function validDate(y, m, d) {
  const x = new Date(y, m - 1, d);
  return x.getFullYear() === y && x.getMonth() === m - 1 && x.getDate() === d ? x : null;
}

// "10월 3일" has no year: use the mail's year, unless that lands well in the
// past (a December mail talking about "1월 5일" means next January).
function inferYear(m, d, ref) {
  const cand = validDate(ref.getFullYear(), m, d);
  if (!cand) return null;
  const diffDays = (cand - startOfDay(ref)) / 86400000;
  return diffDays < -60 ? validDate(ref.getFullYear() + 1, m, d) : cand;
}

// Monday-based week, which is how "이번 주 / 다음 주" is used at work.
function weekdayInWeek(ref, weekOffset, dayChar) {
  const target = WEEKDAY_CHARS.indexOf(dayChar);
  const mondayOffset = (ref.getDay() + 6) % 7;
  const monday = addDays(ref, -mondayOffset + weekOffset * 7);
  return addDays(monday, (target + 6) % 7);
}

function nextWeekday(ref, dayChar) {
  const target = WEEKDAY_CHARS.indexOf(dayChar);
  return addDays(ref, (target - ref.getDay() + 7) % 7);
}

// Each rule: regex + function that turns the match into a Date (or null).
// Order matters: earlier rules claim their span first, later overlapping
// matches are ignored (so "2026. 10. 3.(금)" isn't also read as "10/3").
const DATE_RULES = [
  {
    re: new RegExp(`(20\\d{2})\\s*(?:년\\s*|[.\\-/]\\s*)(\\d{1,2})\\s*(?:월\\s*|[.\\-/]\\s*)(\\d{1,2})(?!\\d)\\s*일?\\.?${WEEKDAY_SUFFIX}`, 'g'),
    toDate: (m) => validDate(+m[1], +m[2], +m[3]),
  },
  {
    re: new RegExp(`(\\d{1,2})\\s*월\\s*(\\d{1,2})\\s*일${WEEKDAY_SUFFIX}`, 'g'),
    toDate: (m, ref) => inferYear(+m[1], +m[2], ref),
  },
  {
    re: new RegExp(`(?<![\\d/.])(\\d{1,2})\\s*/\\s*(\\d{1,2})(?![\\d/])${WEEKDAY_SUFFIX}`, 'g'),
    toDate: (m, ref) => inferYear(+m[1], +m[2], ref),
  },
  {
    // "10.3(금)" - a bare "10.3" is too often a version number or a decimal,
    // so the dotted form only counts when a weekday follows it.
    re: /(?<![\d.])(\d{1,2})\s*\.\s*(\d{1,2})\s*\.?\s*\(\s*[월화수목금토일](?:요일)?\s*\)/g,
    toDate: (m, ref) => inferYear(+m[1], +m[2], ref),
  },
  {
    re: /(다다음\s*주|이번\s*주|금주|다음\s*주|담주|차주)\s*(?:의\s*)?([월화수목금토일])(?:요일|(?![가-힣]))/g,
    toDate: (m, ref) => {
      const w = m[1].replace(/\s+/g, '');
      const offset = w === '다다음주' ? 2 : w === '이번주' || w === '금주' ? 0 : 1;
      return weekdayInWeek(ref, offset, m[2]);
    },
  },
  {
    re: /(오늘|금일|내일|명일|익일|모레|글피)/g,
    weak: true,
    toDate: (m, ref) => {
      const offset = { 오늘: 0, 금일: 0, 내일: 1, 명일: 1, 익일: 1, 모레: 2, 글피: 3 }[m[1]];
      return addDays(ref, offset);
    },
  },
  {
    re: /([월화수목금토일])요일/g,
    weak: true,
    toDate: (m, ref) => nextWeekday(ref, m[1]),
  },
];

function overlaps(spans, start, end) {
  return spans.some((s) => start < s.end && end > s.index);
}

function findDates(line, ref) {
  const found = [];
  for (const rule of DATE_RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(line))) {
      const index = m.index;
      const end = index + m[0].length;
      if (overlaps(found, index, end)) continue;
      const date = rule.toDate(m, startOfDay(ref));
      if (date) found.push({ index, end, date, weak: !!rule.weak, text: m[0].trim() });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

const PM_RE = /^(오후|저녁|밤|pm|p\.m\.)$/i;
const NOON_RE = /^(낮|점심)$/;

// Turn a raw hour + optional 오전/오후 marker into 0-23. With no marker,
// 1~7시 is taken as afternoon because meetings at 3am are rare.
function toHour(raw, meridiem) {
  let h = raw;
  if (h > 24) return null;
  if (meridiem) {
    if (PM_RE.test(meridiem)) {
      if (h < 12) h += 12;
    } else if (NOON_RE.test(meridiem)) {
      if (h < 7) h += 12;
    } else if (h === 12) {
      h = 0;
    }
  } else if (h >= 1 && h <= 7) {
    h += 12;
  }
  return h === 24 ? null : h;
}

const MERIDIEM = '(오전|오후|아침|낮|점심|저녁|밤|새벽)';
const TIME_RULES = [
  {
    re: new RegExp(`${MERIDIEM}?\\s*(\\d{1,2})\\s*시(?!간)\\s*(?:(\\d{1,2})\\s*분|(반))?`, 'g'),
    parse: (m) => ({ raw: +m[2], minute: m[4] ? 30 : m[3] ? +m[3] : 0, meridiem: m[1] }),
  },
  {
    re: new RegExp(`${MERIDIEM}?\\s*(?<![\\d:.])(\\d{1,2}):(\\d{2})(?![\\d:])(?:\\s*(am|pm|a\\.m\\.|p\\.m\\.))?`, 'gi'),
    parse: (m) => ({ raw: +m[2], minute: +m[3], meridiem: m[1] || m[4] }),
  },
  {
    re: /(?<![\d:.])(\d{1,2})\s*(am|pm)\b/gi,
    parse: (m) => ({ raw: +m[1], minute: 0, meridiem: m[2] }),
  },
  {
    re: /정오/g,
    parse: () => ({ raw: 12, minute: 0, meridiem: '낮' }),
  },
];

function findTimes(line, dateSpans) {
  const tokens = [];
  for (const rule of TIME_RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(line))) {
      // leading whitespace of an optional group shouldn't count as the token
      const lead = m[0].length - m[0].trimStart().length;
      const index = m.index + lead;
      const end = m.index + m[0].length;
      if (overlaps(dateSpans, index, end) || overlaps(tokens, index, end)) continue;
      const p = rule.parse(m);
      if (p.minute > 59) continue;
      const hour = toHour(p.raw, p.meridiem);
      if (hour === null) continue;
      tokens.push({ index, end, hour, minute: p.minute, raw: p.raw, meridiem: p.meridiem });
    }
  }
  tokens.sort((a, b) => a.index - b.index);

  // Pair "14:00~15:30", "2시부터 4시", "오후 2시-4시" into ranges.
  const times = [];
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    const between = b ? line.slice(a.end, b.index) : '';
    if (b && /^\s*(~|-|–|—|부터|에서)\s*$/.test(between)) {
      let endHour = b.hour;
      if (!b.meridiem && a.meridiem && PM_RE.test(a.meridiem) && b.raw < 12) endHour = b.raw + 12;
      const startMin = a.hour * 60 + a.minute;
      if (endHour * 60 + b.minute <= startMin && endHour + 12 < 24) endHour += 12;
      times.push({ index: a.index, end: b.end, start: [a.hour, a.minute], finish: [endHour, b.minute] });
      i++;
    } else {
      times.push({ index: a.index, end: a.end, start: [a.hour, a.minute], finish: null });
    }
  }
  return times;
}

function hm([h, m]) {
  return `${pad(h)}:${pad(m)}`;
}

function isRequest(line) {
  return REQUEST_RE.test(line) && !PAST_RE.test(line);
}

function isUrgent(line) {
  return URGENT_RE.test(line) && !PAST_RE.test(line);
}

function kindOf(line) {
  if (DEADLINE_RE.test(line)) return 'deadline';
  if (MEETING_RE.test(line)) return 'meeting';
  if (isRequest(line) || isUrgent(line)) return 'deadline';
  return 'event';
}

function applyTime(ev, t) {
  ev.start = hm(t.start);
  if (t.finish) {
    ev.end = hm(t.finish);
  } else if (ev.kind === 'meeting') {
    const endMin = Math.min(t.start[0] * 60 + t.start[1] + 60, 23 * 60 + 59);
    ev.end = hm([Math.floor(endMin / 60), endMin % 60]);
  }
  ev.allDay = false;
}

/**
 * Pull schedule candidates out of a mail body.
 * @param {string} text plain-text body
 * @param {Date} refDate when the mail was received (relative words are resolved against it)
 * Events carry urgent: true when the mail says ASAP / 긴급 / EOD etc.; an
 * urgent mail with no date at all yields a deadline on the received day.
 * @returns {{date:string,start:string|null,end:string|null,allDay:boolean,kind:string,context:string,urgent:boolean}[]}
 */
function extractEvents(text, refDate = new Date()) {
  const ref = new Date(refDate);
  const today = startOfDay(ref);
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim());
  const events = [];
  let pendingNoTime = null; // "일시: 10월 3일" followed by "시간: 오후 2시" on the next line
  let pendingLine = -10;
  let urgentLine = null;

  lines.forEach((line, i) => {
    if (!line) return;
    if (!urgentLine && isUrgent(line)) urgentLine = line;
    const dates = findDates(line, ref);
    const times = findTimes(line, dates);

    if (dates.length === 0) {
      if (times.length && pendingNoTime && i - pendingLine <= 2) {
        applyTime(pendingNoTime, times[0]);
        pendingNoTime = null;
      }
      return;
    }

    let lastEv = null;
    dates.forEach((d, k) => {
      const nextIndex = k + 1 < dates.length ? dates[k + 1].index : Infinity;
      let t = times.find((x) => x.index >= d.end && x.index < nextIndex);
      if (!t && dates.length === 1) t = times.find((x) => x.index < d.index);
      const ev = {
        date: ymd(d.date),
        start: null,
        end: null,
        allDay: true,
        kind: kindOf(line),
        context: line.length > 160 ? `${line.slice(0, 157)}...` : line,
      };
      // "오늘도 수고하셨습니다" is not a schedule: relative words only count
      // when the line also has a time or reads like a meeting/deadline.
      if (d.weak && !t && ev.kind === 'event') return;
      if (t) applyTime(ev, t);
      if (d.date >= today) events.push(ev);
      lastEv = ev;
    });
    pendingNoTime = lastEv && lastEv.allDay && events.includes(lastEv) ? lastEv : null;
    pendingLine = i;
  });

  // Same date+time mentioned twice (e.g. in the intro and again in a
  // summary table) should only produce one calendar entry.
  const seen = new Map();
  for (const ev of events) {
    const key = `${ev.date}|${ev.start || ''}`;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, ev);
    } else if (prev.kind === 'event' && ev.kind !== 'event') {
      prev.kind = ev.kind;
    }
  }
  // An all-day entry is redundant when the same day already has a timed
  // one of the same kind (the date was just mentioned twice).
  const all = [...seen.values()];
  const result = all.filter(
    (e) => !(e.allDay && all.some((t) => !t.allDay && t.date === e.date && (e.kind === 'event' || t.kind === e.kind))),
  );

  // An urgent mail: flag its dated entries, or make it due today if it has none.
  if (urgentLine) {
    if (result.length) {
      for (const ev of result) ev.urgent = true;
    } else {
      result.push({
        date: ymd(today),
        start: null,
        end: null,
        allDay: true,
        kind: 'deadline',
        context: urgentLine.length > 160 ? `${urgentLine.slice(0, 157)}...` : urgentLine,
        urgent: true,
      });
    }
  }
  for (const ev of result) ev.urgent = !!ev.urgent;
  return result;
}

module.exports = { extractEvents, findDates, findTimes, ymd };
