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
    find: function (sel, text, nth) {
      var nodes;
      try {
        nodes = sel
          ? Array.prototype.slice.call(document.querySelectorAll(sel))
          : Array.prototype.slice.call(document.querySelectorAll('body *'));
      } catch (_) { nodes = []; }
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
    click: function (sel, text, nth, button, dbl) {
      var el = this.find(sel, text, nth);
      if (!el) return false;
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
      if (button === 'right') {
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        return true;
      }
      if (dbl) el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      el.click();
      return true;
    },
    type: function (sel, text, nth, value, clear, enter) {
      var el = this.find(sel, text, nth);
      if (!el) return false;
      try { el.focus(); } catch (_) {}
      var v = String(value == null ? '' : value);
      try {
        if ('value' in el) el.value = clear ? v : (el.value || '') + v;
        else el.textContent = clear ? v : (el.textContent || '') + v;
      } catch (_) {}
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (enter) {
        ['keydown', 'keypress', 'keyup'].forEach(function (type) {
          el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
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
