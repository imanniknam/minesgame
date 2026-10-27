// Black-box end-to-end test against a deployed instance, as real Telegram users would hit it.
// It re-implements every outcome rule independently (no imports from lib/) and checks the server against it.
//   BOT_TOKEN=... DATABASE_URL=... [BASE=https://mines-tma.vercel.app] node scripts/e2e-prod.mjs
// Test users get negative ids (Telegram never issues those) and are deleted at the end.
import { createHash, createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';

const BASE = process.env.BASE ?? 'https://mines-tma.vercel.app';
const { BOT_TOKEN, DATABASE_URL } = process.env;
if (!BOT_TOKEN || !DATABASE_URL) throw new Error('BOT_TOKEN and DATABASE_URL required');

const sha = s => createHash('sha256').update(s).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const close = (a, b) => Math.abs(a - b) < 1e-6; // our running totals are floats; the server's are integer cents

// ---------- independent reference rules ----------
const MINES_LADDER = [1.22, 1.62, 2.28, 3.42, 5.70, 11.40, 34.20];
const POOP_LADDER = [1.90, 3.80, 7.60, 15.20, 30.40];
const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const refMines = seed => [...Array(9).keys()].map(c => [c, sha(`${seed}:${c}`)]).sort((a, b) => (a[1] < b[1] ? -1 : 1)).slice(0, 2).map(x => x[0]).sort((a, b) => a - b);
const refPoop = (seed, i) => parseInt(sha(`${seed}:${i}`)[0], 16) & 1;
const refCrash = seed => Math.min(1000, Math.max(1, Math.floor(95 / (1 - parseInt(sha(seed).slice(0, 13), 16) / 2 ** 52)) / 100));
function refRoulette(seed) {
  const lim = Math.floor(2 ** 32 / 37) * 37;
  for (let i = 0; ; i++) { const v = parseInt(sha(`${seed}:${i}`).slice(0, 8), 16); if (v < lim) return v % 37; }
}
const refWins = (type, pick, n) => type === 'number' ? n === pick : n !== 0 && (type === 'red' ? REDS.has(n) : type === 'black' ? !REDS.has(n) : (n % 2 === 0) === (type === 'even'));

// ---------- clients ----------
function initData(id, { token = BOT_TOKEN, age = 0, tamper = false } = {}) {
  const f = { auth_date: String(Math.floor(Date.now() / 1000) - age), user: JSON.stringify({ id, first_name: `E2E${id}` }) };
  const dcs = Object.entries(f).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const hash = createHmac('sha256', createHmac('sha256', 'WebAppData').update(token).digest()).update(dcs).digest('hex');
  if (tamper) f.user = JSON.stringify({ id: id - 1, first_name: 'X' });
  return new URLSearchParams({ ...f, hash }).toString();
}
let nextId = -(100000 + (Date.now() % 100000)) * 10;
let requests = 0;
function player() {
  const id = nextId--, auth = 'tma ' + initData(id);
  const call = async (method, path, body, headers = {}) => {
    requests++;
    const r = await fetch(BASE + '/api' + path, { method, headers: { 'content-type': 'application/json', authorization: auth, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.status >= 500) throw new Error(`500 on ${method} ${path}: ${JSON.stringify(j)}`);
    return { status: r.status, ...j };
  };
  const p = { id, get: path => call('GET', path), post: (path, body = {}) => call('POST', path, body) };
  p.balance = async () => (await p.get('/state')).user.balance;
  return p;
}
const results = [];
async function check(name, fn) {
  const t = Date.now();
  try { await fn(); results.push(['PASS', name, Date.now() - t]); console.log(`  ✔ ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log(`  ✖ ${name}\n      ${e.message.split('\n').join('\n      ')}`); }
}
const fairOk = g => { assert.equal(sha(g.seed), g.seedHash, `seed hash mismatch game ${g.id}`); };

console.log(`E2E against ${BASE}\n`);

{ // this suite plays all four games; with only Mines switched on, scripts/e2e-mines.mjs is the one to run
  const s = await fetch(BASE + '/api/state', { headers: { authorization: 'tma ' + initData(nextId) } }).then(r => r.json());
  const on = Object.keys(s.config?.games ?? {}).sort().join();
  if (on !== 'crash,mines,poop,roulette') { console.log(`Enabled games: ${on || '?'} — run "npm run e2e:mines" instead.`); process.exit(2); }
}

// ---------- 1. auth ----------
await check('auth: missing / forged / expired / other-bot / dev-header all rejected; valid accepted', async () => {
  const id = nextId--;
  const raw = (h = {}) => fetch(BASE + '/api/state', { headers: h }).then(r => r.status);
  assert.equal(await raw(), 401);
  assert.equal(await raw({ authorization: 'tma ' + initData(id, { tamper: true }) }), 401);
  assert.equal(await raw({ authorization: 'tma ' + initData(id, { age: 90000 }) }), 401);
  assert.equal(await raw({ authorization: 'tma ' + initData(id, { token: '1:WRONG' }) }), 401);
  assert.equal(await raw({ 'x-dev-user': '123' }), 401); // dev auth must be off in production
  assert.equal(await raw({ authorization: 'tma ' + initData(id) }), 200);
});

await check('signup: 1,000 coins, ledger has the grant, config lists 4 games', async () => {
  const p = player(), s = await p.get('/state');
  assert.equal(s.user.balance, 1000);
  assert.deepEqual(Object.keys(s.config.games).sort(), ['crash', 'mines', 'poop', 'roulette']);
  assert.deepEqual(s.config.bets, [10, 50, 100]);
  const w = await p.get('/wallet');
  assert.deepEqual(w.items.map(i => [i.kind, i.amount]), [['signup', 1000]]);
});

// ---------- 2. validation ----------
await check('validation: 30 malformed payloads -> 4xx, nothing charged', async () => {
  const p = player();
  const bad = [
    ['/mines/bet', { bet: 0 }], ['/mines/bet', { bet: -100 }], ['/mines/bet', { bet: 10.5 }], ['/mines/bet', { bet: '10' }], ['/mines/bet', { bet: 1e9 }],
    ['/mines/bet', { bet: null }], ['/mines/bet', { bet: [10] }], ['/mines/bet', { bet: { $gt: 0 } }], ['/mines/bet', { bet: 10, rid: '../../x' }],
    ['/crash/bet', { bet: 10, auto: 1 }], ['/crash/bet', { bet: 10, auto: 0 }], ['/crash/bet', { bet: 10, auto: -5 }], ['/crash/bet', { bet: 10, auto: 1e6 }], ['/crash/bet', { bet: 10, auto: '2' }],
    ['/roulette/spin', { bet: 10 }], ['/roulette/spin', { bet: 10, type: 'green' }], ['/roulette/spin', { bet: 10, type: '__proto__' }], ['/roulette/spin', { bet: 10, type: 'constructor' }],
    ['/roulette/spin', { bet: 10, type: 'number' }], ['/roulette/spin', { bet: 10, type: 'number', number: 37 }], ['/roulette/spin', { bet: 10, type: 'number', number: '7' }],
    ['/poop/pick', { choice: 0 }], ['/poop/cashout', {}], ['/mines/reveal', { cell: 0 }], ['/mines/cashout', {}],
    ['/poop/bet', { bet: 5 }], ['/poop/bet', { bet: 101 }], ['/roulette/spin', { bet: 0, type: 'red' }], ['/crash/bet', { bet: 1 }], ['/mines/bet', { bet: Infinity }],
  ];
  for (const [path, body] of bad) {
    const r = await p.post(path, body);
    assert.ok(r.status >= 400 && r.status < 500, `${path} ${JSON.stringify(body)} -> ${r.status}`);
  }
  for (const q of ['toString', 'constructor', '__proto__', 'nope']) assert.equal((await p.get('/history?game=' + q)).status, 400, q);
  assert.equal(await p.balance(), 1000);
});

// ---------- 3. Mines ----------
await check('mines: 12 rounds, every outcome matches the seed, payouts exact, balance exact', async () => {
  const p = player();
  let expected = 1000;
  for (let round = 0; round < 12; round++) {
    const bet = [10, 50, 100][round % 3], target = 1 + (round % 4);
    let r = await p.post('/mines/bet', { bet });
    assert.equal(r.status, 200); expected -= bet;
    assert.ok(close(r.balance, expected));
    assert.equal(r.game.mines, undefined, 'mines leaked while active');
    assert.equal(r.game.seed, undefined, 'seed leaked while active');
    const order = [...Array(9).keys()].sort(() => Math.random() - 0.5);
    let g = r.game;
    for (const cell of order) {
      if (g.status !== 'active' || g.revealed.length >= target) break;
      r = await p.post('/mines/reveal', { cell }); g = r.game;
      if (g.status === 'active') assert.equal(g.mines, undefined);
    }
    if (g.status === 'active') { r = await p.post('/mines/cashout'); g = r.game; }
    fairOk(g);
    assert.deepEqual(g.mines, refMines(g.seed));
    const hitMine = g.mines.includes(g.revealed.at(-1));
    assert.equal(g.status, hitMine ? 'busted' : 'cashed');
    if (!hitMine) {
      assert.ok(g.revealed.every(c => !g.mines.includes(c)));
      assert.ok(close(g.multiplier, MINES_LADDER[g.revealed.length - 1]));
      assert.ok(close(g.payout, Math.round(bet * MINES_LADDER[g.revealed.length - 1] * 100) / 100));
      expected += g.payout;
    } else assert.equal(g.payout, 0);
    assert.ok(close(r.balance, expected), `balance ${r.balance} != ${expected}`);
  }
});

// ---------- 4. Roulette ----------
await check('roulette: 24 spins over every bet type match the seed and the payout table', async () => {
  const p = player();
  let expected = 1000;
  const types = [['red'], ['black'], ['odd'], ['even'], ['number', 0], ['number', 17], ['number', 36]];
  for (let i = 0; i < 24; i++) {
    const [type, number] = types[i % types.length], bet = [10, 50][i % 2];
    const r = await p.post('/roulette/spin', { bet, type, ...(number !== undefined && { number }) });
    assert.equal(r.status, 200);
    const g = r.game; fairOk(g);
    assert.equal(g.number, refRoulette(g.seed));
    assert.equal(g.color, g.number === 0 ? 'green' : REDS.has(g.number) ? 'red' : 'black');
    const won = refWins(type, number, g.number);
    assert.equal(g.won, won, `type=${type} n=${g.number}`);
    const pay = won ? bet * (type === 'number' ? 36 : 2) : 0;
    assert.equal(g.payout, pay);
    expected += pay - bet;
    assert.ok(close(r.balance, expected));
  }
});

// ---------- 5. Poop ----------
await check('poop: 10 rounds, stage answers match the seed, table payouts exact, replays ignored', async () => {
  const p = player();
  let expected = 1000;
  for (let round = 0; round < 10; round++) {
    const bet = 10, target = 1 + (round % 3);
    let r = await p.post('/poop/bet', { bet }); expected -= bet;
    let g = r.game;
    for (let s = 0; s < 5 && g.status === 'active' && g.stage < target; s++) {
      r = await p.post('/poop/pick', { choice: Math.random() < 0.5 ? 0 : 1, stage: s }); g = r.game;
      if (s === 0 && g.status === 'active') assert.deepEqual((await p.post('/poop/pick', { choice: 1 - g.picks[0], stage: 0 })).game.picks, g.picks);
    }
    if (g.status === 'active') { r = await p.post('/poop/cashout'); g = r.game; }
    fairOk(g);
    g.picks.forEach((pick, i) => assert.equal(pick === refPoop(g.seed, i), i < g.stage, `stage ${i}`));
    if (g.won) { assert.ok(close(g.payout, bet * POOP_LADDER[g.stage - 1])); expected += g.payout; }
    else assert.equal(g.payout, 0);
    assert.ok(close(r.balance, expected));
  }
});

// ---------- 6. Crash ----------
await check('crash: auto cash-out, manual cash-out, and an abandoned round all settle correctly', async () => {
  const p = player();
  let expected = 1000;
  // a) auto 1.25x, client never polls; outcome learned on return
  let r = await p.post('/crash/bet', { bet: 100, auto: 1.25 }); expected -= 100;
  assert.equal(r.game.crash, undefined, 'crash point leaked');
  await sleep(1500 + 5500);
  let s = await p.get('/state'); assert.equal(s.game, null, 'round should have settled');
  let [g] = (await p.get('/history?game=crash')).games; fairOk(g);
  assert.ok(close(g.crash, refCrash(g.seed)));
  if (g.crash > 1.25) { assert.equal(g.won, true); assert.ok(close(g.multiplier, 1.25)); assert.equal(g.payout, 125); expected += 125; }
  else { assert.equal(g.won, false); }
  assert.ok(close(s.user.balance, expected));
  // b) manual cash-out ~1.15x (unless it crashes first)
  for (let i = 0; i < 3; i++) {
    r = await p.post('/crash/bet', { bet: 50 }); expected -= 50;
    const startLocal = Date.now() + (r.game.startsAt - r.serverNow); // flight start on our clock
    await sleep(Math.max(0, startLocal - Date.now()) + 2300);
    r = await p.post('/crash/cashout'); g = r.game; fairOk(g);
    const mMax = Math.exp(0.00006 * (Date.now() - startLocal + 200)); // the server can't have seen a later multiplier
    assert.ok(close(g.crash, refCrash(g.seed)));
    if (g.won) {
      assert.ok(g.multiplier < g.crash, 'cashed at/after crash point');
      assert.ok(g.multiplier >= 1.1 && g.multiplier <= mMax, `m=${g.multiplier} max=${mMax}`);
      assert.ok(close(g.payout, Math.round(50 * g.multiplier * 100) / 100));
      expected += g.payout;
    } else assert.ok(g.crash <= mMax, `lost but crash=${g.crash} > reachable ${mMax}`);
    assert.ok(close(r.balance, expected), `${r.balance} vs ${expected}`);
  }
  // c) cash-out during countdown refused, then a second cash-out after the first is a no-op
  r = await p.post('/crash/bet', { bet: 10 }); expected -= 10;
  const early = await p.post('/crash/cashout');
  if (Date.now() < r.game.startsAt) assert.equal(early.status, 400);
  await sleep(2500);
  const [a, b] = await Promise.all([p.post('/crash/cashout'), p.post('/crash/cashout')]);
  const paid = [a, b].filter(x => !x.late && x.game?.won).length;
  assert.ok(paid <= 1);
  g = (a.late ? b : a).game;
  if (g.won) expected += g.payout;
  assert.ok(close(await p.balance(), expected));
});

// ---------- 7. concurrency ----------
await check('race: 8 parallel bets across 4 games -> exactly one round, one debit', async () => {
  const p = player();
  const rs = await Promise.all([...Array(8)].map((_, i) => p.post(['/mines/bet', '/poop/bet', '/crash/bet', '/mines/bet'][i % 4], { bet: 100 })));
  assert.equal(rs.filter(r => r.status === 200).length, 1);
  assert.equal(await p.balance(), 900);
  const rr = await p.post('/roulette/spin', { bet: 10, type: 'red' });
  assert.equal(rr.status, 409);
});

await check('race: 10 parallel roulette spins never overspend; ledger == balance', async () => {
  const p = player();
  const rs = await Promise.all([...Array(10)].map(() => p.post('/roulette/spin', { bet: 100, type: 'red' })));
  const ok = rs.filter(r => r.status === 200);
  const final = await p.balance();
  assert.equal(final, 1000 - ok.length * 100 + ok.filter(r => r.game.won).length * 200);
  assert.ok(final >= 0);
});

await check('race: parallel mines cash-outs + reveals pay at most once', async () => {
  const p = player();
  let g = (await p.post('/mines/bet', { bet: 100 })).game;
  for (const cell of [4, 0, 8, 2, 6]) { g = (await p.post('/mines/reveal', { cell })).game; if (g.status !== 'active' || g.revealed.length) break; }
  if (g.status === 'active') {
    const rs = await Promise.all([p.post('/mines/cashout'), p.post('/mines/cashout'), p.post('/mines/cashout'), p.post('/mines/reveal', { cell: 1 }), p.post('/mines/reveal', { cell: 3 })]);
    assert.ok(rs.filter(r => r.status === 200 && r.game.status === 'cashed').length <= 3); // replies may echo the same settled round
  }
  const [last] = (await p.get('/history?game=mines')).games;
  assert.ok(close(await p.balance(), 900 + last.payout));
});

await check('race: 5 parallel daily-bonus claims -> one +100', async () => {
  const p = player();
  const rs = await Promise.all([...Array(5)].map(() => p.post('/bonus')));
  assert.equal(rs.filter(r => r.status === 200).length, 1);
  assert.equal(await p.balance(), 1100);
});

await check('replay: same rid twice -> one round, one debit; rid reused in another game -> 409', async () => {
  const p = player(), rid = `e2e-${Date.now()}`;
  const [a, b] = await Promise.all([p.post('/roulette/spin', { bet: 50, type: 'odd', rid }), p.post('/roulette/spin', { bet: 50, type: 'odd', rid })]);
  const ok = [a, b].filter(r => r.status === 200);
  assert.ok(ok.length >= 1);
  assert.ok(ok.every(r => r.game.id === ok[0].game.id));
  assert.equal(await p.balance(), 1000 - 50 + ok[0].game.payout);
  assert.equal((await p.post('/mines/bet', { bet: 10, rid })).status, 409);
});

await check('views: wallet, profile, history and leaderboard agree with play', async () => {
  const p = player();
  for (let i = 0; i < 3; i++) await p.post('/roulette/spin', { bet: 10, type: 'even' });
  const [w, prof, h] = [await p.get('/wallet'), await p.get('/profile'), await p.get('/history')];
  assert.equal(h.games.length, 3);
  assert.equal(prof.rounds, 3); assert.equal(prof.xp, 30);
  assert.ok(close(prof.net, h.games.reduce((s, g) => s + g.net, 0)));
  assert.ok(close(w.items[0].balance, await p.balance()));
  assert.equal(w.items.filter(i => i.kind === 'bet').length, 3);
  assert.equal((await p.get('/leaderboard')).top.length <= 10, true);
});

// ---------- 8. global accounting invariants on everything this run created ----------
const db = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
await check('invariants: balance == Σ ledger, no negatives, exact payouts, one win entry per won round, ≤1 active round', async () => {
  const q = async s => (await db.query(s)).rows;
  const users = await q(`SELECT u.id, u.balance, COALESCE(SUM(l.amount),0) AS total, MIN(l.balance_after) AS low FROM users u LEFT JOIN ledger l ON l.user_id=u.id WHERE u.id < 0 GROUP BY u.id`);
  assert.ok(users.length >= 12, `only ${users.length} test users`);
  for (const u of users) { assert.equal(Number(u.balance), Number(u.total), `user ${u.id}`); assert.ok(Number(u.low) >= 0); }
  assert.deepEqual(await q(`SELECT id FROM games WHERE user_id < 0 AND ((status='cashed' AND payout <> bet*mult_x100/100) OR (status='busted' AND payout<>0) OR (status<>'active' AND ended_at IS NULL))`), []);
  assert.deepEqual(await q(`SELECT g.id FROM games g WHERE g.user_id < 0 AND g.status='cashed' AND (SELECT COUNT(*) FROM ledger l WHERE l.game_id=g.id AND l.kind='win') <> 1`), []);
  // a Mines bet can be changed before the first tile, so a round may have several 'bet' rows; together they equal its bet
  assert.deepEqual(await q(`SELECT g.id FROM games g WHERE g.user_id < 0 AND (SELECT COALESCE(SUM(l.amount),0) FROM ledger l WHERE l.game_id=g.id AND l.kind='bet') <> -g.bet`), []);
  assert.deepEqual(await q(`SELECT user_id FROM games WHERE user_id < 0 AND status='active' GROUP BY user_id HAVING COUNT(*)>1`), []);
});
for (const s of ['DELETE FROM ledger WHERE user_id < 0', 'DELETE FROM games WHERE user_id < 0', 'DELETE FROM users WHERE id < 0']) await db.query(s);
await db.end();

const failed = results.filter(r => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed · ${requests} API requests · test data cleaned up`);
process.exit(failed.length ? 1 : 0);
