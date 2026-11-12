import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

import { loadConfig, saveConfig, applyPatch, dockView, overlayView, effectiveTheme, DATA_DIR } from './config.js';
import { safeImageUrl, cleanText, cleanFragment, cleanName, cleanColor, userKey, normalizeForFilter } from './security.js';
import { TwitchConnector } from './connectors/twitch.js';
import { YouTubeConnector } from './connectors/youtube.js';
import { TikTokConnector } from './connectors/tiktok.js';
import { GifFeature } from './features/gif.js';
import { PollFeature } from './features/poll.js';

const APP_VERSION = '2.9.0';

// Safety net: a bug in one feature must never take the whole app down mid-stream.
process.on('uncaughtException', (err) => {
  console.error('Unexpected error (app keeps running):', err);
  try {
    log(`Internal error: ${err.message}`);
  } catch {
    // logging not ready yet
  }
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise error (app keeps running):', err);
});

const cfg = loadConfig();
const PORT = cfg.port;
const HOST = '127.0.0.1'; // never listen on the network, only this PC
const PUBLIC = path.resolve('public');
const CUSTOM_DIR = path.join(DATA_DIR, 'custom');
fs.mkdirSync(CUSTOM_DIR, { recursive: true });
const MAX_UPLOAD = 8 * 1024 * 1024;
const MAX_CUSTOM = 50;
const RESERVED = new Set(['gif', 'vote', 'poll', 'endpoll', 'skipgif']);
const IMAGE_TYPES = { gif: 'image/gif', png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg' };

// Decide the file type from its first bytes, not from its name.
// SVG is deliberately not accepted because SVG files can contain scripts.
function sniffImage(buf) {
  const head = buf.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'gif';
  if (buf[0] === 0x89 && head.slice(1, 4) === 'PNG') return 'png';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  return null;
}

// ---------------------------------------------------------------- logging
const logLines = [];
function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  logLines.push(line);
  if (logLines.length > 200) logLines.shift();
  toDocks({ type: 'log', line });
}

// ---------------------------------------------------------------- http
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

const IMG_SRC = [
  "'self'",
  'data:',
  'https://*.giphy.com',
  'https://static.klipy.com',
  'https://yt3.ggpht.com',
  'https://yt4.ggpht.com',
  'https://*.googleusercontent.com',
  'https://static-cdn.jtvnw.net',
  'https://*.tiktokcdn.com',
  'https://*.tiktokcdn-us.com',
  'https://*.tiktokcdn-eu.com',
  'https://*.ibyteimg.com',
].join(' ');

function csp(images, { frame = "'none'", frames = "'none'" } = {}) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    `img-src ${images}`,
    `connect-src 'self' ws://127.0.0.1:${PORT} ws://localhost:${PORT}`,
    `frame-src ${frames}`,
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frame}`,
  ].join('; ');
}

// Only these files can ever be served. No directory browsing, no path tricks.
const ROUTES = {
  // frames 'self': the Everything overlay shows the clock in its own small frame,
  // so the clock can use a different template than chat
  '/overlay': { file: 'overlay.html', type: 'text/html', csp: csp(`${IMG_SRC} https:`, { frame: "'self'", frames: "'self'" }) },
  '/layout': { file: 'layout.html', type: 'text/html', csp: csp("'self' data:", { frames: "'self'" }) },
  '/static/layout.css': { file: 'layout.css', type: 'text/css' },
  '/static/layout.js': { file: 'layout.js', type: 'text/javascript' },
  '/static/editor.js': { file: 'editor.js', type: 'text/javascript' },
  // the dock shows avatars and emotes in the Live tab, from the same platform CDNs as the overlay
  '/dock': { file: 'dock.html', type: 'text/html', csp: csp(IMG_SRC) },
  '/static/overlay.css': { file: 'overlay.css', type: 'text/css' },
  '/static/overlay.js': { file: 'overlay.js', type: 'text/javascript' },
  '/static/dock.css': { file: 'dock.css', type: 'text/css' },
  '/static/dock.js': { file: 'dock.js', type: 'text/javascript' },
  '/static/custom-css-starter.css': { file: 'custom-css-starter.css', type: 'text/css' },
  '/guide': { file: 'guide.html', type: 'text/html', csp: csp("'self' data:") },
  '/static/guide.css': { file: 'guide.css', type: 'text/css' },
};
// Curve / Accordion / Liquid arrival modules: only plain names inside public/motion and its presets folder
const MOTION_FILE = /^\/static\/motion\/((?:presets\/)?[a-z0-9-]+\.(js|css))$/;

const server = http.createServer((req, res) => {
  if (!ALLOWED_HOSTS.has(req.headers.host)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/') {
    res.writeHead(302, { Location: '/overlay?layer=all' }).end();
    return;
  }
  // The streamer's own CSS, served as a stylesheet file (never inlined into HTML).
  // Only used when the theme is "Custom CSS".
  if (url.pathname === '/user.css' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/css; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    }).end(effectiveTheme(cfg) === 'custom' ? readPreset(cfg.css.active) : '');
    return;
  }
  if (url.pathname === '/api/css') {
    handleCssApi(req, res, url);
    return;
  }
  const brand = url.pathname.match(/^\/static\/(achat-logo(?:-64)?\.png)$/);
  if (brand && req.method === 'GET') {
    fs.readFile(path.join(PUBLIC, 'brand', brand[1]), (err, body) => {
      if (err) return res.writeHead(404).end('Not found');
      res.writeHead(200, { 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'max-age=86400' }).end(body);
    });
    return;
  }
  if (url.pathname === '/samples/test.gif' && req.method === 'GET') {
    fs.readFile(path.join(PUBLIC, 'samples', 'test.gif'), (err, body) => {
      if (err) return res.writeHead(404).end('Not found');
      res.writeHead(200, { 'Content-Type': 'image/gif', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'max-age=86400' }).end(body);
    });
    return;
  }
  const bundledLogo = url.pathname.match(/^\/logos\/(youtube|twitch|tiktok)\.png$/);
  if (bundledLogo && req.method === 'GET') {
    fs.readFile(path.join(PUBLIC, 'logos', `${bundledLogo[1]}.png`), (err, body) => {
      if (err) {
        res.writeHead(404).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
        'Cache-Control': 'max-age=86400',
      }).end(body);
    });
    return;
  }
  const customFile = url.pathname.match(/^\/custom\/([a-f0-9]{32})\.(gif|png|webp|jpg)$/);
  if (customFile && req.method === 'GET') {
    fs.readFile(path.join(CUSTOM_DIR, `${customFile[1]}.${customFile[2]}`), (err, body) => {
      if (err) {
        res.writeHead(404).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': IMAGE_TYPES[customFile[2]],
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
        'Cache-Control': 'max-age=3600',
      }).end(body);
    });
    return;
  }
  if (url.pathname === '/api/custom' && req.method === 'POST') {
    handleUpload(req, res, url);
    return;
  }
  if (url.pathname === '/api/logo' && req.method === 'POST') {
    handleLogoUpload(req, res, url);
    return;
  }
  const motionFile = url.pathname.match(MOTION_FILE);
  const route = motionFile
    ? { file: path.join('motion', motionFile[1]), type: motionFile[2] === 'js' ? 'text/javascript' : 'text/css' }
    : ROUTES[url.pathname];
  if (!route || req.method !== 'GET') {
    res.writeHead(404).end('Not found');
    return;
  }
  fs.readFile(path.join(PUBLIC, route.file), (err, body) => {
    if (err) {
      res.writeHead(500).end('Missing file');
      return;
    }
    const headers = {
      'Content-Type': `${route.type}; charset=utf-8`,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    };
    if (route.csp) headers['Content-Security-Policy'] = route.csp;
    // stamp the app version into pages and scripts so OBS never runs a stale copy
    res.writeHead(200, headers).end(body.toString('utf8').replaceAll('{{BAE_VERSION}}', APP_VERSION));
  });
});

// Read an uploaded image body (max 8 MB), check its real type, save it under a
// random name, then call done(fileName). Errors are answered here.
function readImage(req, res, done) {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    if (size > MAX_UPLOAD) {
      aborted = true;
      reply(res, 413, { error: 'File is larger than 8 MB' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    const buf = Buffer.concat(chunks);
    const ext = sniffImage(buf);
    if (!ext) return reply(res, 400, { error: 'Use a GIF, PNG, WEBP or JPG file' });
    const file = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
    try {
      fs.writeFileSync(path.join(CUSTOM_DIR, file), buf);
    } catch (err) {
      return reply(res, 500, { error: `Could not save: ${err.message}` });
    }
    done(file);
  });
}

function uploadAllowed(req) {
  return ALLOWED_ORIGINS.has(req.headers.origin) && tokenOk(req.headers['x-bae-token']);
}

function handleLogoUpload(req, res, url) {
  const platform = url.searchParams.get('platform');
  if (!uploadAllowed(req) || !['youtube', 'twitch', 'tiktok'].includes(platform)) {
    req.resume();
    return reply(res, 403, { error: 'Not allowed' });
  }
  readImage(req, res, (file) => {
    const old = cfg.chat.logos[platform];
    if (old) fs.rm(path.join(CUSTOM_DIR, old), { force: true }, () => {});
    cfg.chat.logos[platform] = file;
    saveConfig(cfg);
    log(`Logo for ${platform} updated`);
    pushCssChange();
    toDocks({ type: 'config', config: dockView(cfg) });
    reply(res, 200, { ok: true, platform });
  });
}

function reply(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' }).end(JSON.stringify(obj));
}

// Upload a custom GIF from the dock. Only the dock (same origin + token) can do this.
function handleUpload(req, res, url) {
  if (!uploadAllowed(req)) {
    req.resume();
    return reply(res, 403, { error: 'Not allowed' });
  }
  const cmd = String(url.searchParams.get('cmd') || '').toLowerCase().replace(/^!/, '').trim();
  if (!/^[a-z0-9_]{2,20}$/.test(cmd)) {
    req.resume();
    return reply(res, 400, { error: 'Command must be 2-20 letters, numbers or _' });
  }
  if (RESERVED.has(cmd) || cfg.poll.commands.includes(`!${cmd}`)) {
    req.resume();
    return reply(res, 400, { error: `!${cmd} is already a built-in command` });
  }
  const existing = cfg.custom.commands.find((c) => c.cmd === cmd);
  if (!existing && cfg.custom.commands.length >= MAX_CUSTOM) {
    req.resume();
    return reply(res, 400, { error: `You can have up to ${MAX_CUSTOM} custom commands` });
  }
  readImage(req, res, (file) => {
    if (existing) {
      fs.rm(path.join(CUSTOM_DIR, existing.file), { force: true }, () => {});
      existing.file = file;
    } else {
      cfg.custom.commands.push({ cmd, file });
    }
    cfg.custom.commands.sort((a, b) => a.cmd.localeCompare(b.cmd));
    saveConfig(cfg);
    log(`Custom command !${cmd} ${existing ? 'updated' : 'added'}`);
    toDocks({ type: 'config', config: dockView(cfg) });
    reply(res, 200, { ok: true, cmd });
  });
}

// ---------------------------------------------------------------- custom CSS presets
const CSS_DIR = path.join(DATA_DIR, 'css');
fs.mkdirSync(CSS_DIR, { recursive: true });
const MAX_CSS = 3 * 1024 * 1024; // community chat CSS often embeds images, so allow a few MB

function presetPath(id) {
  return /^[a-f0-9]{12}$/.test(id || '') ? path.join(CSS_DIR, `${id}.css`) : null;
}
function readPreset(id) {
  const p = presetPath(id);
  try {
    return p ? fs.readFileSync(p, 'utf8') : '';
  } catch {
    return '';
  }
}
function cssVersion() {
  const p = presetPath(cfg.css.active);
  let stamp = '0';
  try {
    if (p) stamp = String(fs.statSync(p).mtimeMs);
  } catch {
    // missing file
  }
  return `${effectiveTheme(cfg)}-${cfg.css.active}-${stamp}`;
}
function cleanPresetName(n) {
  return String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || 'My CSS';
}

// move CSS from older versions (stored inside config) into a preset file
if (cfg.chat.customCss && !cfg.css.presets.length) {
  const id = crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(path.join(CSS_DIR, `${id}.css`), cfg.chat.customCss);
  cfg.css.presets.push({ id, name: 'Imported CSS' });
  cfg.css.active = id;
  cfg.chat.customCss = '';
  saveConfig(cfg);
}

function pushCssChange() {
  toOverlays({ type: 'settings', settings: { ...overlayView(cfg), cssVersion: cssVersion() } });
  toDocks({ type: 'config', config: dockView(cfg) });
}

// GET  /api/css?id=...           read a preset (dock only, token header)
// POST /api/css?id=...&name=...  save text into a preset; no id = new preset
function handleCssApi(req, res, url) {
  if (!tokenOk(req.headers['x-bae-token']) || (req.method === 'POST' && !ALLOWED_ORIGINS.has(req.headers.origin))) {
    req.resume();
    return reply(res, 403, { error: 'Not allowed' });
  }
  const id = url.searchParams.get('id') || '';
  if (req.method === 'GET') {
    if (!presetPath(id) || !cfg.css.presets.some((p) => p.id === id)) return reply(res, 404, { error: 'No such preset' });
    return reply(res, 200, { id, css: readPreset(id) });
  }
  if (req.method !== 'POST') {
    req.resume();
    return reply(res, 405, { error: 'Method not allowed' });
  }
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    if (size > MAX_CSS) {
      aborted = true;
      reply(res, 413, { error: 'CSS is larger than 3 MB' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    const css = Buffer.concat(chunks).toString('utf8').replace(/\u0000/g, '');
    let entry = cfg.css.presets.find((p) => p.id === id);
    if (!entry) {
      if (cfg.css.presets.length >= 30) return reply(res, 400, { error: 'You can keep up to 30 presets' });
      entry = { id: crypto.randomBytes(6).toString('hex'), name: cleanPresetName(url.searchParams.get('name')) };
      cfg.css.presets.push(entry);
    } else if (url.searchParams.get('name')) {
      entry.name = cleanPresetName(url.searchParams.get('name'));
    }
    try {
      fs.writeFileSync(presetPath(entry.id), css);
    } catch (err) {
      return reply(res, 500, { error: `Could not save: ${err.message}` });
    }
    cfg.css.active = entry.id;
    saveConfig(cfg);
    log(`Custom CSS saved: ${entry.name} (${Math.round(css.length / 1024)} KB)`);
    pushCssChange();
    reply(res, 200, { ok: true, id: entry.id, name: entry.name });
  });
}

// ---------------------------------------------------------------- websocket
// Control messages are small; big things (CSS, images) go through HTTP uploads.
const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
const overlays = new Set();
const docks = new Set();

function tokenOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(cfg.dockToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const originOk = ALLOWED_ORIGINS.has(req.headers.origin);
  if (!ALLOWED_HOSTS.has(req.headers.host) || !originOk || url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const role = url.searchParams.get('role');
  if (role === 'dock' && !tokenOk(url.searchParams.get('token'))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  if (role !== 'dock' && role !== 'overlay') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.alive = true;
    ws.on('pong', () => (ws.alive = true));
    // without this, one oversized or broken message would crash the whole app
    ws.on('error', (err) => {
      log(`Connection error from ${role}: ${err.message}`);
      ws.terminate();
    });
    if (role === 'dock') {
      docks.add(ws);
      ws.on('close', () => docks.delete(ws));
      ws.on('message', (raw) => {
        try {
          onDockMessage(raw);
        } catch (err) {
          log(`Dock action failed: ${err.message}`);
        }
      });
      send(ws, { type: 'hello', ...dockState(), log: logLines });
    } else {
      const layer = url.searchParams.get('layer');
      ws.layer = ['all', 'chat', 'gif', 'poll', 'clock'].includes(layer) ? layer : 'all';
      // the layout editor's preview and the clock frame inside an overlay aren't OBS sources
      ws.preview = url.searchParams.get('preview') === '1' || url.searchParams.get('embed') === '1';
      ws.size = [Number(url.searchParams.get('sw')) || 0, Number(url.searchParams.get('sh')) || 0];
      ws.version = String(url.searchParams.get('v') || 'old').slice(0, 20);
      overlays.add(ws);
      toDocks({ type: 'overlays', overlays: overlaySummary() });
      ws.on('close', () => {
        overlays.delete(ws);
        toDocks({ type: 'overlays', overlays: overlaySummary() });
      });
      // overlays are display only: anything they send is ignored
      // the version lets an overlay loaded from an older achat reload itself
      send(ws, { type: 'hello', version: APP_VERSION });
      send(ws, { type: 'settings', settings: { ...overlayView(cfg), cssVersion: cssVersion() } });
      // OBS reloads a source whenever its scene becomes active: bring back what's
      // already on screen, or a running poll would be missing until the next vote
      if (poll.poll) send(ws, { type: 'poll', poll: poll.view() });
      const f = featured && findRecent(featured.id);
      if (f) send(ws, { type: 'feature', msg: { id: f.id, user: f.user, parts: f.parts, paid: f.paid } });
    }
  });
});

// Heartbeat. After hours idle, or when the PC sleeps, a connection can die
// without either side noticing. Every 10s: drop connections that didn't answer
// the last ping, and send every page a small message; a page that hears
// nothing for 25s reconnects by itself.
setInterval(() => {
  for (const ws of [...overlays, ...docks]) {
    if (ws.alive === false) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    try {
      ws.ping();
    } catch {
      // closing
    }
    send(ws, { type: 'ping' });
  }
}, 10000).unref();

function overlaySummary() {
  const count = { all: 0, chat: 0, gif: 0, poll: 0, clock: 0, outdated: 0, sizes: [] };
  for (const ws of overlays) {
    if (ws.preview) continue; // the layout editor's preview isn't an OBS source
    count[ws.layer]++;
    if (ws.version !== APP_VERSION) count.outdated++;
    if (ws.layer === 'all' && ws.size && ws.size[0]) count.sizes.push(ws.size);
  }
  return count;
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function toOverlays(obj) {
  const s = JSON.stringify(obj);
  for (const ws of overlays) if (ws.readyState === 1) ws.send(s);
}
function toDocks(obj) {
  const s = JSON.stringify(obj);
  for (const ws of docks) if (ws.readyState === 1) ws.send(s);
}

// ---------------------------------------------------------------- features
const getCfg = () => cfg;
const gif = new GifFeature(getCfg, (m) => {
  toOverlays(m);
  toDocks({ type: 'gifState', gif: gif.state() });
}, log);
const poll = new PollFeature(getCfg, (m) => {
  toOverlays(m);
  toDocks({ type: 'pollState', poll: poll.view() });
}, log);

// ---------------------------------------------------------------- connectors
const connectors = {};
const status = { youtube: ['off', ''], twitch: ['off', ''], tiktok: ['off', ''] };
// current viewers per platform; null means unknown or not live
const viewers = { youtube: null, twitch: null, tiktok: null };
function setViewers(platform, n) {
  const v = Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  if (viewers[platform] === v) return;
  viewers[platform] = v;
  toDocks({ type: 'viewers', viewers });
}

function buildConnector(platform) {
  const c = cfg.connections[platform];
  if (platform === 'twitch') return new TwitchConnector(c.channel, log);
  if (platform === 'youtube') return new YouTubeConnector(c.target, log, { apiKey: c.useApi ? c.apiKey : '', apiInterval: c.apiInterval });
  return new TikTokConnector(c.username, c.signKey, log);
}

function startConnector(platform) {
  stopConnector(platform);
  const conn = buildConnector(platform);
  connectors[platform] = conn;
  conn.on('status', (s, detail) => {
    status[platform] = [s, detail];
    toDocks({ type: 'status', status });
  });
  conn.on('message', (m) => {
    try {
      onChat(m);
    } catch (err) {
      log(`Message skipped: ${err.message}`);
    }
  });
  conn.on('viewers', (n) => setViewers(platform, n));
  conn.on('delete', (d) => onDelete(platform, d));
  conn.start();
}

function stopConnector(platform) {
  if (connectors[platform]) {
    connectors[platform].removeAllListeners();
    connectors[platform].stop();
    delete connectors[platform];
  }
  setViewers(platform, null);
  status[platform] = ['off', ''];
  toDocks({ type: 'status', status });
}

// ---------------------------------------------------------------- chat pipeline
let msgCounter = 0;

function onChat(raw, opts = {}) {
  const user = {
    platform: raw.platform,
    key: userKey(raw.platform, raw.userId || raw.name),
    name: cleanName(raw.name),
    avatar: safeImageUrl(raw.avatar),
    color: cleanColor(raw.color),
    roles: {
      owner: !!raw.roles?.owner,
      mod: !!raw.roles?.mod,
      member: !!raw.roles?.member,
      vip: !!raw.roles?.vip,
    },
  };
  const lowerName = user.name.toLowerCase();
  if (cfg.chat.ignoredUsers.includes(lowerName)) return;
  const banned = cfg.bannedUsers.includes(lowerName) || cfg.bannedUsers.includes(user.key);

  const text = cleanText(raw.text, 300);
  const parts = [];
  let budget = 300;
  for (const p of raw.parts || []) {
    if (budget <= 0 || parts.length >= 60) break;
    if (p.t === 'text') {
      const v = cleanFragment(p.v, budget);
      if (v) {
        parts.push({ t: 'text', v });
        budget -= v.length;
      }
    } else if (p.t === 'emote') {
      const url = safeImageUrl(p.url);
      const alt = cleanText(p.alt, 40);
      parts.push(url ? { t: 'emote', url, alt } : { t: 'text', v: alt });
    }
  }
  if (!parts.length && !text) return;

  const isCommand = text.startsWith('!');
  const onStream = !(isCommand && cfg.chat.hideCommands);
  const msg = {
    type: 'chat',
    id: `m${++msgCounter}`,
    user: { name: user.name, avatar: user.avatar, color: user.color, roles: user.roles, platform: user.platform },
    parts,
  };
  if (raw.paid) msg.paid = { amount: cleanText(raw.paid.amount, 30) };
  if (onStream) toOverlays(msg);

  // every message also goes to the dock's Live tab, including hidden !commands
  const entry = { ...msg, type: undefined, key: user.key, at: Date.now(), onStream, cmd: isCommand };
  // the platform's own ids, so a mod deleting the message can be matched later (never sent anywhere)
  Object.defineProperty(entry, 'pid', { value: raw.pid == null ? null : String(raw.pid) });
  Object.defineProperty(entry, 'uid', { value: raw.userId == null ? null : String(raw.userId) });
  recentChat.push(entry);
  if (recentChat.length > MAX_RECENT) recentChat.shift();
  toDocks({ type: 'livechat', msg: entry });

  if (isCommand && !banned) runCommand(user, text, opts);
}

// ---------------------------------------------------------------- Live tab
const MAX_RECENT = 200; // messages kept for a dock that opens mid-stream
const recentChat = [];
let featured = null; // { id, timer }
const findRecent = (id) => recentChat.find((c) => c.id === id);

function unfeature() {
  if (!featured) return;
  clearTimeout(featured.timer);
  featured = null;
  toOverlays({ type: 'feature', msg: null });
  toDocks({ type: 'featured', id: null });
}

// A platform mod deleted messages: they leave the stream, and the Live tab
// keeps them crossed out so you can still see what was said.
function onDelete(platform, d) {
  const ids = new Set((d?.ids || []).map(String));
  const users = new Set((d?.userIds || []).map(String));
  let n = 0;
  for (const c of recentChat) {
    if (c.user.platform !== platform || c.deleted) continue;
    if (!(d?.all || (c.pid && ids.has(c.pid)) || (c.uid && users.has(c.uid)))) continue;
    c.deleted = true;
    n++;
    if (c.onStream) toOverlays({ type: 'chat:remove', id: c.id });
    if (featured && featured.id === c.id) unfeature();
    toDocks({ type: 'livechat:update', id: c.id, deleted: true, hidden: !!c.hidden });
  }
  if (n) log(`${{ youtube: 'YouTube', twitch: 'Twitch', tiktok: 'TikTok' }[platform]}: a mod deleted ${n} message${n > 1 ? 's' : ''}`);
}

function onLiveAction(m) {
  const c = typeof m.id === 'string' ? findRecent(m.id) : null;
  if (!c) return;
  if (m.type === 'chat:hide') {
    if (!c.onStream || c.hidden) return;
    c.hidden = true;
    toOverlays({ type: 'chat:remove', id: c.id });
    if (featured && featured.id === c.id) unfeature();
    toDocks({ type: 'livechat:update', id: c.id, hidden: true, deleted: !!c.deleted });
    log(`Message from ${c.user.name} hidden from stream`);
  } else if (m.type === 'user:ban') {
    // toggles: blocked users can still chat but can't use !gif, custom commands or votes
    const i = cfg.bannedUsers.indexOf(c.key);
    if (i >= 0) cfg.bannedUsers.splice(i, 1);
    else cfg.bannedUsers.push(c.key);
    saveConfig(cfg);
    log(`${c.user.name} (${c.user.platform}) ${i >= 0 ? 'unblocked' : 'blocked'} from commands`);
    toDocks({ type: 'config', config: dockView(cfg) });
  } else if (m.type === 'chat:feature') {
    if (featured && featured.id === c.id) return unfeature();
    if (c.deleted) return;
    unfeature();
    const secs = cfg.featured.seconds; // 0 keeps it up until you take it off
    featured = { id: c.id, timer: secs > 0 ? setTimeout(unfeature, secs * 1000) : null };
    toOverlays({ type: 'feature', msg: { id: c.id, user: c.user, parts: c.parts, paid: c.paid } });
    toDocks({ type: 'featured', id: c.id });
    log(`Featured on stream: ${c.user.name}`);
  }
}

function runCommand(user, text, opts = {}) {
  const bypassCooldown = !!opts.test;
  const [cmdRaw, ...args] = text.split(' ');
  const cmd = cmdRaw.toLowerCase();
  const arg = args.join(' ').trim();
  const staff = user.roles.owner || user.roles.mod;

  switch (cmd) {
    case '!gif':
      gif.request(user, arg, { bypassCooldown });
      break;
    case '!vote':
      if (cfg.poll.enabled) poll.vote(user, arg);
      break;
    case '!poll':
      if (staff && cfg.poll.enabled) poll.fromChat(user, arg);
      break;
    case '!endpoll':
      if (staff) poll.end();
      break;
    case '!skipgif':
      if (staff) gif.skip();
      break;
    default: {
      const entry = cfg.custom.commands.find((c) => c.cmd === cmd.slice(1));
      if (entry) {
        gif.custom(user, entry, { bypassCooldown });
        break;
      }
      // your own poll commands, like !yes / !no
      const idx = cfg.poll.commands.indexOf(cmd);
      if (idx >= 0 && cfg.poll.enabled) poll.vote(user, String(idx + 1));
      break;
    }
  }
}

// ---------------------------------------------------------------- dock actions
function dockState() {
  return {
    config: dockView(cfg),
    status,
    gif: gif.state(),
    poll: poll.view(),
    viewers,
    chat: recentChat,
    features: ['live'], // lets a newer dock tell when it's talking to an older app
    featured: featured ? featured.id : null,
    overlays: overlaySummary(),
    version: APP_VERSION,
    layoutUrl: `http://127.0.0.1:${PORT}/layout?token=${cfg.dockToken}`,
    urls: {
      all: `http://127.0.0.1:${PORT}/overlay?layer=all`,
      chat: `http://127.0.0.1:${PORT}/overlay?layer=chat`,
      gif: `http://127.0.0.1:${PORT}/overlay?layer=gif`,
      poll: `http://127.0.0.1:${PORT}/overlay?layer=poll`,
      clock: `http://127.0.0.1:${PORT}/overlay?layer=clock`,
    },
  };
}

const TEST_USERS = [
  { name: 'shadow_vibe', platform: 'youtube' },
  { name: 'luna_star', platform: 'twitch', roles: { member: true } },
  { name: 'kris_p', platform: 'tiktok', roles: { mod: true } },
  { name: 'Pebble', platform: 'youtube' },
  { name: 'frosty_bite', platform: 'twitch' },
];
const TEST_LINES = [
  'What playlist is this? The background music is a whole vibe.',
  'valid tbh',
  'Try turning off motion blur in the settings, the frame drops usually happen during heavy combat scenes.',
  'no way lol',
  'Wait, did you check behind the door earlier?',
  'caught in 4k',
  '<b>this should show as plain text</b> <img src=x onerror=alert(1)>',
];

function testUser(i) {
  const t = TEST_USERS[i % TEST_USERS.length];
  return {
    platform: t.platform,
    userId: 'test-' + t.name,
    name: t.name,
    avatar: null,
    roles: t.roles || {},
  };
}

// Why a poll can't be seen right now, in plain words, or '' when some open
// OBS source shows the spot the poll goes to.
function pollProblem(c = overlaySummary()) {
  if (c.all + c.chat + c.gif + c.poll + c.clock === 0) {
    return 'No achat overlay is open in OBS (or in a browser), so the poll has nowhere to show. Add a Browser Source with a link from the Connect tab.';
  }
  if (cfg.poll.location === 'layout' && c.all + c.poll === 0) {
    return 'The poll went to the Layout box, but none of your OBS sources show that box. Choose "Top of chat" above, or add the "Poll only" or "Everything" link.';
  }
  if (cfg.poll.location === 'chat' && c.all + c.chat === 0) {
    return 'The poll went to the top of chat, but none of your OBS sources show chat. Choose "Layout box" above and add the "Poll only" link, or add the "Everything" link.';
  }
  if (cfg.poll.location === 'layout' && c.poll === 0 && cfg.layout.poll.visible === false) {
    return 'The Poll box is switched off in Layout ("Show on stream"), so the Everything source hides it.';
  }
  if (cfg.poll.location === 'chat' && c.chat === 0 && cfg.layout.chat.visible === false) {
    return 'The Chat box is switched off in Layout ("Show on stream"), so the Everything source hides the poll with it.';
  }
  return '';
}

// After a test, tell the dock in plain words where the result went and whether
// any open OBS source can actually show it.
function reportTest(m) {
  const c = overlaySummary();
  const total = c.all + c.chat + c.gif + c.poll + c.clock;
  const say = (text, ok = true) => toDocks({ type: 'notice', area: 'test', ok, text });
  if (total === 0) {
    return say('Nothing can show yet: no achat overlay is open in OBS (or in a browser). Add a Browser Source with a link from the Connect tab, then run the test again.', false);
  }
  const showsChat = c.all + c.chat > 0;
  const text = typeof m.text === 'string' ? m.text.trim().toLowerCase() : '';
  const cmd = text.split(' ')[0];
  const isGif =
    m.what === 'gif' ||
    (m.what === 'type' && (/^!?sample$/.test(text) || cmd === '!gif' || cfg.custom.commands.some((x) => `!${x.cmd}` === cmd)));
  if (isGif) {
    if (!cfg.gif.enabled) return say('GIFs are switched off, so no GIF was shown. Turn them on in the GIFs tab.', false);
    const where = cfg.gif.location;
    const visible = where === 'chat' ? showsChat : c.all + c.gif > 0;
    if (!visible) {
      return say(
        where === 'layout'
          ? 'The GIF went to the Layout box, but none of your OBS sources show that box. In the GIFs tab choose "Chat", or add the "GIFs only" or "Everything" link in OBS.'
          : 'The GIF went into chat, but none of your OBS sources show chat. Add the "Chat only" or "Everything" link in OBS.',
        false,
      );
    }
    if (cmd === '!gif') return say('Searching for your GIF. If a key is missing, the line below will say so.');
    return say(`Sent a test GIF. It should appear ${where === 'chat' ? 'in your chat' : 'in the GIF box'} now.`);
  }
  if (m.what === 'poll') {
    if (!cfg.poll.enabled) return say('Polls are switched off. Turn them on in the Polls tab.', false);
    const problem = pollProblem(c);
    if (problem) return say(problem, false);
    return say('Started a 20-second test poll with pretend votes.');
  }
  if (!showsChat) return say('Sent, but none of your OBS sources show chat. Add the "Chat only" or "Everything" link in OBS.', false);
  const n = m.what === 'burst' ? '5 test messages' : m.what === 'spam' ? '40 fast test messages' : m.what === 'superchat' ? 'a test Super Chat' : 'a test message';
  return say(`Sent ${n}. ${c.chat + c.all === 1 ? 'Your OBS source' : 'Your OBS sources'} should show ${m.what === 'burst' || m.what === 'spam' ? 'them' : 'it'} now.`);
}

function onDockMessage(raw) {
  let m;
  try {
    m = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (!m || typeof m.type !== 'string') return;

  switch (m.type) {
    case 'patch': {
      const pt = m.patch && typeof m.patch === 'object' ? { ...m.patch } : {};
      // logo and dot are either/or
      if (pt['chat.showLogo'] === true) pt['chat.showDot'] = false;
      if (pt['chat.showDot'] === true) pt['chat.showLogo'] = false;
      const changed = applyPatch(cfg, pt);
      if (!changed.length) return;
      saveConfig(cfg);
      for (const p of ['youtube', 'twitch', 'tiktok']) {
        // typing a new channel name only saves it; Connect / Reconnect applies it
        if (changed.includes(`connections.${p}.enabled`)) {
          if (cfg.connections[p].enabled) startConnector(p);
          else stopConnector(p);
        }
      }
      // switching the YouTube reading method (or its key) reconnects straight away
      if (cfg.connections.youtube.enabled && changed.some((k) => /^connections\.youtube\.(useApi|apiKey|apiInterval)$/.test(k))) {
        startConnector('youtube');
      }
      if (changed.includes('chat.theme') || changed.includes('chat.lookMode')) toOverlays({ type: 'clear', instant: true });
      pushCssChange();
      break;
    }
    case 'reconnect':
      if (['youtube', 'twitch', 'tiktok'].includes(m.platform) && cfg.connections[m.platform].enabled) {
        startConnector(m.platform);
      }
      break;
    case 'test': {
      reportTest(m);
      if (m.what === 'chat') {
        const i = crypto.randomInt(1000);
        const line = TEST_LINES[i % TEST_LINES.length];
        onChat({ ...testUser(i), text: line, parts: [{ t: 'text', v: line }] });
      } else if (m.what === 'burst') {
        for (let n = 0; n < 5; n++) {
          const line = TEST_LINES[n % 6];
          onChat({ ...testUser(n), text: line, parts: [{ t: 'text', v: line }] });
        }
      } else if (m.what === 'spam') {
        // a chat flood: 40 messages, 20 per second, from many viewers
        for (let n = 0; n < 40; n++) {
          setTimeout(() => {
            const line = TEST_LINES[n % 6];
            onChat({ ...testUser(n), userId: `spam-${n}`, name: `viewer_${n + 1}`, text: line, parts: [{ t: 'text', v: line }] });
          }, n * 50);
        }
      } else if (m.what === 'superchat') {
        const line = 'Take my money, great stream!';
        onChat({ ...testUser(1), text: line, parts: [{ t: 'text', v: line }], paid: { amount: 'Rp50.000' } });
      } else if (m.what === 'gif') {
        // built-in sample, so testing works without any GIF key
        gif.sample({ ...testUser(2), key: 'test:gif', name: 'kris_p' });
      } else if (m.what === 'custom') {
        const entry = cfg.custom.commands.find((c) => c.cmd === m.cmd);
        if (entry) gif.custom({ ...testUser(4), key: 'test:custom', name: 'frosty_bite' }, entry, { bypassCooldown: true });
      } else if (m.what === 'poll') {
        if (!cfg.poll.enabled) {
          log('Poll test: polls are switched off');
          break;
        }
        const started = poll.start('Which snack for the next stream?', ['Mochi', 'Takoyaki', 'Onigiri'], 20, 'test');
        if (started.error) break;
        // pretend viewers type your real vote commands, through the normal chat path
        [1, 2, 2, 1, 2, 3, 2].forEach((n, i) =>
          setTimeout(() => {
            const cmdText = cfg.poll.commands[n - 1];
            onChat({ ...testUser(i), userId: `test-voter-${i}`, text: cmdText, parts: [{ t: 'text', v: cmdText }] }, { test: true });
          }, 600 + i * 700),
        );
      } else if (m.what === 'type') {
        // typed test: exactly what a viewer would type, through the real pipeline
        const text = cleanText(typeof m.text === 'string' ? m.text : '', 200);
        if (!text) break;
        if (/^!?sample$/i.test(text)) {
          gif.sample({ ...testUser(2), key: 'test:type', name: 'kris_p' });
          break;
        }
        const u = testUser(2);
        onChat({ ...u, userId: 'test-typed', text, parts: [{ t: 'text', v: text }] }, { test: true });
      }
      break;
    }
    case 'css:activate': {
      if (!cfg.css.presets.some((p) => p.id === m.id)) break;
      cfg.css.active = m.id;
      saveConfig(cfg);
      pushCssChange();
      break;
    }
    case 'css:delete': {
      const i = cfg.css.presets.findIndex((p) => p.id === m.id);
      if (i < 0) break;
      const [gone] = cfg.css.presets.splice(i, 1);
      fs.rm(presetPath(gone.id), { force: true }, () => {});
      if (cfg.css.active === gone.id) cfg.css.active = cfg.css.presets[0]?.id || '';
      saveConfig(cfg);
      log(`Custom CSS preset deleted: ${gone.name}`);
      pushCssChange();
      break;
    }
    case 'css:rename': {
      const entry = cfg.css.presets.find((p) => p.id === m.id);
      if (!entry) break;
      entry.name = cleanPresetName(m.name);
      saveConfig(cfg);
      toDocks({ type: 'config', config: dockView(cfg) });
      break;
    }
    case 'logo:delete': {
      const p = m.platform;
      if (!['youtube', 'twitch', 'tiktok'].includes(p) || !cfg.chat.logos[p]) break;
      fs.rm(path.join(CUSTOM_DIR, cfg.chat.logos[p]), { force: true }, () => {});
      cfg.chat.logos[p] = '';
      saveConfig(cfg);
      pushCssChange();
      toDocks({ type: 'config', config: dockView(cfg) });
      break;
    }
    case 'custom:delete': {
      const i = cfg.custom.commands.findIndex((c) => c.cmd === m.cmd);
      if (i < 0) break;
      const [gone] = cfg.custom.commands.splice(i, 1);
      fs.rm(path.join(CUSTOM_DIR, gone.file), { force: true }, () => {});
      saveConfig(cfg);
      log(`Custom command !${gone.cmd} deleted`);
      toDocks({ type: 'config', config: dockView(cfg) });
      break;
    }
    case 'gif:skip':
      gif.skip();
      break;
    case 'gif:clear':
      gif.clearQueue();
      break;
    case 'poll:start': {
      const say = (text, ok) => toDocks({ type: 'notice', area: 'pollstart', ok, text });
      if (!cfg.poll.enabled) {
        say('Polls are switched off. Turn on the switch at the top of this tab first.', false);
        break;
      }
      const res = poll.start(m.question, Array.isArray(m.options) ? m.options : [], m.seconds);
      if (res.error) {
        log(`Poll not started: ${res.error}`);
        say(`Poll not started: ${res.error}.`, false);
        break;
      }
      const problem = pollProblem();
      if (problem) say(`The poll is running, but it can't be seen. ${problem}`, false);
      else say(`The poll is live ${cfg.poll.location === 'chat' ? 'at the top of chat' : 'in the Poll box'}.`, true);
      break;
    }
    case 'poll:commands': {
      const list = Array.isArray(m.commands) ? m.commands.slice(0, 6) : [];
      const clean = list.map((c) => String(c || '').trim().toLowerCase());
      const problems = [];
      clean.forEach((c, i) => {
        if (!/^![a-z0-9_]{1,20}$/.test(c)) problems.push(`Option ${i + 1}: use ! followed by letters, numbers or _ (no spaces)`);
        else if (RESERVED.has(c.slice(1))) problems.push(`Option ${i + 1}: ${c} is a built-in command`);
        else if (cfg.custom.commands.some((x) => `!${x.cmd}` === c)) problems.push(`Option ${i + 1}: ${c} is one of your GIF commands`);
      });
      clean.forEach((c, i) => {
        if (clean.indexOf(c) !== i) problems.push(`Option ${i + 1}: ${c} is used twice`);
      });
      if (clean.length !== 6) problems.push('Six commands are needed');
      if (problems.length) {
        toDocks({ type: 'notice', area: 'poll', ok: false, text: problems[0] });
        break;
      }
      cfg.poll.commands = clean;
      saveConfig(cfg);
      log(`Poll commands saved: ${clean.join(', ')}`);
      toDocks({ type: 'notice', area: 'poll', ok: true, text: 'Saved. Viewers can use these now.' });
      toDocks({ type: 'config', config: dockView(cfg) });
      if (poll.poll) poll.push();
      break;
    }
    case 'poll:end':
      poll.end();
      break;
    case 'chat:hide':
    case 'chat:feature':
    case 'user:ban':
      onLiveAction(m);
      break;
    case 'poll:clear':
      poll.clear();
      break;
    case 'app:stop':
      // "Stop achat" in the dock: achat runs in the background with no window to close
      log('achat stopped from the dock');
      toDocks({ type: 'stopping' });
      setTimeout(() => process.exit(0), 300);
      break;
    case 'overlay:clear':
      toOverlays({ type: 'clear' });
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- start
server.listen(PORT, HOST, () => {
  const dockUrl = `http://127.0.0.1:${PORT}/dock?token=${cfg.dockToken}`;
  console.log('');
  console.log('  achat is running.');
  console.log('');
  console.log('  OBS Browser Source (everything):  http://127.0.0.1:' + PORT + '/overlay?layer=all');
  console.log('  OBS Custom Browser Dock (panel):  ' + dockUrl);
  console.log('');
  console.log('  The dock link contains your private token. Do not show it on stream.');
  console.log('');
  for (const p of ['youtube', 'twitch', 'tiktok']) if (cfg.connections[p].enabled) startConnector(p);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  achat could not start: port ${PORT} is already in use.`);
    console.error('  An older achat is probably still running (maybe a minimized or hidden window).');
    console.error('  Double-click start.bat: it closes the old one and starts again.');
    console.error('');
  } else console.error(err);
  process.exit(1);
});
