'use strict';

// Minimal iCalendar (RFC 5545) writer so events can be opened in Outlook /
// Windows Calendar / Google Calendar import. Times are written as floating
// local time, which calendars interpret in the user's own time zone.

function escapeText(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Fold at 75 octets without splitting a multi-byte (Korean) character.
function fold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + b > limit) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function compactDate(date) {
  return date.replace(/-/g, '');
}

function nextDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  const x = new Date(y, m - 1, d + 1);
  return `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}${String(x.getDate()).padStart(2, '0')}`;
}

function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function eventLines(ev) {
  const lines = ['BEGIN:VEVENT', `UID:${ev.id}@mail-calendar-widget`, `DTSTAMP:${stamp()}`];
  if (ev.allDay || !ev.start) {
    lines.push(`DTSTART;VALUE=DATE:${compactDate(ev.date)}`, `DTEND;VALUE=DATE:${nextDay(ev.date)}`);
  } else {
    const start = `${compactDate(ev.date)}T${ev.start.replace(':', '')}00`;
    const end = `${compactDate(ev.date)}T${(ev.end || ev.start).replace(':', '')}00`;
    lines.push(`DTSTART:${start}`, `DTEND:${end}`);
  }
  lines.push(`SUMMARY:${escapeText(ev.title)}`);
  if (ev.note) lines.push(`DESCRIPTION:${escapeText(ev.note)}`);
  lines.push('END:VEVENT');
  return lines;
}

function toIcs(events) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MailCalendarWidget//KO',
    'CALSCALE:GREGORIAN',
    ...events.flatMap(eventLines),
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

module.exports = { toIcs };
