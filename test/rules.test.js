'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyMail, cleanSubject, stripQuoted, DEFAULT_RULES } = require('../lib/rules');
const { mailToCandidate } = require('../lib/processMail');
const { toIcs } = require('../lib/ics');

const rules = { ...DEFAULT_RULES, workDomains: ['mycompany.co.kr'] };

test('sender in work domain is work mail', () => {
  const r = classifyMail({ from: '김팀장 <kim@dev.mycompany.co.kr>', subject: '점심', text: '' }, rules);
  assert.equal(r.isWork, true);
});

test('ad subject is excluded even from a work domain', () => {
  const r = classifyMail({ from: 'kim@mycompany.co.kr', subject: '(광고) 가을 할인', text: '' }, rules);
  assert.equal(r.isWork, false);
});

test('subject keyword marks work mail, body keyword needs a date', () => {
  assert.equal(classifyMail({ from: 'a@gmail.com', subject: '회의 안건 공유', text: '' }, rules).isWork, true);
  assert.equal(classifyMail({ from: 'a@gmail.com', subject: '안녕하세요', text: '검토 부탁' }, rules).isWork, false);
  assert.equal(
    classifyMail({ from: 'a@gmail.com', subject: '안녕하세요', text: '검토 부탁' }, rules, { hasSchedule: true }).isWork,
    true,
  );
});

test('cleanSubject strips reply/forward prefixes', () => {
  assert.equal(cleanSubject('RE: Fwd: 회신: [공지] 워크숍'), '[공지] 워크숍');
});

test('stripQuoted drops reply history but keeps forwards', () => {
  const body = '확인했습니다.\n\n-----Original Message-----\n10월 2일 회의';
  assert.equal(stripQuoted(body, 'RE: 회의').trim(), '확인했습니다.');
  assert.match(stripQuoted(body, 'FW: 회의'), /10월 2일/);
});

test('mailToCandidate builds events, or a to-do when no date', () => {
  const date = new Date(2026, 8, 25, 9, 0);
  const c = mailToCandidate(
    { messageId: '<1@x>', from: 'kim@mycompany.co.kr', subject: 'RE: 분기 보고', date, text: '9/30까지 제출 바랍니다' },
    rules,
  );
  assert.equal(c.events.length, 1);
  assert.equal(c.events[0].title, '[마감] 9/30까지 제출 바랍니다');
  assert.equal(c.events[0].date, '2026-09-30');

  const todo = mailToCandidate({ from: 'kim@mycompany.co.kr', subject: '자료 요청', date, text: '자료 부탁드려요' }, rules);
  assert.equal(todo.events[0].noDate, true);
  assert.equal(todo.events[0].date, '2026-09-25');

  assert.equal(mailToCandidate({ from: 'x@shop.com', subject: '(광고) 세일', date, text: '' }, rules), null);
});

test('meeting subject makes timed entries meetings', () => {
  const c = mailToCandidate(
    { from: 'kim@mycompany.co.kr', subject: '전략 회의 안내', date: new Date(2026, 8, 25), text: '- 일시: 10월 2일(금) 오후 2시~4시' },
    rules,
  );
  assert.equal(c.events[0].kind, 'meeting');
  assert.equal(c.events[0].title, '전략 회의 안내');
});

test('ics output has folded lines and escaped text', () => {
  const ics = toIcs([
    { id: 'a', title: '회의, 준비; 확인', date: '2026-10-02', start: '14:00', end: '15:00', allDay: false, note: '가'.repeat(60) },
    { id: 'b', title: '마감', date: '2026-10-31', allDay: true },
  ]);
  assert.match(ics, /SUMMARY:회의\\, 준비\\; 확인/);
  assert.match(ics, /DTSTART:20261002T140000/);
  assert.match(ics, /DTEND;VALUE=DATE:20261101/);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
});

test('urgent mail gets [긴급] title and is checked by default', () => {
  const c = mailToCandidate(
    { from: 'kim@mycompany.co.kr', subject: '자료 요청', date: new Date(2026, 8, 25, 9, 0), text: 'ASAP 검토 부탁드립니다' },
    rules,
  );
  assert.equal(c.urgent, true);
  assert.equal(c.events[0].title, '[긴급] ASAP 검토 부탁드립니다');
  assert.equal(c.events[0].noDate, false);
});
