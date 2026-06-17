// Browser automation engine. A sibling to the (nut.js) Engine in automation.js:
// instead of moving the mouse, it drives an embedded <webview> guest by running
// JavaScript inside it via webContents.executeJavaScript. It walks a recursive
// list of steps, auto-waiting for elements and branching on real DOM conditions
// (the if/then/else step). Stop is interruptible at every level, exactly like
// Engine, by sharing the same _abort flag + cancellable _sleep pattern.
const { resolveDelayMs } = require('./automation');
const { BB_HELPERS } = require('./browserScripts');

const J = JSON.stringify; // shorthand for embedding args into injected code

// Add a scheme if the user typed a bare host (e.g. "example.com").
function normalizeUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || u.startsWith('about:') || u.startsWith('file:')) return u;
  return 'https://' + u;
}

class BrowserEngine {
  constructor() {
    this.running = false;
    this._abort = false;
    this._cancelSleep = null;
    this._cancelNav = null;
    this.wc = null;          // the guest webContents we drive
    this.vars = {};          // run-scoped values captured by `read` steps
    this._tick = null;
  }

  setGuest(wc) { this.wc = wc; }

  _alive() { return this.wc && !this.wc.isDestroyed(); }

  // Run code in the guest's main world and return its (serializable) result.
  _eval(code) {
    if (!this._alive()) return Promise.reject(new Error('no guest'));
    return this.wc.executeJavaScript(code, true);
  }

  // Make sure window.__bb exists (a navigation wipes it). Cheap no-op when present.
  async _ensureHelpers() {
    try {
      const has = await this._eval('!!window.__bb');
      if (!has) await this._eval(BB_HELPERS);
    } catch (_) { /* page mid-navigation; the next op will retry */ }
  }

  // steps: array of browser steps (see normalizeBrowserStep in main.js).
  // onTick(id) highlights the current step in the UI.
  async run(steps, onTick) {
    if (this.running || !this._alive()) return;
    this.running = true;
    this._abort = false;
    this.vars = {};
    this._tick = typeof onTick === 'function' ? onTick : null;
    try {
      await this._ensureHelpers();
      await this._runSteps(steps);
    } catch (err) {
      console.error('[browser-engine] run failed', err);
    } finally {
      this.running = false;
      this._cancelSleep = null;
      this._cancelNav = null;
      this._tick = null;
    }
  }

  async _runSteps(steps) {
    for (const s of steps) {
      if (this._abort) return;
      if (this._tick) this._tick(s.id);
      try {
        await this._runStep(s);
      } catch (err) {
        console.error('[browser-engine] step failed', s && s.type, err);
      }
      if (this._abort) return;
      await this._sleep(resolveDelayMs(s.delay));
    }
  }

  async _runStep(s) {
    switch (s.type) {
      case 'navigate':
        await this._navigate(s);
        return;
      case 'waitTimeout':
        // A pure pause — the trailing delay (its delay block) is the wait.
        return;
      case 'waitFor':
        await this._waitFor(s);
        return;
      case 'clickEl': {
        if (await this._waitElement(s, s.waitMs)) {
          await this._eval(`window.__bb.click(${J(s.selector)}, ${J(s.text)}, ${s.nth | 0}, ${J(s.button)}, ${!!s.dblclick})`);
        }
        return;
      }
      case 'typeText': {
        if (await this._waitElement(s, s.waitMs)) {
          await this._eval(`window.__bb.type(${J(s.selector)}, ${J(s.text)}, ${s.nth | 0}, ${J(s.value)}, ${!!s.clearFirst}, ${!!s.pressEnter})`);
        }
        return;
      }
      case 'scrollToEl':
        await this._ensureHelpers();
        await this._eval(`window.__bb.scrollTo(${J(s.selector)}, ${J(s.text)}, ${s.nth | 0})`).catch(() => {});
        return;
      case 'read': {
        await this._ensureHelpers();
        let v = null;
        try { v = await this._eval(`window.__bb.read(${J(s.selector)}, ${J(s.text)}, ${s.nth | 0}, ${J(s.attr)})`); } catch (_) {}
        this.vars[s.varName || 'value'] = v;
        console.log(`[browser-engine] read ${s.varName || 'value'} =`, v);
        return;
      }
      case 'if': {
        await this._ensureHelpers();
        let ok = false;
        try { ok = await this._eval(`window.__bb.test(${J(s.cond || {})})`); } catch (_) {}
        await this._runSteps(ok ? (s.then || []) : (s.else || []));
        return;
      }
      default:
        return;
    }
  }

  // Poll until the target element exists (or timeout / abort). Returns boolean.
  async _waitElement(s, timeoutMs) {
    const deadline = Date.now() + (Number(timeoutMs) || 0);
    const code = `!!(window.__bb && window.__bb.find(${J(s.selector)}, ${J(s.text)}, ${s.nth | 0}))`;
    for (;;) {
      if (this._abort) return false;
      await this._ensureHelpers();
      let ok = false;
      try { ok = await this._eval(code); } catch (_) {}
      if (ok) return true;
      if (Date.now() >= deadline) return false;
      await this._sleep(200);
    }
  }

  // Poll a waitFor step's condition until satisfied / timeout / abort.
  async _waitFor(s) {
    const deadline = Date.now() + (Number(s.timeoutMs) || 0);
    const found = `window.__bb.find(${J(s.selector)}, ${J(s.text)}, ${s.nth | 0})`;
    let code;
    if (s.state === 'absent') code = `!(window.__bb && ${found})`;
    else if (s.state === 'visible') code = `!!(window.__bb && window.__bb.visible(${found}))`;
    else code = `!!(window.__bb && ${found})`;
    for (;;) {
      if (this._abort) return;
      await this._ensureHelpers();
      let ok = false;
      try { ok = await this._eval(code); } catch (_) {}
      if (ok) return;
      if ((Number(s.timeoutMs) || 0) > 0 && Date.now() >= deadline) return;
      await this._sleep(200);
    }
  }

  // Load a URL, optionally waiting for the page to finish loading. The wait is
  // resolved by did-finish-load / did-fail-load / a 30s cap, and can be cut
  // short by Stop (via _cancelNav).
  _navigate(s) {
    return new Promise((resolve) => {
      const wc = this.wc;
      const url = normalizeUrl(s.url);
      if (!this._alive() || !url) return resolve();
      if (s.waitLoad === false) { wc.loadURL(url).catch(() => {}); return resolve(); }

      let settled = false;
      const t = setTimeout(() => done(), 30000);
      const onFin = () => done();
      const onFail = () => done();
      function done() {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        wc.removeListener('did-finish-load', onFin);
        wc.removeListener('did-fail-load', onFail);
        resolve();
      }
      this._cancelNav = done;
      wc.once('did-finish-load', onFin);
      wc.once('did-fail-load', onFail);
      wc.loadURL(url).catch(() => {});
    });
  }

  // Interruptible sleep so Stop takes effect immediately, even mid-delay.
  _sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this._cancelSleep = null; resolve(); }, Math.max(0, ms | 0));
      this._cancelSleep = () => { clearTimeout(t); this._cancelSleep = null; resolve(); };
    });
  }

  stop() {
    this._abort = true;
    if (this._cancelSleep) this._cancelSleep();
    if (this._cancelNav) this._cancelNav();
  }
}

module.exports = { BrowserEngine, normalizeUrl };
