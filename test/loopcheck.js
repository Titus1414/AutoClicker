// Headless check for the unified Browser Bot run loop: looping (pass counter)
// and a screen `loop` condition driving if/then/else across passes — no real
// mouse needed (loop conditions are pass-based). Run:
//   node_modules/.bin/electron test/loopcheck.js     (exit 0 = pass)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { BrowserEngine } = require('../src/main/browserAutomation');

const PAGE = 'data:text/html,' + encodeURIComponent('<div id="t">x</div>');
const D = { value: 0 };

// First 2 passes take the THEN branch (read id 2); pass >= 2 take ELSE (id 3).
const steps = [{
  id: 1, type: 'if',
  cond: { kind: 'loop', loopMode: 'firstN', loopN: 2 },
  then: [{ id: 2, type: 'read', selector: '#t', text: '', nth: 0, attr: 'text', varName: 'v', delay: D }],
  else: [{ id: 3, type: 'read', selector: '#t', text: '', nth: 0, attr: 'text', varName: 'v', delay: D }],
  delay: D,
}];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL(PAGE);

  const engine = new BrowserEngine();
  engine.setGuest(win.webContents);

  const thenPasses = new Set();
  const elsePasses = new Set();
  const onTick = (id) => {
    if (id === 2) thenPasses.add(engine.pass);
    if (id === 3) elsePasses.add(engine.pass);
  };

  const run = engine.run(steps, onTick, { loop: true });
  setTimeout(() => engine.stop(), 400); // let several passes happen, then stop
  await run;

  const thenArr = [...thenPasses], elseArr = [...elsePasses];
  const r = {
    maxPass: engine.pass,
    thenPasses: thenArr,
    elsePasses: elseArr,
    stopped: engine.running === false,
    thenOnlyFirst2: thenArr.length > 0 && thenArr.every((p) => p < 2),
    elseOnlyAfter2: elseArr.length > 0 && elseArr.every((p) => p >= 2),
  };
  const pass = r.stopped && r.thenOnlyFirst2 && r.elseOnlyAfter2 && r.maxPass >= 3;

  fs.writeFileSync(path.join(__dirname, '_loop.json'), JSON.stringify({ pass, ...r }, null, 2));
  console.log(pass ? 'PASS' : 'FAIL');
  app.exit(pass ? 0 : 1);
});
