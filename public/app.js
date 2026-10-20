import { $, S, ago, api, esc, fmt, haptic, initData, setBalance, tg, toast } from './core.js';
import mines from './games/mines.js';
import crash from './games/crash.js';
import roulette from './games/roulette.js';
import poop from './games/poop.js';

const GAMES = {
  mines: { mount: mines, icon: '💣', name: 'Mines', tag: 'Dodge 2 bombs on a 3×3 board', top: 'up to 34.20x' },
  crash: { mount: crash, icon: '🚀', name: 'Crash', tag: 'Cash out before the rocket blows', top: 'up to 1000x' },
  roulette: { mount: roulette, icon: '🎡', name: 'Roulette', tag: 'European wheel · red, odd, numbers', top: 'up to 36x' },
  poop: { mount: poop, icon: '💩', name: 'Poop', tag: '💩 or 😂 — 5 stages of 50/50', top: 'up to 30.40x' },
};
const RLABEL = { red: '🔴 Red', black: '⚫ Black', odd: 'Odd', even: 'Even' };

let screen = null, mounted = null, activeGame = null, tab = 'games', histFilter = '';

async function loadState() {
  const s = await api('/state');
  S.user = { ...s.user, balance: S.user?.balance ?? null }; S.config = s.config;
  activeGame = s.game;
  $('#name').textContent = s.user.name || 'Player';
  $('#avatar').textContent = (s.user.name || 'P')[0].toUpperCase();
  setBalance(s.user.balance);
  return s;
}

// ---------- routing ----------
function go(to) {
  mounted?.destroy(); mounted = null;
  screen = to;
  const root = $('#screen');
  root.innerHTML = '';
  root.className = `screen-${to}`;
  const inGame = to in GAMES;
  $('#back').hidden = !inGame; $('#who').hidden = inGame;
  $('#title').hidden = !inGame; $('#title').textContent = inGame ? `${GAMES[to].icon} ${GAMES[to].name}` : '';
  if (tg?.BackButton) inGame ? tg.BackButton.show() : tg.BackButton.hide();
  if (!inGame) return renderLobby();
  const box = document.createElement('section'); box.className = 'game'; root.appendChild(box);
  mounted = GAMES[to].mount(box, {
    initial: activeGame?.game === to ? activeGame : null,
    refresh: () => { activeGame = null; },
    resync: async () => { const s = await loadState(); return s.game?.game === to ? s.game : null; },
  });
  scrollTo(0, 0);
}
const back = () => { haptic('impactOccurred', 'light'); loadState().catch(() => {}).finally(() => go('lobby')); };
$('#back').onclick = back;
tg?.BackButton?.onClick(back);

// ---------- lobby ----------
function renderLobby() {
  const root = $('#screen');
  const left = S.user.bonusAt - Date.now();
  const bonus = left <= 0 ? `<button type="button" class="bonus" data-bonus>🎁 +${S.config.dailyBonus}</button>`
    : `<button type="button" class="bonus" disabled>🎁 ${Math.floor(left / 3.6e6)}h ${Math.floor(left % 3.6e6 / 6e4)}m</button>`;
  root.innerHTML = `
    <nav class="tabs" role="tablist">
      ${['games', 'history', 'top'].map(t => `<button role="tab" class="tab ${tab === t ? 'on' : ''}" data-tab="${t}">${{ games: 'Games', history: 'History', top: 'Top' }[t]}</button>`).join('')}
      ${bonus}
    </nav>
    <div data-panel></div>`;
  const panel = $('[data-panel]', root);
  if (tab === 'games') {
    panel.innerHTML = `
      <div class="cards">${Object.entries(GAMES).map(([id, x]) => `
        <button type="button" class="card card-${id}" data-go="${id}">
          ${activeGame?.game === id ? '<span class="badge">▶ Resume</span>' : ''}
          <span class="ic">${x.icon}</span><b>${x.name}</b><small>${x.tag}</small><em>${x.top}</em>
        </button>`).join('')}</div>
      ${S.config.bot ? `<button type="button" class="invite" data-invite>
        <span>👥</span><div><b>Invite friends · +${S.config.referralBonus} 🪙 each</b><small>${S.user.invited} joined with your link</small></div><span>›</span></button>` : ''}
      <p class="hint">Virtual coins only — no real money. Each game is provably fair.</p>`;
  } else {
    panel.innerHTML = tab === 'history'
      ? `<div class="filters">${['', ...Object.keys(GAMES)].map(f => `<button type="button" class="chip sm ${histFilter === f ? 'on' : ''}" data-filter="${f}">${f ? GAMES[f].icon + ' ' + GAMES[f].name : 'All'}</button>`).join('')}</div><ul class="list" data-list><li class="empty">Loading…</li></ul>`
      : `<p class="hint">Ranked by total virtual profit</p><ol class="list" data-list><li class="empty">Loading…</li></ol>`;
    loadList(panel);
  }
}

function detail(g) {
  if (g.game === 'mines') return `${g.safe} 💎 · ${g.multiplier.toFixed(2)}x`;
  if (g.game === 'poop') return `${g.stage}/5 stages${g.won ? ` · ${g.multiplier.toFixed(2)}x` : ''}`;
  if (g.game === 'crash') return `crashed ${g.crash.toFixed(2)}x${g.won ? ` · out at ${g.multiplier.toFixed(2)}x` : ''}`;
  const dot = g.color === 'red' ? '🔴' : g.color === 'black' ? '⚫' : '🟢';
  return `${g.type === 'number' ? '#' + g.pick : RLABEL[g.type]} · landed ${g.number} ${dot}`;
}

async function loadList(panel) {
  const list = $('[data-list]', panel);
  try {
    if (tab === 'history') {
      const { games } = await api('/history' + (histFilter ? `?game=${histFilter}` : ''));
      list.innerHTML = games.length ? games.map(g => `<li><div><b>${GAMES[g.game].icon} ${g.won ? 'Won' : 'Lost'}</b> · bet ${fmt(g.bet)}
        <div class="sub">${detail(g)} · ${ago(g.createdAt)}</div></div>
        <span class="${g.net >= 0 ? 'pos' : 'neg'}">${g.net >= 0 ? '+' : '−'}${fmt(Math.abs(g.net))}</span></li>`).join('')
        : '<li class="empty">No rounds yet — go play!</li>';
    } else {
      const { top } = await api('/leaderboard');
      list.innerHTML = top.length ? top.map((p, i) => `<li class="${p.me ? 'me' : ''}"><div><b>${['🥇', '🥈', '🥉'][i] ?? i + 1 + '.'} ${esc(p.name)}</b><div class="sub">${p.games} rounds</div></div>
        <span class="${p.profit >= 0 ? 'pos' : 'neg'}">${p.profit >= 0 ? '+' : '−'}${fmt(Math.abs(p.profit))}</span></li>`).join('')
        : '<li class="empty">No players yet</li>';
    }
  } catch (e) { list.innerHTML = `<li class="empty">${esc(e.message)}</li>`; }
}

$('#screen').addEventListener('click', async e => {
  if (screen !== 'lobby') return;
  const t = e.target.closest('[data-tab]'), f = e.target.closest('[data-filter]'), card = e.target.closest('[data-go]');
  if (t) { tab = t.dataset.tab; haptic('selectionChanged'); return renderLobby(); }
  if (f) { histFilter = f.dataset.filter; return renderLobby(); }
  if (card) { haptic('impactOccurred', 'light'); return go(card.dataset.go); }
  if (e.target.closest('[data-invite]')) {
    const link = `https://t.me/${S.config.bot}?start=ref_${S.user.id}`;
    const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('🎮 Play Mines, Crash, Roulette & Poop with free coins!')}`;
    return tg?.openTelegramLink ? tg.openTelegramLink(share) : navigator.clipboard?.writeText(link).then(() => toast('Invite link copied'));
  }
  const b = e.target.closest('[data-bonus]');
  if (b) {
    b.disabled = true;
    try {
      const r = await api('/bonus', {});
      setBalance(r.balance); S.user.bonusAt = r.bonusAt; haptic('notificationOccurred', 'success'); toast(`+${S.config.dailyBonus} coins! Come back tomorrow`);
    } catch (err) { toast(err.message); await loadState().catch(() => {}); }
    renderLobby();
  }
});

// ---------- boot ----------
(async function boot() {
  tg?.ready(); tg?.expand();
  try { tg?.setHeaderColor?.('secondary_bg_color'); tg?.disableVerticalSwipes?.(); } catch {}
  const params = new URLSearchParams(location.search);
  if (!initData && !params.get('dev')) {
    const cfg = await fetch('/config').then(r => r.json()).catch(() => ({}));
    if (cfg.bot) $('#botLink').href = `https://t.me/${cfg.bot}`;
    $('#gate').hidden = false; return;
  }
  try {
    await loadState();
    // an unfinished round wins over the deep link: the player resumes it after a refresh/disconnect
    const want = activeGame?.game ?? params.get('game');
    go(want in GAMES ? want : 'lobby');
  } catch (e) { toast(e.message); }
  setInterval(() => { if (screen === 'lobby' && tab === 'games') renderLobby(); }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && screen === 'lobby') loadState().then(renderLobby).catch(() => {});
  });
})();
