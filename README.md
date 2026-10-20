# ðŸ’£ Mines â€” Telegram Mini App

Open tiles on a 3Ã—3 board, dodge 2 hidden bombs, cash out whenever you like. Virtual coins only.

- **Bot:** [@Plusgames_bot](https://t.me/Plusgames_bot) â†’ `/start` â†’ **Play**
- **App:** https://mines-tma.vercel.app (only works inside Telegram; outside it shows an "Open in Telegram" screen)

## Features

| Area | What's there |
|---|---|
| Telegram | `/start` button + menu button open the Mini App; user identified from signed `initData` (no sign-up); theme colors, haptics, expand |
| Wallet | 1,000 coins on first open Â· bets 10/50/100 Â· live balance Â· every change written to an append-only `ledger` |
| Game | 3Ã—3, 2 bombs Â· multiplier ladder shown up front Â· cash out after the 1st safe tile Â· board cleared â†’ auto cash-out at 34.20x |
| History | Last 10 rounds: bet, safe tiles, final multiplier, net win/loss, time |
| Bonus | ðŸŽ Daily +100 coins (24h cooldown) Â· ðŸ† Leaderboard by total virtual profit Â· ðŸ”’ Provably fair with an in-browser verifier |

## Odds

7 safe tiles of 9. Probability of surviving *k* picks: `P(k) = C(7,k) / C(9,k)`.
Multiplier = `0.95 / P(k)`, floored to 2 decimals (5% house edge, RTP â‰¤ 95% at every step â€” unit tested).

| Safe tiles | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| Multiplier | 1.22x | 1.62x | 2.28x | 3.42x | 5.70x | 11.40x | 34.20x |

Computed in integer math (`lib/mines.js`), and balances are stored as integer cents, so no float rounding bugs.

## Architecture

```
Telegram â”€â”€/startâ”€â”€â–¶ POST /bot (webhook, secret-token checked) â”€â”€â–¶ sendMessage(web_app button)
Mini App (public/, vanilla JS) â”€â”€Authorization: tma <initData>â”€â”€â–¶ Express API (server.js) â”€â”€â–¶ Postgres (Neon)
```

- **Vercel** runs `server.js` as one serverless function; `public/` is served from the CDN.
- **Postgres** tables: `users` (balance, `CHECK balance >= 0`), `games` (mines, revealed, status, seed), `ledger`.
- No frontend framework: three static files. The client only renders what the server returns.

## Anti-cheat and consistency

| Threat | Defense |
|---|---|
| Fake user / stealing someone's wallet | `initData` HMAC-SHA256 checked against the bot token on **every** request, with a timing-safe compare and a 24h freshness limit |
| Seeing the bombs | Mines are generated server-side (`crypto.randomBytes`) and never sent until the round ends |
| Tampering with balance or multiplier | Client sends only `{bet}` (whitelist 10/50/100) and `{cell}` (0â€“8); all math is done server-side |
| Double spend (parallel bets) | Bet runs in one transaction with `SELECT â€¦ FOR UPDATE` on the user, plus a **partial unique index** `one_active_game(user_id) WHERE status='active'` as a DB-level backstop |
| Double cash-out / reveal after the round ended | `SELECT â€¦ FOR UPDATE` on the active game; the first request moves it out of `active`, so later ones get `409` |
| Double daily bonus | A single conditional `UPDATE â€¦ WHERE last_bonus_at <= now() - 24h` |
| Refresh / disconnect mid-round | The round lives in the DB; `GET /api/state` returns it, and the app resyncs on focus and on `online` |
| "Rigged board" claims | The SHA-256 of the seed is shown at bet time and the seed is revealed after; the in-app **Verify** recomputes the bombs |

Tested (`npm test`) on PGlite, and on real Postgres via `TEST_DATABASE_URL`: parallel bets â†’ exactly one; 6 parallel cash-outs â†’ paid once; parallel bonus claims â†’ one; forged or stale `initData` rejected.

## Run locally

```bash
npm install
echo ALLOW_DEV_AUTH=1 > .env        # dev-only header auth, ignored on Vercel
npm run dev                         # http://localhost:3000/?dev=123  (in-memory Postgres via PGlite)
npm test
```

Deploy: `vercel deploy --prod` with env `DATABASE_URL`, `BOT_TOKEN`, `WEBHOOK_SECRET`, `APP_URL`, `BOT_USERNAME`, then `npm run setup-bot` (sets the webhook, commands and menu button).

## Process

Built following the [Ponytail](https://github.com/DietrichGebert/ponytail) rules: write the least code that fully solves the task, but never cut validation, security or tests. Hence no framework, a single API file, and DB constraints instead of app-level locks wherever possible.

## Product decisions

- **Integer cents + floored multipliers:** the house edge never leaks through rounding.
- **DB as the source of truth for concurrency:** row locks and unique indexes work across serverless instances; in-memory locks wouldn't.
- **Provably fair:** cheap to build, and it answers the first question every player of these games asks.
- **Daily bonus:** a retention loop, and it also stops users getting stuck at 0 coins.

## Known limits / next 4 hours

- No per-user rate limiting (`shortcut:` add Upstash rate limit if abused).
- Leaderboard is computed on the fly (fine to ~100k games; then materialize it).
- Next: referral links (`start_param` is already parsed in `verifyInitData`), board-size and bomb-count choice, sound, and a channel-membership bonus via `getChatMember`.
