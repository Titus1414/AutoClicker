// Renderer: renders the click table and forwards user actions to the main
// process via window.api. Main is the single source of truth; we re-render
// whenever it pushes new state.

const el = {
  rows: document.getElementById('rows'),
  empty: document.getElementById('empty'),
  addBtn: document.getElementById('addBtn'),
  addKeyBtn: document.getElementById('addKeyBtn'),
  addDragBtn: document.getElementById('addDragBtn'),
  addScrollBtn: document.getElementById('addScrollBtn'),
  addConditionBtn: document.getElementById('addConditionBtn'),
  copyBtn: document.getElementById('copyBtn'),
  pasteBtn: document.getElementById('pasteBtn'),
  runBtn: document.getElementById('runBtn'),
  stopBtn: document.getElementById('stopBtn'),
  status: document.getElementById('status'),
  hideCircles: document.getElementById('hideCircles'),
  selectAll: document.getElementById('selectAll'),
  // tabs / panels
  tabScreen: document.getElementById('tabScreen'),
  tabBrowser: document.getElementById('tabBrowser'),
  screenPanel: document.getElementById('screenPanel'),
  browserPanel: document.getElementById('browserPanel'),
  // browser bot
  bbUrl: document.getElementById('bbUrl'),
  bbGo: document.getElementById('bbGo'),
  bbRunBtn: document.getElementById('bbRunBtn'),
  bbStopBtn: document.getElementById('bbStopBtn'),
  bbStatus: document.getElementById('bbStatus'),
  browserRows: document.getElementById('browserRows'),
  bbEmpty: document.getElementById('bbEmpty'),
  bv: document.getElementById('bv'),
  bbAdd: document.querySelector('.bb-add'),
};

let current = {
  clicks: [], browserSteps: [], mode: 'screen', browser: { url: '' },
  settings: {}, running: false, browserRunning: false, canPaste: false, armedId: null, pickTarget: null,
};
let selected = new Set();   // selected click ids (for Copy)
let runningId = null;       // click currently firing (during Run)
let browserRunningId = null; // browser step currently executing (during Run)

// ---------- helpers ----------
function opt(value, label, selectedValue) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  if (value === selectedValue) o.selected = true;
  return o;
}

function makeSelect(options, value, onChange) {
  const s = document.createElement('select');
  for (const [v, label] of options) s.appendChild(opt(v, label, value));
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function makeNumber(value, onChange, min = 0) {
  const i = document.createElement('input');
  i.type = 'number';
  i.min = String(min);
  i.step = 'any';
  i.value = value;
  i.addEventListener('change', () => onChange(i.value));
  return i;
}

// A small labeled number input (allows negatives) for a position increment.
function makeStep(axis, value, onChange) {
  const wrap = document.createElement('label');
  wrap.className = 'axis';
  const tag = document.createElement('span');
  tag.textContent = axis;
  const i = document.createElement('input');
  i.type = 'number';
  i.step = 'any';
  i.value = value;
  i.className = 'step-num';
  i.addEventListener('change', () => onChange(i.value));
  wrap.appendChild(tag);
  wrap.appendChild(i);
  return wrap;
}

// ---------- delay editor ----------
// `update` lets the same editor drive either a click (api.updateClick) or a
// browser step (api.updateBrowserStep); it defaults to the click updater.
function buildDelay(c, update) {
  const upd = update || ((patch) => api.updateClick(c.id, patch));
  const wrap = document.createElement('div');
  wrap.className = 'delay';

  const modeSel = makeSelect(
    [['fixed', 'Fixed'], ['random', 'Random']],
    c.delay.mode,
    (v) => upd({ delay: { mode: v } })
  );
  wrap.appendChild(modeSel);

  if (c.delay.mode === 'random') {
    wrap.appendChild(makeNumber(c.delay.min, (v) => upd({ delay: { min: Number(v) } })));
    const sep = document.createElement('span');
    sep.className = 'sep'; sep.textContent = 'to';
    wrap.appendChild(sep);
    wrap.appendChild(makeNumber(c.delay.max, (v) => upd({ delay: { max: Number(v) } })));
  } else {
    wrap.appendChild(makeNumber(c.delay.value, (v) => upd({ delay: { value: Number(v) } })));
  }

  wrap.appendChild(makeSelect(
    [['sec', 'seconds'], ['min', 'minutes']],
    c.delay.unit,
    (v) => upd({ delay: { unit: v } })
  ));

  return wrap;
}

// A plain text input (used by Browser Bot for selectors, text, URLs, values).
function makeText(value, placeholder, onChange, opts = {}) {
  const i = document.createElement('input');
  i.type = 'text';
  i.className = 'bb-input' + (opts.mono ? ' mono' : '');
  i.spellcheck = false;
  i.value = value == null ? '' : value;
  if (placeholder) i.placeholder = placeholder;
  i.addEventListener('change', () => onChange(i.value));
  return i;
}

// ---------- key combo editor ----------
// Keys the user can pick as the main key of a chord. Tokens must match KEY_MAP
// in automation.js. '' means "modifiers only" (e.g. just tap Ctrl).
const KEY_OPTIONS = (() => {
  const o = [['', '(none)']];
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') o.push([ch, ch]);
  for (let i = 0; i <= 9; i++) o.push([String(i), String(i)]);
  for (let i = 1; i <= 12; i++) o.push(['F' + i, 'F' + i]);
  for (const k of ['Enter', 'Tab', 'Escape', 'Space', 'Backspace', 'Delete',
    'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right']) {
    o.push([k, k]);
  }
  return o;
})();

const MOD_LABELS = [['ctrl', 'Ctrl'], ['shift', 'Shift'], ['alt', 'Alt'], ['win', 'Win']];

function buildKeys(c) {
  const wrap = document.createElement('div');
  wrap.className = 'delay keys';

  const active = new Set(c.modifiers || []);
  for (const [mod, label] of MOD_LABELS) {
    const lbl = document.createElement('label');
    lbl.className = 'modchk';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = active.has(mod);
    cb.addEventListener('change', () => {
      const next = new Set(c.modifiers || []);
      if (cb.checked) next.add(mod); else next.delete(mod);
      api.updateClick(c.id, { modifiers: [...next] });
    });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(label));
    wrap.appendChild(lbl);
  }

  const plus = document.createElement('span');
  plus.className = 'sep'; plus.textContent = '+';
  wrap.appendChild(plus);

  wrap.appendChild(makeSelect(KEY_OPTIONS, c.key || '', (v) => api.updateClick(c.id, { key: v })));
  return wrap;
}

// ---------- position cell ----------
// True when this step's given point is the one armed for F6 capture.
function isArmed(c, field) {
  const a = current.armed;
  return !!a && a.id === c.id && a.field === field;
}

// A coordinates label + "Set" button that arms F6 capture for one point.
// field: 'pos' (click), 'start' / 'end' (drag). labelText optionally prefixes
// the coords (used to tell a drag's start/end apart).
function buildPosCell(c, field, labelText) {
  const pos = document.createElement('div');
  pos.className = 'pos';

  if (labelText) {
    const tag = document.createElement('span');
    tag.className = 'pos-tag';
    tag.textContent = labelText;
    pos.appendChild(tag);
  }

  const x = field === 'end' ? c.x2 : c.x;
  const y = field === 'end' ? c.y2 : c.y;
  const coords = document.createElement('span');
  coords.className = 'coords set';
  coords.textContent = `${x}, ${y}`;

  const armed = isArmed(c, field);
  const setBtn = document.createElement('button');
  setBtn.className = 'btn ghost small';
  setBtn.textContent = armed ? 'Press F6…' : 'Set';
  setBtn.title = 'Arm capture, then press F6 at the target spot (or drag the circle)';
  setBtn.addEventListener('click', () => api.armCapture(c.id, field));

  pos.appendChild(coords);
  pos.appendChild(setBtn);
  return pos;
}

// ---------- condition editor ----------
// A condition step has no input of its own — it tests the screen (or the loop
// counter) and, when the test fails, controls the steps that follow it.
function buildCondition(c) {
  const ch = c.check || {};
  const wrap = document.createElement('div');
  wrap.className = 'cond';

  // Row 1 — which test
  const r1 = document.createElement('div');
  r1.className = 'delay';
  const ifTag = document.createElement('span');
  ifTag.className = 'pos-tag';
  ifTag.textContent = 'If';
  r1.appendChild(ifTag);
  r1.appendChild(makeSelect(
    [['pixel', 'Pixel is color'], ['pixelChanged', 'Pixel changed'],
     ['image', 'Region matches'], ['loop', 'Loop pass']],
    ch.type,
    (v) => api.updateClick(c.id, { check: { type: v } })
  ));
  wrap.appendChild(r1);

  // Row 2 — test parameters
  const r2 = document.createElement('div');
  r2.className = 'delay';
  if (ch.type === 'loop') {
    r2.appendChild(makeSelect(
      [['everyN', 'every'], ['firstN', 'first'], ['afterN', 'after']],
      ch.loopMode,
      (v) => api.updateClick(c.id, { check: { loopMode: v } })
    ));
    r2.appendChild(makeNumber(ch.loopN, (v) => api.updateClick(c.id, { check: { loopN: Number(v) } }), 1));
    const lbl = document.createElement('span');
    lbl.className = 'sep'; lbl.textContent = 'pass(es)';
    r2.appendChild(lbl);
  } else {
    const armed = isArmed(c, 'cond');
    const setBtn = document.createElement('button');
    setBtn.className = 'btn ghost small';
    setBtn.textContent = armed ? 'Press F6…' : 'Set point';
    setBtn.title = 'Arm capture, then press F6 over the target spot (or drag the circle)';
    setBtn.addEventListener('click', () => api.armCapture(c.id, 'cond'));
    r2.appendChild(setBtn);

    const coords = document.createElement('span');
    coords.className = 'coords';
    coords.textContent = `${ch.x}, ${ch.y}`;
    r2.appendChild(coords);

    if (ch.type === 'image') {
      r2.appendChild(makeStep('w', ch.w, (v) => api.updateClick(c.id, { check: { w: Number(v) } })));
      r2.appendChild(makeStep('h', ch.h, (v) => api.updateClick(c.id, { check: { h: Number(v) } })));
      const conf = document.createElement('label');
      conf.className = 'axis';
      const ct = document.createElement('span');
      ct.textContent = 'match';
      ct.title = 'Required match ratio, 0–1 (capture the baseline with Set point).';
      conf.appendChild(ct);
      conf.appendChild(makeNumber(ch.confidence, (v) => api.updateClick(c.id, { check: { confidence: Number(v) } })));
      r2.appendChild(conf);
    } else {
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = ch.color;
      sw.title = ch.color;
      r2.appendChild(sw);
      const tol = document.createElement('label');
      tol.className = 'axis';
      const tt = document.createElement('span');
      tt.textContent = '±';
      tt.title = 'Color tolerance per channel (0–255).';
      tol.appendChild(tt);
      tol.appendChild(makeNumber(ch.tolerance, (v) => api.updateClick(c.id, { check: { tolerance: Number(v) } })));
      r2.appendChild(tol);
    }
  }
  wrap.appendChild(r2);

  // Row 3 — what happens when the test fails
  const r3 = document.createElement('div');
  r3.className = 'delay';
  const elseTag = document.createElement('span');
  elseTag.className = 'sep'; elseTag.textContent = 'else';
  r3.appendChild(elseTag);
  r3.appendChild(makeSelect(
    [['skip', 'skip next'], ['stop', 'stop run'], ['wait', 'wait until true']],
    c.onFalse,
    (v) => api.updateClick(c.id, { onFalse: v })
  ));
  if (c.onFalse === 'skip') {
    r3.appendChild(makeNumber(c.skipCount, (v) => api.updateClick(c.id, { skipCount: Number(v) }), 0));
    const s = document.createElement('span');
    s.className = 'sep'; s.textContent = 'step(s)';
    r3.appendChild(s);
  } else if (c.onFalse === 'wait') {
    r3.appendChild(makeNumber(c.timeoutSec, (v) => api.updateClick(c.id, { timeoutSec: Number(v) }), 0));
    const s = document.createElement('span');
    s.className = 'sep'; s.textContent = 's, then';
    r3.appendChild(s);
    r3.appendChild(makeSelect(
      [['skip', 'skip'], ['stop', 'stop']],
      c.onTimeout,
      (v) => api.updateClick(c.id, { onTimeout: v })
    ));
  }
  wrap.appendChild(r3);

  return wrap;
}

// ---------- one row ----------
function buildRow(c, index, total) {
  const tr = document.createElement('tr');
  if (c.id === runningId) tr.classList.add('running');
  if (c.id === current.armedId) tr.classList.add('armed');

  // select checkbox
  const tdSel = document.createElement('td');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = selected.has(c.id);
  cb.addEventListener('change', () => {
    if (cb.checked) selected.add(c.id); else selected.delete(c.id);
    refreshToolbar();
    el.selectAll.checked = selected.size === current.clicks.length && current.clicks.length > 0;
  });
  tdSel.appendChild(cb);
  tr.appendChild(tdSel);

  // number badge
  const tdNum = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = 'num-badge';
  badge.textContent = index + 1;
  tdNum.appendChild(badge);
  tr.appendChild(tdNum);

  if (c.type === 'key') {
    // key steps have no position/button — one cell spans both columns
    const tdKeys = document.createElement('td');
    tdKeys.colSpan = 2;
    tdKeys.appendChild(buildKeys(c));
    tr.appendChild(tdKeys);
  } else if (c.type === 'drag') {
    // drag: a start point and an end point, plus button + glide duration
    const tdPos = document.createElement('td');
    tdPos.appendChild(buildPosCell(c, 'start', 'Start'));
    tdPos.appendChild(buildPosCell(c, 'end', 'End'));
    tr.appendChild(tdPos);

    const tdBtn = document.createElement('td');
    const btnWrap = document.createElement('div');
    btnWrap.className = 'delay';
    btnWrap.appendChild(makeSelect(
      [['left', 'Left'], ['right', 'Right'], ['middle', 'Middle']],
      c.button,
      (v) => api.updateClick(c.id, { button: v })
    ));
    const dur = document.createElement('label');
    dur.className = 'axis';
    const durTag = document.createElement('span');
    durTag.textContent = 'glide';
    durTag.title = 'Time the press-and-move takes, in milliseconds (0 = instant).';
    const durInput = makeNumber(c.duration, (v) => api.updateClick(c.id, { duration: Number(v) }));
    const ms = document.createElement('span');
    ms.className = 'sep'; ms.textContent = 'ms';
    dur.appendChild(durTag);
    dur.appendChild(durInput);
    dur.appendChild(ms);
    btnWrap.appendChild(dur);
    tdBtn.appendChild(btnWrap);
    tr.appendChild(tdBtn);
  } else if (c.type === 'scroll') {
    // scroll: a position to scroll at, plus direction + amount
    const tdPos = document.createElement('td');
    tdPos.appendChild(buildPosCell(c, 'pos'));
    tr.appendChild(tdPos);

    const tdBtn = document.createElement('td');
    const btnWrap = document.createElement('div');
    btnWrap.className = 'delay';
    btnWrap.appendChild(makeSelect(
      [['down', '▼ Down'], ['up', '▲ Up'], ['left', '◀ Left'], ['right', '▶ Right']],
      c.direction,
      (v) => api.updateClick(c.id, { direction: v })
    ));
    const amt = document.createElement('label');
    amt.className = 'axis';
    const amtTag = document.createElement('span');
    amtTag.textContent = 'steps';
    amtTag.title = 'Number of wheel notches to scroll each time this step fires.';
    const amtInput = makeNumber(c.amount, (v) => api.updateClick(c.id, { amount: Number(v) }));
    amt.appendChild(amtTag);
    amt.appendChild(amtInput);
    btnWrap.appendChild(amt);
    tdBtn.appendChild(btnWrap);
    tr.appendChild(tdBtn);
  } else if (c.type === 'condition') {
    // condition: a screen/loop test + flow control, spanning position + action
    const tdCond = document.createElement('td');
    tdCond.colSpan = 2;
    tdCond.appendChild(buildCondition(c));
    tr.appendChild(tdCond);
  } else {
    // position
    const tdPos = document.createElement('td');
    tdPos.appendChild(buildPosCell(c, 'pos'));

    // per-click position increment (added after each click, resets each run)
    const step = document.createElement('div');
    step.className = 'step';
    const lbl = document.createElement('span');
    lbl.className = 'step-label';
    lbl.textContent = 'move/click';
    lbl.title = 'Pixels added to the position after each click. Resets when you press Run.';
    step.appendChild(lbl);
    step.appendChild(makeStep('x', c.stepX, (v) => api.updateClick(c.id, { stepX: Number(v) })));
    step.appendChild(makeStep('y', c.stepY, (v) => api.updateClick(c.id, { stepY: Number(v) })));
    tdPos.appendChild(step);

    tr.appendChild(tdPos);

    // click type
    const tdBtn = document.createElement('td');
    const btnWrap = document.createElement('div');
    btnWrap.className = 'delay';
    btnWrap.appendChild(makeSelect(
      [['left', 'Left'], ['right', 'Right'], ['middle', 'Middle']],
      c.button,
      (v) => api.updateClick(c.id, { button: v })
    ));
    btnWrap.appendChild(makeSelect(
      [['single', 'Single'], ['double', 'Double']],
      c.double ? 'double' : 'single',
      (v) => api.updateClick(c.id, { double: v === 'double' })
    ));
    tdBtn.appendChild(btnWrap);
    tr.appendChild(tdBtn);
  }

  // delay
  const tdDelay = document.createElement('td');
  tdDelay.appendChild(buildDelay(c));
  tr.appendChild(tdDelay);

  // order up/down
  const tdOrder = document.createElement('td');
  const orderWrap = document.createElement('div');
  orderWrap.className = 'row-actions';
  const up = iconBtn('▲', 'Move up', () => api.moveClick(c.id, -1));
  up.disabled = index === 0;
  const down = iconBtn('▼', 'Move down', () => api.moveClick(c.id, 1));
  down.disabled = index === total - 1;
  orderWrap.appendChild(up);
  orderWrap.appendChild(down);
  tdOrder.appendChild(orderWrap);
  tr.appendChild(tdOrder);

  // delete
  const tdAct = document.createElement('td');
  const del = iconBtn('🗑', 'Delete', () => api.deleteClick(c.id));
  del.classList.add('danger');
  tdAct.appendChild(del);
  tr.appendChild(tdAct);

  return tr;
}

function iconBtn(glyph, title, onClick) {
  const b = document.createElement('button');
  b.className = 'iconbtn';
  b.textContent = glyph;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

// ---------- browser bot ----------
const BB_LABELS = {
  navigate: 'Navigate', clickEl: 'Click', typeText: 'Type', waitFor: 'Wait for',
  waitTimeout: 'Wait', read: 'Read', scrollToEl: 'Scroll to', if: 'If',
};

// One labeled field row: a caption plus its controls.
function field(labelText, ...nodes) {
  const f = document.createElement('div');
  f.className = 'bb-field';
  if (labelText) {
    const l = document.createElement('span');
    l.className = 'lbl';
    l.textContent = labelText;
    f.appendChild(l);
  }
  nodes.forEach((n) => n && f.appendChild(n));
  return f;
}

function checkbox(labelText, checked, onChange) {
  const lbl = document.createElement('label');
  lbl.className = 'chk';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!checked;
  cb.addEventListener('change', () => onChange(cb.checked));
  lbl.appendChild(cb);
  lbl.appendChild(document.createTextNode(' ' + labelText));
  return lbl;
}

// "Pick" button: arms click-to-pick on the page for one selector field.
function bbPickBtn(stepId, fieldName) {
  const t = current.pickTarget;
  const picking = !!t && t.id === stepId && t.field === fieldName;
  const b = document.createElement('button');
  b.className = 'btn ghost small';
  b.textContent = picking ? 'Picking…' : 'Pick';
  b.title = 'Click an element on the page to capture its selector (Esc cancels)';
  b.addEventListener('click', () => api.browserPick(stepId, fieldName));
  return b;
}

// A small dropdown to insert a step (used for if-branch children).
function buildAddControl(onPick) {
  const s = document.createElement('select');
  s.className = 'bb-input';
  s.style.maxWidth = '170px';
  const opts = [['', '+ add step'], ['navigate', 'Navigate'], ['clickEl', 'Click'],
    ['typeText', 'Type'], ['waitFor', 'Wait for'], ['waitTimeout', 'Wait'],
    ['read', 'Read'], ['scrollToEl', 'Scroll to'], ['if', 'If / Else']];
  for (const [v, l] of opts) s.appendChild(opt(v, l, ''));
  s.addEventListener('change', () => { if (s.value) { onPick(s.value); s.value = ''; } });
  const wrap = document.createElement('div');
  wrap.style.marginTop = '6px';
  wrap.appendChild(s);
  return wrap;
}

// The condition editor for an `if` step: choose a kind, then its parameters.
function buildBrowserCondition(step, upd) {
  const cond = step.cond || {};
  const cupd = (patch) => upd({ cond: patch });
  const wrap = document.createElement('div');
  wrap.className = 'bb-fields';

  wrap.appendChild(field('If', makeSelect(
    [['elementExists', 'element exists'], ['elementVisible', 'element is visible'],
     ['textExists', 'page contains text'], ['attrEquals', 'attribute equals'],
     ['attrContains', 'attribute contains']],
    cond.kind, (v) => cupd({ kind: v })
  )));

  if (cond.kind === 'textExists') {
    wrap.appendChild(field('Text', makeText(cond.text, 'text somewhere on the page', (v) => cupd({ text: v }))));
  } else {
    const sel = makeText(cond.selector, 'CSS selector', (v) => cupd({ selector: v }), { mono: true });
    wrap.appendChild(field('Selector', sel, bbPickBtn(step.id, 'cond')));
    if (cond.kind === 'attrEquals' || cond.kind === 'attrContains') {
      wrap.appendChild(field('Attribute',
        makeText(cond.attr, 'href', (v) => cupd({ attr: v })),
        makeText(cond.value, 'value', (v) => cupd({ value: v }))));
    } else {
      wrap.appendChild(field('Text', makeText(cond.text, 'optional: contains text', (v) => cupd({ text: v }))));
    }
  }
  return wrap;
}

// One `then`/`else` branch: a labeled, indented list of child steps + add box.
function buildBranch(step, branch, label) {
  const list = (branch === 'else' ? step.else : step.then) || [];
  const wrap = document.createElement('div');
  wrap.className = 'bb-branch' + (branch === 'else' ? ' else' : '');
  const lbl = document.createElement('div');
  lbl.className = 'bb-branch-label';
  lbl.textContent = label;
  wrap.appendChild(lbl);

  const body = document.createElement('div');
  body.className = 'bb-branch-body';
  if (list.length === 0) {
    const e = document.createElement('div');
    e.className = 'bb-branch-empty';
    e.textContent = '(no steps)';
    body.appendChild(e);
  } else {
    list.forEach((s, i) => body.appendChild(buildBrowserStep(s, i, list.length)));
  }
  body.appendChild(buildAddControl((kind) => api.addBrowserChild(step.id, branch, kind)));
  wrap.appendChild(body);
  return wrap;
}

// One browser step card. `if` steps recurse into their then/else branches.
function buildBrowserStep(step, index, total) {
  const upd = (patch) => api.updateBrowserStep(step.id, patch);
  const card = document.createElement('div');
  card.className = 'bb-step';
  if (step.id === browserRunningId) card.classList.add('running');
  if (current.pickTarget && current.pickTarget.id === step.id) card.classList.add('picking');

  // header: number + kind + reorder/delete
  const head = document.createElement('div');
  head.className = 'bb-head';
  const badge = document.createElement('span');
  badge.className = 'num-badge';
  badge.textContent = index + 1;
  const kind = document.createElement('span');
  kind.className = 'bb-kind';
  kind.textContent = BB_LABELS[step.type] || step.type;
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  const up = iconBtn('▲', 'Move up', () => api.moveBrowserStep(step.id, -1));
  up.disabled = index === 0;
  const down = iconBtn('▼', 'Move down', () => api.moveBrowserStep(step.id, 1));
  down.disabled = index === total - 1;
  const del = iconBtn('🗑', 'Delete', () => api.deleteBrowserStep(step.id));
  del.classList.add('danger');
  head.append(badge, kind, spacer, up, down, del);
  card.appendChild(head);

  const fields = document.createElement('div');
  fields.className = 'bb-fields';
  card.appendChild(fields);

  // a selector + text target row, shared by element-targeting steps
  const targetRows = () => {
    const sel = makeText(step.selector, 'CSS selector e.g. button.login', (v) => upd({ selector: v }), { mono: true });
    fields.appendChild(field('Selector', sel, bbPickBtn(step.id, 'selector')));
    fields.appendChild(field('Text', makeText(step.text, 'optional: element contains text', (v) => upd({ text: v }))));
  };

  if (step.type === 'navigate') {
    fields.appendChild(field('URL', makeText(step.url, 'https://example.com', (v) => upd({ url: v }))));
    fields.appendChild(field('', checkbox('Wait for page to finish loading', step.waitLoad, (b) => upd({ waitLoad: b }))));
  } else if (step.type === 'clickEl') {
    targetRows();
    fields.appendChild(field('Click',
      makeSelect([['left', 'Left'], ['right', 'Right'], ['middle', 'Middle']], step.button, (v) => upd({ button: v })),
      makeSelect([['single', 'Single'], ['double', 'Double']], step.dblclick ? 'double' : 'single', (v) => upd({ dblclick: v === 'double' }))));
  } else if (step.type === 'typeText') {
    targetRows();
    fields.appendChild(field('Value', makeText(step.value, 'text to type', (v) => upd({ value: v }))));
    fields.appendChild(field('',
      checkbox('Clear first', step.clearFirst, (b) => upd({ clearFirst: b })),
      checkbox('Press Enter after', step.pressEnter, (b) => upd({ pressEnter: b }))));
  } else if (step.type === 'waitFor') {
    targetRows();
    const ms = document.createElement('span'); ms.className = 'sep'; ms.textContent = 'ms timeout';
    fields.appendChild(field('Until',
      makeSelect([['present', 'is present'], ['visible', 'is visible'], ['absent', 'is gone']], step.state, (v) => upd({ state: v })),
      makeNumber(step.timeoutMs, (v) => upd({ timeoutMs: Number(v) })), ms));
  } else if (step.type === 'read') {
    targetRows();
    fields.appendChild(field('Read',
      makeSelect([['text', 'text'], ['value', 'value'], ['href', 'href'], ['html', 'html']], step.attr, (v) => upd({ attr: v }))));
    fields.appendChild(field('Into var', makeText(step.varName, 'name', (v) => upd({ varName: v }))));
  } else if (step.type === 'scrollToEl') {
    targetRows();
  } else if (step.type === 'if') {
    fields.appendChild(buildBrowserCondition(step, upd));
    card.appendChild(buildBranch(step, 'then', 'Then'));
    card.appendChild(buildBranch(step, 'else', 'Else'));
  }

  // delay (the `if` step has none of its own — its branches carry the work)
  if (step.type !== 'if') {
    fields.appendChild(field(step.type === 'waitTimeout' ? 'Wait' : 'Then wait', buildDelay(step, upd)));
  }

  return card;
}

function renderBrowser() {
  el.browserRows.innerHTML = '';
  current.browserSteps.forEach((s, i) => el.browserRows.appendChild(buildBrowserStep(s, i, current.browserSteps.length)));
  el.bbEmpty.classList.toggle('show', current.browserSteps.length === 0);

  if (document.activeElement !== el.bbUrl) el.bbUrl.value = (current.browser && current.browser.url) || '';

  const running = current.browserRunning;
  el.bbRunBtn.disabled = running || current.browserSteps.length === 0;
  el.bbStopBtn.disabled = !running;
  el.bbStatus.textContent = running ? 'Running' : 'Idle';
  el.bbStatus.className = 'status ' + (running ? 'running' : 'idle');
  el.bbAdd.querySelectorAll('button').forEach((b) => { b.disabled = running; });
}

function applyMode() {
  const browser = current.mode === 'browser';
  el.screenPanel.classList.toggle('hidden', browser);
  el.browserPanel.classList.toggle('hidden', !browser);
  el.tabScreen.classList.toggle('active', !browser);
  el.tabBrowser.classList.toggle('active', browser);
  if (browser) ensureGuest();
}

// Report the webview's webContents id to main once it's attached.
function ensureGuest() {
  try {
    const id = el.bv.getWebContentsId();
    if (id) api.browserSetGuestId(id);
  } catch (_) { /* not attached yet — dom-ready will retry */ }
}

// ---------- render ----------
function render() {
  // drop selections for clicks that no longer exist
  const ids = new Set(current.clicks.map((c) => c.id));
  for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);

  el.rows.innerHTML = '';
  current.clicks.forEach((c, i) => el.rows.appendChild(buildRow(c, i, current.clicks.length)));

  el.empty.classList.toggle('show', current.clicks.length === 0);
  el.selectAll.checked = selected.size === current.clicks.length && current.clicks.length > 0;

  el.hideCircles.checked = !!current.settings.hideCircles;
  refreshToolbar();

  renderBrowser();
  applyMode();
}

function refreshToolbar() {
  const running = current.running;
  el.copyBtn.disabled = selected.size === 0 || running;
  el.pasteBtn.disabled = !current.canPaste || running;
  el.addBtn.disabled = running;
  el.addKeyBtn.disabled = running;
  el.addDragBtn.disabled = running;
  el.addScrollBtn.disabled = running;
  el.addConditionBtn.disabled = running;
  el.runBtn.disabled = running || current.clicks.length === 0;
  el.stopBtn.disabled = !running;
  el.status.textContent = running ? 'Running' : 'Idle';
  el.status.className = 'status ' + (running ? 'running' : 'idle');
}

// ---------- toolbar events ----------
el.addBtn.addEventListener('click', () => api.addClick());
el.addKeyBtn.addEventListener('click', () => api.addKey());
el.addDragBtn.addEventListener('click', () => api.addDrag());
el.addScrollBtn.addEventListener('click', () => api.addScroll());
el.addConditionBtn.addEventListener('click', () => api.addCondition());
el.copyBtn.addEventListener('click', () => api.copyClicks([...selected]));
el.pasteBtn.addEventListener('click', () => api.pasteClicks());
el.runBtn.addEventListener('click', () => api.run());
el.stopBtn.addEventListener('click', () => api.stop());
el.hideCircles.addEventListener('change', () => api.setSettings({ hideCircles: el.hideCircles.checked }));
el.selectAll.addEventListener('change', () => {
  if (el.selectAll.checked) current.clicks.forEach((c) => selected.add(c.id));
  else selected.clear();
  render();
});

// ---------- browser bot events ----------
el.tabScreen.addEventListener('click', () => api.setMode('screen'));
el.tabBrowser.addEventListener('click', () => api.setMode('browser'));

function goToUrl() { ensureGuest(); api.browserNavigate(el.bbUrl.value); }
el.bbGo.addEventListener('click', goToUrl);
el.bbUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') goToUrl(); });

el.bbAdd.querySelectorAll('button[data-kind]').forEach((b) => {
  b.addEventListener('click', () => api.addBrowserStep(b.dataset.kind));
});
el.bbRunBtn.addEventListener('click', () => { ensureGuest(); api.browserRun(); });
el.bbStopBtn.addEventListener('click', () => api.browserStop());

// webview wiring: report its id, relay picker results, track the address.
let bootstrapped = false;
el.bv.addEventListener('dom-ready', () => {
  ensureGuest();
  if (!bootstrapped) {
    bootstrapped = true;
    const url = (current.browser && current.browser.url) || '';
    if (url && el.bv.getURL() === 'about:blank') api.browserNavigate(url);
  }
});
el.bv.addEventListener('ipc-message', (e) => {
  if (e.channel === 'bbReport') api.browserPickResult(e.args[0]);
});
function syncAddress() {
  const u = el.bv.getURL();
  if (u && u !== 'about:blank') { el.bbUrl.value = u; api.browserSetUrl(u); }
}
el.bv.addEventListener('did-navigate', syncAddress);
el.bv.addEventListener('did-navigate-in-page', syncAddress);

// ---------- main -> renderer ----------
api.onState((s) => { current = s; render(); });
api.onEngine((e) => {
  runningId = e.running ? e.currentId : null;
  current.running = e.running;
  render();
});
api.onBrowserEngine((e) => {
  browserRunningId = e.running ? e.currentId : null;
  current.browserRunning = e.running;
  render();
});

// initial pull (in case the first push was missed)
api.getState().then((s) => { current = s; render(); });
