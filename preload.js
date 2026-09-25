const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetAPI', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (callback) => ipcRenderer.on('state:changed', (_event, state) => callback(state)),
  saveSettings: (input) => ipcRenderer.invoke('settings:save', input),
  testMail: (account) => ipcRenderer.invoke('mail:test', account),
  checkMail: () => ipcRenderer.invoke('mail:check'),
  acceptCandidate: (id, events) => ipcRenderer.invoke('candidate:accept', id, events),
  dismissCandidate: (id) => ipcRenderer.invoke('candidate:dismiss', id),
  saveEvent: (ev) => ipcRenderer.invoke('event:save', ev),
  deleteEvent: (id) => ipcRenderer.invoke('event:delete', id),
  exportIcs: () => ipcRenderer.invoke('ics:export'),
  openIcs: (id) => ipcRenderer.invoke('ics:open', id),
  hide: () => ipcRenderer.send('window:hide'),
});
