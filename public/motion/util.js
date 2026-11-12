// Small math helpers shared by the motion engine and the presets.

export const DEG = 180 / Math.PI;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (lo = 0, hi = 1) => lo + Math.random() * (hi - lo);

// easing, t in 0..1
export const ease = {
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t, s = 1.70158) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
};

// Damped spring on obj[key], velocity kept in obj.v[key].
// f = natural frequency in Hz (how snappy), z = damping ratio (1 = no bounce, 0.2 = jelly).
// Sub-stepped so stiff springs stay stable at low frame rates.
export function spring(obj, key, target, f, z, dt) {
  const w = 2 * Math.PI * f;
  const k = w * w;
  const c = 2 * z * w;
  const v = obj.v || (obj.v = {});
  let x = obj[key];
  let vel = v[key] || 0;
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    vel += (k * (target - x) - c * vel) * h;
    x += vel * h;
  }
  obj[key] = x;
  v[key] = vel;
  return x;
}
