// Shared client plumbing. The client never decides outcomes or balances; it renders server answers.
export const tg = window.Telegram?.WebApp;
export const $ = (sel, root = document) => root.querySelector(sel);
const devUser = new URLSearchParams(location.search).get('dev'); // local testing only; ignored by the deployed server

export const S = { user: null, config: null, bet: 10, serverOffset: 0 };

export const haptic = (t, k) => { try { tg?.HapticFeedback?.[t]?.(k); } catch {} };
export const rid = () => crypto.randomUUID?.() ?? `r${Date.now()}${Math.random().toString(36).slice(2)}`;
export const fmt = n => n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
export const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
export const serverNow = () => Date.now() + S.serverOffset;
export const syncClock = t => { if (t) S.serverOffset = t - Date.now(); };

export async function api(path, body) {
  const headers = { 'content-type': 'application/json' };
  if (tg?.initData) headers.authorization = 'tma ' + tg.initData;
  if (devUser) headers['x-dev-user'] = devUser;
  let r;
  try {
    r = await fetch('/api' + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw Object.assign(new Error('Connection lost — check your network'), { offline: true }); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'Something went wrong'), { status: r.status, data: j });
  syncClock(j.serverNow);
  return j;
}

let toastT;
export function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600);
}

export function setBalance(b) {
  const el = $('#balance'), prev = S.user.balance;
  S.user.balance = b; el.textContent = fmt(b);
  if (prev != null && b !== prev) {
    el.className = b > prev ? 'up' : 'down';
    setTimeout(() => (el.className = ''), 700);
  }
}

// Bet chips 10 / 50 / 100, shared by every game.
export function betChips(disabled) {
  return `<div class="bets" role="radiogroup" aria-label="Bet amount">${S.config.bets.map(v =>
    `<button type="button" class="chip" role="radio" aria-checked="${v === S.bet}" data-bet="${v}" ${disabled ? 'disabled' : ''}>${v}</button>`).join('')}</div>`;
}
export function bindChips(root, onChange) {
  root.addEventListener('click', e => {
    const v = Number(e.target.closest?.('[data-bet]')?.dataset.bet);
    if (v && !e.target.disabled) { S.bet = v; haptic('selectionChanged'); onChange(); }
  });
}

// Busy-guard: one request at a time per screen; on conflict resync from the server.
export function makeAct(render, resync) {
  const st = { busy: false };
  st.run = async fn => {
    if (st.busy) return;
    st.busy = true; render();
    try { await fn(); }
    catch (e) {
      toast(e.message); haptic('notificationOccurred', 'error');
      if (e.status === 409 || e.status === 401) await resync?.(e).catch(() => {});
    } finally { st.busy = false; render(); }
  };
  return st;
}

// ---------- provably fair: recompute the outcome from the revealed seed, in the browser ----------
export async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const VERIFY = {
  async mines(g) {
    const ranked = await Promise.all([...Array(9).keys()].map(async c => [c, await sha256(`${g.seed}:${c}`)]));
    const m = ranked.sort((a, b) => (a[1] < b[1] ? -1 : 1)).slice(0, 2).map(([c]) => c).sort((a, b) => a - b);
    return [m.join() === [...g.mines].sort((a, b) => a - b).join(), `bombs on tiles ${m.map(x => x + 1).join(' & ')}`];
  },
  async poop(g) {
    const ans = await Promise.all(g.answers.map(async (_, i) => parseInt((await sha256(`${g.seed}:${i}`))[0], 16) & 1));
    return [ans.join() === g.answers.join(), `answers ${ans.map(a => (a ? '😂' : '💩')).join(' ')}`];
  },
  async roulette(g) {
    const LIMIT = Math.floor(2 ** 32 / 37) * 37;
    for (let i = 0; ; i++) {
      const v = parseInt((await sha256(`${g.seed}:${i}`)).slice(0, 8), 16);
      if (v < LIMIT) return [v % 37 === g.number, `winning number ${v % 37}`];
    }
  },
  async crash(g) {
    const r = parseInt((await sha256(g.seed)).slice(0, 13), 16) / 2 ** 52;
    const c = Math.min(100000, Math.max(100, Math.floor(95 / (1 - r)))) / 100;
    return [c === g.crash, `crash point ${c.toFixed(2)}x`];
  },
};
export async function verify(g) {
  const hashOk = (await sha256(g.seed)) === g.seedHash;
  const [ok, what] = await VERIFY[g.game](g);
  return hashOk && ok ? `✅ Verified: seed matches its hash, ${what}` : '❌ Mismatch!';
}

export function fairBox(g) {
  const over = g && g.status !== 'active';
  return `<details class="fair"><summary>🔒 Provably fair</summary>
    <p>The outcome is fixed by a secret seed before you play. You see its SHA-256 now; the seed is revealed after the round so you can check nothing changed.</p>
    <p class="mono">Hash: ${g?.seedHash ?? '—'}</p>
    ${over ? `<p class="mono">Seed: ${g.seed}</p><button type="button" class="ghost" data-verify>Verify last round</button><p data-verify-out></p>` : ''}
  </details>`;
}
export function bindFair(root, getGame) {
  root.addEventListener('click', async e => {
    if (!e.target.matches('[data-verify]')) return;
    $('[data-verify-out]', root).textContent = await verify(getGame());
  });
}

export const ago = t => {
  const s = (Date.now() - new Date(t)) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(t).toLocaleDateString();
};
