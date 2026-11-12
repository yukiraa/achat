// Everything that comes from chat is untrusted. These helpers are the only way
// chat data reaches the overlay: text is cleaned and capped, and image URLs must
// be https on a known platform CDN. The overlay itself also only ever uses
// textContent and img.src, never innerHTML, so even a bad value cannot become code.

const IMAGE_HOSTS = [
  /^yt[3-4]\.ggpht\.com$/,
  /^yt[3-4]\.googleusercontent\.com$/,
  /^lh[3-6]\.googleusercontent\.com$/,
  /^static-cdn\.jtvnw\.net$/,
  /^[a-z0-9-]+\.tiktokcdn(-us|-eu)?\.com$/,
  /^[a-z0-9-]+\.ibyteimg\.com$/,
];

const GIF_HOSTS = [/^media[0-9]?\.giphy\.com$/, /^i\.giphy\.com$/, /^static\.klipy\.com$/];

function checkUrl(raw, hosts) {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password || u.port) return null;
  if (!hosts.some((re) => re.test(u.hostname))) return null;
  return u.toString();
}

export const safeImageUrl = (raw) => checkUrl(raw, IMAGE_HOSTS);
export const safeGifUrl = (raw) => checkUrl(raw, GIF_HOSTS);

// Strip control characters and bidi overrides, collapse whitespace, cap length.
export function cleanText(raw, max = 300) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// Same cleaning for a piece of a message, but keeps single spaces at the edges
// so text next to an emote does not get glued together.
export function cleanFragment(raw, max = 300) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, max);
}

export function cleanName(raw) {
  return cleanText(raw, 40) || 'viewer';
}

// Hex color only, used for Twitch name colors.
export function cleanColor(raw) {
  return typeof raw === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : null;
}

// Lowercase, undo common letter swaps, drop everything that is not a letter or digit.
export function normalizeForFilter(s) {
  const map = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[013457@$!]/g, (c) => map[c])
    .replace(/[^a-z0-9]/g, '');
}

export function hitsBlocklist(text, words) {
  const n = normalizeForFilter(text);
  return words.some((w) => {
    const nw = normalizeForFilter(w);
    return nw.length > 0 && n.includes(nw);
  });
}

export function userKey(platform, id) {
  return `${platform}:${String(id).toLowerCase()}`;
}
