'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractEvents } = require('../lib/dateExtract');

// 2026-09-25 is a Friday
const REF = new Date(2026, 8, 25, 10, 0);

function pick(events) {
  return events.map(({ date, start, end, allDay, kind }) => ({ date, start, end, allDay, kind }));
}

test('Korean month/day with 오후 time and range', () => {
  const ev = extractEvents('주간 회의: 10월 2일(금) 오후 2시~4시, 3층 회의실', REF);
  assert.deepEqual(pick(ev), [{ date: '2026-10-02', start: '14:00', end: '16:00', allDay: false, kind: 'meeting' }]);
});

test('full dotted date with 24h range', () => {
  const ev = extractEvents('일시 : 2026. 10. 7.(수) 14:00-15:30', REF);
  assert.deepEqual(pick(ev), [{ date: '2026-10-07', start: '14:00', end: '15:30', allDay: false, kind: 'event' }]);
});

test('deadline with 까지 is all-day', () => {
  const ev = extractEvents('보고서는 9/30까지 제출 부탁드립니다.', REF);
  assert.deepEqual(pick(ev), [{ date: '2026-09-30', start: null, end: null, allDay: true, kind: 'deadline' }]);
});

test('meeting without end time gets one hour', () => {
  const ev = extractEvents('다음 주 화요일 10시 반에 미팅 가능하실까요?', REF);
  assert.deepEqual(pick(ev), [{ date: '2026-09-29', start: '10:30', end: '11:30', allDay: false, kind: 'meeting' }]);
});

test('이번 주 / 내일 relative dates', () => {
  const ev = extractEvents('내일 오전 9시 회의\n이번주 일요일까지 검토 부탁드립니다', REF);
  assert.deepEqual(pick(ev), [
    { date: '2026-09-26', start: '09:00', end: '10:00', allDay: false, kind: 'meeting' },
    { date: '2026-09-27', start: null, end: null, allDay: true, kind: 'deadline' },
  ]);
});

test('time on the following line attaches to the date', () => {
  const ev = extractEvents('일자: 10월 12일\n시간: 오후 3시\n장소: 본사', REF);
  assert.deepEqual(pick(ev), [{ date: '2026-10-12', start: '15:00', end: null, allDay: false, kind: 'event' }]);
});

test('bare 1~7시 is treated as afternoon, 3시간 is not a time', () => {
  const ev = extractEvents('10월 5일 2시 세미나 (약 3시간 소요)', REF);
  assert.deepEqual(pick(ev), [{ date: '2026-10-05', start: '14:00', end: '15:00', allDay: false, kind: 'meeting' }]);
});

test('small talk with 오늘 and past dates are ignored', () => {
  assert.deepEqual(extractEvents('오늘도 수고 많으셨습니다.', REF), []);
  assert.deepEqual(extractEvents('9월 10일 회의 결과 공유드립니다.', REF), []);
});

test('January date in a December mail rolls to next year', () => {
  const ev = extractEvents('1월 5일 킥오프 미팅', new Date(2026, 11, 20));
  assert.equal(ev[0].date, '2027-01-05');
});

test('version numbers and plain decimals are not dates', () => {
  assert.deepEqual(extractEvents('v2.3 배포 완료, 성공률 10.5% 개선', REF), []);
});

test('duplicate mentions collapse into one entry', () => {
  const ev = extractEvents('10월 2일 오후 2시 회의\n\n※ 일정: 10월 2일 14:00', REF);
  assert.equal(ev.length, 1);
});

test('multiple dates on one line each get their own time', () => {
  const ev = extractEvents('1차 10/6 오전 10시, 2차 10/8 오후 4시 면접', REF);
  assert.deepEqual(
    pick(ev).map((e) => [e.date, e.start]),
    [
      ['2026-10-06', '10:00'],
      ['2026-10-08', '16:00'],
    ],
  );
});

test('relative day + request wording becomes a deadline', () => {
  const ev = extractEvents('내일 확인 부탁드려요\n명일 오전 중 공유 바랍니다', REF);
  assert.deepEqual(pick(ev), [{ date: '2026-09-26', start: null, end: null, allDay: true, kind: 'deadline' }]);
});

test('ASAP / 급히 / EOD without a date are due today and urgent', () => {
  for (const line of ['ASAP 검토 부탁드립니다', '급히 확인 부탁드립니다', '가능한 빨리 회신 부탁드립니다', 'EOD까지 부탁드립니다', 'Please review ASAP']) {
    const ev = extractEvents(line, REF);
    assert.equal(ev.length, 1, line);
    assert.equal(ev[0].date, '2026-09-25', line);
    assert.equal(ev[0].kind, 'deadline', line);
    assert.equal(ev[0].urgent, true, line);
  }
});

test('urgent mail with a date keeps the date and is flagged', () => {
  const ev = extractEvents('긴급: 서버 점검 안내\n10월 2일 오후 2시 점검', REF);
  assert.deepEqual(ev.map((e) => [e.date, e.start, e.urgent]), [['2026-10-02', '14:00', true]]);
});

test('past-tense reports and greetings are not schedules', () => {
  assert.deepEqual(extractEvents('오늘 확인했습니다', REF), []);
  assert.deepEqual(extractEvents('내일 뵙겠습니다', REF), []);
  assert.deepEqual(extractEvents('긴급 건은 어제 처리 완료했습니다', REF), []);
});
