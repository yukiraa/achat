// Motion engine for the animated arrival styles (Curve, Accordion, Liquid).
//
// Every chat card becomes an Actor. Each frame the active preset moves the actors
// (springs, paths), then the stage writes one transform + opacity per card. Only
// transform and opacity change, so the browser never re-runs layout and OBS stays
// smooth. The cards themselves are the overlay's normal template cards.
//
// Presets are plain objects (see presets/index.js):
//   { id, prefs, setup(st), enter(a, st, adopt), tick(st, dt) }
// A preset moves st.live and also animates st.leaving, calling st.kill(a) when done.

import { clamp, lerp, ease } from './util.js';

export const DEFAULTS = { preset: 'curve-it', speed: 1, max: 8, life: 0, side: 'left', params: {} };

const SVGNS = 'http://www.w3.org/2000/svg';
let serial = 0;

export class Actor {
  constructor(msg, el) {
    this.id = msg.id;
    this.msg = msg;
    this.el = el;
    el.classList.add('mx-actor');
    this.serial = ++serial;
    this.seed = Math.random();
    this.w = 0;
    this.h = 0;
    // transform state (stage px, degrees)
    this.x = 0;
    this.y = 0;
    this.r = 0;
    this.s = 1;
    this.sx = 1;
    this.sy = 1;
    this.o = 1;
    this.rx = 0;
    this.v = {}; // spring velocities
    this.d = {}; // preset's private data
    this.age = 0;
    this.realAge = 0;
    this.state = 'live';
    this.ex = null;
    this.origin = '';
    this._t = '';
    this._o = '';
    this._z = '';
    this._origin = '';
  }

  snapshot() {
    return { x: this.x, y: this.y, r: this.r, s: this.s, sx: this.sx, sy: this.sy, o: this.o, rx: this.rx };
  }

  write(b) {
    const m = (k) => (b ? lerp(b.from[k], this[k], b.k) : this[k]);
    let r = this.r;
    if (b) {
      let fr = b.from.r;
      fr += Math.round((r - fr) / 360) * 360; // never spin the long way round
      r = lerp(fr, r, b.k);
    }
    const s = m('s');
    const rx = m('rx');
    let t = `translate3d(${m('x').toFixed(1)}px,${m('y').toFixed(1)}px,0) translate(-50%,-50%)`;
    if (rx) t += ` rotateX(${rx.toFixed(2)}deg)`;
    t += ` rotate(${r.toFixed(2)}deg) scale(${(m('sx') * s).toFixed(4)},${(m('sy') * s).toFixed(4)})`;
    if (t !== this._t) {
      this.el.style.transform = t;
      this._t = t;
    }
    const os = clamp(m('o'), 0, 1).toFixed(3);
    if (os !== this._o) {
      this.el.style.opacity = os;
      this._o = os;
    }
    const z = String(this.serial);
    if (z !== this._z) {
      this.el.style.zIndex = z;
      this._z = z;
    }
    if (this.origin !== this._origin) {
      this.el.style.transformOrigin = this.origin;
      this._origin = this.origin;
    }
  }
}

export class Stage {
  // host: element to fill. presets: { id: preset }. opts.makeCard(msg) -> element
  constructor(host, presets, opts = {}) {
    this.frame = this.frame.bind(this);
    this.host = host;
    this.presets = presets;
    this.makeCard = opts.makeCard;
    this.root = document.createElement('div');
    this.root.className = 'mx-stage';
    this.back = document.createElementNS(SVGNS, 'svg');
    this.back.setAttribute('class', 'mx-back');
    this.layer = document.createElement('div');
    this.layer.className = 'mx-actors';
    this.root.append(this.back, this.layer);
    host.append(this.root);

    this.settings = { ...DEFAULTS };
    this.actors = []; // oldest first
    this.live = []; // not leaving, newest first
    this.leaving = [];
    this.queue = [];
    this.nextEntry = 0;
    this.time = 0;
    this.state = {}; // preset's private stage data
    this.blend = null;
    this.running = false;
    this.pad = 28;
    this.preset = presets[this.settings.preset];
    this.resize();
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => this.resize()).observe(host);
    this.preset.setup?.(this);
  }

  // ---------------------------------------------------------------- settings
  get area() {
    const p = this.pad;
    return { x: p, y: p, w: this.W - p * 2, h: this.H - p * 2, r: this.W - p, b: this.H - p };
  }
  // x for a column of cards, honoring the chat side
  colX(w, offset = 0) {
    const A = this.area;
    if (this.settings.side === 'right') return A.r - w / 2 - offset;
    return A.x + w / 2 + offset;
  }

  resize() {
    this.W = this.host.clientWidth || window.innerWidth;
    this.H = this.host.clientHeight || window.innerHeight;
    this.back.setAttribute('viewBox', `0 0 ${this.W} ${this.H}`);
    this.back.setAttribute('width', String(this.W));
    this.back.setAttribute('height', String(this.H));
    this.wake();
  }

  apply(next) {
    this.settings = { ...DEFAULTS, ...next };
    if (this.settings.preset !== this.preset.id && this.presets[this.settings.preset]) this.switchPreset(this.settings.preset);
    // text size or card width may have changed
    for (const a of this.actors) this.measure(a);
    this.trim();
    this.wake();
  }

  measure(a) {
    a.w = a.el.offsetWidth;
    a.h = a.el.offsetHeight;
  }

  switchPreset(id) {
    const next = this.presets[id];
    for (const a of [...this.leaving]) this.kill(a);
    this.back.textContent = '';
    this.state = {};
    this.preset = next;
    this.root.classList.toggle('mx-3d', !!next.prefs?.perspective);
    next.setup?.(this);
    // glide from the old style's positions into the new one
    this.blend = { t: 0, dur: 0.7 };
    for (const a of this.actors) {
      a.blendFrom = a.snapshot();
      a.d = {};
      a.v = {};
      a.origin = '';
      a.rx = 0;
      a.sx = a.sy = 1;
      next.enter?.(a, this, true);
    }
    this.liveList();
  }

  // ---------------------------------------------------------------- messages
  push(msg) {
    if (!msg || !msg.id || this.actors.some((a) => a.id === msg.id)) return;
    this.queue.push(msg);
    if (this.queue.length > 30) this.queue.splice(0, this.queue.length - 30);
    this.wake();
  }

  spawn(msg) {
    const a = new Actor(msg, this.makeCard(msg));
    a.o = 0;
    a.el.style.opacity = '0';
    this.layer.append(a.el);
    this.measure(a);
    a.x = this.W / 2;
    a.y = this.H / 2;
    this.actors.push(a);
    this.liveList();
    this.preset.enter?.(a, this, false);
    this.trim();
    return a;
  }

  remove(id) {
    const a = this.actors.find((x) => x.id === id);
    if (a) this.retire(a);
    this.queue = this.queue.filter((m) => m.id !== id);
  }

  clear(instant) {
    this.queue.length = 0;
    for (const a of [...this.actors]) {
      if (instant) this.kill(a);
      else this.retire(a);
    }
  }

  // too many on screen: oldest ones leave
  trim() {
    const live = this.actors.filter((a) => a.state === 'live');
    for (let i = 0; i < live.length - this.settings.max; i++) this.retire(live[i]);
  }

  retire(a) {
    if (a.state !== 'live') return;
    a.state = 'leaving';
    a.ex = { t: 0 };
    this.liveList();
    this.wake();
  }

  kill(a) {
    a.el.remove();
    const i = this.actors.indexOf(a);
    if (i >= 0) this.actors.splice(i, 1);
    this.liveList();
  }

  liveList() {
    this.live = [];
    this.leaving = [];
    for (let i = this.actors.length - 1; i >= 0; i--) {
      const a = this.actors[i];
      if (a.state === 'live') {
        a.idx = this.live.length;
        this.live.push(a);
      } else this.leaving.push(a);
    }
  }

  // ---------------------------------------------------------------- loop
  wake() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  frame(now) {
    const real = clamp((now - this.last) / 1000, 0, 1 / 20);
    this.last = now;
    this.advance(real);
    // sleeps when nothing is on screen, so an idle overlay costs nothing
    if (this.actors.length || this.queue.length || this.blend) requestAnimationFrame(this.frame);
    else this.running = false;
  }

  advance(real) {
    const dt = real * this.settings.speed;
    this.time += dt;

    // entries: one at a time, faster when chat is busy
    if (this.queue.length && this.time >= this.nextEntry) {
      this.spawn(this.queue.shift());
      const busy = this.queue.length;
      this.nextEntry = this.time + (busy > 6 ? 0.07 : busy > 2 ? 0.16 : 0.38);
    }

    for (const a of this.actors) {
      a.age += dt;
      a.realAge += real;
      if (a.state === 'live' && this.settings.life > 0 && a.realAge > this.settings.life) this.retire(a);
    }

    try {
      this.preset.tick?.(this, dt);
    } catch (err) {
      console.error('[motion] preset error', err);
    }

    let b = null;
    if (this.blend) {
      this.blend.t += real;
      b = ease.inOut(clamp(this.blend.t / this.blend.dur, 0, 1));
      if (b >= 1) this.blend = null;
    }
    for (const a of this.actors) a.write(b !== null && a.blendFrom ? { k: b, from: a.blendFrom } : null);
  }

  // tests and debugging: advance by ms in 60fps steps
  step(ms) {
    for (let t = 0; t < ms; t += 1000 / 60) this.advance(1 / 60);
  }
}
