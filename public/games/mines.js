import { COIN, S, api, betChips, bindChips, bindFair, fairBox, fmt, haptic, makeAct, rid, setBalance } from '../core.js';
import * as fx from '../fx.js';

export default function mount(root, { initial, refresh, resync }) {
  const cfg = S.config.games.mines;
  let g = initial, pending = null, fresh = null; // pending: tile waiting on the server; fresh: tile just opened (animates once)
  let play = null; // effect to run on the next settled render (the board is rebuilt on every render)
  const act = makeAct(render, async () => { g = await resync(); });
  if (g?.status === 'active') S.bet = g.bet; // a resumed round shows its real bet, not the default chip

  function render() {
    const fairOpen = root.querySelector('.fair')?.open; // re-render must not collapse it
    const active = g?.status === 'active', over = g && !active, k = active ? g.revealed.length : -1;
    const status = !g ? `${cfg.mines} bombs hidden in ${cfg.cells} tiles — open safe ones to climb`
      : active ? (g.revealed.length ? `${g.multiplier.toFixed(2)}x now · next tile <b>${g.next?.toFixed(2)}x</b>` : `First safe tile pays <b>${g.next.toFixed(2)}x</b>`)
      : g.won ? `<span class="win">+${fmt(g.net)}${COIN} at ${g.multiplier.toFixed(2)}x</span>` : `<span class="lose">💥 Boom! −${fmt(g.bet)}${COIN}</span>`;
    let cells = '';
    for (let c = 0; c < cfg.cells; c++) {
      const opened = g?.revealed.includes(c), mine = over && g.mines.includes(c);
      const [cls, icon] = opened && mine ? ['boom', '💥'] : opened ? ['gem', '💎'] : mine ? ['ghost', '💣'] : over ? ['ghost', '💎'] : ['', ''];
      const state = c === pending ? 'pending' : c === fresh ? 'new' : '';
      cells += `<button type="button" class="cell ${cls} ${state}" data-cell="${c}" ${!active || opened || act.busy ? 'disabled' : ''} aria-label="${opened ? (mine ? 'Bomb' : 'Safe') : `Tile ${c + 1}`}">${icon}</button>`;
    }
    const cta = active && g.revealed.length ? [`Cash out ${fmt(g.cashout)}`, 'cash', act.busy]
      : active ? ['Pick a tile', '', true]
      : S.user.balance < S.bet ? [`Not enough coins for ${S.bet}${COIN}`, '', true]
      : [`${g ? 'Play again' : 'Bet'} · ${S.bet}${COIN}`, '', act.busy];
    root.innerHTML = `
      <div class="ladder">${cfg.ladder.map((m, i) => `<div class="step ${i < k ? 'done' : ''} ${i === k ? 'next' : ''}"><small>${i + 1} 💎</small><b>${m.toFixed(2)}x</b></div>`).join('')}</div>
      <div class="status" aria-live="polite"><span>${status}</span></div>
      <div class="board panel neon"><div class="grid ${g ? '' : 'idle'}">${cells}</div></div>
      ${betChips((active && g.revealed.length) || act.busy)}
      <button type="button" class="cta ${cta[1]} ${act.busy ? 'busy' : ''}" data-cta ${cta[2] ? 'disabled' : ''}>${cta[0]}</button>
      ${fairBox(g)}`;
    if (fairOpen) root.querySelector('.fair').open = true;
    // center the next step by scrolling the ladder only; scrollIntoView also scrolled the page and moved the board under the finger
    const ladder = root.querySelector('.ladder'), next = ladder.querySelector('.step.next');
    if (next) ladder.scrollLeft = next.getBoundingClientRect().left - ladder.getBoundingClientRect().left - (ladder.clientWidth - next.offsetWidth) / 2;
    fresh = null;
    if (play && !act.busy) { const p = play; play = null; if (fx.on) p(); }
  }

  // ---------- effects (GSAP, see public/fx.js) ----------
  const $ = s => root.querySelector(s), $$ = s => [...root.querySelectorAll(s)];
  const cellEl = c => $(`[data-cell="${c}"]`);
  const deal = () => fx.gsap.timeline()
    .from($$('.cell'), { rotationY: 90, scale: 0.6, autoAlpha: 0, duration: 0.5, ease: 'back.out(1.7)', stagger: { grid: [3, 3], from: 'center', each: 0.06 }, clearProps: 'transform,opacity,visibility' })
    .from($$('.step'), { y: -12, autoAlpha: 0, duration: 0.3, stagger: 0.04, clearProps: 'transform,opacity,visibility' }, 0);
  const pop = (el, from = 0.6) => el && fx.gsap.from(el, { scale: from, duration: 0.55, ease: 'elastic.out(1, 0.45)', clearProps: 'scale' });
  // the rest of the board turns over once the round is decided, rippling out from the last tile
  const unveil = (from, delay) => fx.gsap.from($$('.cell.ghost'), { scale: 0.3, autoAlpha: 0, rotationY: -90, duration: 0.4, ease: 'back.out(2)', delay, stagger: { grid: [3, 3], from, each: 0.07 }, clearProps: 'transform,opacity,visibility' });

  function safeFx(c) {
    const el = cellEl(c);
    fx.gsap.fromTo(el, { rotationY: 180, scale: 0.7 }, { rotationY: 0, scale: 1, duration: 0.55, ease: 'back.out(2.2)', clearProps: 'transform' });
    fx.sparks(el); fx.ring(el);
    pop($$('.step.done').at(-1), 1.35);
    pop($('.status b'), 0.5);
    pop($('[data-cta].cash'), 0.92);
  }
  function bustFx(c) {
    const el = cellEl(c);
    fx.gsap.from(el, { scale: 1.7, rotation: -18, duration: 0.6, ease: 'elastic.out(1, 0.35)', clearProps: 'transform' });
    fx.flash(); fx.shake($('.board'), 14);
    fx.sparks(el, { colors: ['#ef4444', '#f97316', '#facc15', '#7f1d1d'], count: 26, power: [250, 560], gravity: 900, size: [5, 12] });
    unveil(c, 0.35);
    pop($('.status .lose'), 0.4);
  }
  function winFx(fromEl) {
    const big = g.multiplier >= 5.7;
    fx.coinsTo(fromEl, document.querySelector('.wallet'), Math.min(24, 8 + g.revealed.length * 2));
    fx.gsap.to($$('.cell.gem'), { scale: 1.12, duration: 0.18, yoyo: true, repeat: 1, stagger: 0.05, ease: 'power2.out' });
    unveil('center', 0.25);
    pop($('.status .win'), 0.4);
    if (big) { fx.confetti(g.multiplier >= 34.2 ? 110 : 60); fx.banner(g.multiplier >= 34.2 ? 'MAX WIN!' : 'BIG WIN!', `${g.multiplier.toFixed(2)}x · +${fmt(g.net)}`); }
  }

  // wins count the balance up as the coins land
  const after = r => {
    g = r.game;
    if (r.balance != null) setBalance(r.balance, g.status === 'cashed' && fx.on ? 0.75 : 0);
    if (g.status === 'active') S.bet = g.bet; else refresh();
  };
  root.addEventListener('click', e => {
    const cell = e.target.closest('[data-cell]');
    if (cell && !cell.disabled) {
      if (act.busy) return;
      const c = Number(cell.dataset.cell);
      pending = c;
      return act.run(async () => {
        try { after(await api('/mines/reveal', { cell: c })); fresh = c; } finally { pending = null; }
        play = g.status === 'busted' ? () => bustFx(c)
          : g.status === 'cashed' ? () => { safeFx(c); winFx(cellEl(c)); } // board cleared: auto cash-out
          : () => safeFx(c);
        haptic(g.status === 'busted' ? 'notificationOccurred' : 'impactOccurred', g.status === 'busted' ? 'error' : g.status === 'cashed' ? 'heavy' : 'light');
      });
    }
    const btn = e.target.closest('[data-cta]');
    if (btn) act.run(async () => {
      if (g?.status === 'active') {
        after(await api('/mines/cashout', {})); haptic('notificationOccurred', 'success');
        play = () => winFx($('[data-cta]'));
      } else {
        after(await api('/mines/bet', { bet: S.bet, rid: rid() })); haptic('impactOccurred', 'medium');
        play = deal;
      }
    });
  });
  // before the first tile the bet can still change: the server re-prices the open round
  bindChips(root, () => {
    if (g?.status !== 'active' || S.bet === g.bet) return render();
    const prev = g.bet;
    act.run(async () => {
      try { after(await api('/mines/bet', { bet: S.bet, rid: rid() })); } catch (e) { S.bet = prev; throw e; }
      play = () => pop($('.status b'), 0.5);
    });
  });
  bindFair(root, () => g);
  play = deal;
  render();
  return { destroy() {} };
}
