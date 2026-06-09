// Manages the small, transparent, always-on-top "circle" windows that mark
// each click's position on screen. One BrowserWindow per click. Coordinates
// here are in Electron's DIP screen space.
const { BrowserWindow } = require('electron');
const path = require('path');

const SIZE = 46;

class OverlayManager {
  constructor() {
    this.byId = new Map();    // clickId -> BrowserWindow
    this.wcToId = new Map();  // webContents.id -> clickId
    this.labels = new Map();  // clickId -> number shown in the circle
  }

  idOf(webContents) {
    return this.wcToId.get(webContents.id);
  }

  // Reconcile overlay windows with the current click list.
  sync(clicks, visible) {
    const ids = new Set(clicks.map((c) => c.id));
    for (const id of [...this.byId.keys()]) {
      if (!ids.has(id)) this.remove(id);
    }
    clicks.forEach((c, idx) => {
      let win = this.byId.get(c.id);
      if (!win) win = this._create(c.id);
      this._label(c.id, idx + 1);
      this._setCenter(c.id, c.x, c.y);
      if (win.isDestroyed()) return;
      if (visible) { if (!win.isVisible()) win.showInactive(); }
      else if (win.isVisible()) win.hide();
    });
  }

  _create(id) {
    const win = new BrowserWindow({
      width: SIZE,
      height: SIZE,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      focusable: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'overlayPreload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.loadFile(path.join(__dirname, '../overlay/circle.html'));
    win.webContents.on('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.send('label', this.labels.get(id) || 1);
    });
    win.on('closed', () => { this.wcToId.delete(win.webContents.id); });

    this.byId.set(id, win);
    this.wcToId.set(win.webContents.id, id);
    return win;
  }

  _label(id, n) {
    this.labels.set(id, n);
    const win = this.byId.get(id);
    if (win && !win.isDestroyed()) win.webContents.send('label', n);
  }

  _setCenter(id, cx, cy) {
    const win = this.byId.get(id);
    if (!win || win.isDestroyed()) return;
    win.setBounds({ x: Math.round(cx - SIZE / 2), y: Math.round(cy - SIZE / 2), width: SIZE, height: SIZE });
  }

  // Live reposition during a drag (top-left in DIP).
  setTopLeft(id, x, y) {
    const win = this.byId.get(id);
    if (!win || win.isDestroyed()) return;
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: SIZE, height: SIZE });
  }

  // Current center of an overlay window (DIP).
  center(id) {
    const win = this.byId.get(id);
    if (!win || win.isDestroyed()) return null;
    const b = win.getBounds();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  }

  remove(id) {
    const win = this.byId.get(id);
    if (win && !win.isDestroyed()) {
      this.wcToId.delete(win.webContents.id);
      win.close();
    }
    this.byId.delete(id);
    this.labels.delete(id);
  }

  destroyAll() {
    for (const id of [...this.byId.keys()]) this.remove(id);
  }
}

module.exports = { OverlayManager };
