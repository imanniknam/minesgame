// Game-feel effects on GSAP (self-hosted in vendor/gsap: CDNs are filtered for some players).
// Everything here is decoration: if GSAP failed to load, or the player prefers reduced motion,
// every export is a no-op and the game works exactly the same.
import { I } from './icons.js';

const G = window.gsap;
const plugins = [window.Physics2DPlugin, window.MotionPathPlugin, window.CustomEase, window.CustomWiggle];
export let on = false;

if (G && plugins.every(Boolean)) {
  G.registerPlugin(...plugins);
  G.defaults({ duration: 0.45, ease: 'power3.out' });
  window.CustomWiggle.create('shake', { wiggles: 7, type: 'easeOut' });
  // reduced motion switches the effects off live, without a reload
  G.matchMedia().add({ full: '(prefers-reduced-motion: no-preference)' }, ctx => { on = ctx.conditions.full; });
}
document.documentElement.classList.toggle('fx', on);
document.documentElement.classList.remove('fx-pending'); // set inline in <head> so the splash doesn't flash before its intro

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

export function shake(el, strength = 12) {
  if (!on || !el) return;
  G.fromTo(el, { x: 0 }, { x: strength, duration: 0.55, ease: 'shake', clearProps: 'x' });
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
      const sx = G.getProperty(p, 'x'), sy = G.getProperty(p, 'y');
      G.timeline({ delay: i * 0.045, onComplete: () => { p.remove(); if (i === 0) done(); if (i === count - 1) bump(toEl); } })
        .from(p, { scale: 0, duration: 0.18, ease: 'back.out(3)' })
        .to(p, {
          duration: R(0.65, 0.85), ease: 'power2.in',
          motionPath: { path: [{ x: sx, y: sy }, { x: (sx + x1) / 2 + R(-90, 90), y: Math.min(sy, y1) - R(60, 160) }, { x: x1, y: y1 }], curviness: 1.4 },
          rotation: R(-360, 360), scale: 0.6,
        });
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

let intro;
export function splashIn(root) {
  if (!on) return;
  intro = G.timeline({ defaults: { ease: 'power3.out' } })
    .from(root.querySelector('.mark'), { scale: 0, rotation: -200, duration: 0.8, ease: 'back.out(1.6)' })
    .from(root.querySelectorAll('.brand b, .brand small'), { x: -30, autoAlpha: 0, stagger: 0.08 }, '-=0.45')
    .from(root.querySelector('h1'), { y: 30, autoAlpha: 0, duration: 0.6 }, '-=0.25')
    .from(root.querySelector('p'), { y: 20, autoAlpha: 0 }, '-=0.35')
    .from(root.querySelector('#splashAct'), { y: 20, autoAlpha: 0 }, '-=0.3')
    .from(root.querySelector('.deco'), { x: 160, y: 160, rotation: 25, autoAlpha: 0, duration: 1.1, ease: 'expo.out' }, 0.2);
}

export function splashOut(root, done) {
  if (!on) return done();
  intro?.kill(); // a returning player may skip the intro halfway
  G.timeline({ onComplete: done })
    .to(root.querySelector('.deco'), { x: 260, y: -420, rotation: -20, duration: 0.6, ease: 'power3.in' })
    .to(root.querySelectorAll('.brand, h1, p, #splashAct'), { y: -24, autoAlpha: 0, stagger: 0.04, duration: 0.3, ease: 'power2.in' }, 0)
    .to(root, { autoAlpha: 0, duration: 0.35 }, 0.3);
}

export const gsap = G;
