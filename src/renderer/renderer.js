// Renderer: renders the click table and forwards user actions to the main
// process via window.api. Main is the single source of truth; we re-render
// whenever it pushes new state.

const el = {
  rows: document.getElementById('rows'),
  empty: document.getElementById('empty'),
  addBtn: document.getElementById('addBtn'),
  addKeyBtn: document.getElementById('addKeyBtn'),
  copyBtn: document.getElementById('copyBtn'),
  pasteBtn: document.getElementById('pasteBtn'),
  runBtn: document.getElementById('runBtn'),
  stopBtn: document.getElementById('stopBtn'),
  status: document.getElementById('status'),
  hideCircles: document.getElementById('hideCircles'),
  selectAll: document.getElementById('selectAll'),
};

let current = { clicks: [], settings: {}, running: false, canPaste: false, armedId: null };
let selected = new Set();   // selected click ids (for Copy)
let runningId = null;       // click currently firing (during Run)

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
function buildDelay(c) {
  const wrap = document.createElement('div');
  wrap.className = 'delay';

  const modeSel = makeSelect(
    [['fixed', 'Fixed'], ['random', 'Random']],
    c.delay.mode,
    (v) => api.updateClick(c.id, { delay: { mode: v } })
  );
  wrap.appendChild(modeSel);

  if (c.delay.mode === 'random') {
    wrap.appendChild(makeNumber(c.delay.min, (v) => api.updateClick(c.id, { delay: { min: Number(v) } })));
    const sep = document.createElement('span');
    sep.className = 'sep'; sep.textContent = 'to';
    wrap.appendChild(sep);
    wrap.appendChild(makeNumber(c.delay.max, (v) => api.updateClick(c.id, { delay: { max: Number(v) } })));
  } else {
    wrap.appendChild(makeNumber(c.delay.value, (v) => api.updateClick(c.id, { delay: { value: Number(v) } })));
  }

  wrap.appendChild(makeSelect(
    [['sec', 'seconds'], ['min', 'minutes']],
    c.delay.unit,
    (v) => api.updateClick(c.id, { delay: { unit: v } })
  ));

  return wrap;
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
  } else {
    // position
    const tdPos = document.createElement('td');
    const pos = document.createElement('div');
    pos.className = 'pos';
    const coords = document.createElement('span');
    coords.className = 'coords set';
    coords.textContent = `${c.x}, ${c.y}`;
    const setBtn = document.createElement('button');
    setBtn.className = 'btn ghost small';
    setBtn.textContent = c.id === current.armedId ? 'Press F6…' : 'Set';
    setBtn.title = 'Arm capture, then press F6 at the target spot (or drag the circle)';
    setBtn.addEventListener('click', () => api.armCapture(c.id === current.armedId ? -1 : c.id));
    pos.appendChild(coords);
    pos.appendChild(setBtn);
    tdPos.appendChild(pos);

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
}

function refreshToolbar() {
  const running = current.running;
  el.copyBtn.disabled = selected.size === 0 || running;
  el.pasteBtn.disabled = !current.canPaste || running;
  el.addBtn.disabled = running;
  el.addKeyBtn.disabled = running;
  el.runBtn.disabled = running || current.clicks.length === 0;
  el.stopBtn.disabled = !running;
  el.status.textContent = running ? 'Running' : 'Idle';
  el.status.className = 'status ' + (running ? 'running' : 'idle');
}

// ---------- toolbar events ----------
el.addBtn.addEventListener('click', () => api.addClick());
el.addKeyBtn.addEventListener('click', () => api.addKey());
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

// ---------- main -> renderer ----------
api.onState((s) => { current = s; render(); });
api.onEngine((e) => {
  runningId = e.running ? e.currentId : null;
  current.running = e.running;
  render();
});

// initial pull (in case the first push was missed)
api.getState().then((s) => { current = s; render(); });
