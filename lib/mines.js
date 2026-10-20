import { createHash, randomBytes } from 'node:crypto';

export const CELLS = 9;
export const MINES = 2;
export const SAFE = CELLS - MINES;
export const EDGE_PCT = 95; // RTP 95% -> 5% house edge
export const BETS = [10, 50, 100]; // coins
export const CENTS = 100; // balances are stored as integer cents of a coin

// P(k safe picks in a row) = C(SAFE,k)/C(CELLS,k) = prod (SAFE-i)/(CELLS-i).
// Multiplier = RTP / P, floored to 2 decimals. Integer math only, so no float drift.
// Returns the multiplier in hundredths (122 = 1.22x). k=0 -> 100 (1.00x).
export function multiplierX100(k) {
  if (!Number.isInteger(k) || k < 0 || k > SAFE) throw new RangeError('bad k');
  let num = 1n, den = 1n;
  for (let i = 0; i < k; i++) { num *= BigInt(SAFE - i); den *= BigInt(CELLS - i); }
  if (k === 0) return 100;
  return Number((BigInt(EDGE_PCT) * den) / num);
}

export const LADDER = Array.from({ length: SAFE }, (_, i) => multiplierX100(i + 1));

export const payoutCents = (betCents, k) => (betCents * multiplierX100(k)) / 100; // bet is whole coins -> exact

// Provably fair: mines = 2 cells with the smallest sha256(seed:cell).
// The client gets sha256(seed) up front and the seed after the round, and can recompute.
export function newSeed() {
  const seed = randomBytes(32).toString('hex');
  return { seed, hash: createHash('sha256').update(seed).digest('hex') };
}

export function minesFromSeed(seed) {
  return [...Array(CELLS).keys()]
    .map(c => [c, createHash('sha256').update(`${seed}:${c}`).digest('hex')])
    .sort((a, b) => (a[1] < b[1] ? -1 : 1))
    .slice(0, MINES)
    .map(([c]) => c)
    .sort((a, b) => a - b);
}
