'use strict';

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// Daum mail: 메일 설정 > IMAP/POP3 > "IMAP 사용" must be on. With 2-step
// verification the normal password is rejected and an app password is needed.
const DAUM_IMAP = { host: 'imap.daum.net', port: 993 };

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

function makeClient(account) {
  return new ImapFlow({
    host: account.host || DAUM_IMAP.host,
    port: Number(account.port) || DAUM_IMAP.port,
    secure: true,
    auth: { user: account.user, pass: account.pass },
    logger: false,
  });
}

function friendlyError(err) {
  const text = `${err && (err.responseText || err.message || err)}`;
  if (err && err.authenticationFailed) {
    return '로그인 실패: 아이디/비밀번호를 확인하세요. 2단계 인증을 쓰면 앱 비밀번호가 필요하고, 다음 메일 설정에서 IMAP 사용을 켜야 합니다.';
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) return '서버를 찾을 수 없습니다. 인터넷 연결과 IMAP 서버 주소를 확인하세요.';
  if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET/.test(text)) return '메일 서버에 연결할 수 없습니다. 네트워크/방화벽을 확인하세요.';
  return `메일 확인 오류: ${text}`;
}

async function testConnection(account) {
  const client = makeClient(account);
  try {
    await client.connect();
    const status = await client.status('INBOX', { messages: true, unseen: true });
    return { ok: true, message: `연결 성공 (받은편지함 ${status.messages}통, 안 읽음 ${status.unseen}통)` };
  } catch (err) {
    return { ok: false, message: friendlyError(err) };
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Fetch mails that arrived since the last check.
 * @param {object} account {host, port, user, pass}
 * @param {{uidValidity?: string, lastUid?: number}} cursor where the last check stopped
 * @returns {Promise<{mails: object[], cursor: object}>}
 */
async function fetchNewMail(account, cursor = {}) {
  const client = makeClient(account);
  await client.connect();
  const raw = [];
  let next = { ...cursor };
  try {
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
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
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

module.exports = { DAUM_IMAP, fetchNewMail, testConnection, friendlyError };
