import { S, api, betChips, bindChips, bindFair, fairBox, fmt, haptic, makeAct, rid, serverNow, setBalance } from '../core.js';

// The client only animates m(t) = e^(k·t) on the server clock. It never knows the crash point:
// it learns the outcome by polling /crash/status, and cash-outs are priced by the server's clock.
export default function mount(root, { initial, refresh, resync }) {
  const { growth: K, countdownMs } = S.config.games.crash;
  let g = initial, raf, poll, recent = [];
  const auto = S.crashAuto ??= { on: false, x: 2 };
  const act = makeAct(renderControls, async () => { g = await resync(); start(); });

  root.innerHTML = `
    <div class="recent" data-recent></div>
    <div class="sky"><canvas data-canvas></canvas>
      <div class="big"><small data-phase>Waiting</small><b data-mult>1.00x</b><span data-sub></span></div></div>
    <div data-controls></div>`;
  const canvas = root.querySelector('[data-canvas]'), ctx2 = canvas.getContext('2d');
  const multEl = root.querySelector('[data-mult]'), phaseEl = root.querySelector('[data-phase]'), subEl = root.querySelector('[data-sub]');
  const controls = root.querySelector('[data-controls]');

  const multAt = ms => (ms <= 0 ? 1 : Math.floor(100 * Math.exp(K * ms)) / 100);
  const timeTo = m => Math.log(m) / K;
  const active = () => g?.status === 'active';
  const phase = () => !g ? 'waiting' : active() ? (serverNow() < g.startsAt ? 'starting' : 'running') : g.won ? 'cashed' : 'crashed';

  function draw(m, endM, color) {
    const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2.clearRect(0, 0, w, h);
    const tEnd = timeTo(endM), tMax = Math.max(8000, tEnd * 1.15), yMax = Math.max(2, endM * 1.2);
    const X = t => 12 + (t / tMax) * (w - 40), Y = v => h - 14 - ((v - 1) / (yMax - 1)) * (h - 40);
    ctx2.strokeStyle = 'rgba(139,150,176,.15)'; ctx2.lineWidth = 1; ctx2.fillStyle = 'rgba(139,150,176,.6)'; ctx2.font = '10px system-ui';
    for (const v of [1.5, 2, 3, 5, 10, 20, 50, 100].filter(v => v < yMax)) { ctx2.beginPath(); ctx2.moveTo(0, Y(v)); ctx2.lineTo(w, Y(v)); ctx2.stroke(); ctx2.fillText(v + 'x', 4, Y(v) - 3); }
    ctx2.beginPath(); ctx2.moveTo(X(0), Y(1));
    for (let i = 1; i <= 60; i++) { const t = tEnd * i / 60; ctx2.lineTo(X(t), Y(Math.exp(K * t))); }
    ctx2.strokeStyle = color; ctx2.lineWidth = 4; ctx2.stroke();
    ctx2.lineTo(X(tEnd), Y(1)); ctx2.closePath();
    const grad = ctx2.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, color + '55'); grad.addColorStop(1, color + '00');
    ctx2.fillStyle = grad; ctx2.fill();
    const tx = X(tEnd), ty = Y(endM);
    ctx2.font = '28px system-ui'; ctx2.textAlign = 'center'; ctx2.textBaseline = 'middle';
    ctx2.fillText(phase() === 'crashed' ? '💥' : '🚀', Math.min(tx, w - 18), Math.max(ty, 18));
    ctx2.textAlign = 'start';
    if (g?.won && m) { // mark where the player got out
      const cx = X(timeTo(m)), cy = Y(m);
      ctx2.fillStyle = '#22c55e'; ctx2.beginPath(); ctx2.arc(cx, cy, 6, 0, 7); ctx2.fill();
    }
  }

  function frame() {
    const p = phase();
    phaseEl.textContent = { waiting: 'Waiting', starting: 'Starting…', running: 'Running', crashed: 'Crashed', cashed: 'Cashed out' }[p];
    root.querySelector('.sky').dataset.phase = p;
    if (p === 'starting') {
      multEl.textContent = '1.00x'; subEl.textContent = `Lift-off in ${((g.startsAt - serverNow()) / 1000).toFixed(1)}s`;
      draw(0, 1.0001, '#fbbf24');
    } else if (p === 'running') {
      const m = multAt(serverNow() - g.startsAt);
      multEl.textContent = m.toFixed(2) + 'x';
      subEl.textContent = g.auto ? `Auto cash-out at ${g.auto.toFixed(2)}x` : '';
      const btn = controls.querySelector('[data-cta]');
      if (btn && !act.busy) btn.textContent = `Cash out ${fmt(Math.floor(g.bet * m * 100) / 100)}`;
      draw(0, m, '#22c55e');
    } else if (p === 'crashed' || p === 'cashed') {
      multEl.textContent = (p === 'cashed' ? g.multiplier : g.crash).toFixed(2) + 'x';
      subEl.innerHTML = p === 'cashed' ? `<span class="win">+${fmt(g.net)} 🪙</span> · crashed at ${g.crash.toFixed(2)}x` : `<span class="lose">−${fmt(g.bet)} 🪙</span>`;
      draw(p === 'cashed' ? g.multiplier : 0, g.crash, p === 'cashed' ? '#22c55e' : '#ef4444');
    } else {
      multEl.textContent = '1.00x'; subEl.textContent = 'Place a bet — cash out before it crashes';
      draw(0, 1.0001, '#8b96b0');
    }
    if (active()) raf = requestAnimationFrame(frame);
  }

  function renderControls() {
    const p = phase(), live = active();
    const cta = p === 'running' ? ['Cash out', 'cash', act.busy] : p === 'starting' ? ['Starting…', '', true]
      : [`${g ? 'Play again' : 'Bet'} · ${S.bet} 🪙`, '', act.busy || S.user.balance < S.bet];
    controls.innerHTML = `
      <label class="auto"><input type="checkbox" data-auto ${auto.on ? 'checked' : ''} ${live ? 'disabled' : ''}> Auto cash-out at
        <input type="number" inputmode="decimal" min="1.01" max="1000" step="0.01" value="${auto.x}" data-autox ${live || !auto.on ? 'disabled' : ''}>x</label>
      ${betChips(live || act.busy)}
      <button type="button" class="cta ${cta[1]}" data-cta ${cta[2] ? 'disabled' : ''}>${cta[0]}</button>
      ${fairBox(g)}`;
  }

  function renderRecent() {
    root.querySelector('[data-recent]').innerHTML = recent.map(c => `<span class="${c >= 2 ? 'hi' : 'lo'}">${c.toFixed(2)}x</span>`).join('') || '<span class="muted">Your recent crash points show here</span>';
  }
  const loadRecent = () => api('/history?game=crash').then(h => { recent = h.games.map(x => x.crash); renderRecent(); }).catch(() => {});

  function ended(r) {
    g = r.game; if (r.balance != null) setBalance(r.balance);
    stop(); frame(); renderControls(); refresh(); loadRecent();
    haptic('notificationOccurred', g.won ? 'success' : 'error');
  }
  function stop() { cancelAnimationFrame(raf); clearInterval(poll); poll = null; }
  function start() {
    stop(); frame(); renderControls();
    if (!active()) return;
    let wasStarting = phase() === 'starting';
    poll = setInterval(async () => {
      if (wasStarting && phase() === 'running') { wasStarting = false; renderControls(); }
      if (phase() !== 'running') return;
      const r = await api('/crash/status').catch(() => null); // network blip: keep animating, retry next tick
      if (r?.game && r.game.id === g.id && r.game.status !== 'active') ended(r);
    }, 400);
  }

  root.addEventListener('click', e => {
    if (!e.target.closest('[data-cta]')) return;
    act.run(async () => {
      if (active()) {
        const r = await api('/crash/cashout', {});
        if (r.game) ended(r);
      } else {
        const x = auto.x;
        if (auto.on && !(x >= 1.01 && x <= 1000)) throw new Error('Auto cash-out must be 1.01x–1000x');
        const r = await api('/crash/bet', { bet: S.bet, rid: rid(), auto: auto.on ? x : null });
        g = r.game; setBalance(r.balance); haptic('impactOccurred', 'medium');
        start();
      }
    });
  });
  controls.addEventListener('input', e => { if (e.target.matches('[data-autox]')) auto.x = Math.round(Number(e.target.value) * 100) / 100; });
  controls.addEventListener('change', e => {
    if (e.target.matches('[data-auto]')) { auto.on = e.target.checked; renderControls(); }
  });
  bindChips(controls, renderControls);
  bindFair(controls, () => g);
  const onResize = () => frame();
  addEventListener('resize', onResize);
  renderRecent(); loadRecent();
  start();
  return { destroy() { stop(); removeEventListener('resize', onResize); } };
}
