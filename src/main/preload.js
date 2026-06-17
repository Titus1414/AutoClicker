// Bridge between the renderer UI and the main process. Exposes a small,
// explicit API on window.api — the renderer has no direct Node access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('getState'),
  addClick: () => ipcRenderer.send('addClick'),
  addKey: () => ipcRenderer.send('addKey'),
  addDrag: () => ipcRenderer.send('addDrag'),
  addScroll: () => ipcRenderer.send('addScroll'),
  addCondition: () => ipcRenderer.send('addCondition'),
  updateClick: (id, patch) => ipcRenderer.send('updateClick', { id, patch }),
  deleteClick: (id) => ipcRenderer.send('deleteClick', id),
  moveClick: (id, dir) => ipcRenderer.send('moveClick', { id, dir }),
  copyClicks: (ids) => ipcRenderer.send('copyClicks', ids),
  pasteClicks: () => ipcRenderer.send('pasteClicks'),
  armCapture: (id, field) => ipcRenderer.send('armCapture', { id, field }),
  run: () => ipcRenderer.send('run'),
  stop: () => ipcRenderer.send('stop'),
  setSettings: (patch) => ipcRenderer.send('setSettings', patch),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onEngine: (cb) => ipcRenderer.on('engine', (_e, s) => cb(s)),

  // ----- Browser Bot mode -----
  setMode: (mode) => ipcRenderer.send('setMode', mode),
  browserSetGuestId: (id) => ipcRenderer.send('browser:guestId', id),
  browserNavigate: (url) => ipcRenderer.send('browser:navigate', url),
  browserSetUrl: (url) => ipcRenderer.send('browser:url', url),
  addBrowserStep: (kind) => ipcRenderer.send('browser:addStep', kind),
  addBrowserChild: (parentId, branch, kind) => ipcRenderer.send('browser:addChild', { parentId, branch, kind }),
  updateBrowserStep: (id, patch) => ipcRenderer.send('browser:updateStep', { id, patch }),
  deleteBrowserStep: (id) => ipcRenderer.send('browser:deleteStep', id),
  moveBrowserStep: (id, dir) => ipcRenderer.send('browser:moveStep', { id, dir }),
  browserPick: (id, field) => ipcRenderer.send('browser:pick', { id, field }),
  browserPickResult: (payload) => ipcRenderer.send('browser:pickResult', payload),
  browserRun: () => ipcRenderer.send('browser:run'),
  browserStop: () => ipcRenderer.send('browser:stop'),
  onBrowserEngine: (cb) => ipcRenderer.on('browserEngine', (_e, s) => cb(s)),
});
