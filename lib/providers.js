'use strict';

// IMAP presets for the mail services the widget supports out of the box.
// All three reject the normal web password once 2-step verification is on,
// so the help text points people at each service's app-password page.
const PROVIDERS = {
  daum: {
    label: '다음',
    host: 'imap.daum.net',
    port: 993,
    userHint: '아이디 (예: myid 또는 myid@daum.net)',
    help: '다음 메일 > 환경설정 > IMAP/POP3에서 "IMAP 사용"을 켜세요. 카카오 계정 2단계 인증을 쓰면 앱 비밀번호를 발급받아 입력하세요.',
  },
  naver: {
    label: '네이버',
    host: 'imap.naver.com',
    port: 993,
    userHint: '네이버 아이디 (예: myid)',
    help: '네이버 메일 > 환경설정 > POP3/IMAP 설정에서 "IMAP/SMTP 사용"을 사용함으로 바꾸세요. 2단계 인증을 쓰면 네이버 애플리케이션 비밀번호를 만들어 입력하세요.',
  },
  gmail: {
    label: 'Gmail',
    host: 'imap.gmail.com',
    port: 993,
    userHint: 'Gmail 주소 (예: me@gmail.com)',
    help: 'Google 계정 > 보안에서 2단계 인증을 켠 뒤 "앱 비밀번호"(16자리)를 만들어 입력하세요. 일반 Google 비밀번호로는 로그인되지 않습니다.',
    // app passwords are shown as "abcd efgh ijkl mnop"; the spaces aren't part of it
    stripSpaces: true,
  },
  custom: {
    label: '기타 (직접 입력)',
    host: '',
    port: 993,
    userHint: '메일 계정',
    help: '사용하는 메일 서비스의 IMAP 서버 주소와 포트(보통 993)를 입력하세요.',
  },
};

function providerOf(id) {
  return PROVIDERS[id] || PROVIDERS.custom;
}

// Resolve host/port for an account: presets always use their own server,
// only "custom" takes what the user typed.
function serverFor(account) {
  const p = providerOf(account.provider);
  if (account.provider === 'custom' || !PROVIDERS[account.provider]) {
    return { host: String(account.host || '').trim(), port: Number(account.port) || 993 };
  }
  return { host: p.host, port: p.port };
}

function normalizePassword(provider, password) {
  const p = providerOf(provider);
  return p.stripSpaces ? String(password || '').replace(/\s+/g, '') : String(password || '');
}

module.exports = { PROVIDERS, providerOf, serverFor, normalizePassword };
