'use strict';
// SAFETY RULE FOR THIS FILE: chat data is only ever placed with textContent or
// img.src. There is no innerHTML anywhere, so a chat message can never become code.

(function () {
  const params = new URLSearchParams(location.search);
  const layer = ['all', 'chat', 'gif', 'poll', 'clock'].includes(params.get('layer')) ? params.get('layer') : 'all';
  const VERSION = '{{BAE_VERSION}}';
  const preview = params.get('preview') === '1';
  // embed=1: this page is the clock frame inside an "Everything" overlay
  const embed = params.get('embed') === '1';
  document.body.dataset.layer = layer;

  const $chat = document.getElementById('items'); // the moving stack of cards
  const $chatLayer = document.getElementById('chatLayer'); // the fixed frame
  const $chatMask = document.querySelector('yt-live-chat-renderer'); // faded edges live here
  const $gif = document.getElementById('gif');
  const $poll = document.getElementById('poll');
  const $clock = document.getElementById('clock');
  const $featured = document.getElementById('featured');
  if (layer !== 'all') {
    for (const [name, el] of [['chat', $chatLayer], ['gif', $gif], ['poll', $poll], ['clock', $clock], ['featured', $featured]]) {
      if (name !== layer) el.classList.add('hidden');
    }
  }

  let settings = { chat: { maxMessages: 8, hideAfter: 0, fontSize: 16, theme: 'clean', align: 'left' }, gif: {} };

  // ---------- tiny DOM helper (text only) ----------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function hue(name) {
    let h = 0;
    for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360;
    return h;
  }

  function avatar(user, cls) {
    const wrap = el('div', cls);
    const letter = el('div', 'letter', (Array.from(user.name)[0] || '?').toUpperCase());
    letter.style.background = `hsl(${hue(user.name)} 65% 55%)`;
    if (user.avatar) {
      const img = new Image();
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.decoding = 'async';
      img.onerror = () => img.replaceWith(letter);
      img.src = user.avatar;
      wrap.append(img);
    } else {
      wrap.append(letter);
    }
    return wrap;
  }

  // ---------- chat ----------
  function roleLabel(r) {
    if (r.owner) return 'host';
    if (r.mod) return 'mod';
    if (r.vip) return 'vip';
    if (r.member) return 'member';
    return null;
  }

  // Custom CSS chat fills the whole source like YouTube's popout: it lives outside
  // the scaled layout canvas. Templates keep it inside, in the Chat box.
  const $canvas = document.getElementById('canvas');
  function placeChatLayer() {
    // Custom CSS on the "Chat only" link: chat fills the whole source, like
    // YouTube's popout. On the "Everything" link it lives in the Chat box from
    // Layout, so moving and resizing that box works for Custom CSS too.
    const custom = settings.chat && settings.chat.theme === 'custom' && layer !== 'all';
    if (custom && $chatLayer.parentNode !== document.body) {
      document.body.insertBefore($chatLayer, $canvas);
      $chatLayer.classList.add('fill');
      $chatLayer.removeAttribute('style');
    } else if (!custom && $chatLayer.parentNode !== $canvas) {
      $canvas.insertBefore($chatLayer, $canvas.firstChild);
      $chatLayer.classList.remove('fill');
    }
  }

  // ---------- canvas scaling (Everything source) ----------
  let scale = 1;
  let zoom = 1; // chat size setting
  function fitCanvas() {
    if (layer !== 'all' || !settings.layout) return;
    const W = settings.layout.canvasW;
    const H = settings.layout.canvasH;
    scale = Math.min(window.innerWidth / W, window.innerHeight / H) || 1;
    const st = document.documentElement.style;
    st.setProperty('--cw', `${W}px`);
    st.setProperty('--ch', `${H}px`);
    st.setProperty('--k', String(scale));
    st.setProperty('--cx', `${(window.innerWidth - W * scale) / 2}px`);
    st.setProperty('--cy', `${(window.innerHeight - H * scale) / 2}px`);
  }
  window.addEventListener('resize', fitCanvas);

  // ---------- smooth chat motion ----------
  // Strictly one message at a time: a message fully lands, there's a short
  // pause, then the next one starts. Nothing ever overlaps.
  // The whole stack moves up as ONE piece (one GPU layer), which is much
  // smoother in OBS than animating every card separately.
  const EASE = 'cubic-bezier(0.25, 0.8, 0.25, 1)';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = (t) => new Promise((r) => setTimeout(r, t));

  function duration() {
    if (reduceMotion) return 1;
    const base = settings.chat.animMs || 500;
    // when chat is flooded, shorten each entry instead of overlapping them
    if (entryQueue.length > 1) return base * 0.7;
    return base;
  }

  // little cloud puffs that pop off the side a bubble came from
  function puffs(rect, side, dur) {
    if (reduceMotion) return;
    const box = $chatLayer.getBoundingClientRect();
    const baseX = ((side === 'left' ? rect.left : rect.right) - box.left) / scale;
    const dir = side === 'left' ? -1 : 1;
    for (let i = 0; i < 4; i++) {
      const size = 9 + Math.random() * 14;
      const p = el('span', 'puff');
      p.style.width = p.style.height = `${size}px`;
      p.style.left = `${baseX - size / 2}px`;
      p.style.top = `${(rect.top - box.top + rect.height * (0.25 + Math.random() * 0.5)) / scale - size / 2}px`;
      $chatLayer.append(p);
      const dx = dir * (18 + Math.random() * 30);
      const dy = -10 + Math.random() * 20;
      p.animate(
        [
          { transform: 'translate(0, 0) scale(0)', opacity: 0.95 },
          { transform: `translate(${dx * 0.6}px, ${dy * 0.6}px) scale(1)`, opacity: 0.9, offset: 0.4 },
          { transform: `translate(${dx}px, ${dy}px) scale(0.6)`, opacity: 0 },
        ],
        { duration: dur * 0.9, delay: i * 40, easing: 'ease-out', fill: 'backwards' },
      ).finished.then(() => p.remove(), () => p.remove());
    }
  }

  function showCard(card) {
    $chat.append(card);
    const gap = parseFloat(getComputedStyle($chat).rowGap) || 10;
    const rect = card.getBoundingClientRect();
    const lift = card.offsetHeight + gap; // layout pixels, correct at any scale
    const d = duration();

    // 1. the stack (all cards) rises by exactly one card height
    const stack = $chat.animate(
      [{ transform: `translateY(${lift}px)` }, { transform: 'translateY(0)' }],
      { duration: d, easing: EASE },
    );
    // 2. how the new card itself arrives (Animation Mode). Every mode except
    //    Slide Up cancels the stack's vertical motion so the card appears in
    //    place while the older cards glide up around it.
    const mode = settings.chat.animMode || 'slideUp';
    // exact mirror of the stack motion: keeps the new card vertically still
    const holdStill = () =>
      card.animate([{ transform: `translateY(${-lift}px)` }, { transform: 'translateY(0)' }], { duration: d, easing: EASE });
    // extra movement layered on top of whatever else is moving the card
    const addMove = (frames, dur, easing) => card.animate(frames, { duration: dur, easing, composite: 'add' });
    const look = (frames, dur, easing) => card.animate(frames, { duration: dur, easing });

    if (mode === 'bubble') {
      // a speech bubble puffs out of the avatar like a cloud, from a random side
      const side = Math.random() < 0.5 ? 'left' : 'right';
      const dir = side === 'left' ? -1 : 1;
      holdStill();
      card.style.transformOrigin = side === 'left' ? '24px 50%' : 'calc(100% - 24px) 50%';
      const dur = d * 1.25;
      addMove(
        [
          { transform: `translateX(${dir * 26}px) scale(0.2, 0.35)` },
          { transform: 'translateX(0) scale(1.07, 0.95)', offset: 0.55 },
          { transform: 'scale(0.97, 1.03)', offset: 0.78 },
          { transform: 'scale(1)' },
        ],
        dur,
        'ease-out',
      );
      look(
        [
          { opacity: 0, filter: 'blur(8px)' },
          { opacity: 1, filter: 'blur(2px)', offset: 0.35 },
          { opacity: 1, filter: 'blur(0px)', offset: 0.6 },
          { opacity: 1, filter: 'blur(0px)' },
        ],
        dur,
        'ease-out',
      );
      puffs(rect, side, dur);
      setTimeout(() => (card.style.transformOrigin = ''), dur + 50);
    } else if (mode === 'slideUp') {
      look([{ opacity: 0 }, { opacity: 1 }], d * 0.8, 'ease-out');
    } else if (mode === 'slideLeft' || mode === 'slideRight') {
      holdStill();
      const k = scale * zoom; // screen pixels per card pixel
      const x = mode === 'slideLeft' ? -(rect.right / k + 40) : (window.innerWidth - rect.left) / k + 40;
      addMove([{ transform: `translateX(${x}px)` }, { transform: 'translateX(0)' }], d, EASE);
      look([{ opacity: 0 }, { opacity: 1 }], d * 0.8, 'ease-out');
    } else if (mode === 'fadeSlide') {
      holdStill();
      addMove([{ transform: 'translateY(18px)' }, { transform: 'translateY(0)' }], d, EASE);
      look([{ opacity: 0 }, { opacity: 1 }], d, 'ease-out');
    } else if (mode === 'cloud') {
      // a soft blurred puff that settles into place
      holdStill();
      addMove([{ transform: 'scale(0.86)' }, { transform: 'scale(1.02)', offset: 0.7 }, { transform: 'scale(1)' }], d * 1.15, 'ease-out');
      look(
        [
          { opacity: 0, filter: 'blur(12px)' },
          { opacity: 1, filter: 'blur(2px)', offset: 0.7 },
          { opacity: 1, filter: 'blur(0px)' },
        ],
        d * 1.15,
        'ease-out',
      );
    } else if (mode === 'pop') {
      holdStill();
      addMove([{ transform: 'scale(0.6)' }, { transform: 'scale(1.04)', offset: 0.65 }, { transform: 'scale(1)' }], d, 'ease-out');
      look([{ opacity: 0 }, { opacity: 1, offset: 0.4 }, { opacity: 1 }], d, 'ease-out');
    }

    // 3. trim old cards off the top (bottom-anchored, so nothing else moves)
    trimCards([card]);

    return stack.finished.catch(() => {});
  }

  function removeCard(card) {
    if (card.dataset.leaving) return;
    card.dataset.leaving = '1';
    if (isCustom()) {
      card.remove(); // no overlay animation in Custom CSS mode
      return;
    }
    const d = reduceMotion ? 1 : Math.min(400, (settings.chat.animMs || 500) * 0.7);
    const fade = card.animate(
      [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-10px)' }],
      { duration: d, easing: 'ease-in', fill: 'forwards' },
    );
    fade.finished
      .then(() => {
        // fold the space closed smoothly (matters if a middle card is removed)
        const gap = parseFloat(getComputedStyle($chat).rowGap) || 10;
        const h = card.offsetHeight;
        card.style.overflow = 'hidden';
        return card.animate(
          [
            { height: `${h}px`, marginTop: '0px', paddingTop: getComputedStyle(card).paddingTop, paddingBottom: getComputedStyle(card).paddingBottom },
            { height: '0px', marginTop: `${-gap}px`, paddingTop: '0px', paddingBottom: '0px' },
          ],
          { duration: reduceMotion ? 1 : 220, easing: 'ease-in-out', fill: 'forwards' },
        ).finished;
      })
      .catch(() => {})
      .then(() => card.remove());
  }

  // One-by-one entry queue.
  const entryQueue = [];
  let entering = false;
  // Keeping up with chat:
  // - calm chat: one message at a time, full animation, with a reading pause
  // - fast chat: as soon as the oldest waiting message is older than MAX_LAG,
  //   everything waiting comes in together in one quick motion, so the overlay
  //   stays within about a second of live chat and nothing is dropped
  const MAX_LAG = 700; // ms
  const MAX_WAITING = 60; // safety cap for extreme floods
  function enqueueCard(card) {
    card._queuedAt = performance.now();
    entryQueue.push(card);
    if (entryQueue.length > MAX_WAITING) entryQueue.splice(0, entryQueue.length - MAX_WAITING);
    if (!entering) runQueue();
  }
  const lagging = () => entryQueue.length > 0 && performance.now() - entryQueue[0]._queuedAt > MAX_LAG;

  // bring several cards in at once: one stack lift, quick staggered fades
  function showBatch(cards) {
    const gap = parseFloat(getComputedStyle($chat).rowGap) || 10;
    for (const c of cards) $chat.append(c);
    const lift = cards.reduce((sum, c) => sum + c.offsetHeight + gap, 0);
    const d = reduceMotion ? 1 : Math.min(260, (settings.chat.animMs || 500) * 0.5);
    const stack = $chat.animate([{ transform: `translateY(${lift}px)` }, { transform: 'translateY(0)' }], {
      duration: d,
      easing: 'cubic-bezier(0.25, 0.8, 0.25, 1)',
    });
    cards.forEach((c, i) =>
      c.animate([{ opacity: 0 }, { opacity: 1 }], { duration: d, delay: Math.min(i * 25, 150), easing: 'ease-out', fill: 'backwards' }),
    );
    trimCards(cards);
    return stack.finished.catch(() => {});
  }

  function trimCards(added) {
    const live = [...$chat.children].filter((c) => !c.dataset.leaving);
    const extra = live.length - settings.chat.maxMessages;
    for (let i = 0; i < extra; i++) {
      // far-off-screen extras in a flood go instantly instead of animating
      if (extra > 6) live[i].remove();
      else removeCard(live[i]);
    }
    if (settings.chat.hideAfter > 0) for (const c of added) setTimeout(() => removeCard(c), settings.chat.hideAfter * 1000);
  }

  async function runQueue() {
    entering = true;
    while (entryQueue.length) {
      if (isCustom()) {
        // Custom CSS: the overlay adds no animation of its own. Messages appear
        // immediately and your CSS (keyframes, transitions) animates them.
        const all = entryQueue.splice(0, entryQueue.length);
        for (const c of all) $chat.append(c);
        trimCards(all);
        continue;
      }
      if (lagging() && entryQueue.length > 1) {
        const batch = entryQueue.splice(0, entryQueue.length);
        try {
          await showBatch(batch);
        } catch (err) {
          diag.errors.push(`showing messages: ${err.message}`);
          for (const c of batch) if (!c.isConnected) $chat.append(c);
        }
        continue; // no pause: fast chat keeps flowing
      }
      const next = entryQueue.shift();
      try {
        await showCard(next);
      } catch (err) {
        // one bad message must never freeze chat: show it plainly and move on
        diag.errors.push(`showing a message: ${err.message}`);
        if (!next.isConnected) $chat.append(next);
      }
      // reading pause only while that doesn't make the overlay fall behind
      const busy = entryQueue.length > 0;
      let pause = busy ? Math.max(settings.chat.stagger || 0, settings.chat.busyHold ?? 450) : settings.chat.stagger;
      if (busy) pause = Math.max(0, Math.min(pause, MAX_LAG - (performance.now() - entryQueue[0]._queuedAt)));
      if (pause > 0 && !reduceMotion) await sleep(pause);
    }
    entering = false;
  }

  // Shared card frame: avatar, name, role pill. Returns the pieces to fill.
  function makeCard(u) {
    const card = el('div', 'card chatitem');
    const av = avatar(u, 'av');
    av.append(el('span', `pf pf-${u.platform}`));
    const body = el('div', 'body');
    const top = el('div', 'top');
    const name = el('span', 'name', u.name);
    top.append(name);
    // data-role lets each template give hosts, mods, VIPs and members their own look
    const role = roleLabel(u.roles || {});
    if (role) {
      card.dataset.role = role;
      // Twitch calls members subscribers
      top.append(el('span', 'role', role === 'member' && u.platform === 'twitch' ? 'sub' : role));
    }
    body.append(top);
    card.append(av, body);
    if (settings.chat.showLogo) {
      const logo = settings.chat.logos && settings.chat.logos[u.platform];
      if (logo) {
        const img = new Image();
        img.alt = '';
        img.src = logo;
        if (settings.chat.logoPos === 'card') {
          card.classList.add('has-badge');
          const badge = el('span', `pbadge img ${u.platform}`);
          badge.append(img);
          card.append(badge);
        } else {
          const badge = el('span', 'avlogo');
          badge.append(img);
          av.append(badge);
        }
      }
    }
    return { card, top, body };
  }

  function pushCard(card) {
    enqueueCard(card);
  }

  // ---------- YouTube-compatible structure (Custom CSS theme) ----------
  // Mirrors the element names, ids, classes and attributes of YouTube's chat page,
  // e.g. yt-live-chat-text-message-renderer[author-type] > #author-photo, #content,
  // yt-live-chat-author-chip > #author-name.owner, #chat-badges, #message.
  const isCustom = () => settings.chat.theme === 'custom';

  function yt(tag, id, host) {
    const n = document.createElement(tag);
    if (id) n.id = id;
    n.className = `style-scope ${host}`;
    return n;
  }
  function ytAuthorType(r) {
    if (r.owner) return 'owner';
    if (r.mod) return 'moderator';
    if (r.member) return 'member';
    return '';
  }
  function ytPhoto(u, host) {
    const shadow = yt('yt-img-shadow', 'author-photo', host);
    if (u.avatar) {
      const img = new Image();
      img.id = 'img';
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => img.remove();
      img.src = u.avatar;
      shadow.append(img);
    } else {
      const letter = el('div', 'letter', (Array.from(u.name)[0] || '?').toUpperCase());
      letter.style.background = `hsl(${hue(u.name)} 55% 50%)`;
      shadow.append(letter);
    }
    return shadow;
  }
  function ytTextItem(u, fillMessage) {
    const host = 'yt-live-chat-text-message-renderer';
    const item = document.createElement(host);
    item.classList.add('chatitem', `platform-${u.platform}`);
    const type = ytAuthorType(u.roles || {});
    if (type) item.setAttribute('author-type', type);
    const content = yt('div', 'content', host);
    content.append(yt('span', 'timestamp', host));
    const chip = document.createElement('yt-live-chat-author-chip');
    chip.className = `style-scope ${host}`;
    const name = yt('span', 'author-name', 'yt-live-chat-author-chip');
    if (type) name.classList.add(type);
    name.textContent = u.name;
    const badges = yt('span', 'chat-badges', 'yt-live-chat-author-chip');
    if (type) {
      const b = document.createElement('yt-live-chat-author-badge-renderer');
      b.className = 'style-scope yt-live-chat-author-chip';
      b.setAttribute('type', type);
      b.append(document.createElement('yt-icon'));
      badges.append(b);
    }
    chip.append(name, badges);
    const message = yt('span', 'message', host);
    fillMessage(message);
    content.append(chip, message);
    item.append(ytPhoto(u, host), content);
    return item;
  }
  function ytPaidItem(m) {
    const host = 'yt-live-chat-paid-message-renderer';
    const u = m.user;
    const item = document.createElement(host);
    item.classList.add('chatitem', `platform-${u.platform}`);
    const card = yt('div', 'card', host);
    const header = yt('div', 'header', host);
    const headerContent = yt('div', 'header-content', host);
    const primary = yt('div', 'header-content-primary-column', host);
    const single = yt('div', 'single-line', host);
    const chip = yt('div', 'author-name-chip', host);
    const name = yt('span', 'author-name', host);
    name.textContent = u.name;
    chip.append(name);
    const amountCol = yt('div', 'purchase-amount-column', host);
    const amount = yt('div', 'purchase-amount', host);
    amount.textContent = (m.paid && m.paid.amount) || '';
    amountCol.append(amount);
    single.append(chip, amountCol);
    primary.append(single);
    headerContent.append(primary);
    header.append(ytPhoto(u, host), headerContent);
    const content = yt('div', 'content', host);
    const message = yt('div', 'message', host);
    fillParts(message, m.parts);
    content.append(message);
    card.append(header, content);
    item.append(card);
    return item;
  }
  function fillParts(target, parts) {
    for (const p of parts) {
      if (p.t === 'emote') {
        const img = new Image();
        img.className = 'emoji small-emoji';
        img.alt = p.alt;
        img.referrerPolicy = 'no-referrer';
        img.onerror = () => img.replaceWith(document.createTextNode(p.alt));
        img.src = p.url;
        target.append(img);
      } else {
        target.append(document.createTextNode(p.v));
      }
    }
  }

  // Curve / Accordion / Liquid arrivals are played by motion/bridge.js with these same cards
  const motion = () => (window.achatMotion && window.achatMotion.active() ? window.achatMotion : null);
  window.achatTemplateCard = (m) => {
    const card = templateCard(m);
    card.dataset.id = m.id;
    return card;
  };

  function addChat(m) {
    if (motion()) {
      motion().push(m);
      return;
    }
    if (isCustom()) {
      const item = m.paid ? ytPaidItem(m) : ytTextItem(m.user, (msg) => fillParts(msg, m.parts));
      item.dataset.id = m.id;
      pushCard(item);
      return;
    }
    const card = templateCard(m);
    card.dataset.id = m.id;
    pushCard(card);
  }

  function templateCard(m) {
    const { card, top, body } = makeCard(m.user);
    if (m.paid) {
      card.classList.add('paid');
      if (m.paid.amount) top.append(el('span', 'amount', m.paid.amount));
    }
    const msg = el('div', 'msg');
    for (const p of m.parts) {
      if (p.t === 'emote') {
        const img = new Image();
        img.alt = p.alt;
        img.referrerPolicy = 'no-referrer';
        img.onerror = () => img.replaceWith(document.createTextNode(p.alt));
        img.src = p.url;
        msg.append(img);
      } else {
        msg.append(document.createTextNode(p.v));
      }
    }
    body.append(msg);
    return card;
  }

  // A GIF shown inside chat: behaves like a normal message and scrolls away.
  function addChatGif(g) {
    if (isCustom()) {
      const item = ytTextItem({ name: g.name, platform: g.platform, avatar: g.avatar, roles: {} }, (msg) => {
        const img = new Image();
        img.className = 'bae-gif';
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.src = g.url;
        msg.append(img);
      });
      item.dataset.gif = g.id;
      const img = item.querySelector('img.bae-gif');
      // decode() can reject for a cached GIF that is fine; show it whenever it really loaded
      img.decode().catch(() => {}).then(() => img.naturalWidth && pushCard(item));
      return;
    }
    const { card, top, body } = makeCard({ name: g.name, platform: g.platform, avatar: g.avatar, roles: {} });
    card.dataset.gif = g.id;
    card.classList.add('gifmsg');
    const img = new Image();
    img.className = 'chatgif';
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = g.url;
    const wrap = el('div', 'chatgifwrap');
    wrap.append(img);
    const credit = { giphy: 'GIPHY', klipy: 'KLIPY' }[g.source];
    if (credit) wrap.append(el('span', 'gifmark', credit));
    body.append(wrap);
    // wait until the GIF has loaded so the card knows its real height before
    // sliding in (otherwise the stack would jump when the image appears)
    // decode() can reject for a cached GIF that is fine; show it whenever it really loaded
    img.decode().catch(() => {}).then(() => img.naturalWidth && pushCard(card));
  }

  // ---------- gif ----------
  let gifTimer = null;
  function showGif(m) {
    clearGif(true);
    const g = m.gif;
    const card = el('div', 'gifcard');
    card.dataset.gif = g.id;
    const img = new Image();
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => card.remove();
    img.src = g.url;
    const cap = el('div', 'gifcap');
    const who = el('span', 'q');
    who.append(el('b', null, g.name), document.createTextNode(`  ${g.query}`));
    cap.append(who);
    const credit = { giphy: 'Powered by GIPHY', klipy: 'Powered by KLIPY' }[g.source];
    if (credit) cap.append(el('span', 'giphy', credit));
    card.append(img, cap);
    $gif.append(card);
    gifTimer = setTimeout(() => clearGif(), m.seconds * 1000);
  }
  function clearGif(instant) {
    clearTimeout(gifTimer);
    for (const c of [...$gif.children]) {
      if (instant) c.remove();
      else {
        c.classList.add('out');
        setTimeout(() => c.remove(), 420);
      }
    }
  }
  // Remove one GIF everywhere (mod skip), in the separate spot and in chat.
  function removeGif(id) {
    for (let i = entryQueue.length - 1; i >= 0; i--) if (entryQueue[i].dataset.gif === id) entryQueue.splice(i, 1);
    for (const c of document.querySelectorAll('[data-gif]')) {
      if (c.dataset.gif !== id) continue;
      if (c.classList.contains('chatitem')) removeCard(c);
      else {
        clearTimeout(gifTimer);
        c.classList.add('out');
        setTimeout(() => c.remove(), 420);
      }
    }
  }

  // ---------- poll ----------
  // pollEl is an outer box that is positioned and scaled to fit its host; the
  // card inside it does the enter/leave animation (an animation would otherwise
  // override the scale).
  let pollEl = null;
  let lastPoll = null;
  const POLL_W = 520; // the card is designed at this width, then scaled to its box
  // "chat": pinned at the top of the chat area (works on a Chat-only source)
  // "layout": in the Poll box from the layout editor, filling it
  const pollHost = () => ((settings.poll && settings.poll.location) === 'layout' ? $poll : $chatLayer);
  // Size the poll to its Layout box, and stack whatever is pinned at the top of
  // chat (a poll, then a featured message) at the width of the chat area.
  // Client sizes are layout pixels, unaffected by the canvas scale.
  function fitPoll() {
    const setK = (box, k) => box.style.setProperty('--pk', String(Math.max(0.25, Math.min(4, k)) || 1));
    if (pollEl && pollEl.parentNode === $poll) {
      setK(pollEl, Math.min(($poll.clientWidth - 20) / POLL_W, ($poll.clientHeight - 20) / (pollEl.offsetHeight || 1)));
    }
    let top = 12;
    const W = $chatLayer.clientWidth - 24;
    const H = $chatLayer.clientHeight;
    for (const box of [pollEl, featEl]) {
      if (!box || box.parentNode !== $chatLayer) continue;
      const natH = box.offsetHeight || 1;
      // the poll scales to the chat width; a featured message is a chat message,
      // so it only follows the Chat size setting like the rest of chat
      const k = box === featEl ? zoom : Math.max(0.25, Math.min(4, W / POLL_W, (H * 0.6) / natH));
      if (box !== featEl) setK(box, k);
      box.style.top = `${top}px`;
      top += natH * k + 12;
    }
    // chat starts below whatever is pinned, so nothing overlaps
    const pinned = `${top > 12 ? top : 0}px`;
    if ($chatLayer.style.getPropertyValue('--pinned') !== pinned) {
      $chatLayer.style.setProperty('--pinned', pinned);
      applyFade();
    }
  }
  new ResizeObserver(fitPoll).observe($poll);
  new ResizeObserver(fitPoll).observe($chatLayer);
  if (document.fonts) document.fonts.ready.then(fitPoll);
  function renderPoll(p) {
    lastPoll = p;
    if (!p || p.cleared || (!p.active && !p.ended)) {
      if (pollEl) {
        const old = pollEl;
        pollEl = null;
        old.firstChild.classList.add('out');
        setTimeout(() => {
          old.remove();
          fitPoll(); // a featured message below moves up
        }, 450);
      }
      return;
    }
    const fresh = !pollEl || pollEl.dataset.q !== p.question;
    if (fresh) {
      if (pollEl) pollEl.remove();
      pollEl = el('div', 'pollbox');
      if (pollHost() === $chatLayer) pollEl.classList.add('pinned');
      pollEl.dataset.q = p.question;
      const card = el('div', 'pollcard');
      pollEl.append(card);
      const tag = el('div', 'ptag');
      tag.append(achatLogo(), el('span', 'ptagtext', 'Live poll'));
      card.append(tag, el('div', 'pq', p.question));
      const list = el('ol', 'popts');
      p.options.forEach((label, i) => {
        const li = el('li', 'popt');
        const row = el('div', 'prow');
        const cmd = (p.commands && p.commands[i]) || `!vote${i + 1}`;
        row.append(el('span', 'pnum', cmd), el('span', 'plabel', label), el('span', 'ppct', '0%'));
        const bar = el('div', 'pbar');
        bar.append(el('i'));
        li.append(row, bar);
        list.append(li);
      });
      const foot = el('div', 'pfoot');
      foot.append(el('span', 'phint', 'Type a command to vote'), el('span', 'ptotal', '0 votes'));
      const timer = el('div', 'ptimer');
      const drain = el('i');
      timer.append(drain);
      card.append(list, foot, timer);
      pollHost().append(pollEl);
      const left = Math.max(0, p.endsAt - Date.now());
      drain.style.animationDuration = `${left}ms`;
      fitPoll();
    }
    const items = pollEl.querySelectorAll('.popt');
    if (p.commands) items.forEach((li, i) => (li.querySelector('.pnum').textContent = p.commands[i] || li.querySelector('.pnum').textContent));
    p.counts.forEach((n, i) => {
      const pct = p.total ? Math.round((n / p.total) * 100) : 0;
      items[i].querySelector('.pbar i').style.width = `${pct}%`;
      items[i].querySelector('.ppct').textContent = `${pct}%`;
      items[i].classList.toggle('win', p.ended && p.winner === i);
      items[i].classList.toggle('lose', p.ended && p.winner >= 0 && p.winner !== i);
    });
    pollEl.querySelector('.ptotal').textContent = `${p.total} ${p.total === 1 ? 'vote' : 'votes'}`;
    if (p.ended) {
      pollEl.firstChild.classList.add('ended');
      pollEl.querySelector('.ptagtext').textContent = 'Results';
      pollEl.querySelector('.phint').textContent =
        p.total === 0 ? 'No votes this time' : p.winner === -2 ? "It's a tie!" : 'Poll closed';
      fitPoll();
    }
  }

  function achatLogo() {
    const img = new Image();
    img.className = 'plogo';
    img.alt = '';
    img.src = '/static/achat-logo-64.png';
    return img;
  }

  // ---------- featured message (from the dock's Live tab) ----------
  // Pinned at the top of the chat area (under a pinned poll), drawn exactly like
  // a chat message: your Custom CSS or template styles it. Style it on its own
  // with  .bae-featured  or  [featured].
  let featEl = null;
  let lastFeature = null;
  // "layout": in its own Featured box (Everything source only); otherwise pinned at the top of chat
  const featHost = () => ((settings.featured && settings.featured.location) === 'layout' && layer === 'all' ? $featured : $chatLayer);
  // in the Featured box: centered and scaled to fit the box
  function fitFeatured() {
    if (!featEl || featEl.parentNode !== $featured) return;
    featEl.style.setProperty('--fk', '1');
    const k = Math.min(($featured.clientWidth - 16) / (featEl.offsetWidth || 1), ($featured.clientHeight - 16) / (featEl.offsetHeight || 1));
    featEl.style.setProperty('--fk', String(Math.max(0.2, Math.min(3, k)) || 1));
  }
  new ResizeObserver(fitFeatured).observe($featured);
  function renderFeature(m) {
    lastFeature = m;
    if (featEl) {
      const old = featEl;
      featEl = null;
      old.classList.add('out');
      setTimeout(() => {
        old.remove();
        fitPoll();
      }, 400);
    }
    if (!m) return;
    const custom = isCustom();
    const item = custom
      ? m.paid ? ytPaidItem(m) : ytTextItem(m.user, (msg) => fillParts(msg, m.parts))
      : templateCard(m);
    item.setAttribute('featured', '');
    // Custom CSS: wrap it like YouTube's chat so rules such as  yt-live-chat-renderer *  apply too
    featEl = custom ? document.createElement('yt-live-chat-renderer') : el('div');
    featEl.className = 'bae-featured';
    featEl.append(item);
    featHost().append(featEl);
    fitPoll();
    fitFeatured();
  }

  // Edge fade on the chat. Each fade is at most 35% of the chat's visible
  // height, which shrinks while a poll or featured message is pinned on top.
  function applyFade() {
    const c = settings.chat;
    const pinned = parseFloat($chatLayer.style.getPropertyValue('--pinned')) || 0;
    // with Custom CSS on the Chat only link, chat fills the whole page instead of the Layout box
    const boxH = ((layer === 'all' && settings.layout ? settings.layout.chat.h : window.innerHeight) - pinned) / zoom;
    const top = Math.min(c.fadeTop || 0, Math.round(boxH * 0.35));

    const bottom = Math.min(c.fadeBottom || 0, Math.round(boxH * 0.35));
    const min = 1 - (c.fadeStrength ?? 100) / 100;
    // a real fade: chat stays at the bottom and its lower edge (including the
    // newest message) melts away, the mirror of the top fade
    $chat.style.removeProperty('padding-bottom');
    if (top > 0 || bottom > 0) {
      const steps = 12;
      const stops = [];
      const a = (t) => (min + (1 - min) * t * t * (3 - 2 * t)).toFixed(3);
      for (let i = 0; i <= steps; i++) stops.push(`rgba(0,0,0,${a(i / steps)}) ${((top * i) / steps).toFixed(1)}px`);
      for (let i = steps; i >= 0; i--) stops.push(`rgba(0,0,0,${a(i / steps)}) calc(100% - ${((bottom * i) / steps).toFixed(1)}px)`);
      const mask = `linear-gradient(to bottom, ${stops.join(', ')})`;
      $chatMask.style.webkitMaskImage = mask;
      $chatMask.style.maskImage = mask;
    } else {
      $chatMask.style.webkitMaskImage = '';
      $chatMask.style.maskImage = '';
    }
  }

  // ---------- clock ----------
  // Your PC's time. The clock is always drawn by a "Clock only" page: the
  // Everything overlay shows one in a small frame in the Clock box, so the
  // clock can use a different template than chat (templates style the whole
  // page). Looks: a template card (the chat's, or one picked just for the
  // clock) or simple text ("plain", "outline").
  const CLOCK_TEMPLATES = ['clean', 'dark', 'cloud', 'kitty', 'bunny', 'matcha', 'starlight'];
  function clockLook(s) {
    const st = (s.clock && s.clock.style) || 'plain';
    if (st === 'theme') return s.chat.theme === 'custom' ? { simple: 'plain' } : { theme: s.chat.theme };
    if (CLOCK_TEMPLATES.includes(st)) return { theme: st };
    return { simple: st === 'outline' ? 'outline' : 'plain' };
  }
  let clockFrame = null;
  function placeClockFrame(on) {
    if (!on) {
      if (clockFrame) clockFrame.remove();
      clockFrame = null;
      return;
    }
    if (clockFrame) return;
    clockFrame = document.createElement('iframe');
    clockFrame.className = 'clockframe';
    clockFrame.title = 'Clock';
    clockFrame.tabIndex = -1;
    clockFrame.src = '/overlay?layer=clock&embed=1';
    $clock.append(clockFrame);
  }
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const pad2 = (n) => String(n).padStart(2, '0');
  let clockEl = null;
  let clockKey = '';
  function clockText() {
    const c = settings.clock || {};
    const n = new Date();
    let h = n.getHours();
    let suffix = '';
    if (c.hour12) {
      suffix = h < 12 ? ' AM' : ' PM';
      h = h % 12 || 12;
    }
    const time = (c.hour12 ? String(h) : pad2(h)) + ':' + pad2(n.getMinutes()) + (c.seconds !== false ? ':' + pad2(n.getSeconds()) : '') + suffix;
    const day = DAYS[n.getDay()];
    const month = MONTHS[n.getMonth()];
    const date =
      c.dateFormat === 'short' ? `${day.slice(0, 3)} ${n.getDate()} ${month.slice(0, 3)}` :
      c.dateFormat === 'numeric' ? `${pad2(n.getDate())}/${pad2(n.getMonth() + 1)}/${n.getFullYear()}` :
      `${day}, ${pad2(n.getDate())} ${month} ${n.getFullYear()}`;
    return { time, date };
  }
  function buildClock() {
    const c = settings.clock || {};
    const look = clockLook(settings);
    const themed = !!look.theme;
    const key = [c.enabled, look.theme || look.simple, c.date !== false].join('|');
    if (!c.enabled || layer !== 'clock') {
      if (clockEl) clockEl.remove();
      clockEl = null;
      clockKey = key;
      return;
    }
    if (clockEl && key === clockKey) return;
    clockKey = key;
    if (clockEl) clockEl.remove();
    clockEl = el('div', `clockbox ${themed ? 'themed' : look.simple}`);
    if (themed) {
      const card = el('div', 'card clockcard');
      const body = el('div', 'body');
      const top = el('div', 'top');
      top.append(el('span', 'name ck-date'));
      if (c.date === false) top.classList.add('nodate');
      body.append(top, el('div', 'msg ck-time'));
      card.append(body);
      clockEl.append(card);
    } else {
      clockEl.append(el('div', 'ck-time'));
      if (c.date !== false) clockEl.append(el('div', 'ck-date'));
    }
    $clock.append(clockEl);
    tickClock();
  }
  let clockSize = '';
  function tickClock() {
    if (!clockEl) return;
    const { time, date } = clockText();
    clockEl.querySelector('.ck-time').textContent = time;
    const d = clockEl.querySelector('.ck-date');
    if (d) d.textContent = date;
    // refit only when the text length changes (new day, 12/24h switch), not every second
    const size = `${time.length}|${date.length}`;
    if (size !== clockSize) {
      clockSize = size;
      fitClock();
    }
  }
  function fitClock() {
    if (!clockEl) return;
    clockEl.style.setProperty('--ck', '1');
    // window templates put the date in a title bar pinned to the card's edges:
    // widen the card so the whole date fits between the mascot and the dots
    const card = clockEl.querySelector('.clockcard');
    if (card) {
      card.style.minWidth = '';
      if (getComputedStyle(card.querySelector('.top')).position === 'absolute') {
        card.style.minWidth = `${card.querySelector('.ck-date').scrollWidth + 130}px`;
      }
    }
    const W = $clock.clientWidth - 16;
    const H = $clock.clientHeight - 16;
    const k = Math.min(W / (clockEl.offsetWidth || 1), H / (clockEl.offsetHeight || 1));
    clockEl.style.setProperty('--ck', String(Math.max(0.1, Math.min(6, k)) || 1));
  }
  new ResizeObserver(fitClock).observe($clock);
  if (document.fonts) document.fonts.ready.then(fitClock);
  setInterval(tickClock, 1000);

  // ---------- settings ----------
  function applySettings(s) {
    if (s.chat.theme === 'custom') {
      // Custom CSS decides the look; only the edge fade and chat size still apply
      s.chat = {
        ...s.chat,
        align: 'left',
        showLogo: false, // no platform logos with Custom CSS
        showDot: false,
        maxMessages: 40,
        hideAfter: 0,
      };
    }
    settings = s;
    placeChatLayer();
    const toMotion = () => {
      // switching to Curve, Accordion or Liquid: the classic cards make room
      if (window.achatMotion.apply(s)) {
        entryQueue.length = 0;
        $chat.textContent = '';
      }
    };
    if (window.achatMotion) toMotion();
    else (window.__achatMotionWait ||= []).push(toMotion);
    // a "Clock only" page (and the clock frame) wears the clock's own template
    const clockTheme = layer === 'clock' ? clockLook(s).theme : null;
    document.body.dataset.theme = clockTheme || s.chat.theme;
    document.body.dataset.align = s.chat.align;
    document.body.dataset.ui = (s.ui && s.ui.dockTheme) === 'dark' ? 'dark' : 'light'; // poll follows the dock look
    document.documentElement.style.setProperty('--fs', `${s.chat.fontSize}px`);
    const c = s.chat;
    const root = document.documentElement.style;
    root.setProperty('--colw', `${c.columnWidth || 420}px`);
    root.setProperty('--cardmax', `${c.cardMaxWidth || 380}px`);
    root.setProperty('--bgpct', `${c.bgOpacity ?? 100}%`);
    // GIF size inside chat. Also set on the stack itself: it is animated, and
    // Chrome can keep an animated element's old inherited values.
    const chatGif = `${(s.gif && s.gif.chatSize) || 150}px`;
    root.setProperty('--chatgif', chatGif);
    $chat.style.setProperty('--chatgif', chatGif);
    document.body.dataset.dot = c.showDot ? '1' : '0';

    // edge fade: an eased (smoothstep) curve with many stops instead of a
    // straight line, so messages melt away without a visible edge
    // chat size (zoom)
    zoom = Math.min(2, Math.max(0.3, (c.zoom || 100) / 100));
    root.setProperty('--chatzoom', String(zoom));

    applyFade();

    // your custom CSS file: reload only when it changed
    const link = document.getElementById('usercss');
    const want = `/user.css?v=${encodeURIComponent(s.cssVersion || c.cssVersion || '')}`;
    if (layer === 'clock') link.removeAttribute('href'); // chat CSS never styles the clock
    else if (link.getAttribute('href') !== want) link.setAttribute('href', want);

    // featured location changed while one is showing: move it to the new place
    if (featEl && featEl.parentNode !== featHost()) {
      featEl.remove();
      featEl = null;
      if (lastFeature) renderFeature(lastFeature);
    }

    // poll location changed while a poll is showing: rebuild it in the new place
    if (pollEl && pollEl.parentNode !== pollHost()) {
      pollEl.remove();
      pollEl = null;
      if (lastPoll) renderPoll(lastPoll);
    }

    // clock: on/off, look, what it shows
    $clock.classList.toggle('hidden', !(s.clock && s.clock.enabled) || (layer !== 'all' && layer !== 'clock'));
    placeClockFrame(layer === 'all' && !!(s.clock && s.clock.enabled));
    buildClock();
    clockSize = '';
    tickClock();

    // layout editor positions (only for the "Everything" source)
    if (layer === 'all' && s.layout) {
      const L = s.layout;
      for (const [name, node] of [['chat', $chatLayer], ['gif', $gif], ['poll', $poll], ['clock', $clock], ['featured', $featured]]) {
        const b = L[name];
        if (!b) continue;
        if (name === 'chat' && node.classList.contains('fill')) continue; // Custom CSS: whole source
        node.style.left = `${b.x}px`;
        node.style.top = `${b.y}px`;
        node.style.width = `${b.w}px`;
        node.style.height = `${b.h}px`;
        node.classList.toggle('hidden', b.visible === false);
      }
      fitCanvas();
    }
    document.body.dataset.soft = (c.bgOpacity ?? 100) < 70 ? '1' : '0';
    // custom colors override the theme; text flips light on dark backgrounds
    // theme colors live on <body>, so overrides must go on <body> too
    const bodyStyle = document.body.style;
    for (const v of ['--card', '--card2', '--card-line', '--text', '--name']) bodyStyle.removeProperty(v);
    if (!c.useThemeColors && /^#[0-9a-f]{6}$/i.test(c.bgColor || '')) {
      bodyStyle.setProperty('--card', c.bgColor);
      bodyStyle.setProperty('--card2', c.bgColor);
      if (/^#[0-9a-f]{6}$/i.test(c.borderColor || '')) bodyStyle.setProperty('--card-line', c.borderColor);
      const n = parseInt(c.bgColor.slice(1), 16);
      const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
      if (lum < 0.5) {
        bodyStyle.setProperty('--text', '#f2f0f8');
        bodyStyle.setProperty('--name', '#a9b8ff');
      } else {
        bodyStyle.setProperty('--text', '#2c2f3a');
        bodyStyle.setProperty('--name', '#3b56c9');
      }
    }
  }

  // ---------- "did the test show up?" report ----------
  // After a message is added, check a moment later whether it is really visible
  // and tell the app, so the dock can say where a test appeared.
  let seenTimer = null;
  function reportSeen() {
    if (preview || embed || !wsRef || wsRef.readyState !== 1) return;
    clearTimeout(seenTimer);
    seenTimer = setTimeout(() => {
      const n = $chat.lastElementChild;
      let visible = false;
      if (n) {
        const r = n.getBoundingClientRect();
        const cs = getComputedStyle(n);
        visible =
          r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 &&
          r.left < window.innerWidth && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.05;
      }
      try {
        wsRef.send(JSON.stringify({ type: 'seen', visible }));
      } catch {
        // connection closing
      }
    }, 900);
  }

  // ---------- status panel (normal browser only) ----------
  const diag = { connected: false, settings: false, received: 0, last: '', errors: [] };
  window.addEventListener('error', (e) => diag.errors.push(e.message));
  window.addEventListener('unhandledrejection', (e) => diag.errors.push(String((e.reason && e.reason.message) || e.reason)));
  const inOBS = typeof window.obsstudio !== 'undefined';
  if (!inOBS && !preview && !embed) {
    const panel = el('div', null);
    panel.id = 'baeStatus';
    const head = el('div', 'bs-head');
    head.append(el('b', null, 'achat overlay status'));
    const x = el('button', null, 'Hide');
    x.addEventListener('click', () => panel.remove());
    head.append(x);
    const body = el('div', 'bs-body');
    panel.append(head, body, el('div', 'bs-note', 'Only shown when you open this link in a normal browser. OBS never shows it.'));
    document.body.append(panel);
    const line = (label, value, bad) => {
      const r = el('div', `bs-row${bad ? ' bad' : ''}`);
      r.append(el('span', null, label), el('span', null, value));
      return r;
    };
    setInterval(() => {
      body.textContent = '';
      const c = settings.chat || {};
      const onScreen = [...$chat.children].filter((n) => !n.dataset.leaving).length + document.querySelectorAll('#motionHost .mx-actor').length;
      const newest = $chat.lastElementChild;
      let newestInfo = 'none yet';
      if (newest) {
        const r = newest.getBoundingClientRect();
        const op = getComputedStyle(newest).opacity;
        const inView = r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth && r.width > 0 && r.height > 0;
        newestInfo = `${inView ? 'inside the page' : 'OUTSIDE the page'}, ${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.left)},${Math.round(r.top)}, opacity ${op}`;
      }
      const box = settings.layout && settings.layout.chat;
      body.append(
        line('Version', VERSION),
        line('Connected to the app', diag.connected ? 'yes' : 'NO, retrying', !diag.connected),
        line('Settings received', diag.settings ? 'yes' : 'NO', !diag.settings),
        line('Link', layer === 'all' ? 'Everything' : `${layer} only`),
        line('Look', c.theme === 'custom' ? 'Custom CSS' : `template "${c.theme}"`),
        layer === 'all' && box
          ? line('Chat box (Layout)', `${box.w}x${box.h} at ${box.x},${box.y}${box.visible === false ? ', HIDDEN' : ''}`, box.visible === false)
          : line('Chat area', `${window.innerWidth}x${window.innerHeight}`),
        line('Page size / scale', `${window.innerWidth}x${window.innerHeight}, ${scale.toFixed(2)}x`),
        line('Edge fade top / bottom', `${c.fadeTop || 0}px / ${c.fadeBottom || 0}px at ${c.fadeStrength ?? 100}%`),
        line('Chat messages received', `${diag.received}${diag.last ? `, last from ${diag.last}` : ''}`, diag.connected && diag.received === 0),
        line('Messages on screen now', String(onScreen)),
        line('Newest message', newestInfo, newestInfo.includes('OUTSIDE') || newestInfo.endsWith('opacity 0')),
        line('Errors', diag.errors.length ? diag.errors.slice(-3).join(' | ') : 'none', diag.errors.length > 0),
      );
      let tip = '';
      if (!diag.connected) tip = 'This page cannot reach the achat app. Is its window open?';
      else if (diag.received === 0) tip = 'Connected, but no chat has arrived yet. Press Test in the dock, or check Connect.';
      else if (onScreen === 0) tip = 'Messages arrived but none are on screen. Check "Hide messages after" in Style.';
      else tip = 'Messages are on the page. If you still can\'t see them, your Custom CSS or colors may be hiding them.';
      body.append(el('div', 'bs-tip', tip));
    }, 1000);
  }

  // ---------- connection ----------
  function handle(m) {
    switch (m.type) {
      case 'hello':
        // achat was updated since this page loaded: load the new version
        if (m.version && m.version !== VERSION && !VERSION.includes('{{')) location.reload();
        return;
      case 'ping':
        return; // heartbeat, see connect()
      case 'settings':
        diag.settings = true;
        return applySettings(m.settings);
      case 'chat':
        diag.received++;
        diag.last = m.user && m.user.name;
        addChat(m);
        reportSeen();
        return;
      case 'clear':
        if (window.achatMotion) window.achatMotion.clear(!!m.instant);
        entryQueue.length = 0;
        if (m.instant) $chat.textContent = ''; // theme changed: old-style cards must go
        else [...$chat.children].forEach(removeCard);
        return;
      case 'gif': return showGif(m);
      case 'gif:chat': return addChatGif(m.gif);
      case 'gif:remove': return removeGif(m.id);
      case 'poll': return renderPoll(m.poll);
      case 'feature': return renderFeature(m.msg);
      case 'chat:remove': {
        // hidden from the dock's Live tab
        if (window.achatMotion) window.achatMotion.remove(m.id);
        for (let i = entryQueue.length - 1; i >= 0; i--) if (entryQueue[i].dataset.id === m.id) entryQueue.splice(i, 1);
        for (const c of [...$chat.children]) if (c.dataset.id === m.id) removeCard(c);
        return;
      }
      default:
    }
  }

  let retry = 0;
  let wsRef = null;
  // achat sends something at least every 10s. Silence for longer means the
  // connection died quietly (PC sleep, hours idle): drop it and reconnect.
  let lastHeard = Date.now();
  let reconnectTimer = null;
  function connect() {
    clearTimeout(reconnectTimer);
    lastHeard = Date.now();
    const ws = new WebSocket(
      `ws://${location.host}/ws?role=overlay&layer=${layer}&v=${encodeURIComponent(VERSION)}` +
        `&sw=${window.innerWidth}&sh=${window.innerHeight}${preview ? '&preview=1' : ''}${embed ? '&embed=1' : ''}`,
    );
    wsRef = ws;
    ws.onopen = () => {
      retry = 0;
      diag.connected = true;
      lastHeard = Date.now();
    };
    ws.onmessage = (e) => {
      lastHeard = Date.now();
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      try { handle(m); } catch (err) { console.error(err); }
    };
    ws.onclose = () => {
      if (wsRef !== ws) return; // replaced by the watchdog already
      diag.connected = false;
      reconnectTimer = setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
    };
  }
  setInterval(() => {
    if (!wsRef || wsRef.readyState === 3) return; // closed: onclose already schedules a retry
    if (Date.now() - lastHeard < 25000) return;
    const dead = wsRef;
    wsRef = null;
    diag.connected = false;
    try { dead.close(); } catch { /* already gone */ }
    connect();
  }, 5000);
  connect();
})();
