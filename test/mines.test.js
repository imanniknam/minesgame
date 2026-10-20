import test from 'node:test';
import assert from 'node:assert/strict';
import { LADDER, minesFromSeed, multiplierX100, newSeed, payoutCents } from '../lib/mines.js';

test('ladder = 0.95 / P(survive), floored to 2dp', () => {
  assert.deepEqual(LADDER, [122, 162, 228, 342, 570, 1140, 3420]);
});

test('every cash-out step has RTP <= 95% (house never loses on expectation)', () => {
  // P(k) = C(7,k)/C(9,k); EV of "cash out after k" = P(k) * mult(k)
  let p = 1;
  for (let k = 1; k <= 7; k++) {
    p *= (7 - (k - 1)) / (9 - (k - 1));
    const ev = p * multiplierX100(k) / 100;
    assert.ok(ev <= 0.95 + 1e-12 && ev > 0.94, `k=${k} ev=${ev}`);
  }
});

test('payout is exact integer cents', () => {
  assert.equal(payoutCents(1000, 1), 1220); // 10 coins * 1.22 = 12.20
  assert.equal(payoutCents(10000, 7), 342000);
});

test('provably fair: seed deterministically gives 2 distinct mines', () => {
  const { seed } = newSeed();
  const m = minesFromSeed(seed);
  assert.equal(m.length, 2);
  assert.notEqual(m[0], m[1]);
  assert.deepEqual(minesFromSeed(seed), m);
});
