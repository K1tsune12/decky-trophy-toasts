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

import { ANIMATIONS, defaultAmbient, defaultFx, fontImport, getAnim, getTheme, resolveAccent, resolveFontStack, resolveFxColor } from './themes';

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
  /** Ongoing accent color animation; '' = the theme's default. */
  ambient?: string;
  /** Font override id; '' = the theme's own font. */
  font?: string;
  /** Flash/particle color override (ACCENTS id); '' = each effect's default. */
  fxColor?: string;
  /** Animated glowing border ring around the card; undefined = theme default. */
  border?: boolean;
  /** Effect ids to render; undefined = sensible defaults by rarity. */
  fx?: string[];
  /** Card background opacity 0..100 (undefined = theme default). */
  bgOpacity?: number;
  /** Whole-card opacity 0..100 (undefined = 100). */
  cardOpacity?: number;
  /** Frosted-glass blur on the card background (undefined = theme default). */
  glass?: boolean;
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

/** "#rrggbb" -> "rgba(r,g,b,a)"; passes through anything it can't parse. */
function hexToRgba(hex: string, a: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex).trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Set every rgba(...) stop in a background/gradient to the given alpha (0..1). */
function reAlphaBg(cardBg: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha)).toFixed(3);
  return cardBg.replace(/rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/g, (_m, r, g, b) => `rgba(${r},${g},${b},${a})`);
}

function buildParts(data: ToastData, opts: ToastOptions, opaque = false, isStatic = false): { fontImp: string; style: string; body: string } {
  const rare = opts.rare;
  const theme = getTheme(opts.themeId);
  const [accA, accB] = resolveAccent(theme, opts.accentId);
  const anim = getAnim(opts.animId);
  const lay = LAYOUTS[opts.layout] || LAYOUTS.standard;
  const fontStack = resolveFontStack(theme, opts.font);
  const fontImp = fontImport(opts.font);
  const fxCol = resolveFxColor(opts.fxColor || ''); // '' = per-effect defaults
  const glow = theme.glow ? `0 0 16px ${theme.glow}` : 'none';
  const allKeyframes = ANIMATIONS.map((a) => `@keyframes kf_${a.id}{${a.keyframes}}`).join('');

  // User transparency / glass controls. bgOpacity re-alphas the card background
  // (baked, so it works over the game too); cardOpacity fades the whole card (here
  // for the preview; the over-game path applies it in the helper); glass is the
  // frosted blur (preview / Steam UI only — a running game can't be blurred).
  const cardBg = typeof opts.bgOpacity === 'number' ? reAlphaBg(theme.cardBg, opts.bgOpacity / 100) : theme.cardBg;
  const cardA = typeof opts.cardOpacity === 'number' ? Math.max(0, Math.min(1, opts.cardOpacity / 100)) : 1;
  const glassOn = opts.glass !== false;
  const glassBlur = (!opaque && glassOn && theme.blur)
    ? `-webkit-backdrop-filter:blur(${theme.blur}px) saturate(1.2);backdrop-filter:blur(${theme.blur}px) saturate(1.2);`
    : '';

  const eyebrowStyle = theme.eyebrow === 'accent'
    ? `background:linear-gradient(90deg,${accA},${accB});-webkit-background-clip:text;background-clip:text;color:transparent;`
    : `color:${theme.eyebrow};`;

  const iconHtml = data.icon
    ? `<img class="ic" src="${esc(data.icon)}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ic ph',innerHTML:'&#127942;'}))" />`
    : `<div class="ic ph">&#127942;</div>`;

  // Which effects are on (opts.fx overrides the per-theme defaults).
  const fxSet: string[] = Array.isArray(opts.fx) ? opts.fx : defaultFx(theme.id, rare);
  const has = (f: string) => fxSet.includes(f);
  const r8 = Math.min(theme.radius, 8);
  const rx = theme.radius > 0 ? 3 : 0; // edge-outline corner radius (viewBox units)
  const edgeRect = (cls: string) => `<rect class="${cls}" x="1" y="1" width="98" height="98" rx="${rx}" pathLength="100"></rect>`;
  const edgeSvg = (cls: string, inner: string) => `<svg class="${cls}" preserveAspectRatio="none" viewBox="0 0 100 100">${inner}</svg>`;

  // Ongoing "ambient" color animation on the accent bar (light, CSS-only).
  const ambient = opts.ambient || defaultAmbient(theme.id);
  const grad = lay.accentTop ? '90deg' : '180deg';
  const glowC = theme.glow || 'rgba(255,255,255,0.4)';
  let barBg = `linear-gradient(${grad},${accA},${accB})`;
  let barSize = '';
  const ambAnims: string[] = [];
  let ambKf = '';
  if (ambient === 'flow' || ambient === 'flow-pulse') {
    barBg = `linear-gradient(${grad},${accA},${accB},${accA})`;
    barSize = lay.accentTop ? 'background-size:300% 100%;' : 'background-size:100% 300%;';
    const to = lay.accentTop ? '-300% 0' : '0 -300%';
    ambKf += `@keyframes amb_flow{to{background-position:${to};}}`;
    ambAnims.push('amb_flow 2.6s linear infinite');
  }
  if (ambient === 'hue') {
    ambKf += '@keyframes amb_hue{to{filter:hue-rotate(360deg);}}';
    ambAnims.push('amb_hue 4s linear infinite');
  }
  if (ambient === 'pulse' || ambient === 'flow-pulse') {
    ambKf += `@keyframes amb_pulse{0%,100%{box-shadow:0 0 5px ${glowC};}50%{box-shadow:0 0 18px ${glowC};}}`;
    ambAnims.push('amb_pulse 1.9s ease-in-out infinite');
  }
  if (ambient === 'breathe') {
    ambKf += '@keyframes amb_breathe{0%,100%{opacity:.7;}50%{opacity:1;}}';
    ambAnims.push('amb_breathe 2.8s ease-in-out infinite');
  }
  const barPos = lay.accentTop ? 'left:0;right:0;top:0;height:4px;' : `left:0;top:0;bottom:0;width:${lay.accentTop ? 4 : 5}px;`;
  const accentCss = has('accentbar')
    ? `.card::before{content:"";position:absolute;${barPos}background:${barBg};${barSize}${ambAnims.length ? `animation:${ambAnims.join(',')};` : ''}}` + ambKf
    : '';

  // Shimmer sweep: rare only (the "passing shine" effect). Motion-only -> skip in static.
  const shimmerCss = rare && !isStatic
    ? `.card::after{content:"";position:absolute;top:0;left:-60%;width:40%;height:100%;z-index:3;pointer-events:none;
        background:linear-gradient(100deg,transparent,rgba(255,255,255,0.18),transparent);
        transform:skewX(-18deg);animation:sweep 2.6s ease-in-out .8s infinite;}`
    : '';

  // Animated glowing border ring (rotating conic gradient, masked to the edge).
  const border = has('border');
  const borderKf = border ? '@property --tbang{syntax:"<angle>";initial-value:0deg;inherits:false;}@keyframes tbspin{to{--tbang:360deg;}}' : '';
  const borderCss = border
    ? `.brd{position:absolute;inset:-1px;border-radius:${theme.radius}px;padding:2px;pointer-events:none;z-index:2;
        background:conic-gradient(from var(--tbang),${accA},${accB},${accA},${accB},${accA});
        -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;
        mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude;
        animation:tbspin 3.2s linear infinite;}`
    : '';
  const borderEl = border ? '<div class="brd"></div>' : '';

  // Rare: pulsing gold glow around the card.
  const rareGlowKf = rare
    ? `@keyframes trglow{0%,100%{box-shadow:inset 0 0 0 1px ${theme.border},0 0 14px rgba(255,197,92,0.42);}50%{box-shadow:inset 0 0 0 1px ${theme.border},0 0 34px rgba(255,197,92,0.72);}}`
    : '';
  const cardAnim = `kf_${anim.id} ${anim.timing} both${rare ? ',trglow 2.3s ease-in-out .5s infinite' : ''}`;

  const badgeHtml = opts.rare && opts.badge
    ? `<span class="badge">${esc(opts.badge)}</span>` : '';
  const rarityHtml = data.rarityText ? `<div class="rar">${esc(data.rarityText)}</div>` : '';

  // Icon wrapper; stamp + shockwave are entrance one-shots on it.
  const iconFxCss =
    `.icwrap{position:relative;flex:0 0 auto;display:inline-flex;${lay.dir === 'row' ? 'align-self:flex-start;margin-top:2px;' : ''}${has('stamp') ? 'animation:icstamp .55s cubic-bezier(.2,1.5,.45,1) .08s both;' : ''}}` +
    (has('stamp') ? '@keyframes icstamp{0%{opacity:0;transform:scale(.4);}60%{transform:scale(1.12);}100%{opacity:1;transform:scale(1);}}' : '') +
    (has('shockwave') ? `.icwrap::after{content:"";position:absolute;inset:0;border-radius:${r8}px;border:2px solid ${accA};opacity:0;pointer-events:none;animation:shock .8s ease-out .2s both;}@keyframes shock{0%{opacity:.7;transform:scale(1);}100%{opacity:0;transform:scale(1.8);}}` : '');

  let fxCss = '';
  let fxEls = '';
  // The glow line lives OUTSIDE the card (which clips), so it never gets cut.
  let glowlineEl = '';
  if ((has('glowline') || has('edgepulse') || has('edgerainbow')) && !isStatic) {
    fxCss += `.edgefx{position:absolute;top:0;left:0;width:100%;height:100%;z-index:5;pointer-events:none;overflow:visible;display:block;}
    .edgefx rect{fill:none;vector-effect:non-scaling-stroke;}`;
  }
  if (has('glowline') && !isStatic) {
    // Match the cairo over-game render: a FAINT continuous outline (gbase) + a soft,
    // wide travelling glow (gglow, blurred) + one crisp bright core segment (grun).
    // dasharray 22/78 over the normalized pathLength=100 -> exactly ONE segment, not
    // a repeating dash. Smooth glow instead of stacked drop-shadow bands (which read
    // as several parallel lines).
    fxCss += `.glowline .gbase{stroke:${accB};stroke-width:1.1;opacity:.38;filter:drop-shadow(0 0 3px ${accB});}
    .glowline .gglow{stroke:${accB};stroke-width:6;stroke-linecap:round;stroke-dasharray:22 78;opacity:.8;filter:blur(2.4px);animation:gline 2.3s linear infinite;}
    .glowline .grun{stroke:${accA};stroke-width:2.2;stroke-linecap:round;stroke-dasharray:22 78;filter:drop-shadow(0 0 2px ${accA});animation:gline 2.3s linear infinite;}
    @keyframes gline{from{stroke-dashoffset:0;}to{stroke-dashoffset:-100;}}`;
    glowlineEl += edgeSvg('edgefx glowline', edgeRect('gbase') + edgeRect('gglow') + edgeRect('grun'));
  }
  if (has('edgepulse') && !isStatic) {
    // Continuous outline whose glow pulses (no travelling segment).
    fxCss += `.epulse rect{stroke:${accB};stroke-width:2.5;animation:epulse 1.9s ease-in-out infinite;}
    @keyframes epulse{0%,100%{filter:drop-shadow(0 0 2px ${accB});opacity:.78;}50%{filter:drop-shadow(0 0 6px ${accB}) drop-shadow(0 0 13px ${accA});opacity:1;}}`;
    glowlineEl += edgeSvg('edgefx epulse', edgeRect('e'));
  }
  if (has('edgerainbow') && !isStatic) {
    // Continuous outline that cycles through colors.
    fxCss += `.erain rect{stroke:${accB};stroke-width:2.5;filter:drop-shadow(0 0 4px ${accB});animation:erain 4s linear infinite;}
    @keyframes erain{to{filter:drop-shadow(0 0 5px ${accB}) hue-rotate(360deg);}}`;
    glowlineEl += edgeSvg('edgefx erain', edgeRect('e'));
  }
  if (has('comet') && lay.dir === 'row' && !isStatic) {
    fxCss += `.comet{position:absolute;left:-1px;width:4px;height:15px;border-radius:3px;z-index:3;pointer-events:none;background:linear-gradient(180deg,${hexToRgba('#ffffff', 0.9)},${hexToRgba(accB, 0.3)});box-shadow:0 0 7px ${hexToRgba(accA, 0.7)},0 0 16px ${hexToRgba(accB, 0.5)},0 0 26px ${hexToRgba(accB, 0.28)};filter:blur(0.6px);opacity:.9;animation:comet 2.6s ease-in-out .4s infinite;}@keyframes comet{0%{top:-18px;opacity:0;}14%{opacity:.9;}86%{opacity:.9;}100%{top:100%;opacity:0;}}`;
    fxEls += '<div class="comet"></div>';
  }
  if (has('flash') && !isStatic) {
    const flashInner = fxCol ? hexToRgba(fxCol, 0.65) : 'rgba(255,224,150,0.65)';
    fxCss += `.flash{position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:4;background:radial-gradient(circle at 50% 35%,${flashInner},transparent 62%);animation:flashin .75s ease-out both;}@keyframes flashin{0%{opacity:0;}14%{opacity:1;}100%{opacity:0;}}`;
    fxEls += '<div class="flash"></div>';
  }
  if (has('sparkles') && !isStatic) {
    const sp = [[12, 24], [82, 16], [56, 80], [90, 66], [30, 86], [70, 38]];
    const dot = fxCol || '#ffe9a8';
    const g1 = fxCol || '#ffd166';
    const g2 = fxCol ? hexToRgba(fxCol, 0.6) : 'rgba(255,200,90,0.6)';
    fxCss += `.spark{position:absolute;width:5px;height:5px;border-radius:50%;background:${dot};box-shadow:0 0 6px ${g1},0 0 10px ${g2};pointer-events:none;z-index:4;animation:twinkle 1.7s ease-in-out infinite;}@keyframes twinkle{0%,100%{opacity:0;transform:scale(.4);}50%{opacity:1;transform:scale(1.1);}}`;
    fxEls += sp.map((p, i) => `<span class="spark" style="left:${p[0]}%;top:${p[1]}%;animation-delay:${(i * 0.28).toFixed(2)}s;"></span>`).join('');
  }
  if (has('stars') && !isStatic) {
    const st = [[8, 30], [22, 72], [40, 16], [52, 84], [66, 28], [78, 66], [88, 20], [94, 54], [16, 50], [72, 48], [34, 62], [60, 74]];
    const col = fxCol || '#fff3c4';
    const g1 = fxCol || '#ffe08a';
    const g2 = fxCol ? hexToRgba(fxCol, 0.8) : 'rgba(255,210,120,0.8)';
    fxCss += `.star{position:absolute;color:${col};font-size:12px;line-height:1;pointer-events:none;z-index:4;text-shadow:0 0 6px ${g1},0 0 12px ${g2};animation:startw 1.6s ease-in-out infinite;}@keyframes startw{0%,100%{opacity:0;transform:scale(.3) rotate(0deg);}50%{opacity:1;transform:scale(1) rotate(28deg);}}`;
    fxEls += st.map((p, i) => `<span class="star" style="left:${p[0]}%;top:${p[1]}%;animation-delay:${(i * 0.15).toFixed(2)}s;">✦</span>`).join('');
  }
  if (has('glint') && !isStatic) {
    fxCss += `.glint{position:absolute;top:-20%;left:-35%;width:26%;height:140%;z-index:3;pointer-events:none;transform:rotate(18deg);background:linear-gradient(90deg,transparent,rgba(255,255,255,0.55),transparent);filter:blur(1px);animation:glint 1.2s ease-in .25s both;}@keyframes glint{0%{left:-35%;}100%{left:135%;}}`;
    fxEls += '<div class="glint"></div>';
  }
  if (has('confetti') && !isStatic) {
    const cols = fxCol ? [fxCol] : ['#ffd166', '#ff7a1a', '#4fb6ff', '#9cff9c', '#ff6ad0', '#c89cff'];
    const cx = [10, 24, 38, 52, 66, 80, 92];
    fxCss += `.conf{position:absolute;top:-10px;width:6px;height:9px;z-index:4;pointer-events:none;opacity:0;animation:conf 1.5s ease-in both;}@keyframes conf{0%{top:-10px;opacity:0;transform:rotate(0);}10%{opacity:1;}100%{top:112%;opacity:0;transform:rotate(380deg);}}`;
    fxEls += cx.map((x, i) => `<span class="conf" style="left:${x}%;background:${cols[i % cols.length]};animation-delay:${(i * 0.07).toFixed(2)}s;"></span>`).join('');
  }
  if (has('blooddrip') && !isStatic) {
    // Blood drops forming at the top edge and trickling down. Always red (blood),
    // or the fx color if one is set.
    const bBot = fxCol || '#ff2a2a';
    const bx = [12, 30, 50, 68, 86];
    fxCss += `.blood{position:absolute;top:-2px;width:4px;z-index:3;pointer-events:none;border-radius:0 0 60% 60%;background:linear-gradient(180deg,#5a0000,${bBot});box-shadow:0 0 5px ${hexToRgba(bBot, 0.6)};animation:bdrip 2.8s ease-in infinite;}@keyframes bdrip{0%{height:0;top:-2px;opacity:0;}10%{opacity:.95;}55%{height:16px;}100%{height:8px;top:100%;opacity:0;}}`;
    fxEls += bx.map((x, i) => `<span class="blood" style="left:${x}%;animation-delay:${(i * 0.5).toFixed(2)}s;"></span>`).join('');
  }
  if (has('bloodrain') && !isStatic) {
    // Confetti-style burst, but blood drops raining down. Always red (blood), or
    // the fx color if one is set. Teardrop-ish droplets falling top -> bottom.
    const bc = fxCol || '#ff2a2a';
    const rx = [8, 20, 31, 44, 56, 68, 80, 90, 15, 50, 85];
    fxCss += `.brain{position:absolute;top:-12px;width:5px;height:9px;z-index:4;pointer-events:none;opacity:0;border-radius:50% 50% 50% 50%/60% 60% 42% 42%;background:linear-gradient(180deg,#5a0000,${bc});box-shadow:0 0 4px ${hexToRgba(bc, 0.5)};animation:brain 1.5s ease-in both;}@keyframes brain{0%{top:-12px;opacity:0;}12%{opacity:1;}100%{top:112%;opacity:.15;}}`;
    fxEls += rx.map((x, i) => `<span class="brain" style="left:${x}%;animation-delay:${(i * 0.09).toFixed(2)}s;"></span>`).join('');
  }

  const style = `
  .wrap{display:flex;align-items:center;justify-content:center;min-height:100%;padding:14px;box-sizing:border-box;font-family:${fontStack};}
  .cardwrap{position:relative;width:100%;}
  .card{position:relative;display:flex;flex-direction:${lay.dir};align-items:center;gap:${lay.gap}px;
    padding:${lay.pad};width:100%;box-sizing:border-box;overflow:hidden;border-radius:${theme.radius}px;
    background:${cardBg};
    ${glassBlur}
    ${!opaque && cardA < 1 ? `opacity:${cardA};` : ''}
    box-shadow:inset 0 0 0 1px ${theme.border}${glow !== 'none' ? ',' + glow : ''};
    animation:${cardAnim};}
  ${accentCss}
  ${borderCss}
  .card.out{animation:kf_out .34s ease-in forwards;}
  ${shimmerCss}
  ${borderKf}${rareGlowKf}
  .ic{display:block;width:${lay.iconSize}px;height:${lay.iconSize}px;border-radius:${Math.min(theme.radius, 8)}px;object-fit:cover;box-shadow:${theme.iconFrame};}
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
  ${iconFxCss}
  ${fxCss}
  ${isStatic ? `.cardwrap,.cardwrap *,.card,.card::before,.card::after,.icwrap::before,.icwrap::after{animation:none!important;}${rare ? `.card{box-shadow:inset 0 0 0 1px ${theme.border},0 0 26px rgba(255,197,92,0.6)!important;}` : ''}` : ''}
  `;
  const body = `<div class="wrap"><div class="cardwrap">
    <div class="card" id="card">
      ${borderEl}
      ${fxEls}
      <div class="icwrap">${iconHtml}</div>
      <div class="txt">
        <div class="eb">${esc(opts.eyebrow)}${badgeHtml}</div>
        <div class="nm">${esc(data.name)}</div>
        ${rarityHtml}
      </div>
    </div>
    ${glowlineEl}
  </div></div>`;
  return { fontImp, style, body };
}

const DOC_RESET = 'html,body{margin:0;padding:0;width:100%;min-height:100%;overflow:hidden;}';

/** Full HTML document for the popup window / preview iframe. */
export function renderToastHtml(data: ToastData, opts: ToastOptions): string {
  const { fontImp, style, body } = buildParts(data, opts);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${fontImp}${DOC_RESET}html,body{background:transparent!important;}${style}</style></head><body>${body}</body></html>`;
}

/** In-panel preview: same card on a dark backdrop so translucent themes read. */
export function renderPreviewHtml(data: ToastData, opts: ToastOptions): string {
  const { fontImp, style, body } = buildParts(data, opts);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${fontImp}${DOC_RESET}html,body{background:linear-gradient(135deg,#1b1d22,#0c0d10)!important;}${style}</style></head><body>${body}</body></html>`;
}

/** Style + markup fragment for injection into a Shadow DOM (the over-game
 *  notification body). No <html>/<body> — the host element is the container. */
export function renderCardFragment(data: ToastData, opts: ToastOptions): string {
  const { fontImp, style, body } = buildParts(data, opts, true); // opaque: backdrop-filter doesn't composite in the overlay layer
  return `<style>${fontImp}:host{display:block;}${style}</style>${body}`;
}

/** Opaque, STATIC card parts for off-screen rasterization into a PNG that the
 *  over-game overlay helper displays. Static = no motion-only effects and all
 *  animations frozen at their resting visible state (the overlay is a still
 *  image; moving effects can't composite over the game). Rendered natively via
 *  an SVG <foreignObject> (see overlay.ts) for full fidelity. `fontImp` is the
 *  @import rule, returned separately so the caller can inline the web font. */
export function renderCaptureParts(data: ToastData, opts: ToastOptions, animated = false): { fontImp: string; style: string; body: string } {
  return buildParts(data, opts, true, !animated); // opaque; static unless animated (flipbook frames)
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
      if (win) { win.document.write(renderToastHtml(data, opts)); win.document.close(); }
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
            const fh = Math.min(maxH, h + 44);
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
