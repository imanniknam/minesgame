# 💣 Mines — Telegram Mini App

Open tiles on a 3×3 board, dodge 2 hidden bombs, cash out whenever you like. Virtual coins only.

- **Bot:** [@MinegamePlus_bot](https://t.me/MinegamePlus_bot) → `/start` → **Play**
- **App:** https://mines-tma.vercel.app (only works inside Telegram; outside it shows an "Open in Telegram" screen)

## Features

| Area | What's there |
|---|---|
| Telegram | `/start` button + menu button open the Mini App; user identified from signed `initData` (no sign-up); theme colors, haptics, expand |
| Wallet | 1,000 coins on first open · bets 10/50/100 · live balance · every change written to an append-only `ledger` |
| Game | 3×3, 2 bombs · multiplier ladder shown up front · cash out after the 1st safe tile · board cleared → auto cash-out at 34.20x |
| History | Last 10 rounds: bet, safe tiles, final multiplier, net win/loss, time |
| Bonus | 🎁 Daily +100 coins (24h cooldown) · 🏆 Leaderboard by total virtual profit · 🔒 Provably fair with an in-browser verifier |

## Odds

7 safe tiles of 9. Probability of surviving *k* picks: `P(k) = C(7,k) / C(9,k)`.
Multiplier = `0.95 / P(k)`, floored to 2 decimals (5% house edge, RTP ≤ 95% at every step — unit tested).

| Safe tiles | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| Multiplier | 1.22x | 1.62x | 2.28x | 3.42x | 5.70x | 11.40x | 34.20x |

Computed in integer math (`lib/mines.js`), and balances are stored as integer cents, so no float rounding bugs.

## Architecture

```
Telegram ──/start──▶ POST /bot (webhook, secret-token checked) ──▶ sendMessage(web_app button)
Mini App (public/, vanilla JS) ──Authorization: tma <initData>──▶ Express API (server.js) ──▶ Postgres (Neon)
```

- **Vercel** runs `server.js` as one serverless function; `public/` is served from the CDN.
- **Postgres** tables: `users` (balance, `CHECK balance >= 0`), `games` (mines, revealed, status, seed), `ledger`.
- No frontend framework: three static files. The client only renders what the server returns.

## Anti-cheat and consistency

| Threat | Defense |
|---|---|
| Fake user / stealing someone's wallet | `initData` HMAC-SHA256 checked against the bot token on **every** request, with a timing-safe compare and a 24h freshness limit |
| Seeing the bombs | Mines are generated server-side (`crypto.randomBytes`) and never sent until the round ends |
| Tampering with balance or multiplier | Client sends only `{bet}` (whitelist 10/50/100) and `{cell}` (0–8); all math is done server-side |
| Double spend (parallel bets) | Bet runs in one transaction with `SELECT … FOR UPDATE` on the user, plus a **partial unique index** `one_active_game(user_id) WHERE status='active'` as a DB-level backstop |
| Double cash-out / reveal after the round ended | `SELECT … FOR UPDATE` on the active game; the first request moves it out of `active`, so later ones get `409` |
| Double daily bonus | A single conditional `UPDATE … WHERE last_bonus_at <= now() - 24h` |
| Refresh / disconnect mid-round | The round lives in the DB; `GET /api/state` returns it, and the app resyncs on focus and on `online` |
| "Rigged board" claims | The SHA-256 of the seed is shown at bet time and the seed is revealed after; the in-app **Verify** recomputes the bombs |

Tested (`npm test`) on PGlite, and on real Postgres via `TEST_DATABASE_URL`: parallel bets → exactly one; 6 parallel cash-outs → paid once; parallel bonus claims → one; forged or stale `initData` rejected.

## Run locally

```bash
npm install
echo ALLOW_DEV_AUTH=1 > .env        # dev-only header auth, ignored on Vercel
npm run dev                         # http://localhost:3000/?dev=123  (in-memory Postgres via PGlite)
npm test
```

Deploy: `vercel deploy --prod` with env `DATABASE_URL`, `BOT_TOKEN`, `WEBHOOK_SECRET`, `APP_URL`, `BOT_USERNAME`, then `npm run setup-bot` (sets the webhook, commands and menu button).

## AI tools and process

Built with **Claude Code**, following the [Ponytail](https://github.com/DietrichGebert/ponytail) rules: write the least code that fully solves the task, but never cut validation, security or tests. Hence no framework, a single API file, and DB constraints instead of app-level locks wherever possible.

## Product decisions

- **Integer cents + floored multipliers:** the house edge never leaks through rounding.
- **DB as the source of truth for concurrency:** row locks and unique indexes work across serverless instances; in-memory locks wouldn't.
- **Provably fair:** cheap to build, and it answers the first question every player of these games asks.
- **Daily bonus:** a retention loop, and it also stops users getting stuck at 0 coins.

## Known limits / next 4 hours

- No per-user rate limiting (`shortcut:` add Upstash rate limit if abused).
- Leaderboard is computed on the fly (fine to ~100k games; then materialize it).
- Next: referral links (`start_param` is already parsed in `verifyInitData`), board-size and bomb-count choice, sound, and a channel-membership bonus via `getChatMember`.
