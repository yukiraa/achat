// Building blocks shared by the presets.

import { spring } from '../util.js';

// Column layout, newest at the bottom. Writes a.d.tx / a.d.ty.
// opts.gap, opts.hMul(a) height multiplier (folded cards take less room)
export function stackTargets(st, opts = {}) {
  const gap = opts.gap ?? 12;
  let y = st.area.b;
  for (const a of st.live) {
    const h = a.h * (opts.hMul ? opts.hMul(a) : 1);
    a.d.ty = y - h / 2;
    a.d.tx = st.colX(a.w);
    y -= h + gap;
  }
}

// Jelly: a.sy springs to 1 with low damping; sx keeps the volume roughly constant.
export function jelly(a, dt, f = 3.6, z = 0.24) {
  spring(a, 'sy', 1, f, z, dt);
  a.sx = 1 + (1 - a.sy) * 0.9;
}

// Follow d.tx/d.ty with springs. Higher-up (older) cards are a little lazier,
// which gives free follow-through when the stack shifts.
export function follow(a, dt, f = 3, z = 0.6, lag = 0.12) {
  const ff = Math.max(f * 0.5, f - a.idx * lag);
  spring(a, 'x', a.d.tx, ff, z, dt);
  spring(a, 'y', a.d.ty, ff, z, dt);
}
