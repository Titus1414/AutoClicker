// Headless integration check for Browser Bot: drives a real Chromium DOM with
// the actual BrowserEngine + injected __bb helpers, exercising type -> click ->
// if/else branch -> read. Run with: node_modules/.bin/electron test/bbcheck.js
const { app, BrowserWindow } = require('electron');
const { BrowserEngine } = require('../src/main/browserAutomation');

const PAGE = 'data:text/html,' + encodeURIComponent(`
  <!doctype html><html><body>
    <input id="user" />
    <button id="submit">Login</button>
    <div id="out"></div>
    <script>
      document.getElementById('submit').addEventListener('click', function () {
        var u = document.getElementById('user').value;
        document.getElementById('out').textContent =
          (u === 'tomsmith') ? 'Welcome to the secure area' : 'login failed';
      });
    </script>
  </body></html>`);

const D = { value: 0 }; // zero trailing delay

const steps = [
  { id: 1, type: 'typeText', selector: '#user', text: '', nth: 0, value: 'tomsmith', clearFirst: true, pressEnter: false, waitMs: 3000, delay: D },
  { id: 2, type: 'clickEl', selector: '#submit', text: '', nth: 0, waitMs: 3000, button: 'left', dblclick: false, delay: D },
  {
    id: 3, type: 'if',
    cond: { kind: 'textExists', selector: '', text: 'secure area', nth: 0, attr: 'href', value: '' },
    then: [{ id: 4, type: 'read', selector: '#out', text: '', nth: 0, attr: 'text', varName: 'banner', delay: D }],
    else: [{ id: 5, type: 'read', selector: '#out', text: '', nth: 0, attr: 'text', varName: 'wrong', delay: D }],
    delay: D,
  },
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL(PAGE);

  const engine = new BrowserEngine();
  engine.setGuest(win.webContents);

  const ticked = [];
  await engine.run(steps, (id) => ticked.push(id));

  const results = {
    ticked,
    banner: engine.vars.banner,
    thenRan: ticked.includes(4),
    elseRan: ticked.includes(5),
    bannerOk: /secure area/i.test(engine.vars.banner || ''),
  };
  const pass = results.thenRan && !results.elseRan && results.bannerOk;
  console.log('RESULT ' + JSON.stringify(results));
  console.log(pass ? 'PASS' : 'FAIL');

  app.exit(pass ? 0 : 1);
});
