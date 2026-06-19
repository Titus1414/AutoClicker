// Mouse automation engine for the Screen Clicker. Runs the click sequence in a
// loop until stopped. The actual input + screen-condition primitives live in
// ./inputActions (shared with the BrowserEngine); this file owns the loop,
// flow control (conditions), interruptible sleep, and stop semantics.
const {
  clickAt, pressKeys, performDrag, performScroll, evalScreenCondition, signatureOf,
} = require('./inputActions');

function unitMs(unit) {
  return unit === 'min' ? 60000 : 1000;
}

// Resolve a step's delay config into milliseconds.
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
  }

  // steps: mouse clicks  { id, type:'click', x, y, stepX, stepY, button, double, delay }
  //        drags         { id, type:'drag', x, y, x2, y2, button, duration, delay }
  //        scrolls       { id, type:'scroll', x, y, direction, amount, delay }
  //        key presses   { id, type:'key', modifiers:[...], key, delay }
  //     or conditions    { id, type:'condition', check, onFalse, skipCount, ... }
  // stepX/stepY drift a click's position after each fire; `pass` counts
  // completed loops, so positions reset to base whenever a run starts.
  // onTick(id, index) is called right after each performed step.
  async run(clicks, onTick) {
    if (this.running) return;
    this.running = true;
    this._abort = false;
    const ctl = { abort: () => this._abort, sleep: (ms) => this._sleep(ms) };
    try {
      // Brief pause so overlay circles can hide before the first click lands.
      await this._sleep(400);
      let pass = 0;
      while (!this._abort) {
        if (clicks.length === 0) break;
        for (let i = 0; i < clicks.length; i++) {
          if (this._abort) break;
          const c = clicks[i];
          // A condition step gates the steps that follow it (no input itself).
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
              i += Math.max(0, Number(c.skipCount) || 0);
            }
            if (typeof onTick === 'function') onTick(c.id, startIdx);
            if (this._abort) break;
            await this._sleep(resolveDelayMs(c.delay));
            continue;
          }
          try {
            if (c.type === 'key') {
              await pressKeys(c);
            } else if (c.type === 'drag') {
              await performDrag(c, ctl);
            } else if (c.type === 'scroll') {
              await performScroll(c);
            } else {
              await clickAt({
                x: c.x + pass * (c.stepX || 0),
                y: c.y + pass * (c.stepY || 0),
                button: c.button,
                double: c.double,
              });
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

  _evalCondition(c, pass) {
    return evalScreenCondition(c.check, pass);
  }

  // Poll a condition until it passes, times out, or Stop is hit.
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
