import { COIN, S, api, betChips, bindChips, bindFair, fairBox, fmt, haptic, makeAct, rid, setBalance } from '../core.js';

export default function mount(root, { initial, refresh, resync }) {
  const cfg = S.config.games.mines;
  let g = initial;
  const act = makeAct(render, async () => { g = await resync(); });

  function render() {
    const active = g?.status === 'active', over = g && !active, k = active ? g.revealed.length : -1;
    const status = !g ? `${cfg.mines} bombs hidden in ${cfg.cells} tiles — open safe ones to climb`
      : active ? (g.revealed.length ? `${g.multiplier.toFixed(2)}x now · next tile <b>${g.next?.toFixed(2)}x</b>` : `First safe tile pays <b>${g.next.toFixed(2)}x</b>`)
      : g.won ? `<span class="win">+${fmt(g.net)}${COIN} at ${g.multiplier.toFixed(2)}x</span>` : `<span class="lose">💥 Boom! −${fmt(g.bet)}${COIN}</span>`;
    let cells = '';
    for (let c = 0; c < cfg.cells; c++) {
      const opened = g?.revealed.includes(c), mine = over && g.mines.includes(c);
      const [cls, icon] = opened && mine ? ['boom', '💥'] : opened ? ['gem', '💎'] : mine ? ['ghost', '💣'] : over ? ['ghost', '💎'] : ['', ''];
      cells += `<button type="button" class="cell ${cls}" data-cell="${c}" ${!active || opened || act.busy ? 'disabled' : ''} aria-label="${opened ? (mine ? 'Bomb' : 'Safe') : `Tile ${c + 1}`}">${icon}</button>`;
    }
    const cta = active && g.revealed.length ? [`Cash out ${fmt(g.cashout)}`, 'cash', act.busy]
      : active ? ['Pick a tile', '', true]
      : [`${g ? 'Play again' : 'Bet'} · ${S.bet}${COIN}`, '', act.busy || S.user.balance < S.bet];
    root.innerHTML = `
      <div class="ladder">${cfg.ladder.map((m, i) => `<div class="step ${i < k ? 'done' : ''} ${i === k ? 'next' : ''}"><small>${i + 1} 💎</small><b>${m.toFixed(2)}x</b></div>`).join('')}</div>
      <div class="status" aria-live="polite">${status}</div>
      <div class="board panel neon"><div class="grid ${g ? '' : 'idle'}">${cells}</div></div>
      ${betChips(active || act.busy)}
      <button type="button" class="cta ${cta[1]}" data-cta ${cta[2] ? 'disabled' : ''}>${cta[0]}</button>
      ${fairBox(g)}`;
    root.querySelector('.step.next')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  const after = r => { g = r.game; if (r.balance != null) setBalance(r.balance); if (g.status !== 'active') refresh(); };
  root.addEventListener('click', e => {
    const cell = e.target.closest('[data-cell]');
    if (cell && !cell.disabled) return act.run(async () => {
      after(await api('/mines/reveal', { cell: Number(cell.dataset.cell) }));
      haptic(g.status === 'busted' ? 'notificationOccurred' : 'impactOccurred', g.status === 'busted' ? 'error' : g.status === 'cashed' ? 'heavy' : 'light');
    });
    if (e.target.closest('[data-cta]')) act.run(async () => {
      if (g?.status === 'active') { after(await api('/mines/cashout', {})); haptic('notificationOccurred', 'success'); }
      else { after(await api('/mines/bet', { bet: S.bet, rid: rid() })); haptic('impactOccurred', 'medium'); }
    });
  });
  bindChips(root, render);
  bindFair(root, () => g);
  render();
  return { destroy() {} };
}
