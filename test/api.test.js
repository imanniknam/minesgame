// End-to-end over HTTP with the dev auth header. Default: in-memory PGlite.
// TEST_DATABASE_URL runs the same suite against real Postgres (true row-lock concurrency).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';

process.env.ALLOW_DEV_AUTH = '1';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; else delete process.env.DATABASE_URL;
process.env.BOT_TOKEN = '123:TEST';
process.env.WEBHOOK_SECRET = 'hook';
process.env.APP_URL = 'https://example.test/index.html';
process.env.ENABLED_GAMES = 'mines,crash,roulette,poop'; // production shows Mines only; the suite still covers every game
const { default: app } = await import('../server.js');
const { verifyInitData } = await import('../lib/telegram.js');
const mines = await import('../lib/games/mines.js');
const roulette = await import('../lib/games/roulette.js');
const crash = await import('../lib/games/crash.js');
const poop = await import('../lib/games/poop.js');

let server, origin;
before(() => new Promise(r => { server = app.listen(0, () => { origin = `http://127.0.0.1:${server.address().port}`; r(); }); }));
after(async () => {
  server.close();
  if (process.env.DATABASE_URL) { // test users have negative ids (Telegram never issues those); remove them
    const { getDb } = await import('../lib/db.js');
    const db = await getDb();
    await db.query('DELETE FROM ledger WHERE user_id < 0');
    await db.query('DELETE FROM games WHERE user_id < 0');
    await db.query('DELETE FROM users WHERE id < 0');
    process.exit(0); // close pg pool
  }
});

let uidSeq = -(Date.now() % 1e9); // negative: never a real Telegram id
const client = (uid = --uidSeq) => {
  const c = async (method, path, body) => {
    const r = await fetch(origin + '/api' + path, { method, headers: { 'content-type': 'application/json', 'x-dev-user': String(uid) }, body: body && JSON.stringify(body) });
    return { status: r.status, ...(await r.json()) };
  };
  c.uid = uid;
  return c;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const balance = async c => (await c('GET', '/state')).user.balance;

test('rejects calls without valid Telegram auth', async () => {
  assert.equal((await fetch(origin + '/api/state')).status, 401);
});

test('initData HMAC: accepts real signature, rejects tampering, stale data, other bot', () => {
  const token = '123:TEST', now = 1_700_000_000;
  const fields = { auth_date: String(now), user: JSON.stringify({ id: 42, first_name: 'A' }) };
  const dcs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const hash = createHmac('sha256', createHmac('sha256', 'WebAppData').update(token).digest()).update(dcs).digest('hex');
  const qs = new URLSearchParams({ ...fields, hash }).toString();
  assert.equal(verifyInitData(qs, token, now + 5).user.id, 42);
  assert.equal(verifyInitData(qs.replace('42', '43'), token, now + 5), null);
  assert.equal(verifyInitData(qs, token, now + 90000), null);
  assert.equal(verifyInitData(qs, '999:OTHER', now + 5), null);
});

test('wallet: 1000 on signup, bad bet rejected, parallel bets -> one round only', async () => {
  const c = client();
  assert.equal(await balance(c), 1000);
  assert.equal((await c('POST', '/mines/bet', { bet: 999 })).status, 400);
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => c('POST', ['/mines/bet', '/poop/bet', '/crash/bet'][i % 3], { bet: 100 })));
  assert.equal(rs.filter(r => r.status === 200).length, 1);
  assert.equal(await balance(c), 900);
});

test('one active round across games, and retried start (same rid) is not charged twice', async () => {
  const c = client();
  const a = await c('POST', '/mines/bet', { bet: 10, rid: 'rid-aaaaaaaa' });
  const b = await c('POST', '/mines/bet', { bet: 10, rid: 'rid-aaaaaaaa' });
  assert.equal(a.game.id, b.game.id);
  assert.equal(await balance(c), 990);
  const other = await c('POST', '/roulette/spin', { bet: 10, type: 'red' });
  assert.equal(other.status, 409);
  assert.equal(other.activeGame, 'mines');
});

test('mines: bet can change before the first tile (difference charged/refunded), not after', async () => {
  const c = client();
  const a = (await c('POST', '/mines/bet', { bet: 10, rid: 'rid-change-a' })).game;
  const up = await c('POST', '/mines/bet', { bet: 100, rid: 'rid-change-b' });
  assert.equal(up.game.id, a.id); assert.equal(up.game.bet, 100); assert.equal(up.balance, 900);
  const replay = await c('POST', '/mines/bet', { bet: 10, rid: 'rid-change-a' }); // late retry of the first request
  assert.equal(replay.game.bet, 100); assert.equal(await balance(c), 900);
  const down = await c('POST', '/mines/bet', { bet: 50, rid: 'rid-change-c' });
  assert.equal(down.game.bet, 50); assert.equal(down.balance, 950);
  const same = await c('POST', '/mines/bet', { bet: 50 });
  assert.equal(same.status, 409);
  const r = await c('POST', '/mines/reveal', { cell: 0 });
  if (r.game.status === 'active') {
    assert.equal((await c('POST', '/mines/bet', { bet: 10 })).status, 409); // board is in play: bet is fixed
    assert.equal((await c('POST', '/mines/cashout')).game.payout, 61); // 50 × 1.22x
  } else assert.equal(r.game.bet, 50);
  const w = await c('GET', '/wallet');
  assert.deepEqual(w.items.filter(i => i.kind === 'bet' && i.game === 'mines').map(i => i.amount).reverse(), [-10, -90, 50]);
});

test('mines: no leak while active, parallel cash-outs pay once, seed reproduces board', async () => {
  const c = client();
  let g = (await c('POST', '/mines/bet', { bet: 100 })).game;
  assert.equal(g.mines, undefined); assert.equal(g.seed, undefined);
  assert.equal((await c('POST', '/mines/cashout')).status, 400);
  for (let cell = 0; cell < 9; cell++) {
    g = (await c('POST', '/mines/reveal', { cell })).game;
    if (g.status === 'busted') { g = (await c('POST', '/mines/bet', { bet: 100 })).game; cell = -1; continue; }
    break;
  }
  const before = await balance(c);
  const rs = await Promise.all(Array.from({ length: 6 }, () => c('POST', '/mines/cashout')));
  const ok = rs.filter(r => r.status === 200);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].balance, before + 122);
  assert.deepEqual(mines.minesFromSeed(ok[0].game.seed), ok[0].game.mines);
  assert.equal(createHash('sha256').update(ok[0].game.seed).digest('hex'), ok[0].game.seedHash);
});

test('roulette: server spin, correct payout, history row', async () => {
  const c = client();
  const r = await c('POST', '/roulette/spin', { bet: 100, type: 'number', number: 7 });
  assert.equal(r.status, 200);
  const n = r.game.number;
  assert.equal(roulette.numberFromSeed(r.game.seed), n);
  assert.equal(r.balance, n === 7 ? 1000 - 100 + 3600 : 900);
  assert.equal((await c('POST', '/roulette/spin', { bet: 10, type: 'number', number: 37 })).status, 400);
  assert.equal((await c('POST', '/roulette/spin', { bet: 10, type: 'green' })).status, 400);
  const h = await c('GET', '/history?game=roulette');
  assert.equal(h.games[0].number, n);
});

test('roulette: parallel spins never overspend', async () => {
  const c = client();
  const rs = await Promise.all(Array.from({ length: 15 }, () => c('POST', '/roulette/spin', { bet: 100, type: 'red' })));
  const ok = rs.filter(r => r.status === 200);
  const final = await balance(c);
  const wins = ok.filter(r => r.game.won).length;
  assert.equal(final, 1000 - ok.length * 100 + wins * 200);
  assert.ok(final >= 0);
});

test('poop: follows hidden answers, idempotent per stage, cash out once', async () => {
  const c = client();
  let { game: g } = await c('POST', '/poop/bet', { bet: 10 });
  assert.equal(g.next, 1.9);
  // play to a loss with deliberately random picks; the round must end busted or cashed at stage 5
  for (let s = 0; s < 5 && g.status === 'active'; s++) {
    const pick = await c('POST', '/poop/pick', { choice: s % 2, stage: s });
    const again = await c('POST', '/poop/pick', { choice: 1 - (s % 2), stage: s }); // replay of same stage: ignored
    if (pick.game.status === 'active') assert.deepEqual(again.game.picks, pick.game.picks);
    else assert.equal(again.status, 409); // round already over: nothing to replay into
    g = pick.game;
    if (g.status === 'active') {
      assert.equal(g.multiplier, poop.LADDER[s] / 100);
      if (s === 1) { // cash out after 2 correct
        const rs = await Promise.all([1, 2, 3].map(() => c('POST', '/poop/cashout')));
        assert.equal(rs.filter(r => r.status === 200).length, 1);
        g = rs.find(r => r.status === 200).game;
        assert.equal(g.payout, 38);
      }
    }
  }
  assert.notEqual(g.status, 'active');
  g.answers.forEach((a, i) => assert.equal(poop.answer(g.seed, i), a));
});

test('crash: crash point hidden, cash out before start refused, parallel cash-outs pay once', async () => {
  const c = client();
  const { game: g } = await c('POST', '/crash/bet', { bet: 100 });
  assert.equal(g.crash, undefined);
  const early = await c('POST', '/crash/cashout');
  if (Date.now() < g.startsAt) assert.equal(early.status, 400); // still in countdown (skipped on a slow link to a remote DB)
  await sleep(crash.COUNTDOWN_MS + 150);
  const rs = await Promise.all(Array.from({ length: 5 }, () => c('POST', '/crash/cashout')));
  assert.ok(rs.every(r => r.status === 200));
  const done = rs.find(r => !r.late)?.game ?? rs[0].game;
  assert.notEqual(done.status, 'active');
  assert.equal(crash.crashFromSeed(done.seed) / 100, done.crash);
  const final = await balance(c);
  if (done.won) {
    assert.ok(done.multiplier < done.crash);
    assert.equal(final, 900 + done.payout);
  } else assert.equal(final, 900); // instant bust (~5%)
  const h = await c('GET', '/history?game=crash');
  assert.equal(h.games.length, 1);
});

test('crash: round ends on the server even if the client disappears (auto cash-out honoured)', async () => {
  const c = client();
  await c('POST', '/crash/bet', { bet: 50, auto: 1.05 });
  await sleep(crash.COUNTDOWN_MS + 1200); // ~1.07x on the server clock, nobody polls meanwhile
  const s = await c('GET', '/state'); // reconnect
  assert.equal(s.game, null);
  const [g] = (await c('GET', '/history?game=crash')).games;
  if (g.crash > 1.05) { assert.equal(g.won, true); assert.equal(g.multiplier, 1.05); assert.equal(s.user.balance, 950 + 52.5); }
  else { assert.equal(g.won, false); assert.equal(s.user.balance, 950); }
});

// ---------- white-box: read the hidden outcome from the DB to drive exact paths ----------
const dbq = async (sql, p) => (await (await import('../lib/db.js')).getDb()).query(sql, p);
const activeRow = async uid => (await dbq(`SELECT * FROM games WHERE user_id=$1 AND status='active'`, [uid])).rows[0];

test('mines: clearing all 7 safe tiles auto-pays 34.20x; revealing a used tile is idempotent', async () => {
  const c = client();
  await c('POST', '/mines/bet', { bet: 100 });
  const { mines: bombs } = await activeRow(c.uid);
  const safe = [...Array(9).keys()].filter(x => !bombs.includes(x));
  let r;
  for (const [i, cell] of safe.entries()) {
    r = await c('POST', '/mines/reveal', { cell });
    if (i < 6) {
      assert.equal(r.game.status, 'active');
      assert.equal(r.game.multiplier, mines.LADDER[i] / 100);
      assert.deepEqual((await c('POST', '/mines/reveal', { cell })).game.revealed, r.game.revealed); // replay
    }
  }
  assert.equal(r.game.status, 'cashed');
  assert.equal(r.game.multiplier, 34.2);
  assert.equal(r.balance, 900 + 3420);
  assert.equal((await c('POST', '/mines/cashout')).status, 409);
});

test('poop: perfect 5-stage run auto-pays 30.40x', async () => {
  const c = client();
  await c('POST', '/poop/bet', { bet: 50 });
  const { seed } = await activeRow(c.uid);
  let r;
  for (let s = 0; s < 5; s++) r = await c('POST', '/poop/pick', { choice: poop.answer(seed, s), stage: s });
  assert.equal(r.game.status, 'cashed');
  assert.equal(r.game.stage, 5);
  assert.equal(r.game.payout, 50 * 30.4);
  assert.equal(r.balance, 950 + 1520);
});

test('crash: cash-out after the crash point pays nothing; before it pays bet x server multiplier', async () => {
  const c = client();
  // force a 1.01x crash, then try to cash out at ~1.06x
  await c('POST', '/crash/bet', { bet: 100 });
  await dbq(`UPDATE games SET data = jsonb_set(data, '{crash}', '101') WHERE user_id=$1 AND status='active'`, [c.uid]);
  await sleep(crash.COUNTDOWN_MS + 1000);
  const late = await c('POST', '/crash/cashout');
  assert.equal(late.game.won, false);
  assert.equal(late.balance, 900);
  // force a far crash point and cash out mid-flight
  await c('POST', '/crash/bet', { bet: 100 });
  await dbq(`UPDATE games SET data = jsonb_set(data, '{crash}', '100000') WHERE user_id=$1 AND status='active'`, [c.uid]);
  await sleep(crash.COUNTDOWN_MS + 800);
  const out = await c('POST', '/crash/cashout');
  assert.equal(out.game.won, true);
  assert.ok(out.game.multiplier >= 1.04 && out.game.multiplier < 1.2, `m=${out.game.multiplier}`);
  assert.equal(out.game.payout, Math.round(100 * out.game.multiplier * 100) / 100);
  assert.equal(out.balance, 800 + out.game.payout);
});

test('input fuzzing: every bad payload is a clean 4xx, never 500, never charged', async () => {
  const c = client();
  const bad = [
    ['/mines/bet', { bet: 0 }], ['/mines/bet', { bet: -10 }], ['/mines/bet', { bet: 10.5 }], ['/mines/bet', { bet: '10' }],
    ['/mines/bet', { bet: [10] }], ['/mines/bet', {}], ['/mines/bet', { bet: 10, rid: 'x' }], ['/mines/bet', { bet: 10, rid: 'a'.repeat(65) }],
    ['/crash/bet', { bet: 10, auto: 1 }], ['/crash/bet', { bet: 10, auto: 1001 }], ['/crash/bet', { bet: 10, auto: '2' }],
    ['/roulette/spin', { bet: 10 }], ['/roulette/spin', { bet: 10, type: 'number' }], ['/roulette/spin', { bet: 10, type: 'number', number: -1 }],
    ['/roulette/spin', { bet: 10, type: 'number', number: 1.5 }], ['/roulette/spin', { bet: 10, type: '__proto__' }], ['/roulette/spin', { bet: 10, type: 'toString' }],
    ['/poop/pick', { choice: 0 }], ['/mines/reveal', { cell: 0 }], ['/mines/cashout', {}], ['/poop/cashout', {}],
  ];
  for (const [path, body] of bad) {
    const r = await c('POST', path, body);
    assert.ok(r.status >= 400 && r.status < 500, `${path} ${JSON.stringify(body)} -> ${r.status}`);
  }
  await c('POST', '/mines/bet', { bet: 10 });
  for (const cell of [-1, 9, 1.5, '1', null]) assert.equal((await c('POST', '/mines/reveal', { cell })).status, 400);
  for (const q of ['?game=toString', '?game=constructor', '?game=__proto__', '?game=nope', '?game=mines&game=crash']) assert.equal((await c('GET', '/history' + q)).status, 400, q);
  const raw = await fetch(origin + '/api/mines/cashout', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user': String(c.uid) }, body: '{bad json' });
  assert.equal(raw.status, 400);
  assert.equal(await balance(c), 990); // only the one valid bet was charged
});

test('a request id used for one game cannot replay into another', async () => {
  const c = client();
  await c('POST', '/roulette/spin', { bet: 10, type: 'red', rid: 'rid-cross-0001' });
  const r = await c('POST', '/mines/bet', { bet: 10, rid: 'rid-cross-0001' });
  assert.equal(r.status, 409);
});

test('race: parallel reveals + cash-out on one board stay consistent', async () => {
  const c = client();
  await c('POST', '/mines/bet', { bet: 100 });
  const rs = await Promise.all([...[0, 1, 2, 3, 4, 5, 6, 7, 8].map(cell => c('POST', '/mines/reveal', { cell })), c('POST', '/mines/cashout')]);
  assert.ok(rs.every(r => r.status === 200 || r.status === 409 || r.status === 400));
  const [g] = (await c('GET', '/history?game=mines')).games;
  const final = await balance(c);
  assert.equal(final, 900 + g.payout);
  if (g.won) assert.equal(g.payout, (100 * mines.LADDER[g.revealed.length - 1]) / 100);
  else assert.ok(g.mines.includes(g.revealed.at(-1)));
});

test('ledger invariant: for every user, balance == sum(ledger) and every settled round paid exactly', async () => {
  const { rows: users } = await dbq(`SELECT u.id, u.balance, COALESCE(SUM(l.amount),0) AS total, MIN(l.balance_after) AS lowest
    FROM users u LEFT JOIN ledger l ON l.user_id=u.id GROUP BY u.id`);
  assert.ok(users.length > 10);
  for (const u of users) {
    assert.equal(Number(u.balance), Number(u.total), `user ${u.id}`);
    assert.ok(Number(u.lowest) >= 0, `user ${u.id} went negative`);
  }
  const { rows: bad } = await dbq(`SELECT id FROM games WHERE
       (status='cashed' AND payout <> bet * mult_x100 / 100) OR (status='busted' AND payout <> 0)
    OR (status <> 'active' AND ended_at IS NULL)`);
  assert.deepEqual(bad, []);
  const { rows: wins } = await dbq(`SELECT g.id FROM games g WHERE g.status='cashed'
     AND (SELECT COUNT(*) FROM ledger l WHERE l.game_id=g.id AND l.kind='win') <> 1`);
  assert.deepEqual(wins, []); // each win paid exactly once
  const { rows: multi } = await dbq(`SELECT user_id FROM games WHERE status='active' GROUP BY user_id HAVING COUNT(*) > 1`);
  assert.deepEqual(multi, []);
});

test('wallet ledger and profile stats reflect real rounds', async () => {
  const c = client();
  const spin = await c('POST', '/roulette/spin', { bet: 50, type: 'odd' });
  const w = await c('GET', '/wallet');
  assert.deepEqual(w.items.map(i => i.kind).slice(-2), ['bet', 'signup']);
  assert.equal(w.items[0].balance, spin.balance);
  assert.ok(w.items.some(i => i.kind === 'bet' && i.amount === -50 && i.game === 'roulette'));
  const p = await c('GET', '/profile');
  assert.deepEqual([p.rounds, p.xp, p.wins], [1, 50, spin.game.won ? 1 : 0]);
  assert.equal(p.net, spin.game.net);
});

test('daily bonus once per 24h under parallel claims', async () => {
  const c = client();
  const rs = await Promise.all(Array.from({ length: 5 }, () => c('POST', '/bonus')));
  assert.equal(rs.filter(r => r.status === 200).length, 1);
  assert.equal(await balance(c), 1100);
});

test('referral: only a brand-new user via the bot credits the inviter, never self', async () => {
  const inviter = client();
  await inviter('GET', '/state');
  const hook = (from, text) => fetch(origin + '/bot', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'hook' },
    body: JSON.stringify({ message: { text, chat: { id: from }, from: { id: from, first_name: 'N' } } }),
  });
  assert.equal((await fetch(origin + '/bot', { method: 'POST' })).status, 401);
  const newbie = --uidSeq;
  assert.equal((await hook(newbie, `/start ref_${inviter.uid}`)).status, 200);
  assert.equal(await balance(inviter), 1200);
  await hook(newbie, `/start ref_${inviter.uid}`); // existing user again: no second reward
  await hook(inviter.uid, `/start ref_${inviter.uid}`); // self
  assert.equal(await balance(inviter), 1200);
  assert.equal((await inviter('GET', '/state')).user.invited, 1);
  assert.equal(await balance(client(newbie)), 1000);
});
