import { COIN, S, api, betChips, bindChips, bindFair, fairBox, fmt, haptic, makeAct, rid, setBalance } from '../core.js';

// European wheel order, clockwise from 0
const ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const STEP = 360 / 37, SPIN_MS = 4200;
const LABEL = { red: '🔴 Red', black: '⚫ Black', odd: 'Odd', even: 'Even' };

function wheelSvg(reds) {
  const R = 150, r0 = 92, pt = (a, rad) => [150 + rad * Math.cos((a - 90) * Math.PI / 180), 150 + rad * Math.sin((a - 90) * Math.PI / 180)];
  const slices = ORDER.map((n, i) => {
    const a0 = i * STEP - STEP / 2, a1 = a0 + STEP;
    const [x0, y0] = pt(a0, R), [x1, y1] = pt(a1, R), [x2, y2] = pt(a1, r0), [x3, y3] = pt(a0, r0), [tx, ty] = pt(i * STEP, 128);
    const fill = n === 0 ? '#16a34a' : reds.includes(n) ? '#dc2626' : '#111827';
    return `<path d="M${x0},${y0} A${R},${R} 0 0 1 ${x1},${y1} L${x2},${y2} A${r0},${r0} 0 0 0 ${x3},${y3} Z" fill="${fill}" stroke="#d4af37" stroke-width=".6"/>
      <text x="${tx}" y="${ty}" transform="rotate(${i * STEP} ${tx} ${ty})" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="700" fill="#fff">${n}</text>`;
  }).join('');
  return `<svg viewBox="0 0 300 300" aria-hidden="true">${slices}<circle cx="150" cy="150" r="${r0}" fill="#0b0b1e" stroke="#a855f7" stroke-width="3"/></svg>`;
}

export default function mount(root, { refresh, resync }) {
  const { reds, payouts } = S.config.games.roulette;
  let g = null, phase = 'waiting', type = 'red', number = 17, rot = 0, showNums = false, timer;
  const act = makeAct(renderControls, async () => { await resync(); });

  root.innerHTML = `
    <div class="wheel-wrap"><div class="pointer">▼</div><div class="wheel" data-wheel>${wheelSvg(reds)}</div><div class="hub" data-hub>🎡</div></div>
    <div data-controls></div>`;
  const wheel = root.querySelector('[data-wheel]'), hub = root.querySelector('[data-hub]'), controls = root.querySelector('[data-controls]');

  const colorDot = n => (n === 0 ? 'green' : reds.includes(n) ? 'red' : 'black');
  function renderControls() {
    const spinning = phase === 'spinning';
    const status = phase === 'waiting' ? 'Waiting · pick a bet and spin'
      : spinning ? 'Spinning…'
      : g.won ? `<span class="win">${g.number} ${colorDot(g.number) === 'red' ? '🔴' : colorDot(g.number) === 'black' ? '⚫' : '🟢'} · +${fmt(g.net)}${COIN}</span>`
      : `<span class="lose">${g.number} ${colorDot(g.number) === 'red' ? '🔴' : colorDot(g.number) === 'black' ? '⚫' : '🟢'} · −${fmt(g.bet)}${COIN}</span>`;
    const off = spinning || act.busy;
    controls.innerHTML = `
      <div class="status" aria-live="polite"><small class="phase">${phase === 'result' ? 'Result' : spinning ? 'Spinning' : 'Waiting'}</small>${status}</div>
      <div class="types">${Object.entries(LABEL).map(([t, l]) => `<button type="button" class="type ${t} ${type === t ? 'on' : ''}" data-type="${t}" ${off ? 'disabled' : ''}>${l}<small>${payouts[t]}x</small></button>`).join('')}
        <button type="button" class="type num ${type === 'number' ? 'on' : ''}" data-type="number" ${off ? 'disabled' : ''}>#${type === 'number' ? number : ''} Number<small>${payouts.number}x</small></button></div>
      ${showNums ? `<div class="numgrid">${[...Array(37).keys()].map(n => `<button type="button" class="n ${colorDot(n)} ${type === 'number' && number === n ? 'on' : ''}" data-num="${n}" ${off ? 'disabled' : ''}>${n}</button>`).join('')}</div>` : ''}
      ${betChips(off)}
      <button type="button" class="cta" data-cta ${off || S.user.balance < S.bet ? 'disabled' : ''}>${spinning ? 'Spinning…' : `Spin · ${S.bet}${COIN} on ${type === 'number' ? `#${number}` : LABEL[type]}`}</button>
      ${fairBox(phase === 'result' ? g : null)}`;
  }

  function spinTo(n) {
    const target = (360 - ORDER.indexOf(n) * STEP) % 360; // pocket under the pointer
    rot += 360 * 6 + ((target - (rot % 360)) + 360) % 360;
    wheel.style.transition = `transform ${SPIN_MS}ms cubic-bezier(.12,.7,.1,1)`;
    wheel.style.transform = `rotate(${rot}deg)`;
  }

  root.addEventListener('click', e => {
    const t = e.target.closest('[data-type]');
    if (t && !t.disabled) { type = t.dataset.type; showNums = type === 'number' ? !showNums : false; haptic('selectionChanged'); return renderControls(); }
    const n = e.target.closest('[data-num]');
    if (n && !n.disabled) { number = Number(n.dataset.num); showNums = false; haptic('selectionChanged'); return renderControls(); }
    if (e.target.closest('[data-cta]')) act.run(async () => {
      const before = S.user.balance;
      const r = await api('/roulette/spin', { bet: S.bet, type, ...(type === 'number' && { number }), rid: rid() });
      phase = 'spinning'; hub.textContent = '🎡'; hub.className = 'hub'; renderControls();
      setBalance(before - S.bet); haptic('impactOccurred', 'medium');
      spinTo(r.game.number);
      // reveal only once the wheel has actually stopped on the server's number (timer = fallback)
      await new Promise(res => { wheel.addEventListener('transitionend', res, { once: true }); timer = setTimeout(res, SPIN_MS + 1500); });
      clearTimeout(timer);
      g = r.game; phase = 'result'; hub.textContent = g.number;
      hub.className = `hub ${colorDot(g.number)}`;
      setBalance(r.balance); refresh();
      haptic('notificationOccurred', g.won ? 'success' : 'error');
    });
  });
  bindChips(controls, renderControls);
  bindFair(controls, () => g);
  renderControls();
  return { destroy() { clearTimeout(timer); } };
}
