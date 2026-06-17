// Preload for the embedded <webview> guest. Runs in the guest's isolated world
// and exposes a single reporting hook into the guest's main world so the picker
// script (injected via executeJavaScript) can hand a captured selector back to
// the host renderer, which forwards it to main. Mirrors overlayPreload.js.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__bbReport', (payload) => {
  ipcRenderer.sendToHost('bbReport', payload);
});
