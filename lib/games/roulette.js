import { HttpError, baseView, openRound, parseBet, parseRid, settle, sha256 } from '../core.js';

export const REDS = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
export const colorOf = n => (n === 0 ? 'green' : REDS.includes(n) ? 'red' : 'black');
const PAYOUT_X100 = { red: 200, black: 200, odd: 200, even: 200, number: 3600 };

// Unbiased 0..36 from the seed: rejection-sample 32-bit chunks so 2^32 % 37 doesn't skew the wheel.
const LIMIT = Math.floor(2 ** 32 / 37) * 37;
export function numberFromSeed(seed) {
  for (let i = 0; ; i++) {
    const v = parseInt(sha256(`${seed}:${i}`).slice(0, 8), 16);
    if (v < LIMIT) return v % 37;
  }
}

// zero loses every outside bet
export function wins(type, pick, n) {
  if (type === 'number') return n === pick;
  if (n === 0) return false;
  if (type === 'red' || type === 'black') return colorOf(n) === type;
  return (n % 2 === 0) === (type === 'even');
}

export const view = g => ({ ...baseView(g), type: g.data.type, pick: g.data.pick ?? null, ...(g.status !== 'active' && { number: g.data.number, color: colorOf(g.data.number) }) });

export const config = { reds: REDS, payouts: { red: 2, black: 2, odd: 2, even: 2, number: 36 } };

export function routes(api) {
  // One request = whole round: debit, server-side spin, payout, all in one transaction.
  api.post('/roulette/spin', async (req, res) => {
    const bet = parseBet(req.body?.bet), rid = parseRid(req.body?.rid);
    const { type, number } = req.body ?? {};
    if (!(type in PAYOUT_X100)) throw new HttpError(400, 'Pick red, black, odd, even or a number');
    if (type === 'number' && !(Number.isInteger(number) && number >= 0 && number <= 36)) throw new HttpError(400, 'Number must be 0–36');
    const pick = type === 'number' ? number : undefined;
    res.json(await req.db.tx(async q => {
      const { g } = await openRound(q, req.uid, { game: 'roulette', bet, rid, data: seed => ({ type, pick, number: numberFromSeed(seed) }) });
      const done = g.status === 'active' // a replayed rid returns the already-settled round untouched
        ? await settle(q, g, { won: wins(type, pick, g.data.number), multX100: PAYOUT_X100[type] })
        : g;
      const { rows: [u] } = await q('SELECT balance FROM users WHERE id=$1', [req.uid]);
      return { game: view(done), balance: u.balance / 100 };
    }));
  });
}
