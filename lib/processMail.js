'use strict';

const crypto = require('crypto');
const { extractEvents, ymd } = require('./dateExtract');
const { classifyMail, cleanSubject, stripQuoted } = require('./rules');

const KIND_PREFIX = { deadline: '[마감] ', meeting: '', event: '', task: '[할 일] ' };
const MEETING_SUBJECT_RE = /(회의|미팅|meeting|면담|세미나|워크숍|워크샵|교육|간담회|인터뷰|면접)/i;
const TITLE_MAX = 40;

function newId() {
  return crypto.randomUUID();
}

function summarize(text, max = 300) {
  const compact = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n');
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact;
}

/**
 * Turn one received mail into a calendar candidate, or null if the rules say
 * it isn't work mail.
 * @param {{messageId:string, from:string, subject:string, date:Date|string, text:string}} mail
 */
function mailToCandidate(mail, rules) {
  const received = mail.date ? new Date(mail.date) : new Date();
  const body = stripQuoted(mail.text, mail.subject);
  const found = extractEvents(`${mail.subject || ''}\n${body}`, received);
  const verdict = classifyMail({ ...mail, text: body }, rules, { hasSchedule: found.length > 0 });
  if (!verdict.isWork) return null;

  const title = cleanSubject(mail.subject);
  const meetingSubject = MEETING_SUBJECT_RE.test(title);

  // A deadline line ("자료는 9/30까지 공유 부탁드립니다") says more than the
  // mail subject does, so it becomes the title of that entry.
  function titleFor(ev) {
    if (ev.kind === 'deadline' && ev.context && !ev.context.includes(title)) {
      const line = ev.context.replace(/^[-*•·※>\s]+/, '');
      return `${KIND_PREFIX.deadline}${line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line}`;
    }
    return `${KIND_PREFIX[ev.kind] || ''}${title}`;
  }

  const events = found.length
    ? found.map((ev) => ({ ...ev, kind: ev.kind === 'event' && meetingSubject ? 'meeting' : ev.kind }))
    : // Work mail with no date in it: still offer it as a to-do on the
      // received day so the task isn't lost; the user can fix the date.
      [{ date: ymd(received), start: null, end: null, allDay: true, kind: 'task', context: '', noDate: true }];

  return {
    id: newId(),
    messageId: mail.messageId || null,
    from: mail.from || '',
    subject: mail.subject || '',
    receivedAt: received.toISOString(),
    reason: verdict.reason,
    summary: summarize(body),
    events: events.map((ev) => ({
      id: newId(),
      title: titleFor(ev),
      date: ev.date,
      start: ev.start,
      end: ev.end,
      allDay: ev.allDay,
      kind: ev.kind,
      noDate: !!ev.noDate,
      note: [ev.context, `보낸 사람: ${mail.from || ''}`, `메일 제목: ${mail.subject || ''}`].filter(Boolean).join('\n'),
    })),
  };
}

module.exports = { mailToCandidate };
