// Creates our OWN popup window for the achievement toast — independent of
// Steam's notification toast, composited over the game/UI in gamescope.
//
// Recipe (proven on Deck + PS5):
//   1. SteamClient.BrowserView.CreatePopup({ strName, parentPopupBrowserID })
//      -> { strCreateURL, browserView }   (parent id REQUIRED; skip uid 0)
//   2. window.open(strCreateURL, name, MINIMAL features) + document.write
//      (a real window.open size makes the surface opaque; minimal keeps it
//       composited/transparent. No createflags — a window-level blur bleeds past
//       the card as a halo.)
//   3. browserView.SetBounds(x,y,w,h) (LOGICAL coords == popup CSS px) +
//      SetVisible(true) + SetWindowStackingOrder(1)  (SetVisible = draws it)
//   4. measure the card and shrink the window to fit (full name, any lines)
//   5. animate out, then SteamClient.BrowserView.Destroy(view) + win.close()

import { ANIMATIONS, getAnim, getTheme, resolveAccent } from './themes';

const w = window as any;

export interface ToastData {
  name: string;
  icon?: string;
  pct?: number;
  /** Fully localized rarity line (e.g. "Only 2.3% of players have this"). */
  rarityText?: string;
}

export interface ToastStyle {
  themeId: string;
  animId: string;
  accentId: string;
  layout: string;
  position: string;
  /** Localized eyebrow + badge text. */
  eyebrow: string;
  badge: string;
}

export interface ToastOptions extends ToastStyle {
  rare: boolean;
  durationMs: number;
  width: number;
  /** Fired when this toast actually becomes visible (for syncing sound to display). */
  onShow?: () => void;
}

interface Live {
  win: Window | null;
  view: any;
  dismissTimer: any;
  destroyTimer: any;
}

interface LayoutCfg {
  dir: 'row' | 'column';
  iconSize: number;
  namePx: number;
  eyebrowPx: number;
  rarityPx: number;
  pad: string;
  gap: number;
  textAlign: 'left' | 'center';
  accentTop: boolean; // horizontal top bar instead of left bar
}

const LAYOUTS: Record<string, LayoutCfg> = {
  standard: { dir: 'row', iconSize: 52, namePx: 20, eyebrowPx: 12, rarityPx: 13, pad: '12px 22px 12px 18px', gap: 16, textAlign: 'left', accentTop: false },
  compact: { dir: 'row', iconSize: 40, namePx: 17, eyebrowPx: 11, rarityPx: 12, pad: '9px 16px 9px 14px', gap: 12, textAlign: 'left', accentTop: false },
  centered: { dir: 'column', iconSize: 56, namePx: 21, eyebrowPx: 12, rarityPx: 13, pad: '16px 22px 16px 22px', gap: 7, textAlign: 'center', accentTop: true },
  banner: { dir: 'row', iconSize: 64, namePx: 24, eyebrowPx: 13, rarityPx: 14, pad: '16px 28px 16px 22px', gap: 20, textAlign: 'left', accentTop: false },
};

function parentPopupBrowserID(): number {
  try {
    const pm = w.g_PopupManager;
    const popups = pm?.GetPopups?.() ?? [];
    const counts: Record<number, number> = {};
    for (const p of popups) {
      const name: string = p?.m_strName || p?.strName || p?.m_strTitle || '';
      const m = /_uid(\d+)/.exec(name);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (n <= 0) continue;
      if (/notificationtoast/i.test(name)) return n;
      counts[n] = (counts[n] || 0) + 1;
    }
    const best = Object.keys(counts).sort((a, b) => counts[Number(b)] - counts[Number(a)])[0];
    if (best) return Number(best);
  } catch {
    /* fall through */
  }
  return 2;
}

function mainDims(): { width: number; height: number } {
  try {
    const bw = w.SteamUIStore?.m_WindowStore?.MainWindowInstance?.m_BrowserWindow;
    if (bw?.innerWidth) return { width: bw.innerWidth, height: bw.innerHeight };
  } catch {
    /* fall through */
  }
  return { width: 1498, height: 843 };
}

function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml(data: ToastData, opts: ToastOptions): string {
  const theme = getTheme(opts.themeId);
  const [accA, accB] = resolveAccent(theme, opts.accentId);
  const anim = getAnim(opts.animId);
  const lay = LAYOUTS[opts.layout] || LAYOUTS.standard;
  const glow = theme.glow ? `0 0 16px ${theme.glow}` : 'none';
  const allKeyframes = ANIMATIONS.map((a) => `@keyframes kf_${a.id}{${a.keyframes}}`).join('');

  const eyebrowStyle = theme.eyebrow === 'accent'
    ? `background:linear-gradient(90deg,${accA},${accB});-webkit-background-clip:text;background-clip:text;color:transparent;`
    : `color:${theme.eyebrow};`;

  const iconHtml = data.icon
    ? `<img class="ic" src="${esc(data.icon)}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ic ph',innerHTML:'&#127942;'}))" />`
    : `<div class="ic ph">&#127942;</div>`;

  const accentCss = lay.accentTop
    ? `.card::before{content:"";position:absolute;left:0;right:0;top:0;height:4px;background:linear-gradient(90deg,${accA},${accB});}`
    : `.card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:linear-gradient(180deg,${accA},${accB});}`;

  const shimmerCss = theme.shimmer
    ? `.card::after{content:"";position:absolute;top:0;left:-60%;width:40%;height:100%;
        background:linear-gradient(100deg,transparent,rgba(255,255,255,0.16),transparent);
        transform:skewX(-18deg);animation:sweep 2.6s ease-in-out .8s infinite;}`
    : '';

  const badgeHtml = opts.rare && opts.badge
    ? `<span class="badge">${esc(opts.badge)}</span>` : '';
  const rarityHtml = data.rarityText ? `<div class="rar">${esc(data.rarityText)}</div>` : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:100%;min-height:100%;background:transparent!important;overflow:hidden;font-family:${theme.font};}
  .wrap{display:flex;align-items:flex-start;justify-content:center;min-height:100%;padding:10px;box-sizing:border-box;}
  .card{position:relative;display:flex;flex-direction:${lay.dir};align-items:center;gap:${lay.gap}px;
    padding:${lay.pad};width:100%;box-sizing:border-box;overflow:hidden;border-radius:${theme.radius}px;
    background:${theme.cardBg};
    ${theme.blur ? `-webkit-backdrop-filter:blur(${theme.blur}px) saturate(1.2);backdrop-filter:blur(${theme.blur}px) saturate(1.2);` : ''}
    box-shadow:inset 0 0 0 1px ${theme.border}${glow !== 'none' ? ',' + glow : ''};
    animation:kf_${anim.id} ${anim.timing} both;}
  ${accentCss}
  .card.out{animation:kf_out .34s ease-in forwards;}
  ${shimmerCss}
  .ic{flex:0 0 auto;width:${lay.iconSize}px;height:${lay.iconSize}px;border-radius:${Math.min(theme.radius, 8)}px;object-fit:cover;box-shadow:${theme.iconFrame};${lay.dir === 'row' ? 'align-self:flex-start;margin-top:2px;' : ''}}
  .ic.ph{display:flex;align-items:center;justify-content:center;font-size:${Math.round(lay.iconSize * 0.58)}px;background:radial-gradient(circle at 35% 30%,rgba(255,255,255,0.14),rgba(255,255,255,0.03));}
  .txt{display:flex;flex-direction:column;gap:2px;min-width:0;text-align:${lay.textAlign};${lay.dir === 'column' ? 'align-items:center;' : ''}}
  .eb{font-size:${lay.eyebrowPx}px;font-weight:700;letter-spacing:2px;text-transform:uppercase;${eyebrowStyle}}
  .badge{display:inline-block;margin-left:8px;padding:1px 7px;font-size:10px;font-weight:800;letter-spacing:1px;border-radius:2px;color:#15100a;background:linear-gradient(90deg,${accA},${accB});vertical-align:middle;}
  .nm{font-size:${lay.namePx}px;font-weight:800;color:${theme.nameColor};line-height:1.2;word-break:break-word;text-shadow:0 1px 2px rgba(0,0,0,0.8),0 0 6px rgba(0,0,0,0.5);}
  .rar{font-size:${lay.rarityPx}px;font-weight:600;color:${theme.rarityColor};margin-top:1px;}
  .rar b{color:${theme.pctColor};}
  @keyframes kf_out{to{opacity:0;transform:translateY(-22px) scale(.98);}}
  @keyframes sweep{0%{left:-60%;}60%,100%{left:130%;}}
  ${allKeyframes}
  </style></head><body><div class="wrap"><div class="card" id="card">
    ${iconHtml}
    <div class="txt">
      <div class="eb">${esc(opts.eyebrow)}${badgeHtml}</div>
      <div class="nm">${esc(data.name)}</div>
      ${rarityHtml}
    </div>
  </div></div></body></html>`;
}

export class ToastWindow {
  private live?: Live;
  private queue: Array<{ data: ToastData; opts: ToastOptions }> = [];

  show(data: ToastData, opts: ToastOptions): void {
    if (this.live) {
      this.queue.push({ data, opts });
      return;
    }
    this.present(data, opts);
  }

  private present(data: ToastData, opts: ToastOptions): void {
    try {
      const name = 'kitsune_ach_toast';
      const bv = w.SteamClient?.BrowserView;
      if (!bv?.CreatePopup) return;
      const r = bv.CreatePopup({ strName: name, parentPopupBrowserID: parentPopupBrowserID() });
      const url: string = r.strCreateURL;
      const view = r.browserView;

      const dims = mainDims();
      const W = Math.max(300, Math.min(opts.width, dims.width - 24));
      const maxH = Math.max(140, dims.height - 24);
      const margin = 12;
      const pos = opts.position || 'top-center';
      const x = pos.endsWith('left') ? margin : pos.endsWith('right') ? dims.width - W - margin : Math.round((dims.width - W) / 2);
      const atBottom = pos.startsWith('bottom');
      const yFor = (h: number) => (atBottom ? Math.max(margin, dims.height - h - margin) : margin);

      const win: Window | null = w.open(url, name, 'top=0,left=0,width=2,height=2,resizable=yes,status=0,toolbar=0,menubar=0,location=0');
      if (win) { win.document.write(buildHtml(data, opts)); win.document.close(); }
      try { view.SetBounds(x, yFor(maxH), W, maxH); } catch { /* ignore */ }
      try { view.SetVisible(true); } catch { /* ignore */ }
      try { view.SetWindowStackingOrder(1); } catch { /* ignore */ }
      try { opts.onShow?.(); } catch { /* ignore */ }

      const live: Live = { win, view, dismissTimer: null, destroyTimer: null };
      this.live = live;

      // fit the window to the content (full name, any number of lines)
      setTimeout(() => {
        if (this.live !== live) return;
        try {
          const card = win?.document?.getElementById('card');
          const h = card ? (card as HTMLElement).offsetHeight : 0;
          if (h > 0) {
            const fh = Math.min(maxH, h + 22);
            view.SetBounds(x, yFor(fh), W, fh);
          }
        } catch { /* ignore */ }
      }, 90);

      live.dismissTimer = setTimeout(() => this.dismiss(live), Math.max(1500, opts.durationMs));
    } catch (e) {
      console.error('[achievement-toasts] present failed', e);
      this.live = undefined;
      this.pump();
    }
  }

  private dismiss(live: Live): void {
    if (this.live !== live) return;
    try {
      const card = live.win?.document?.getElementById('card');
      if (card) (card as HTMLElement).classList.add('out');
    } catch { /* ignore */ }
    live.destroyTimer = setTimeout(() => {
      this.destroy(live);
      this.pump();
    }, 360);
  }

  private destroy(live: Live): void {
    try { if (live.view) w.SteamClient?.BrowserView?.Destroy?.(live.view); } catch { /* ignore */ }
    try { if (live.win && !live.win.closed) live.win.close(); } catch { /* ignore */ }
    if (this.live === live) this.live = undefined;
  }

  private pump(): void {
    const next = this.queue.shift();
    if (next) setTimeout(() => this.present(next.data, next.opts), 250);
  }

  deinit(): void {
    this.queue = [];
    if (this.live) {
      try { clearTimeout(this.live.dismissTimer); } catch { /* ignore */ }
      try { clearTimeout(this.live.destroyTimer); } catch { /* ignore */ }
      this.destroy(this.live);
    }
    this.live = undefined;
  }
}
