const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, shell, safeStorage, Notification, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const { JsonStore } = require('./lib/jsonStore');
const { DEFAULT_RULES } = require('./lib/rules');
const { mailToCandidate } = require('./lib/processMail');
const { DAUM_IMAP, fetchNewMail, testConnection, friendlyError } = require('./lib/mailWatcher');
const { toIcs } = require('./lib/ics');

const APP_ID = 'com.mailcalendarwidget.app';
const WIDGET_WIDTH = 360;
const WIDGET_HEIGHT = 580;
const MIN_POLL_MINUTES = 1;
const MAX_PROCESSED_IDS = 1000;
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

let mainWindow = null;
let tray = null;
let pollTimer = null;
let quitting = false;

const userDir = app.getPath('userData');
const settings = new JsonStore(path.join(userDir, 'settings.json'), {
  account: { host: DAUM_IMAP.host, port: DAUM_IMAP.port, user: '', passEnc: '' },
  pollMinutes: 3,
  autoAdd: false,
  notify: true,
  openAtLogin: false,
  alwaysOnTop: false,
  rules: DEFAULT_RULES,
  bounds: null,
});
// events: confirmed calendar entries; candidates: work mails waiting for the
// user to confirm; cursor/processedIds: where the IMAP check left off.
const data = new JsonStore(path.join(userDir, 'data.json'), {
  events: [],
  candidates: [],
  cursor: {},
  processedIds: [],
});
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

function accountForImap() {
  const a = settings.data.account;
  return { host: a.host, port: a.port, user: a.user, pass: decryptPassword(a.passEnc) };
}

function isAccountReady() {
  const a = settings.data.account;
  return !!(a.user && a.passEnc);
}

// ---------- state sent to the renderer ----------

function publicState() {
  const { account, ...rest } = settings.data;
  return {
    settings: { ...rest, account: { host: account.host, port: account.port, user: account.user, hasPassword: !!account.passEnc } },
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
  if (!isAccountReady()) {
    setStatus('설정 탭에서 다음 메일 계정을 입력하세요.', true);
    return;
  }
  status.checking = true;
  setStatus('메일 확인 중...');
  try {
    const { mails, cursor } = await fetchNewMail(accountForImap(), data.data.cursor);
    const seen = new Set(data.data.processedIds);
    const created = [];
    for (const mail of mails) {
      if (seen.has(mail.messageId)) continue;
      seen.add(mail.messageId);
      data.data.processedIds.push(mail.messageId);
      const candidate = mailToCandidate(mail, settings.data.rules);
      if (!candidate) continue;
      const hasRealDates = candidate.events.some((e) => !e.noDate);
      if (settings.data.autoAdd && hasRealDates) {
        addEventsFromCandidate(candidate, candidate.events.filter((e) => !e.noDate));
      } else {
        data.data.candidates.unshift(candidate);
      }
      created.push(candidate);
    }
    data.data.processedIds = data.data.processedIds.slice(-MAX_PROCESSED_IDS);
    data.data.cursor = cursor;
    data.save();
    status.lastCheck = new Date().toISOString();
    notifyNew(created);
    setStatus(created.length ? `새 업무 메일 ${created.length}건` : '새 업무 메일 없음');
  } catch (err) {
    setStatus(friendlyError(err), true);
  } finally {
    status.checking = false;
    broadcast();
  }
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
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

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

function listFromInput(v) {
  return (Array.isArray(v) ? v : String(v || '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean);
}

ipcMain.handle('state:get', () => publicState());

ipcMain.handle('settings:save', (_e, input) => {
  const s = settings.data;
  const acc = input.account || {};
  const newUser = String(acc.user || '').trim();
  if (newUser !== s.account.user) data.data.cursor = {}; // different mailbox, start over
  s.account.user = newUser;
  s.account.host = String(acc.host || DAUM_IMAP.host).trim();
  s.account.port = Number(acc.port) || DAUM_IMAP.port;
  if (acc.password) s.account.passEnc = encryptPassword(acc.password);
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

ipcMain.handle('mail:test', async (_e, acc) => {
  const current = accountForImap();
  return testConnection({
    host: (acc && acc.host) || current.host,
    port: (acc && acc.port) || current.port,
    user: (acc && acc.user) || current.user,
    pass: (acc && acc.password) || current.pass,
  });
});

ipcMain.handle('mail:check', async () => {
  await checkMail();
  return publicState();
});

ipcMain.handle('candidate:accept', (_e, candidateId, events) => {
  const idx = data.data.candidates.findIndex((c) => c.id === candidateId);
  if (idx === -1) return publicState();
  addEventsFromCandidate(data.data.candidates[idx], events || []);
  data.data.candidates.splice(idx, 1);
  data.save();
  broadcast();
  return publicState();
});

ipcMain.handle('candidate:dismiss', (_e, candidateId) => {
  data.data.candidates = data.data.candidates.filter((c) => c.id !== candidateId);
  data.save();
  broadcast();
  return publicState();
});

ipcMain.handle('event:save', (_e, ev) => {
  const clean = cleanEvent(ev);
  if (!clean) return publicState();
  const idx = data.data.events.findIndex((x) => x.id === clean.id);
  if (idx === -1) data.data.events.push(clean);
  else data.data.events[idx] = { ...clean, source: data.data.events[idx].source };
  data.save();
  broadcast();
  return publicState();
});

ipcMain.handle('event:delete', (_e, id) => {
  data.data.events = data.data.events.filter((x) => x.id !== id);
  data.save();
  broadcast();
  return publicState();
});

ipcMain.handle('ics:export', async () => {
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
ipcMain.handle('ics:open', async (_e, id) => {
  const ev = data.data.events.find((x) => x.id === id);
  if (!ev) return false;
  const file = path.join(os.tmpdir(), `mail-calendar-${ev.id}.ics`);
  fs.writeFileSync(file, toIcs([ev]));
  const err = await shell.openPath(file);
  return !err;
});

ipcMain.on('window:hide', () => mainWindow && mainWindow.hide());

// ---------- app lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID); // needed for Windows toast notifications
    createWindow();
    createTray();
    schedulePolling();
    setTimeout(checkMail, 3000);
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  // keep running in the tray when the widget window is hidden
  app.on('window-all-closed', (e) => e.preventDefault());
}
