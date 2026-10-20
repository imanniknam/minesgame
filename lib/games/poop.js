import { HttpError, baseView, balanceOf, getActive, openRound, parseBet, parseRid, settle, sha256 } from '../core.js';

// Fixed table from the brief: 0.95 / 0.5^k
export const LADDER = [190, 380, 760, 1520, 3040];
export const STAGES = LADDER.length;
export const CHOICES = ['poop', 'laugh']; // 0 = 💩, 1 = 😂

// Correct answer of stage i (0-based): one fair bit from sha256(seed:i). Independent per stage, fixed at bet time.
export const answer = (seed, i) => parseInt(sha256(`${seed}:${i}`)[0], 16) & 1;

export function view(g) {
  const active = g.status === 'active';
  const picks = g.revealed; // user's choices; all correct except a losing last one
  const correct = picks.length - (g.status === 'busted' ? 1 : 0);
  return {
    ...baseView(g),
    picks,
    stage: correct, // stages cleared
    // only for finished stages: what the right answer was (never the future)
    answers: picks.map((p, i) => (i < correct ? p : 1 - p)),
    next: active && correct < STAGES ? LADDER[correct] / 100 : null,
    cashout: active && correct ? (g.bet * LADDER[correct - 1]) / 100 / 100 : 0,
  };
}

export const config = { ladder: LADDER.map(m => m / 100), stages: STAGES };

export function routes(api) {
  api.post('/poop/bet', async (req, res) => {
    const bet = parseBet(req.body?.bet), rid = parseRid(req.body?.rid);
    const { g, balance } = await req.db.tx(q => openRound(q, req.uid, { game: 'poop', bet, rid }));
    res.json({ game: view(g), balance: balance / 100 });
  });

  api.post('/poop/pick', async (req, res) => {
    const choice = req.body?.choice, stage = req.body?.stage;
    if (choice !== 0 && choice !== 1) throw new HttpError(400, 'Pick poop or laugh');
    res.json(await req.db.tx(async q => {
      const g = await getActive(q, req.uid, 'poop');
      if (!g) throw new HttpError(409, 'No active round');
      // client says which stage it is answering: a retried request for an already-played stage is a no-op
      if (Number.isInteger(stage) && stage < g.revealed.length) return { game: view(g) };
      const i = g.revealed.length, picks = [...g.revealed, choice];
      let done;
      if (answer(g.seed, i) !== choice) done = await settle(q, g, { won: false, revealed: picks });
      else if (picks.length === STAGES) done = await settle(q, g, { won: true, multX100: LADDER[STAGES - 1], revealed: picks }); // auto-pay stage 5
      else ({ rows: [done] } = await q(`UPDATE games SET revealed=$2, mult_x100=$3 WHERE id=$1 RETURNING *`, [g.id, picks, LADDER[i]]));
      return { game: view(done), balance: await balanceOf(q, req.uid) };
    }));
  });

  api.post('/poop/cashout', async (req, res) => {
    res.json(await req.db.tx(async q => {
      const g = await getActive(q, req.uid, 'poop');
      if (!g) throw new HttpError(409, 'No active round');
      if (!g.revealed.length) throw new HttpError(400, 'Win at least one stage first');
      const done = await settle(q, g, { won: true, multX100: LADDER[g.revealed.length - 1] });
      return { game: view(done), balance: await balanceOf(q, req.uid) };
    }));
  });
}
