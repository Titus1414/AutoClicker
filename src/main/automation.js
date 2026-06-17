// Mouse automation engine. Wraps nut.js and runs the click sequence in a loop
// until stopped. All coordinates passed in here are PHYSICAL pixels (already
// converted from Electron's DIP space by the main process).
const { mouse, keyboard, screen, Point, Region, Button, Key } = require('@nut-tree-fork/nut-js');

// Modifier token -> nut.js Key. We always use the left-hand modifier.
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

function unitMs(unit) {
  return unit === 'min' ? 60000 : 1000;
}

function buttonOf(name) {
  return name === 'right' ? Button.RIGHT : name === 'middle' ? Button.MIDDLE : Button.LEFT;
}

// Resolve a click's delay config into milliseconds.
// delay = { mode: 'fixed'|'random', value, min, max, unit: 'sec'|'min' }
function resolveDelayMs(d) {
  if (!d) return 1000;
  if (d.mode === 'random') {
    const lo = Math.min(Number(d.min) || 0, Number(d.max) || 0);
    const hi = Math.max(Number(d.min) || 0, Number(d.max) || 0);
    const v = lo + Math.random() * (hi - lo);
    return Math.max(0, v) * unitMs(d.unit);
  }
  return Math.max(0, Number(d.value) || 0) * unitMs(d.unit);
}

// ---------- condition helpers ----------
// '#RRGGBB' -> { R, G, B }. Falls back to black on a malformed string.
function hexToRgb(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ''));
  if (!m) return { R: 0, G: 0, B: 0 };
  const n = parseInt(m[1], 16);
  return { R: (n >> 16) & 255, G: (n >> 8) & 255, B: n & 255 };
}

// True when two colors are within `tol` (per channel, 0-255).
function withinTol(a, b, tol) {
  return Math.abs(a.R - b.R) <= tol && Math.abs(a.G - b.G) <= tol && Math.abs(a.B - b.B) <= tol;
}

// Reduce a nut.js region Image to a compact, scale-independent signature:
// an 8x8 grid of sampled R,G,B values (192 ints). The region's pixel buffer is
// BGRA with `byteWidth` bytes per row (may include padding). Capture and runtime
// use this same reduction so comparisons are apples-to-apples.
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

// Fraction of signature cells whose color matches; pass if ratio >= confidence.
function signatureMatch(a, b, confidence) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return false;
  const CELL_TOL = 28; // per-channel tolerance for a single grid cell
  const cells = a.length / 3;
  let ok = 0;
  for (let i = 0; i < a.length; i += 3) {
    if (Math.abs(a[i] - b[i]) <= CELL_TOL &&
        Math.abs(a[i + 1] - b[i + 1]) <= CELL_TOL &&
        Math.abs(a[i + 2] - b[i + 2]) <= CELL_TOL) ok++;
  }
  return ok / cells >= confidence;
}

class Engine {
  constructor() {
    this.running = false;
    this._abort = false;
    this._cancelSleep = null;
    // No artificial delay between nut.js mouse / keyboard actions.
    mouse.config.autoDelayMs = 0;
    mouse.config.mouseSpeed = 9999; // effectively instant for any movement
    keyboard.config.autoDelayMs = 0;
  }

  // steps: mouse clicks  { id, type:'click', x, y, stepX, stepY, button, double, delay }
  //        drags         { id, type:'drag', x, y, x2, y2, button, duration, delay }
  //        scrolls       { id, type:'scroll', x, y, direction, amount, delay }
  //     or key presses   { id, type:'key', modifiers:[...], key, delay }
  // stepX/stepY drift a click's position by that many (physical) pixels after
  // every time it fires; `pass` counts how often each click has already fired,
  // so it resets to the base position whenever a run starts.
  // onTick(id, index) is called right after each performed step.
  async run(clicks, onTick) {
    if (this.running) return;
    this.running = true;
    this._abort = false;
    try {
      // Brief pause so overlay circles can hide before the first click lands.
      await this._sleep(400);
      let pass = 0; // completed full loops so far
      while (!this._abort) {
        if (clicks.length === 0) break;
        for (let i = 0; i < clicks.length; i++) {
          if (this._abort) break;
          const c = clicks[i];
          // A condition step gates the steps that follow it. It performs no
          // input itself: it evaluates a test and, when false, either skips the
          // next `skipCount` steps, stops the run, or waits until the test passes.
          if (c.type === 'condition') {
            const startIdx = i;
            let ok = await this._evalCondition(c, pass);
            if (!ok && c.onFalse === 'wait') {
              const r = await this._waitForCondition(c, pass);
              if (r === 'aborted') break;
              if (r === 'timeout') { if (c.onTimeout === 'stop') break; ok = false; }
              else ok = true;
            }
            if (this._abort) break;
            if (!ok) {
              if (c.onFalse === 'stop') break;
              i += Math.max(0, Number(c.skipCount) || 0); // skip the guarded block
            }
            if (typeof onTick === 'function') onTick(c.id, startIdx);
            if (this._abort) break;
            await this._sleep(resolveDelayMs(c.delay));
            continue;
          }
          try {
            if (c.type === 'key') {
              await this._pressKeys(c);
            } else if (c.type === 'drag') {
              await this._performDrag(c);
            } else if (c.type === 'scroll') {
              await this._performScroll(c);
            } else {
              const x = c.x + pass * (c.stepX || 0);
              const y = c.y + pass * (c.stepY || 0);
              await mouse.setPosition(new Point(x, y));
              const btn = buttonOf(c.button);
              if (c.double) await mouse.doubleClick(btn);
              else await mouse.click(btn);
            }
          } catch (err) {
            console.error('[engine] step failed', err);
          }
          if (typeof onTick === 'function') onTick(c.id, i);
          if (this._abort) break;
          await this._sleep(resolveDelayMs(c.delay));
        }
        pass++;
      }
    } finally {
      this.running = false;
      this._cancelSleep = null;
    }
  }

  // Press a modifier+key chord (e.g. Ctrl+C): hold every key down, then
  // release them in reverse order. A modifier-only step (no main key) just
  // taps the modifier.
  async _pressKeys(step) {
    const mods = (step.modifiers || []).map((m) => MOD_MAP[m]).filter((k) => k != null);
    const main = step.key ? KEY_MAP[step.key] : null;
    const combo = main != null ? [...mods, main] : mods;
    if (combo.length === 0) return;
    await keyboard.pressKey(...combo);
    await keyboard.releaseKey(...combo.slice().reverse());
  }

  // Press the button at the start point, glide to the end point, release.
  // `duration` (ms) is split into ~60fps steps for a smooth, human-like drag;
  // duration 0 jumps straight to the end. The button is always released, even
  // if Stop is hit mid-drag, so no button is left stuck down.
  async _performDrag(step) {
    const btn = buttonOf(step.button);
    await mouse.setPosition(new Point(step.x, step.y));
    await mouse.pressButton(btn);
    try {
      const dur = Math.max(0, Number(step.duration) || 0);
      const steps = dur > 0 ? Math.max(1, Math.round(dur / 16)) : 1;
      for (let s = 1; s <= steps; s++) {
        if (this._abort) break;
        const t = s / steps;
        const x = Math.round(step.x + (step.x2 - step.x) * t);
        const y = Math.round(step.y + (step.y2 - step.y) * t);
        await mouse.setPosition(new Point(x, y));
        if (s < steps) await this._sleep(dur / steps);
      }
      // Guarantee we finish exactly on target even if rounding/abort skipped it.
      if (!this._abort) await mouse.setPosition(new Point(step.x2, step.y2));
    } finally {
      await mouse.releaseButton(btn);
    }
  }

  // Move to the target spot, then scroll `amount` steps in one direction.
  // Scroll happens under the cursor, so most apps scroll whatever is hovered.
  async _performScroll(step) {
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

  // Evaluate a condition step's test. Returns true/false and never throws — a
  // failed screen read is treated as "not met" so it can't escape the run loop.
  // `pass` is the completed-loop counter, used by loop conditions.
  async _evalCondition(c, pass) {
    const ch = c.check || {};
    try {
      if (ch.type === 'loop') {
        const n = Math.max(1, Number(ch.loopN) || 1);
        if (ch.loopMode === 'firstN') return pass < n;
        if (ch.loopMode === 'afterN') return pass >= n;
        return pass % n === 0; // everyN (incl. the very first pass, pass 0)
      }
      if (ch.type === 'image') {
        if (!Array.isArray(ch.signature)) return false;
        const img = await screen.grabRegion(new Region(ch.x, ch.y, ch.w, ch.h));
        return signatureMatch(signatureOf(img), ch.signature, Number(ch.confidence) || 0.9);
      }
      // pixel / pixelChanged — colorAt scales the DIP point internally.
      const col = await screen.colorAt(new Point(ch.x, ch.y));
      const same = withinTol(col, hexToRgb(ch.color), Number(ch.tolerance) || 0);
      return ch.type === 'pixelChanged' ? !same : same;
    } catch (err) {
      console.error('[engine] condition eval failed', err);
      return false;
    }
  }

  // Poll a condition until it passes, the timeout elapses, or Stop is hit.
  // Reuses the interruptible _sleep so Stop is instant even mid-wait.
  // Returns 'pass' | 'timeout' | 'aborted'.
  async _waitForCondition(c, pass) {
    const timeoutMs = (Number(c.timeoutSec) || 0) * 1000; // 0 = wait forever
    const start = Date.now();
    while (!this._abort) {
      if (await this._evalCondition(c, pass)) return 'pass';
      if (timeoutMs > 0 && Date.now() - start >= timeoutMs) return 'timeout';
      await this._sleep(250);
      if (this._abort) break;
    }
    return 'aborted';
  }

  // Interruptible sleep so Stop takes effect immediately, even mid-delay.
  _sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this._cancelSleep = null; resolve(); }, ms);
      this._cancelSleep = () => { clearTimeout(t); this._cancelSleep = null; resolve(); };
    });
  }

  stop() {
    this._abort = true;
    if (this._cancelSleep) this._cancelSleep();
  }
}

module.exports = { Engine, resolveDelayMs, signatureOf };
