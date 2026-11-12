// Offline tests: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeImageUrl, safeGifUrl, hitsBlocklist, cleanText } from '../server/security.js';
import { applyPatch, DEFAULTS, dockView } from '../server/config.js';
import { resolveTarget, YouTubeConnector, apiItemToMessage } from '../server/connectors/youtube.js';
import { TwitchConnector } from '../server/connectors/twitch.js';
import { GifFeature } from '../server/features/gif.js';
import { PollFeature } from '../server/features/poll.js';

test('image URLs: only https on platform CDNs', () => {
  assert.ok(safeImageUrl('https://yt3.ggpht.com/abc=s64'));
  assert.ok(safeImageUrl('https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0'));
  assert.ok(safeImageUrl('https://p16-sign-va.tiktokcdn.com/x.webp'));
  assert.equal(safeImageUrl('http://yt3.ggpht.com/a'), null);
  assert.equal(safeImageUrl('javascript:alert(1)'), null);
  assert.equal(safeImageUrl('https://evil.com/yt3.ggpht.com'), null);
  assert.equal(safeImageUrl('https://yt3.ggpht.com.evil.com/a'), null);
  assert.equal(safeImageUrl('https://user:pw@yt3.ggpht.com/a'), null);
  assert.equal(safeGifUrl('https://media2.giphy.com/media/x/200.webp'), 'https://media2.giphy.com/media/x/200.webp');
  assert.equal(safeGifUrl('https://giphy.com.evil.net/a.gif'), null);
});

test('blocklist catches spacing and letter swaps', () => {
  const words = DEFAULTS.gif.blockedWords;
  assert.ok(hitsBlocklist('p 0 r n', words));
  assert.ok(hitsBlocklist('NUD3', words));
  assert.ok(hitsBlocklist('h.e.n.t.a.i', words));
  assert.ok(!hitsBlocklist('happy cat', words));
  assert.ok(!hitsBlocklist('cucumber dance', words));
});

test('text cleaning strips control and bidi characters', () => {
  assert.equal(cleanText('hi\u202Eevil\u0000  there'), 'hievil there');
  assert.equal(cleanText('x'.repeat(500)).length, 300);
});

test('settings patch rejects unknown keys and clamps numbers', () => {
  const cfg = structuredClone(DEFAULTS);
  const changed = applyPatch(cfg, {
    'chat.fontSize': 999,
    'chat.theme': 'hacker',
    'dockToken': 'x',
    'port': 1,
    'connections.twitch.channel': 'bad name!',
    'gif.giphyKey': '',
  });
  assert.deepEqual(changed, ['chat.fontSize']);
  assert.equal(cfg.chat.fontSize, 32);
  assert.equal(cfg.chat.theme, 'clean');
  assert.equal(cfg.port, 7788);
});

test('youtube target parsing', () => {
  assert.deepEqual(resolveTarget('@k3bae'), { page: 'https://www.youtube.com/@k3bae/live' });
  assert.deepEqual(resolveTarget('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), { videoId: 'dQw4w9WgXcQ' });
  assert.deepEqual(resolveTarget('https://youtu.be/dQw4w9WgXcQ'), { videoId: 'dQw4w9WgXcQ' });
  assert.deepEqual(resolveTarget('https://www.youtube.com/live/dQw4w9WgXcQ?si=x'), { videoId: 'dQw4w9WgXcQ' });
  assert.deepEqual(resolveTarget('UCxxxxxxxxxxxxxxxxxxxxxx'), { page: 'https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx/live' });
  assert.equal(resolveTarget('https://evil.com/watch?v=dQw4w9WgXcQ'), null);
});

test('youtube chat action parsing', () => {
  const yt = new YouTubeConnector('@x', () => {});
  yt.startedAt = 0;
  const got = [];
  yt.on('message', (m) => got.push(m));
  yt.handleAction({
    addChatItemAction: { item: { liveChatTextMessageRenderer: {
      id: 'a1', timestampUsec: '1',
      message: { runs: [{ text: 'hello ' }, { emoji: { emojiId: 'UCx/abc', isCustomEmoji: true, shortcuts: [':yay:'], image: { thumbnails: [{ url: 'https://yt3.ggpht.com/e1' }] } } }, { emoji: { emojiId: '😀', image: { thumbnails: [] } } }] },
      authorName: { simpleText: 'Viewer One' },
      authorPhoto: { thumbnails: [{ url: 'https://yt4.ggpht.com/p' }] },
      authorExternalChannelId: 'UC1',
      authorBadges: [{ liveChatAuthorBadgeRenderer: { icon: { iconType: 'MODERATOR' } } }],
    } } },
  });
  yt.handleAction({ addChatItemAction: { item: { liveChatTextMessageRenderer: { id: 'a1', timestampUsec: '1', message: { runs: [] } } } } });
  assert.equal(got.length, 1, 'duplicate id is dropped');
  assert.equal(got[0].name, 'Viewer One');
  assert.equal(got[0].roles.mod, true);
  assert.deepEqual(got[0].parts.map((p) => p.t), ['text', 'emote', 'text']);
  assert.equal(got[0].text, 'hello :yay:😀');
});

test('twitch IRC parsing with emotes and tags', async () => {
  const tw = new TwitchConnector('chan', () => {});
  const got = [];
  tw.on('message', (m) => got.push(m));
  global.fetch = async () => ({ ok: false, text: async () => '' });
  await tw.handle('@badges=moderator/1,subscriber/12;color=#FF69B4;display-name=Luna\\sStar;emotes=25:6-10;user-id=42 :luna!luna@luna.tmi.twitch.tv PRIVMSG #chan :hello Kappa !gif cat');
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'Luna Star');
  assert.equal(got[0].roles.mod, true);
  assert.equal(got[0].roles.member, true);
  assert.equal(got[0].parts[1].t, 'emote');
  assert.equal(got[0].parts[1].alt, 'Kappa');
  assert.equal(got[0].text, 'hello Kappa !gif cat');
});

test('gif: filters ratings, blocklist, cooldowns and budget', async () => {
  const cfg = structuredClone(DEFAULTS);
  cfg.gif.provider = 'giphy';
  cfg.gif.giphyKey = 'k';
  cfg.gif.location = 'layout';
  const sent = [];
  const logs = [];
  let calls = 0;
  global.fetch = async (url) => {
    calls++;
    assert.match(String(url), /rating=g/);
    return {
      ok: true, status: 200,
      json: async () => ({ data: [
        { rating: 'r', title: 'bad', images: { fixed_height: { webp: 'https://media1.giphy.com/r.webp' } } },
        { rating: 'g', title: 'nsfw cat', images: { fixed_height: { webp: 'https://media1.giphy.com/n.webp' } } },
        { rating: 'g', title: 'evil host', images: { fixed_height: { webp: 'https://evil.com/x.webp' } } },
        { rating: 'g', title: 'cute cat', images: { fixed_height: { webp: 'https://media1.giphy.com/ok.webp' } } },
      ] }),
    };
  };
  const gif = new GifFeature(() => cfg, (m) => sent.push(m), (l) => logs.push(l));
  const u1 = { key: 'yt:1', name: 'a', platform: 'youtube' };
  const u2 = { key: 'tw:2', name: 'b', platform: 'twitch' };
  await gif.request(u1, 'cute cat');
  assert.equal(sent[0].gif.url, 'https://media1.giphy.com/ok.webp');
  await gif.request(u1, 'dog');
  assert.equal(sent.length, 1, 'user cooldown');
  await gif.request(u2, 'dog');
  assert.equal(sent.length, 1, 'global cooldown');
  await gif.request(u2, 'p0rn', { bypassCooldown: true });
  assert.ok(logs.some((l) => l.includes('blocked')));
  const before = calls;
  await gif.request(u2, 'cute cat', { bypassCooldown: true });
  assert.equal(calls, before, 'cached search does not use budget');
  clearTimeout(gif.timer);
});

test('gif location and master switch', async () => {
  const cfg = structuredClone(DEFAULTS);
  const sent = [];
  const logs = [];
  const gif = new GifFeature(() => cfg, (m) => sent.push(m), (l) => logs.push(l));
  const u = { key: 'yt:1', name: 'a', platform: 'youtube' };
  const entry = { cmd: 'x03', file: 'a'.repeat(32) + '.gif' };

  // GIF ON + Chat -> into chat, never the layout box
  cfg.gif.location = 'chat';
  gif.custom(u, entry, { bypassCooldown: true });
  gif.sample(u);
  assert.equal(sent.filter((m) => m.type === 'gif:chat').length, 2);
  assert.equal(sent.filter((m) => m.type === 'gif').length, 0);

  // GIF ON + Layout -> into the layout box, never chat
  sent.length = 0;
  cfg.gif.location = 'layout';
  gif.sample(u);
  assert.equal(sent.filter((m) => m.type === 'gif').length, 1);
  assert.equal(sent.filter((m) => m.type === 'gif:chat').length, 0);
  const shown = sent.find((m) => m.type === 'gif').gif.id;
  gif.skip();
  assert.ok(sent.some((m) => m.type === 'gif:remove' && m.id === shown));
  clearTimeout(gif.timer);

  // GIF OFF -> nothing at all, from any path
  sent.length = 0;
  cfg.gif.enabled = false;
  gif.custom(u, entry, { bypassCooldown: true });
  gif.sample(u);
  await gif.request(u, 'cat', { bypassCooldown: true });
  assert.equal(sent.filter((m) => m.type === 'gif' || m.type === 'gif:chat').length, 0);
  assert.ok(logs.some((l) => /switched off/.test(l)));
});

test('youtube live detection: /live page variants', () => {
  const yt = new YouTubeConnector('@x', () => {});
  const canonA = '<link rel="canonical" href="https://www.youtube.com/watch?v=AAAAAAAAAAA">';
  const canonB = '<link href="https://www.youtube.com/watch?v=BBBBBBBBBBB" rel="canonical">';
  assert.deepEqual(yt.inspectLivePage(canonA + '"isLiveNow":true'), { videoId: 'AAAAAAAAAAA', state: 'live' });
  assert.deepEqual(yt.inspectLivePage(canonB + '"isLive":true'), { videoId: 'BBBBBBBBBBB', state: 'live' });
  assert.deepEqual(yt.inspectLivePage('"videoDetails":{"videoId":"CCCCCCCCCCC","isLive":true'), { videoId: 'CCCCCCCCCCC', state: 'live' });
  assert.equal(yt.inspectLivePage(canonA + '"isUpcoming":true').state, 'upcoming');
  assert.equal(yt.inspectLivePage('<html>channel home</html>').state, 'none');
});

test('youtube live detection: Streams tab fallback', () => {
  const yt = new YouTubeConnector('@x', () => {});
  const data = { contents: { tabs: [{ items: [
    { videoRenderer: { videoId: 'OLDOLDOLDOL', thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { style: 'DEFAULT' } }] } },
    { videoRenderer: { videoId: 'LIVELIVELIV', thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { style: 'LIVE' } }] } },
  ] }] } };
  const html = `<script>var ytInitialData = ${JSON.stringify(data)};</script>`;
  assert.equal(yt.findLiveInStreamsTab(html), 'LIVELIVELIV');
  assert.equal(yt.findLiveInStreamsTab('<script>var ytInitialData = {"a":1};</script>'), null);
});

test('twitch keeps message order even when avatar lookups are slow', async () => {
  const tw = new TwitchConnector('chan', () => {});
  const got = [];
  tw.on('message', (m) => got.push(m.name));
  let first = true;
  global.fetch = async () => {
    if (first) {
      first = false;
      await new Promise((r) => setTimeout(r, 150)); // slow lookup for the first user
    }
    return { ok: false, text: async () => '' };
  };
  tw.ws = { send() {} };
  const line = (n) => `@display-name=${n};user-id=${n} :${n}!${n}@${n}.tmi.twitch.tv PRIVMSG #chan :hi`;
  for (const n of ['slowuser', 'fastuser']) tw.chain = tw.chain.then(() => tw.handle(line(n)));
  await tw.chain;
  assert.deepEqual(got, ['slowuser', 'fastuser']);
});

test('color settings only accept hex colors', () => {
  const cfg = structuredClone(DEFAULTS);
  applyPatch(cfg, { 'chat.bgColor': 'red; background:url(x)', 'chat.borderColor': '#AABBCC', 'chat.bgOpacity': 150 });
  assert.equal(cfg.chat.bgColor, '#ffffff');
  assert.equal(cfg.chat.borderColor, '#aabbcc');
  assert.equal(cfg.chat.bgOpacity, 100);
});

test('klipy: parses results, skips ad slots and foreign hosts, unlimited mode', async () => {
  const cfg = structuredClone(DEFAULTS);
  cfg.gif.provider = 'klipy';
  cfg.gif.klipyKey = 'KEY';
  cfg.gif.hourlyBudget = 0; // unlimited
  cfg.gif.mode = 'chat'; // no queue, so every request reaches the search
  cfg.installId = 'abcdef0123456789';
  const sent = [];
  let calls = 0;
  global.fetch = async (url) => {
    calls++;
    const u = String(url);
    assert.match(u, /^https:\/\/api\.klipy\.com\/api\/v1\/KEY\/gifs\/search\?/);
    assert.match(u, /rating=g/);
    return {
      ok: true, status: 200,
      json: async () => ({ result: true, data: { data: [
        { type: 'ad', file: { md: { gif: { url: 'https://static.klipy.com/ad.gif' } } } },
        { type: 'gif', title: 'evil', file: { md: { webp: { url: 'https://evil.example/x.webp' } } } },
        { type: 'gif', title: 'nude cat', file: { md: { webp: { url: 'https://static.klipy.com/n.webp' } } } },
        { type: 'gif', title: 'happy cat', slug: 'happy-cat', file: { md: { webp: { url: 'https://static.klipy.com/ok.webp' } } } },
      ] } }),
    };
  };
  const gif = new GifFeature(() => cfg, (m) => sent.push(m), () => {});
  for (let i = 0; i < 150; i++) await gif.request({ key: 'u' + i, name: 'v', platform: 'twitch' }, 'happy cat ' + i, { bypassCooldown: true });
  const shown = sent.filter((m) => m.type === 'gif' || m.type === 'gif:chat');
  assert.ok(shown.length > 0);
  assert.ok(shown.every((m) => m.gif.url === 'https://static.klipy.com/ok.webp'), 'only the safe, non-ad result');
  assert.equal(calls, 150, 'no hourly cap when limit is 0');
  assert.equal(shown[0].gif.source, 'klipy');
  clearTimeout(gif.timer);
});

test('klipy: missing key explains itself', async () => {
  const cfg = structuredClone(DEFAULTS);
  const logs = [];
  const gif = new GifFeature(() => cfg, () => {}, (l) => logs.push(l));
  await gif.request({ key: 'u', name: 'v', platform: 'twitch' }, 'cat', { bypassCooldown: true });
  assert.match(logs[0], /no KLIPY key/);
});

// ---- full YouTube detection flow against fake pages ----
function fakeYouTube(pages) {
  return async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/youtubei/v1/live_chat/get_live_chat')) {
      return { ok: true, status: 200, url: u, json: async () => ({ continuationContents: { liveChatContinuation: { actions: [], continuations: [{ timedContinuationData: { continuation: 'NEXT', timeoutMs: 60000 } }] } } }) };
    }
    const key = Object.keys(pages).find((k) => u.includes(k));
    const page = key ? pages[key] : { status: 404, text: '' };
    return { ok: (page.status || 200) < 400, status: page.status || 200, url: page.finalUrl || u, text: async () => page.text };
  };
}
const CHAT_OK = '"INNERTUBE_API_KEY":"k","INNERTUBE_CLIENT_VERSION":"2.2026","continuation":"C1"';
async function runDetect(pages) {
  global.fetch = fakeYouTube(pages);
  const logs = [];
  const yt = new YouTubeConnector('@LofiGirl', (l) => logs.push(l));
  const states = [];
  yt.on('status', (s, d) => states.push(`${s}: ${d}`));
  yt.stopped = false;
  await yt.findStream();
  yt.stop();
  return { states, logs };
}

test('youtube flow: watch link without a live flag is verified through chat and connects', async () => {
  const { states } = await runDetect({
    '/@LofiGirl/live': { text: '<link rel="canonical" href="https://www.youtube.com/watch?v=jfKfPfyJRdk"><title>lofi hip hop radio</title>' },
    '/live_chat': { text: CHAT_OK },
  });
  assert.ok(states.some((s) => s.startsWith('live: video jfKfPfyJRdk')), states.join(' | '));
});

test('youtube flow: falls back to the Streams tab', async () => {
  const data = { x: [{ videoRenderer: { videoId: 'STREAMLIVE1', badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW' } }] } }] };
  const { states } = await runDetect({
    '/@LofiGirl/live': { text: '<title>Lofi Girl - YouTube</title>' },
    '/@LofiGirl/streams': { text: `<script>var ytInitialData = ${JSON.stringify(data)};</script>` },
    '/live_chat': { text: CHAT_OK },
  });
  assert.ok(states.some((s) => s.startsWith('live: video STREAMLIVE1')), states.join(' | '));
});

test('youtube flow: not live stays waiting, and consent pages are reported', async () => {
  let r = await runDetect({
    '/@LofiGirl/live': { text: '<title>Lofi Girl - YouTube</title>' },
    '/@LofiGirl/streams': { text: '<script>var ytInitialData = {"a":1};</script>' },
  });
  assert.ok(r.states.at(-2).startsWith('waiting: Not live yet'), r.states.join(' | '));
  r = await runDetect({
    '/@LofiGirl/live': { text: '<form>consent</form>', finalUrl: 'https://consent.youtube.com/m?continue=x' },
  });
  assert.ok(r.logs.some((l) => /consent page/.test(l)), r.logs.join(' | '));
});

test('poll: one vote per viewer, can change, winner and tie', () => {
  const cfg = structuredClone(DEFAULTS);
  const sent = [];
  const p = new PollFeature(() => cfg, (m) => sent.push(m), () => {});
  assert.ok(p.start('Q?', ['only one'], 30).error, 'needs two options');
  assert.ok(p.start('', ['a', 'b'], 30).error, 'needs a question');
  assert.ok(p.start('Best snack?', ['Mochi', 'Takoyaki', 'Onigiri'], 30).ok);
  p.vote({ key: 'yt:1' }, '1');
  p.vote({ key: 'tw:2' }, '2');
  p.vote({ key: 'tt:3' }, '2');
  p.vote({ key: 'yt:1' }, '2'); // changes vote
  p.vote({ key: 'yt:9' }, '7'); // out of range, ignored
  p.vote({ key: 'yt:8' }, 'abc'); // ignored
  let v = p.view();
  assert.deepEqual(v.counts, [0, 3, 0]);
  p.end();
  v = p.view();
  assert.equal(v.ended, true);
  assert.equal(v.winner, 1);
  p.vote({ key: 'late' }, '1');
  assert.deepEqual(p.view().counts, [0, 3, 0], 'no votes after the end');
  // tie
  p.start('Tie?', ['a', 'b'], 30);
  p.vote({ key: 'x' }, '1');
  p.vote({ key: 'y' }, '2');
  p.end();
  assert.equal(p.view().winner, -2);
  p.clear();
  assert.equal(p.view().active, false);
});

test('twitch turns green on join confirmation and on first message', async () => {
  const tw = new TwitchConnector('chan', () => {});
  const states = [];
  tw.on('status', (s) => states.push(s));
  global.fetch = async () => ({ ok: false, text: async () => '' });
  tw.ws = { send() {} };
  await tw.handle(':justinfan123.tmi.twitch.tv 366 justinfan123 #chan :End of /NAMES list');
  assert.deepEqual(states, ['live']);
  const tw2 = new TwitchConnector('chan', () => {});
  const st2 = [];
  tw2.on('status', (s) => st2.push(s));
  tw2.ws = { send() {} };
  await tw2.handle('@display-name=A;user-id=1 :a!a@a.tmi.twitch.tv PRIVMSG #chan :hi :)');
  assert.deepEqual(st2, ['live']);
});

test('config: template vs Custom CSS and colors only on Default', async () => {
  const { effectiveTheme, overlayView } = await import('../server/config.js');
  const cfg = structuredClone(DEFAULTS);
  cfg.chat.useThemeColors = false;
  cfg.chat.theme = 'clean';
  assert.equal(effectiveTheme(cfg), 'clean');
  assert.equal(overlayView(cfg).chat.useThemeColors, false, 'Default keeps custom colors');
  cfg.chat.theme = 'dark';
  assert.equal(overlayView(cfg).chat.useThemeColors, true, 'Dark ignores custom colors');
  cfg.chat.lookMode = 'custom';
  assert.equal(effectiveTheme(cfg), 'custom');
  cfg.chat.lookMode = 'template';
  assert.equal(effectiveTheme(cfg), 'dark', 'switching back restores the template');
  assert.deepEqual(applyPatch(cfg, { 'chat.theme': 'custom' }), [], 'custom is a mode, not a template');
  assert.deepEqual(applyPatch(cfg, { 'ui.dockTheme': 'dark', 'gif.location': 'layout', 'poll.location': 'chat' }).sort(), ['gif.location', 'ui.dockTheme']);
});

test('formal dock style is gone and old settings fall back to light', () => {
  const cfg = structuredClone(DEFAULTS);
  assert.deepEqual(applyPatch(cfg, { 'ui.dockTheme': 'formal' }), []);
  assert.equal(cfg.ui.dockTheme, 'light');
});

test('mod deletions are reported by YouTube and Twitch', async () => {
  const yt = new YouTubeConnector('@x', () => {});
  const ydel = [];
  yt.on('delete', (d) => ydel.push(d));
  yt.handleAction({ markChatItemAsDeletedAction: { targetItemId: 'a1' } });
  yt.handleAction({ removeChatItemByAuthorAction: { externalChannelId: 'UC1' } });
  assert.deepEqual(ydel, [{ ids: ['a1'] }, { userIds: ['UC1'] }]);

  const tw = new TwitchConnector('chan', () => {});
  const tdel = [];
  const msgs = [];
  tw.on('delete', (d) => tdel.push(d));
  tw.on('message', (m) => msgs.push(m));
  global.fetch = async () => ({ ok: false, text: async () => '' });
  await tw.handle('@id=abc-1;user-id=42 :luna!luna@luna.tmi.twitch.tv PRIVMSG #chan :hello');
  await tw.handle('@login=luna;target-msg-id=abc-1 :tmi.twitch.tv CLEARMSG #chan :hello');
  await tw.handle('@ban-duration=600;target-user-id=42 :tmi.twitch.tv CLEARCHAT #chan :luna');
  await tw.handle(':tmi.twitch.tv CLEARCHAT #chan');
  assert.equal(msgs[0].pid, 'abc-1');
  assert.deepEqual(tdel, [{ ids: ['abc-1'] }, { userIds: ['42'] }, { all: true }]);
});

test('templates: the new ones are accepted, removed ones are not', () => {
  const cfg = structuredClone(DEFAULTS);
  for (const t of ['dark', 'cloud', 'bunny', 'matcha', 'starlight', 'kitty', 'clean']) {
    assert.deepEqual(applyPatch(cfg, { 'chat.theme': t }), ['chat.theme'], t);
  }
  for (const t of ['light', 'sakura', 'midnight', 'glass', 'kawaii', 'bow']) {
    assert.deepEqual(applyPatch(cfg, { 'chat.theme': t }), [], `${t} was removed`);
  }
});

test('EAAK styles were removed, GIF size in chat is adjustable', () => {
  const cfg = structuredClone(DEFAULTS);
  for (const t of ['eaak-star', 'eaak-goat', 'eaak-crimson']) {
    assert.deepEqual(applyPatch(cfg, { 'chat.theme': t }), [], t);
    assert.deepEqual(applyPatch(cfg, { 'clock.style': t }), [], `clock ${t}`);
  }
  assert.deepEqual(applyPatch(cfg, { 'gif.chatSize': 480 }), ['gif.chatSize']);
  assert.equal(cfg.gif.chatSize, 480);
  applyPatch(cfg, { 'gif.chatSize': 5000 });
  assert.ok(cfg.gif.chatSize <= 600, 'capped at 600px');
});

test('clock settings: look, parts, and a Layout box', () => {
  const cfg = structuredClone(DEFAULTS);
  assert.equal(cfg.clock.enabled, false, 'off until the streamer turns it on');
  assert.deepEqual(applyPatch(cfg, { 'clock.enabled': true, 'clock.style': 'theme', 'clock.hour12': true }).sort(), ['clock.enabled', 'clock.hour12', 'clock.style']);
  assert.deepEqual(applyPatch(cfg, { 'clock.style': 'neon' }), [], 'unknown looks are rejected');
  assert.deepEqual(applyPatch(cfg, { 'clock.style': 'kitty', 'clock.dateFormat': 'short' }).sort(), ['clock.dateFormat', 'clock.style'], 'a template just for the clock');
  assert.deepEqual(applyPatch(cfg, { 'clock.style': 'outline' }), ['clock.style']);
  assert.deepEqual(applyPatch(cfg, { 'clock.dateFormat': 'weird' }), []);
  assert.deepEqual(applyPatch(cfg, { 'layout.clock': { x: 100, y: 50, w: 300, h: 120 } }), ['layout.clock']);
  assert.equal(cfg.layout.clock.w, 300);
});

test('featured messages: duration and where they appear', () => {
  const cfg = structuredClone(DEFAULTS);
  assert.equal(cfg.featured.location, 'chat', 'pinned at the top of chat by default');
  assert.deepEqual(applyPatch(cfg, { 'featured.location': 'layout', 'featured.seconds': 45 }).sort(), ['featured.location', 'featured.seconds']);
  assert.deepEqual(applyPatch(cfg, { 'featured.location': 'sidebar' }), []);
  applyPatch(cfg, { 'featured.seconds': 9999 });
  assert.equal(cfg.featured.seconds, 600, 'clamped');
  assert.deepEqual(applyPatch(cfg, { 'layout.featured': { x: 10, y: 10, w: 500, h: 200 } }), ['layout.featured']);
});

test('youtube flow: a scheduled stream reads its chat right away', async () => {
  // the /live page shows a scheduled (upcoming) stream whose chat is already open
  let r = await runDetect({
    '/@LofiGirl/live': { text: '<link rel="canonical" href="https://www.youtube.com/watch?v=SCHEDULED01"><title>Soon</title> "isUpcoming":true' },
    '/live_chat': { text: CHAT_OK },
  });
  assert.ok(r.states.some((s) => s.startsWith('live: scheduled stream SCHEDULED01')), r.states.join(' | '));
  // only the Streams tab knows about the scheduled stream
  const data = { x: [{ videoRenderer: { videoId: 'SCHEDULED02', upcomingEventData: { startTime: '1790700000' } } }] };
  r = await runDetect({
    '/@LofiGirl/live': { text: '<title>Lofi Girl - YouTube</title>' },
    '/@LofiGirl/streams': { text: `<script>var ytInitialData = ${JSON.stringify(data)};</script>` },
    '/live_chat': { text: CHAT_OK },
  });
  assert.ok(r.states.some((s) => s.startsWith('live: scheduled stream SCHEDULED02')), r.states.join(' | '));
  // scheduled, but chat not open yet: keeps waiting and says why
  r = await runDetect({
    '/@LofiGirl/live': { text: '<link rel="canonical" href="https://www.youtube.com/watch?v=SCHEDULED03"><title>Soon</title> "isUpcoming":true' },
    '/@LofiGirl/streams': { text: '<script>var ytInitialData = {"a":1};</script>' },
    '/live_chat': { text: 'chat is disabled' },
  });
  assert.ok(r.states.some((s) => s.startsWith("waiting: Scheduled stream found, but its chat isn't open yet")), r.states.join(' | '));
});

test('Curve, Accordion and Liquid are arrival choices', () => {
  const cfg = structuredClone(DEFAULTS);
  for (const m of ['curve', 'accordion', 'liquid']) assert.deepEqual(applyPatch(cfg, { 'chat.animMode': m }), ['chat.animMode'], m);
  assert.deepEqual(applyPatch(cfg, { 'chat.animMode': 'orbit' }), [], 'removed styles are rejected');
});

test('YouTube Data API: key stays private, messages convert', () => {
  const cfg = structuredClone(DEFAULTS);
  assert.deepEqual(applyPatch(cfg, { 'connections.youtube.apiKey': 'AIza-abc_123', 'connections.youtube.useApi': true }).sort(), [
    'connections.youtube.apiKey',
    'connections.youtube.useApi',
  ]);
  assert.deepEqual(applyPatch(cfg, { 'connections.youtube.apiKey': 'has spaces!' }), [], 'odd characters rejected');
  const v = dockView(cfg);
  assert.equal(v.connections.youtube.apiKey, '');
  assert.equal(v.connections.youtube.hasApiKey, true);
  assert.deepEqual(applyPatch(cfg, { 'connections.youtube.apiInterval': 1 }), ['connections.youtube.apiInterval']);
  assert.equal(cfg.connections.youtube.apiInterval, 3, 'never polls faster than every 3s');

  const text = apiItemToMessage({
    id: 'm1',
    snippet: { type: 'textMessageEvent', textMessageDetails: { messageText: 'hello <b>' } },
    authorDetails: { channelId: 'UC1', displayName: 'Mochi', profileImageUrl: 'https://yt3.ggpht.com/a', isChatModerator: true },
  });
  assert.equal(text.name, 'Mochi');
  assert.equal(text.text, 'hello <b>');
  assert.equal(text.roles.mod, true);
  assert.equal(text.paid, undefined);
  const sc = apiItemToMessage({
    id: 'm2',
    snippet: { type: 'superChatEvent', superChatDetails: { amountDisplayString: '$5.00', userComment: 'yay' } },
    authorDetails: { displayName: 'Bun', isChatSponsor: true },
  });
  assert.deepEqual(sc.paid, { amount: '$5.00' });
  assert.equal(sc.roles.member, true);
  assert.equal(apiItemToMessage({ id: 'm3', snippet: { type: 'pollEvent' } }), null);
});
