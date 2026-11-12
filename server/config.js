import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = path.resolve('data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const DEFAULTS = {
  port: 7788,
  dockToken: '',
  installId: '',
  connections: {
    // useApi: read chat through the official YouTube Data API v3 with your own key
    youtube: { enabled: false, target: '', useApi: false, apiKey: '', apiInterval: 8 },
    twitch: { enabled: false, channel: '' },
    tiktok: { enabled: false, username: '', signKey: '' },
  },
  ui: {
    dockTheme: 'light',
    blurPrivate: true, // blur the overlay links in the dock until you press Show
  },
  chat: {
    theme: 'clean',
    lookMode: 'template',
    fontSize: 16,
    maxMessages: 8,
    hideAfter: 0,
    align: 'left',
    columnWidth: 420,
    cardMaxWidth: 380,
    platformBadge: 'dot',
    showLogo: true,
    showDot: false,
    logoPos: 'avatar',
    fadeTop: 0,
    fadeBottom: 0,
    fadeStrength: 100,
    animMode: 'slideUp',
    customCss: '',
    logos: { youtube: '', twitch: '', tiktok: '' },
    useThemeColors: true,
    bgColor: '#ffffff',
    bgOpacity: 100,
    borderColor: '#dfe4f2',
    enterFrom: 'bottom',
    animMs: 500,
    stagger: 120,
    busyHold: 450,
    zoom: 100,
    scaleWithBox: true, // resizing the Chat box in Layout also changes Chat size
    cssLogo: true,
    cssLogoPos: 'after',
    hideCommands: true,
    ignoredUsers: ['nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot', 'wizebot'],
  },
  gif: {
    enabled: true,
    provider: 'klipy',
    klipyKey: '',
    giphyKey: '',
    rating: 'g',
    globalCooldown: 20,
    userCooldown: 60,
    displaySeconds: 8,
    maxQueue: 4,
    hourlyBudget: 90,
    mode: 'separate',
    location: 'chat',
    position: 'tr',
    size: 320,
    chatSize: 150,
    blockedWords: [
      'nsfw', 'porn', 'sex', 'nude', 'naked', 'boob', 'hentai', 'xxx', 'gore',
      'suicide', 'selfharm', 'nazi', 'hitler', 'rape', 'dick', 'penis', 'vagina',
      'fetish', 'lewd', 'onlyfans', 'thong', 'bdsm', 'twerk', 'kkk', 'isis',
    ],
  },
  poll: {
    enabled: true,
    location: 'chat',
    commands: ['!vote1', '!vote2', '!vote3', '!vote4', '!vote5', '!vote6'],
    defaultSeconds: 60,
    resultSeconds: 8,
  },

  // a chat message featured from the Live tab stays pinned this long (0 = until you take it off)
  featured: {
    seconds: 20,
    location: 'chat', // 'chat': pinned at the top of chat · 'layout': its own box from Layout
  },

  // on-stream clock (PC time); lives in the Clock box from Layout
  clock: {
    enabled: false,
    // 'theme' follows the chat template; a template key (clean, dark, kitty...)
    // uses that template just for the clock; 'plain' / 'outline' are simple text
    style: 'plain',
    dateFormat: 'long', // long: Tuesday, 29 September 2026 · short: Tue 29 Sep · numeric: 29/09/2026
    seconds: true,
    date: true,
    hour12: false,
  },

  custom: {
    enabled: true,
    commands: [],
  },
  css: {
    presets: [],
    active: '',
  },
  layout: {
    canvasW: 1920,
    canvasH: 1080,
    grid: 20,
    snap: true,
    chat: { x: 20, y: 260, w: 640, h: 800, locked: false, visible: true },
    gif: { x: 1340, y: 40, w: 560, h: 420, locked: false, visible: true },
    poll: { x: 560, y: 300, w: 800, h: 480, locked: false, visible: true },
    clock: { x: 1500, y: 40, w: 380, h: 150, locked: false, visible: true },
    featured: { x: 660, y: 40, w: 600, h: 200, locked: false, visible: true },
  },
  bannedUsers: [],
};

export const POSITIONS = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];
// chat templates ("clean" is Default). Removed ones fall back to Default on load.
export const THEMES = ['clean', 'dark', 'cloud', 'bunny', 'matcha', 'starlight', 'kitty'];

// Every editable setting, with its type and allowed range.
// Anything not listed here is rejected, so the dock can never write arbitrary data.
const SCHEMA = {
  'connections.youtube.enabled': { type: 'bool' },
  'connections.youtube.target': { type: 'str', max: 200 },
  'connections.youtube.useApi': { type: 'bool' },
  'connections.youtube.apiKey': { type: 'secret', max: 100, pattern: /^[A-Za-z0-9_-]*$/ },
  'connections.youtube.apiInterval': { type: 'int', min: 3, max: 60 },
  'connections.twitch.enabled': { type: 'bool' },
  'connections.twitch.channel': { type: 'str', max: 40, pattern: /^[a-zA-Z0-9_]*$/ },
  'connections.tiktok.enabled': { type: 'bool' },
  'connections.tiktok.username': { type: 'str', max: 40, pattern: /^@?[a-zA-Z0-9_.]*$/ },
  'connections.tiktok.signKey': { type: 'secret', max: 200 },
  'chat.theme': { type: 'enum', values: THEMES },
  'chat.lookMode': { type: 'enum', values: ['template', 'custom'] },
  'ui.dockTheme': { type: 'enum', values: ['light', 'dark'] },
  'ui.blurPrivate': { type: 'bool' },
  'gif.location': { type: 'enum', values: ['chat', 'layout'] },
  'poll.location': { type: 'enum', values: ['chat', 'layout'] },
  'chat.fontSize': { type: 'int', min: 11, max: 32 },
  'chat.maxMessages': { type: 'int', min: 1, max: 30 },
  'chat.hideAfter': { type: 'int', min: 0, max: 600 },
  'chat.align': { type: 'enum', values: ['left', 'right'] },
  'chat.columnWidth': { type: 'int', min: 200, max: 1600 },
  'chat.cardMaxWidth': { type: 'int', min: 150, max: 1600 },
  'chat.platformBadge': { type: 'enum', values: ['dot', 'logo', 'none'] },
  'chat.showLogo': { type: 'bool' },
  'chat.showDot': { type: 'bool' },
  'chat.useThemeColors': { type: 'bool' },
  'chat.bgColor': { type: 'color' },
  'chat.bgOpacity': { type: 'int', min: 0, max: 100 },
  'chat.borderColor': { type: 'color' },
  'chat.logoPos': { type: 'enum', values: ['avatar', 'card'] },
  'chat.fadeTop': { type: 'int', min: 0, max: 400 },
  'chat.fadeBottom': { type: 'int', min: 0, max: 400 },
  'chat.fadeStrength': { type: 'int', min: 0, max: 100 },
  'chat.animMode': { type: 'enum', values: ['slideUp', 'bubble', 'fadeSlide', 'cloud', 'pop', 'slideLeft', 'slideRight', 'curve', 'accordion', 'liquid'] },
  'layout.canvasW': { type: 'int', min: 320, max: 3840 },
  'layout.canvasH': { type: 'int', min: 320, max: 3840 },
  'layout.grid': { type: 'int', min: 5, max: 200 },
  'layout.snap': { type: 'bool' },
  'layout.chat': { type: 'box' },
  'layout.gif': { type: 'box' },
  'layout.poll': { type: 'box' },
  'layout.clock': { type: 'box' },
  'layout.featured': { type: 'box' },
  'featured.location': { type: 'enum', values: ['chat', 'layout'] },
  'featured.seconds': { type: 'int', min: 0, max: 600 },
  'clock.enabled': { type: 'bool' },
  'clock.style': { type: 'enum', values: ['theme', 'clean', 'dark', 'cloud', 'kitty', 'bunny', 'matcha', 'starlight', 'plain', 'outline'] },
  'clock.dateFormat': { type: 'enum', values: ['long', 'short', 'numeric'] },
  'clock.seconds': { type: 'bool' },
  'clock.date': { type: 'bool' },
  'clock.hour12': { type: 'bool' },
  'chat.enterFrom': { type: 'enum', values: ['bottom', 'left', 'right'] },
  'chat.animMs': { type: 'int', min: 150, max: 1500 },
  'chat.stagger': { type: 'int', min: 0, max: 1000 },
  'chat.hideCommands': { type: 'bool' },
  'chat.ignoredUsers': { type: 'list', max: 100, itemMax: 40 },
  'gif.enabled': { type: 'bool' },
  'gif.giphyKey': { type: 'secret', max: 100 },
  'gif.provider': { type: 'enum', values: ['klipy', 'giphy'] },
  'gif.klipyKey': { type: 'secret', max: 200 },
  'gif.rating': { type: 'enum', values: ['g', 'pg'] },
  'gif.globalCooldown': { type: 'int', min: 5, max: 600 },
  'gif.userCooldown': { type: 'int', min: 5, max: 3600 },
  'gif.displaySeconds': { type: 'int', min: 3, max: 30 },
  'gif.maxQueue': { type: 'int', min: 1, max: 10 },
  'gif.hourlyBudget': { type: 'int', min: 0, max: 5000 },
  'gif.blockedWords': { type: 'list', max: 500, itemMax: 40 },
  'gif.mode': { type: 'enum', values: ['separate', 'chat', 'both'] },
  'gif.position': { type: 'enum', values: ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'] },
  'gif.size': { type: 'int', min: 120, max: 700 },
  'gif.chatSize': { type: 'int', min: 60, max: 600 },
  'custom.enabled': { type: 'bool' },
  'poll.enabled': { type: 'bool' },
  'poll.defaultSeconds': { type: 'int', min: 10, max: 600 },
  'poll.resultSeconds': { type: 'int', min: 3, max: 60 },
  'chat.busyHold': { type: 'int', min: 0, max: 2000 },
  'chat.zoom': { type: 'int', min: 30, max: 200 },
  'chat.scaleWithBox': { type: 'bool' },
  'chat.cssLogo': { type: 'bool' },
  'chat.cssLogoPos': { type: 'enum', values: ['before', 'after'] },
  'bannedUsers': { type: 'list', max: 1000, itemMax: 60 },
};

function merge(base, extra) {
  const out = structuredClone(base);
  if (!extra || typeof extra !== 'object') return out;
  for (const key of Object.keys(base)) {
    if (!(key in extra)) continue;
    const b = base[key];
    const e = extra[key];
    if (b && typeof b === 'object' && !Array.isArray(b)) out[key] = merge(b, e);
    else if (typeof e === typeof b || (Array.isArray(b) && Array.isArray(e))) out[key] = e;
  }
  return out;
}

export function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    // first run or unreadable file: start from defaults
  }
  const cfg = merge(DEFAULTS, saved);
  // the old default chat box was too narrow for most chat CSS; widen it if untouched
  const oc = cfg.layout.chat;
  if (oc.x === 20 && oc.y === 260 && oc.w === 460 && oc.h === 800) oc.w = 640;
  if (cfg.ui.dockTheme === 'formal') cfg.ui.dockTheme = 'light';
  // Light, Sakura, Midnight Gold, Glass, Kawaii and Pastel Bow were removed
  if (!THEMES.includes(cfg.chat.theme)) cfg.chat.theme = 'clean';
  // the EAAK styles (Star Cat, Goat, Crimson Cat) were removed
  if (!SCHEMA['clock.style'].values.includes(cfg.clock.style)) cfg.clock.style = 'theme';
  if (saved?.chat?.theme === 'custom') {
    cfg.chat.lookMode = 'custom';
    cfg.chat.theme = 'clean';
  }
  if (saved?.gif && !saved.gif.location) cfg.gif.location = saved.gif.mode === 'separate' ? 'layout' : 'chat';
  if (!Array.isArray(cfg.poll.commands) || cfg.poll.commands.length !== 6) cfg.poll.commands = [...DEFAULTS.poll.commands];
  if (saved?.layout?.battle && !saved.layout.poll) cfg.layout.poll = { ...cfg.layout.poll, ...saved.layout.battle };
  if (saved?.chat && !saved.chat.animMode && saved.chat.enterFrom) {
    cfg.chat.animMode = { left: 'slideLeft', right: 'slideRight' }[saved.chat.enterFrom] || 'slideUp';
  }
  cfg.custom.commands = (Array.isArray(cfg.custom.commands) ? cfg.custom.commands : []).filter(
    (c) =>
      c &&
      /^[a-z0-9_]{2,20}$/.test(c.cmd) &&
      /^[a-f0-9]{32}\.(gif|png|webp|jpg)$/.test(c.file) &&
      fs.existsSync(path.join(DATA_DIR, 'custom', c.file)),
  );
  cfg.css.presets = (Array.isArray(cfg.css.presets) ? cfg.css.presets : []).filter(
    (p) => p && /^[a-f0-9]{12}$/.test(p.id) && typeof p.name === 'string' && fs.existsSync(path.join(DATA_DIR, 'css', `${p.id}.css`)),
  );
  if (!cfg.css.presets.some((p) => p.id === cfg.css.active)) cfg.css.active = cfg.css.presets[0]?.id || '';
  for (const p of ['youtube', 'twitch', 'tiktok']) {
    const f = cfg.chat.logos[p];
    if (typeof f !== 'string' || !/^[a-f0-9]{32}\.(gif|png|webp|jpg)$/.test(f) || !fs.existsSync(path.join(DATA_DIR, 'custom', f))) {
      cfg.chat.logos[p] = '';
    }
  }
  if (!/^[a-f0-9]{16}$/.test(cfg.installId || '')) cfg.installId = crypto.randomBytes(8).toString('hex');
  if (!/^[a-f0-9]{48}$/.test(cfg.dockToken)) cfg.dockToken = crypto.randomBytes(24).toString('hex');
  saveConfig(cfg);
  return cfg;
}

export function saveConfig(cfg) {
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}

function getPath(obj, p) {
  return p.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
}
function setPath(obj, p, value) {
  const keys = p.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}

function cleanItem(s, max) {
  return String(s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

// Apply a flat patch like {"chat.theme": "sakura"}. Returns list of changed keys.
export function applyPatch(cfg, patch) {
  const changed = [];
  if (!patch || typeof patch !== 'object') return changed;
  for (const [key, raw] of Object.entries(patch)) {
    const rule = SCHEMA[key];
    if (!rule) continue;
    let value;
    switch (rule.type) {
      case 'bool':
        if (typeof raw !== 'boolean') continue;
        value = raw;
        break;
      case 'int': {
        const n = Number(raw);
        if (!Number.isFinite(n)) continue;
        value = Math.min(rule.max, Math.max(rule.min, Math.round(n)));
        break;
      }
      case 'color':
        if (typeof raw !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(raw)) continue;
        value = raw.toLowerCase();
        break;
      case 'text':
        // free text (custom CSS): strip control chars except newline/tab, cap size
        if (typeof raw !== 'string') continue;
        value = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, rule.max);
        break;
      case 'box': {
        if (!raw || typeof raw !== 'object') continue;
        const W = cfg.layout.canvasW;
        const H = cfg.layout.canvasH;
        const n = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));
        const w = n(raw.w, 80, W);
        const h = n(raw.h, 60, H);
        value = {
          x: n(raw.x, 0, W - w),
          y: n(raw.y, 0, H - h),
          w,
          h,
          locked: raw.locked === true,
          visible: raw.visible !== false,
        };
        break;
      }
      case 'enum':
        if (!rule.values.includes(raw)) continue;
        value = raw;
        break;
      case 'str':
      case 'secret': {
        if (typeof raw !== 'string') continue;
        value = cleanItem(raw, rule.max);
        if (rule.pattern && !rule.pattern.test(value)) continue;
        // an empty secret from the dock means "keep the current one"
        if (rule.type === 'secret' && value === '' && patch[key + '.clear'] !== true) continue;
        break;
      }
      case 'list': {
        if (!Array.isArray(raw)) continue;
        value = [...new Set(raw.map((s) => cleanItem(s, rule.itemMax).toLowerCase()).filter(Boolean))].slice(0, rule.max);
        break;
      }
      default:
        continue;
    }
    if (JSON.stringify(getPath(cfg, key)) !== JSON.stringify(value)) {
      setPath(cfg, key, value);
      changed.push(key);
    }
  }
  // canvas resized: pull every box back inside the new canvas
  if (changed.some((k) => k === 'layout.canvasW' || k === 'layout.canvasH')) {
    for (const name of ['chat', 'gif', 'poll', 'clock', 'featured']) {
      const b = cfg.layout[name];
      const W = cfg.layout.canvasW;
      const H = cfg.layout.canvasH;
      b.w = Math.min(b.w, W);
      b.h = Math.min(b.h, H);
      b.x = Math.min(Math.max(0, b.x), W - b.w);
      b.y = Math.min(Math.max(0, b.y), H - b.h);
    }
  }
  // explicit secret clearing
  for (const key of ['connections.tiktok.signKey', 'connections.youtube.apiKey', 'gif.giphyKey', 'gif.klipyKey']) {
    if (patch[key + '.clear'] === true && getPath(cfg, key) !== '') {
      setPath(cfg, key, '');
      changed.push(key);
    }
  }
  return changed;
}

// What the dock is allowed to see: secrets are replaced by a yes/no flag.
export function dockView(cfg) {
  const v = structuredClone(cfg);
  delete v.dockToken;
  v.connections.tiktok.hasSignKey = !!cfg.connections.tiktok.signKey;
  v.connections.youtube.hasApiKey = !!cfg.connections.youtube.apiKey;
  v.connections.youtube.apiKey = '';
  v.connections.tiktok.signKey = '';
  v.gif.hasGiphyKey = !!cfg.gif.giphyKey;
  v.gif.giphyKey = '';
  v.gif.hasKlipyKey = !!cfg.gif.klipyKey;
  v.gif.klipyKey = '';
  return v;
}

// What overlays are allowed to see: look settings only.
function cssHash(text) {
  return crypto.createHash('sha1').update(text || '').digest('hex').slice(0, 10);
}

// What the overlay should draw with: Custom CSS mode wins over the template,
// and custom colors only ever apply to the Default template.
export function effectiveTheme(cfg) {
  return cfg.chat.lookMode === 'custom' ? 'custom' : cfg.chat.theme;
}

export function overlayView(cfg) {
  return {
    chat: {
      theme: effectiveTheme(cfg),
      fontSize: cfg.chat.fontSize,
      maxMessages: cfg.chat.maxMessages,
      hideAfter: cfg.chat.hideAfter,
      align: cfg.chat.align,
      columnWidth: cfg.chat.columnWidth,
      cardMaxWidth: cfg.chat.cardMaxWidth,
      logoPos: cfg.chat.logoPos,
      fadeTop: cfg.chat.fadeTop,
      fadeBottom: cfg.chat.fadeBottom,
      fadeStrength: cfg.chat.fadeStrength,
      animMode: cfg.chat.animMode,
      cssVersion: cssHash(cfg.chat.customCss),
      showLogo: cfg.chat.showLogo,
      showDot: cfg.chat.showDot,
      logos: Object.fromEntries(
        Object.entries(cfg.chat.logos).map(([k, f]) => [k, f ? `/custom/${f}` : `/logos/${k}.png`]),
      ),
      useThemeColors: cfg.chat.useThemeColors || effectiveTheme(cfg) !== 'clean',
      bgColor: cfg.chat.bgColor,
      bgOpacity: cfg.chat.bgOpacity,
      borderColor: cfg.chat.borderColor,
      enterFrom: cfg.chat.enterFrom,
      animMs: cfg.chat.animMs,
      stagger: cfg.chat.stagger,
      busyHold: cfg.chat.busyHold,
      zoom: cfg.chat.zoom,
      cssLogo: cfg.chat.cssLogo,
      cssLogoPos: cfg.chat.cssLogoPos,
    },
    layout: cfg.layout,
    ui: { dockTheme: cfg.ui.dockTheme },
    poll: { location: cfg.poll.location },
    clock: { ...cfg.clock },
    featured: { location: cfg.featured.location },
    gif: {
      displaySeconds: cfg.gif.displaySeconds,
      location: cfg.gif.location,
      mode: cfg.gif.mode,
      position: cfg.gif.position,
      size: cfg.gif.size,
      chatSize: cfg.gif.chatSize,
    },
  };
}
