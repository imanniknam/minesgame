import { COIN, S, api, bindFair, fmt, haptic, makeAct, rid, setBalance } from '../core.js';
import * as fx from '../fx.js';
import { BOMB, GEM, I, MARK } from '../icons.js';

export default function mount(root, { initial, refresh, resync }) {
  const cfg = S.config.games.mines, bets = S.config.bets, SAFE = cfg.cells - cfg.mines;
  let g = initial, pending = null, fresh = null; // pending: tile waiting on the server; fresh: tile just opened (animates once)
  let play = null; // effect to run on the next settled render (the board is rebuilt on every render)
  let sheet = null; // 'help' | 'fair' | null
  const act = makeAct(render, async () => { g = await resync(); });
  if (g?.status === 'active') S.bet = g.bet; // a resumed round shows its real bet, not the default chip

  const x2 = n => `${n.toFixed(2)}x`;
  function panel(active) {
    const k = g?.revealed.length ?? 0;
    if (g && !active) return g.won
      ? `<div class="mx won">${I.gauge}<div><small>You won</small><span class="mx-now">+${fmt(g.net)}</span></div><div class="mx-next"><small>Cashed at</small><b>${x2(g.multiplier)}</b></div></div>`
      : `<div class="mx lost"><span class="mini big">${BOMB}</span><div><small>Boom!</small><span class="mx-now">−${fmt(g.bet)}</span></div><div class="mx-next"><small>Safe tiles</small><b>${g.safe}/${SAFE}</b></div></div>`;
    const now = active && k ? g.multiplier : 1, next = active ? g.next : cfg.ladder[0];
    return `<div class="mx">${I.gauge}<div><small>Current multiplier</small><span class="mx-now">${x2(now)}</span></div>
      <div class="mx-next"><small>Next pick</small><b>${next ? x2(next) : '—'}</b></div></div>`;
  }

  function sheetHtml() {
    if (sheet === 'help') return `
      <div class="bsheet-back" data-close><section class="bsheet" role="dialog" aria-modal="true" aria-labelledby="sheetT">
        <header><h3 id="sheetT">${I.help}How to play</h3><button type="button" class="x" data-close aria-label="Close">${I.close}</button></header>
        <ol class="rules">
          <li>Choose your bet: ${bets.join(', ')} coins.</li>
          <li>${cfg.mines} bombs hide among ${cfg.cells} tiles. Every safe tile raises the multiplier.</li>
          <li>Cash out any time after the first safe tile. Hit a bomb and the bet is lost.</li>
          <li>Clear all ${SAFE} safe tiles to win the top prize automatically.</li>
        </ol>
        <table class="ladder-t"><thead><tr><th>Safe tiles</th><th>Multiplier</th><th>Pays (${S.bet}${COIN})</th></tr></thead>
          <tbody>${cfg.ladder.map((m, i) => `<tr class="${g?.status === 'active' && i === g.revealed.length ? 'next' : ''}"><td>${i + 1}</td><td>${x2(m)}</td><td>${fmt(Math.round(S.bet * m * 100) / 100)}</td></tr>`).join('')}</tbody></table>
        <p class="note">Coins are virtual and have no cash value.</p>
      </section></div>`;
    if (sheet === 'fair') {
      const over = g && g.status !== 'active';
      return `
      <div class="bsheet-back" data-close><section class="bsheet" role="dialog" aria-modal="true" aria-labelledby="sheetT">
        <header><h3 id="sheetT">${I.shield}Provably fair</h3><button type="button" class="x" data-close aria-label="Close">${I.close}</button></header>
        <p>The bombs are placed by a secret seed <b>before</b> you play. You see its SHA-256 fingerprint now; the seed is revealed when the round ends, so you can check nothing changed.</p>
        <p class="mono"><small>Hash</small>${g?.seedHash ?? 'Place a bet to get a round hash'}</p>
        ${over ? `<p class="mono"><small>Seed</small>${g.seed}</p><button type="button" class="ghost-btn wide" data-verify>${I.shield}Verify last round</button><p class="verify-out" data-verify-out aria-live="polite"></p>` : ''}
      </section></div>`;
    }
    return '';
  }

  function render() {
    const active = g?.status === 'active', over = g && !active, k = active ? g.revealed.length : 0;
    let cells = '';
    for (let c = 0; c < cfg.cells; c++) {
      const opened = g?.revealed.includes(c), mine = over && g.mines.includes(c);
      const [cls, art, label] = opened && mine ? ['is-boom', BOMB, 'Bomb'] : opened ? ['is-gem', GEM, 'Safe']
        : mine ? ['is-ghost mine', BOMB, 'Bomb'] : over ? ['is-ghost', GEM, 'Safe'] : ['', MARK, `Tile ${c + 1}`];
      const state = c === pending ? 'pending' : c === fresh ? 'new' : '';
      cells += `<button type="button" class="tile ${cls} ${state}" data-cell="${c}" ${!active || opened || act.busy ? 'disabled' : ''} aria-label="${label}">${art}</button>`;
    }
    const i = bets.indexOf(S.bet), betLocked = (active && k > 0) || act.busy;
    const cta = active && k ? [`${I.cash}Cash out <small>${fmt(g.cashout)}</small>`, 'cash', act.busy]
      : active ? ['Pick a tile', 'wait', true]
      : S.user.balance < S.bet ? ['Not enough coins', '', true]
      : [`${I.play}${g ? 'Play again' : 'Play'}`, '', act.busy];
    root.innerHTML = `
      <div class="mboard"><div class="mgrid ${g ? '' : 'idle'}">${cells}</div></div>
      <div class="console">
        <div class="ctl-row">
          <div class="ctl-box bet"><span class="lbl">${I.stack}<span>Bet</span></span>
            <button type="button" class="step-btn" data-step="-1" aria-label="Lower bet" ${betLocked || i <= 0 ? 'disabled' : ''}>${I.minus}</button>
            <output aria-live="polite" aria-label="Bet amount">${S.bet}</output>
            <button type="button" class="step-btn" data-step="1" aria-label="Raise bet" ${betLocked || i >= bets.length - 1 ? 'disabled' : ''}>${I.plus}</button></div>
          <div class="ctl-box mines" aria-label="${cfg.mines} mines in ${cfg.cells} tiles"><span class="mini">${BOMB}</span><b>${cfg.mines}</b><small>/ ${cfg.cells}</small></div>
        </div>
        <div aria-live="polite">${panel(active)}</div>
        <div class="pips" aria-label="${k} of ${SAFE} safe tiles">${Array.from({ length: SAFE }, (_, j) => `<i class="pip ${j < k || (over && j < g.safe) ? 'done' : ''} ${active && j === k ? 'next' : ''}"></i>`).join('')}</div>
        <div class="act-row">
          <button type="button" class="icon-btn" data-random aria-label="Open a random tile" ${!active || act.busy ? 'disabled' : ''}>${I.dice}</button>
          <button type="button" class="play ${cta[1]} ${act.busy ? 'busy' : ''}" data-cta ${cta[2] ? 'disabled' : ''}>${cta[0]}</button>
          <button type="button" class="icon-btn" data-fair aria-label="Provably fair">${I.shield}</button>
        </div>
      </div>
      ${sheetHtml()}`;
    fresh = null;
    if (play && !act.busy) { const p = play; play = null; if (fx.on) p(); }
  }

  // ---------- effects (GSAP, see public/fx.js) ----------
  const $ = s => root.querySelector(s), $$ = s => [...root.querySelectorAll(s)];
  const cellEl = c => $(`[data-cell="${c}"]`);
  const deal = () => fx.gsap.timeline()
    .from($$('.tile'), { rotationY: 90, scale: 0.6, autoAlpha: 0, duration: 0.5, ease: 'back.out(1.7)', stagger: { grid: [3, 3], from: 'center', each: 0.06 }, clearProps: 'transform,opacity,visibility' })
    .from($$('.pip'), { scaleX: 0, duration: 0.3, stagger: 0.04, clearProps: 'transform' }, 0.1);
  const pop = (el, from = 0.6) => el && fx.gsap.from(el, { scale: from, duration: 0.55, ease: 'elastic.out(1, 0.45)', clearProps: 'scale' });
  // the rest of the board turns over once the round is decided, rippling out from the last tile
  const unveil = (from, delay) => fx.gsap.from($$('.tile.is-ghost'), { scale: 0.3, autoAlpha: 0, rotationY: -90, duration: 0.4, ease: 'back.out(2)', delay, stagger: { grid: [3, 3], from, each: 0.07 }, clearProps: 'transform,opacity,visibility' });

  function safeFx(c) {
    const el = cellEl(c);
    fx.gsap.fromTo(el, { rotationY: 180, scale: 0.7 }, { rotationY: 0, scale: 1, duration: 0.55, ease: 'back.out(2.2)', clearProps: 'transform' });
    fx.sparks(el); fx.ring(el);
    pop($$('.pip.done').at(-1), 1.8);
    pop($('.mx-now'), 0.6);
    pop($('.play.cash'), 0.94);
  }
  function bustFx(c) {
    const el = cellEl(c);
    fx.gsap.from(el, { scale: 1.7, rotation: -18, duration: 0.6, ease: 'elastic.out(1, 0.35)', clearProps: 'transform' });
    fx.flash(); fx.shake($('.mboard'), 14);
    fx.sparks(el, { colors: ['#ef4444', '#f97316', '#facc15', '#ec4899'], count: 26, power: [250, 560], gravity: 900, size: [5, 12] });
    unveil(c, 0.35);
    pop($('.mx-now'), 0.4);
  }
  function winFx(fromEl) {
    fx.coinsTo(fromEl, document.querySelector('.wallet'), Math.min(24, 8 + g.revealed.length * 2));
    fx.gsap.to($$('.tile.is-gem'), { scale: 1.12, duration: 0.18, yoyo: true, repeat: 1, stagger: 0.05, ease: 'power2.out' });
    unveil('center', 0.25);
    pop($('.mx-now'), 0.4);
    if (g.multiplier >= 5.7) { fx.confetti(g.multiplier >= 34.2 ? 110 : 60); fx.banner(g.multiplier >= 34.2 ? 'MAX WIN!' : 'BIG WIN!', `${x2(g.multiplier)} · +${fmt(g.net)}`); }
  }

  // wins count the balance up as the coins land
  const after = r => {
    g = r.game;
    if (r.balance != null) setBalance(r.balance, g.status === 'cashed' && fx.on ? 0.75 : 0);
    if (g.status === 'active') S.bet = g.bet; else refresh();
  };
  function reveal(c) {
    if (act.busy || g?.status !== 'active' || g.revealed.includes(c)) return;
    pending = c;
    act.run(async () => {
      try { after(await api('/mines/reveal', { cell: c })); fresh = c; } finally { pending = null; }
      play = g.status === 'busted' ? () => bustFx(c)
        : g.status === 'cashed' ? () => { safeFx(c); winFx(cellEl(c)); } // board cleared: auto cash-out
        : () => safeFx(c);
      haptic(g.status === 'busted' ? 'notificationOccurred' : 'impactOccurred', g.status === 'busted' ? 'error' : g.status === 'cashed' ? 'heavy' : 'light');
    });
  }
  // before the first tile the bet can still change: the server re-prices the open round
  function setBet(next) {
    if (next === S.bet) return;
    S.bet = next; haptic('selectionChanged');
    if (g?.status !== 'active') return render();
    const prev = g.bet;
    act.run(async () => {
      try { after(await api('/mines/bet', { bet: S.bet, rid: rid() })); } catch (e) { S.bet = prev; throw e; }
      play = () => pop($('.ctl-box output'), 0.5);
    });
  }
  const openSheet = name => {
    sheet = name; haptic('selectionChanged'); render();
    root.querySelector('.bsheet .x')?.focus();
    if (fx.on) fx.gsap.timeline().from('.bsheet-back', { autoAlpha: 0, duration: 0.2 }).from('.bsheet', { yPercent: 100, duration: 0.4, ease: 'power3.out' }, 0);
  };
  const closeSheet = () => { sheet = null; render(); };

  root.addEventListener('click', e => {
    const t = e.target;
    if (sheet) {
      if (t.closest('[data-verify]')) return; // handled by bindFair
      if (t.closest('[data-close]') && (t.closest('.x') || !t.closest('.bsheet'))) closeSheet();
      return;
    }
    const cell = t.closest('[data-cell]');
    if (cell && !cell.disabled) return reveal(Number(cell.dataset.cell));
    const step = t.closest('[data-step]');
    if (step && !step.disabled) return setBet(bets[Math.max(0, Math.min(bets.length - 1, bets.indexOf(S.bet) + Number(step.dataset.step)))]);
    if (t.closest('[data-random]') && g?.status === 'active') {
      const free = [...Array(cfg.cells).keys()].filter(c => !g.revealed.includes(c));
      return reveal(free[Math.floor(Math.random() * free.length)]);
    }
    if (t.closest('[data-fair]')) return openSheet('fair');
    if (t.closest('[data-cta]')) act.run(async () => {
      if (g?.status === 'active') {
        after(await api('/mines/cashout', {})); haptic('notificationOccurred', 'success');
        play = () => winFx($('[data-cta]'));
      } else {
        after(await api('/mines/bet', { bet: S.bet, rid: rid() })); haptic('impactOccurred', 'medium');
        play = deal;
      }
    });
  });
  const onHelp = () => openSheet('help');
  const onKey = e => { if (e.key === 'Escape' && sheet) closeSheet(); };
  addEventListener('game-help', onHelp);
  addEventListener('keydown', onKey);
  bindFair(root, () => g);
  play = deal;
  render();
  return { destroy() { removeEventListener('game-help', onHelp); removeEventListener('keydown', onKey); } };
}
