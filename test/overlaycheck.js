// Reproduces the overlay 'closed'-handler crash path: create a marker window,
// then close it and confirm no uncaught "Object has been destroyed" fires.
// Run: node_modules/.bin/electron test/overlaycheck.js
const { app } = require('electron');
const { OverlayManager } = require('../src/main/overlay');

let crashed = null;
process.on('uncaughtException', (err) => { crashed = err; });

app.whenReady().then(async () => {
  const overlays = new OverlayManager();
  // Create one marker window, let it load, then tear it down (fires 'closed').
  overlays.sync([{ key: '1:pos', label: '1', kind: 'click', x: 200, y: 200 }], true);
  await new Promise((r) => setTimeout(r, 800));
  overlays.destroyAll();                 // -> win.close() -> 'closed' handler
  await new Promise((r) => setTimeout(r, 600));

  if (crashed) {
    console.log('FAIL ' + crashed.message);
    app.exit(1);
  } else {
    console.log('PASS no uncaught exception on overlay close');
    app.exit(0);
  }
});
