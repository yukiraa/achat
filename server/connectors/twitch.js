import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

// Read-only, anonymous Twitch chat. No login or key needed.
// Avatars come from decapi.me (a free community service); if it is down,
// the overlay falls back to a letter avatar.

function unescapeTag(v) {
  return v.replace(/\\(.)/g, (_, c) => ({ s: ' ', ':': ';', '\\': '\\', r: '\r', n: '\n' })[c] ?? c);
}

function parseTags(raw) {
  const tags = {};
  for (const pair of raw.split(';')) {
    const i = pair.indexOf('=');
    if (i > 0) tags[pair.slice(0, i)] = unescapeTag(pair.slice(i + 1));
  }
  return tags;
}

// Twitch emote positions count Unicode code points, not UTF-16 units.
function splitEmotes(text, emoteTag) {
  const chars = Array.from(text);
  if (!emoteTag) return [{ t: 'text', v: text }];
  const ranges = [];
  for (const group of emoteTag.split('/')) {
    const [id, spots] = group.split(':');
    if (!id || !spots || !/^[a-zA-Z0-9_]+$/.test(id)) continue;
    for (const spot of spots.split(',')) {
      const [s, e] = spot.split('-').map(Number);
      if (Number.isInteger(s) && Number.isInteger(e) && s <= e && e < chars.length) ranges.push({ id, s, e });
    }
  }
  ranges.sort((a, b) => a.s - b.s);
  const parts = [];
  let pos = 0;
  for (const r of ranges) {
    if (r.s < pos) continue;
    if (r.s > pos) parts.push({ t: 'text', v: chars.slice(pos, r.s).join('') });
    parts.push({
      t: 'emote',
      url: `https://static-cdn.jtvnw.net/emoticons/v2/${r.id}/default/dark/2.0`,
      alt: chars.slice(r.s, r.e + 1).join(''),
    });
    pos = r.e + 1;
  }
  if (pos < chars.length) parts.push({ t: 'text', v: chars.slice(pos).join('') });
  return parts;
}

const avatarCache = new Map();
async function fetchAvatar(login) {
  if (avatarCache.has(login)) return avatarCache.get(login);
  let url = null;
  try {
    const res = await fetch(`https://decapi.me/twitch/avatar/${encodeURIComponent(login)}`, {
      signal: AbortSignal.timeout(1500),
    });
    const body = (await res.text()).trim();
    if (res.ok && body.startsWith('https://')) url = body;
  } catch {
    // leave as null
  }
  if (avatarCache.size > 2000) avatarCache.clear();
  avatarCache.set(login, url);
  return url;
}

export class TwitchConnector extends EventEmitter {
  constructor(channel, log) {
    super();
    this.channel = channel.toLowerCase().replace(/^#/, '');
    this.log = log;
    this.ws = null;
    this.stopped = true;
    this.retry = 0;
    this.status = 'off';
    this.chain = Promise.resolve();
    this.awaitingPong = false;
  }

  setStatus(s, detail = '') {
    this.status = s;
    this.emit('status', s, detail);
  }

  start() {
    if (!this.channel) return this.setStatus('error', 'No Twitch channel set');
    this.stopped = false;
    this.open();
    this.checkViewers();
    clearInterval(this.viewerTimer);
    this.viewerTimer = setInterval(() => this.checkViewers(), 60000);
  }

  // Anonymous chat has no viewer count, so ask decapi.me (the same free service
  // used for avatars). It answers with a number, or "<name> is offline".
  async checkViewers() {
    let n = null;
    try {
      const res = await fetch(`https://decapi.me/twitch/viewercount/${encodeURIComponent(this.channel)}`, {
        signal: AbortSignal.timeout(8000),
      });
      const body = (await res.text()).trim();
      if (res.ok && /^\d+$/.test(body)) n = Number(body);
    } catch {
      // keep "unknown"
    }
    if (!this.stopped) this.emit('viewers', n);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.pinger);
    clearInterval(this.viewerTimer);
    this.emit('viewers', null);
    if (this.ws) this.ws.terminate();
    this.ws = null;
    this.setStatus('off');
  }

  open() {
    this.setStatus('connecting');
    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    this.ws = ws;
    ws.on('open', () => {
      this.awaitingPong = false;
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS SCHMOOPIIE');
      ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 89999)}`);
      ws.send(`JOIN #${this.channel}`);
    });
    ws.on('message', (data) => {
      for (const line of data.toString().split('\r\n')) {
        // handle lines strictly in order (avatar lookups must not reorder chat)
        if (line) this.chain = this.chain.then(() => this.handle(line)).catch((e) => this.log(`Twitch: ${e.message}`));
      }
    });
    // keepalive: if Twitch stops answering, reconnect instead of silently hanging
    clearInterval(this.pinger);
    this.pinger = setInterval(() => {
      if (ws.readyState !== 1) return;
      if (this.awaitingPong) return ws.terminate();
      this.awaitingPong = true;
      ws.send('PING :achat');
    }, 60000);
    ws.on('close', () => this.reconnect());
    ws.on('error', (err) => this.log(`Twitch error: ${err.message}`));
  }

  reconnect() {
    if (this.stopped) return;
    this.setStatus('connecting', 'Reconnecting');
    const wait = Math.min(30000, 1000 * 2 ** this.retry++);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => !this.stopped && this.open(), wait);
  }

  markLive() {
    this.retry = 0;
    if (this.status !== 'live') {
      this.setStatus('live', `#${this.channel}`);
      this.log(`Twitch: joined #${this.channel}`);
    }
  }

  async handle(line) {
    if (line.startsWith('PING')) return this.ws?.send('PONG :tmi.twitch.tv');
    if (/^:\S+ PONG /.test(line) || line.startsWith('PONG')) {
      this.awaitingPong = false;
      return;
    }
    let rest = line;
    let tags = {};
    if (rest.startsWith('@')) {
      const sp = rest.indexOf(' ');
      tags = parseTags(rest.slice(1, sp));
      rest = rest.slice(sp + 1);
    }
    // generic IRC parse: [:prefix] COMMAND param param ... [:trailing]
    let prefix = '';
    if (rest.startsWith(':')) {
      const sp = rest.indexOf(' ');
      prefix = rest.slice(1, sp);
      rest = rest.slice(sp + 1);
    }
    const colon = rest.indexOf(' :');
    const trailing = colon >= 0 ? rest.slice(colon + 2) : '';
    const head = (colon >= 0 ? rest.slice(0, colon) : rest).split(' ').filter(Boolean);
    const command = head[0] || '';

    // joined: Twitch confirms with 366 (end of names) or ROOMSTATE; either means we're in
    if (command === '366' || command === 'ROOMSTATE') {
      this.markLive();
      return;
    }
    if (command === 'RECONNECT') return this.ws?.terminate();
    if (command === 'NOTICE') {
      this.log(`Twitch notice: ${trailing}`);
      if (/suspended|does not exist|banned/i.test(trailing)) this.setStatus('error', trailing);
      return;
    }
    // a mod deleted one message, or timed out / banned a viewer (all their messages go)
    if (command === 'CLEARMSG') {
      if (tags['target-msg-id']) this.emit('delete', { ids: [tags['target-msg-id']] });
      return;
    }
    if (command === 'CLEARCHAT') {
      if (tags['target-user-id']) this.emit('delete', { userIds: [tags['target-user-id']] });
      else if (!trailing) this.emit('delete', { all: true }); // /clear
      return;
    }
    if (command !== 'PRIVMSG') return;
    this.markLive();

    let text = trailing;
    const action = text.startsWith('\u0001ACTION ') && text.endsWith('\u0001');
    if (action) text = text.slice(8, -1);

    const login = prefix.split('!')[0];
    const badges = tags.badges || '';
    const avatar = await fetchAvatar(login);
    this.emit('message', {
      platform: 'twitch',
      pid: tags.id || null,
      userId: tags['user-id'] || login,
      name: tags['display-name'] || login,
      avatar,
      color: tags.color || null,
      roles: {
        owner: /(^|,)broadcaster\//.test(badges),
        mod: /(^|,)moderator\//.test(badges),
        member: /(^|,)(subscriber|founder)\//.test(badges),
        vip: /(^|,)vip\//.test(badges),
      },
      text,
      parts: splitEmotes(text, tags.emotes),
    });
  }
}
