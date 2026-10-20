import { HttpError, baseView, balanceOf, getActive, openRound, parseBet, parseRid, settle, sha256 } from '../core.js';

export const CELLS = 9, MINES = 2, SAFE = CELLS - MINES, RTP_PCT = 95;

// P(k safe in a row) = C(7,k)/C(9,k); multiplier = 0.95/P floored to 2dp, integer math. 122 = 1.22x.
export function multiplierX100(k) {
  if (!Number.isInteger(k) || k < 1 || k > SAFE) throw new RangeError('bad k');
  let num = 1n, den = 1n;
  for (let i = 0; i < k; i++) { num *= BigInt(SAFE - i); den *= BigInt(CELLS - i); }
  return Number((BigInt(RTP_PCT) * den) / num);
}
export const LADDER = Array.from({ length: SAFE }, (_, i) => multiplierX100(i + 1));

// mines = the 2 cells with the smallest sha256(seed:cell)
export const minesFromSeed = seed => [...Array(CELLS).keys()]
  .map(c => [c, sha256(`${seed}:${c}`)])
  .sort((a, b) => (a[1] < b[1] ? -1 : 1))
  .slice(0, MINES).map(([c]) => c).sort((a, b) => a - b);

export function view(g) {
  const active = g.status === 'active', k = g.revealed.length;
  return {
    ...baseView(g),
    revealed: g.revealed,
    safe: k - (g.status === 'busted' ? 1 : 0),
    next: active && k < SAFE ? multiplierX100(k + 1) / 100 : null,
    cashout: active && k ? (g.bet * multiplierX100(k)) / 100 / 100 : 0,
    ...(!active && { mines: g.mines }), // never while the round is live
  };
}

export const config = { cells: CELLS, mines: MINES, ladder: LADDER.map(m => m / 100) };

export function routes(api) {
  api.post('/mines/bet', async (req, res) => {
    const bet = parseBet(req.body?.bet), rid = parseRid(req.body?.rid);
    const { g, balance } = await req.db.tx(q => openRound(q, req.uid, { game: 'mines', bet, rid, mines: minesFromSeed }));
    res.json({ game: view(g), balance: balance / 100 });
  });

  api.post('/mines/reveal', async (req, res) => {
    const cell = req.body?.cell;
    if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS) throw new HttpError(400, 'Bad cell');
    res.json(await req.db.tx(async q => {
      const g = await getActive(q, req.uid, 'mines');
      if (!g) throw new HttpError(409, 'No active round');
      if (g.revealed.includes(cell)) return { game: view(g) }; // double tap / retry: idempotent
      const revealed = [...g.revealed, cell];
      let done;
      if (g.mines.includes(cell)) done = await settle(q, g, { won: false, revealed });
      else if (revealed.length === SAFE) done = await settle(q, g, { won: true, multX100: multiplierX100(SAFE), revealed }); // board cleared
      else ({ rows: [done] } = await q(`UPDATE games SET revealed=$2, mult_x100=$3 WHERE id=$1 RETURNING *`, [g.id, revealed, multiplierX100(revealed.length)]));
      return { game: view(done), balance: await balanceOf(q, req.uid) };
    }));
  });

  api.post('/mines/cashout', async (req, res) => {
    res.json(await req.db.tx(async q => {
      const g = await getActive(q, req.uid, 'mines');
      if (!g) throw new HttpError(409, 'No active round'); // a second cash-out lands here
      if (!g.revealed.length) throw new HttpError(400, 'Open at least one tile first');
      const done = await settle(q, g, { won: true, multX100: multiplierX100(g.revealed.length) });
      return { game: view(done), balance: await balanceOf(q, req.uid) };
    }));
  });
}
