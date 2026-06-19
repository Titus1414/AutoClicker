// Preload for the on-screen circle windows.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  move: (x, y) => ipcRenderer.send('overlay:move', { x, y }),
  moveEnd: () => ipcRenderer.send('overlay:moveEnd'),
  onLabel: (cb) => ipcRenderer.on('label', (_e, m) => cb(m)),
});
