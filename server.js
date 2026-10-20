import express from 'express';
import { getDb } from './lib/db.js';
import { verifyInitData } from './lib/telegram.js';
import { BETS, CENTS, HttpError, getActive } from './lib/core.js';
import * as mines from './lib/games/mines.js';
import * as crash from './lib/games/crash.js';
import * as roulette from './lib/games/roulette.js';
import * as poop from './lib/games/poop.js';

const GAMES = { mines, crash, roulette, poop };
const { BOT_TOKEN, WEBHOOK_SECRET, APP_URL, BOT_USERNAME } = process.env;
const DEV_AUTH = process.env.ALLOW_DEV_AUTH === '1' && !process.env.VERCEL; // never on the deployed app
const START_BALANCE = 1000 * CENTS;
const DAILY_BONUS = 100 * CENTS;
const REFERRAL_BONUS = 200 * CENTS;
const BONUS_EVERY_MS = 24 * 3600 * 1000;

const view = g => g && GAMES[g.game].view(g);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public')); // on Vercel public/ is served by the CDN instead

// first visit creates the wallet with the 1,000-coin grant (same transaction as its ledger row)
async function ensureUser(q, tg, referrer = null) {
  const { rows: [r] } = await q(
    `INSERT INTO users (id, username, first_name, balance, referred_by)
     VALUES ($1,$2,$3,$4,(SELECT id FROM users WHERE id=$5 AND id<>$1))
     ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name
     RETURNING (xmax = 0) AS inserted, referred_by`,
    [tg.id, tg.username ?? null, (tg.first_name ?? '').slice(0, 64), START_BALANCE, referrer]);
  if (!r.inserted) return;
  await q(`INSERT INTO ledger (user_id, kind, amount, balance_after) VALUES ($1,'signup',$2,$2)`, [tg.id, START_BALANCE]);
  if (r.referred_by) { // only brand-new users count as a successful invite
    const { rows: [ref] } = await q('UPDATE users SET balance = balance + $2 WHERE id=$1 RETURNING balance', [r.referred_by, REFERRAL_BONUS]);
    await q(`INSERT INTO ledger (user_id, kind, amount, balance_after) VALUES ($1,'referral',$2,$3)`, [r.referred_by, REFERRAL_BONUS, ref.balance]);
  }
}

// ---------- auth: every /api call carries Telegram initData; the server verifies its HMAC ----------
async function auth(req, _res, next) {
  try {
    const raw = (req.get('authorization') || '').replace(/^tma /, '');
    let tg = verifyInitData(raw, BOT_TOKEN)?.user;
    if (!tg && DEV_AUTH && req.get('x-dev-user')) tg = { id: Number(req.get('x-dev-user')), first_name: 'Dev' };
    if (!tg || !Number.isSafeInteger(tg.id)) throw new HttpError(401, 'Open the game from Telegram');
    const db = await getDb();
    await db.tx(q => ensureUser(q, tg));
    req.uid = tg.id; req.db = db;
    next();
  } catch (e) { next(e); }
}

const api = express.Router();
api.use(auth);

api.get('/state', async (req, res) => {
  res.json(await req.db.tx(async q => {
    const g = await getActive(q, req.uid); // also settles a crash round that ended while the app was closed
    const { rows: [u] } = await q(
      `SELECT id, first_name, balance, last_bonus_at, (SELECT COUNT(*) FROM users r WHERE r.referred_by = u.id) AS invited
       FROM users u WHERE id=$1`, [req.uid]);
    return {
      user: { id: u.id, name: u.first_name, balance: u.balance / CENTS, invited: Number(u.invited),
        bonusAt: u.last_bonus_at ? new Date(u.last_bonus_at).getTime() + BONUS_EVERY_MS : 0 },
      game: view(g) ?? null,
      serverNow: Date.now(),
      config: {
        bets: BETS, bot: BOT_USERNAME ?? null, referralBonus: REFERRAL_BONUS / CENTS, dailyBonus: DAILY_BONUS / CENTS,
        games: Object.fromEntries(Object.entries(GAMES).map(([id, m]) => [id, m.config])),
      },
    };
  }));
});

for (const m of Object.values(GAMES)) m.routes(api);

api.post('/bonus', async (req, res) => {
  res.json(await req.db.tx(async q => {
    const { rows: [u] } = await q(
      `UPDATE users SET balance = balance + $2, last_bonus_at = now()
       WHERE id=$1 AND (last_bonus_at IS NULL OR last_bonus_at <= now() - interval '24 hours')
       RETURNING balance, last_bonus_at`, [req.uid, DAILY_BONUS]);
    if (!u) throw new HttpError(429, 'Daily bonus already claimed');
    await q(`INSERT INTO ledger (user_id, kind, amount, balance_after) VALUES ($1,'bonus',$2,$3)`, [req.uid, DAILY_BONUS, u.balance]);
    return { balance: u.balance / CENTS, bonusAt: new Date(u.last_bonus_at).getTime() + BONUS_EVERY_MS };
  }));
});

api.get('/history', async (req, res) => {
  const game = req.query.game || undefined;
  if (game !== undefined && !(typeof game === 'string' && Object.hasOwn(GAMES, game))) throw new HttpError(400, 'Unknown game');
  const { rows } = await req.db.query(
    `SELECT * FROM games WHERE user_id=$1 AND status <> 'active' AND ($2::text IS NULL OR game = $2)
     ORDER BY id DESC LIMIT 10`, [req.uid, game ?? null]);
  res.json({ games: rows.map(view) });
});

// Wallet tab: the user's own ledger, newest first
api.get('/wallet', async (req, res) => {
  const { rows } = await req.db.query(
    `SELECT l.id, l.kind, l.amount, l.balance_after, l.created_at, g.game
     FROM ledger l LEFT JOIN games g ON g.id = l.game_id WHERE l.user_id=$1 ORDER BY l.id DESC LIMIT 20`, [req.uid]);
  res.json({ items: rows.map(r => ({ id: r.id, kind: r.kind, game: r.game, amount: r.amount / CENTS, balance: r.balance_after / CENTS, at: r.created_at })) });
});

// Profile tab: stats derived from real rounds (XP = coins wagered)
api.get('/profile', async (req, res) => {
  const { rows: [s] } = await req.db.query(
    `SELECT COUNT(*) AS rounds, COUNT(*) FILTER (WHERE status='cashed') AS wins,
       COALESCE(SUM(payout - bet), 0) AS net, COALESCE(SUM(bet), 0) AS wagered,
       COALESCE(MAX(mult_x100) FILTER (WHERE status='cashed'), 0) AS best
     FROM games WHERE user_id=$1 AND status <> 'active'`, [req.uid]);
  res.json({ rounds: Number(s.rounds), wins: Number(s.wins), net: Number(s.net) / CENTS, xp: Number(s.wagered) / CENTS, best: Number(s.best) / 100 });
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
app.get('/config', (_req, res) => res.json({ bot: BOT_USERNAME || null }));

// ---------- bot webhook ----------
const tgSend = body => fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000),
}).catch(e => console.error('sendMessage failed', e));

const appLink = game => `${APP_URL}${game ? `${APP_URL.includes('?') ? '&' : '?'}game=${game}` : ''}`;

app.post('/bot', async (req, res) => {
  if (!WEBHOOK_SECRET || req.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) return res.sendStatus(401);
  const msg = req.body?.message;
  if (msg?.text?.startsWith('/start') && APP_URL && msg.from) {
    // /start ref_<id>: Telegram is the trusted source of who invited whom (webhook is secret-checked)
    const ref = /^\/start ref_(-?\d{1,15})$/.exec(msg.text.trim())?.[1];
    if (ref) await getDb().then(db => db.tx(q => ensureUser(q, msg.from, Number(ref)))).catch(e => console.error('referral', e));
    await tgSend({
      chat_id: msg.chat.id,
      text: '🎮 Plus Games — 4 quick games, one wallet.\n\nYou start with 1,000 free coins. Pick a game:',
      reply_markup: { inline_keyboard: [
        [{ text: '💣 Mines', web_app: { url: appLink('mines') } }, { text: '🚀 Crash', web_app: { url: appLink('crash') } }],
        [{ text: '🎡 Roulette', web_app: { url: appLink('roulette') } }, { text: '💩 Poop', web_app: { url: appLink('poop') } }],
        [{ text: '🏠 Open lobby', web_app: { url: appLink() } }],
      ] },
    });
  }
  res.sendStatus(200);
});

app.use((err, _req, res, _next) => {
  if (err.status) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err.code === '23505') return res.status(409).json({ error: 'Finish your current round first' }); // unique index backstop
  console.error(err);
  res.status(500).json({ error: 'Server error, try again' });
});

if (!process.env.VERCEL && process.argv[1]?.endsWith('server.js')) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`http://localhost:${port}`));
}

export default app;
