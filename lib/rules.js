'use strict';

// Rule-based "is this a work mail?" classification. The user edits these
// lists in the widget's 설정 tab; these are only the starting values.
const DEFAULT_RULES = {
  workDomains: [],
  workSenders: [],
  includeKeywords: [
    '회의', '미팅', 'meeting', '마감', '기한', '일정', '보고', '요청', '검토',
    '제출', '공유', '면담', '세미나', '워크숍', '교육', '발표', '업무', '프로젝트',
    '결재', '협조', '회신', '진행',
  ],
  excludeKeywords: ['(광고)', '[광고]', '뉴스레터', 'newsletter', '수신거부', 'unsubscribe', '프로모션', '쿠폰'],
};

function normList(list) {
  return (Array.isArray(list) ? list : String(list || '').split(','))
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
}

function senderAddress(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}

function matchesDomain(addr, domains) {
  const domain = addr.split('@')[1] || '';
  return domains.some((d) => {
    const want = d.replace(/^@/, '');
    return domain === want || domain.endsWith(`.${want}`);
  });
}

function containsAny(haystack, keywords) {
  const h = haystack.toLowerCase();
  return keywords.find((k) => h.includes(k)) || null;
}

/**
 * @param {{from:string, subject:string, text:string}} mail
 * @param {object} rules DEFAULT_RULES-shaped
 * @param {{hasSchedule?: boolean}} [hint] whether a date was found in the body
 * @returns {{isWork: boolean, reason: string}}
 */
function classifyMail(mail, rules = DEFAULT_RULES, hint = {}) {
  const addr = senderAddress(mail.from);
  const subject = String(mail.subject || '');
  const body = String(mail.text || '');
  const domains = normList(rules.workDomains);
  const senders = normList(rules.workSenders);
  const include = normList(rules.includeKeywords);
  const exclude = normList(rules.excludeKeywords);

  const excluded = containsAny(`${subject} ${mail.from || ''}`, exclude);
  if (excluded) return { isWork: false, reason: `제외 키워드 "${excluded}"` };

  if (senders.includes(addr)) return { isWork: true, reason: '업무 발신자' };
  if (domains.length && matchesDomain(addr, domains)) return { isWork: true, reason: '업무 도메인' };

  const inSubject = containsAny(subject, include);
  if (inSubject) return { isWork: true, reason: `제목 키워드 "${inSubject}"` };

  // A keyword buried in the body alone is weak evidence; accept it only if
  // the mail also mentions a concrete date.
  const inBody = containsAny(body, include);
  if (inBody && hint.hasSchedule) return { isWork: true, reason: `본문 키워드 "${inBody}" + 일정` };

  return { isWork: false, reason: '규칙에 해당 없음' };
}

const SUBJECT_PREFIX_RE = /^\s*(re|fw|fwd|회신|답장|전달)\s*(\[\d+\])?\s*:\s*/i;

function cleanSubject(subject) {
  let s = String(subject || '').trim();
  while (SUBJECT_PREFIX_RE.test(s)) s = s.replace(SUBJECT_PREFIX_RE, '');
  return s || '(제목 없음)';
}

function isForward(subject) {
  return /^\s*(fw|fwd|전달)\s*:/i.test(String(subject || ''));
}

const QUOTE_MARKER_RE = /^(-{2,}\s*(original message|원본 메시지|원래 메시지|forwarded message|전달된 메시지)|on .+wrote:$|.+님이 작성:$)/i;

// Drop the quoted history under a reply so an old thread's dates don't get
// re-added on every "RE:". Forwards keep it: the forwarded part is the point.
function stripQuoted(text, subject) {
  const lines = String(text || '').split(/\r?\n/);
  if (isForward(subject)) return lines.join('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (QUOTE_MARKER_RE.test(t)) break;
    if (t.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n');
}

module.exports = { DEFAULT_RULES, classifyMail, cleanSubject, stripQuoted, senderAddress, normList };
