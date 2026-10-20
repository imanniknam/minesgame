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
