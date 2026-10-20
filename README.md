# 🎮 Plus Games — Telegram Mini App game hub

Four quick games in one Telegram bot, one wallet, one account: **💣 Mines · 🚀 Crash · 🎡 Roulette · 💩 Poop**. Virtual coins only.

- **Bot:** [@Plusgames_bot](https://t.me/Plusgames_bot) → `/start` → pick a game (or the **Play** menu button for the lobby)
- **App:** https://mines-tma.vercel.app (runs inside Telegram; outside it shows an "Open in Telegram" screen)

## Features

| Area | What's there |
|---|---|
| Telegram | `/start` sends 4 game buttons + lobby; deep link `?game=` opens a game directly; user identified from signed `initData` (no sign-up); native BackButton, theme colors, haptics |
| Wallet | 1,000 coins on first open · bets 10/50/100 · live balance shared by all games · every change in an append-only `ledger` |
| Mines | 3×3, 2 bombs · multiplier ladder shown up front · cash out after the 1st safe tile · board cleared → auto cash-out at 34.20x |
| Crash | Multiplier rises from 1.00x on the server clock · Waiting / Running / Crashed / Cashed out · live curve + rocket · **auto cash-out** · your recent crash points |
| Roulette | European 0–36 · Red/Black 2x, Odd/Even 2x, Straight number 36x · zero loses outside bets · SVG wheel lands exactly on the server's number |
| Poop | 💩 or 😂, 50/50 per stage, up to 5 stages · table 1.90 / 3.80 / 7.60 / 15.20 / 30.40x · cash out after any win · stage 5 auto-pays |
| History | Last 10 rounds, filterable per game, with game-specific details (crash point, winning number, stages…) |
| Bonus | 🎁 Daily +100 · 🏆 Leaderboard by total virtual profit · 👥 Referral +200 per new friend · 🔒 Provably fair with an in-browser verifier for every game |

## Odds (5% house edge everywhere, unit tested)

- **Mines:** `P(k) = C(7,k)/C(9,k)`, multiplier = `0.95 / P(k)` floored → 1.22, 1.62, 2.28, 3.42, 5.70, 11.40, 34.20x.
- **Crash:** `r` = 52 bits of `sha256(seed)` / 2^52, crash point `C = floor(95 / (1 − r)) / 100`, minimum 1.00x, capped at 1000x. A cash-out at M wins iff `M < C`, so `P(win) = 0.95 / (M + 0.01)` and RTP ≤ 95% for every M (≈5.9% of rounds bust instantly at 1.00x). Curve: `m(t) = e^(0.00006·t_ms)`.
- **Roulette:** standard European payouts (RTP 36/37 ≈ 97.3%); number = 32-bit chunks of `sha256(seed:i)` with rejection sampling, so there's no modulo bias.
- **Poop:** fixed table from the brief (`0.95 / 0.5^k`); each stage's answer is one bit of `sha256(seed:stage)`, fixed at bet time.

## Architecture

```
Telegram ──/start──▶ POST /bot (secret-token checked) ──▶ 4 web_app buttons (+ referral capture)
Mini App (public/, vanilla JS modules) ──Authorization: tma <initData>──▶ Express API ──▶ Postgres (Neon)
                                                            server.js        lib/core.js  (wallet, rounds)
                                                                             lib/games/{mines,crash,roulette,poop}.js
```

- **One core, four thin game modules.** All money moves through `openRound()` (debit + create round) and `settle()` (end once + pay) in `lib/core.js`, so the anti-double-spend rules exist in exactly one place.
- **Crash without websockets:** the crash point is fixed and hidden at bet time. The client animates the curve using a synced server clock and polls `/crash/status` (400 ms). The server prices a cash-out with **its own clock** and settles rounds lazily on any request, so a round still ends correctly if the player closes the app (auto cash-out included).
- **Vercel** runs `server.js` as one function; `public/` is served from the CDN. **Postgres** tables: `users`, `games` (`game`, `data jsonb`, seed, status), `ledger`.

## Anti-cheat and consistency

| Threat | Defense |
|---|---|
| Fake user | `initData` HMAC-SHA256 checked on **every** request, timing-safe, 24h freshness |
| Seeing the outcome | Bombs, crash point and stage answers stay server-side until the round ends; roulette is decided and settled in the same request |
| Tampering with amount or multiplier | Client sends only the bet (whitelist), cell, choice or bet type; every payout is computed server-side |
| Double spend / two games at once | Bet transaction locks the user row (`FOR UPDATE`), plus a partial unique index `one_active_game(user_id) WHERE status='active'` across **all** games |
| Double cash-out, late cash-out | Active round row-locked; the first request moves it out of `active`, later ones get `409`; crash cash-outs past the crash point lose |
| Retried or double-tapped start | Client request id (`rid`) with a unique index: a replay returns the same round and isn't charged twice |
| Double daily bonus, fake referral | Conditional `UPDATE … WHERE last_bonus_at <= now()-24h`; referrals only come from the Telegram webhook, only for brand-new users, never self |
| Refresh / disconnect | Rounds live in the DB; the app reopens the unfinished game automatically; crash rounds settle on the server clock |
| "Rigged" claims | `sha256(seed)` shown before play and the seed after; **Verify** recomputes the result in the browser |

Tests (`npm test`, 19): math and RTP per game, uniform roulette, crash resolution, parallel bets/cash-outs/spins/bonus claims, replayed requests, referral rules, lazy crash settlement. They pass on in-memory PGlite and on real Postgres (`TEST_DATABASE_URL=… npm test`).

## Run locally

```bash
npm install
echo ALLOW_DEV_AUTH=1 > .env        # dev-only header auth, ignored on Vercel
npm run dev                         # http://localhost:3000/index.html?dev=123  (in-memory Postgres via PGlite)
npm test
```

Deploy: `vercel deploy --prod` with env `DATABASE_URL`, `BOT_TOKEN`, `WEBHOOK_SECRET`, `APP_URL`, `BOT_USERNAME`, then `npm run setup-bot`.

## Process

Built following the [Ponytail](https://github.com/DietrichGebert/ponytail) rules: write the least code that fully solves the task, but never cut validation, security or tests. Hence no framework, DB constraints instead of app-level locks, and one shared money path for all four games.

## Product decisions

- **Hub instead of four apps:** one wallet means coins won in one game can be played in another, which drives retention. One bot is also one place to grow (referrals, daily bonus).
- **One active round across all games:** simpler for players and closes a whole class of double-spend bugs.
- **Integer cents + floored multipliers:** the house edge never leaks through rounding.
- **Polling over websockets for Crash:** works on serverless with no extra infrastructure. The server clock stays authoritative, so polling latency can only cost the player a later cash-out, never let them cheat.

## Known limits / next steps

- Crash is single-player with ~400 ms polling (`shortcut:` move to websockets/SSE for a shared multiplayer round).
- No per-user rate limiting (`shortcut:` add Upstash rate limit if abused).
- Leaderboard is computed on the fly (fine to ~100k rounds; then materialize it).
- Next: missions for Poop, a channel-membership bonus via `getChatMember`, sound effects.
