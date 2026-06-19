// Headless check for the robust interaction primitives in browserScripts.js:
// click focuses + fires events, type is React-aware + handles contenteditable,
// and find/click reach into a same-origin iframe. Real Chromium, no login.
// Run: node_modules/.bin/electron test/interactcheck.js   (exit 0 = pass)
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { BB_HELPERS } = require('../src/main/browserScripts');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadFile(path.join(__dirname, 'interactpage.html'));
  await win.webContents.executeJavaScript(BB_HELPERS, true);

  const script = `(function () {
    var r = {};
    // 1) click focuses the input
    window.__bb.click('#q');
    r.focused = !!(document.activeElement && document.activeElement.id === 'q');
    // 2) React-aware typing into an input
    window.__bb.type('#q', '', 0, 'hello', true, false);
    r.inputValue = document.getElementById('q').value;
    r.inputEvent = window.__inq === true;
    // 3) contenteditable composer
    window.__bb.type('#editor', '', 0, 'hi there', true, false);
    r.editorText = document.getElementById('editor').textContent;
    r.editorEvent = window.__ined === true;
    // 4) click a button inside a same-origin iframe
    window.__bb.click('#b');
    var ifr = document.getElementById('f');
    r.iframeClicked = !!(ifr.contentWindow && ifr.contentWindow.__clicked);
    return r;
  })();`;
  const r = await win.webContents.executeJavaScript(script, true);

  const pass = r.focused && r.inputValue === 'hello' && r.inputEvent &&
    /hi there/.test(r.editorText) && r.editorEvent && r.iframeClicked;

  fs.writeFileSync(path.join(__dirname, '_interact.json'), JSON.stringify({ pass, ...r }, null, 2));
  console.log('RESULT ' + JSON.stringify(r));
  console.log(pass ? 'PASS' : 'FAIL');
  app.exit(pass ? 0 : 1);
});
