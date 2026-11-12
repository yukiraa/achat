import { EventEmitter } from 'node:events';

// Reads YouTube live chat the same way the youtube.com chat window does
// (the internal "youtubei" endpoint). No API key or quota needed.
// This is unofficial: if YouTube changes its page, this file is what needs fixing.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
// SOCS is YouTube's current "consent given" cookie; CONSENT is the older one
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' };

// Accepts @handle, channel ID (UC...), a video ID, or any youtube.com URL.
export function resolveTarget(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  try {
    const u = new URL(t);
    if (/(^|\.)youtube\.com$/.test(u.hostname) || u.hostname === 'youtu.be') {
      const v = u.searchParams.get('v') || (u.hostname === 'youtu.be' ? u.pathname.slice(1) : null);
      if (v && /^[\w-]{11}$/.test(v)) return { videoId: v };
      const live = u.pathname.match(/^\/live\/([\w-]{11})/);
      if (live) return { videoId: live[1] };
      const handle = u.pathname.match(/^\/(@[\w.-]+)/);
      if (handle) return { page: `https://www.youtube.com/${handle[1]}/live` };
      const ch = u.pathname.match(/^\/channel\/(UC[\w-]{22})/);
      if (ch) return { page: `https://www.youtube.com/channel/${ch[1]}/live` };
    }
    return null;
  } catch {
    // not a URL
  }
  if (/^UC[\w-]{22}$/.test(t)) return { page: `https://www.youtube.com/channel/${t}/live` };
  if (/^@[\w.-]{3,}$/.test(t)) return { page: `https://www.youtube.com/${t}/live` };
  if (/^[\w-]{11}$/.test(t)) return { videoId: t };
  return null;
}

function runsToParts(runs = []) {
  const parts = [];
  for (const r of runs) {
    if (typeof r.text === 'string') parts.push({ t: 'text', v: r.text });
    else if (r.emoji) {
      const e = r.emoji;
      if (!e.isCustomEmoji && e.emojiId && [...e.emojiId].length <= 4) {
        parts.push({ t: 'text', v: e.emojiId }); // standard emoji: keep as text
      } else {
        const thumbs = e.image?.thumbnails || [];
        const url = thumbs[thumbs.length - 1]?.url;
        const alt = e.shortcuts?.[0] || e.searchTerms?.[0] || ':emoji:';
        if (url) parts.push({ t: 'emote', url: url.startsWith('//') ? 'https:' + url : url, alt });
      }
    }
  }
  return parts;
}

function partsToText(parts) {
  return parts.map((p) => (p.t === 'text' ? p.v : p.alt)).join('');
}

function badgeRoles(badges = []) {
  const roles = { owner: false, mod: false, member: false, vip: false };
  for (const b of badges) {
    const r = b.liveChatAuthorBadgeRenderer;
    if (!r) continue;
    const icon = r.icon?.iconType;
    if (icon === 'OWNER') roles.owner = true;
    else if (icon === 'MODERATOR') roles.mod = true;
    else if (r.customThumbnail) roles.member = true;
  }
  return roles;
}

// Official YouTube Data API v3 (optional, needs the streamer's own API key).
// Finding the stream still uses the page check above (free); only reading chat
// goes through the API: videos.list (1 unit) once, then liveChatMessages.list
// (5 units) every few seconds.
const API = 'https://www.googleapis.com/youtube/v3';

function apiRoles(a = {}) {
  return { owner: !!a.isChatOwner, mod: !!a.isChatModerator, member: !!a.isChatSponsor, vip: false };
}

// One liveChatMessage resource into achat's message shape (null = not a chat line)
export function apiItemToMessage(item) {
  const sn = item && item.snippet;
  const au = (item && item.authorDetails) || {};
  if (!sn) return null;
  let text = '';
  let paid = null;
  if (sn.type === 'textMessageEvent') text = sn.textMessageDetails?.messageText ?? sn.displayMessage ?? '';
  else if (sn.type === 'superChatEvent') {
    text = sn.superChatDetails?.userComment || sn.displayMessage || '';
    paid = { amount: sn.superChatDetails?.amountDisplayString || '' };
  } else if (sn.type === 'superStickerEvent') {
    text = sn.superStickerDetails?.superStickerMetadata?.altText || 'Super Sticker';
    paid = { amount: sn.superStickerDetails?.amountDisplayString || '' };
  } else return null;
  if (!text) return null;
  const msg = {
    platform: 'youtube',
    pid: item.id,
    userId: au.channelId || sn.authorChannelId || au.displayName,
    name: au.displayName || 'viewer',
    avatar: au.profileImageUrl || null,
    color: null,
    roles: apiRoles(au),
    text,
    parts: [{ t: 'text', v: text }],
  };
  if (paid) msg.paid = paid;
  return msg;
}

export class YouTubeConnector extends EventEmitter {
  constructor(target, log, opts = {}) {
    super();
    this.apiKey = opts.apiKey || '';
    this.apiInterval = Math.max(3, Number(opts.apiInterval) || 8) * 1000;
    this.target = resolveTarget(target);
    this.rawTarget = target;
    this.log = log;
    this.stopped = true;
    this.status = 'off';
    this.seen = new Set();
  }

  setStatus(s, detail = '') {
    this.status = s;
    this.emit('status', s, detail);
    if (s !== 'live') {
      clearInterval(this.viewerTimer);
      this.emit('viewers', null);
    }
  }

  // "1,234 watching now": the same number the watch page shows, asked for every 30s.
  async checkViewers() {
    if (this.stopped || !this.chat || this.chat.api) return;
    const { key, version, videoId } = this.chat;
    try {
      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/updated_metadata?prettyPrint=false${key ? `&key=${key}` : ''}`,
        {
          method: 'POST',
          headers: { ...HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: version } }, videoId }),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!res.ok) return;
      const data = await res.json();
      for (const a of data?.actions || []) {
        const r = a.updateViewershipAction?.viewCount?.videoViewCountRenderer;
        if (!r) continue;
        const raw = r.originalViewCount ?? r.viewCount?.simpleText ?? r.viewCount?.runs?.map((x) => x.text).join('') ?? '';
        const n = Number(String(raw).replace(/[^\d]/g, ''));
        if (String(raw).match(/\d/) && Number.isFinite(n) && this.status === 'live') this.emit('viewers', n);
        return;
      }
    } catch {
      // try again next round
    }
  }

  start() {
    if (!this.target) return this.setStatus('error', 'Enter a @handle, channel ID, video ID or link');
    this.stopped = false;
    this.findStream();
  }

  // Writes the last pages YouTube returned into a folder, so they can be inspected.
  saveDebug(dir, fs, path) {
    fs.mkdirSync(dir, { recursive: true });
    const saved = [];
    for (const [label, d] of Object.entries(this.debug || {})) {
      const safe = label.replace(/[^a-z0-9-]/gi, '_').slice(0, 40);
      const header = `<!-- url: ${d.url}\n final: ${d.finalUrl}\n status: ${d.status}\n at: ${d.at} -->\n`;
      fs.writeFileSync(path.join(dir, `youtube-${safe}.html`), header + d.text);
      saved.push(`youtube-${safe}.html`);
    }
    return saved;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.viewerTimer);
    this.setStatus('off');
  }

  later(fn, ms) {
    clearTimeout(this.timer);
    if (!this.stopped) this.timer = setTimeout(() => !this.stopped && fn(), ms);
  }

  // Only log a check result when it changes, so waiting doesn't flood the log.
  logOnce(line) {
    this.lastLines = this.lastLines || new Set();
    if (this.lastLines.has(line)) return;
    if (this.lastLines.size > 20) this.lastLines.clear();
    this.lastLines.add(line);
    this.log(line);
  }

  async fetchText(url, label) {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    // keep the last copy of each page so it can be saved for debugging
    this.debug = this.debug || {};
    this.debug[label || url] = { url, finalUrl: res.url, status: res.status, at: new Date().toISOString(), text };
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
    if (/consent\.youtube\.com|consent\.google\.com/.test(res.url)) {
      throw new Error('YouTube sent a cookie consent page instead of the channel');
    }
    if (/confirm you.{0,3}re not a bot|unusual traffic/i.test(text)) {
      throw new Error('YouTube is asking for a bot check from this PC');
    }
    return text;
  }

  // Short summary of what a page contained, for the log.
  describe(html) {
    const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || 'no title';
    const canon = (html.match(/rel="canonical"[^>]*href="([^"]+)"/) || html.match(/href="([^"]+)"[^>]*rel="canonical"/) || [])[1] || 'none';
    return `title="${title.slice(0, 60)}" canonical=${canon.replace('https://www.youtube.com', '')} size=${Math.round(html.length / 1024)}KB`;
  }

  // Method 1: the channel's /live page. Returns { videoId, state } where state is
  // 'live', 'upcoming', 'members', or 'none'.
  inspectLivePage(html) {
    const canon =
      html.match(/<link[^>]+rel="canonical"[^>]+href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/) ||
      html.match(/<link[^>]+href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"[^>]+rel="canonical"/);
    const details = html.match(/"videoDetails":\{"videoId":"([\w-]{11})"/);
    const videoId = canon?.[1] || details?.[1] || null;
    if (!videoId) return { videoId: null, state: 'none' };
    if (/"isUpcoming":true/.test(html) && !/"isLiveNow":true/.test(html)) return { videoId, state: 'upcoming' };
    if (/"status":"LOGIN_REQUIRED"/.test(html) || /members-only|membersOnly|"SPONSORS_ONLY"/i.test(html)) {
      if (!/"isLiveNow":true|"isLive":true/.test(html)) return { videoId, state: 'members' };
    }
    if (/\\?"isLiveNow\\?":\s*true|\\?"isLive\\?":\s*true|"style":"LIVE"|BADGE_STYLE_TYPE_LIVE_NOW/.test(html)) {
      return { videoId, state: 'live' };
    }
    // The /live page of a channel that isn't live normally shows the channel
    // home with no watch link at all. A watch link without a clear flag is
    // most likely live, so it gets verified by trying to open its chat.
    return { videoId, state: 'maybe' };
  }

  // Method 2: the channel's Streams tab. Finds any video marked LIVE.
  findLiveInStreamsTab(html) {
    const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s) || html.match(/ytInitialData"?\]? ?= ?(\{.*?\});<\/script>/s);
    if (!m) return null;
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      return null;
    }
    let found = null;
    let upcoming = null;
    const walk = (o, depth) => {
      if (found || !o || typeof o !== 'object' || depth > 40) return;
      if (typeof o.videoId === 'string' && /^[\w-]{11}$/.test(o.videoId)) {
        const txt = JSON.stringify(o);
        if (/"style":"LIVE"|BADGE_STYLE_TYPE_LIVE_NOW|"iconType":"LIVE"/.test(txt)) {
          found = o.videoId;
          return;
        }
        // a scheduled stream: its chat is usually open already (the waiting room)
        if (!upcoming && /"style":"UPCOMING"|"upcomingEventData"/.test(txt)) upcoming = o.videoId;
      }
      for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v, depth + 1);
    };
    walk(data, 0);
    this.upcomingInStreams = upcoming;
    return found;
  }

  async findStream() {
    this.setStatus('connecting', 'Looking for a live stream');
    try {
      let videoId = this.target.videoId;
      if (!videoId) {
        const page = this.target.page;
        const livePage = await this.fetchText(page, 'live-page');
        const info = this.inspectLivePage(livePage);
        this.logOnce(`YouTube /live check: video=${info.videoId || 'none'} state=${info.state} (${this.describe(livePage)})`);

        if (info.state === 'live') videoId = info.videoId;
        if (info.state === 'maybe') {
          const opened = await this.openChat(info.videoId, { quiet: true });
          if (opened) return;
        }
        // scheduled stream: read its waiting-room chat now; when it goes live
        // it's the same chat, so reading simply carries on
        if (info.state === 'upcoming') {
          const opened = await this.openChat(info.videoId, { quiet: true, scheduled: true });
          if (opened) return;
        }
        if (!videoId) {
          const streamsUrl = page.replace(/\/live$/, '/streams');
          const streams = await this.fetchText(streamsUrl, 'streams-tab');
          const found = this.findLiveInStreamsTab(streams);
          this.logOnce(`YouTube Streams tab check: ${found ? 'live video ' + found : this.upcomingInStreams ? 'scheduled video ' + this.upcomingInStreams : 'no LIVE video found'}`);
          if (found) videoId = found;
          else if (this.upcomingInStreams && this.upcomingInStreams !== info.videoId) {
            const opened = await this.openChat(this.upcomingInStreams, { quiet: true, scheduled: true });
            if (opened) return;
          }
        }
        if (!videoId) {
          const why = {
            upcoming: "Scheduled stream found, but its chat isn't open yet",
            members: 'Looks members-only; paste the video link to try, members-only chat may not be readable',
            none: 'Not live yet',
          }[info.state] || 'Not live yet';
          this.setStatus('waiting', `${why}, checking every 30s`);
          return this.later(() => this.findStream(), 30000);
        }
      }
      await this.openChat(videoId);
    } catch (err) {
      // YouTube's bot check and network hiccups are usually brief: try again
      // quickly at first, then back off to every 30s
      this.fails = (this.fails || 0) + 1;
      const wait = [5, 10, 20][this.fails - 1] || 30;
      this.log(`YouTube: ${err.message} (try ${this.fails}, next in ${wait}s)`);
      const bot = /bot check/i.test(err.message);
      this.setStatus(
        'waiting',
        bot
          ? `YouTube asked for a bot check, retrying in ${wait}s. If it keeps happening, paste the stream's video link instead`
          : `Could not reach YouTube, retrying in ${wait}s`,
      );
      this.later(() => this.findStream(), wait * 1000);
    }
  }

  async openChat(videoId, opts = {}) {
    if (this.apiKey && !this.apiFailed) {
      try {
        return await this.openApiChat(videoId, opts);
      } catch (err) {
        this.log(`YouTube API: ${err.message}. Using the default method instead.`);
        this.apiFailed = true;
      }
    }
    return this.openPageChat(videoId, opts);
  }

  async api(path, params) {
    const q = new URLSearchParams({ ...params, key: this.apiKey });
    const res = await fetch(`${API}/${path}?${q}`, { signal: AbortSignal.timeout(10000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || `HTTP ${res.status}`;
      const err = new Error(`${reason}${data?.error?.message ? ` (${data.error.message})` : ''}`);
      err.reason = reason;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async openApiChat(videoId, { quiet = false, scheduled = false } = {}) {
    const data = await this.api('videos', { part: 'liveStreamingDetails', id: videoId });
    const chatId = data.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
    if (!chatId) {
      this.logOnce(`YouTube API: video ${videoId} has no active live chat`);
      if (quiet) return false;
      this.setStatus('waiting', 'Chat not available (chat off, or stream not started), retrying in 30s');
      this.later(() => this.findStream(), 30000);
      return false;
    }
    this.chat = { videoId, api: true, chatId, pageToken: null, first: true };
    this.fails = 0;
    this.setStatus('live', `${scheduled ? 'scheduled stream' : 'video'} ${videoId} (official API, every ${this.apiInterval / 1000}s)`);
    this.log(`YouTube: reading chat of ${videoId} through the YouTube Data API`);
    this.apiPoll();
    // viewer count: 1 quota unit a minute
    const viewers = async () => {
      try {
        const d = await this.api('videos', { part: 'liveStreamingDetails', id: videoId });
        const n = Number(d.items?.[0]?.liveStreamingDetails?.concurrentViewers);
        if (Number.isFinite(n) && this.status === 'live') this.emit('viewers', n);
      } catch {
        // try again next minute
      }
    };
    viewers();
    clearInterval(this.viewerTimer);
    this.viewerTimer = setInterval(viewers, 60000);
    return true;
  }

  async apiPoll() {
    if (this.stopped || !this.chat?.api) return;
    const c = this.chat;
    try {
      const params = { liveChatId: c.chatId, part: 'snippet,authorDetails', maxResults: '200', profileImageSize: '88' };
      if (c.pageToken) params.pageToken = c.pageToken;
      const data = await this.api('liveChat/messages', params);
      c.pageToken = data.nextPageToken || c.pageToken;
      // the first page is history from before we connected: skip it
      if (!c.first) {
        for (const item of data.items || []) {
          const t = item.snippet?.type;
          if (t === 'messageDeletedEvent' && item.snippet.messageDeletedDetails?.deletedMessageId) {
            this.emit('delete', { ids: [item.snippet.messageDeletedDetails.deletedMessageId] });
            continue;
          }
          if (t === 'userBannedEvent' && item.snippet.userBannedDetails?.bannedUserDetails?.channelId) {
            this.emit('delete', { userIds: [item.snippet.userBannedDetails.bannedUserDetails.channelId] });
            continue;
          }
          if (!item.id || this.seen.has(item.id)) continue;
          this.seen.add(item.id);
          const msg = apiItemToMessage(item);
          if (msg) this.emit('message', msg);
        }
        if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2000));
      } else for (const item of data.items || []) if (item.id) this.seen.add(item.id);
      c.first = false;
      if (data.offlineAt) {
        this.log('YouTube API: stream ended');
        this.setStatus('waiting', 'Stream ended, waiting for the next one');
        return this.later(() => this.findStream(), 30000);
      }
      this.later(() => this.apiPoll(), Math.max(this.apiInterval, Number(data.pollingIntervalMillis) || 0));
    } catch (err) {
      if (/quota|dailyLimit|rateLimit|forbidden|keyInvalid|API_KEY|PERMISSION_DENIED/i.test(err.reason || err.message)) {
        this.log(`YouTube API stopped: ${err.message}. Switching to the default method.`);
        this.apiFailed = true;
        return this.openPageChat(c.videoId).catch(() => this.later(() => this.findStream(), 30000));
      }
      if (/liveChatEnded|liveChatNotFound|liveChatDisabled/i.test(err.reason || '') || err.status === 404) {
        this.log(`YouTube API: ${err.reason || 'chat closed'}`);
        this.setStatus('waiting', 'Stream ended or chat closed, waiting for the next one');
        return this.later(() => this.findStream(), 30000);
      }
      this.log(`YouTube API poll error: ${err.message}`);
      this.later(() => this.apiPoll(), 10000);
    }
  }

  async openPageChat(videoId, { quiet = false, scheduled = false } = {}) {
    const html = await this.fetchText(`https://www.youtube.com/live_chat?is_popout=1&v=${videoId}`, 'chat-page');
    const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
    const version =
      html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] || html.match(/"clientVersion":"([\d.]+)"/)?.[1];
    const continuation = html.match(/"continuation":"([^"]+)"/)?.[1];
    if (!version || !continuation) {
      const reason = /LOGIN_REQUIRED|sign in/i.test(html)
        ? 'Chat needs a login (members-only or age-restricted)'
        : 'Chat not available (chat off, or stream not started)';
      this.logOnce(`YouTube: ${reason} for video ${videoId} (${this.describe(html)})`);
      if (quiet) return false;
      this.setStatus('waiting', `${reason}, retrying in 30s`);
      this.later(() => this.findStream(), 30000);
      return false;
    }
    this.chat = { videoId, key, version, continuation };
    this.fails = 0;
    this.startedAt = Date.now() * 1000 - 5_000_000; // microseconds, skip old backlog
    this.setStatus('live', scheduled ? `scheduled stream ${videoId} (chat is open)` : `video ${videoId}`);
    this.log(`YouTube: reading chat of ${scheduled ? 'scheduled stream ' : ''}${videoId}`);
    this.poll();
    this.checkViewers();
    clearInterval(this.viewerTimer);
    this.viewerTimer = setInterval(() => this.checkViewers(), 30000);
    return true;
  }

  async poll() {
    if (this.stopped) return;
    const { key, version, continuation } = this.chat;
    const url = `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?prettyPrint=false${key ? `&key=${key}` : ''}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: version } }, continuation }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const lcc = data?.continuationContents?.liveChatContinuation;
      const next = lcc?.continuations?.[0];
      const cont = next?.invalidationContinuationData || next?.timedContinuationData || next?.reloadContinuationData;
      if (!lcc || !cont?.continuation) {
        this.log('YouTube: stream ended or chat closed');
        this.setStatus('waiting', 'Stream ended, waiting for the next one');
        return this.later(() => this.findStream(), 30000);
      }
      this.chat.continuation = cont.continuation;
      for (const action of lcc.actions || []) this.handleAction(action);
      const wait = Math.min(5000, Math.max(1000, Number(cont.timeoutMs) || 1500));
      this.later(() => this.poll(), wait);
    } catch (err) {
      this.log(`YouTube poll error: ${err.message}`);
      this.later(() => this.poll(), 5000);
    }
  }

  handleAction(action) {
    // a mod deleted one message, or removed every message from a viewer
    const del = action.markChatItemAsDeletedAction || action.removeChatItemAction;
    if (del?.targetItemId) return this.emit('delete', { ids: [del.targetItemId] });
    const byAuthor = action.markChatItemsByAuthorAsDeletedAction || action.removeChatItemByAuthorAction;
    if (byAuthor?.externalChannelId) return this.emit('delete', { userIds: [byAuthor.externalChannelId] });
    const item = action.addChatItemAction?.item;
    if (!item) return;
    const r = item.liveChatTextMessageRenderer || item.liveChatPaidMessageRenderer;
    if (!r || !r.id || this.seen.has(r.id)) return;
    if (Number(r.timestampUsec) < this.startedAt) return;
    this.seen.add(r.id);
    if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2000));

    const parts = runsToParts(r.message?.runs);
    const thumbs = r.authorPhoto?.thumbnails || [];
    const msg = {
      platform: 'youtube',
      pid: r.id,
      userId: r.authorExternalChannelId || r.authorName?.simpleText,
      name: r.authorName?.simpleText || 'viewer',
      avatar: thumbs[thumbs.length - 1]?.url || null,
      color: null,
      roles: badgeRoles(r.authorBadges),
      text: partsToText(parts),
      parts,
    };
    if (item.liveChatPaidMessageRenderer) msg.paid = { amount: r.purchaseAmountText?.simpleText || '' };
    this.emit('message', msg);
  }
}
