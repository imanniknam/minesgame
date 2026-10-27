// SVG art and icons (no emoji as UI icons: they render differently on every phone).
// Icons are 24x24, stroke = currentColor, so CSS colors them. Game art carries its own gradients.
const icon = (body, extra = '') => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;

export const I = {
  coin: `<svg class="ic coin-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="url(#coinG)"/><circle cx="12" cy="12" r="7.2" fill="none" stroke="#04263a" stroke-width="1.4" opacity=".35"/><path d="M15.2 8.9a4.3 4.3 0 1 0 0 6.2" fill="none" stroke="#04263a" stroke-width="2.2" stroke-linecap="round"/><defs><radialGradient id="coinG" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#cffafe"/><stop offset=".55" stop-color="#22d3ee"/><stop offset="1" stop-color="#0e7490"/></radialGradient></defs></svg>`,
  play: icon('<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>'),
  cash: icon('<path d="M4 7h16v10H4z"/><circle cx="12" cy="12" r="2.5"/><path d="M7 10v4M17 10v4"/>'),
  dice: icon('<rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="9" cy="9" r="1.1" fill="currentColor"/><circle cx="15" cy="15" r="1.1" fill="currentColor"/><circle cx="15" cy="9" r="1.1" fill="currentColor"/><circle cx="9" cy="15" r="1.1" fill="currentColor"/>'),
  shield: icon('<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>'),
  help: icon('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>'),
  close: icon('<path d="M6 6l12 12M18 6L6 18"/>'),
  gauge: icon('<path d="M4.5 16a8 8 0 1 1 15 0"/><path d="M12 13l4-4"/><circle cx="12" cy="13.5" r="1.4" fill="currentColor"/>'),
  bombIc: icon('<circle cx="11" cy="14" r="6.5"/><path d="M15.5 9.5l2-2M17 5l.6-1.6M19.5 7.4L21 6.8M18.8 4.6l1-1"/>'),
  stack: icon('<ellipse cx="12" cy="6.5" rx="7" ry="2.5"/><path d="M5 6.5v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-5M5 11.5v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-5"/>'),
  gift: icon('<rect x="3.5" y="8.5" width="17" height="4" rx="1"/><path d="M5 12.5v8h14v-8M12 8.5v12M12 8.5S10.5 4 8 4.5 7 8.5 12 8.5zM12 8.5S13.5 4 16 4.5 17 8.5 12 8.5z"/>'),
  users: icon('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 19.5c.8-3.3 3.3-5 6.5-5s5.7 1.7 6.5 5"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.6c1.8.7 3 2.3 3.5 4.9"/>'),
  trophy: icon('<path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 14v3M8 20h8M9 17h6"/>'),
  spark: icon('<path d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6z"/><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>'),
  lock: icon('<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>'),
  chevron: icon('<path d="M9 6l6 6-6 6"/>'),
  minus: icon('<path d="M6 12h12"/>', 'stroke-width="2.4"'),
  plus: icon('<path d="M12 6v12M6 12h12"/>', 'stroke-width="2.4"'),
};

// Faceted crystal. `glow` adds the soft halo used on revealed tiles and the header art.
export const GEM = `<svg class="art gem-art" viewBox="0 0 64 64" aria-hidden="true">
  <defs>
    <linearGradient id="gemA" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e0fbff"/><stop offset=".45" stop-color="#38bdf8"/><stop offset="1" stop-color="#6d28d9"/></linearGradient>
    <linearGradient id="gemB" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a5f3fc"/><stop offset="1" stop-color="#2563eb"/></linearGradient>
    <linearGradient id="gemC" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c084fc"/><stop offset="1" stop-color="#4c1d95"/></linearGradient>
  </defs>
  <path d="M18 10h28l12 14-26 34L6 24z" fill="url(#gemA)"/>
  <path d="M18 10l6 14h16l6-14z" fill="#ecfeff" opacity=".75"/>
  <path d="M6 24h18l8 34z" fill="url(#gemB)" opacity=".9"/>
  <path d="M58 24H40l-8 34z" fill="url(#gemC)" opacity=".9"/>
  <path d="M24 24h16l-8 34z" fill="#7dd3fc" opacity=".55"/>
  <path d="M18 10l6 14L6 24zM46 10l-6 14h18z" fill="#bae6fd" opacity=".6"/>
  <path d="M18 10h28l12 14-26 34L6 24z" fill="none" stroke="#f0fdff" stroke-width="1.2" stroke-linejoin="round" opacity=".8"/>
  <path d="M22 13l-3 7" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".9"/>
</svg>`;

export const BOMB = `<svg class="art bomb-art" viewBox="0 0 64 64" aria-hidden="true">
  <defs>
    <radialGradient id="bombA" cx=".35" cy=".3" r=".75"><stop offset="0" stop-color="#64748b"/><stop offset=".45" stop-color="#1e1b2e"/><stop offset="1" stop-color="#05050c"/></radialGradient>
  </defs>
  <path d="M40 18c4-6 9-7 13-4" fill="none" stroke="#d4a373" stroke-width="3" stroke-linecap="round"/>
  <rect x="33" y="15" width="12" height="9" rx="2" transform="rotate(40 39 19.5)" fill="#334155" stroke="#94a3b8" stroke-width="1.2"/>
  <circle cx="29" cy="37" r="19" fill="url(#bombA)" stroke="#475569" stroke-width="1.2"/>
  <ellipse cx="22" cy="29" rx="6" ry="3.5" transform="rotate(-35 22 29)" fill="#fff" opacity=".28"/>
  <g class="bomb-spark"><path d="M54 8l1.6 4.4L60 14l-4.4 1.6L54 20l-1.6-4.4L48 14l4.4-1.6z" fill="#fde68a"/><circle cx="54" cy="14" r="2.4" fill="#fff"/><circle cx="54" cy="14" r="6" fill="#ec4899" opacity=".35"/></g>
</svg>`;

// unopened tile mark: a diamond outline with a four-point star
export const MARK = `<svg class="mark-art" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3l13 13-13 13L3 16z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M16 9l1.8 5.2L23 16l-5.2 1.8L16 23l-1.8-5.2L9 16l5.2-1.8z" fill="currentColor"/></svg>`;
