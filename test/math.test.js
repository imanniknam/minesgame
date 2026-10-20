import test from 'node:test';
import assert from 'node:assert/strict';
import { newSeed } from '../lib/core.js';
import * as mines from '../lib/games/mines.js';
import * as poop from '../lib/games/poop.js';
import * as roulette from '../lib/games/roulette.js';
import * as crash from '../lib/games/crash.js';

test('mines: ladder = 0.95 / P(survive), RTP <= 95% at every step', () => {
  assert.deepEqual(mines.LADDER, [122, 162, 228, 342, 570, 1140, 3420]);
  let p = 1;
  for (let k = 1; k <= 7; k++) {
    p *= (7 - (k - 1)) / (9 - (k - 1));
    const ev = p * mines.multiplierX100(k) / 100;
    assert.ok(ev <= 0.95 + 1e-12 && ev > 0.94, `k=${k} ev=${ev}`);
  }
});

test('mines: seed gives 2 distinct, reproducible mines', () => {
  const { seed } = newSeed();
  const m = mines.minesFromSeed(seed);
  assert.equal(new Set(m).size, 2);
  assert.deepEqual(mines.minesFromSeed(seed), m);
});

test('poop: table from the brief and fair coin per stage', () => {
  assert.deepEqual(poop.LADDER, [190, 380, 760, 1520, 3040]);
  poop.LADDER.forEach((m, i) => assert.ok(Math.abs(m / 100 * 0.5 ** (i + 1) - 0.95) < 1e-9));
  let ones = 0;
  for (let i = 0; i < 4000; i++) ones += poop.answer(newSeed().seed, i % 5);
  assert.ok(ones > 1800 && ones < 2200, `ones=${ones}`); // ~50/50
});

test('roulette: payouts and zero rule', () => {
  assert.equal(roulette.wins('red', undefined, 1), true);
  assert.equal(roulette.wins('black', undefined, 1), false);
  assert.equal(roulette.wins('even', undefined, 0), false);
  assert.equal(roulette.wins('odd', undefined, 0), false);
  assert.equal(roulette.wins('red', undefined, 0), false);
  assert.equal(roulette.wins('number', 0, 0), true);
  assert.equal(roulette.wins('number', 17, 18), false);
  assert.equal(roulette.wins('even', undefined, 36), true);
  assert.equal(roulette.colorOf(0), 'green');
  assert.equal(roulette.REDS.length, 18);
});

test('roulette: every number 0..36 reachable, roughly uniform', () => {
  const counts = Array(37).fill(0);
  for (let i = 0; i < 37000; i++) counts[roulette.numberFromSeed(newSeed().seed)]++;
  assert.ok(counts.every(c => c > 800 && c < 1200), counts.join(','));
});

test('crash: P(win at M) = 95/(M+1) -> RTP <= 95%, ~5% instant bust', () => {
  const N = 40000, pts = Array.from({ length: N }, () => crash.crashFromSeed(newSeed().seed));
  const instant = pts.filter(c => c === 100).length / N;
  assert.ok(instant > 0.04 && instant < 0.06, `instant=${instant}`);
  for (const M of [101, 150, 200]) { // expected 0.95*M/(M+1); bounds ~4 sigma
    const rtp = pts.filter(c => M < c).length / N * M / 100;
    assert.ok(rtp < 0.975 && rtp > 0.915, `M=${M} rtp=${rtp}`);
  }
});

test('crash: resolve() on the server clock', () => {
  const g = { data: { crash: 250, auto: null, startsAt: 0 } };
  const tAt = m => Math.ceil(Math.log(m / 100) / crash.GROWTH) + 1; // first ms where multAt >= m
  assert.equal(crash.resolve(g, tAt(249) - 2), null);
  assert.deepEqual(crash.resolve(g, tAt(250)), { won: false, data: { crashedAt: 250 } });
  assert.deepEqual(crash.resolve({ data: { ...g.data, auto: 200 } }, tAt(210)), { won: true, multX100: 200 });
  assert.deepEqual(crash.resolve({ data: { ...g.data, auto: 250 } }, tAt(260)), { won: false, data: { crashedAt: 250 } }); // auto == crash loses
  assert.equal(crash.multAt(-100), 100);
});
