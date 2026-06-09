// Mouse automation engine. Wraps nut.js and runs the click sequence in a loop
// until stopped. All coordinates passed in here are PHYSICAL pixels (already
// converted from Electron's DIP space by the main process).
const { mouse, keyboard, Point, Button, Key } = require('@nut-tree-fork/nut-js');

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
          try {
            if (c.type === 'key') {
              await this._pressKeys(c);
            } else {
              const x = c.x + pass * (c.stepX || 0);
              const y = c.y + pass * (c.stepY || 0);
              await mouse.setPosition(new Point(x, y));
              const btn =
                c.button === 'right' ? Button.RIGHT :
                c.button === 'middle' ? Button.MIDDLE : Button.LEFT;
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

module.exports = { Engine, resolveDelayMs };
