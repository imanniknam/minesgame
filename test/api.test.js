// End-to-end against an in-memory Postgres (PGlite) using the dev auth header.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.ALLOW_DEV_AUTH = '1';
// TEST_DATABASE_URL runs the same suite against real Postgres (true row-lock concurrency); default is in-memory PGlite.
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; else delete process.env.DATABASE_URL;
process.env.BOT_TOKEN = '123:TEST';
const { default: app } = await import('../server.js');
const { verifyInitData } = await import('../lib/telegram.js');

let server, base;
before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api`; r(); }); }));
after(async () => {
  server.close();
  if (process.env.DATABASE_URL) { // test users have negative ids (Telegram never issues those); remove them
    const { getDb } = await import('../lib/db.js');
    const db = await getDb();
    for (const t of ['ledger', 'games', 'users']) await db.query(`DELETE FROM ${t} WHERE ${t === 'users' ? 'id' : 'user_id'} < 0`);
    process.exit(0); // close pg pool
  }
});

let uidSeq = -(Date.now() % 1e9); // negative: never a real Telegram id
const client = (uid = --uidSeq) => async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-dev-user': String(uid) }, body: body && JSON.stringify(body) });
  return { status: r.status, ...(await r.json()) };
};

test('rejects calls without valid Telegram auth', async () => {
  const r = await fetch(base + '/state');
  assert.equal(r.status, 401);
});

test('initData HMAC check accepts real signature, rejects tampering and stale data', () => {
  const token = '123:TEST', now = 1_700_000_000;
  const fields = { auth_date: String(now), user: JSON.stringify({ id: 42, first_name: 'A' }) };
  const dcs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  const qs = new URLSearchParams({ ...fields, hash }).toString();
  assert.equal(verifyInitData(qs, token, now + 5).user.id, 42);
  assert.equal(verifyInitData(qs.replace('42', '43'), token, now + 5), null);
  assert.equal(verifyInitData(qs, token, now + 90000), null);
  assert.equal(verifyInitData(qs, '999:OTHER', now + 5), null);
});

test('new user gets 1000, bet deducts, mines never leak while active', async () => {
  const c = client();
  assert.equal((await c('GET', '/state')).user.balance, 1000);
  const b = await c('POST', '/bet', { bet: 50 });
  assert.equal(b.balance, 950);
  assert.equal(b.game.mines, undefined);
  assert.equal(b.game.seed, undefined);
  assert.equal((await c('POST', '/bet', { bet: 999 })).status, 400);
});

test('cannot bet twice in parallel (one active round, no double spend)', async () => {
  const c = client();
  const rs = await Promise.all(Array.from({ length: 8 }, () => c('POST', '/bet', { bet: 100 })));
  assert.equal(rs.filter(r => r.status === 200).length, 1);
  assert.equal((await c('GET', '/state')).user.balance, 900);
});

test('cash out before any tile is refused; parallel cash-outs pay exactly once', async () => {
  const c = client();
  await c('POST', '/bet', { bet: 100 });
  assert.equal((await c('POST', '/cashout')).status, 400);
  // find a safe cell by trying until one is safe; if we hit a mine first, start over
  let g;
  for (let cell = 0; cell < 9; cell++) {
    g = (await c('POST', '/reveal', { cell })).game;
    if (g.status === 'busted') { await c('POST', '/bet', { bet: 100 }); cell = -1; continue; }
    break;
  }
  const before = (await c('GET', '/state')).user.balance;
  const rs = await Promise.all(Array.from({ length: 6 }, () => c('POST', '/cashout')));
  const ok = rs.filter(r => r.status === 200);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].balance, before + 122); // 100 * 1.22
  assert.equal((await c('GET', '/state')).user.balance, before + 122);
});

test('hitting a mine loses the bet and reveals seed that reproduces the board', async () => {
  const c = client();
  const { minesFromSeed } = await import('../lib/mines.js');
  const { createHash } = await import('node:crypto');
  await c('POST', '/bet', { bet: 10 });
  let g;
  for (let cell = 0; cell < 9; cell++) {
    g = (await c('POST', '/reveal', { cell })).game;
    if (g.status !== 'active') break;
  }
  if (g.status === 'busted') {
    assert.equal(g.payout, 0);
    assert.deepEqual(minesFromSeed(g.seed), g.mines);
    assert.equal(createHash('sha256').update(g.seed).digest('hex'), g.seedHash);
  } else assert.equal(g.status, 'cashed'); // impossible: 9 reveals always hit a mine before clearing
  const h = await c('GET', '/history');
  assert.equal(h.games.length, 1);
});

test('refresh mid-round restores the same round', async () => {
  const c = client();
  const { game } = await c('POST', '/bet', { bet: 10 });
  const s = await c('GET', '/state');
  assert.equal(s.game.id, game.id);
  assert.equal(s.game.status, 'active');
});

test('daily bonus once per 24h, even under parallel claims', async () => {
  const c = client();
  const rs = await Promise.all(Array.from({ length: 5 }, () => c('POST', '/bonus')));
  assert.equal(rs.filter(r => r.status === 200).length, 1);
  assert.equal((await c('GET', '/state')).user.balance, 1100);
});
