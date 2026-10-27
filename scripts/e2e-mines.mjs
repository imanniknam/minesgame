// Strict Mines-only black-box suite (plus white-box DB invariants). Runs against any deployment:
//   production:  BOT_TOKEN=... DATABASE_URL=... node scripts/e2e-mines.mjs
//   local:       DEV=1 BASE=http://localhost:3000 DATABASE_URL=... node scripts/e2e-mines.mjs   (server with ALLOW_DEV_AUTH=1)
// Rules are re-implemented here (no imports from lib/). Test users get negative ids and are deleted at the end.
import { createHash, createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';

const BASE = process.env.BASE ?? 'https://mines-tma.vercel.app';
const { BOT_TOKEN, DATABASE_URL, DEV } = process.env;
if (!DATABASE_URL || !(BOT_TOKEN || DEV)) throw new Error('DATABASE_URL and BOT_TOKEN (or DEV=1 for a local server) required');

const sha = s => createHash('sha256').update(s).digest('hex');
const LADDER = [1.22, 1.62, 2.28, 3.42, 5.70, 11.40, 34.20];
const refMines = seed => [...Array(9).keys()].map(c => [c, sha(`${seed}:${c}`)]).sort((a, b) => (a[1] < b[1] ? -1 : 1)).slice(0, 2).map(x => x[0]).sort((a, b) => a - b);
const cents = n => Math.round(n * 100);
const shuffle = a => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(x => x[1]);

pg.types.setTypeParser(20, Number); // BIGINT cents -> number, as the server does
const db = new pg.Client({ connectionString: DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false } });
await db.connect();
const sql = async (s, p) => (await db.query(s, p)).rows;

function initData(id, { token = BOT_TOKEN, age = 0, tamper = false } = {}) {
  const f = { auth_date: String(Math.floor(Date.now() / 1000) - age), user: JSON.stringify({ id, first_name: `E2E${id}` }) };
  const dcs = Object.entries(f).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const hash = createHmac('sha256', createHmac('sha256', 'WebAppData').update(token).digest()).update(dcs).digest('hex');
  if (tamper) f.user = JSON.stringify({ id: id - 1, first_name: 'X' });
  return new URLSearchParams({ ...f, hash }).toString();
}

let nextId = -(200000 + (Date.now() % 100000)) * 10;
const timings = {};
function player() {
  const id = nextId--;
  const headers = { 'content-type': 'application/json', ...(BOT_TOKEN ? { authorization: 'tma ' + initData(id) } : { 'x-dev-user': String(id) }) };
  const call = async (method, path, body) => {
    const t = performance.now();
    const r = await fetch(BASE + '/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const key = `${method} ${path.split('?')[0]}`;
    (timings[key] ??= []).push(performance.now() - t);
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 80) }; }
    if (r.status >= 500) throw new Error(`${r.status} on ${method} ${path} ${JSON.stringify(body)}: ${text.slice(0, 200)}`);
    return { status: r.status, ...j };
  };
  const p = { id, get: path => call('GET', path), post: (path, body = {}) => call('POST', path, body) };
  p.balance = async () => (await p.get('/state')).user.balance;
  // white-box: set the balance for "rich"/"broke" scenarios, booked as a ledger row so the accounting invariants stay exact
  p.setBalance = async coins => (await p.get('/state'), sql(`WITH o AS (SELECT balance FROM users WHERE id=$1 FOR UPDATE),
      u AS (UPDATE users SET balance=$2 WHERE id=$1 RETURNING balance)
    INSERT INTO ledger (user_id, kind, amount, balance_after) SELECT $1, 'bonus', u.balance - o.balance, u.balance FROM o, u`, [id, coins * 100]));
  return p;
}
// mines of a live round straight from the DB (white-box: lets a test steer around or into a bomb)
const liveMines = async gid => (await sql('SELECT mines FROM games WHERE id=$1', [gid]))[0].mines;

const results = [];
async function check(name, fn) {
  const t = Date.now();
  try { await fn(); results.push(['PASS', name]); console.log(`  ✔ ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log(`  ✖ ${name}\n      ${e.stack.split('\n').slice(0, 3).join('\n      ')}`); }
}
const noLeak = (g, where) => { assert.equal(g.mines, undefined, `mines leaked ${where}`); assert.equal(g.seed, undefined, `seed leaked ${where}`); };
const settledOk = g => {
  assert.equal(sha(g.seed), g.seedHash, 'seed hash');
  assert.deepEqual([...g.mines].sort((a, b) => a - b), refMines(g.seed), 'board != seed');
  assert.equal(new Set(g.revealed).size, g.revealed.length, 'duplicate reveal');
  const hit = g.revealed.some(c => g.mines.includes(c));
  if (g.status === 'busted') {
    assert.ok(g.mines.includes(g.revealed.at(-1)), 'busted on a safe tile');
    assert.ok(g.revealed.slice(0, -1).every(c => !g.mines.includes(c)), 'kept playing after a bomb');
    assert.equal(g.payout, 0); assert.equal(g.multiplier, 0); assert.equal(g.net, -g.bet);
  } else {
    assert.equal(g.status, 'cashed'); assert.ok(!hit, 'cashed with a bomb revealed'); assert.ok(g.revealed.length >= 1);
    assert.equal(g.multiplier, LADDER[g.revealed.length - 1]);
    assert.equal(cents(g.payout), Math.floor(cents(g.bet) * Math.round(g.multiplier * 100) / 100));
    assert.equal(cents(g.net), cents(g.payout) - cents(g.bet));
  }
};

console.log(`Mines E2E against ${BASE} (${BOT_TOKEN ? 'signed initData' : 'dev auth'})\n`);

await check('config: Mines only, 3x3 / 2 bombs, ladder and bets as specified; other games are gone', async () => {
  const p = player(), s = await p.get('/state');
  assert.deepEqual(Object.keys(s.config.games), ['mines']);
  assert.deepEqual(s.config.games.mines, { cells: 9, mines: 2, ladder: LADDER });
  assert.deepEqual(s.config.bets, [10, 50, 100]);
  assert.equal(s.user.balance, 1000);
  for (const [path, body] of [['/poop/bet', { bet: 10 }], ['/crash/bet', { bet: 10 }], ['/roulette/spin', { bet: 10, type: 'red' }], ['/crash/status']]) {
    const r = path.endsWith('status') ? await p.get(path) : await p.post(path, body);
    assert.equal(r.status, 404, `${path} should not exist`);
  }
  for (const gname of ['poop', 'crash', 'roulette', '__proto__']) assert.equal((await p.get('/history?game=' + gname)).status, 400);
  assert.equal(await p.balance(), 1000);
});

if (BOT_TOKEN) await check('auth: forged / expired / other bot / dev header / no header all 401, nothing created', async () => {
  const id = nextId--;
  const raw = h => fetch(BASE + '/api/mines/bet', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: '{"bet":10}' }).then(r => r.status);
  assert.equal(await raw({}), 401);
  assert.equal(await raw({ authorization: 'tma ' + initData(id, { tamper: true }) }), 401);
  assert.equal(await raw({ authorization: 'tma ' + initData(id, { age: 86400 + 60 }) }), 401);
  assert.equal(await raw({ authorization: 'tma ' + initData(id, { token: '1:WRONG' }) }), 401);
  assert.equal(await raw({ authorization: 'tma garbage' }), 401);
  assert.equal(await raw({ 'x-dev-user': String(id) }), 401);
  assert.equal((await sql('SELECT 1 FROM users WHERE id=$1 OR id=$2', [id, id - 1])).length, 0);
});

await check('validation: 40 malformed bet/reveal/cashout payloads -> clean 4xx, balance untouched', async () => {
  const p = player();
  const bets = [0, -10, 10.5, '10', 1e9, null, [10], { $gt: 0 }, true, 'Infinity', 20, 99, 101, 1000, NaN];
  for (const bet of bets) { const r = await p.post('/mines/bet', { bet }); assert.ok(r.status >= 400 && r.status < 500, `bet ${JSON.stringify(bet)} -> ${r.status}`); }
  for (const rid of ['short', '../../etc', 'x'.repeat(65), 12345678, { a: 1 }, 'has space here']) assert.equal((await p.post('/mines/bet', { bet: 10, rid })).status, 400, `rid ${JSON.stringify(rid)}`);
  assert.equal((await p.post('/mines/reveal', { cell: 0 })).status, 409, 'reveal with no round');
  assert.equal((await p.post('/mines/cashout')).status, 409, 'cashout with no round');
  const r = await p.post('/mines/bet', { bet: 10 }); assert.equal(r.status, 200);
  for (const cell of [-1, 9, 100, 1.5, '1', null, [1], { c: 1 }, true, 'NaN']) assert.equal((await p.post('/mines/reveal', { cell })).status, 400, `cell ${JSON.stringify(cell)}`);
  assert.equal((await p.post('/mines/cashout')).status, 400, 'cashout before any tile');
  const bad = await fetch(BASE + '/api/mines/bet', { method: 'POST', headers: { 'content-type': 'application/json', ...(BOT_TOKEN ? { authorization: 'tma ' + initData(p.id) } : { 'x-dev-user': String(p.id) }) }, body: '{"bet":' });
  assert.ok(bad.status >= 400 && bad.status < 500, `broken JSON -> ${bad.status}`);
  assert.equal(await p.balance(), 990);
});

await check('play: 40 random rounds — every board matches its seed, payouts exact, balance tracked to the cent', async () => {
  const p = player();
  await p.setBalance(100000);
  let expected = cents(100000);
  for (let round = 0; round < 40; round++) {
    const bet = [10, 50, 100][round % 3], target = 1 + (round % 7);
    let r = await p.post('/mines/bet', { bet, rid: `e2e-${p.id}-${round}` });
    assert.equal(r.status, 200); expected -= cents(bet);
    assert.equal(cents(r.balance), expected); noLeak(r.game, 'after bet');
    let g = r.game;
    for (const cell of shuffle([...Array(9).keys()])) {
      if (g.status !== 'active' || g.revealed.length >= target) break;
      r = await p.post('/mines/reveal', { cell }); g = r.game;
      if (g.status === 'active') {
        noLeak(g, 'after reveal');
        assert.equal(g.multiplier, LADDER[g.revealed.length - 1]);
        assert.equal(g.cashout, Math.round(bet * LADDER[g.revealed.length - 1] * 100) / 100);
        assert.equal(g.next, g.revealed.length < 7 ? LADDER[g.revealed.length] : null);
      }
    }
    if (g.status === 'active') { r = await p.post('/mines/cashout'); g = r.game; }
    settledOk(g);
    expected += cents(g.payout);
    assert.equal(cents(r.balance), expected, `round ${round}`);
  }
  const s = await p.get('/state');
  assert.equal(cents(s.user.balance), expected); assert.equal(s.game, null);
});

await check('full board: 7 safe tiles auto-pay 34.20x; a bomb on the very first tile busts', async () => {
  const p = player();
  let g = (await p.post('/mines/bet', { bet: 100 })).game;
  const m = await liveMines(g.id);
  for (const cell of [...Array(9).keys()].filter(c => !m.includes(c))) g = (await p.post('/mines/reveal', { cell })).game;
  assert.equal(g.status, 'cashed'); assert.equal(g.payout, 3420); settledOk(g);
  assert.equal(await p.balance(), 1000 - 100 + 3420);
  g = (await p.post('/mines/bet', { bet: 50 })).game;
  g = (await p.post('/mines/reveal', { cell: (await liveMines(g.id))[0] })).game;
  assert.equal(g.status, 'busted'); settledOk(g);
  assert.equal(await p.balance(), 4320 - 50);
  assert.equal((await p.post('/mines/reveal', { cell: 0 })).status, 409, 'reveal after bust');
  assert.equal((await p.post('/mines/cashout')).status, 409, 'cashout after bust');
});

await check('idempotency: replayed bet rid, double-tapped tile, second cash-out', async () => {
  const p = player();
  const rid = `e2e-rid-${p.id}`;
  const rs = await Promise.all([...Array(6)].map(() => p.post('/mines/bet', { bet: 100, rid })));
  const ok = rs.filter(r => r.status === 200);
  assert.ok(ok.length >= 1); assert.ok(ok.every(r => r.game.id === ok[0].game.id), 'replay made a second round');
  assert.equal(await p.balance(), 900);
  const m = await liveMines(ok[0].game.id), cell = [...Array(9).keys()].find(c => !m.includes(c));
  const taps = await Promise.all([...Array(5)].map(() => p.post('/mines/reveal', { cell })));
  assert.ok(taps.every(t => t.status === 200 && t.game.revealed.length === 1), 'double tap opened more than one tile');
  const outs = await Promise.all([...Array(6)].map(() => p.post('/mines/cashout')));
  assert.equal(outs.filter(o => o.status === 200).length, 1, 'paid more than once');
  assert.equal(await p.balance(), 900 + 122);
});

await check('bet change before the first tile: up, down, replay, too expensive, same amount', async () => {
  const p = player();
  const a = (await p.post('/mines/bet', { bet: 10, rid: `e2e-a-${p.id}` })).game;
  let r = await p.post('/mines/bet', { bet: 100, rid: `e2e-b-${p.id}` });
  assert.equal(r.status, 200); assert.equal(r.game.id, a.id); assert.equal(r.game.bet, 100); assert.equal(r.balance, 900); noLeak(r.game, 'after change');
  assert.equal(r.game.seedHash, a.seedHash, 'board must stay the same round');
  r = await p.post('/mines/bet', { bet: 10, rid: `e2e-a-${p.id}` }); // stale retry of the first request
  assert.equal(r.game.bet, 100); assert.equal(await p.balance(), 900);
  r = await p.post('/mines/bet', { bet: 10, rid: `e2e-c-${p.id}` });
  assert.equal(r.game.bet, 10); assert.equal(r.balance, 990);
  assert.equal((await p.post('/mines/bet', { bet: 10 })).status, 409, 'same amount is not a change');
  await p.setBalance(50); // 10 already staked, only 50 left
  r = await p.post('/mines/bet', { bet: 100, rid: `e2e-d-${p.id}` });
  assert.equal(r.status, 400, 'raise beyond balance'); assert.equal(await p.balance(), 50);
  r = await p.post('/mines/bet', { bet: 50, rid: `e2e-e-${p.id}` });
  assert.equal(r.status, 200); assert.equal(r.balance, 10); // exactly affordable
  const m = await liveMines(a.id), safe = [...Array(9).keys()].find(c => !m.includes(c));
  const g = (await p.post('/mines/reveal', { cell: safe })).game;
  assert.equal(g.bet, 50); assert.equal(g.cashout, 61);
  assert.equal((await p.post('/mines/bet', { bet: 100, rid: `e2e-f-${p.id}` })).status, 409, 'bet change after a tile');
  assert.equal((await p.post('/mines/cashout')).game.payout, 61);
  assert.equal(await p.balance(), 71);
});

await check('race: 12 parallel bet changes on one round — final stake == what was charged', async () => {
  const p = player();
  const g = (await p.post('/mines/bet', { bet: 10 })).game;
  await Promise.all([...Array(12)].map((_, i) => p.post('/mines/bet', { bet: [50, 100, 10][i % 3], rid: `e2e-r${i}-${p.id}` })));
  const [row] = await sql('SELECT bet FROM games WHERE id=$1', [g.id]);
  assert.equal(await p.balance(), 1000 - row.bet / 100);
  assert.equal((await sql(`SELECT COUNT(*)::int n FROM games WHERE user_id=$1`, [p.id]))[0].n, 1, 'parallel changes opened extra rounds');
});

await check('race: bet change vs first reveal — never a re-priced board after a tile', async () => {
  for (let i = 0; i < 6; i++) {
    const p = player();
    const g = (await p.post('/mines/bet', { bet: 10 })).game;
    const m = await liveMines(g.id), safe = [...Array(9).keys()].find(c => !m.includes(c));
    const [chg, rev] = await Promise.all([p.post('/mines/bet', { bet: 100, rid: `e2e-x-${p.id}` }), p.post('/mines/reveal', { cell: safe })]);
    const [row] = await sql('SELECT bet, revealed FROM games WHERE id=$1', [g.id]);
    if (chg.status === 200) assert.equal(row.bet, 10000); else { assert.equal(chg.status, 409); assert.equal(row.bet, 1000); }
    assert.equal(rev.status, 200); assert.equal(row.revealed.length, 1);
    assert.equal(await p.balance(), 1000 - row.bet / 100);
  }
});

await check('race: 9 parallel reveals of different tiles + 3 cash-outs — one consistent outcome', async () => {
  for (let i = 0; i < 5; i++) {
    const p = player();
    const g = (await p.post('/mines/bet', { bet: 100 })).game;
    const rs = await Promise.all([...[...Array(9).keys()].map(cell => p.post('/mines/reveal', { cell })), p.post('/mines/cashout'), p.post('/mines/cashout'), p.post('/mines/cashout')]);
    assert.ok(rs.every(r => [200, 400, 409].includes(r.status)), rs.map(r => r.status).join());
    const [row] = await sql('SELECT * FROM games WHERE id=$1', [g.id]);
    assert.notEqual(row.status, 'active');
    const final = (await p.get('/history?game=mines')).games[0];
    settledOk(final);
    assert.equal(await p.balance(), 900 + final.payout);
  }
});

await check('insufficient coins: bet refused cleanly at 0 and at 49 for a 50 bet', async () => {
  const p = player();
  await p.get('/state'); await p.setBalance(0);
  assert.equal((await p.post('/mines/bet', { bet: 10 })).status, 400);
  await p.setBalance(49);
  assert.equal((await p.post('/mines/bet', { bet: 50 })).status, 400);
  assert.equal((await p.post('/mines/bet', { bet: 10 })).status, 200);
  assert.equal(await p.balance(), 39);
});

await check('views: active round never leaks via /state, /history or /wallet; history = 10 newest ended rounds', async () => {
  const p = player();
  for (let i = 0; i < 12; i++) {
    const g = (await p.post('/mines/bet', { bet: 10 })).game;
    await p.post('/mines/reveal', { cell: (await liveMines(g.id))[0] });
  }
  const g = (await p.post('/mines/bet', { bet: 10 })).game;
  const s = await p.get('/state');
  assert.equal(s.game.id, g.id); noLeak(s.game, 'in /state');
  const h = await p.get('/history');
  assert.equal(h.games.length, 10); assert.ok(h.games.every(x => x.status !== 'active' && x.game === 'mines'));
  assert.ok(h.games.every((x, i, a) => i === 0 || a[i - 1].id > x.id), 'history not newest-first');
  h.games.forEach(settledOk);
  const w = await p.get('/wallet');
  assert.ok(!JSON.stringify(w).includes(String((await liveMines(g.id)))), 'wallet leaked');
  const prof = await p.get('/profile');
  assert.equal(prof.rounds, 12); assert.equal(prof.wins, 0); assert.equal(prof.net, -120);
});

await check('fairness: bomb positions over 120 server rounds look uniform (each tile ~2/9)', async () => {
  const p = player(); await p.setBalance(100000);
  const hits = Array(9).fill(0);
  for (let i = 0; i < 120; i++) {
    const g = (await p.post('/mines/bet', { bet: 10 })).game;
    const r = await p.post('/mines/reveal', { cell: 4 });
    let done = r.game;
    if (done.status === 'active') done = (await p.post('/mines/cashout')).game;
    settledOk(done);
    done.mines.forEach(c => hits[c]++);
    void g;
  }
  const exp = 120 * 2 / 9, chi = hits.reduce((s, h) => s + (h - exp) ** 2 / exp, 0);
  assert.ok(chi < 26.1, `chi² ${chi.toFixed(1)} (df 8, p<0.001 cutoff 26.1) hits=${hits}`);
});

await check('parallel players: 15 users × 4 rounds at once — no 5xx, every balance exact', async () => {
  const ps = [...Array(15)].map(player);
  await Promise.all(ps.map(async p => {
    let bal = 100000;
    for (let i = 0; i < 4; i++) {
      let r = await p.post('/mines/bet', { bet: 10 }); bal -= 1000;
      let g = r.game;
      for (const cell of shuffle([...Array(9).keys()]).slice(0, 2)) { if (g.status !== 'active') break; r = await p.post('/mines/reveal', { cell }); g = r.game; }
      if (g.status === 'active') { r = await p.post('/mines/cashout'); g = r.game; }
      bal += cents(g.payout);
      assert.equal(cents(r.balance), bal);
    }
  }));
});

await check('DB invariants on every test user: balance == Σ ledger, running balances, exact payouts, ≤1 active', async () => {
  assert.deepEqual(await sql(`SELECT u.id FROM users u LEFT JOIN ledger l ON l.user_id=u.id WHERE u.id<0 GROUP BY u.id HAVING u.balance <> COALESCE(SUM(l.amount),0)`), []);
  assert.deepEqual(await sql(`SELECT id FROM (SELECT id, balance_after, SUM(amount) OVER (PARTITION BY user_id ORDER BY id) run FROM ledger WHERE user_id<0) x WHERE balance_after <> run`), []);
  assert.deepEqual(await sql(`SELECT id FROM games WHERE user_id<0 AND ((status='cashed' AND payout <> bet*mult_x100/100) OR (status='busted' AND payout<>0) OR (status<>'active' AND ended_at IS NULL))`), []);
  assert.deepEqual(await sql(`SELECT g.id FROM games g WHERE g.user_id<0 AND g.status='cashed' AND (SELECT COUNT(*) FROM ledger l WHERE l.game_id=g.id AND l.kind='win') <> 1`), []);
  assert.deepEqual(await sql(`SELECT g.id FROM games g WHERE g.user_id<0 AND g.status='busted' AND EXISTS (SELECT 1 FROM ledger l WHERE l.game_id=g.id AND l.kind='win')`), []);
  assert.deepEqual(await sql(`SELECT g.id FROM games g WHERE g.user_id<0 AND (SELECT COALESCE(SUM(amount),0) FROM ledger l WHERE l.game_id=g.id AND l.kind='bet') <> -g.bet`), []);
  assert.deepEqual(await sql(`SELECT user_id FROM games WHERE user_id<0 AND status='active' GROUP BY user_id HAVING COUNT(*)>1`), []);
  assert.deepEqual(await sql(`SELECT id FROM games WHERE user_id<0 AND game='mines' AND status='cashed' AND mult_x100 <> (ARRAY[122,162,228,342,570,1140,3420])[cardinality(revealed)]`), []);
  assert.deepEqual(await sql(`SELECT id FROM ledger WHERE user_id<0 AND balance_after<0`), []);
});

const lat = Object.entries(timings).map(([k, v]) => { v.sort((a, b) => a - b); return { endpoint: k, n: v.length, p50: Math.round(v[v.length >> 1]), p95: Math.round(v[Math.floor(v.length * 0.95)]), max: Math.round(v.at(-1)) }; });
console.log('\nLatency (ms, from this machine):'); console.table(lat);

for (const s of ['DELETE FROM ledger WHERE user_id < 0', 'DELETE FROM games WHERE user_id < 0', 'DELETE FROM users WHERE id < 0']) await db.query(s);
await db.end();
const failed = results.filter(r => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed · test data cleaned up`);
process.exit(failed.length ? 1 : 0);
