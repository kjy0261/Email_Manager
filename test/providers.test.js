'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { serverFor, normalizePassword, providerOf } = require('../lib/providers');

test('presets use their own IMAP server regardless of typed host', () => {
  assert.deepEqual(serverFor({ provider: 'naver', host: 'ignored' }), { host: 'imap.naver.com', port: 993 });
  assert.deepEqual(serverFor({ provider: 'gmail' }), { host: 'imap.gmail.com', port: 993 });
  assert.deepEqual(serverFor({ provider: 'daum' }), { host: 'imap.daum.net', port: 993 });
});

test('custom provider uses the typed host/port', () => {
  assert.deepEqual(serverFor({ provider: 'custom', host: ' imap.corp.com ', port: '143' }), { host: 'imap.corp.com', port: 143 });
  assert.equal(providerOf('unknown').label, '기타 (직접 입력)');
});

test('Gmail app password spaces are removed, others kept', () => {
  assert.equal(normalizePassword('gmail', 'abcd efgh ijkl mnop'), 'abcdefghijklmnop');
  assert.equal(normalizePassword('naver', 'pa ss'), 'pa ss');
});
