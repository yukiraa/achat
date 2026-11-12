import { EventEmitter } from 'node:events';

// TikTok has no official live chat API. This uses the open-source
// tiktok-live-connector library, which needs a signing service (Euler Stream).
// Free use is rate-limited; a sign key from eulerstream.com raises the limit.
// It is loaded lazily so a TikTok problem can never stop YouTube or Twitch.

export class TikTokConnector extends EventEmitter {
  constructor(username, signKey, log) {
    super();
    this.username = String(username || '').replace(/^@/, '');
    this.signKey = signKey || undefined;
    this.log = log;
    this.stopped = true;
    this.status = 'off';
    this.conn = null;
  }

  setStatus(s, detail = '') {
    this.status = s;
    this.emit('status', s, detail);
    if (s !== 'live') {
      clearInterval(this.viewerTimer);
      this.emit('viewers', null);
    }
  }

  setViewers(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return;
    this.viewersAt = Date.now();
    this.emit('viewers', Math.round(n));
  }

  // The count normally arrives by itself (roomUser). Some rooms rarely send it,
  // so when it goes quiet for a minute, ask TikTok's room info instead.
  async refreshViewers() {
    if (this.stopped || this.status !== 'live' || !this.conn) return;
    if (Date.now() - (this.viewersAt || 0) < 50000) return;
    try {
      const info = await this.conn.fetchRoomInfo();
      this.setViewers(info?.data?.user_count ?? info?.user_count);
    } catch {
      // try again next minute
    }
  }

  start() {
    this.username = this.username.replace(/^https?:\/\/(www\.)?tiktok\.com\//, '').replace(/\/live.*$/, '').replace(/^@/, '').trim();
    if (!this.username) return this.setStatus('error', 'No TikTok username set');
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.viewerTimer);
    try {
      this.conn?.disconnect();
    } catch {
      // ignore
    }
    this.conn = null;
    this.setStatus('off');
  }

  later(fn, ms) {
    clearTimeout(this.timer);
    if (!this.stopped) this.timer = setTimeout(() => !this.stopped && fn(), ms);
  }

  async connect() {
    this.setStatus('connecting', `@${this.username}`);
    let lib;
    try {
      lib = await import('tiktok-live-connector');
    } catch (err) {
      this.log(`TikTok library failed to load: ${err.message}`);
      return this.setStatus('error', 'TikTok library missing, run npm install');
    }
    const { TikTokLiveConnection, WebcastEvent, ControlEvent } = lib;
    try {
      if (this.conn) {
        this.conn.removeAllListeners?.();
        try {
          await this.conn.disconnect();
        } catch {
          // already closed
        }
      }
      this.conn = new TikTokLiveConnection(this.username, {
        signApiKey: this.signKey,
        processInitialData: false,
        enableExtendedGiftInfo: false,
      });
      this.conn.on(WebcastEvent.CHAT, (d) => this.onChat(d));
      // TikTok pushes the current viewer count every few seconds
      this.conn.on(WebcastEvent.ROOM_USER, (d) => this.setViewers(d?.viewerCount ?? d?.viewer_count));
      // a mod deleted messages, or every message from a viewer
      this.conn.on(WebcastEvent.IM_DELETE, (d) =>
        this.emit('delete', { ids: d?.deleteMsgIdsList || [], userIds: d?.deleteUserIdsList || [] }),
      );
      this.conn.on(ControlEvent.DISCONNECTED, () => {
        if (this.stopped) return;
        this.setStatus('waiting', 'Disconnected, retrying in 30s');
        this.later(() => this.connect(), 30000);
      });
      this.conn.on(WebcastEvent.STREAM_END, () => {
        this.setStatus('waiting', 'Stream ended, checking every 60s');
        this.later(() => this.connect(), 60000);
      });
      this.conn.on(ControlEvent.ERROR, (e) => this.log(`TikTok: ${e?.message || e?.info || 'error'}`));
      const state = await this.conn.connect();
      this.setStatus('live', `@${this.username}`);
      this.log(`TikTok: connected to @${this.username}`);
      this.viewersAt = 0;
      this.setViewers(state?.roomInfo?.data?.user_count ?? state?.roomInfo?.user_count);
      clearInterval(this.viewerTimer);
      this.viewerTimer = setInterval(() => this.refreshViewers(), 60000);
    } catch (err) {
      const msg = err?.message || String(err);
      const offline = /offline|not live|UserOffline/i.test(msg + (err?.name || ''));
      const limited = /rate|limit|429/i.test(msg);
      this.log(`TikTok: ${msg}`);
      if (offline) this.setStatus('waiting', 'Not live yet, checking every 60s');
      else if (limited) this.setStatus('waiting', 'Sign server rate limit, retrying in 2 min');
      else this.setStatus('waiting', 'Could not connect, retrying in 60s');
      this.later(() => this.connect(), limited ? 120000 : 60000);
    }
  }

  onChat(d) {
    const u = d?.user || {};
    const thumbs = u.avatarThumb?.urlList || [];
    const ident = d?.userIdentity || {};
    const text = typeof d?.content === 'string' ? d.content : typeof d?.comment === 'string' ? d.comment : '';
    this.emit('message', {
      platform: 'tiktok',
      pid: d?.common?.msgId || null,
      userId: u.userId || u.id || u.displayId || u.uniqueId || u.nickname,
      name: u.nickname || u.displayId || u.uniqueId || 'viewer',
      avatar: thumbs[0] || null,
      color: null,
      roles: {
        owner: !!ident.isAnchor,
        mod: !!ident.isModeratorOfAnchor,
        member: !!ident.isSubscriberOfAnchor,
        vip: false,
      },
      text,
      parts: [{ t: 'text', v: text }],
    });
  }
}
