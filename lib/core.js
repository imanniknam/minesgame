// Shared money + round plumbing used by every game. All balance changes go through openRound/settle,
// so the anti-double-spend rules live in exactly one place.
import { createHash, randomBytes } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; }
}

export const CENTS = 100; // balances are integer cents of a coin
export const BETS = [10, 50, 100];
export const NAMES = { mines: 'Mines', crash: 'Crash', roulette: 'Roulette', poop: 'Poop' };

export const sha256 = s => createHash('sha256').update(s).digest('hex');

// Provably fair: the round's outcome is derived from `seed`; the client sees sha256(seed) before playing
// and the seed itself after the round ends.
export function newSeed() {
  const seed = randomBytes(32).toString('hex');
  return { seed, hash: sha256(seed) };
}

export function parseBet(coins) {
  if (!BETS.includes(coins)) throw new HttpError(400, 'Bet must be 10, 50 or 100');
  return coins * CENTS;
}

// Optional client request id: a retried/double-tapped "start" returns the same round instead of a second one.
export function parseRid(rid) {
  if (rid == null) return null;
  if (typeof rid !== 'string' || !/^[\w-]{8,64}$/.test(rid)) throw new HttpError(400, 'Bad request id');
  return rid;
}

// Lazy settlement hooks (crash rounds end on the clock, not on a request). Registered by game modules.
export const tickers = {};

// The user's active round (row-locked), after letting time-based games settle themselves.
export async function getActive(q, uid, game) {
  const { rows: [g] } = await q(`SELECT * FROM games WHERE user_id=$1 AND status='active' FOR UPDATE`, [uid]);
  if (!g) return null;
  if (tickers[g.game] && await tickers[g.game](q, g)) return null; // it just ended
  if (game && g.game !== game) return null;
  return g;
}

// Debit the bet and create the round in one transaction. One active round per user across ALL games.
export async function openRound(q, uid, { game, bet, rid, mines = null, data = {} }) {
  const { rows: [u] } = await q('SELECT balance FROM users WHERE id=$1 FOR UPDATE', [uid]); // serialises this user's requests
  if (rid) {
    const { rows: [dup] } = await q('SELECT * FROM games WHERE user_id=$1 AND rid=$2', [uid, rid]);
    if (dup) return { g: dup, balance: u.balance };
  }
  const active = await getActive(q, uid);
  if (active) throw new HttpError(409, `Finish your ${NAMES[active.game]} round first`, { activeGame: active.game });
  if (u.balance < bet) throw new HttpError(400, 'Not enough coins');
  const { rows: [nu] } = await q('UPDATE users SET balance = balance - $2 WHERE id=$1 RETURNING balance', [uid, bet]);
  const { seed, hash } = newSeed();
  const seeded = typeof data === 'function' ? data(seed) : data;
  const { rows: [g] } = await q(
    `INSERT INTO games (user_id, game, bet, mines, data, status, seed, seed_hash, rid)
     VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8) RETURNING *`,
    [uid, game, bet, typeof mines === 'function' ? mines(seed) : mines, seeded, seed, hash, rid]);
  await q(`INSERT INTO ledger (user_id, game_id, kind, amount, balance_after) VALUES ($1,$2,'bet',$3,$4)`, [uid, g.id, -bet, nu.balance]);
  return { g, balance: nu.balance };
}

// End a round exactly once (the status guard makes a second settle a no-op error) and pay out if won.
export async function settle(q, g, { won, multX100, revealed, data }) {
  const payout = won ? (g.bet * multX100) / 100 : 0; // bets are whole coins -> exact cents
  const { rows: [done] } = await q(
    `UPDATE games SET status=$2, mult_x100=$3, payout=$4, revealed=COALESCE($5, revealed),
       data = data || COALESCE($6, '{}'::jsonb), ended_at=now()
     WHERE id=$1 AND status='active' RETURNING *`,
    [g.id, won ? 'cashed' : 'busted', won ? multX100 : 0, payout, revealed ?? null, data ?? null]);
  if (!done) throw new HttpError(409, 'Round already finished');
  if (payout > 0) {
    const { rows: [u] } = await q('UPDATE users SET balance = balance + $2 WHERE id=$1 RETURNING balance', [g.user_id, payout]);
    await q(`INSERT INTO ledger (user_id, game_id, kind, amount, balance_after) VALUES ($1,$2,'win',$3,$4)`, [g.user_id, g.id, payout, u.balance]);
  }
  return done;
}

export const balanceOf = async (q, uid) => (await q('SELECT balance FROM users WHERE id=$1', [uid])).rows[0].balance / CENTS;

// Fields every game exposes; secrets (seed) only once the round is over.
export const baseView = g => ({
  id: g.id,
  game: g.game,
  bet: g.bet / CENTS,
  status: g.status,
  won: g.status === 'cashed',
  multiplier: g.mult_x100 / 100,
  payout: g.payout / CENTS,
  net: g.status === 'active' ? 0 : (g.payout - g.bet) / CENTS,
  seedHash: g.seed_hash,
  ...(g.status !== 'active' && { seed: g.seed }),
  createdAt: g.created_at,
});
