'use strict';
(function () {
  const token = new URLSearchParams(location.search).get('token') || '';
  const $ = (s) => document.querySelector(s);
  let ws = null;
  let config = null;
  const send = (o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
  const patch = (k, v) => send({ type: 'patch', patch: { [k]: v } });

  const stage = document.querySelector('[data-ed="stage"]');
  const frame = $('#preview');

  // live preview: the real overlay, scaled down to the stage
  function fitPreview(L) {
    const layout = L || (config && config.layout);
    if (!layout) return;
    frame.width = layout.canvasW;
    frame.height = layout.canvasH;
    frame.style.transform = `scale(${stage.clientWidth / layout.canvasW})`;
  }
  new ResizeObserver(() => fitPreview()).observe(stage);
  $('#showPreview').addEventListener('change', (e) => {
    frame.style.visibility = e.target.checked ? 'visible' : 'hidden';
  });

  const editor = window.BaeEditor(document.getElementById('editorRoot'), {
    getConfig: () => config,
    patch,
    sendPatch: (obj) => send({ type: 'patch', patch: obj }),
    onRender: fitPreview,
  });

  // floating test tool
  const panel = $('#testpanel');
  const open = $('#testOpen');
  const setOpen = (v) => {
    panel.classList.toggle('hidden', !v);
    open.classList.toggle('hidden', v);
    open.setAttribute('aria-expanded', String(v));
  };
  open.addEventListener('click', () => setOpen(true));
  $('#testClose').addEventListener('click', () => setOpen(false));
  const sync = () => $('#testTypeBox').classList.toggle('hidden', $('#testWhat').value !== 'type');
  $('#testWhat').addEventListener('change', sync);
  sync();
  const run = () => {
    const v = $('#testWhat').value;
    $('#testResult').textContent = 'Running...';
    $('#testDetail').textContent = '';
    send(v === 'type' ? { type: 'test', what: 'type', text: $('#testText').value } : { type: 'test', what: v });
  };
  $('#testRun').addEventListener('click', run);
  $('#testText').addEventListener('keydown', (e) => e.key === 'Enter' && run());
  $('#testClear').addEventListener('click', () => send({ type: 'overlay:clear' }));

  let retry = 0;
  function connect() {
    if (!token) {
      $('#offline').textContent = 'This link is missing its token. Open the editor from the Layout section of the dock.';
      $('#offline').classList.remove('hidden');
      return;
    }
    lastHeard = Date.now();
    const sock = new WebSocket(`ws://${location.host}/ws?role=dock&token=${encodeURIComponent(token)}`);
    ws = sock;
    ws.onopen = () => {
      retry = 0;
      lastHeard = Date.now();
      $('#offline').classList.add('hidden');
      if (!frame.src) frame.src = '/overlay?layer=all&preview=1';
    };
    ws.onmessage = (e) => {
      lastHeard = Date.now();
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.type === 'hello' || m.type === 'config') {
        config = m.config;
        document.body.dataset.ui = config.ui.dockTheme;
        editor.render();
      }
      if (m.type === 'log' && /\] (GIF|Poll)/.test(m.line)) $('#testDetail').textContent = m.line.replace(/^\[[^\]]*\] /, '');
      if (m.type === 'notice' && m.area === 'test') {
        $('#testResult').textContent = m.text;
        $('#testResult').classList.toggle('bad', !m.ok);
      }
    };
    ws.onclose = () => {
      if (ws !== sock) return; // replaced by the watchdog already
      $('#offline').classList.remove('hidden');
      setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
    };
  }
  // achat sends something at least every 10s. Silence for longer means the
  // connection died quietly (PC sleep, hours idle): drop it and reconnect.
  let lastHeard = Date.now();
  setInterval(() => {
    if (!ws || ws.readyState === 3) return; // closed: onclose already schedules a retry
    if (Date.now() - lastHeard < 25000) return;
    const dead = ws;
    ws = null;
    try { dead.close(); } catch { /* already gone */ }
    $('#offline').classList.remove('hidden');
    connect();
  }, 5000);
  connect();
})();
