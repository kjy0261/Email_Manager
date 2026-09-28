const api = window.widgetAPI;
const $ = (sel) => document.querySelector(sel);

const KIND_LABEL = { deadline: '마감', meeting: '회의', event: '일정', task: '할 일' };
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

let state = null;
let currentView = 'inbox';
let viewMonth = startOfMonth(new Date());
let selectedDate = ymd(new Date());
let settingsDirty = false;
let lastInboxKey = '';
let lastCalendarKey = '';

function pad(n) {
  return String(n).padStart(2, '0');
}

function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

function dateLabel(date) {
  const d = parseYmd(date);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`;
}

function timeLabel(ev) {
  if (ev.allDay || !ev.start) return '종일';
  return ev.end ? `${ev.start} ~ ${ev.end}` : ev.start;
}

function relativeTime(iso) {
  if (!iso) return '';
  const diff = Math.round((Date.now() - new Date(iso)) / 60000);
  if (diff < 1) return '방금';
  if (diff < 60) return `${diff}분 전`;
  if (diff < 1440) return `${Math.floor(diff / 60)}시간 전`;
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ---------- tabs ----------

function showView(name) {
  currentView = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== `view-${name}`));
  if (name === 'settings') fillSettings();
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

// ---------- event editor (shared by candidates and calendar) ----------

function makeEditor(ev) {
  const node = $('#event-editor').content.firstElementChild.cloneNode(true);
  node.querySelector('.ed-title').value = ev.title || '';
  node.querySelector('.ed-date').value = ev.date || selectedDate;
  node.querySelector('.ed-start').value = ev.start || '';
  node.querySelector('.ed-end').value = ev.end || '';
  node.read = () => ({
    ...ev,
    title: node.querySelector('.ed-title').value.trim() || '(제목 없음)',
    date: node.querySelector('.ed-date').value,
    start: node.querySelector('.ed-start').value || null,
    end: node.querySelector('.ed-end').value || null,
  });
  return node;
}

// ---------- inbox (candidates) ----------

function renderInbox() {
  const view = $('#view-inbox');
  view.replaceChildren();
  const cands = state.candidates;
  if (!cands.length) {
    const msg = state.status.accountReady
      ? '확인할 새 업무 메일이 없습니다.\n새 업무 메일이 오면 여기에 일정 후보가 나타납니다.'
      : '먼저 설정 탭에서 메일 계정(다음·네이버·Gmail)을 추가하세요.';
    view.append(el('div', { class: 'empty', text: msg, style: 'white-space: pre-line' }));
    return;
  }

  for (const c of cands) {
    const rows = c.events.map((ev) => {
      const check = el('input', { type: 'checkbox' });
      check.checked = !ev.noDate;
      const editor = makeEditor(ev);
      if (ev.noDate) editor.append(el('div', { class: 'warn', text: '메일에서 날짜를 못 찾았어요. 날짜를 정해 주세요.' }));
      const row = el('div', { class: 'cand-event' }, [check, editor]);
      row.read = () => (check.checked ? editor.read() : null);
      return row;
    });

    const summary = el('div', { class: 'cand-summary', text: c.summary, title: '클릭해서 펼치기' });
    summary.addEventListener('click', () => summary.classList.toggle('open'));

    const card = el('div', { class: 'cand' }, [
      el('div', { class: 'cand-subject', text: c.subject || '(제목 없음)' }),
      el('div', {
        class: 'cand-meta',
        text: [c.account, c.from, relativeTime(c.receivedAt), c.reason].filter(Boolean).join(' · '),
      }),
      c.summary ? summary : null,
      ...rows,
      el('div', { class: 'cand-actions' }, [
        el('button', {
          class: 'ghost',
          text: '무시',
          onclick: async () => render(await api.dismissCandidate(c.id)),
        }),
        el('button', {
          class: 'primary',
          text: '캘린더에 추가',
          onclick: async () => {
            const events = rows.map((r) => r.read()).filter(Boolean);
            if (!events.length) {
              alert('추가할 일정을 체크해 주세요. 필요 없는 메일이면 "무시"를 누르세요.');
              return;
            }
            render(await api.acceptCandidate(c.id, events));
          },
        }),
      ]),
    ]);
    view.append(card);
  }
}

// ---------- calendar ----------

function eventsOn(date) {
  return state.events.filter((e) => e.date === date);
}

function eventRow(ev, { showDate = false } = {}) {
  const row = el('div', { class: `ev k-${ev.kind}` });
  const main = el('div', { class: 'ev-main' }, [
    el('div', { class: 'ev-title', text: ev.title, title: ev.note || ev.title }),
    el('div', { class: 'ev-time', text: `${showDate ? `${dateLabel(ev.date)} · ` : ''}${timeLabel(ev)} · ${KIND_LABEL[ev.kind] || '일정'}` }),
  ]);
  const actions = el('div', { class: 'ev-actions' }, [
    el('button', { class: 'icon-btn', text: '✎', title: '수정', onclick: () => editInline(row, ev) }),
    el('button', { class: 'icon-btn', text: '📅', title: 'Outlook/윈도우 캘린더로 열기', onclick: () => api.openIcs(ev.id) }),
    el('button', {
      class: 'icon-btn',
      text: '✕',
      title: '삭제',
      onclick: async () => {
        if (confirm(`"${ev.title}" 일정을 삭제할까요?`)) render(await api.deleteEvent(ev.id));
      },
    }),
  ]);
  row.append(main, actions);
  return row;
}

function editInline(row, ev) {
  const editor = makeEditor(ev);
  const box = el('div', { class: 'cand-event' }, [
    editor,
    el('div', { class: 'row', style: 'flex-direction: column' }, [
      el('button', {
        class: 'small-btn',
        text: '저장',
        onclick: async () => {
          const saved = editor.read();
          if (!saved.date) return;
          selectedDate = saved.date;
          render(await api.saveEvent(saved));
        },
      }),
      el('button', { class: 'small-btn', text: '취소', onclick: () => renderCalendar() }),
    ]),
  ]);
  row.replaceWith(box);
  editor.querySelector('.ed-title').focus();
}

function renderCalendar() {
  $('#month-label').textContent = `${viewMonth.getFullYear()}년 ${viewMonth.getMonth() + 1}월`;
  const grid = $('#month-grid');
  grid.replaceChildren(...DOW.map((d, i) => el('div', { class: `dow${i === 0 ? ' sun' : ''}`, text: d })));

  const today = ymd(new Date());
  const first = new Date(viewMonth);
  const cursor = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay());
  for (let i = 0; i < 42; i++) {
    const date = ymd(cursor);
    const kinds = [...new Set(eventsOn(date).map((e) => e.kind))].slice(0, 3);
    const cls = ['day'];
    if (cursor.getMonth() !== viewMonth.getMonth()) cls.push('other');
    if (cursor.getDay() === 0) cls.push('sun');
    if (date === today) cls.push('today');
    if (date === selectedDate) cls.push('selected');
    grid.append(
      el('button', { class: cls.join(' '), onclick: () => ((selectedDate = date), renderCalendar()) }, [
        el('span', { class: 'num', text: String(cursor.getDate()) }),
        el('span', { class: 'dots' }, kinds.map((k) => el('span', { class: `dot k-${k}` }))),
      ]),
    );
    cursor.setDate(cursor.getDate() + 1);
  }

  $('#day-label').textContent = dateLabel(selectedDate);
  const dayEvents = eventsOn(selectedDate);
  $('#day-events').replaceChildren(
    ...(dayEvents.length ? dayEvents.map((e) => eventRow(e)) : [el('div', { class: 'muted-line', text: '일정 없음' })]),
  );

  const upcoming = state.events.filter((e) => e.date >= today).slice(0, 8);
  $('#upcoming').replaceChildren(
    ...(upcoming.length
      ? upcoming.map((e) => eventRow(e, { showDate: true }))
      : [el('div', { class: 'muted-line', text: '다가오는 일정이 없습니다.' })]),
  );
}

$('#prev-month').addEventListener('click', () => {
  viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1);
  renderCalendar();
});
$('#next-month').addEventListener('click', () => {
  viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1);
  renderCalendar();
});
$('#btn-add-event').addEventListener('click', () => {
  const placeholder = el('div');
  $('#day-events').prepend(placeholder);
  editInline(placeholder, { title: '', date: selectedDate, kind: 'event' });
});
$('#btn-export').addEventListener('click', () => api.exportIcs());

// ---------- settings ----------

function accountCard(acc) {
  const card = $('#account-card').content.firstElementChild.cloneNode(true);
  const q = (sel) => card.querySelector(sel);
  const providers = state.providers;
  for (const [id, p] of Object.entries(providers)) q('.acc-provider').append(el('option', { value: id, text: p.label }));
  q('.acc-provider').value = providers[acc.provider] ? acc.provider : 'custom';
  q('.acc-user').value = acc.user || '';
  q('.acc-password').placeholder = acc.hasPassword ? '저장됨 (바꿀 때만 입력)' : '';
  q('.acc-host').value = acc.host || '';
  q('.acc-port').value = acc.port || 993;

  // presets use their own server; only "기타" shows host/port fields
  const sync = () => {
    const p = providers[q('.acc-provider').value];
    q('.acc-user-label').textContent = p.userHint;
    q('.acc-help').textContent = p.help;
    q('.acc-server').hidden = q('.acc-provider').value !== 'custom';
  };
  q('.acc-provider').addEventListener('change', sync);
  sync();

  card.read = () => ({
    id: acc.id,
    provider: q('.acc-provider').value,
    user: q('.acc-user').value.trim(),
    password: q('.acc-password').value,
    host: q('.acc-host').value.trim(),
    port: Number(q('.acc-port').value) || 993,
  });
  q('.acc-remove').addEventListener('click', () => {
    card.remove();
    settingsDirty = true;
  });
  q('.acc-test').addEventListener('click', async () => {
    const out = q('.acc-result');
    out.className = 'hint acc-result';
    out.textContent = '연결 중...';
    const r = await api.testMail(card.read());
    out.className = `acc-result ${r.ok ? 'ok' : 'fail'}`;
    out.textContent = r.message;
  });
  return card;
}

function fillSettings() {
  const s = state.settings;
  const f = $('#settings-form');
  const accounts = s.accounts.length ? s.accounts : [{ provider: 'daum' }];
  $('#account-list').replaceChildren(...accounts.map(accountCard));
  f.workDomains.value = s.rules.workDomains.join(', ');
  f.workSenders.value = s.rules.workSenders.join(', ');
  f.includeKeywords.value = s.rules.includeKeywords.join(', ');
  f.excludeKeywords.value = s.rules.excludeKeywords.join(', ');
  f.pollMinutes.value = s.pollMinutes;
  f.autoAdd.checked = s.autoAdd;
  f.notify.checked = s.notify;
  f.openAtLogin.checked = s.openAtLogin;
  settingsDirty = false;
}

$('#btn-add-account').addEventListener('click', () => {
  const used = new Set([...document.querySelectorAll('.acc-provider')].map((x) => x.value));
  const next = ['daum', 'naver', 'gmail'].find((p) => !used.has(p)) || 'custom';
  const card = accountCard({ provider: next });
  $('#account-list').append(card);
  card.querySelector('.acc-user').focus();
  settingsDirty = true;
});

$('#settings-form').addEventListener('input', () => (settingsDirty = true));

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    state = await api.saveSettings({
      accounts: [...document.querySelectorAll('#account-list .account')].map((c) => c.read()),
      pollMinutes: Number(f.pollMinutes.value),
      autoAdd: f.autoAdd.checked,
      notify: f.notify.checked,
      openAtLogin: f.openAtLogin.checked,
      rules: {
        workDomains: f.workDomains.value,
        workSenders: f.workSenders.value,
        includeKeywords: f.includeKeywords.value,
        excludeKeywords: f.excludeKeywords.value,
      },
    });
    fillSettings();
    render(state);
    api.checkMail();
  } catch (err) {
    setStatusLine(String(err.message || err), true);
  }
});

$('#btn-wipe').addEventListener('click', async () => {
  if (!confirm('메일 계정·비밀번호, 일정 후보, 캘린더 일정을 모두 삭제할까요?\n되돌릴 수 없습니다.')) return;
  state = await api.wipeData();
  fillSettings();
  render(state);
});

// ---------- title bar / status ----------

$('#btn-hide').addEventListener('click', () => api.hide());
$('#btn-check').addEventListener('click', () => api.checkMail());

function setStatusLine(text, error) {
  const s = $('#status');
  s.textContent = text;
  s.classList.toggle('error', !!error);
}

function renderStatus() {
  const st = state.status;
  const last = st.lastCheck ? ` · 마지막 확인 ${relativeTime(st.lastCheck)}` : '';
  setStatusLine(`${st.message || ''}${st.error ? '' : last}`, st.error);
  $('#btn-check').classList.toggle('spinning', st.checking);
  const badge = $('#badge');
  badge.hidden = state.candidates.length === 0;
  badge.textContent = String(state.candidates.length);
}

// Status updates ("메일 확인 중...") arrive often; only rebuild the lists when
// their data actually changed so half-edited fields aren't wiped.
function render(next) {
  if (next) state = next;
  if (!state) return;
  renderStatus();
  const inboxKey = JSON.stringify([state.candidates.map((c) => c.id), state.status.accountReady]);
  if (inboxKey !== lastInboxKey) {
    lastInboxKey = inboxKey;
    renderInbox();
  }
  const calendarKey = JSON.stringify(state.events);
  if (calendarKey !== lastCalendarKey) {
    lastCalendarKey = calendarKey;
    renderCalendar();
  }
  // don't wipe what the user is typing in the settings form
  if (currentView === 'settings' && !settingsDirty) fillSettings();
}

api.onState(render);
api.getState().then((s) => {
  render(s);
  if (!s.status.accountReady) showView('settings');
});
// keep "n분 전" fresh
setInterval(() => state && renderStatus(), 30000);
