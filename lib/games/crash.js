import { HttpError, baseView, balanceOf, getActive, openRound, parseBet, parseRid, settle, sha256, tickers } from '../core.js';

export const GROWTH = 0.00006;     // m(t) = e^(GROWTH * ms): 2x at ~11.6s, 10x at ~38s
export const COUNTDOWN_MS = 1500;  // "Waiting" phase before the rocket starts
export const MAX_X100 = 100000;    // 1000x cap

// Multiplier (x100) on the server clock, floored like it is displayed.
export const multAt = ms => (ms <= 0 ? 100 : Math.floor(100 * Math.exp(GROWTH * ms)));

// Crash point from the seed. r uniform in [0,1); C = floor(95 / (1 - r)), min 1.00x.
// You win iff your cash-out multiplier M < C, so P(win at M) = 95/(M+1) -> RTP <= 95% at every M
// (and ~5% of rounds bust instantly at 1.00x).
export function crashFromSeed(seed) {
  const r = parseInt(sha256(seed).slice(0, 13), 16) / 2 ** 52;
  return Math.min(MAX_X100, Math.max(100, Math.floor(95 / (1 - r))));
}

// Authoritative outcome at time `now`, or null while still flying.
export function resolve(g, now) {
  const { crash, auto, startsAt } = g.data, m = multAt(now - startsAt);
  if (auto && auto < crash && m >= auto) return { won: true, multX100: auto }; // auto cash-out fired first
  if (m >= crash) return { won: false, data: { crashedAt: crash } };
  return null;
}

const finish = (q, g, r) => settle(q, g, { ...r, data: { ...(r.data ?? {}), crashedAt: g.data.crash } });

// Rounds end on the clock even if nobody is watching: any request that touches the round settles it.
tickers.crash = async (q, g) => {
  const r = resolve(g, Date.now());
  return r ? finish(q, g, r) : null;
};

export function view(g) {
  const live = g.status === 'active';
  return {
    ...baseView(g),
    startsAt: g.data.startsAt,
    auto: g.data.auto ? g.data.auto / 100 : null,
    ...(!live && { crash: g.data.crash / 100 }), // the crash point is secret until the round is over
  };
}

export const config = { growth: GROWTH, countdownMs: COUNTDOWN_MS, max: MAX_X100 / 100 };

const lastCrash = async (q, uid) =>
  (await q(`SELECT * FROM games WHERE user_id=$1 AND game='crash' ORDER BY id DESC LIMIT 1`, [uid])).rows[0];

export function routes(api) {
  api.post('/crash/bet', async (req, res) => {
    const bet = parseBet(req.body?.bet), rid = parseRid(req.body?.rid);
    let auto = req.body?.auto ?? null;
    if (auto !== null) {
      if (typeof auto !== 'number' || !(auto >= 1.01 && auto <= MAX_X100 / 100)) throw new HttpError(400, 'Auto cash-out must be 1.01x–1000x');
      auto = Math.round(auto * 100);
    }
    const { g, balance } = await req.db.tx(q => openRound(q, req.uid, {
      game: 'crash', bet, rid,
      data: seed => ({ crash: crashFromSeed(seed), auto, startsAt: Date.now() + COUNTDOWN_MS }),
    }));
    res.json({ game: view(g), balance: balance / 100, serverNow: Date.now() });
  });

  // Polled by the client while flying; also how a reconnecting player learns the outcome.
  api.get('/crash/status', async (req, res) => {
    res.json(await req.db.tx(async q => {
      const g = (await getActive(q, req.uid, 'crash')) ?? await lastCrash(q, req.uid);
      return { game: g ? view(g) : null, balance: await balanceOf(q, req.uid), serverNow: Date.now() };
    }));
  });

  api.post('/crash/cashout', async (req, res) => {
    res.json(await req.db.tx(async q => {
      const g = await getActive(q, req.uid, 'crash'); // already settles a round that crashed / auto-cashed meanwhile
      if (!g) {
        const last = await lastCrash(q, req.uid);
        return { game: last ? view(last) : null, balance: await balanceOf(q, req.uid), late: true, serverNow: Date.now() };
      }
      const now = Date.now(); // one clock reading decides the outcome
      if (now < g.data.startsAt) throw new HttpError(400, 'Round has not started yet');
      const r = resolve(g, now);
      const done = await finish(q, g, r ?? { won: true, multX100: multAt(now - g.data.startsAt) }); // r==null => m < crash
      return { game: view(done), balance: await balanceOf(q, req.uid), serverNow: Date.now() };
    }));
  });
}
