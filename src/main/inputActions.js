// Shared physical-input + screen-condition primitives (nut.js). Used by BOTH
// the screen-clicker Engine (automation.js) and the BrowserEngine
// (browserAutomation.js) so coordinate clicks/keys/drags/scrolls and
// pixel/image/loop conditions behave identically in either flow.
//
// All coordinates passed in here are PHYSICAL pixels (callers convert from
// Electron DIP space first), except condition sample points, which stay in DIP
// because nut.js colorAt/grabRegion scale internally.
const { mouse, keyboard, screen, Point, Region, Button, Key } = require('@nut-tree-fork/nut-js');

// No artificial delay between nut.js actions; movement is effectively instant.
mouse.config.autoDelayMs = 0;
mouse.config.mouseSpeed = 9999;
keyboard.config.autoDelayMs = 0;

// Modifier token -> nut.js Key (always the left-hand modifier).
const MOD_MAP = {
  ctrl: Key.LeftControl,
  shift: Key.LeftShift,
  alt: Key.LeftAlt,
  win: Key.LeftSuper,
};

// Main-key token -> nut.js Key. Tokens match the labels offered in the UI.
const KEY_MAP = (() => {
  const m = {};
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') m[ch] = Key[ch];
  for (let i = 0; i <= 9; i++) m[String(i)] = Key['Num' + i];
  for (let i = 1; i <= 12; i++) m['F' + i] = Key['F' + i];
  Object.assign(m, {
    Enter: Key.Enter, Tab: Key.Tab, Escape: Key.Escape, Space: Key.Space,
    Backspace: Key.Backspace, Delete: Key.Delete, Insert: Key.Insert,
    Home: Key.Home, End: Key.End, PageUp: Key.PageUp, PageDown: Key.PageDown,
    Up: Key.Up, Down: Key.Down, Left: Key.Left, Right: Key.Right,
  });
  return m;
})();

function buttonOf(name) {
  return name === 'right' ? Button.RIGHT : name === 'middle' ? Button.MIDDLE : Button.LEFT;
}

// ---------- condition helpers ----------
// '#RRGGBB' -> { R, G, B }. Falls back to black on a malformed string.
function hexToRgb(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ''));
  if (!m) return { R: 0, G: 0, B: 0 };
  const n = parseInt(m[1], 16);
  return { R: (n >> 16) & 255, G: (n >> 8) & 255, B: n & 255 };
}

function withinTol(a, b, tol) {
  return Math.abs(a.R - b.R) <= tol && Math.abs(a.G - b.G) <= tol && Math.abs(a.B - b.B) <= tol;
}

// Reduce a nut.js region Image to a scale-independent 8x8 RGB signature.
function signatureOf(image) {
  const N = 8;
  const { width, height, byteWidth, channels, data } = image;
  const sig = [];
  for (let gy = 0; gy < N; gy++) {
    for (let gx = 0; gx < N; gx++) {
      const px = Math.min(width - 1, Math.floor(((gx + 0.5) / N) * width));
      const py = Math.min(height - 1, Math.floor(((gy + 0.5) / N) * height));
      const off = py * byteWidth + px * channels;
      sig.push(data[off + 2], data[off + 1], data[off]); // R, G, B from BGRA
    }
  }
  return sig;
}

function signatureMatch(a, b, confidence) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return false;
  const CELL_TOL = 28;
  const cells = a.length / 3;
  let ok = 0;
  for (let i = 0; i < a.length; i += 3) {
    if (Math.abs(a[i] - b[i]) <= CELL_TOL &&
        Math.abs(a[i + 1] - b[i + 1]) <= CELL_TOL &&
        Math.abs(a[i + 2] - b[i + 2]) <= CELL_TOL) ok++;
  }
  return ok / cells >= confidence;
}

// ---------- actions ----------
// step: { x, y, button, double } — physical pixels.
async function clickAt(step) {
  await mouse.setPosition(new Point(step.x, step.y));
  const btn = buttonOf(step.button);
  if (step.double) await mouse.doubleClick(btn);
  else await mouse.click(btn);
}

// Press a modifier+key chord, then release in reverse. Modifier-only taps work.
async function pressKeys(step) {
  const mods = (step.modifiers || []).map((m) => MOD_MAP[m]).filter((k) => k != null);
  const main = step.key ? KEY_MAP[step.key] : null;
  const combo = main != null ? [...mods, main] : mods;
  if (combo.length === 0) return;
  await keyboard.pressKey(...combo);
  await keyboard.releaseKey(...combo.slice().reverse());
}

// Press at the start point, glide to the end over `duration` ms (~60fps), then
// release. `ctl` = { abort:()=>bool, sleep:(ms)=>Promise } so callers can stop
// mid-drag; the button is always released.
async function performDrag(step, ctl) {
  const abort = ctl && ctl.abort ? ctl.abort : () => false;
  const sleep = ctl && ctl.sleep ? ctl.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = buttonOf(step.button);
  await mouse.setPosition(new Point(step.x, step.y));
  await mouse.pressButton(btn);
  try {
    const dur = Math.max(0, Number(step.duration) || 0);
    const steps = dur > 0 ? Math.max(1, Math.round(dur / 16)) : 1;
    for (let s = 1; s <= steps; s++) {
      if (abort()) break;
      const t = s / steps;
      const x = Math.round(step.x + (step.x2 - step.x) * t);
      const y = Math.round(step.y + (step.y2 - step.y) * t);
      await mouse.setPosition(new Point(x, y));
      if (s < steps) await sleep(dur / steps);
    }
    if (!abort()) await mouse.setPosition(new Point(step.x2, step.y2));
  } finally {
    await mouse.releaseButton(btn);
  }
}

// Move to the spot, then scroll `amount` notches in one direction.
async function performScroll(step) {
  await mouse.setPosition(new Point(step.x, step.y));
  const amount = Math.max(0, Math.round(Number(step.amount) || 0));
  if (amount === 0) return;
  switch (step.direction) {
    case 'up': await mouse.scrollUp(amount); break;
    case 'left': await mouse.scrollLeft(amount); break;
    case 'right': await mouse.scrollRight(amount); break;
    default: await mouse.scrollDown(amount); break;
  }
}

// Evaluate a screen condition. Accepts either a screen-clicker `check` (uses
// `.type`) or a browser `if` condition (uses `.kind`); fields are otherwise the
// same (x,y,w,h,color,tolerance,signature,confidence,loopMode,loopN). `pass` is
// the completed-loop count, for loop conditions. Never throws.
async function evalScreenCondition(ch, pass) {
  ch = ch || {};
  const type = ch.type || ch.kind;
  try {
    if (type === 'loop') {
      const n = Math.max(1, Number(ch.loopN) || 1);
      if (ch.loopMode === 'firstN') return pass < n;
      if (ch.loopMode === 'afterN') return pass >= n;
      return pass % n === 0; // everyN (incl. pass 0)
    }
    if (type === 'image') {
      if (!Array.isArray(ch.signature)) return false;
      const img = await screen.grabRegion(new Region(ch.x, ch.y, ch.w, ch.h));
      return signatureMatch(signatureOf(img), ch.signature, Number(ch.confidence) || 0.9);
    }
    // pixel / pixelChanged — colorAt scales the DIP point internally.
    const col = await screen.colorAt(new Point(ch.x, ch.y));
    const same = withinTol(col, hexToRgb(ch.color), Number(ch.tolerance) || 0);
    return type === 'pixelChanged' ? !same : same;
  } catch (err) {
    console.error('[input] condition eval failed', err);
    return false;
  }
}

module.exports = {
  MOD_MAP, KEY_MAP, buttonOf,
  hexToRgb, withinTol, signatureOf, signatureMatch,
  clickAt, pressKeys, performDrag, performScroll, evalScreenCondition,
};
