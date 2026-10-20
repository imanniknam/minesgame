// Thin client: it only renders what the server says. Balance, mines and payouts are all decided server-side.
const tg = window.Telegram?.WebApp;
const $ = id => document.getElementById(id);
const devUser = new URLSearchParams(location.search).get('dev'); // local testing only; server ignores it in prod
const haptic = (t, k) => { try { tg?.HapticFeedback?.[t]?.(k); } catch {} };

let S = { user: null, game: null, config: null, bet: 10, busy: false, last: null };

async function api(path, body) {
  const headers = { 'content-type': 'application/json' };
  if (tg?.initData) headers.authorization = 'tma ' + tg.initData;
  if (devUser) headers['x-dev-user'] = devUser;
  let r;
  try {
    r = await fetch('/api' + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new Error('Connection lost — check your network'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Something went wrong'); e.status = r.status; throw e; }
  return j;
}

let toastT;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600);
}

const fmt = n => n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });

function setBalance(b) {
  const el = $('balance'), prev = S.user.balance;
  S.user.balance = b; el.textContent = fmt(b);
  if (prev != null && b !== prev) {
    el.className = b > prev ? 'up' : 'down';
    setTimeout(() => (el.className = ''), 700);
  }
}

// ---------- render ----------
function renderLadder() {
  const g = S.game, k = g?.status === 'active' ? g.revealed.length : -1;
  $('ladder').innerHTML = S.config.ladder.map((m, i) =>
    `<div class="step ${i < k ? 'done' : ''} ${i === k ? 'next' : ''}"><small>${i + 1} 💎</small><b>${m.toFixed(2)}x</b></div>`).join('');
  $('ladder').querySelector('.next')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}

function renderGrid() {
  const g = S.game, active = g?.status === 'active', over = g && !active;
  const grid = $('grid');
  grid.classList.toggle('idle', !g);
  grid.innerHTML = '';
  for (let c = 0; c < S.config.cells; c++) {
    const b = document.createElement('button');
    b.className = 'cell'; b.type = 'button';
    const opened = g?.revealed.includes(c), mine = over && g.mines.includes(c);
    if (opened && mine) { b.classList.add('boom'); b.textContent = '💥'; }
    else if (opened) { b.classList.add('gem'); b.textContent = '💎'; }
    else if (mine) { b.classList.add('ghost'); b.textContent = '💣'; }
    else if (over) { b.classList.add('ghost'); b.textContent = '💎'; }
    b.disabled = !active || opened || S.busy;
    b.setAttribute('aria-label', opened ? (mine ? 'Bomb' : 'Safe') : `Tile ${c + 1}`);
    b.onclick = () => reveal(c);
    grid.appendChild(b);
  }
}

function renderControls() {
  const g = S.game, active = g?.status === 'active';
  $('bets').innerHTML = S.config.bets.map(v =>
    `<button type="button" class="chip" role="radio" aria-checked="${v === S.bet}" data-bet="${v}" ${active || S.busy ? 'disabled' : ''}>${v}</button>`).join('');
  const cta = $('cta');
  cta.classList.toggle('cash', active && g.revealed.length > 0);
  cta.classList.toggle('busy', S.busy);
  if (active && g.revealed.length) { cta.textContent = `Cash out ${fmt(g.cashout)}`; cta.disabled = S.busy; }
  else if (active) { cta.textContent = 'Pick a tile'; cta.disabled = true; }
  else { cta.textContent = `${g ? 'Play again' : 'Bet'} · ${S.bet} 🪙`; cta.disabled = S.busy || S.user.balance < S.bet; }

  const st = $('status');
  if (!g) st.textContent = S.user.balance < 10 ? 'Out of coins — grab your daily bonus 🎁' : 'Pick a bet and start';
  else if (g.status === 'active') st.innerHTML = g.revealed.length
    ? `${g.multiplier.toFixed(2)}x now · next tile <b>${g.next?.toFixed(2)}x</b>`
    : `2 bombs hidden · first tile pays <b>${g.next.toFixed(2)}x</b>`;
  else if (g.status === 'cashed') st.innerHTML = `<span class="win">+${fmt(g.payout - g.bet)} 🪙 at ${g.multiplier.toFixed(2)}x</span>`;
  else st.innerHTML = `<span class="lose">💥 Boom! −${fmt(g.bet)} 🪙</span>`;

  $('hash').textContent = g?.seedHash ?? '—';
  $('seedRow').hidden = $('verify').hidden = !(g && !active);
  if (g && !active) $('seed').textContent = g.seed;
}

function renderBonus() {
  const b = $('bonus'), left = S.user.bonusAt - Date.now();
  if (left <= 0) { b.disabled = false; b.textContent = '🎁 +100'; return; }
  b.disabled = true;
  const h = Math.floor(left / 3.6e6), m = Math.floor(left % 3.6e6 / 6e4);
  b.textContent = `🎁 ${h}h ${m}m`;
}

const render = () => { renderLadder(); renderGrid(); renderControls(); };

// ---------- actions (each one locks the UI until the server answers) ----------
async function act(fn) {
  if (S.busy) return;
  S.busy = true; renderControls(); renderGrid();
  try { await fn(); }
  catch (e) {
    toast(e.message); haptic('notificationOccurred', 'error');
    if (e.status === 409 || e.status === 401) await load().catch(() => {}); // resync with server truth
  }
  finally { S.busy = false; render(); }
}

const startRound = () => act(async () => {
  const r = await api('/bet', { bet: S.bet });
  S.game = r.game; setBalance(r.balance); haptic('impactOccurred', 'medium');
});

const reveal = cell => act(async () => {
  const r = await api('/reveal', { cell });
  S.game = r.game; if (r.balance != null) setBalance(r.balance);
  if (r.game.status === 'busted') haptic('notificationOccurred', 'error');
  else if (r.game.status === 'cashed') { haptic('notificationOccurred', 'success'); refreshLists(); }
  else haptic('impactOccurred', 'light');
  if (r.game.status === 'busted') refreshLists();
});

const cashout = () => act(async () => {
  const r = await api('/cashout', {});
  S.game = r.game; setBalance(r.balance); haptic('notificationOccurred', 'success');
  refreshLists();
});

async function claimBonus() {
  $('bonus').disabled = true;
  try {
    const r = await api('/bonus', {});
    setBalance(r.balance); S.user.bonusAt = r.bonusAt; haptic('notificationOccurred', 'success'); toast('+100 coins! Come back tomorrow');
    renderControls();
  } catch (e) { toast(e.message); await load().catch(() => {}); }
  renderBonus();
}

// ---------- lists ----------
const ago = t => {
  const s = (Date.now() - new Date(t)) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(t).toLocaleDateString();
};
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

async function refreshLists() {
  const [h, t] = await Promise.all([api('/history'), api('/leaderboard')]).catch(() => [null, null]);
  if (h) $('history').innerHTML = h.games.length ? h.games.map(g => {
    const net = g.payout - g.bet;
    return `<li><div><b>${g.status === 'cashed' ? '✅ Won' : '💥 Lost'}</b> · bet ${fmt(g.bet)}<div class="sub">${g.safe} 💎 · ${g.multiplier.toFixed(2)}x · ${ago(g.createdAt)}</div></div>
      <span class="${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : '−'}${fmt(Math.abs(net))}</span></li>`;
  }).join('') : '<p class="empty">No rounds yet — go play!</p>';
  if (t) $('top').innerHTML = t.top.length ? t.top.map((p, i) =>
    `<li class="${p.me ? 'me' : ''}"><div><b>${['🥇', '🥈', '🥉'][i] ?? i + 1 + '.'} ${esc(p.name)}</b><div class="sub">${p.games} rounds</div></div>
      <span class="${p.profit >= 0 ? 'pos' : 'neg'}">${p.profit >= 0 ? '+' : '−'}${fmt(Math.abs(p.profit))}</span></li>`).join('')
    : '<p class="empty">No players yet</p>';
}

// ---------- provably fair check, fully in the browser ----------
async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
$('verify').onclick = async () => {
  const g = S.game;
  const hashOk = (await sha256(g.seed)) === g.seedHash;
  const ranked = await Promise.all([...Array(S.config.cells).keys()].map(async c => [c, await sha256(`${g.seed}:${c}`)]));
  const mines = ranked.sort((a, b) => (a[1] < b[1] ? -1 : 1)).slice(0, 2).map(([c]) => c).sort((a, b) => a - b);
  const minesOk = mines.join() === [...g.mines].sort((a, b) => a - b).join();
  $('verifyOut').textContent = hashOk && minesOk ? `✅ Verified: seed matches hash, bombs were on tiles ${mines.map(m => m + 1).join(' & ')}` : '❌ Mismatch!';
};

// ---------- wiring ----------
$('cta').onclick = () => (S.game?.status === 'active' ? cashout() : startRound());
$('bets').onclick = e => { const v = Number(e.target.dataset.bet); if (v) { S.bet = v; haptic('selectionChanged'); renderControls(); } };
$('bonus').onclick = claimBonus;
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'tab-' + t.dataset.tab));
  if (t.dataset.tab !== 'play') refreshLists();
});

async function load() {
  const s = await api('/state');
  S.user = { ...s.user, balance: null }; S.config = s.config;
  // after a refresh/disconnect the active round comes back from the server exactly as it was
  if (s.game || S.game?.status === 'active') S.game = s.game;
  if (s.game) S.bet = s.game.bet;
  $('name').textContent = s.user.name || 'Player';
  $('avatar').textContent = (s.user.name || 'P')[0].toUpperCase();
  setBalance(s.user.balance);
  renderBonus(); render();
}

(async function boot() {
  tg?.ready(); tg?.expand();
  try { tg?.setHeaderColor?.('secondary_bg_color'); tg?.disableVerticalSwipes?.(); } catch {}
  if (!tg?.initData && !devUser) {
    const cfg = await fetch('/config').then(r => r.json()).catch(() => ({}));
    if (cfg.bot) $('botLink').href = `https://t.me/${cfg.bot}`;
    $('gate').hidden = false; return;
  }
  try { await load(); refreshLists(); }
  catch (e) { toast(e.message); }
  setInterval(renderBonus, 30000);
  // came back to the app (switched chats, network blip): resync from the server
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !S.busy) load().catch(() => {}); });
  window.addEventListener('online', () => load().catch(() => {}));
})();
