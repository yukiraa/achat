import { safeGifUrl, hitsBlocklist, cleanText } from '../security.js';

// !gif <search>   GIPHY search with strict rating and filters
// !<custom>       your own uploaded GIFs/art, e.g. !x03
// Viewers only type words; they can never supply a link. GIPHY GIFs come from
// GIPHY's servers, custom ones from files you uploaded to this PC.
//
// Display mode (set in the dock):
//   separate  shown in its own spot, one at a time, from a queue
//   chat      shown as a card inside chat, scrolls away like a message
//   both      both at once

// KLIPY items carry several sizes (hd, md, sm, xs) and formats. Pick a
// medium webp/gif so it looks sharp without being heavy.
function pickKlipyUrl(g) {
  const files = g.file || g.files || {};
  for (const size of ['md', 'hd', 'sm']) {
    for (const fmt of ['webp', 'gif']) {
      const u = files[size]?.[fmt]?.url;
      if (u) return u;
    }
  }
  return files.gif?.url || files.webp?.url || null;
}

export class GifFeature {
  constructor(getCfg, broadcast, log) {
    this.getCfg = getCfg;
    this.broadcast = broadcast;
    this.log = log;
    this.queue = [];
    this.current = null;
    this.recent = []; // ids of recently shown GIFs, newest last, for Skip
    this.counter = 0;
    this.lastGlobal = 0;
    this.userLast = new Map();
    this.cache = new Map();
    this.budget = { hour: this.hourNow(), used: 0 };
  }

  hourNow() {
    return Math.floor(Date.now() / 3600000);
  }

  state() {
    return {
      current: this.current && { name: this.current.name, query: this.current.query },
      queued: this.queue.length,
      budgetUsed: this.budget.used,
      last: this.recent.length ? this.recent[this.recent.length - 1].label : null,
    };
  }

  // Shared cooldown check for !gif and custom commands.
  checkCooldown(user) {
    const cfg = this.getCfg().gif;
    const now = Date.now();
    const userWait = cfg.userCooldown * 1000 - (now - (this.userLast.get(user.key) || 0));
    if (userWait > 0) {
      this.log(`GIF: ${user.name} on cooldown (${Math.ceil(userWait / 1000)}s)`);
      return false;
    }
    const globalWait = cfg.globalCooldown * 1000 - (now - this.lastGlobal);
    if (globalWait > 0) {
      this.log(`GIF: global cooldown (${Math.ceil(globalWait / 1000)}s)`);
      return false;
    }
    return true;
  }

  queueFull() {
    const cfg = this.getCfg().gif;
    if (cfg.location === 'chat') return false;
    if (this.queue.length >= cfg.maxQueue) {
      this.log('GIF: queue full');
      return true;
    }
    return false;
  }

  async request(user, rawQuery, { bypassCooldown = false } = {}) {
    const cfg = this.getCfg().gif;
    if (!cfg.enabled) return this.log('GIF: GIFs are switched off, so nothing was shown');
    const query = cleanText(rawQuery, 60).toLowerCase();
    if (query.length < 2) return this.log(`GIF: search from ${user.name} too short`);
    const key = cfg.provider === 'klipy' ? cfg.klipyKey : cfg.giphyKey;
    const providerName = cfg.provider === 'klipy' ? 'KLIPY' : 'GIPHY';
    if (!key) return this.log(`GIF: no ${providerName} key saved yet, paste one in the GIFs tab`);
    if (hitsBlocklist(query, cfg.blockedWords)) {
      return this.log(`GIF blocked (word filter): ${user.name} searched "${query}"`);
    }
    if (!bypassCooldown && !this.checkCooldown(user)) return;
    if (this.queueFull()) return;

    const url = await this.search(query, cfg);
    if (!url) return;
    this.markUsed(user);
    this.deliver({ url, name: user.name, platform: user.platform, avatar: user.avatar, query, source: cfg.provider });
  }

  // Custom command, e.g. !x03. `entry` comes from your saved config, never from chat.
  custom(user, entry, { bypassCooldown = false } = {}) {
    const cfg = this.getCfg();
    if (!cfg.gif.enabled) return this.log('GIF: GIFs are switched off, so nothing was shown');
    if (!cfg.custom.enabled) return this.log('GIF: your own GIF commands are switched off in Custom GIFs');
    if (!bypassCooldown && !this.checkCooldown(user)) return;
    if (this.queueFull()) return;
    this.markUsed(user);
    this.deliver({
      url: `/custom/${entry.file}`,
      name: user.name,
      platform: user.platform,
      avatar: user.avatar,
      query: `!${entry.cmd}`,
      source: 'custom',
    });
  }

  // Built-in test GIF: works without any provider key and skips cooldowns.
  sample(user) {
    if (!this.getCfg().gif.enabled) return this.log('GIF: GIFs are switched off, so nothing was shown');
    if (this.queueFull()) return;
    this.deliver({
      url: '/samples/test.gif',
      name: user.name,
      platform: user.platform,
      avatar: user.avatar,
      query: 'test GIF',
      source: 'custom',
    });
  }

  markUsed(user) {
    const now = Date.now();
    this.lastGlobal = now;
    this.userLast.set(user.key, now);
    if (this.userLast.size > 5000) this.userLast.clear();
  }

  deliver(item) {
    const cfg = this.getCfg().gif;
    item.id = `g${++this.counter}`;
    this.recent.push({ id: item.id, label: `${item.name} ${item.query}` });
    if (this.recent.length > 20) this.recent.shift();
    this.log(`GIF: ${item.name} ${item.source !== 'custom' ? '"' + item.query + '"' : item.query}`);

    // one place only: inside chat, or the GIF box from Layout
    if (cfg.location === 'chat') {
      this.broadcast({ type: 'gif:chat', gif: item });
      this.broadcast({ type: 'gif:state' });
    } else {
      this.queue.push(item);
      this.pump();
    }
  }

  async search(query, cfg) {
    const cacheKey = `${cfg.provider}:${cfg.rating}:${query}`;
    const hit = this.cache.get(cacheKey);
    let items = hit && Date.now() - hit.t < 3600000 ? hit.items : null;

    if (!items) {
      if (this.budget.hour !== this.hourNow()) this.budget = { hour: this.hourNow(), used: 0 };
      // hourlyBudget 0 means no limit (for unlimited production keys)
      if (cfg.hourlyBudget > 0 && this.budget.used >= cfg.hourlyBudget) {
        this.log('GIF: hourly search limit reached, try again next hour');
        return null;
      }
      this.budget.used++;
      try {
        const raw = cfg.provider === 'klipy' ? await this.fetchKlipy(query, cfg) : await this.fetchGiphy(query, cfg);
        if (!raw) return null;
        items = raw
          .filter((g) => !hitsBlocklist(`${g.title || ''} ${g.slug || ''}`, cfg.blockedWords))
          .map((g) => safeGifUrl(g.url))
          .filter(Boolean);
        this.cache.set(cacheKey, { t: Date.now(), items });
        if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value);
      } catch (err) {
        this.log(`GIF: could not reach ${cfg.provider === 'klipy' ? 'KLIPY' : 'GIPHY'} (${err.message}). Check your internet or firewall`);
        return null;
      }
    }
    if (!items.length) {
      this.log(`GIF: nothing safe found for "${query}"`);
      return null;
    }
    return items[Math.floor(Math.random() * items.length)];
  }

  // Both fetchers return [{ url, title, slug }] or null after logging the problem.
  async fetchGiphy(query, cfg) {
    const params = new URLSearchParams({
      api_key: cfg.giphyKey,
      q: query,
      limit: '15',
      rating: cfg.rating,
      lang: 'en',
      bundle: 'messaging_non_clips',
    });
    const res = await fetch(`https://api.giphy.com/v1/gifs/search?${params}`, { signal: AbortSignal.timeout(5000) });
    if (res.status === 429) return this.log('GIF: GIPHY rate limit reached'), null;
    if (res.status === 401 || res.status === 403) {
      return this.log('GIF: GIPHY rejected the key. Copy the API key (not the SDK key) from developers.giphy.com'), null;
    }
    if (!res.ok) return this.log(`GIF: GIPHY error ${res.status}`), null;
    const data = await res.json();
    const allowed = cfg.rating === 'g' ? ['g', 'y'] : ['g', 'y', 'pg'];
    return (data.data || [])
      .filter((g) => allowed.includes(String(g.rating).toLowerCase()))
      .map((g) => ({ url: g.images?.fixed_height?.webp || g.images?.fixed_height?.url, title: g.title, slug: g.slug }));
  }

  async fetchKlipy(query, cfg) {
    const params = new URLSearchParams({
      q: query,
      per_page: '24',
      page: '1',
      rating: cfg.rating,
      locale: 'en_US',
      customer_id: this.getCfg().installId || 'achat',
    });
    const url = `https://api.klipy.com/api/v1/${encodeURIComponent(cfg.klipyKey)}/gifs/search?${params}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.status === 429) return this.log('GIF: KLIPY rate limit reached (test keys allow 100 searches an hour)'), null;
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return this.log('GIF: KLIPY rejected the key. Copy it from the API Keys page at partner.klipy.com'), null;
    }
    if (!res.ok) return this.log(`GIF: KLIPY error ${res.status}`), null;
    const body = await res.json();
    const list = Array.isArray(body?.data?.data) ? body.data.data : Array.isArray(body?.data) ? body.data : [];
    return list
      .filter((g) => g && g.type !== 'ad') // never show ad slots on stream
      .map((g) => ({ url: pickKlipyUrl(g), title: g.title, slug: g.slug }));
  }

  pump() {
    if (this.current || !this.queue.length) {
      this.broadcast({ type: 'gif:state' });
      return;
    }
    this.current = this.queue.shift();
    const secs = this.getCfg().gif.displaySeconds;
    this.broadcast({ type: 'gif', gif: this.current, seconds: secs });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.finish(), secs * 1000 + 700);
  }

  finish() {
    this.current = null;
    this.pump();
  }

  // Removes the GIF on screen (or the newest one in chat) from everywhere.
  skip() {
    const id = this.current?.id || this.recent[this.recent.length - 1]?.id;
    if (!id) return;
    this.log(`GIF removed: ${this.recent.find((r) => r.id === id)?.label || id}`);
    this.recent = this.recent.filter((r) => r.id !== id);
    this.queue = this.queue.filter((q) => q.id !== id);
    this.broadcast({ type: 'gif:remove', id });
    if (this.current?.id === id) {
      clearTimeout(this.timer);
      this.current = null;
      setTimeout(() => this.pump(), 400);
    } else {
      this.broadcast({ type: 'gif:state' });
    }
  }

  clearQueue() {
    for (const q of this.queue) this.broadcast({ type: 'gif:remove', id: q.id });
    this.queue = [];
    this.skip();
  }
}
