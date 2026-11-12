'use strict';
// Shared visual layout editor, used by the dock and by the full-screen editor page.
// root: element containing [data-ed=...] controls; any control can be left out.
// api: { getConfig, patch, sendPatch, only? } - "only" lists the boxes this
// editor may move (e.g. ['clock'] in the Clock tab); the rest are drawn faded
// for reference.
window.BaeEditor = function BaeEditor(root, api) {
  const $ = (name) => root.querySelector(`[data-ed="${name}"]`);
  const on = (name, ev, fn) => {
    const n = $(name);
    if (n) n.addEventListener(ev, fn);
  };
  const stage = $('stage');
  const NAMES = { chat: 'Chat', gif: 'GIFs', poll: 'Poll', clock: 'Clock', featured: 'Featured' };
  const ALL = ['chat', 'gif', 'poll', 'clock', 'featured'];
  const EDITABLE = api.only || ALL;
  const boxes = {};
  for (const name of ALL) {
    const b = document.createElement('div');
    const editable = EDITABLE.includes(name);
    b.className = editable ? 'lbox' : 'lbox ref';
    b.dataset.box = name;
    if (editable) b.tabIndex = 0;
    const t = document.createElement('span');
    t.className = 'ltitle';
    t.textContent = NAMES[name];
    b.append(t);
    if (!editable) {
      stage.append(b);
      boxes[name] = b;
      continue;
    }
    // resize handles on every corner and side
    for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const h = document.createElement('i');
      h.className = `rh rh-${dir}`;
      h.dataset.h = dir;
      h.setAttribute('aria-hidden', 'true');
      b.append(h);
    }
    stage.append(b);
    boxes[name] = b;
  }
  let selected = EDITABLE[0];
  let drag = null;
  const L = () => api.getConfig().layout;

  const snap = (v) => (L().snap ? Math.round(v / L().grid) * L().grid : Math.round(v));
  function clampBox(b) {
    const W = L().canvasW;
    const H = L().canvasH;
    b.w = Math.min(W, Math.max(80, b.w));
    b.h = Math.min(H, Math.max(60, b.h));
    b.x = Math.min(W - b.w, Math.max(0, b.x));
    b.y = Math.min(H - b.h, Math.max(0, b.y));
    return b;
  }
  // Resize from any side or corner: only the dragged edges move, the opposite
  // edges stay put, and the box never goes below 80x60 or off the canvas.
  function resizeBox(o, dir, dx, dy) {
    const W = L().canvasW;
    const H = L().canvasH;
    let left = o.x;
    let top = o.y;
    let right = o.x + o.w;
    let bottom = o.y + o.h;
    if (dir.includes('e')) right = Math.min(W, Math.max(left + 80, snap(right + dx)));
    if (dir.includes('w')) left = Math.max(0, Math.min(right - 80, snap(left + dx)));
    if (dir.includes('s')) bottom = Math.min(H, Math.max(top + 60, snap(bottom + dy)));
    if (dir.includes('n')) top = Math.max(0, Math.min(bottom - 60, snap(top + dy)));
    return { ...o, x: left, y: top, w: right - left, h: bottom - top };
  }

  function place(name, b) {
    const { canvasW: W, canvasH: H } = L();
    const el = boxes[name];
    el.style.left = `${(b.x / W) * 100}%`;
    el.style.top = `${(b.y / H) * 100}%`;
    el.style.width = `${(b.w / W) * 100}%`;
    el.style.height = `${(b.h / H) * 100}%`;
  }
  // Resizing the Chat box also resizes chat itself (Chat size), in proportion
  // to the width change, unless that's switched off in Style.
  // GIFs, the poll and featured messages only use their box when set to
  // "Layout box": moving or resizing that box switches them to it, so the
  // change always shows on stream.
  const USES_BOX = { gif: 'gif', poll: 'poll', featured: 'featured' };
  function saveBox(name, b, prev) {
    const cfg = api.getConfig();
    const out = { [`layout.${name}`]: { ...b } };
    const section = USES_BOX[name];
    const moved = prev && (b.x !== prev.x || b.y !== prev.y || b.w !== prev.w || b.h !== prev.h);
    if (section && moved && cfg[section] && cfg[section].location !== 'layout') {
      cfg[section].location = 'layout';
      out[`${section}.location`] = 'layout';
    }
    if (name === 'chat' && prev && b.w !== prev.w && cfg.chat && cfg.chat.scaleWithBox !== false) {
      // in steps of 5, like the Chat size slider, so the two always agree
      const zoom = Math.min(200, Math.max(30, Math.round(((cfg.chat.zoom || 100) * b.w) / prev.w / 5) * 5));
      cfg.chat.zoom = zoom;
      out['chat.zoom'] = zoom;
    }
    if (Object.keys(out).length > 1) api.sendPatch(out);
    else api.patch(`layout.${name}`, { ...b });
  }

  function renderSelected() {
    const b = drag && drag.name === selected ? drag.cur : L()[selected];
    if ($('selName')) $('selName').textContent = NAMES[selected];
    for (const k of ['x', 'y', 'w', 'h']) {
      const input = $(`sel${k.toUpperCase()}`);
      if (input && document.activeElement !== input) input.value = b[k];
    }
    if ($('selLocked')) $('selLocked').checked = !!b.locked;
    if ($('selVisible')) $('selVisible').checked = b.visible !== false;
  }

  function render() {
    const cfg = api.getConfig();
    if (!cfg || !cfg.layout || drag) return;
    const { canvasW: W, canvasH: H, grid } = L();
    stage.style.aspectRatio = `${W} / ${H}`;
    stage.style.setProperty('--ar', String(W / H));
    stage.style.backgroundSize = `${(grid / W) * 100}% ${(grid / H) * 100}%`;
    if ($('gridVal')) $('gridVal').textContent = `${grid}px`;
    if ($('canvasNote')) $('canvasNote').textContent = `${W}x${H}`;
    if ($('snap')) $('snap').checked = !!L().snap;
    const preset = $('preset');
    if (preset) {
      const key = `${W}x${H}`;
      if (![...preset.options].some((o) => o.value === key)) preset.add(new Option(`${key} (custom)`, key));
      preset.value = key;
    }
    for (const [name, el] of Object.entries(boxes)) {
      const b = L()[name];
      place(name, b);
      el.classList.toggle('locked', !!b.locked);
      el.classList.toggle('off', b.visible === false);
      el.classList.toggle('sel', name === selected);
      el.setAttribute('aria-label', `${NAMES[name]} box, x ${b.x}, y ${b.y}, ${b.w} by ${b.h}`);
    }
    renderSelected();
    if (api.onRender) api.onRender(L());
  }

  function select(name) {
    selected = name;
    for (const [n, el] of Object.entries(boxes)) el.classList.toggle('sel', n === name);
    renderSelected();
  }

  for (const [name, el] of Object.entries(boxes)) {
    if (!EDITABLE.includes(name)) continue; // reference boxes can't be moved here
    el.addEventListener('pointerdown', (e) => {
      select(name);
      el.focus({ preventScroll: true });
      const b = L()[name];
      if (b.locked) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      drag = {
        name,
        mode: e.target.dataset.h || 'move',
        startX: e.clientX,
        startY: e.clientY,
        orig: { ...b },
        cur: { ...b },
      };
      el.classList.add('dragging');
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || drag.name !== name) return;
      const scale = L().canvasW / stage.clientWidth;
      const dx = (e.clientX - drag.startX) * scale;
      const dy = (e.clientY - drag.startY) * scale;
      const o = drag.orig;
      drag.cur = drag.mode === 'move' ? clampBox({ ...o, x: snap(o.x + dx), y: snap(o.y + dy) }) : resizeBox(o, drag.mode, dx, dy);
      place(name, drag.cur);
      renderSelected();
    });
    const end = () => {
      if (!drag || drag.name !== name) return;
      const moved = JSON.stringify(drag.cur) !== JSON.stringify(drag.orig);
      const b = drag.cur;
      const prev = drag.orig;
      api.getConfig().layout[name] = { ...b };
      drag = null;
      el.classList.remove('dragging');
      if (moved) saveBox(name, b, prev);
      render();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!step || L()[name].locked) return;
      e.preventDefault();
      const g = L().grid * (e.shiftKey ? 5 : 1);
      const prev = { ...L()[name] };
      const b = clampBox({ ...prev, x: prev.x + step[0] * g, y: prev.y + step[1] * g });
      api.getConfig().layout[name] = b;
      place(name, b);
      renderSelected();
      clearTimeout(el.saveTimer);
      el.saveTimer = setTimeout(() => saveBox(name, b, prev), 250);
    });
    el.addEventListener('focus', () => select(name));
  }

  for (const k of ['x', 'y', 'w', 'h']) {
    on(`sel${k.toUpperCase()}`, 'change', (e) => {
      const prev = { ...L()[selected] };
      const b = clampBox({ ...prev, [k]: Number(e.target.value) || 0 });
      api.getConfig().layout[selected] = b;
      saveBox(selected, b, prev);
      render();
    });
  }
  on('selLocked', 'change', (e) => saveBox(selected, { ...L()[selected], locked: e.target.checked }));
  on('selVisible', 'change', (e) => saveBox(selected, { ...L()[selected], visible: e.target.checked }));
  on('snap', 'change', (e) => api.patch('layout.snap', e.target.checked));
  on('gridMinus', 'click', () => api.patch('layout.grid', Math.max(5, L().grid - 5)));
  on('gridPlus', 'click', () => api.patch('layout.grid', Math.min(200, L().grid + 5)));
  on('preset', 'change', (e) => {
    const [w, h] = e.target.value.split('x').map(Number);
    api.sendPatch({ 'layout.canvasW': w, 'layout.canvasH': h });
  });
  on('reset', 'click', () => {
    if (!confirm('Put chat, GIFs, the poll, the clock and featured messages back in their default spots?')) return;
    const { canvasW: W, canvasH: H } = L();
    const r = (fx, fy, fw, fh) => ({
      x: Math.round(W * fx),
      y: Math.round(H * fy),
      w: Math.round(W * fw),
      h: Math.round(H * fh),
      locked: false,
      visible: true,
    });
    api.sendPatch({
      'layout.chat': r(0.01, 0.24, 0.335, 0.74),
      'layout.gif': r(0.7, 0.04, 0.29, 0.39),
      'layout.poll': r(0.29, 0.28, 0.42, 0.44),
      'layout.clock': r(0.78, 0.04, 0.2, 0.14),
      'layout.featured': r(0.34, 0.04, 0.31, 0.19),
    });
  });

  return { render };
};
