// Game-feel effects on GSAP (self-hosted: CDNs are filtered for some players).
// Everything here is decoration. GSAP is fetched in the background after the app is up (init), so it never
// delays the first screen on a slow network; until it arrives, or if it fails, or the player prefers
// reduced motion, every export is a no-op and the game works exactly the same.
import { I } from './icons.js';

const VENDOR = 'vendor/gsap-3.13.0/';
let G;
export let gsap;
export let on = false;

const script = src => new Promise((ok, fail) => {
  const s = document.createElement('script');
  s.src = VENDOR + src; s.async = false; s.onload = ok; s.onerror = fail;
  document.head.append(s);
});
export function init() {
  if (G || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  script('gsap.min.js').then(() => script('Physics2DPlugin.min.js')).then(() => {
    gsap = G = window.gsap;
    G.registerPlugin(window.Physics2DPlugin);
    G.defaults({ duration: 0.45, ease: 'power3.out' });
    G.matchMedia().add({ full: '(prefers-reduced-motion: no-preference)' }, ctx => { on = ctx.conditions.full; document.documentElement.classList.toggle('fx', on); });
  }).catch(() => {});
}

const R = (a, b) => G.utils.random(a, b);
let layer;
function fxLayer() {
  if (!layer) { layer = document.createElement('div'); layer.className = 'fx-layer'; layer.setAttribute('aria-hidden', 'true'); document.body.append(layer); }
  return layer;
}
const center = el => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
function particle(cls, x, y, html = '') {
  const p = document.createElement('i');
  p.className = cls; p.innerHTML = html;
  G.set(p, { x, y, xPercent: -50, yPercent: -50 });
  fxLayer().append(p);
  return p;
}

// burst of sparks flying out of an element (gem found / bomb debris)
export function sparks(el, { colors = ['#22d3ee', '#a5f3fc', '#a855f7', '#fff'], count = 16, power = [180, 420], gravity = 500, size = [4, 9] } = {}) {
  if (!on || !el) return;
  const [x, y] = center(el);
  for (let i = 0; i < count; i++) {
    const p = particle('fx-spark', x, y), s = R(...size);
    G.set(p, { width: s, height: s, background: G.utils.random(colors) });
    G.to(p, { duration: R(0.6, 1.1), physics2D: { velocity: R(...power), angle: R(0, 360), gravity }, autoAlpha: 0, scale: 0.2, ease: 'none', onComplete: () => p.remove() });
  }
}

// expanding ring from an element
export function ring(el, color = '#22d3ee') {
  if (!on || !el) return;
  const [x, y] = center(el), { width } = el.getBoundingClientRect();
  const p = particle('fx-ring', x, y);
  G.set(p, { width, height: width, borderColor: color });
  G.fromTo(p, { scale: 0.4, autoAlpha: 0.9 }, { scale: 2.2, autoAlpha: 0, duration: 0.6, onComplete: () => p.remove() });
}

export function shake(el, s = 12) {
  if (!on || !el) return;
  G.to(el, { keyframes: { x: [0, -s, s, -s * 0.7, s * 0.7, -s * 0.4, s * 0.4, 0] }, duration: 0.5, ease: 'none', clearProps: 'x' });
}

export function flash(color = 'rgba(239,68,68,.45)') {
  if (!on) return;
  const p = document.createElement('i'); p.className = 'fx-flash'; p.style.background = `radial-gradient(circle at 50% 45%, ${color}, transparent 70%)`;
  fxLayer().append(p);
  G.timeline({ onComplete: () => p.remove() }).fromTo(p, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.08, ease: 'none' }).to(p, { autoAlpha: 0, duration: 0.5 });
}

// coins arc from one element into another (cash out -> wallet); resolves when the first coin lands
export function coinsTo(fromEl, toEl, count = 12) {
  if (!on || !fromEl || !toEl) return Promise.resolve();
  const [x0, y0] = center(fromEl), [x1, y1] = center(toEl);
  return new Promise(done => {
    for (let i = 0; i < count; i++) {
      const p = particle('fx-coin', x0 + R(-60, 60), y0 + R(-10, 10), I.coin);
      const d = R(0.65, 0.85);
      // x and y on different eases bend the path into an arc (no MotionPath plugin needed)
      G.timeline({ delay: i * 0.045, onComplete: () => { p.remove(); if (i === 0) done(); if (i === count - 1) bump(toEl); } })
        .from(p, { scale: 0, duration: 0.18, ease: 'back.out(3)' })
        .to(p, { x: x1, duration: d, ease: 'power2.out', rotation: R(-360, 360), scale: 0.6 })
        .to(p, { y: y1, duration: d, ease: 'back.in(2.2)' }, '<');
    }
  });
}

export function bump(el, scale = 1.18) {
  if (!on || !el) return;
  G.fromTo(el, { scale }, { scale: 1, duration: 0.6, ease: 'elastic.out(1, 0.4)', clearProps: 'scale' });
}

// number ticker (balance, payouts)
export function countTo(el, from, to, format, { delay = 0, duration = 0.9 } = {}) {
  if (!el) return;
  el._count?.kill();
  if (!on) { el.textContent = format(to); return; }
  const o = { v: from };
  el._count = G.to(o, { v: to, delay, duration, ease: 'power2.out', onUpdate: () => { el.textContent = format(Math.round(o.v * 100) / 100); }, onComplete: () => { el.textContent = format(to); } });
}

// falling confetti from both bottom corners (big wins)
export function confetti(count = 70) {
  if (!on) return;
  const colors = ['#ec4899', '#a855f7', '#22d3ee', '#22c55e', '#facc15', '#fff'], w = innerWidth, h = innerHeight;
  for (let i = 0; i < count; i++) {
    const left = i % 2 === 0, p = particle('fx-confetti', left ? -10 : w + 10, h * 0.85);
    G.set(p, { background: G.utils.random(colors), width: R(6, 11), height: R(10, 18), rotation: R(0, 360) });
    G.to(p, {
      duration: R(1.8, 2.8), ease: 'none', delay: R(0, 0.25),
      physics2D: { velocity: R(650, 1050), angle: left ? R(-75, -45) : R(-135, -105), gravity: 700 },
      rotation: `+=${R(360, 900)}`, rotationX: `+=${R(360, 720)}`, onComplete: () => p.remove(),
    });
  }
}

// a big centered banner ("BIG WIN 11.40x")
export function banner(title, sub, color = '#22c55e') {
  if (!on) return;
  const p = document.createElement('div'); p.className = 'fx-banner';
  p.innerHTML = `<b style="color:${color};text-shadow:0 0 28px ${color}">${title}</b><span>${sub}</span>`;
  fxLayer().append(p);
  G.timeline({ onComplete: () => p.remove() })
    .fromTo(p, { scale: 0.3, autoAlpha: 0, rotation: -8 }, { scale: 1, autoAlpha: 1, rotation: 0, duration: 0.7, ease: 'elastic.out(1, 0.5)' })
    .from(p.children[1], { y: 14, autoAlpha: 0, duration: 0.3 }, '<0.2')
    .to(p, { scale: 1.15, autoAlpha: 0, duration: 0.35, ease: 'power2.in' }, '+=0.9');
}

// staggered entrance for freshly rendered content
export function enter(targets, vars = {}) {
  if (!on) return;
  const els = G.utils.toArray(targets);
  if (els.length) G.from(els, { y: 18, autoAlpha: 0, duration: 0.45, stagger: 0.06, clearProps: 'transform,opacity,visibility', ...vars });
}


