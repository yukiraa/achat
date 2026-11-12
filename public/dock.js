'use strict';
(function () {
  const token = new URLSearchParams(location.search).get('token') || '';
  const DOCK_VERSION = '{{BAE_VERSION}}';
  let dockOutdated = false;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  let ws = null;
  let config = null;

  // ---------- tab navigation ----------
  function go(name) {
    $$('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
    for (const b of $$('#tabs [data-go]')) {
      if (b.dataset.go === name) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    window.scrollTo(0, 0);
    if (name === 'layout' && editor) editor.render();
    if (config && typeof renderLayout === 'function') renderLayout(); // the small editors in each tab
    if (name === 'look') loadPresetText();
  }
  let pickedTab = false; // once you choose a tab, the dock never switches for you
  for (const b of $$('#tabs [data-go]')) {
    b.addEventListener('click', () => {
      pickedTab = true;
      go(b.dataset.go);
    });
  }

  const get = (obj, path) => path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);

  function send(obj) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }
  // verify: for choices (templates, modes). If achat hasn't taken the new value
  // a moment later, it's almost always an older achat still running that
  // doesn't know the option, so say so instead of silently doing nothing.
  let verifyTimer = null;
  function patch(key, value, { verify = false } = {}) {
    send({ type: 'patch', patch: { [key]: value } });
    if (!verify) return;
    clearTimeout(verifyTimer);
    verifyTimer = setTimeout(() => {
      if (!config || get(config, key) === value) return;
      const box = $('#outdated');
      box.textContent =
        "achat didn't accept that change. It's probably still running an older version that doesn't know this option. " +
        'Double-click start.bat (it restarts achat with the latest version), then this panel and your overlays reload by themselves.';
      box.classList.remove('hidden');
      render(); // put the control back to what achat is really using
    }, 2500);
  }

  // ---------- fill form from config ----------
  function render() {
    if (!config) return;
    for (const input of $$('[data-k]')) {
      if (document.activeElement === input) continue;
      const v = get(config, input.dataset.k);
      if (input.type === 'checkbox') input.checked = !!v;
      else input.value = v ?? '';
      const out = document.querySelector(`[data-out="${input.dataset.k}"]`);
      if (out) out.textContent = input.value;
    }
    for (const ta of $$('[data-list]')) {
      if (document.activeElement === ta) continue;
      ta.value = (get(config, ta.dataset.list) || []).join('\n');
    }
    renderCustom(config.custom.commands);
    $('#colorbox').classList.toggle('dim', config.chat.useThemeColors);
    $('#logobox').classList.toggle('hidden', !config.chat.showLogo);
    for (const d of $$('[data-prov]')) d.classList.toggle('hidden', d.dataset.prov !== config.gif.provider);
    const kk = $('[data-secret="gif.klipyKey"]');
    kk.placeholder = config.gif.hasKlipyKey ? 'saved (type to replace)' : 'not set';
    renderLogos(config.chat.logos);
    renderOverlayWarn();
    renderLayout();

    renderPresets();
    loadPresetText();
    renderConnect();
    renderLinks(); // Blur private info may have changed
    renderTestOptions();
    renderChoices();
    const tt = $('[data-secret="connections.tiktok.signKey"]');
    tt.placeholder = config.connections.tiktok.hasSignKey ? 'saved (type to replace)' : 'not set';
    const yk = $('[data-secret="connections.youtube.apiKey"]');
    yk.placeholder = config.connections.youtube.hasApiKey ? 'saved (type to replace)' : 'not set';
    const gk = $('[data-secret="gif.giphyKey"]');
    gk.placeholder = config.gif.hasGiphyKey ? 'saved (type to replace)' : 'not set';
  }

  // ---------- form events ----------
  for (const input of $$('[data-k]')) {
    const key = input.dataset.k;
    if (input.type === 'range') {
      input.addEventListener('input', () => {
        const out = document.querySelector(`[data-out="${key}"]`);
        if (out) out.textContent = input.value;
      });
      input.addEventListener('change', () => patch(key, Number(input.value)));
    } else if (input.type === 'checkbox') {
      input.addEventListener('change', () => patch(key, input.checked));
    } else {
      input.addEventListener('change', () => patch(key, input.value.trim(), { verify: input.tagName === 'SELECT' }));
    }
  }
  for (const ta of $$('[data-list]')) {
    ta.addEventListener('change', () =>
      patch(ta.dataset.list, ta.value.split('\n').map((s) => s.trim()).filter(Boolean)),
    );
  }
  for (const input of $$('[data-secret]')) {
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (v) patch(input.dataset.secret, v);
      input.value = '';
    });
  }
  for (const b of $$('[data-act]')) {
    b.addEventListener('click', () => {
      if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
      send({ type: b.dataset.act });
    });
  }

  // ---------- custom commands ----------
  function renderCustom(list) {
    const ul = $('#clist');
    ul.textContent = '';
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No custom commands yet';
      ul.append(li);
      return;
    }
    for (const c of list) {
      const li = document.createElement('li');
      const img = new Image();
      img.alt = '';
      img.src = `/custom/${c.file}`;
      const code = document.createElement('code');
      code.textContent = `!${c.cmd}`;
      const del = document.createElement('button');
      del.className = 'small warn';
      del.textContent = 'Delete';
      del.addEventListener('click', () => {
        if (confirm(`Delete !${c.cmd}?`)) send({ type: 'custom:delete', cmd: c.cmd });
      });
      li.append(img, code, del);
      ul.append(li);
    }
  }

  $('#cadd').addEventListener('click', async () => {
    const msg = $('#cmsg');
    const cmd = $('#ccmd').value.trim().toLowerCase().replace(/^!/, '');
    const file = $('#cfile').files[0];
    if (!/^[a-z0-9_]{2,20}$/.test(cmd)) return (msg.textContent = 'Command: 2-20 letters, numbers or _');
    if (!file) return (msg.textContent = 'Pick a file first');
    if (file.size > 8 * 1024 * 1024) return (msg.textContent = 'File is larger than 8 MB');
    msg.textContent = 'Uploading...';
    try {
      const res = await fetch(`/api/custom?cmd=${encodeURIComponent(cmd)}`, {
        method: 'POST',
        headers: { 'X-Bae-Token': token },
        body: file,
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || 'Upload failed');
      msg.textContent = `Added !${out.cmd}`;
      $('#ccmd').value = '';
      $('#cfile').value = '';
    } catch (err) {
      msg.textContent = err.message;
    }
  });

  // ---------- platform logos ----------
  function renderLogos(logos) {
    const ul = $('#logolist');
    ul.textContent = '';
    for (const [p, label] of [['youtube', 'YouTube'], ['twitch', 'Twitch'], ['tiktok', 'TikTok']]) {
      const li = document.createElement('li');
      const slot = document.createElement('span');
      slot.className = `logo-slot ${p}`;
      const img = new Image();
      img.alt = '';
      img.src = logos[p] ? `/custom/${logos[p]}` : `/logos/${p}.png`;
      slot.append(img);
      slot.style.background = 'none';
      const name = document.createElement('code');
      name.textContent = label;
      const pick = document.createElement('input');
      pick.type = 'file';
      pick.accept = 'image/gif,image/png,image/webp,image/jpeg';
      pick.hidden = true;
      const up = document.createElement('button');
      up.className = 'small';
      up.textContent = 'Replace';
      up.addEventListener('click', () => pick.click());
      pick.addEventListener('change', async () => {
        const file = pick.files[0];
        if (!file) return;
        up.textContent = '...';
        try {
          const res = await fetch(`/api/logo?platform=${p}`, { method: 'POST', headers: { 'X-Bae-Token': token }, body: file });
          const out = await res.json();
          if (!res.ok) throw new Error(out.error || 'Upload failed');
        } catch (err) {
          alert(err.message);
          up.textContent = 'Replace';
        }
      });
      li.append(slot, name, up, pick);
      if (logos[p]) {
        const del = document.createElement('button');
        del.className = 'small warn';
        del.textContent = 'Reset';
        del.addEventListener('click', () => send({ type: 'logo:delete', platform: p }));
        li.append(del);
      }
      ul.append(li);
    }
  }

  // ---------- warn when no OBS source can show the GIFs ----------
  let overlayCounts = null;
  function renderOverlayWarn() {
    if (!config || !overlayCounts) return;
    const c = overlayCounts;
    const total = c.all + c.chat + c.gif + c.poll + (c.clock || 0);
    const where = (loc, part) => {
      if (total === 0) return 'No overlay is open in OBS right now, so nothing can show. Add a Browser Source with a link from Connect.';
      if (loc === 'layout' && c.all + c[part] === 0) {
        return `Your OBS sources don't show the ${part === 'gif' ? 'GIFs' : 'Poll'} box. Choose ${part === 'gif' ? '"Chat"' : '"Top of chat"'} above, or use the "Everything" link in OBS.`;
      }
      if (loc === 'chat' && c.all + c.chat === 0) return 'None of your OBS sources show chat, so nothing placed in chat will be visible.';
      return '';
    };
    const g = where(config.gif.location, 'gif');
    $('#gifwarn').textContent = g;
    $('#gifwarn').classList.toggle('hidden', !g);
    const pw = where(config.poll.location, 'poll');
    $('#pollwarn').textContent = pw;
    $('#pollwarn').classList.toggle('hidden', !pw);
  }


  // ---------- layout editor (shared with the full-screen editor page) ----------
  const editor = window.BaeEditor($('#layoutPanel'), {
    getConfig: () => config,
    patch,
    sendPatch: (obj) => send({ type: 'patch', patch: obj }),
  });
  // Small layout editors inside the Style, GIFs, Polls and Clock tabs: each moves
  // only its own box ([data-mini="chat|gif|poll|clock"]); the other boxes are
  // drawn faded for reference. They share the same layout as the Layout tab.
  const MINI = {
    chat: { title: 'Chat', color: 'orange', heading: 'Position on stream', help: 'Where chat sits on the "Everything" source.' },
    gif: { title: 'GIFs', color: 'blue', heading: 'GIFs box', help: 'Where GIFs show when "Where GIFs appear" is Layout box.',
      unused: () => config.gif.location !== 'layout', unusedText: 'GIFs appear in chat right now, so this box is not used. Choose "Layout box" above to use it.' },
    poll: { title: 'Poll', color: 'navy', heading: 'Poll box', help: 'Where the poll shows when "Where the poll appears" is Layout box.',
      unused: () => config.poll.location !== 'layout', unusedText: 'The poll appears at the top of chat right now, so this box is not used. Choose "Layout box" above to use it.' },
    clock: { title: 'Clock', color: 'green', heading: '', help: 'Where the clock sits on the "Everything" source.' },
    featured: { title: 'Featured', color: 'pink', heading: 'Featured box', help: 'Where featured messages show when set to Layout box; they grow or shrink to fit it.',
      unused: () => config.featured.location !== 'layout', unusedText: 'Featured messages are pinned at the top of chat right now, so this box is not used. Choose "Layout box" above to use it.' },
  };
  function buildMini(slot, name) {
    const m = MINI[name];
    const mk = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };
    const ed = (n, attr) => {
      n.dataset.ed = attr;
      return n;
    };
    if (m.heading) slot.append(mk('h2', 'gap', m.heading));
    const note = mk('p', 'sub mini-unused hidden', m.unusedText || '');
    const stage = ed(mk('div', 'stage'), 'stage');
    const sel = mk('div', 'selected');
    const head = mk('div', 'row between');
    const checks = mk('div', 'row');
    for (const [attr, label] of [['selVisible', 'Show'], ['selLocked', 'Lock']]) {
      const l = mk('label', 'check tight');
      const input = ed(mk('input'), attr);
      input.type = 'checkbox';
      l.append(input, document.createTextNode(` ${label}`));
      checks.append(l);
    }
    head.append(ed(mk('b', null, m.title), 'selName'), checks);
    const nums = mk('div', 'nums');
    for (const k of ['X', 'Y', 'W', 'H']) {
      const l = mk('label', null, `${k} `);
      const input = ed(mk('input'), `sel${k}`);
      input.type = 'number';
      l.append(input);
      nums.append(l);
    }
    sel.append(head, nums);
    const help = mk('p', 'sub', `${m.help} Drag the ${m.color} ${m.title} box to move it, or a corner or side to resize it. The faded boxes are the other parts, for reference.`);
    slot.append(note, stage, sel, help);
    slot._note = note;
    return window.BaeEditor(slot, {
      getConfig: () => config,
      patch,
      sendPatch: (obj) => send({ type: 'patch', patch: obj }),
      only: [name],
    });
  }
  const miniEditors = $$('[data-mini]').map((slot) => ({ slot, name: slot.dataset.mini, editor: buildMini(slot, slot.dataset.mini) }));

  function renderLayout() {
    if (!config) return;
    editor.render();
    for (const { slot, name, editor: e } of miniEditors) {
      e.render();
      const unused = MINI[name].unused ? MINI[name].unused() : false;
      slot._note.classList.toggle('hidden', !unused);
    }
  }

  // ---------- custom CSS presets ----------
  let loadedPreset = null;
  function renderPresets() {
    const sel = $('#cssPreset');
    const list = config.css.presets;
    sel.textContent = '';
    if (!list.length) sel.add(new Option('No presets yet', ''));
    for (const p of list) sel.add(new Option(p.name, p.id));
    sel.value = config.css.active || '';
    $('#cssRename').disabled = $('#cssDelete').disabled = !list.length;
  }
  async function loadPresetText(force) {
    if (!config || config.chat.lookMode !== 'custom') return;
    const id = config.css.active;
    if (!id) {
      loadedPreset = null;
      return;
    }
    if (!force && (loadedPreset === id || document.activeElement === $('#cssText'))) return;
    try {
      const res = await fetch(`/api/css?id=${encodeURIComponent(id)}`, { headers: { 'X-Bae-Token': token } });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error);
      $('#cssText').value = out.css;
      loadedPreset = id;
    } catch (err) {
      $('#cssMsg').textContent = `Could not load: ${err.message}`;
    }
  }
  async function saveCss(id, name, text) {
    const msg = $('#cssMsg');
    msg.textContent = 'Saving...';
    try {
      const q = new URLSearchParams();
      if (id) q.set('id', id);
      if (name) q.set('name', name);
      const res = await fetch(`/api/css?${q}`, {
        method: 'POST',
        headers: { 'X-Bae-Token': token, 'Content-Type': 'text/css' },
        body: text,
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || 'Save failed');
      loadedPreset = out.id;
      msg.textContent = `Saved "${out.name}", now showing on stream`;
    } catch (err) {
      msg.textContent = err.message;
    }
  }
  $('#cssSave').addEventListener('click', () => {
    const id = config.css.active;
    saveCss(id, id ? '' : 'My CSS', $('#cssText').value);
  });
  $('#cssNew').addEventListener('click', () => {
    const name = prompt('Name for the new preset:', 'My CSS');
    if (name == null) return;
    $('#cssText').value = '';
    saveCss('', name, '');
  });
  $('#cssRename').addEventListener('click', () => {
    const cur = config.css.presets.find((p) => p.id === config.css.active);
    if (!cur) return;
    const name = prompt('New name:', cur.name);
    if (name) send({ type: 'css:rename', id: cur.id, name });
  });
  $('#cssDelete').addEventListener('click', () => {
    const cur = config.css.presets.find((p) => p.id === config.css.active);
    if (cur && confirm(`Delete the preset "${cur.name}"?`)) {
      loadedPreset = null;
      send({ type: 'css:delete', id: cur.id });
    }
  });
  $('#cssPreset').addEventListener('change', (e) => {
    if (!e.target.value) return;
    loadedPreset = null;
    send({ type: 'css:activate', id: e.target.value });
  });
  $('#cssStarter').addEventListener('click', async () => {
    const box = $('#cssText');
    if (box.value.trim() && !confirm('Replace what is in the editor with the starter CSS? Your saved preset stays until you press Save.')) return;
    try {
      const res = await fetch('/static/custom-css-starter.css');
      box.value = await res.text();
      $('#cssMsg').textContent = 'Starter loaded. Press "Save and apply" to see it on stream.';
    } catch (err) {
      $('#cssMsg').textContent = `Could not load the starter: ${err.message}`;
    }
  });
  $('#cssFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) {
      $('#cssMsg').textContent = 'That file is larger than 3 MB';
      return;
    }
    const text = await file.text();
    $('#cssText').value = text;
    saveCss('', file.name.replace(/\.css$/i, ''), text);
  });

  // ---------- warnings about OBS sources ----------
  function renderSourceWarnings() {
    if (!overlayCounts) return;
    const c = overlayCounts;
    const lw = $('#layoutWarn');
    let msg = '';
    if (c.all === 0 && c.chat + c.gif + c.poll > 0) {
      msg = 'Your OBS sources use the single-part links (like "Chat only"), and those always fill their own source, so this layout doesn\'t move them. To arrange things here, replace them with one Browser Source using the "Everything" link from Connect.';
    } else if (c.all === 0) {
      msg = 'No "Everything" Browser Source is open in OBS right now, so layout changes have nothing to show on yet.';
    }
    lw.textContent = msg;
    lw.classList.toggle('hidden', !msg);
    // an "Everything" source whose size doesn't match the canvas still works (it
    // scales to fit), but everything looks smaller than planned: say so plainly
    const sw = $('#sizewarn');
    let sizeMsg = '';
    if (config && c.sizes && c.sizes.length) {
      const { canvasW: W, canvasH: H } = config.layout;
      const off = c.sizes.find(([w, h]) => Math.abs(w - W) > 2 || Math.abs(h - H) > 2);
      if (off) {
        sizeMsg = `Your "Everything" Browser Source in OBS is ${off[0]}x${off[1]}, but the layout canvas is ${W}x${H}. ` +
          `It still fits, just scaled down. For sharp, full-size chat, open the Browser Source properties in OBS and set Width ${W} and Height ${H}.`;
      }
    }
    sw.textContent = sizeMsg;
    sw.classList.toggle('hidden', !sizeMsg);
    const od = $('#outdated');
    if (dockOutdated) return;
    od.textContent = c.outdated
      ? `${c.outdated} OBS source${c.outdated > 1 ? 's are' : ' is'} still running an older version of the overlay. Right-click it in OBS and choose Refresh.`
      : '';
    od.classList.toggle('hidden', !c.outdated);
  }

  // ---------- status, links, state ----------
  const LABEL = { off: 'Off', connecting: 'Connecting', live: 'Connected', waiting: 'Waiting', error: 'Needs attention' };
  function renderStatus(status) {
    for (const [p, [s, detail]] of Object.entries(status)) {
      const dot = document.querySelector(`#status [data-p="${p}"]`);
      if (dot) dot.dataset.s = s;
      const line = document.querySelector(`[data-status="${p}"]`);
      if (line) line.textContent = `${LABEL[s] || s}${detail ? ': ' + detail : ''}`;
    }
  }

  // Copying must work inside OBS's dock browser, which may refuse the modern
  // clipboard API. Try it, then the classic copy command, then select the text.
  async function copyText(text, input) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through
    }
    try {
      input.focus();
      input.select();
      if (document.execCommand('copy')) return true;
    } catch {
      // fall through
    }
    input.focus();
    input.select();
    return false;
  }

  let linkUrls = null;
  function renderLinks(urls) {
    if (urls) linkUrls = urls;
    if (!linkUrls) return;
    const box = $('#links');
    box.textContent = '';
    const names = { all: 'Everything', chat: 'Chat only', gif: 'GIFs only', poll: 'Poll only', clock: 'Clock only' };
    for (const [k, url] of Object.entries(linkUrls)) {
      const row = document.createElement('div');
      row.className = 'link';
      const label = document.createElement('span');
      label.textContent = names[k];
      const btns = document.createElement('span');
      btns.className = 'row';
      const copy = document.createElement('button');
      copy.className = 'small';
      copy.textContent = 'Copy';
      const open = document.createElement('a');
      open.className = 'btn small ghost';
      open.href = url;
      open.target = '_blank';
      open.rel = 'noopener';
      open.textContent = 'Open';
      open.title = 'Open in your browser to check it (shows a status panel)';
      // private: blurred until you press Show (for 10 seconds)
      const blur = !config || config.ui.blurPrivate !== false;
      const show = document.createElement('button');
      show.className = 'small ghost';
      show.textContent = 'Show';
      show.title = 'Show the link for 10 seconds';
      btns.append(copy, open);
      if (blur) btns.prepend(show);
      // the link in a read-only box: one click selects exactly the link
      const field = document.createElement('input');
      field.type = 'text';
      field.readOnly = true;
      field.value = url;
      if (blur) {
        field.classList.add('censor');
        show.addEventListener('click', () => {
          const shown = field.classList.toggle('shown');
          show.textContent = shown ? 'Hide' : 'Show';
          clearTimeout(field.hideTimer);
          if (shown) {
            field.hideTimer = setTimeout(() => {
              field.classList.remove('shown');
              show.textContent = 'Show';
            }, 10000);
          }
        });
      }
      field.setAttribute('aria-label', `${names[k]} link`);
      field.addEventListener('focus', () => field.select());
      field.addEventListener('click', () => field.select());
      copy.addEventListener('click', async () => {
        const ok = await copyText(url, field);
        copy.textContent = ok ? 'Copied' : 'Press Ctrl+C';
        setTimeout(() => (copy.textContent = 'Copy'), 1800);
      });
      // live status: is this link actually open somewhere?
      const n = overlayCounts ? overlayCounts[k] || 0 : null;
      const st = document.createElement('span');
      st.className = `linkstat ${n ? 'on' : 'off'}`;
      st.textContent = n == null ? '' : n ? `Open in ${n} place${n > 1 ? 's' : ''}` : 'Not open anywhere';
      row.append(label, btns, st, field);
      box.append(row);
    }
  }

  function renderGif(g) {
    const last = g.last ? ` Last: ${g.last}.` : '';
    $('#gifnow').textContent = (g.current
      ? `On screen: ${g.current.name} "${g.current.query}". ${g.queued} waiting. ${g.budgetUsed} searches this hour.`
      : `No GIF in the separate spot. ${g.queued} waiting. ${g.budgetUsed} searches this hour.`) + last;
  }

  // the live poll, drawn like the on-stream poll card
  function renderPoll(p) {
    const box = $('#pollNow');
    const live = p && (p.active || p.ended);
    box.classList.toggle('pollnow', !!live);
    if (!live) {
      box.textContent = 'No poll running';
      return;
    }
    box.textContent = '';
    const mk = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };
    box.append(mk('div', 'pn-tag', p.ended ? 'Results' : 'Live poll'), mk('div', 'pn-q', p.question));
    p.options.forEach((o, i) => {
      const pct = p.total ? Math.round((p.counts[i] / p.total) * 100) : 0;
      const row = mk('div', `pn-opt${p.ended && p.winner === i ? ' win' : ''}${p.ended && p.winner >= 0 && p.winner !== i ? ' lose' : ''}`);
      const line = mk('div', 'pn-row');
      line.append(
        mk('code', 'pn-cmd', (p.commands && p.commands[i]) || `!vote${i + 1}`),
        mk('span', 'pn-label', o),
        mk('span', 'pn-pct', `${p.counts[i]} · ${pct}%`),
      );
      const bar = mk('div', 'pn-bar');
      const fill = mk('i');
      fill.style.width = `${pct}%`;
      bar.append(fill);
      row.append(line, bar);
      box.append(row);
    });
    const hint = p.ended ? (p.total === 0 ? 'No votes this time' : p.winner === -2 ? "It's a tie!" : 'Poll closed') : 'Voting open';
    const foot = mk('div', 'pn-foot');
    foot.append(mk('span', null, hint), mk('b', null, `${p.total} ${p.total === 1 ? 'vote' : 'votes'}`));
    box.append(foot);
  }

  const pollMsg = (text, ok) => {
    $('#pollMsg').textContent = text;
    $('#pollMsg').classList.toggle('bad', !ok);
  };
  $('#pollSec').addEventListener('input', (e) => ($('#pollSecOut').textContent = e.target.value));
  $('#pollStart').addEventListener('click', () => {
    const question = $('#pollQ').value.trim();
    const options = $('#pollOpts').value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!question) return pollMsg('Write a question first.', false);
    if (options.length < 2) return pollMsg('Add at least two options, each on its own line (press Enter between them).', false);
    if (!send({ type: 'poll:start', question, options, seconds: Number($('#pollSec').value) })) {
      return pollMsg('The panel lost its connection to achat. Is the app window still open?', false);
    }
    pollMsg('Starting...', true);
  });
  $('#pollEnd').addEventListener('click', () => send({ type: 'poll:end' }));
  $('#pollClear').addEventListener('click', () => send({ type: 'poll:clear' }));

  // ---------- connect buttons ----------
  function renderConnect(status) {
    for (const p of ['youtube', 'twitch', 'tiktok']) {
      const box = document.querySelector(`[data-conn="${p}"]`);
      if (!box || !config) continue;
      const on = config.connections[p].enabled;
      const want = on ? 'on' : 'off';
      if (box.dataset.state === want) continue;
      box.dataset.state = want;
      box.textContent = '';
      const main = document.createElement('button');
      main.className = 'small';
      if (!on) {
        main.textContent = 'Connect';
        main.addEventListener('click', () => {
          flushField(p);
          patch(`connections.${p}.enabled`, true);
        });
        box.append(main);
      } else {
        main.textContent = 'Reconnect';
        main.title = 'Apply a changed channel name, or try again';
        main.addEventListener('click', () => {
          flushField(p);
          setTimeout(() => send({ type: 'reconnect', platform: p }), 150);
        });
        const off = document.createElement('button');
        off.className = 'small ghost';
        off.textContent = 'Disconnect';
        off.addEventListener('click', () => patch(`connections.${p}.enabled`, false));
        box.append(main, off);
      }
    }
  }
  // save whatever is typed in the platform's box before connecting
  function flushField(p) {
    const key = { youtube: 'connections.youtube.target', twitch: 'connections.twitch.channel', tiktok: 'connections.tiktok.username' }[p];
    const input = document.querySelector(`[data-k="${key}"]`);
    if (input) patch(key, input.value.trim());
  }


  // ---------- one-of-several choices (segmented buttons) ----------
  const CHOICES = [
    ['data-look', 'chat.lookMode', () => config.chat.lookMode],
    ['data-ui', 'ui.dockTheme', () => config.ui.dockTheme],
    ['data-gifloc', 'gif.location', () => config.gif.location],
    ['data-pollloc', 'poll.location', () => config.poll.location],
    ['data-clockdate', 'clock.dateFormat', () => config.clock.dateFormat],
    ['data-featloc', 'featured.location', () => config.featured.location],
  ];
  for (const [attr, key] of CHOICES) {
    for (const b of $$(`[${attr}]`)) b.addEventListener('click', () => patch(key, b.getAttribute(attr), { verify: true }));
  }
  function renderChoices() {
    for (const [attr, , get] of CHOICES) {
      for (const b of $$(`[${attr}]`)) {
        const on = b.getAttribute(attr) === get();
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      }
    }
    const custom = config.chat.lookMode === 'custom';
    // template and Custom CSS: exactly one is usable
    $('#templateBox').classList.toggle('dim', custom);
    $('#templateLocked').classList.toggle('hidden', !custom);
    $('#customBox').classList.toggle('hidden', !custom);
    $('#customLocked').classList.toggle('hidden', custom);
    // colors only for the Default template
    $('#colorSection').classList.toggle('hidden', custom || config.chat.theme !== 'clean');
    $('#sizeBox').classList.toggle('hidden', custom);
    // Custom CSS: the Style tab shows only the CSS editor
    $('#styleRest').classList.toggle('hidden', custom);
    $('#customOnlyNote').classList.toggle('hidden', !custom);
    // GIF master switch
    const gifOn = config.gif.enabled;
    $('#gifSettings').classList.toggle('dim', !gifOn);
    $('#gifOffNote').classList.toggle('hidden', gifOn);
    // dock look
    document.body.dataset.ui = config.ui.dockTheme;
    renderPollCmds();
    renderClockLook();
    renderTemplatePick();
  }

  // ---------- clock look picker (tiles in the dock's own style) ----------
  const CLOCK_LOOKS = [
    ['Follow chat', [['theme', 'Match chat template', 'Follows Style']]],
    ['Templates, just for the clock', [
      ['clean', 'Default', 'White card'],
      ['dark', 'Dark', 'Charcoal card'],
      ['cloud', 'Cloud Puff', 'White card, cloud buddy'],
      ['kitty', 'Kitty Window', 'Pink window, cat'],
      ['bunny', 'Bunny Note', 'Lavender, bunny'],
      ['matcha', 'Matcha Leaf', 'Green, frog'],
      ['starlight', 'Starlight', 'Midnight, star'],
    ]],
    ['Simple text', [['plain', 'Plain', 'Big white text'], ['outline', 'Outline', 'Dark outline']]],
  ];
  buildTilePicker($('#clockLook'), CLOCK_LOOKS, (v) => patch('clock.style', v, { verify: true }), '12:00');
  // ---------- chat template picker (same tiles as the clock look) ----------
  const CHAT_TEMPLATES = [
    ['Simple cards', [['clean', 'Default', 'Colors editable'], ['dark', 'Dark', 'Charcoal card'], ['cloud', 'Cloud Puff', 'Cloud buddy on top']]],
    ['Window templates', [
      ['kitty', 'Kitty Window', 'Pink window, cat'],
      ['bunny', 'Bunny Note', 'Lavender, bunny'],
      ['matcha', 'Matcha Leaf', 'Green, frog'],
      ['starlight', 'Starlight', 'Midnight, star'],
    ]],
  ];
  // builds a tile picker: groups of [value, name, description] tiles with a mini preview
  function buildTilePicker(box, groups, onPick, sample) {
    for (const [group, looks] of groups) {
      const h = document.createElement('div');
      h.className = 'lookgroup';
      h.textContent = group;
      const grid = document.createElement('div');
      grid.className = 'lookgrid';
      for (const [value, name, desc] of looks) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'looktile';
        b.dataset.look = value;
        b.setAttribute('role', 'radio');
        const sw = document.createElement('span');
        sw.className = `looksw sw-${value}`;
        sw.textContent = sample;
        sw.setAttribute('aria-hidden', 'true');
        const t = document.createElement('span');
        t.className = 'looktext';
        const n = document.createElement('b');
        n.textContent = name;
        const d = document.createElement('small');
        d.textContent = desc;
        t.append(n, d);
        b.append(sw, t);
        b.addEventListener('click', () => onPick(value));
        grid.append(b);
      }
      box.append(h, grid);
    }
  }
  buildTilePicker($('#templatePick'), CHAT_TEMPLATES, (v) => patch('chat.theme', v, { verify: true }), 'Hi!');
  function renderTemplatePick() {
    const custom = config.chat.lookMode === 'custom';
    for (const b of $$('#templatePick .looktile')) {
      const on = b.dataset.look === config.chat.theme;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
      b.disabled = custom; // Custom CSS on: templates are switched off
    }
  }

  function renderClockLook() {
    for (const b of $$('#clockLook .looktile')) {
      const on = b.dataset.look === config.clock.style;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
  }

  // ---------- poll vote commands ----------
  const DEFAULT_CMDS = ['!vote1', '!vote2', '!vote3', '!vote4', '!vote5', '!vote6'];
  const cmdBox = $('#pollCmds');
  for (let i = 0; i < 6; i++) {
    const l = document.createElement('label');
    l.textContent = `Option ${i + 1}`;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.spellcheck = false;
    inp.maxLength = 21;
    inp.dataset.cmd = String(i);
    l.append(inp);
    cmdBox.append(l);
  }
  function renderPollCmds() {
    for (const inp of cmdBox.querySelectorAll('input')) {
      if (document.activeElement !== inp) inp.value = config.poll.commands[Number(inp.dataset.cmd)] || '';
    }
  }
  function sendCmds(list) {
    $('#pollCmdMsg').textContent = 'Saving...';
    send({ type: 'poll:commands', commands: list });
  }
  $('#pollCmdSave').addEventListener('click', () =>
    sendCmds([...cmdBox.querySelectorAll('input')].map((x) => {
      const v = x.value.trim().toLowerCase();
      return v && !v.startsWith('!') ? `!${v}` : v;
    })),
  );
  $('#pollCmdReset').addEventListener('click', () => sendCmds([...DEFAULT_CMDS]));

  // ---------- floating test tool ----------
  const testPanel = $('#testpanel');
  const testOpen = $('#testOpen');
  function setTestOpen(open) {
    testPanel.classList.toggle('hidden', !open);
    testOpen.classList.toggle('hidden', open);
    testOpen.setAttribute('aria-expanded', String(open));
    if (open) $('#testWhat').focus();
  }
  testOpen.addEventListener('click', () => setTestOpen(true));
  $('#testClose').addEventListener('click', () => {
    setTestOpen(false);
    testOpen.focus();
  });
  function syncTestInputs() {
    const typing = $('#testWhat').value === 'type';
    $('#testTypeBox').classList.toggle('hidden', !typing);
    $('#testHint').classList.toggle('hidden', !typing);
  }
  $('#testWhat').addEventListener('change', syncTestInputs);
  syncTestInputs();
  function runTest() {
    const v = $('#testWhat').value;
    $('#testDetail').textContent = '';
    if (!ws || ws.readyState !== 1) {
      $('#testResult').textContent = 'Not connected to the achat app, so the test could not run. Is its window open? The panel reconnects by itself.';
      $('#testResult').classList.add('bad');
      return;
    }
    $('#testResult').textContent = 'Running...';
    $('#testResult').classList.remove('bad');
    if (v === 'type') send({ type: 'test', what: 'type', text: $('#testText').value });
    else if (v.startsWith('custom:')) send({ type: 'test', what: 'type', text: `!${v.slice(7)}` });
    else send({ type: 'test', what: v });
  }
  $('#testRun').addEventListener('click', runTest);
  $('#testText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runTest();
  });
  // clears messages only; every setting stays as it is
  $('#testClear').addEventListener('click', () => send({ type: 'overlay:clear' }));
  function renderTestOptions() {
    const sel = $('#testWhat');
    const keep = sel.value;
    [...sel.querySelectorAll('[data-custom]')].forEach((o) => o.remove());
    for (const c of config.custom.commands) {
      const o = new Option(`Your GIF: !${c.cmd}`, `custom:${c.cmd}`);
      o.dataset.custom = '1';
      sel.add(o);
    }
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }

  function addLog(line) {
    const pre = $('#log');
    pre.textContent += line + '\n';
    const lines = pre.textContent.split('\n');
    if (lines.length > 250) pre.textContent = lines.slice(-250).join('\n');
    pre.scrollTop = pre.scrollHeight;
  }

  go('connect');

  // ---------- Live tab: viewers and chat from every platform ----------
  // Chat text only ever goes in with textContent / img.src, like the overlay.
  const lvList = $('#lvList');
  const PLAT = { youtube: 'YT', twitch: 'TW', tiktok: 'TT' };
  const MAX_LIVE = 300;
  let featuredId = null;
  let unseen = 0;
  const fmtCount = (n) =>
    n >= 10000 ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n) : n.toLocaleString('en');

  function renderViewers(v) {
    let total = 0;
    let any = false;
    for (const p of Object.keys(PLAT)) {
      const n = v ? v[p] : null;
      const chip = document.querySelector(`[data-lv="${p}"]`);
      chip.classList.toggle('off', n == null);
      chip.querySelector('b').textContent = n == null ? '-' : fmtCount(n);
      if (n != null) {
        total += n;
        any = true;
      }
    }
    $('#lvTotal').textContent = any ? fmtCount(total) : '-';
    $('.livebar').classList.toggle('on', any);
  }

  // names that count as "you" for mention highlights: your connected channels
  function myNames() {
    if (!config) return [];
    const c = config.connections;
    return [c.twitch.channel, c.tiktok.username, /^@/.test(c.youtube.target || '') ? c.youtube.target : '']
      .map((n) => String(n || '').replace(/^@/, '').trim().toLowerCase())
      .filter((n) => n.length >= 3);
  }
  const isBlocked = (m) => !!config && (config.bannedUsers.includes(m.key) || config.bannedUsers.includes(m.user.name.toLowerCase()));
  const plainText = (m) => m.parts.map((p) => (p.t === 'text' ? p.v : p.alt)).join('');

  function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function liveItem(m) {
    const li = mk('li', 'lv-msg');
    li.dataset.id = m.id;
    li.dataset.p = m.user.platform;
    li._msg = m;
    const r = m.user.roles || {};
    const text = plainText(m);
    const mention = myNames().some((n) => text.toLowerCase().includes(n));
    li.classList.toggle('paid', !!m.paid);
    li.classList.toggle('staff', !!(r.owner || r.mod));
    li.classList.toggle('member', !!(r.member || r.vip) && !(r.owner || r.mod));
    li.classList.toggle('mention', mention && !m.paid);
    li.classList.toggle('cmd', !!m.cmd);
    li.dataset.search = `${m.user.name} ${text}`.toLowerCase();

    const head = mk('div', 'lv-head');
    const letter = mk('span', 'lv-av', (Array.from(m.user.name)[0] || '?').toUpperCase());
    let h = 0;
    for (const ch of m.user.name) h = (h * 31 + ch.codePointAt(0)) % 360;
    letter.style.background = `hsl(${h} 60% 50%)`;
    if (m.user.avatar) {
      const img = new Image();
      img.className = 'lv-av';
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.loading = 'lazy';
      img.onerror = () => img.replaceWith(letter);
      img.src = m.user.avatar;
      head.append(img);
    } else head.append(letter);
    // the platform's own logo (bundled PNGs, same ones the overlay uses)
    const pf = new Image();
    pf.className = 'lv-pf';
    pf.src = `/logos/${m.user.platform}.png`;
    pf.alt = { youtube: 'YouTube', twitch: 'Twitch', tiktok: 'TikTok' }[m.user.platform] || '';
    pf.title = pf.alt;
    head.append(pf, mk('span', 'lv-name', m.user.name));
    const role = r.owner ? 'host' : r.mod ? 'mod' : r.vip ? 'vip' : r.member ? 'member' : '';
    if (role) head.append(mk('span', 'lv-role', role));
    if (m.paid && m.paid.amount) head.append(mk('span', 'lv-tag amount', m.paid.amount));
    if (mention) head.append(mk('span', 'lv-tag mention', '@ you'));
    if (!m.onStream) head.append(mk('span', 'lv-tag note', 'not on stream'));
    head.append(mk('span', 'lv-time', new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));

    const body = mk('div', 'lv-text');
    for (const p of m.parts) {
      if (p.t === 'emote') {
        const img = new Image();
        img.alt = p.alt;
        img.title = p.alt;
        img.referrerPolicy = 'no-referrer';
        img.onerror = () => img.replaceWith(document.createTextNode(p.alt));
        img.src = p.url;
        body.append(img);
      } else body.append(document.createTextNode(p.v));
    }

    const acts = mk('div', 'lv-acts');
    const hide = mk('button', 'small ghost', 'Hide');
    hide.dataset.act = 'chat:hide';
    hide.title = 'Remove this message from the stream';
    const block = mk('button', 'small ghost');
    block.dataset.act = 'user:ban';
    const feat = mk('button', 'small ghost');
    feat.dataset.act = 'chat:feature';
    acts.append(hide, block, feat);
    li.append(head, body, acts);
    updateItem(li);
    applySearch(li);
    return li;
  }

  // refresh the parts of a message that can change later
  function updateItem(li) {
    const m = li._msg;
    const [hide, block, feat] = li.querySelectorAll('.lv-acts button');
    li.classList.toggle('hid', !!m.hidden);
    li.classList.toggle('del', !!m.deleted);
    // deleted by a platform mod: gone from the stream, kept here crossed out
    if (m.deleted && !li.querySelector('.lv-tag.deleted')) {
      li.querySelector('.lv-time').before(mk('span', 'lv-tag deleted', 'deleted by mod'));
    }
    hide.disabled = !m.onStream || !!m.hidden || !!m.deleted;
    hide.textContent = m.hidden ? 'Hidden' : 'Hide';
    const blocked = isBlocked(m);
    block.textContent = blocked ? 'Unblock' : 'Block';
    block.classList.toggle('on', blocked);
    block.title = blocked ? 'Let this viewer use commands again' : 'Stop this viewer using !gif, custom commands and votes';
    const isFeat = featuredId === m.id;
    li.classList.toggle('featured', isFeat);
    feat.textContent = isFeat ? 'Unfeature' : 'Feature';
    feat.classList.toggle('on', isFeat);
    feat.disabled = !!m.hidden || !!m.deleted;
    const secs = config ? config.featured.seconds : 20;
    feat.title = isFeat ? 'Take it off the stream now' : secs > 0 ? `Pin this message on stream for ${secs} seconds` : 'Pin this message on stream until you take it off';
  }

  lvList.addEventListener('click', (e) => {
    const b = e.target.closest('.lv-acts button');
    if (!b) return;
    send({ type: b.dataset.act, id: b.closest('.lv-msg').dataset.id });
  });

  const nearBottom = () => lvList.scrollHeight - lvList.scrollTop - lvList.clientHeight < 40;
  function addLive(m, { stick } = {}) {
    const follow = stick ?? nearBottom();
    lvList.append(liveItem(m));
    while (lvList.children.length > MAX_LIVE) lvList.firstElementChild.remove();
    $('#lvEmpty').classList.toggle('hidden', lvList.children.length > 0);
    if (follow) lvList.scrollTop = lvList.scrollHeight;
    else {
      unseen++;
      $('#lvNew').textContent = `${unseen} new message${unseen > 1 ? 's' : ''}`;
      $('#lvNew').classList.remove('hidden');
    }
  }
  function loadLive(list) {
    lvList.textContent = '';
    for (const m of list || []) addLive(m, { stick: true });
    $('#lvEmpty').classList.toggle('hidden', lvList.children.length > 0);
  }
  const jumpDown = () => {
    lvList.scrollTop = lvList.scrollHeight;
    unseen = 0;
    $('#lvNew').classList.add('hidden');
  };
  $('#lvNew').addEventListener('click', jumpDown);
  lvList.addEventListener('scroll', () => {
    if (unseen && nearBottom()) jumpDown();
  });

  // filter by platform
  for (const b of $$('[data-lvf]')) {
    b.addEventListener('click', () => {
      lvList.dataset.filter = b.dataset.lvf;
      for (const x of $$('[data-lvf]')) {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-checked', String(x === b));
      }
      lvList.scrollTop = lvList.scrollHeight;
    });
  }
  $('[data-lvf="all"]').classList.add('on');
  // search names and words
  function applySearch(li) {
    const q = $('#lvSearch').value.trim().toLowerCase();
    li.classList.toggle('nomatch', !!q && !li.dataset.search.includes(q));
  }
  $('#lvSearch').addEventListener('input', () => {
    for (const li of lvList.children) applySearch(li);
    lvList.scrollTop = lvList.scrollHeight;
  });
  $('#lvTest').addEventListener('click', () => {
    if (!send({ type: 'test', what: 'chat' })) {
      $('#lvEmpty').textContent = 'Not connected to the achat app. Is its window open?';
      $('#lvEmpty').classList.remove('hidden');
    }
  });
  $('#appStop').addEventListener('click', () => {
    if (!confirm('Stop achat? Chat, GIFs and polls stop on stream until you start it again with start.bat.')) return;
    send({ type: 'app:stop' });
  });

  const refreshLive = () => {
    for (const li of lvList.children) updateItem(li);
  };

  // ---------- connection ----------
  const OFFLINE_HTML = $('#offline').innerHTML; // fixed text from dock.html, never chat data
  let retry = 0;
  function connect() {
    if (!token) {
      $('#offline').textContent = 'This dock link is missing its token. Copy the full dock link from the achat window.';
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
      // back to the normal message after a "Stop achat"
      $('#offline').innerHTML = OFFLINE_HTML;
    };
    ws.onmessage = (e) => {
      lastHeard = Date.now();
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      switch (m.type) {
        case 'ping': break; // heartbeat
        case 'hello':
          // achat was updated since this panel loaded: load the new version
          if (m.version && m.version !== DOCK_VERSION && !DOCK_VERSION.includes('{{')) {
            location.reload();
            return;
          }
          if (m.version && m.version !== DOCK_VERSION) {
            $('#outdated').textContent = `This control panel is an older version (${DOCK_VERSION}) than the app (${m.version}), so some buttons may not work. In OBS, close this dock and open it again, or right-click inside it and choose Reload.`;
            $('#outdated').classList.remove('hidden');
            dockOutdated = true;
          }
          config = m.config;
          render();
          renderStatus(m.status);
          renderLinks(m.urls);
          renderGif(m.gif);
          renderPoll(m.poll);
          featuredId = m.featured || null;
          // an app from before the Live tab sends no chat to the dock: say so plainly
          $('#lvOld').classList.toggle('hidden', Array.isArray(m.features) && m.features.includes('live'));
          renderViewers(m.viewers);
          loadLive(m.chat);
          // with a platform connected, open on the Live tab (unless you already picked one)
          if (!pickedTab && Object.values(m.config.connections).some((c) => c.enabled)) go('live');
          overlayCounts = m.overlays;
          renderOverlayWarn();
          renderSourceWarnings();
          renderLinks();
          $('#bigEditor').href = m.layoutUrl;
          $('#copyEditor').onclick = async () => {
            try {
              await navigator.clipboard.writeText(m.layoutUrl);
              $('#copyEditor').textContent = 'Copied';
            } catch {
              prompt('Copy this link:', m.layoutUrl);
            }
            setTimeout(() => ($('#copyEditor').textContent = 'Copy its link'), 1200);
          };
          $('#log').textContent = '';
          m.log.forEach(addLog);
          break;
        case 'config': config = m.config; render(); refreshLive(); break;
        case 'viewers': renderViewers(m.viewers); break;
        case 'livechat': addLive(m.msg); break;
        case 'livechat:update': {
          const li = lvList.querySelector(`[data-id="${CSS.escape(m.id)}"]`);
          if (li) {
            li._msg.hidden = !!m.hidden;
            li._msg.deleted = !!m.deleted;
            updateItem(li);
          }
          break;
        }
        case 'featured': featuredId = m.id; refreshLive(); break;
        case 'stopping':
          $('#offline').textContent = 'achat is stopped. Double-click start.bat in the achat folder to start it again; this panel reconnects by itself.';
          break;
        case 'status': renderStatus(m.status); break;
        case 'gifState': renderGif(m.gif); break;
        case 'pollState': renderPoll(m.poll); break;
        case 'log':
          addLog(m.line);
          if (/\] (GIF|Custom)/.test(m.line)) $('#gifmsg').textContent = m.line.replace(/^\[[^\]]*\] /, '');
          if (/\] (GIF|Poll)/.test(m.line)) $('#testDetail').textContent = m.line.replace(/^\[[^\]]*\] /, '');
          break;
        case 'notice':
          if (m.area === 'test') {
            $('#testResult').textContent = m.text;
            $('#testResult').classList.toggle('bad', !m.ok);
          }
          if (m.area === 'poll') {
            $('#pollCmdMsg').textContent = m.text;
            $('#pollCmdMsg').classList.toggle('bad', !m.ok);
          }
          if (m.area === 'pollstart') pollMsg(m.text, m.ok);
          break;
        case 'overlays': overlayCounts = m.overlays; renderOverlayWarn(); renderSourceWarnings(); renderLinks(); break;
        default:
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
