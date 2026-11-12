// The three animated arrival styles (dock: Style > Animation > How new messages
// arrive). Each moves the normal template cards; the look stays your template.

import { spring, clamp, lerp, ease, rand, DEG } from '../util.js';
import { stackTargets, follow, jelly } from './common.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.append(n);
  return n;
};
let uid = 0;

// ------------------------------------------------------------------ Curve
// The column bows into a gentle arc and messages glide along the curve itself,
// tilting with it, instead of moving in straight lines.
function curvePoint(st, s, L) {
  const u = clamp(s / L, -0.3, 1.3);
  const bulge = Math.min(220, st.W * 0.2);
  const dir = st.settings.side === 'right' ? -1 : 1;
  const off = Math.sin(u * Math.PI) * bulge * dir;
  const off2 = Math.sin((u + 0.01) * Math.PI) * bulge * dir;
  return { off, angle: Math.atan((off2 - off) / (0.01 * L)) * DEG };
}

export const curveIt = {
  id: 'curve-it',
  layout(st) {
    let s = 0;
    for (const a of st.live) {
      a.d.ts = s + a.h / 2;
      s += a.h + 12;
    }
    return st.area.h;
  },
  enter(a, st, adopt) {
    this.layout(st);
    a.d.s = adopt ? st.area.b - a.y : -a.h - 40;
    if (!adopt) a.o = 0;
  },
  tick(st, dt) {
    const L = this.layout(st);
    for (const a of st.live) {
      spring(a.d, 's', a.d.ts, Math.max(1.4, 2.6 - a.idx * 0.1), 0.7, dt);
      this.place(st, a, L);
      a.o = Math.min(1, a.o + dt * 4);
    }
    // leaving: carry on up the curve and fade
    for (const a of st.leaving) {
      a.ex.t += dt;
      a.d.s += dt * 260;
      this.place(st, a, L);
      a.o = Math.max(0, 1 - a.ex.t * 2.2);
      if (a.o <= 0) st.kill(a);
    }
  },
  place(st, a, L) {
    const p = curvePoint(st, a.d.s, L);
    a.x = st.colX(a.w) + p.off;
    a.y = st.area.b - a.d.s;
    a.r = clamp(-p.angle * 0.55, -16, 16);
  },
};

// ------------------------------------------------------------------ Accordion
// Older messages fold into a zig-zag accordion in 3D; the newest unfolds flat.
export const accordionIt = {
  id: 'accordion-it',
  prefs: { perspective: true },
  fold(a) {
    return Math.min(52, a.idx * 9) * (a.idx % 2 ? 1 : -1);
  },
  enter(a, st, adopt) {
    if (adopt) return;
    a.rx = -88;
    a.o = 0;
    stackTargets(st, { gap: 6 });
    a.x = a.d.tx;
    a.y = a.d.ty;
  },
  tick(st, dt) {
    stackTargets(st, { gap: 6, hMul: (x) => Math.max(0.3, Math.cos((x.rx * Math.PI) / 180)) });
    for (const a of st.live) {
      follow(a, dt, 3.2, 0.75);
      spring(a, 'rx', this.fold(a), 2.4, 0.45, dt);
      a.o = Math.min(clamp(1 - a.idx * 0.07, 0.5, 1), a.o + dt * 5);
      a.s = 1 - Math.min(0.1, a.idx * 0.015);
    }
    for (const a of st.leaving) {
      a.ex.t += dt;
      spring(a, 'rx', 90, 3, 0.9, dt);
      a.o = Math.max(0, a.o - dt * 3);
      if (a.o <= 0) st.kill(a);
    }
  },
};

// ------------------------------------------------------------------ Liquid
// Each message drips down as a droplet, splashes into the pool and spreads into
// its card. A gooey layer behind the cards melts neighbors together.
function cardColor(a) {
  const c = getComputedStyle(a.el).backgroundColor;
  return c && c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c) ? c : 'rgba(255,255,255,0.9)';
}

export const liquidChat = {
  id: 'liquid-chat',
  setup(st) {
    const id = `mxGoo${++uid}`;
    const defs = svg('defs', {}, st.back);
    const f = svg('filter', { id, x: '-20%', y: '-20%', width: '140%', height: '140%' }, defs);
    svg('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '11', result: 'b' }, f);
    svg('feColorMatrix', { in: 'b', mode: 'matrix', values: '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -10', result: 'g' }, f);
    svg('feComposite', { in: 'SourceGraphic', in2: 'g', operator: 'atop' }, f);
    st.state.goo = svg('g', { filter: `url(#${id})` }, st.back);
    st.state.rects = new Map();
    st.state.drops = [];
  },
  rect(st, a) {
    let r = st.state.rects.get(a);
    if (!r) {
      r = svg('rect', { fill: cardColor(a) }, st.state.goo);
      st.state.rects.set(a, r);
    }
    return r;
  },
  enter(a, st, adopt) {
    a.origin = '50% 100%';
    stackTargets(st, { gap: 6 });
    a.d.blob = adopt ? 1 : 0;
    if (adopt) return;
    a.d.phase = 'drip';
    a.x = a.d.tx;
    a.y = -40;
    a.d.vy = 0;
    a.o = 0;
  },
  tick(st, dt) {
    stackTargets(st, { gap: 6 });
    for (const a of st.live) {
      const d = a.d;
      if (d.phase === 'drip') {
        d.vy += 2600 * dt;
        a.y += d.vy * dt;
        a.x = d.tx;
        if (a.y >= d.ty) {
          a.y = d.ty;
          d.phase = 'pool';
          a.v.sy = -3;
          const fill = this.rect(st, a).getAttribute('fill');
          for (let i = 0; i < 5; i++) {
            const c = svg('circle', { r: rand(7, 14), fill }, st.state.goo);
            st.state.drops.push({ c, x: a.x + rand(-30, 30), y: a.y + a.h / 2 - 10, vx: rand(-260, 260), vy: -rand(300, 600), t: 0 });
          }
        }
      } else {
        follow(a, dt, 2.6, 0.55);
        d.blob = Math.min(1, d.blob + dt * 4);
        a.o = clamp((d.blob - 0.4) / 0.6, 0, 1);
        jelly(a, dt, 2.8, 0.2);
        // floating on the pool: a slow swell
        d.ty += Math.sin(st.time * 1.6 + a.idx * 0.9) * 3;
        a.x = d.tx + Math.sin(st.time * 1.1 + a.seed * 9) * 5;
      }
    }
    // leaving: evaporate upward
    for (const a of st.leaving) {
      a.ex.t += dt;
      a.y -= dt * 60;
      a.o = Math.max(0, a.o - dt * 3);
      a.d.blob = Math.max(0, (a.d.blob ?? 1) - dt * 1.8);
      if (a.d.blob <= 0) st.kill(a);
    }
    // the gooey blobs follow their card; a falling drip is a stretched droplet
    for (const [a, r] of st.state.rects) {
      if (!st.actors.includes(a)) {
        r.remove();
        st.state.rects.delete(a);
      }
    }
    for (const a of st.actors) {
      const r = this.rect(st, a);
      const d = a.d;
      let w;
      let h;
      if (d.phase === 'drip') {
        w = 46;
        h = 46 + clamp(d.vy / 20, 0, 60);
      } else {
        const k = ease.outBack(clamp(d.blob ?? 1, 0, 1), 1.4);
        w = lerp(46, a.w * a.sx * a.s + 12, k);
        h = lerp(46, a.h * a.sy * a.s + 12, k);
      }
      r.setAttribute('x', (a.x - w / 2).toFixed(1));
      r.setAttribute('y', (a.y - h / 2).toFixed(1));
      r.setAttribute('width', Math.max(0, w).toFixed(1));
      r.setAttribute('height', Math.max(0, h).toFixed(1));
      r.setAttribute('rx', Math.min(h / 2, 26).toFixed(1));
    }
    const D = st.state.drops;
    for (let i = D.length - 1; i >= 0; i--) {
      const p = D[i];
      p.t += dt;
      p.vy += 1800 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.c.setAttribute('cx', p.x.toFixed(1));
      p.c.setAttribute('cy', p.y.toFixed(1));
      p.c.setAttribute('r', Math.max(0, 12 - p.t * 14).toFixed(1));
      if (p.t > 0.85) {
        p.c.remove();
        D.splice(i, 1);
      }
    }
  },
};

export const PRESETS = { 'curve-it': curveIt, 'accordion-it': accordionIt, 'liquid-chat': liquidChat };
