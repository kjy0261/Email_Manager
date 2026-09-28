'use strict';

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { providerOf, serverFor } = require('./providers');

const FIRST_RUN_DAYS = 2; // how far back to look the very first time
const MAX_PER_CHECK = 50;
const MAX_SOURCE_BYTES = 1024 * 1024; // enough for the text part, skips huge attachments

function htmlToText(html) {
  return String(html || '')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)[^>]*>/gi, '\n')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// fail fast on an unreachable server instead of the library's long defaults
const IMAP_TIMEOUTS = { connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 120000 };

function makeClient(account) {
  const { host, port } = serverFor(account);
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    // certificate checks stay on (Node default); refuse outdated TLS versions
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    auth: { user: account.user, pass: account.pass },
    logger: false,
    ...IMAP_TIMEOUTS,
  });
  // ImapFlow also emits 'error' (socket timeout, connection reset) besides
  // rejecting the pending command. Without a listener Node treats that as an
  // uncaught exception and Electron shows a crash dialog, so swallow it here:
  // the same failure already reaches the caller through the rejected promise.
  client.on('error', () => {});
  return client;
}

async function closeQuietly(client) {
  try {
    if (client.usable) await client.logout();
  } catch (err) {
    // connection already broken
  }
  try {
    client.close();
  } catch (err) {
    // already closed
  }
}

function friendlyError(err, account = {}) {
  const text = `${err && (err.responseText || err.message || err)}`;
  if (err && err.authenticationFailed) {
    return `로그인 실패: 아이디/비밀번호를 확인하세요. ${providerOf(account.provider).help}`;
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) return '서버를 찾을 수 없습니다. 인터넷 연결과 IMAP 서버 주소를 확인하세요.';
  if (/socket timeout|NoConnection|Connection not available/i.test(text)) return '메일 서버가 응답하지 않아 연결이 끊겼습니다. 다음 확인 때 다시 시도합니다.';
  if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|required time|timeout/i.test(text)) return '메일 서버에 연결할 수 없습니다. 네트워크/방화벽을 확인하세요.';
  return `메일 확인 오류: ${text}`;
}

async function testConnection(account) {
  const client = makeClient(account);
  try {
    await client.connect();
    const status = await client.status('INBOX', { messages: true, unseen: true });
    return { ok: true, message: `연결 성공 (받은편지함 ${status.messages}통, 안 읽음 ${status.unseen}통)` };
  } catch (err) {
    return { ok: false, message: friendlyError(err, account) };
  } finally {
    await closeQuietly(client);
  }
}

/**
 * Fetch mails that arrived since the last check.
 * @param {object} account {provider, host, port, user, pass}
 * @param {{uidValidity?: string, lastUid?: number}} cursor where the last check stopped
 * @returns {Promise<{mails: object[], cursor: object}>}
 */
async function fetchNewMail(account, cursor = {}) {
  const client = makeClient(account);
  const raw = [];
  let next = { ...cursor };
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uidValidity = String(client.mailbox.uidValidity);
      const fresh = !cursor.lastUid || cursor.uidValidity !== uidValidity;
      const lastUid = fresh ? 0 : cursor.lastUid;
      const range = fresh ? { since: new Date(Date.now() - FIRST_RUN_DAYS * 86400000) } : `${lastUid + 1}:*`;
      let maxUid = lastUid;

      // fetch() uses BODY.PEEK, so checking doesn't mark mail as read
      for await (const msg of client.fetch(
        range,
        { uid: true, envelope: true, internalDate: true, source: { maxLength: MAX_SOURCE_BYTES } },
        { uid: true },
      )) {
        // "N:*" always returns at least the newest message, even if old
        if (msg.uid <= lastUid) continue;
        maxUid = Math.max(maxUid, msg.uid);
        raw.push(msg);
      }
      if (fresh && maxUid === 0) maxUid = Math.max(0, (client.mailbox.uidNext || 1) - 1);
      next = { uidValidity, lastUid: maxUid };
    } finally {
      try {
        lock.release();
      } catch (err) {
        // connection dropped mid-fetch; closeQuietly below cleans up
      }
    }
  } finally {
    await closeQuietly(client);
  }

  raw.sort((a, b) => a.uid - b.uid);
  const mails = [];
  for (const msg of raw.slice(-MAX_PER_CHECK)) {
    try {
      const parsed = await simpleParser(msg.source);
      mails.push({
        uid: msg.uid,
        messageId: parsed.messageId || (msg.envelope && msg.envelope.messageId) || `uid-${next.uidValidity}-${msg.uid}`,
        from: (parsed.from && parsed.from.text) || '',
        subject: parsed.subject || (msg.envelope && msg.envelope.subject) || '',
        date: parsed.date || msg.internalDate || new Date(),
        text: parsed.text || htmlToText(parsed.html),
      });
    } catch (err) {
      // one broken message shouldn't stop the rest
    }
  }
  return { mails, cursor: next };
}

module.exports = { IMAP_TIMEOUTS, makeClient, fetchNewMail, testConnection, friendlyError };
