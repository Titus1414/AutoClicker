// Manages the small, transparent, always-on-top "circle" windows that mark
// each click's position on screen. One BrowserWindow per marker — a plain
// click has a single marker; a drag has two (its start and end points).
// Markers are keyed by a string "<clickId>:<field>" (field: pos | start | end).
// Coordinates here are in Electron's DIP screen space.
const { BrowserWindow } = require('electron');
const path = require('path');

const SIZE = 46;

class OverlayManager {
  constructor() {
    this.byKey = new Map();    // markerKey -> BrowserWindow
    this.wcToKey = new Map();  // webContents.id -> markerKey
    this.meta = new Map();     // markerKey -> { label, kind }
  }

  idOf(webContents) {
    return this.wcToKey.get(webContents.id);
  }

  // Reconcile overlay windows with the current marker list.
  // markers: [{ key, label, kind, x, y }]
  sync(markers, visible) {
    const keys = new Set(markers.map((m) => m.key));
    for (const key of [...this.byKey.keys()]) {
      if (!keys.has(key)) this.remove(key);
    }
    markers.forEach((m) => {
      let win = this.byKey.get(m.key);
      if (!win) win = this._create(m.key);
      this._label(m.key, m.label, m.kind);
      this._setCenter(m.key, m.x, m.y);
      if (win.isDestroyed()) return;
      if (visible) { if (!win.isVisible()) win.showInactive(); }
      else if (win.isVisible()) win.hide();
    });
  }

  _create(key) {
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
      const m = this.meta.get(key) || { label: '1', kind: 'click' };
      if (!win.isDestroyed()) win.webContents.send('label', m);
    });
    win.on('closed', () => { this.wcToKey.delete(win.webContents.id); });

    this.byKey.set(key, win);
    this.wcToKey.set(win.webContents.id, key);
    return win;
  }

  _label(key, label, kind) {
    const m = { label: String(label), kind: kind || 'click' };
    this.meta.set(key, m);
    const win = this.byKey.get(key);
    if (win && !win.isDestroyed()) win.webContents.send('label', m);
  }

  _setCenter(key, cx, cy) {
    const win = this.byKey.get(key);
    if (!win || win.isDestroyed()) return;
    win.setBounds({ x: Math.round(cx - SIZE / 2), y: Math.round(cy - SIZE / 2), width: SIZE, height: SIZE });
  }

  // Live reposition during a drag (top-left in DIP).
  setTopLeft(key, x, y) {
    const win = this.byKey.get(key);
    if (!win || win.isDestroyed()) return;
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: SIZE, height: SIZE });
  }

  // Current center of an overlay window (DIP).
  center(key) {
    const win = this.byKey.get(key);
    if (!win || win.isDestroyed()) return null;
    const b = win.getBounds();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  }

  remove(key) {
    const win = this.byKey.get(key);
    if (win && !win.isDestroyed()) {
      this.wcToKey.delete(win.webContents.id);
      win.close();
    }
    this.byKey.delete(key);
    this.meta.delete(key);
  }

  // Remove every marker belonging to a click (its pos, or its start + end).
  removeForClick(clickId) {
    const prefix = `${clickId}:`;
    for (const key of [...this.byKey.keys()]) {
      if (key.startsWith(prefix)) this.remove(key);
    }
  }

  destroyAll() {
    for (const key of [...this.byKey.keys()]) this.remove(key);
  }
}

module.exports = { OverlayManager };
