import { S, api, betChips, bindChips, bindFair, fairBox, fmt, haptic, makeAct, rid, setBalance } from '../core.js';

const ICON = ['💩', '😂'], NAME = ['Poop', 'Laugh'];

export default function mount(root, { initial, refresh, resync }) {
  const cfg = S.config.games.poop;
  let g = initial, flash = null; // flash = { choice, ok } for the last pick animation
  const act = makeAct(render, async () => { g = await resync(); });

  function render() {
    const active = g?.status === 'active', stage = g?.stage ?? 0;
    const status = !g ? 'Guess 💩 or 😂 — 50/50 each stage, up to 5 stages'
      : active ? (stage ? `Stage ${stage}/${cfg.stages} cleared · ${g.multiplier.toFixed(2)}x · next <b>${g.next.toFixed(2)}x</b>` : `Stage 1/${cfg.stages} · win pays <b>${g.next.toFixed(2)}x</b>`)
      : g.won ? `<span class="win">+${fmt(g.net)} 🪙 at ${g.multiplier.toFixed(2)}x${stage === cfg.stages ? ' · perfect run!' : ''}</span>`
      : `<span class="lose">It was ${ICON[g.answers[stage]]}! −${fmt(g.bet)} 🪙</span>`;
    const cta = active && stage ? [`Cash out ${fmt(g.cashout)}`, 'cash', act.busy]
      : active ? ['Pick 💩 or 😂', '', true]
      : [`${g ? 'Play again' : 'Bet'} · ${S.bet} 🪙`, '', act.busy || S.user.balance < S.bet];
    root.innerHTML = `
      <div class="ladder">${cfg.ladder.map((m, i) => `<div class="step ${active && i < stage ? 'done' : ''} ${active && i === stage ? 'next' : ''}"><small>Stage ${i + 1}</small><b>${m.toFixed(2)}x</b></div>`).join('')}</div>
      <div class="status" aria-live="polite">${status}</div>
      <div class="trail">${(g?.answers ?? []).map((a, i) => `<span class="${g.picks[i] === a ? 'ok' : 'bad'}">${ICON[g.picks[i]]}</span>`).join('') || '&nbsp;'}</div>
      <div class="duo">${[0, 1].map(c => `
        <button type="button" class="pick ${flash?.choice === c ? (flash.ok ? 'gem' : 'boom') : ''}" data-choice="${c}" ${!active || act.busy ? 'disabled' : ''}>
          <span>${ICON[c]}</span><small>${NAME[c]}</small></button>`).join('')}</div>
      ${betChips(active || act.busy)}
      <button type="button" class="cta ${cta[1]}" data-cta ${cta[2] ? 'disabled' : ''}>${cta[0]}</button>
      ${fairBox(g)}`;
    root.querySelector('.step.next')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  const after = r => { g = r.game; if (r.balance != null) setBalance(r.balance); if (g.status !== 'active') refresh(); };
  root.addEventListener('click', e => {
    const p = e.target.closest('[data-choice]');
    if (p && !p.disabled) return act.run(async () => {
      const choice = Number(p.dataset.choice);
      after(await api('/poop/pick', { choice, stage: g.picks.length }));
      flash = { choice, ok: g.status !== 'busted' };
      haptic('notificationOccurred', flash.ok ? 'success' : 'error');
      setTimeout(() => { flash = null; render(); }, 700);
    });
    if (e.target.closest('[data-cta]')) act.run(async () => {
      flash = null;
      if (g?.status === 'active') { after(await api('/poop/cashout', {})); haptic('notificationOccurred', 'success'); }
      else { after(await api('/poop/bet', { bet: S.bet, rid: rid() })); haptic('impactOccurred', 'medium'); }
    });
  });
  bindChips(root, render);
  bindFair(root, () => g);
  render();
  return { destroy() {} };
}
