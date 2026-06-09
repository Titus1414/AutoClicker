// Bridge between the renderer UI and the main process. Exposes a small,
// explicit API on window.api — the renderer has no direct Node access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('getState'),
  addClick: () => ipcRenderer.send('addClick'),
  addKey: () => ipcRenderer.send('addKey'),
  updateClick: (id, patch) => ipcRenderer.send('updateClick', { id, patch }),
  deleteClick: (id) => ipcRenderer.send('deleteClick', id),
  moveClick: (id, dir) => ipcRenderer.send('moveClick', { id, dir }),
  copyClicks: (ids) => ipcRenderer.send('copyClicks', ids),
  pasteClicks: () => ipcRenderer.send('pasteClicks'),
  armCapture: (id) => ipcRenderer.send('armCapture', id),
  run: () => ipcRenderer.send('run'),
  stop: () => ipcRenderer.send('stop'),
  setSettings: (patch) => ipcRenderer.send('setSettings', patch),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onEngine: (cb) => ipcRenderer.on('engine', (_e, s) => cb(s)),
});
