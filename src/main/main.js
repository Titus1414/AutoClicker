// AutoClicker — main process.
// Owns the click list, the run engine, global hotkeys, on-screen circle
// overlays, and persistence. The renderer is a thin view that sends commands.
const { app, BrowserWindow, ipcMain, globalShortcut, screen, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const { Engine, signatureOf } = require('./automation');
const { BrowserEngine, normalizeUrl } = require('./browserAutomation');
const { BB_PICKER } = require('./browserScripts');
const { OverlayManager } = require('./overlay');
// nut.js screen, aliased so it doesn't shadow Electron's `screen` above.
// Used to sample pixel color / a region signature when capturing a condition.
const { screen: nutScreen, Point: NutPoint, Region: NutRegion } = require('@nut-tree-fork/nut-js');

let mainWindow = null;
const engine = new Engine();
const browserEngine = new BrowserEngine();
const overlays = new OverlayManager();

const state = {
  clicks: [],
  // Browser Bot mode: a separate list of DOM-aware steps run against the
  // embedded <webview>. Kept apart from `clicks` so the screen clicker is
  // untouched; `mode` picks which one the UI shows and F8 toggles.
  browserSteps: [],
  mode: 'screen',           // 'screen' | 'browser'
  browser: { url: '' },     // last navigated URL (restored on launch)
  settings: { hideCircles: false, captureKey: 'F6', toggleKey: 'F8' },
};
let clipboard = [];   // copied click templates (no ids)
let nextId = 1;
let armed = null;     // { id, field } awaiting an F6 position capture, or null
let browserGuestWc = null;   // the embedded webview's webContents (once attached)
let browserPickTarget = null; // { id, field } awaiting a click-to-pick result

// ---------- persistence ----------
const stateFile = () => path.join(app.getPath('userData'), 'state.json');

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.clicks)) state.clicks = parsed.clicks.map(normalizeClick);
      if (Array.isArray(parsed.browserSteps)) state.browserSteps = parsed.browserSteps.map(normalizeBrowserStep);
      if (parsed.mode === 'browser' || parsed.mode === 'screen') state.mode = parsed.mode;
      if (parsed.browser && typeof parsed.browser.url === 'string') state.browser.url = parsed.browser.url;
      Object.assign(state.settings, parsed.settings || {});
      nextId = maxId([...state.clicks, ...state.browserSteps]) + 1;
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
        JSON.stringify({
          clicks: state.clicks,
          browserSteps: state.browserSteps,
          mode: state.mode,
          browser: state.browser,
          settings: state.settings,
        }, null, 2)
      );
    } catch (err) {
      // A failed autosave (e.g. disk full / ENOSPC) must never crash the app.
      // Guard the log too: writing to a full disk can itself throw.
      try { console.error('[main] save failed', err && err.code ? err.code : err); } catch (_) {}
    }
  }, 250);
}

// ---------- step model ----------
// A step is either a mouse click (type 'click') or a key chord (type 'key').
const MODIFIERS = ['ctrl', 'shift', 'alt', 'win'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Normalize a condition step's `check` block (the test) defensively so old
// state.json files and pasted steps round-trip cleanly.
function normalizeCheck(ch = {}) {
  return {
    type: ['pixel', 'pixelChanged', 'image', 'loop'].includes(ch.type) ? ch.type : 'pixel',
    x: Math.round(ch.x) || 0,
    y: Math.round(ch.y) || 0,
    w: Math.max(1, Math.round(Number(ch.w) || 32)),
    h: Math.max(1, Math.round(Number(ch.h) || 32)),
    color: typeof ch.color === 'string' ? ch.color : '#00ff00',
    tolerance: clamp(Math.round(Number(ch.tolerance ?? 16)) || 0, 0, 255),
    signature: Array.isArray(ch.signature) ? ch.signature : null,
    confidence: clamp(Number(ch.confidence ?? 0.9), 0, 1),
    loopMode: ['everyN', 'firstN', 'afterN'].includes(ch.loopMode) ? ch.loopMode : 'everyN',
    loopN: Math.max(1, Math.round(Number(ch.loopN) || 2)),
  };
}

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
  if (c.type === 'drag') {
    return {
      id: c.id,
      type: 'drag',
      x: Math.round(c.x) || 0,
      y: Math.round(c.y) || 0,
      x2: Math.round(c.x2) || 0,
      y2: Math.round(c.y2) || 0,
      button: c.button || 'left',
      // How long the press-and-move takes, in milliseconds (0 = instant jump).
      duration: Math.max(0, Math.round(Number(c.duration) || 0)),
      delay,
    };
  }
  if (c.type === 'scroll') {
    const dir = ['up', 'down', 'left', 'right'].includes(c.direction) ? c.direction : 'down';
    return {
      id: c.id,
      type: 'scroll',
      x: Math.round(c.x) || 0,
      y: Math.round(c.y) || 0,
      direction: dir,
      // Number of scroll "steps" (wheel notches) per firing.
      amount: Math.max(0, Math.round(Number(c.amount) || 0)),
      delay,
    };
  }
  if (c.type === 'condition') {
    return {
      id: c.id,
      type: 'condition',
      check: normalizeCheck(c.check),
      onFalse: ['skip', 'stop', 'wait'].includes(c.onFalse) ? c.onFalse : 'skip',
      skipCount: Math.max(0, Math.round(Number(c.skipCount) || 1)),
      timeoutSec: Math.max(0, Number(c.timeoutSec) || 10),
      onTimeout: ['skip', 'stop'].includes(c.onTimeout) ? c.onTimeout : 'skip',
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

function makeDrag(x, y) {
  // Default end point offset to the right so both circles are visible at once.
  return normalizeClick({ id: nextId++, type: 'drag', x, y, x2: x + 160, y2: y, duration: 300 });
}

function makeScroll(x, y) {
  return normalizeClick({ id: nextId++, type: 'scroll', x, y, direction: 'down', amount: 3 });
}

function makeCondition(x, y) {
  // Default: a pixel test at the cursor that skips the next step when it fails.
  return normalizeClick({
    id: nextId++,
    type: 'condition',
    check: { type: 'pixel', x, y },
    delay: { value: 0 },
  });
}

// Write a captured/dragged point into the right field of a click or drag step.
// field: 'pos' | 'start' -> start point (x,y);  'end' -> drag end point (x2,y2).
function setPoint(c, field, x, y) {
  if (c.type === 'condition') {
    // Condition steps store their sample point inside `check` (kept in DIP).
    c.check.x = Math.round(x);
    c.check.y = Math.round(y);
  } else if (c.type === 'drag' && field === 'end') {
    c.x2 = Math.round(x);
    c.y2 = Math.round(y);
  } else {
    c.x = Math.round(x);
    c.y = Math.round(y);
  }
}

// ---------- browser step model ----------
// Browser Bot steps are DOM-aware: they target elements by CSS selector (and an
// optional matching text), so they need no coordinate conversion. The `if` step
// nests child step lists (`then`/`else`) for true branching.
const BROWSER_TYPES = ['navigate', 'clickEl', 'typeText', 'waitFor', 'waitTimeout', 'read', 'scrollToEl', 'if'];
const COND_KINDS = ['elementExists', 'elementVisible', 'textExists', 'attrEquals', 'attrContains'];

const str = (v) => (typeof v === 'string' ? v : '');
const nn = (v) => Math.max(0, Math.round(Number(v) || 0));
const posInt = (v, dflt) => (v == null || isNaN(Number(v)) ? dflt : Math.max(0, Math.round(Number(v))));

function normalizeDelay(d = {}) {
  return {
    mode: d.mode === 'random' ? 'random' : 'fixed',
    value: d.value ?? 1,
    min: d.min ?? 1,
    max: d.max ?? 5,
    unit: d.unit === 'min' ? 'min' : 'sec',
  };
}

function normalizeCond(cond = {}) {
  return {
    kind: COND_KINDS.includes(cond.kind) ? cond.kind : 'elementExists',
    selector: str(cond.selector),
    text: str(cond.text),
    nth: nn(cond.nth),
    attr: str(cond.attr) || 'href',
    value: str(cond.value),
  };
}

function normalizeBrowserStep(s = {}) {
  const type = BROWSER_TYPES.includes(s.type) ? s.type : 'clickEl';
  const base = { id: s.id, type, delay: normalizeDelay(s.delay) };
  switch (type) {
    case 'navigate':
      return { ...base, url: str(s.url), waitLoad: s.waitLoad !== false };
    case 'clickEl':
      return {
        ...base, selector: str(s.selector), text: str(s.text), nth: nn(s.nth),
        waitMs: posInt(s.waitMs, 5000),
        button: ['left', 'right', 'middle'].includes(s.button) ? s.button : 'left',
        dblclick: !!s.dblclick,
      };
    case 'typeText':
      return {
        ...base, selector: str(s.selector), text: str(s.text), nth: nn(s.nth),
        value: str(s.value), clearFirst: s.clearFirst !== false, pressEnter: !!s.pressEnter,
        waitMs: posInt(s.waitMs, 5000),
      };
    case 'waitFor':
      return {
        ...base, selector: str(s.selector), text: str(s.text), nth: nn(s.nth),
        state: ['present', 'visible', 'absent'].includes(s.state) ? s.state : 'present',
        timeoutMs: posInt(s.timeoutMs, 10000),
      };
    case 'read':
      return {
        ...base, selector: str(s.selector), text: str(s.text), nth: nn(s.nth),
        attr: str(s.attr) || 'text', varName: str(s.varName) || 'value',
      };
    case 'scrollToEl':
      return { ...base, selector: str(s.selector), text: str(s.text), nth: nn(s.nth) };
    case 'if':
      return {
        ...base, cond: normalizeCond(s.cond),
        then: Array.isArray(s.then) ? s.then.map(normalizeBrowserStep) : [],
        else: Array.isArray(s.else) ? s.else.map(normalizeBrowserStep) : [],
      };
    default:
      return base;
  }
}

function makeBrowserStep(kind) {
  const type = BROWSER_TYPES.includes(kind) ? kind : 'clickEl';
  // Action steps fire as soon as their target is ready, so default to no extra
  // pause; a Wait step is all about its delay, so give it a sensible 1s.
  const delay = type === 'waitTimeout' ? { value: 1 } : { value: 0 };
  return normalizeBrowserStep({ id: nextId++, type, delay });
}

// Largest id across a (possibly nested) step list, so nextId never collides.
function maxId(list) {
  let m = 0;
  for (const s of list || []) {
    if (s && typeof s.id === 'number') m = Math.max(m, s.id);
    if (s && s.type === 'if') m = Math.max(m, maxId(s.then), maxId(s.else));
  }
  return m;
}

// Locate a browser step by id anywhere in the (nested) tree. Returns the
// containing array + index so callers can update/move/delete in place.
function findBrowserStep(id, list = state.browserSteps) {
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s.id === id) return { list, index: i, step: s };
    if (s.type === 'if') {
      const inThen = findBrowserStep(id, s.then);
      if (inThen) return inThen;
      const inElse = findBrowserStep(id, s.else);
      if (inElse) return inElse;
    }
  }
  return null;
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
  if (c.type === 'condition') {
    // `check` coordinates stay in DIP — nut.js colorAt/grabRegion scale internally.
    return {
      id: c.id, type: 'condition', check: c.check,
      onFalse: c.onFalse, skipCount: c.skipCount,
      timeoutSec: c.timeoutSec, onTimeout: c.onTimeout, delay: c.delay,
    };
  }
  if (c.type === 'drag') {
    const a = dipToPhysical(c.x, c.y);
    const b = dipToPhysical(c.x2, c.y2);
    return {
      id: c.id, type: 'drag',
      x: a.x, y: a.y, x2: b.x, y2: b.y,
      button: c.button, duration: c.duration, delay: c.delay,
    };
  }
  if (c.type === 'scroll') {
    const p = dipToPhysical(c.x, c.y);
    return {
      id: c.id, type: 'scroll', x: p.x, y: p.y,
      direction: c.direction, amount: c.amount, delay: c.delay,
    };
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
    browserSteps: state.browserSteps,
    mode: state.mode,
    browser: state.browser,
    settings: state.settings,
    running: engine.running,
    browserRunning: browserEngine.running,
    canPaste: clipboard.length > 0,
    armed,
    armedId: armed ? armed.id : null,
    pickTarget: browserPickTarget,
  };
}

// Build the on-screen markers from the click list. A click has one marker; a
// drag has two (start + end). Key clients (capture/move) parse "<id>:<field>".
function overlayMarkers() {
  const markers = [];
  state.clicks.forEach((c, idx) => {
    const n = String(idx + 1);
    if (c.type === 'click') {
      markers.push({ key: `${c.id}:pos`, label: n, kind: 'click', x: c.x, y: c.y });
    } else if (c.type === 'drag') {
      markers.push({ key: `${c.id}:start`, label: n, kind: 'start', x: c.x, y: c.y });
      markers.push({ key: `${c.id}:end`, label: n, kind: 'end', x: c.x2, y: c.y2 });
    } else if (c.type === 'scroll') {
      markers.push({ key: `${c.id}:pos`, label: n, kind: 'scroll', x: c.x, y: c.y });
    } else if (c.type === 'condition' && c.check.type !== 'loop') {
      // Pixel/image conditions sample a screen point; show a draggable marker.
      markers.push({ key: `${c.id}:cond`, label: n, kind: 'cond', x: c.check.x, y: c.check.y });
    }
  });
  return markers;
}

function syncOverlays() {
  // Circles are hidden while running so automated clicks land on the real target.
  // Key steps have no on-screen marker.
  const visible = !state.settings.hideCircles && !engine.running;
  overlays.sync(overlayMarkers(), visible);
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
  armed = null;
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

function sendBrowserEngine(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('browserEngine', payload);
}

function startBrowserRun() {
  if (browserEngine.running || state.browserSteps.length === 0) return;
  if (!browserGuestWc || browserGuestWc.isDestroyed()) return;
  browserEngine
    .run(state.browserSteps, (id) => sendBrowserEngine({ running: true, currentId: id }))
    .then(() => {
      sendBrowserEngine({ running: false, currentId: null });
      broadcast();
    });
  broadcast();
  sendBrowserEngine({ running: true, currentId: null });
}

function stopBrowserRun() {
  browserEngine.stop();
}

// F8 toggles whichever mode is currently shown.
function toggleRun() {
  if (state.mode === 'browser') {
    if (browserEngine.running) stopBrowserRun();
    else startBrowserRun();
  } else {
    if (engine.running) stopRun();
    else startRun();
  }
}

async function doCapture() {
  if (!armed) return;
  const c = state.clicks.find((c) => c.id === armed.id);
  if (!c) { armed = null; return; }
  const pt = screen.getCursorScreenPoint(); // DIP
  setPoint(c, armed.field, pt.x, pt.y);
  // For a condition step, also sample the screen at the captured DIP point so
  // the test gets a baseline color / region signature to compare against.
  if (c.type === 'condition') {
    try {
      const ch = c.check;
      if (ch.type === 'image') {
        const img = await nutScreen.grabRegion(new NutRegion(ch.x, ch.y, ch.w, ch.h));
        ch.signature = signatureOf(img);
      } else if (ch.type === 'pixel' || ch.type === 'pixelChanged') {
        const col = await nutScreen.colorAt(new NutPoint(ch.x, ch.y));
        ch.color = '#' + [col.R, col.G, col.B].map((v) => v.toString(16).padStart(2, '0')).join('');
      }
    } catch (err) {
      console.error('[main] condition sample failed', err);
    }
  }
  armed = null;
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

ipcMain.on('addDrag', () => {
  const pt = screen.getCursorScreenPoint();
  state.clicks.push(makeDrag(pt.x, pt.y));
  broadcast();
});

ipcMain.on('addScroll', () => {
  const pt = screen.getCursorScreenPoint();
  state.clicks.push(makeScroll(pt.x, pt.y));
  broadcast();
});

ipcMain.on('addCondition', () => {
  const pt = screen.getCursorScreenPoint();
  state.clicks.push(makeCondition(pt.x, pt.y));
  broadcast();
});

ipcMain.on('updateClick', (_e, { id, patch }) => {
  const c = state.clicks.find((c) => c.id === id);
  if (!c) return;
  if (patch.delay) patch.delay = Object.assign({}, c.delay, patch.delay);
  if (patch.check) patch.check = Object.assign({}, c.check, patch.check);
  Object.assign(c, patch);
  broadcast();
});

ipcMain.on('deleteClick', (_e, id) => {
  state.clicks = state.clicks.filter((c) => c.id !== id);
  overlays.removeForClick(id);
  if (armed && armed.id === id) armed = null;
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
    // Offset positional copies so they don't sit exactly on the original.
    if (nc.type === 'click' || nc.type === 'scroll') { nc.x += 24; nc.y += 24; }
    else if (nc.type === 'drag') { nc.x += 24; nc.y += 24; nc.x2 += 24; nc.y2 += 24; }
    state.clicks.push(nc);
  }
  broadcast();
});

ipcMain.on('armCapture', (_e, { id, field }) => {
  const c = state.clicks.find((c) => c.id === id);
  // Steps with a screen point (click, drag, scroll, condition) can capture.
  // Toggle off if re-armed.
  const positional = c && (c.type === 'click' || c.type === 'drag' || c.type === 'scroll' || c.type === 'condition');
  const f = field || 'pos';
  if (positional && !(armed && armed.id === id && armed.field === f)) {
    armed = { id, field: f };
  } else {
    armed = null;
  }
  broadcast();
});

ipcMain.on('run', startRun);
ipcMain.on('stop', stopRun);

ipcMain.on('setSettings', (_e, patch) => {
  Object.assign(state.settings, patch);
  registerShortcuts();
  broadcast();
});

// ---------- Browser Bot IPC ----------
ipcMain.on('setMode', (_e, mode) => {
  state.mode = mode === 'browser' ? 'browser' : 'screen';
  broadcast();
});

// The renderer reports the embedded webview's webContents id once it attaches;
// we resolve it so the engine can drive that guest.
ipcMain.on('browser:guestId', (_e, id) => {
  try {
    const wc = webContents.fromId(id);
    if (wc) { browserGuestWc = wc; browserEngine.setGuest(wc); }
  } catch (_) { /* webview gone */ }
});

ipcMain.on('browser:navigate', (_e, url) => {
  state.browser.url = str(url);
  const u = normalizeUrl(url);
  if (u && browserGuestWc && !browserGuestWc.isDestroyed()) browserGuestWc.loadURL(u).catch(() => {});
  broadcast();
});

// Save the current URL after in-page navigation without reloading (for restore).
ipcMain.on('browser:url', (_e, url) => {
  state.browser.url = str(url);
  saveState();
});

ipcMain.on('browser:addStep', (_e, kind) => {
  state.browserSteps.push(makeBrowserStep(kind));
  broadcast();
});

ipcMain.on('browser:addChild', (_e, { parentId, branch, kind }) => {
  const hit = findBrowserStep(parentId);
  if (!hit || hit.step.type !== 'if') return;
  const list = branch === 'else' ? hit.step.else : hit.step.then;
  list.push(makeBrowserStep(kind));
  broadcast();
});

ipcMain.on('browser:updateStep', (_e, { id, patch }) => {
  const hit = findBrowserStep(id);
  if (!hit) return;
  const s = hit.step;
  if (patch.delay) patch.delay = Object.assign({}, s.delay, patch.delay);
  if (patch.cond) patch.cond = Object.assign({}, s.cond, patch.cond);
  Object.assign(s, patch);
  broadcast();
});

ipcMain.on('browser:deleteStep', (_e, id) => {
  const hit = findBrowserStep(id);
  if (!hit) return;
  hit.list.splice(hit.index, 1);
  if (browserPickTarget && browserPickTarget.id === id) browserPickTarget = null;
  broadcast();
});

ipcMain.on('browser:moveStep', (_e, { id, dir }) => {
  const hit = findBrowserStep(id);
  if (!hit) return;
  const j = hit.index + dir;
  if (j < 0 || j >= hit.list.length) return;
  [hit.list[hit.index], hit.list[j]] = [hit.list[j], hit.list[hit.index]];
  broadcast();
});

// Arm a click-to-pick, then inject the picker into the guest. The result comes
// back via 'browser:pickResult' (relayed by the renderer's ipc-message hook).
ipcMain.on('browser:pick', (_e, { id, field }) => {
  if (!findBrowserStep(id)) return;
  browserPickTarget = { id, field: field === 'cond' ? 'cond' : 'selector' };
  if (browserGuestWc && !browserGuestWc.isDestroyed()) {
    browserGuestWc.executeJavaScript(BB_PICKER, true).catch(() => {});
  }
  broadcast();
});

ipcMain.on('browser:pickResult', (_e, payload) => {
  const target = browserPickTarget;
  browserPickTarget = null;
  if (!target || !payload) { broadcast(); return; }
  const hit = findBrowserStep(target.id);
  if (hit) {
    if (target.field === 'cond' && hit.step.cond) hit.step.cond.selector = str(payload.selector);
    else hit.step.selector = str(payload.selector);
  }
  broadcast();
});

ipcMain.on('browser:run', startBrowserRun);
ipcMain.on('browser:stop', stopBrowserRun);

// Overlay drag: live move, then commit center back to the marker on release.
ipcMain.on('overlay:move', (e, { x, y }) => {
  const key = overlays.idOf(e.sender);
  if (key != null) overlays.setTopLeft(key, x, y);
});

ipcMain.on('overlay:moveEnd', (e) => {
  const key = overlays.idOf(e.sender);
  if (key == null) return;
  const center = overlays.center(key);
  if (!center) return;
  const [idStr, field] = key.split(':');
  const c = state.clicks.find((c) => c.id === Number(idStr));
  if (c) { setPoint(c, field, center.x, center.y); broadcast(); }
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
      webviewTag: true, // Browser Bot mode embeds a <webview>
    },
  });
  mainWindow.removeMenu();
  // Lock down the embedded webview guest and give it our reporting preload.
  mainWindow.webContents.on('will-attach-webview', (_e, webPreferences) => {
    webPreferences.preload = path.join(__dirname, 'browserPreload.js');
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
  });
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
  browserEngine.stop();
  overlays.destroyAll();
  app.quit();
});
