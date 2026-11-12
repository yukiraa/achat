import fs from 'node:fs';
import path from 'node:path';

// Your own GIFs. Drop files into the custom-gifs folder:
//   custom-gifs/hug.gif   ->  viewers type !hug  or  !gif hug
// Only simple file names and image types are accepted, and only files that
// are in this list can ever be served, so nothing else on your PC is reachable.

export const CUSTOM_DIR = path.resolve('custom-gifs');
const TYPES = {
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};
const MAX_BYTES = 15 * 1024 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const RESERVED = new Set(['gif', 'battle', 'fight', 'accept', 'join', 'decline', 'skipgif', 'cancelbattle']);

export class CustomLibrary {
  constructor(log, onChange) {
    this.log = log;
    this.onChange = onChange;
    this.items = new Map(); // name -> { name, file, type, size }
    this.byFile = new Map(); // file -> item
    fs.mkdirSync(CUSTOM_DIR, { recursive: true });
    this.scan();
    try {
      fs.watch(CUSTOM_DIR, () => {
        clearTimeout(this.t);
        this.t = setTimeout(() => this.scan(), 400);
      });
    } catch {
      // watching is a convenience; the Rescan button still works
    }
  }

  scan() {
    const items = new Map();
    const byFile = new Map();
    const skipped = [];
    let files = [];
    try {
      files = fs.readdirSync(CUSTOM_DIR, { withFileTypes: true });
    } catch (err) {
      this.log(`Custom GIFs: cannot read folder (${err.message})`);
    }
    for (const d of files) {
      if (!d.isFile()) continue;
      const ext = path.extname(d.name).toLowerCase();
      if (!TYPES[ext]) continue;
      const name = path.basename(d.name, path.extname(d.name)).toLowerCase();
      if (!NAME_RE.test(name) || RESERVED.has(name)) {
        skipped.push(d.name);
        continue;
      }
      const full = path.join(CUSTOM_DIR, d.name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > MAX_BYTES) {
        skipped.push(d.name);
        continue;
      }
      if (items.has(name)) {
        skipped.push(d.name);
        continue;
      }
      const item = { name, file: d.name, type: TYPES[ext], size: st.size };
      items.set(name, item);
      byFile.set(d.name, item);
    }
    const before = [...this.items.keys()].join(',');
    this.items = items;
    this.byFile = byFile;
    if (before !== [...items.keys()].join(',')) {
      this.log(`Custom GIFs: ${items.size} loaded${skipped.length ? `, skipped ${skipped.join(', ')}` : ''}`);
      this.onChange?.();
    } else if (skipped.length) {
      this.log(`Custom GIFs skipped (check name, type or 15 MB size limit): ${skipped.join(', ')}`);
    }
  }

  get(name) {
    return this.items.get(String(name).toLowerCase()) || null;
  }

  url(item) {
    return `/custom/${encodeURIComponent(item.file)}`;
  }

  list() {
    return [...this.items.values()].map((i) => ({ name: i.name, url: this.url(i) }));
  }

  // Used by the web server: returns the file only if it is in the scanned list.
  resolve(encodedFile) {
    let file;
    try {
      file = decodeURIComponent(encodedFile);
    } catch {
      return null;
    }
    const item = this.byFile.get(file);
    if (!item) return null;
    const full = path.join(CUSTOM_DIR, item.file);
    if (path.dirname(full) !== CUSTOM_DIR) return null;
    return { full, type: item.type };
  }
}
