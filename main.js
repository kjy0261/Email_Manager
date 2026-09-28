const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, shell, safeStorage, Notification, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const { JsonStore } = require('./lib/jsonStore');
const { DEFAULT_RULES } = require('./lib/rules');
const { mailToCandidate } = require('./lib/processMail');
const { fetchNewMail, testConnection, friendlyError } = require('./lib/mailWatcher');
const { PROVIDERS, providerOf, serverFor, normalizePassword } = require('./lib/providers');
const { toIcs } = require('./lib/ics');

const APP_ID = 'com.mailcalendarwidget.app';
const WIDGET_WIDTH = 360;
const WIDGET_HEIGHT = 580;
const MIN_POLL_MINUTES = 1;
const MAX_PROCESSED_IDS = 1000;
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const INDEX_HTML = path.join(__dirname, 'src', 'index.html');
const INDEX_URL = pathToFileURL(INDEX_HTML).href;
const CANDIDATE_MAX_AGE_DAYS = 30; // unhandled mail candidates are dropped after this
const ICS_TEMP_DIR = path.join(os.tmpdir(), 'mail-calendar-widget');
const ICS_TEMP_TTL_MS = 5 * 60 * 1000;

let mainWindow = null;
let tray = null;
let pollTimer = null;
let quitting = false;

const userDir = app.getPath('userData');
const SETTINGS_DEFAULTS = {
  // [{ id, provider: 'daum'|'naver'|'gmail'|'custom', user, passEnc, host, port }]
  accounts: [],
  pollMinutes: 3,
  autoAdd: false,
  notify: true,
  openAtLogin: false,
  alwaysOnTop: false,
  rules: DEFAULT_RULES,
  bounds: null,
};
// events: confirmed calendar entries; candidates: work mails waiting for the
// user to confirm; cursors (per account id)/processedIds: where the IMAP
// check left off.
const DATA_DEFAULTS = {
  events: [],
  candidates: [],
  cursors: {},
  processedIds: [],
};
// Both stores hold mail-derived personal data (addresses, subjects, summaries),
// so they are encrypted with the OS key store (DPAPI on Windows). They are
// opened after app 'ready' because safeStorage isn't usable before that.
let settings = null;
let data = null;

function storeCodec() {
  if (!safeStorage.isEncryptionAvailable()) return null;
  return {
    encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
    decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  };
}

function openStores() {
  const codec = storeCodec();
  settings = new JsonStore(path.join(userDir, 'settings.json'), SETTINGS_DEFAULTS, codec);
  data = new JsonStore(path.join(userDir, 'data.json'), DATA_DEFAULTS, codec);

  // Earlier versions had a single Daum account under settings.account.
  const old = settings.data.account;
  if (old && old.user) {
    const id = crypto.randomUUID();
    settings.data.accounts.push({ id, provider: 'daum', user: old.user, passEnc: old.passEnc, host: '', port: 993 });
    if (data.data.cursor) data.data.cursors[id] = data.data.cursor;
  }
  delete settings.data.account;
  delete data.data.cursor;
  // (re)write both so files from older versions get encrypted right away
  settings.save();
  data.save();
}

const status = { checking: false, lastCheck: null, message: '', error: false };

// ---------- password (Windows DPAPI via safeStorage) ----------

function encryptPassword(plain) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('이 PC에서는 비밀번호 암호화를 사용할 수 없습니다.');
  return safeStorage.encryptString(plain).toString('base64');
}

function decryptPassword(enc) {
  if (!enc) return '';
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch (err) {
    return '';
  }
}

function accountForImap(a) {
  return { provider: a.provider, host: a.host, port: a.port, user: a.user, pass: decryptPassword(a.passEnc) };
}

function readyAccounts() {
  return settings.data.accounts.filter((a) => a.user && a.passEnc);
}

function isAccountReady() {
  return readyAccounts().length > 0;
}

function accountLabel(a) {
  return PROVIDERS[a.provider] && a.provider !== 'custom' ? `${providerOf(a.provider).label} ${a.user}` : `${a.user} (${a.host})`;
}

// ---------- state sent to the renderer ----------

function publicState() {
  const { accounts, ...rest } = settings.data;
  return {
    settings: {
      ...rest,
      accounts: accounts.map(({ passEnc, ...a }) => ({ ...a, hasPassword: !!passEnc })),
    },
    providers: PROVIDERS,
    events: [...data.data.events].sort((a, b) => `${a.date}${a.start || ''}`.localeCompare(`${b.date}${b.start || ''}`)),
    candidates: data.data.candidates,
    status: { ...status, accountReady: isAccountReady() },
  };
}

function broadcast() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('state:changed', publicState());
  updateTray();
}

function setStatus(message, error = false) {
  status.message = message;
  status.error = error;
  broadcast();
}

// ---------- mail checking ----------

function cleanEvent(ev) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(ev.date) ? ev.date : null;
  if (!date) return null;
  const time = (t) => (/^\d{2}:\d{2}$/.test(t || '') ? t : null);
  const start = time(ev.start);
  const end = start ? time(ev.end) : null;
  return {
    id: ev.id || crypto.randomUUID(),
    title: String(ev.title || '(제목 없음)').slice(0, 200),
    date,
    start,
    end: end && end > start ? end : null,
    allDay: !start,
    kind: ev.kind || 'event',
    note: String(ev.note || '').slice(0, 2000),
    source: ev.source || null,
  };
}

function addEventsFromCandidate(candidate, events) {
  const source = { messageId: candidate.messageId, from: candidate.from, subject: candidate.subject };
  for (const ev of events) {
    const clean = cleanEvent({ ...ev, source });
    if (clean) data.data.events.push(clean);
  }
}

function notifyNew(candidates) {
  if (!settings.data.notify || !Notification.isSupported() || candidates.length === 0) return;
  const first = candidates[0];
  const n = new Notification({
    title: candidates.length === 1 ? '새 업무 메일' : `새 업무 메일 ${candidates.length}건`,
    body: settings.data.autoAdd
      ? `${first.subject} - 캘린더에 추가했습니다`
      : `${first.subject}\n위젯에서 일정을 확인하고 추가하세요`,
    icon: ICON_PATH,
  });
  n.on('click', showWindow);
  n.show();
}

async function checkMail() {
  if (status.checking) return;
  const accounts = readyAccounts();
  if (!accounts.length) {
    setStatus('설정 탭에서 메일 계정을 추가하세요.', true);
    return;
  }
  status.checking = true;
  setStatus('메일 확인 중...');
  const created = [];
  const errors = [];
  try {
    const seen = new Set(data.data.processedIds);
    // accounts are checked in parallel, and one failing (wrong password,
    // IMAP off, server unreachable) doesn't stop the others
    const results = await Promise.allSettled(
      accounts.map((account) => fetchNewMail(accountForImap(account), data.data.cursors[account.id])),
    );
    results.forEach((result, i) => {
      const account = accounts[i];
      if (result.status === 'rejected') {
        errors.push(`[${accountLabel(account)}] ${friendlyError(result.reason, account)}`);
        return;
      }
      const { mails, cursor } = result.value;
      for (const mail of mails) {
        if (seen.has(mail.messageId)) continue;
        seen.add(mail.messageId);
        data.data.processedIds.push(mail.messageId);
        const candidate = mailToCandidate(mail, settings.data.rules);
        if (!candidate) continue;
        candidate.account = accountLabel(account);
        const hasRealDates = candidate.events.some((e) => !e.noDate);
        if (settings.data.autoAdd && hasRealDates) {
          addEventsFromCandidate(candidate, candidate.events.filter((e) => !e.noDate));
        } else {
          data.data.candidates.unshift(candidate);
        }
        created.push(candidate);
      }
      data.data.cursors[account.id] = cursor;
    });
    data.data.processedIds = data.data.processedIds.slice(-MAX_PROCESSED_IDS);
    pruneOldCandidates();
    data.save();
    status.lastCheck = new Date().toISOString();
    notifyNew(created);
    const summary = created.length ? `새 업무 메일 ${created.length}건` : '새 업무 메일 없음';
    if (errors.length) setStatus(`${errors.join('\n')}${errors.length < accounts.length ? `\n(나머지 계정: ${summary})` : ''}`, true);
    else setStatus(summary);
  } finally {
    status.checking = false;
    broadcast();
  }
}

// Don't keep mail summaries around forever for mails nobody acted on.
function pruneOldCandidates() {
  const cutoff = Date.now() - CANDIDATE_MAX_AGE_DAYS * 86400000;
  data.data.candidates = data.data.candidates.filter((c) => new Date(c.receivedAt).getTime() >= cutoff);
}

function schedulePolling() {
  clearInterval(pollTimer);
  const minutes = Math.max(MIN_POLL_MINUTES, Number(settings.data.pollMinutes) || 3);
  pollTimer = setInterval(checkMail, minutes * 60 * 1000);
}

// ---------- window / tray ----------

function defaultBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - WIDGET_WIDTH - 24,
    y: workArea.y + 24,
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
  };
}

function boundsOnScreen(b) {
  if (!b) return false;
  return screen.getAllDisplays().some(({ workArea: w }) => b.x >= w.x - 50 && b.y >= w.y - 50 && b.x < w.x + w.width - 50 && b.y < w.y + w.height - 50);
}

function createWindow() {
  const saved = settings.data.bounds;
  const bounds = boundsOnScreen(saved) ? { ...saved, width: WIDGET_WIDTH, height: WIDGET_HEIGHT } : defaultBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: settings.data.alwaysOnTop,
    show: false,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.loadFile(INDEX_HTML);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // developer tools for the widget UI while running from source (npm start / VS Code)
  if (!app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (_e, input) => {
      const combo = input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'));
      if (combo) mainWindow.webContents.toggleDevTools();
    });
  }

  mainWindow.on('moved', () => {
    settings.data.bounds = mainWindow.getBounds();
    settings.save();
  });
  // closing the widget only hides it; quitting is from the tray menu
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) mainWindow.hide();
  else showWindow();
}

function updateTray() {
  if (!tray) return;
  const pending = data.data.candidates.length;
  tray.setToolTip(pending ? `메일 캘린더 위젯 - 확인할 업무 메일 ${pending}건` : '메일 캘린더 위젯');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: mainWindow && mainWindow.isVisible() ? '위젯 숨기기' : '위젯 보이기', click: toggleWindow },
      { label: '지금 메일 확인', click: checkMail },
      { type: 'separator' },
      {
        label: '항상 위에 표시',
        type: 'checkbox',
        checked: settings.data.alwaysOnTop,
        click: (item) => {
          settings.data.alwaysOnTop = item.checked;
          settings.save();
          if (mainWindow) mainWindow.setAlwaysOnTop(item.checked);
        },
      },
      {
        label: '윈도우 시작 시 자동 실행',
        type: 'checkbox',
        checked: settings.data.openAtLogin,
        click: (item) => applyOpenAtLogin(item.checked),
      },
      { type: 'separator' },
      {
        label: '종료',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function applyOpenAtLogin(enabled) {
  settings.data.openAtLogin = !!enabled;
  settings.save();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!enabled });
  broadcast();
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON_PATH).resize({ width: 32, height: 32 }));
  tray.on('click', toggleWindow);
  updateTray();
}

// ---------- IPC ----------

// Only the widget's own page may call into the main process.
function fromWidget(event) {
  const frame = event.senderFrame;
  return !!(mainWindow && event.sender === mainWindow.webContents && frame && frame.url.split(/[?#]/)[0] === INDEX_URL);
}

function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromWidget(event)) throw new Error('blocked');
    return fn(event, ...args);
  });
}

function listFromInput(v) {
  return (Array.isArray(v) ? v : String(v || '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean);
}

handle('state:get', () => publicState());

handle('settings:save', (_e, input) => {
  const s = settings.data;
  const previous = new Map(s.accounts.map((a) => [a.id, a]));
  const accounts = [];
  for (const acc of input.accounts || []) {
    const user = String(acc.user || '').trim();
    if (!user) continue;
    const old = previous.get(acc.id);
    const next = {
      id: old ? old.id : crypto.randomUUID(),
      provider: PROVIDERS[acc.provider] ? acc.provider : 'custom',
      user,
      host: String(acc.host || '').trim(),
      port: Number(acc.port) || 993,
      passEnc: old ? old.passEnc : '',
    };
    if (acc.password) next.passEnc = encryptPassword(normalizePassword(next.provider, acc.password));
    // a different mailbox behind the same entry: start that account over
    const oldServer = old && serverFor(old);
    const newServer = serverFor(next);
    if (old && (old.user !== next.user || oldServer.host !== newServer.host)) delete data.data.cursors[next.id];
    accounts.push(next);
  }
  for (const id of previous.keys()) {
    if (!accounts.some((a) => a.id === id)) delete data.data.cursors[id];
  }
  s.accounts = accounts;
  s.pollMinutes = Math.max(MIN_POLL_MINUTES, Number(input.pollMinutes) || 3);
  s.autoAdd = !!input.autoAdd;
  s.notify = !!input.notify;
  s.rules = {
    workDomains: listFromInput(input.rules && input.rules.workDomains),
    workSenders: listFromInput(input.rules && input.rules.workSenders),
    includeKeywords: listFromInput(input.rules && input.rules.includeKeywords),
    excludeKeywords: listFromInput(input.rules && input.rules.excludeKeywords),
  };
  settings.save();
  data.save();
  applyOpenAtLogin(input.openAtLogin);
  schedulePolling();
  setStatus('설정을 저장했습니다.');
  return publicState();
});

// Test what's typed in the form; fall back to the saved password when the
// password field was left empty for an existing account.
handle('mail:test', async (_e, acc = {}) => {
  const saved = settings.data.accounts.find((a) => a.id === acc.id);
  const provider = acc.provider || 'custom';
  const pass = acc.password ? normalizePassword(provider, acc.password) : saved ? decryptPassword(saved.passEnc) : '';
  if (!acc.user || !pass) return { ok: false, message: '아이디와 비밀번호를 입력하세요.' };
  if (!serverFor({ ...acc, provider }).host) return { ok: false, message: 'IMAP 서버 주소를 입력하세요.' };
  return testConnection({ provider, host: acc.host, port: acc.port, user: String(acc.user).trim(), pass });
});

handle('mail:check', async () => {
  await checkMail();
  return publicState();
});

handle('candidate:accept', (_e, candidateId, events) => {
  const idx = data.data.candidates.findIndex((c) => c.id === candidateId);
  if (idx === -1) return publicState();
  addEventsFromCandidate(data.data.candidates[idx], events || []);
  data.data.candidates.splice(idx, 1);
  data.save();
  broadcast();
  return publicState();
});

handle('candidate:dismiss', (_e, candidateId) => {
  data.data.candidates = data.data.candidates.filter((c) => c.id !== candidateId);
  data.save();
  broadcast();
  return publicState();
});

handle('event:save', (_e, ev) => {
  const clean = cleanEvent(ev);
  if (!clean) return publicState();
  const idx = data.data.events.findIndex((x) => x.id === clean.id);
  if (idx === -1) data.data.events.push(clean);
  else data.data.events[idx] = { ...clean, source: data.data.events[idx].source };
  data.save();
  broadcast();
  return publicState();
});

handle('event:delete', (_e, id) => {
  data.data.events = data.data.events.filter((x) => x.id !== id);
  data.save();
  broadcast();
  return publicState();
});

handle('ics:export', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '캘린더 내보내기',
    defaultPath: path.join(app.getPath('documents'), '업무일정.ics'),
    filters: [{ name: 'iCalendar', extensions: ['ics'] }],
  });
  if (result.canceled || !result.filePath) return false;
  fs.writeFileSync(result.filePath, toIcs(data.data.events));
  return true;
});

// Opening a one-event .ics hands it to the default calendar app (Outlook /
// Windows Calendar), which shows its own "save to calendar" dialog.
handle('ics:open', async (_e, id) => {
  const ev = data.data.events.find((x) => x.id === id);
  if (!ev) return false;
  fs.mkdirSync(ICS_TEMP_DIR, { recursive: true });
  const file = path.join(ICS_TEMP_DIR, `${crypto.randomUUID()}.ics`);
  fs.writeFileSync(file, toIcs([ev]), { mode: 0o600 });
  const err = await shell.openPath(file);
  // the calendar app has read it by then; don't leave event details in temp
  setTimeout(() => fs.rm(file, { force: true }, () => {}), ICS_TEMP_TTL_MS);
  return !err;
});

function clearIcsTemp() {
  fs.rmSync(ICS_TEMP_DIR, { recursive: true, force: true });
}

// "모든 데이터 삭제": accounts, passwords, candidates, events, temp files
handle('data:wipe', () => {
  clearInterval(pollTimer);
  settings.reset();
  data.reset();
  clearIcsTemp();
  applyOpenAtLogin(false);
  schedulePolling();
  setStatus('모든 계정과 데이터를 삭제했습니다.');
  return publicState();
});

ipcMain.on('window:hide', (event) => {
  if (fromWidget(event) && mainWindow) mainWindow.hide();
});

// ---------- app lifecycle ----------

function lockDownSessions() {
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID); // needed for Windows toast notifications
    lockDownSessions();
    openStores();
    clearIcsTemp();
    createWindow();
    createTray();
    schedulePolling();
    setTimeout(checkMail, 3000);
  });

  app.on('before-quit', () => {
    quitting = true;
    clearIcsTemp();
  });

  // The widget never needs to leave its own page: no navigation, no popups,
  // no <webview>, and every browser permission (camera, notifications from
  // the page, geolocation, ...) is refused.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (e, url) => {
      if (url !== INDEX_URL) e.preventDefault();
    });
    contents.on('will-attach-webview', (e) => e.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  // keep running in the tray when the widget window is hidden
  app.on('window-all-closed', (e) => e.preventDefault());
}
