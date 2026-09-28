'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeClient, friendlyError } = require('../lib/mailWatcher');

// Regression: ImapFlow emits 'error' on socket timeout; without a listener
// Electron shows "A JavaScript error occurred in the main process".
test('IMAP client always has an error listener', () => {
  const client = makeClient({ provider: 'daum', user: 'u', pass: 'p' });
  assert.ok(client.listenerCount('error') > 0);
  assert.doesNotThrow(() => client.emit('error', new Error('Socket timeout')));
});

test('socket timeout gets a readable message', () => {
  assert.match(friendlyError(new Error('Socket timeout')), /응답하지 않아/);
  assert.match(friendlyError({ authenticationFailed: true }, { provider: 'gmail' }), /앱 비밀번호/);
});
