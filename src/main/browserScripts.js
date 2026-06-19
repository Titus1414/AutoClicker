// JavaScript injected into the embedded <webview> guest page. These are plain
// strings run via webContents.executeJavaScript in the guest's main world, so
// they must be self-contained and may only return JSON-serializable values
// (booleans / strings / null) — never DOM nodes.

// BB_HELPERS defines window.__bb, the runtime the BrowserEngine drives:
// find/test inspect the page, click/type/scrollTo act on it, read extracts.
// `find` adds a substring text filter on top of a CSS selector, which is the
// `:has-text`-style matching CSS itself lacks. Re-injected after every
// navigation (a load wipes window globals).
const BB_HELPERS = `(function () {
  window.__bb = {
    // Collect matches from the top document and any reachable (same-origin)
    // iframes. Cross-origin frames throw on contentDocument and are skipped.
    _collect: function (sel) {
      var out = [];
      function scan(doc) {
        try {
          var found = sel ? doc.querySelectorAll(sel) : doc.querySelectorAll('body *');
          Array.prototype.push.apply(out, Array.prototype.slice.call(found));
        } catch (_) {}
        var frames;
        try { frames = doc.querySelectorAll('iframe, frame'); } catch (_) { frames = []; }
        for (var i = 0; i < frames.length; i++) {
          var idoc = null;
          try { idoc = frames[i].contentDocument; } catch (_) { idoc = null; }
          if (idoc) scan(idoc);
        }
      }
      scan(document);
      return out;
    },
    find: function (sel, text, nth) {
      var nodes = this._collect(sel);
      if (text) {
        var t = String(text).toLowerCase();
        nodes = nodes.filter(function (el) {
          return (((el.innerText || el.value || '') + '').toLowerCase()).indexOf(t) >= 0;
        });
      }
      return nodes[nth || 0] || null;
    },
    visible: function (el) {
      return !!el && !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length));
    },
    // If a matched node isn't itself interactive but wraps exactly one such
    // control (a common search-bar pattern), act on the inner control instead.
    _focusTarget: function (el) {
      if (!el) return el;
      var tag = (el.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' ||
          tag === 'button' || tag === 'a' || el.isContentEditable) return el;
      var inner = el.querySelector(
        'input, textarea, select, button, a, [contenteditable=""], [contenteditable="true"]');
      return inner || el;
    },
    // Dispatch a pointer/mouse event at the element's center. Uses PointerEvent
    // when available (most React handlers listen for it), else MouseEvent.
    _fire: function (el, type, right) {
      var r = {};
      try { r = el.getBoundingClientRect(); } catch (_) {}
      var opts = {
        bubbles: true, cancelable: true, composed: true, view: window,
        clientX: (r.left || 0) + (r.width || 0) / 2,
        clientY: (r.top || 0) + (r.height || 0) / 2,
        button: right ? 2 : 0, buttons: right ? 2 : 1,
      };
      var Ctor = (typeof PointerEvent === 'function' && type.indexOf('pointer') === 0)
        ? PointerEvent : MouseEvent;
      try { el.dispatchEvent(new Ctor(type, opts)); } catch (_) {}
    },
    test: function (cond) {
      cond = cond || {};
      var el = this.find(cond.selector, cond.text, cond.nth);
      switch (cond.kind) {
        case 'elementVisible': return this.visible(el);
        case 'textExists':
          return (((document.body && document.body.innerText) || '').toLowerCase())
            .indexOf(String(cond.text || '').toLowerCase()) >= 0;
        case 'attrEquals':
          return !!el && (el.getAttribute(cond.attr) || '') === String(cond.value || '');
        case 'attrContains':
          return !!el && (el.getAttribute(cond.attr) || '').indexOf(String(cond.value || '')) >= 0;
        case 'elementExists':
        default: return !!el;
      }
    },
    // Activate an element like a real user would: focus it, then fire the full
    // pointer/mouse sequence. A bare el.click() doesn't move focus (so a search
    // bar stays inert) and skips the pointerdown/mousedown many SPAs rely on.
    click: function (sel, text, nth, button, dbl) {
      var el = this.find(sel, text, nth);
      if (!el) return false;
      el = this._focusTarget(el);
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
      try { el.focus({ preventScroll: true }); } catch (_) {}
      if (button === 'right') {
        this._fire(el, 'pointerdown', true); this._fire(el, 'mousedown', true);
        this._fire(el, 'pointerup', true); this._fire(el, 'mouseup', true);
        this._fire(el, 'contextmenu', true);
        return true;
      }
      this._fire(el, 'pointerover'); this._fire(el, 'pointerenter');
      this._fire(el, 'mouseover');
      this._fire(el, 'pointerdown'); this._fire(el, 'mousedown');
      this._fire(el, 'pointerup'); this._fire(el, 'mouseup');
      try { el.click(); } catch (_) {}
      if (dbl) { try { el.click(); } catch (_) {} this._fire(el, 'dblclick'); }
      return true;
    },
    // Type into inputs/textareas via the native value setter so React's value
    // tracker sees the change (a plain el.value = ... is silently ignored by
    // React); handle contenteditable boxes (e.g. message composers) too.
    type: function (sel, text, nth, value, clear, enter) {
      var el = this.find(sel, text, nth);
      if (!el) return false;
      el = this._focusTarget(el);
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
      try { el.focus({ preventScroll: true }); } catch (_) {}
      var v = String(value == null ? '' : value);

      if (el.isContentEditable) {
        if (clear) el.textContent = '';
        try { el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: v })); } catch (_) {}
        var inserted = false;
        try { inserted = document.execCommand && document.execCommand('insertText', false, v); } catch (_) {}
        if (!inserted) el.textContent = (clear ? '' : (el.textContent || '')) + v;
        try { el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v })); }
        catch (_) { el.dispatchEvent(new Event('input', { bubbles: true })); }
      } else if ('value' in el) {
        var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        var next = clear ? v : (el.value || '') + v;
        if (desc && desc.set) desc.set.call(el, next); else el.value = next;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.textContent = clear ? v : (el.textContent || '') + v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // Key events so keystroke-driven search / autocomplete handlers run.
      var last = v.slice(-1) || 'a';
      ['keydown', 'keyup'].forEach(function (t) {
        try { el.dispatchEvent(new KeyboardEvent(t, { bubbles: true, key: last })); } catch (_) {}
      });
      if (enter) {
        ['keydown', 'keypress', 'keyup'].forEach(function (t) {
          try { el.dispatchEvent(new KeyboardEvent(t, { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 })); } catch (_) {}
        });
        if (el.form && typeof el.form.requestSubmit === 'function') {
          try { el.form.requestSubmit(); } catch (_) {}
        }
      }
      return true;
    },
    read: function (sel, text, nth, attr) {
      var el = this.find(sel, text, nth);
      if (!el) return null;
      if (attr === 'text') return (el.innerText || '').trim();
      if (attr === 'value') return el.value != null ? el.value : null;
      if (attr === 'html') return el.innerHTML;
      return el.getAttribute(attr);
    },
    scrollTo: function (sel, text, nth) {
      var el = this.find(sel, text, nth);
      if (!el) return false;
      try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); } catch (_) {}
      return true;
    }
  };
})();`;

// BB_PICKER runs once when the user clicks "Pick". It outlines the hovered
// element, and on a capturing click (so the page never actually activates)
// computes a unique-ish CSS selector and reports it back through __bbReport
// (exposed by browserPreload.js). Escape cancels.
const BB_PICKER = `(function () {
  if (window.__bbPickerActive) return;
  window.__bbPickerActive = true;

  var hl = document.createElement('div');
  hl.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;' +
    'border:2px solid #5b8cff;background:rgba(91,140,255,0.15);border-radius:3px;box-shadow:0 0 0 1px rgba(0,0,0,.3);';
  (document.documentElement || document.body).appendChild(hl);

  function move(e) {
    var el = e.target;
    if (!el || el === hl) return;
    var r = el.getBoundingClientRect();
    hl.style.left = r.left + 'px'; hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px'; hl.style.height = r.height + 'px';
  }

  function selectorFor(el) {
    if (!(el instanceof Element)) return '';
    if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id) && !/\\d{4,}/.test(el.id)) {
      try { if (document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id); } catch (_) {}
    }
    var attrs = ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label'];
    for (var i = 0; i < attrs.length; i++) {
      var v = el.getAttribute(attrs[i]);
      if (v) {
        var q = el.tagName.toLowerCase() + '[' + attrs[i] + '=' + JSON.stringify(v) + ']';
        try { if (document.querySelectorAll(q).length === 1) return q; } catch (_) {}
      }
    }
    var parts = [], node = el, depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      var part = node.tagName.toLowerCase();
      var cls = (node.className && typeof node.className === 'string')
        ? node.className.trim().split(/\\s+/).filter(function (c) {
            return c && !/\\d/.test(c) && !/^css-/.test(c) && c.length < 30;
          })
        : [];
      if (cls.length) part += '.' + cls.slice(0, 2).map(function (c) { return CSS.escape(c); }).join('.');
      var parent = node.parentElement;
      if (parent) {
        var sibs = Array.prototype.filter.call(parent.children, function (ch) { return ch.tagName === node.tagName; });
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      var sofar = parts.join(' > ');
      try { if (document.querySelectorAll(sofar).length === 1) return sofar; } catch (_) {}
      node = parent; depth++;
    }
    return parts.join(' > ');
  }

  function cleanup() {
    window.__bbPickerActive = false;
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('click', pick, true);
    document.removeEventListener('keydown', key, true);
    if (hl && hl.parentNode) hl.parentNode.removeChild(hl);
  }

  function pick(e) {
    var el = e.target;
    e.preventDefault(); e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    cleanup();
    var payload = {
      selector: selectorFor(el),
      text: ((el.innerText || el.value || '') + '').trim().replace(/\\s+/g, ' ').slice(0, 60),
      tag: el.tagName ? el.tagName.toLowerCase() : ''
    };
    if (window.__bbReport) window.__bbReport(payload);
    else console.log('__BBPICK__' + JSON.stringify(payload));
  }

  function key(e) { if (e.key === 'Escape') cleanup(); }

  document.addEventListener('mousemove', move, true);
  document.addEventListener('click', pick, true);
  document.addEventListener('keydown', key, true);
})();`;

module.exports = { BB_HELPERS, BB_PICKER };
