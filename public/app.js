import { $, COIN, S, ago, api, esc, fmt, haptic, initData, setBalance, tg, toast } from './core.js';
import mines from './games/mines.js';
import crash from './games/crash.js';
import roulette from './games/roulette.js';
import poop from './games/poop.js';
import * as fx from './fx.js';

const ALL_GAMES = {
  mines: { mount: mines, icon: '💎', name: 'Mines', title: 'Mines', sub: 'Find safe tiles. Avoid the mines.', tag: 'Risk & Strategy', max: '34.20x',
    help: '💎 <b>Mines</b> — 3×3 board, 2 bombs. Each safe tile raises the multiplier; cash out any time.' },
  crash: { mount: crash, icon: '🚀', name: 'Crash', title: 'Crash', sub: 'Cash out before it blows!', tag: 'High Multiplier', max: '1000x',
    help: '🚀 <b>Crash</b> — the multiplier climbs from 1.00x. Cash out before it crashes, or set auto cash-out.' },
  roulette: { mount: roulette, icon: '🎡', name: 'Roulette', title: 'European Roulette', sub: 'Place your bet and spin the wheel.', tag: 'Classic & Elegant', max: '36x',
    help: '🎡 <b>Roulette</b> — red/black or odd/even pay 2x, a single number pays 36x. Zero loses outside bets.' },
  poop: { mount: poop, icon: '💩', name: 'Poop', title: 'Poop', sub: 'The luckiest little poop!', tag: 'Fun & Crazy', max: '30.40x',
    help: '💩 <b>Poop</b> — pick 💩 or 😂, 50/50 per stage, up to 5 stages (30.40x).' },
};
// The games the server has switched on (config.games); the rest stay hidden. Filled in by loadState().
const GAMES = {};
const isGame = k => typeof k === 'string' && Object.hasOwn(GAMES, k);
const RLABEL = { red: '🔴 Red', black: '⚫ Black', odd: 'Odd', even: 'Even' };
const KIND = { signup: ['🎉', 'Welcome bonus'], bonus: ['🎁', 'Daily bonus'], referral: ['🤝', 'Friend joined'] };

let screen = null, mounted = null, activeGame = null, histFilter = '', openSheet = '';

// XP = coins wagered; level n needs 50·(n−1)² XP
const level = xp => {
  const lv = Math.floor(Math.sqrt(xp / 50)) + 1, lo = 50 * (lv - 1) ** 2, hi = 50 * lv ** 2;
  return { lv, xp, hi, pct: Math.min(100, ((xp - lo) / (hi - lo)) * 100) };
};

async function loadState() {
  const s = await api('/state');
  S.user = { ...s.user, balance: S.user?.balance ?? null }; S.config = s.config;
  for (const id of Object.keys(GAMES)) delete GAMES[id];
  for (const id of Object.keys(ALL_GAMES)) if (s.config.games[id]) GAMES[id] = ALL_GAMES[id];
  activeGame = s.game;
  setBalance(s.user.balance);
  return s;
}

// ---------- routing ----------
function go(to) {
  mounted?.destroy(); mounted = null;
  screen = to;
  const root = $('#screen'), inGame = isGame(to), sub = inGame || to === 'top';
  root.innerHTML = '';
  $('#back').hidden = !sub;
  if (tg?.BackButton) sub ? tg.BackButton.show() : tg.BackButton.hide();
  document.querySelectorAll('[data-nav]').forEach(b => b.classList.toggle('on', b.dataset.nav === (inGame ? 'home' : to === 'top' ? 'profile' : to)));
  scrollTo(0, 0);
  if (!inGame) {
    RENDER[to]();
    fx.enter([...root.children].filter(el => !el.matches('.cards')));
    return fx.enter(root.querySelectorAll('.card'), { y: 40, scale: 0.85, rotation: -2, duration: 0.6, stagger: 0.08, ease: 'back.out(1.6)', delay: 0.12 });
  }
  const m = GAMES[to];
  root.innerHTML = `<div class="ghead c-${to}"><h2>${m.title}</h2><p>${m.sub}</p></div><section class="game"></section>`;
  mounted = m.mount($('.game', root), {
    initial: activeGame?.game === to ? activeGame : null,
    refresh: () => { activeGame = null; },
    resync: async () => { const s = await loadState(); return s.game?.game === to ? s.game : null; },
  });
  fx.enter(root.querySelector('.ghead'), { x: -24, y: 0 });
}
const back = () => { haptic('impactOccurred', 'light'); const to = screen === 'top' ? 'profile' : 'home'; loadState().catch(() => {}).finally(() => go(to)); };
$('#back').onclick = back;
tg?.BackButton?.onClick(back);
addEventListener('active-game', e => isGame(e.detail) && setTimeout(() => loadState().catch(() => {}).finally(() => go(e.detail)), 900));
$('#nav').onclick = e => {
  const b = e.target.closest('[data-nav]');
  if (!b || !S.user) return;
  haptic('selectionChanged');
  loadState().catch(() => {}).finally(() => go(b.dataset.nav));
};
$('#plus').onclick = () => S.user && go('wallet');

// ---------- shared bits ----------
const bonusLeft = () => S.user.bonusAt - Date.now();
const bonusLabel = () => { const l = bonusLeft(); return l <= 0 ? `+${S.config.dailyBonus}` : `${Math.floor(l / 3.6e6)}h ${Math.floor(l % 3.6e6 / 6e4)}m`; };
const signed = n => `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n))}`;

async function claimBonus() {
  try {
    const r = await api('/bonus', {});
    setBalance(r.balance); S.user.bonusAt = r.bonusAt;
    haptic('notificationOccurred', 'success'); toast(`+${S.config.dailyBonus} coins! Come back tomorrow`);
  } catch (e) { toast(e.message); await loadState().catch(() => {}); }
  RENDER[screen]?.();
}
function invite() {
  if (!S.config.bot) return toast('Invites are not available yet');
  const link = `https://t.me/${S.config.bot}?start=ref_${S.user.id}`;
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(`🎮 Play ${Object.values(GAMES).map(m => m.name).join(', ')} with free coins!`)}`;
  if (tg?.openTelegramLink) tg.openTelegramLink(share);
  else navigator.clipboard?.writeText(link).then(() => toast('Invite link copied'));
}

function gameRow(g) {
  const m = ALL_GAMES[g.game];
  const detail = g.game === 'mines' ? `${g.safe} 💎 · ${g.multiplier.toFixed(2)}x`
    : g.game === 'poop' ? `${g.stage}/5 stages${g.won ? ` · ${g.multiplier.toFixed(2)}x` : ''}`
    : g.game === 'crash' ? `crashed ${g.crash.toFixed(2)}x${g.won ? ` · out ${g.multiplier.toFixed(2)}x` : ''}`
    : `${g.type === 'number' ? '#' + g.pick : RLABEL[g.type]} · landed ${g.number}`;
  return `<li class="row panel"><span class="gi c-${g.game}">${m.icon}</span>
    <div class="mid"><b>${m.name}</b><small>${detail} · bet ${fmt(g.bet)}</small></div>
    <div class="end"><span class="${g.won ? 'pos' : 'neg'}">${g.won ? 'Win' : 'Lose'} ${signed(g.net)}</span><small>${ago(g.createdAt)}</small></div></li>`;
}
const listError = e => { const l = $('[data-list]'); if (l) l.innerHTML = `<li class="empty">${esc(e.message)}</li>`; };

// ---------- screens ----------
const RENDER = {
  home() {
    const h = new Date().getHours(), greet = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    $('#screen').innerHTML = `
      <div class="hello panel"><span class="avatar">${esc((S.user.name || 'P')[0].toUpperCase())}</span>
        <div><small>${greet},</small><b>${esc(S.user.name || 'Player')}!</b></div>
        <div class="lvl" data-lvl>Lv. …<i></i></div></div>
      <div class="quick">
        <button type="button" class="panel" data-act="bonus" ${bonusLeft() > 0 ? 'disabled' : ''}><span class="ic">🎁</span>Daily ${bonusLabel()}</button>
        <button type="button" class="panel" data-act="invite"><span class="ic">🤝</span>Invite +${S.config.referralBonus}</button>
        <button type="button" class="panel" data-act="top"><span class="ic">🏆</span>Leaderboard</button>
      </div>
      <div class="sec-title">Popular Games</div>
      <div class="cards ${Object.keys(GAMES).length === 1 ? 'solo' : ''}">${Object.entries(GAMES).map(([id, m]) => `
        <button type="button" class="card c-${id}" data-go="${id}">
          <span class="max">up to ${m.max}</span>${activeGame?.game === id ? '<span class="badge">▶ Resume</span>' : ''}
          <div class="art">${m.icon}</div><div class="txt"><b>${m.name}</b><small>${m.tag}</small></div>
        </button>`).join('')}</div>
      <p class="foot">Virtual coins only — no real money. Every round is provably fair.</p>`;
    api('/profile').then(p => {
      const L = level(p.xp), el = $('[data-lvl]');
      if (el) { el.innerHTML = `Lv. ${L.lv}<i></i>`; el.style.setProperty('--p', L.pct + '%'); }
    }).catch(() => {});
  },

  async wallet() {
    $('#screen').innerHTML = `
      <div class="sec-title" style="margin-top:4px">Wallet</div>
      <div class="balance-card panel neon"><small>Your balance</small>
        <div class="big">${COIN}<span>${fmt(S.user.balance)}</span></div>
        <div class="acts">
          <button type="button" class="btn-green" data-act="bonus" ${bonusLeft() > 0 ? 'disabled' : ''}>🎁 Daily ${bonusLabel()}</button>
          <button type="button" class="btn2" data-act="invite">🤝 Invite +${S.config.referralBonus}</button>
        </div>
        <p class="note">Virtual coins only — no deposits or withdrawals.</p></div>
      <div class="sec-title">Transactions</div>
      <ul class="list" data-list><li class="empty">Loading…</li></ul>`;
    try {
      const { items } = await api('/wallet');
      $('[data-list]').innerHTML = items.map(t => {
        const [icon, label] = KIND[t.kind] ?? [ALL_GAMES[t.game]?.icon ?? '🎮', `${ALL_GAMES[t.game]?.name ?? 'Game'} · ${t.kind === 'win' ? 'win' : t.amount > 0 ? 'bet lowered' : 'bet'}`];
        return `<li class="row panel"><span class="gi c-${t.game ?? 'poop'}">${icon}</span>
          <div class="mid"><b>${label}</b><small>${ago(t.at)}</small></div>
          <div class="end"><span class="${t.amount >= 0 ? 'pos' : 'neg'}">${signed(t.amount)}</span><small>bal ${fmt(t.balance)}</small></div></li>`;
      }).join('') || '<li class="empty">No transactions yet</li>';
    } catch (e) { listError(e); }
  },

  async history() {
    $('#screen').innerHTML = `
      <div class="sec-title" style="margin-top:4px">Game History</div>
      <div class="filters">${['', ...Object.keys(GAMES)].map(f => `<button type="button" class="pill ${histFilter === f ? 'on' : ''}" data-filter="${f}">${f ? GAMES[f].name : 'All'}</button>`).join('')}</div>
      <ul class="list" data-list><li class="empty">Loading…</li></ul>`;
    try {
      const { games } = await api('/history' + (histFilter ? `?game=${histFilter}` : ''));
      $('[data-list]').innerHTML = games.map(gameRow).join('') || '<li class="empty">No rounds yet — go play!</li>';
    } catch (e) { listError(e); }
  },

  async profile() {
    const sheet = {
      fair: `<p>Every round's result is fixed by a secret seed <b>before</b> you play. You see its SHA-256 fingerprint up front; when the round ends the seed is revealed.</p><p>Open "Provably fair" under any game and tap <b>Verify</b>: your phone recomputes the result from the seed.</p>`,
      help: `${Object.values(GAMES).map(m => `<p>${m.help}</p>`).join('')}<p>Bets are 10, 50 or 100 coins. Coins are virtual and have no cash value.</p>`,
    };
    const item = (k, icon, label) => `<button type="button" class="panel" data-sheet="${k}"><span>${icon}</span>${label}<span>${openSheet === k ? '⌄' : '›'}</span></button>
      ${openSheet === k ? `<div class="panel sheet" style="padding:4px 14px">${sheet[k]}</div>` : ''}`;
    $('#screen').innerHTML = `
      <div class="sec-title" style="margin-top:4px">Profile</div>
      <div class="player panel neon"><span class="avatar">${esc((S.user.name || 'P')[0].toUpperCase())}</span>
        <div class="info"><b>${esc(S.user.name || 'Player')}</b><small>ID ${S.user.id}</small>
          <div data-xp><span class="lv">Lv. …</span><div class="xpbar"><i style="width:0"></i></div></div></div></div>
      <div class="stats" data-stats>${['Rounds', 'Win rate', 'Net', 'Best'].map(l => `<div class="panel"><b>…</b><small>${l}</small></div>`).join('')}</div>
      <div class="menu">
        <button type="button" class="panel" data-act="top"><span>🏆</span>Leaderboard<span>›</span></button>
        <button type="button" class="panel" data-act="invite"><span>🤝</span>Invite friends · ${S.user.invited} joined<span>›</span></button>
        ${item('fair', '🔒', 'Provably fair')}
        ${item('help', '❓', 'How to play')}
      </div>`;
    try {
      const p = await api('/profile'), L = level(p.xp);
      $('[data-xp]').innerHTML = `<span class="lv">Lv. ${L.lv}</span><div class="xpbar"><i style="width:${L.pct}%"></i></div><small>${fmt(L.xp)} / ${fmt(L.hi)} XP</small>`;
      $('[data-stats]').innerHTML = [
        [p.rounds, 'Rounds'], [p.rounds ? Math.round((p.wins / p.rounds) * 100) + '%' : '—', 'Win rate'],
        [`<span class="${p.net >= 0 ? 'pos' : 'neg'}">${signed(p.net)}</span>`, 'Net'], [p.best ? p.best.toFixed(2) + 'x' : '—', 'Best'],
      ].map(([v, l]) => `<div class="panel"><b>${v}</b><small>${l}</small></div>`).join('');
    } catch {}
  },

  async top() {
    $('#screen').innerHTML = `<div class="sec-title" style="margin-top:4px">🏆 Leaderboard <small class="muted">by virtual profit</small></div><ol class="list" data-list><li class="empty">Loading…</li></ol>`;
    try {
      const { top } = await api('/leaderboard');
      $('[data-list]').innerHTML = top.map((p, i) => `<li class="row panel ${p.me ? 'me' : ''}"><span class="gi">${['🥇', '🥈', '🥉'][i] ?? i + 1}</span>
        <div class="mid"><b>${esc(p.name)}${p.me ? ' (you)' : ''}</b><small>${p.games} rounds</small></div>
        <div class="end"><span class="${p.profit >= 0 ? 'pos' : 'neg'}">${signed(p.profit)}</span></div></li>`).join('') || '<li class="empty">No players yet</li>';
    } catch (e) { listError(e); }
  },
};

$('#screen').addEventListener('click', e => {
  if (isGame(screen)) return; // game modules handle their own clicks
  const card = e.target.closest('[data-go]'), act = e.target.closest('[data-act]'), f = e.target.closest('[data-filter]'), sh = e.target.closest('[data-sheet]');
  if (card) { haptic('impactOccurred', 'light'); return go(card.dataset.go); }
  if (f) { histFilter = f.dataset.filter; haptic('selectionChanged'); return RENDER.history(); }
  if (sh) { openSheet = openSheet === sh.dataset.sheet ? '' : sh.dataset.sheet; return RENDER.profile(); }
  if (!act || act.disabled) return;
  if (act.dataset.act === 'bonus') { act.disabled = true; return claimBonus(); }
  if (act.dataset.act === 'invite') return invite();
  if (act.dataset.act === 'top') return go('top');
});

// ---------- boot ----------
function hideSplash() {
  const s = $('#splash');
  s.style.pointerEvents = 'none';
  if (fx.on) return fx.splashOut(s, () => (s.hidden = true));
  s.classList.add('out'); setTimeout(() => (s.hidden = true), 450);
}
const seen = () => { try { return localStorage.getItem('pg_seen') === '1'; } catch { return true; } };

(async function boot() {
  fx.splashIn($('#splash'));
  tg?.ready(); tg?.expand();
  try { tg?.setHeaderColor?.('#080812'); tg?.setBackgroundColor?.('#080812'); tg?.disableVerticalSwipes?.(); } catch {}
  const params = new URLSearchParams(location.search);
  if (!initData && !params.get('dev')) {
    const cfg = await fetch('/config').then(r => r.json()).catch(() => ({}));
    if (cfg.bot) $('#botLink').href = `https://t.me/${cfg.bot}`;
    hideSplash(); $('#gate').hidden = false; return;
  }
  const minSplash = new Promise(r => setTimeout(r, 700));
  try {
    await loadState();
    // an unfinished round wins over the deep link: the player resumes it after a refresh/disconnect
    const want = activeGame?.game ?? params.get('game');
    go(isGame(want) ? want : 'home');
  } catch (e) {
    hideSplash();
    $('#screen').innerHTML = `<div class="empty" style="padding-top:80px">${esc(e.message)}<br><br><button type="button" class="cta inline" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  setInterval(() => { if (screen === 'home') RENDER.home(); }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.user && !isGame(screen)) loadState().then(() => RENDER[screen]?.()).catch(() => {});
  });
  await minSplash;
  // first visit: the splash doubles as a welcome screen; afterwards it's just a loader
  if (seen() || activeGame || !S.user) return hideSplash();
  $('#splashAct').innerHTML = '<button type="button" class="cta inline" id="start">🎮 START PLAYING</button>';
  fx.enter('#start', { scale: 0.7, y: 10, ease: 'back.out(2)' });
  $('#start').onclick = () => { try { localStorage.setItem('pg_seen', '1'); } catch {} haptic('impactOccurred', 'medium'); hideSplash(); };
})();
