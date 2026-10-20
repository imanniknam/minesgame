import express from 'express';
import { getDb } from './lib/db.js';
import { verifyInitData } from './lib/telegram.js';
import { BETS, CELLS, CENTS, LADDER, SAFE, minesFromSeed, multiplierX100, newSeed, payoutCents } from './lib/mines.js';

const { BOT_TOKEN, WEBHOOK_SECRET, APP_URL } = process.env;
const DEV_AUTH = process.env.ALLOW_DEV_AUTH === '1' && !process.env.VERCEL; // never on the deployed app
const START_BALANCE = 1000 * CENTS;
const DAILY_BONUS = 100 * CENTS;
const BONUS_EVERY_MS = 24 * 3600 * 1000;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public')); // on Vercel public/ is served by the CDN instead

// ---------- auth: every /api call carries Telegram initData; the server verifies its HMAC ----------
async function auth(req, _res, next) {
  try {
    const raw = (req.get('authorization') || '').replace(/^tma /, '');
    let tg = verifyInitData(raw, BOT_TOKEN)?.user;
    if (!tg && DEV_AUTH && req.get('x-dev-user')) tg = { id: Number(req.get('x-dev-user')), first_name: 'Dev' };
    if (!tg || !Number.isSafeInteger(tg.id)) throw new HttpError(401, 'Open the game from Telegram');
    const db = await getDb();
    // first visit creates the wallet with the 1,000-coin grant, in one transaction with its ledger row
    await db.tx(async q => {
      const { rows } = await q(
        `INSERT INTO users (id, username, first_name, balance) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name
         RETURNING (xmax = 0) AS inserted`,
        [tg.id, tg.username ?? null, (tg.first_name ?? '').slice(0, 64), START_BALANCE]);
      if (rows[0].inserted) await q(`INSERT INTO ledger (user_id, kind, amount, balance_after) VALUES ($1,'signup',$2,$2)`, [tg.id, START_BALANCE]);
    });
    req.uid = tg.id; req.db = db;
    next();
  } catch (e) { next(e); }
}

// what the client may see: mine positions and the seed only after the round is over
const view = g => g && ({
  id: g.id,
  bet: g.bet / CENTS,
  status: g.status,
  revealed: g.revealed,
  safe: g.revealed.length - (g.status === 'busted' ? 1 : 0),
  multiplier: g.mult_x100 / 100,
  next: g.status === 'active' && g.revealed.length < SAFE ? multiplierX100(g.revealed.length + 1) / 100 : null,
  cashout: g.status === 'active' && g.revealed.length ? payoutCents(g.bet, g.revealed.length) / CENTS : 0,
  payout: g.payout / CENTS,
  seedHash: g.seed_hash,
  ...(g.status !== 'active' && { mines: g.mines, seed: g.seed }),
  createdAt: g.created_at,
});

const balanceOf = async (q, uid) => (await q('SELECT balance FROM users WHERE id=$1', [uid])).rows[0].balance / CENTS;

async function settle(q, g, revealed) {
  const k = revealed.length, payout = payoutCents(g.bet, k);
  const { rows: [done] } = await q(
    `UPDATE games SET status='cashed', revealed=$2, mult_x100=$3, payout=$4, ended_at=now()
     WHERE id=$1 AND status='active' RETURNING *`, [g.id, revealed, multiplierX100(k), payout]);
  const { rows: [u] } = await q('UPDATE users SET balance = balance + $2 WHERE id=$1 RETURNING balance', [g.user_id, payout]);
  await q(`INSERT INTO ledger (user_id, game_id, kind, amount, balance_after) VALUES ($1,$2,'win',$3,$4)`, [g.user_id, g.id, payout, u.balance]);
  return done;
}

// row lock serialises concurrent reveal/cashout taps for the same round
const lockActive = async (q, uid) =>
  (await q(`SELECT * FROM games WHERE user_id=$1 AND status='active' FOR UPDATE`, [uid])).rows[0];

const api = express.Router();
api.use(auth);

api.get('/state', async (req, res) => {
  const { rows: [u] } = await req.db.query('SELECT id, first_name, balance, last_bonus_at FROM users WHERE id=$1', [req.uid]);
  const { rows: [g] } = await req.db.query(`SELECT * FROM games WHERE user_id=$1 AND status='active'`, [req.uid]);
  res.json({
    user: { id: u.id, name: u.first_name, balance: u.balance / CENTS,
      bonusAt: u.last_bonus_at ? new Date(u.last_bonus_at).getTime() + BONUS_EVERY_MS : 0 },
    game: view(g) ?? null,
    config: { bets: BETS, cells: CELLS, safe: SAFE, ladder: LADDER.map(m => m / 100) },
  });
});

api.post('/bet', async (req, res) => {
  const coins = req.body?.bet;
  if (!BETS.includes(coins)) throw new HttpError(400, 'Bet must be 10, 50 or 100');
  const bet = coins * CENTS;
  const out = await req.db.tx(async q => {
    const { rows: [u] } = await q('SELECT balance FROM users WHERE id=$1 FOR UPDATE', [req.uid]);
    if (await lockActive(q, req.uid)) throw new HttpError(409, 'Finish your current round first');
    if (u.balance < bet) throw new HttpError(400, 'Not enough coins');
    const { rows: [nu] } = await q('UPDATE users SET balance = balance - $2 WHERE id=$1 RETURNING balance', [req.uid, bet]);
    const { seed, hash } = newSeed();
    const { rows: [g] } = await q(
      `INSERT INTO games (user_id, bet, mines, status, seed, seed_hash) VALUES ($1,$2,$3,'active',$4,$5) RETURNING *`,
      [req.uid, bet, minesFromSeed(seed), seed, hash]);
    await q(`INSERT INTO ledger (user_id, game_id, kind, amount, balance_after) VALUES ($1,$2,'bet',$3,$4)`, [req.uid, g.id, -bet, nu.balance]);
    return { game: view(g), balance: nu.balance / CENTS };
  });
  res.json(out);
});

api.post('/reveal', async (req, res) => {
  const cell = req.body?.cell;
  if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS) throw new HttpError(400, 'Bad cell');
  const out = await req.db.tx(async q => {
    const g = await lockActive(q, req.uid);
    if (!g) throw new HttpError(409, 'No active round');
    if (g.revealed.includes(cell)) return { game: view(g) }; // double tap / retry: idempotent
    const revealed = [...g.revealed, cell];
    let done;
    if (g.mines.includes(cell)) {
      ({ rows: [done] } = await q(`UPDATE games SET status='busted', revealed=$2, mult_x100=0, ended_at=now() WHERE id=$1 RETURNING *`, [g.id, revealed]));
    } else if (revealed.length === SAFE) {
      done = await settle(q, g, revealed); // board cleared: auto cash out at max multiplier
    } else {
      ({ rows: [done] } = await q(`UPDATE games SET revealed=$2, mult_x100=$3 WHERE id=$1 RETURNING *`, [g.id, revealed, multiplierX100(revealed.length)]));
    }
    return { game: view(done), balance: await balanceOf(q, req.uid) };
  });
  res.json(out);
});

api.post('/cashout', async (req, res) => {
  const out = await req.db.tx(async q => {
    const g = await lockActive(q, req.uid);
    if (!g) throw new HttpError(409, 'No active round'); // second cash-out lands here
    if (!g.revealed.length) throw new HttpError(400, 'Open at least one tile first');
    const done = await settle(q, g, g.revealed);
    return { game: view(done), balance: await balanceOf(q, req.uid) };
  });
  res.json(out);
});

api.post('/bonus', async (req, res) => {
  const out = await req.db.tx(async q => {
    const { rows: [u] } = await q(
      `UPDATE users SET balance = balance + $2, last_bonus_at = now()
       WHERE id=$1 AND (last_bonus_at IS NULL OR last_bonus_at <= now() - interval '24 hours')
       RETURNING balance, last_bonus_at`, [req.uid, DAILY_BONUS]);
    if (!u) throw new HttpError(429, 'Daily bonus already claimed');
    await q(`INSERT INTO ledger (user_id, kind, amount, balance_after) VALUES ($1,'bonus',$2,$3)`, [req.uid, DAILY_BONUS, u.balance]);
    return { balance: u.balance / CENTS, bonusAt: new Date(u.last_bonus_at).getTime() + BONUS_EVERY_MS };
  });
  res.json(out);
});

api.get('/history', async (req, res) => {
  const { rows } = await req.db.query(
    `SELECT * FROM games WHERE user_id=$1 AND status <> 'active' ORDER BY id DESC LIMIT 10`, [req.uid]);
  res.json({ games: rows.map(view) });
});

api.get('/leaderboard', async (req, res) => {
  const { rows } = await req.db.query(
    `SELECT u.id, u.first_name AS name, SUM(g.payout - g.bet) AS profit, COUNT(*) AS games
     FROM games g JOIN users u ON u.id = g.user_id WHERE g.status <> 'active'
     GROUP BY u.id ORDER BY profit DESC LIMIT 10`);
  res.json({ top: rows.map(r => ({ name: r.name || 'Player', profit: Number(r.profit) / CENTS, games: Number(r.games), me: Number(r.id) === req.uid })) });
});

app.use('/api', api);
app.get('/', (_req, res) => res.redirect('/index.html')); // on Vercel the function owns "/", static files live on the CDN
app.get('/config',(_req, res) => res.json({ bot: process.env.BOT_USERNAME || null }));

// ---------- bot webhook: /start -> button that opens the Mini App ----------
app.post('/bot', async (req, res) => {
  if (!WEBHOOK_SECRET || req.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) return res.sendStatus(401);
  const msg = req.body?.message;
  if (msg?.text?.startsWith('/start') && APP_URL) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: msg.chat.id,
        text: '💣 Mines — open tiles, dodge 2 bombs, cash out before you blow up.\n\nYou start with 1,000 free coins.',
        reply_markup: { inline_keyboard: [[{ text: '🎮 Play Mines', web_app: { url: APP_URL } }]] },
      }),
    }).catch(e => console.error('sendMessage failed', e));
  }
  res.sendStatus(200);
});

app.use((err, _req, res, _next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  if (err.code === '23505') return res.status(409).json({ error: 'Finish your current round first' }); // unique index backstop
  console.error(err);
  res.status(500).json({ error: 'Server error, try again' });
});

if (!process.env.VERCEL && process.argv[1]?.endsWith('server.js')) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`http://localhost:${port}`));
}

export default app;
