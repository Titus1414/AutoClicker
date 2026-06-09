// AutoClicker — main process.
// Owns the click list, the run engine, global hotkeys, on-screen circle
// overlays, and persistence. The renderer is a thin view that sends commands.
const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { Engine } = require('./automation');
const { OverlayManager } = require('./overlay');

let mainWindow = null;
const engine = new Engine();
const overlays = new OverlayManager();

const state = {
  clicks: [],
  settings: { hideCircles: false, captureKey: 'F6', toggleKey: 'F8' },
};
let clipboard = [];   // copied click templates (no ids)
let nextId = 1;
let armedId = null;   // click awaiting an F6 position capture

// ---------- persistence ----------
const stateFile = () => path.join(app.getPath('userData'), 'state.json');

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (parsed && Array.isArray(parsed.clicks)) {
      state.clicks = parsed.clicks.map(normalizeClick);
      Object.assign(state.settings, parsed.settings || {});
      nextId = state.clicks.reduce((m, c) => Math.max(m, c.id), 0) + 1;
    }
  } catch (_) { /* first run, no saved state */ }
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(
        stateFile(),
        JSON.stringify({ clicks: state.clicks, settings: state.settings }, null, 2)
      );
    } catch (err) { console.error('[main] save failed', err); }
  }, 250);
}

// ---------- step model ----------
// A step is either a mouse click (type 'click') or a key chord (type 'key').
const MODIFIERS = ['ctrl', 'shift', 'alt', 'win'];

function normalizeClick(c) {
  const delay = {
    mode: c.delay?.mode === 'random' ? 'random' : 'fixed',
    value: c.delay?.value ?? 1,
    min: c.delay?.min ?? 1,
    max: c.delay?.max ?? 5,
    unit: c.delay?.unit === 'min' ? 'min' : 'sec',
  };
  if (c.type === 'key') {
    return {
      id: c.id,
      type: 'key',
      modifiers: Array.isArray(c.modifiers) ? c.modifiers.filter((m) => MODIFIERS.includes(m)) : [],
      key: typeof c.key === 'string' ? c.key : '',
      delay,
    };
  }
  return {
    id: c.id,
    type: 'click',
    x: Math.round(c.x) || 0,
    y: Math.round(c.y) || 0,
    // Per-click position increment, applied after every firing (resets each run).
    stepX: Number(c.stepX) || 0,
    stepY: Number(c.stepY) || 0,
    button: c.button || 'left',
    double: !!c.double,
    delay,
  };
}

function makeClick(x, y) {
  return normalizeClick({ id: nextId++, x, y });
}

function makeKey() {
  return normalizeClick({ id: nextId++, type: 'key', modifiers: ['ctrl'], key: 'C' });
}

// ---------- coordinate conversion (DIP -> physical pixels) ----------
function dipToPhysical(x, y) {
  const d = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
  const sf = d.scaleFactor || 1;
  return {
    x: Math.round(d.bounds.x + (x - d.bounds.x) * sf),
    y: Math.round(d.bounds.y + (y - d.bounds.y) * sf),
  };
}

function toRuntime(c) {
  if (c.type === 'key') {
    return { id: c.id, type: 'key', modifiers: c.modifiers, key: c.key, delay: c.delay };
  }
  const p = dipToPhysical(c.x, c.y);
  // Convert the DIP increment to physical pixels via the same display scale.
  const p2 = dipToPhysical(c.x + c.stepX, c.y + c.stepY);
  return {
    id: c.id, type: 'click', x: p.x, y: p.y,
    stepX: p2.x - p.x, stepY: p2.y - p.y,
    button: c.button, double: c.double, delay: c.delay,
  };
}

// ---------- broadcast / sync ----------
function publicState() {
  return {
    clicks: state.clicks,
    settings: state.settings,
    running: engine.running,
    canPaste: clipboard.length > 0,
    armedId,
  };
}

function syncOverlays() {
  // Circles are hidden while running so automated clicks land on the real target.
  // Only mouse-click steps have an on-screen marker.
  const visible = !state.settings.hideCircles && !engine.running;
  overlays.sync(state.clicks.filter((c) => c.type === 'click'), visible);
}

function broadcast() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state', publicState());
  }
  syncOverlays();
  saveState();
}

function sendEngine(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('engine', payload);
}

// ---------- run control ----------
function startRun() {
  if (engine.running || state.clicks.length === 0) return;
  armedId = null;
  const runtime = state.clicks.map(toRuntime);
  engine
    .run(runtime, (id, idx) => sendEngine({ running: true, currentId: id, index: idx }))
    .then(() => {
      sendEngine({ running: false, currentId: null, index: -1 });
      broadcast();
    });
  // engine.running is already true here (set synchronously by run()).
  broadcast();
  sendEngine({ running: true, currentId: null, index: -1 });
}

function stopRun() {
  engine.stop();
}

function toggleRun() {
  if (engine.running) stopRun();
  else startRun();
}

function doCapture() {
  if (armedId == null) return;
  const c = state.clicks.find((c) => c.id === armedId);
  if (!c) { armedId = null; return; }
  const pt = screen.getCursorScreenPoint(); // DIP
  c.x = Math.round(pt.x);
  c.y = Math.round(pt.y);
  armedId = null;
  broadcast();
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  try { globalShortcut.register(state.settings.captureKey, doCapture); } catch (_) {}
  try { globalShortcut.register(state.settings.toggleKey, toggleRun); } catch (_) {}
}

// ---------- IPC ----------
ipcMain.handle('getState', () => publicState());

ipcMain.on('addClick', () => {
  const pt = screen.getCursorScreenPoint();
  state.clicks.push(makeClick(pt.x, pt.y));
  broadcast();
});

ipcMain.on('addKey', () => {
  state.clicks.push(makeKey());
  broadcast();
});

ipcMain.on('updateClick', (_e, { id, patch }) => {
  const c = state.clicks.find((c) => c.id === id);
  if (!c) return;
  if (patch.delay) patch.delay = Object.assign({}, c.delay, patch.delay);
  Object.assign(c, patch);
  broadcast();
});

ipcMain.on('deleteClick', (_e, id) => {
  state.clicks = state.clicks.filter((c) => c.id !== id);
  overlays.remove(id);
  if (armedId === id) armedId = null;
  broadcast();
});

ipcMain.on('moveClick', (_e, { id, dir }) => {
  const i = state.clicks.findIndex((c) => c.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.clicks.length) return;
  [state.clicks[i], state.clicks[j]] = [state.clicks[j], state.clicks[i]];
  broadcast();
});

ipcMain.on('copyClicks', (_e, ids) => {
  // Store a full deep copy of each step (minus its id) so any type round-trips.
  clipboard = state.clicks
    .filter((c) => ids.includes(c.id))
    .map((c) => {
      const { id, ...rest } = c;
      return JSON.parse(JSON.stringify(rest));
    });
  broadcast();
});

ipcMain.on('pasteClicks', () => {
  for (const t of clipboard) {
    const nc = normalizeClick({ ...t, id: nextId++ });
    if (nc.type === 'click') { nc.x += 24; nc.y += 24; } // offset so the copy is visible
    state.clicks.push(nc);
  }
  broadcast();
});

ipcMain.on('armCapture', (_e, id) => {
  const c = state.clicks.find((c) => c.id === id);
  armedId = c && c.type === 'click' ? id : null; // only clicks have a position to capture
  broadcast();
});

ipcMain.on('run', startRun);
ipcMain.on('stop', stopRun);

ipcMain.on('setSettings', (_e, patch) => {
  Object.assign(state.settings, patch);
  registerShortcuts();
  broadcast();
});

// Overlay drag: live move, then commit center back to the click on release.
ipcMain.on('overlay:move', (e, { x, y }) => {
  const id = overlays.idOf(e.sender);
  if (id != null) overlays.setTopLeft(id, x, y);
});

ipcMain.on('overlay:moveEnd', (e) => {
  const id = overlays.idOf(e.sender);
  if (id == null) return;
  const center = overlays.center(id);
  const c = state.clicks.find((c) => c.id === id);
  if (c && center) { c.x = center.x; c.y = center.y; broadcast(); }
});

// ---------- window / app lifecycle ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 940,
    height: 660,
    minWidth: 780,
    minHeight: 480,
    title: 'AutoClicker',
    backgroundColor: '#1e1f25',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.webContents.on('did-finish-load', broadcast);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  loadState();
  createWindow();
  registerShortcuts();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  engine.stop();
  overlays.destroyAll();
  app.quit();
});
