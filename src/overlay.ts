// Shows the toast card OVER the running game. A popup created inside Steam only
// shows with the Steam overlay open, so instead we rasterize the card to a PNG
// and hand it to a companion GTK process (assets/overlay_helper.py) that
// composites it above the game via gamescope's GAMESCOPE_EXTERNAL_OVERLAY (the
// FPS-counter layer). See the overgame-overlay memory / overlay_helper.py.
//
// The card is rasterized ONCE as a STATIC image (the browser's own renderer via an
// SVG <foreignObject>, so gradients, ::before/::after, inline SVG and web fonts
// render faithfully). Motion-only effects (particles, shimmer, comet) are left out
// of the image and ANIMATED by the helper in cairo at ~30fps — smooth and cheap,
// instead of a heavy multi-frame flipbook that the Deck can't render reliably.

import { call } from '@decky/api';

import { defaultAmbient, defaultFx, getFont, getTheme, resolveAccent, resolveFontStack, resolveFxColor } from './themes';
import { ToastData, ToastOptions, renderCaptureParts } from './toastWindow';

const RENDER_SCALE = 2;        // rasterization oversampling (crisp when enlarged)

// The card PNG carries the FULL effect config to the helper in a few extra bottom
// rows, so the helper can animate exactly the effects you selected (any of them),
// with no backend changes. Order/geometry must match overlay_helper.py.
const FLAG_ROWS = 4;
const FLAG_BLOCK = 6;
// One block per effect id, then one per ambient id, in this exact order.
const FX_IDS = [
  'border', 'glowline', 'edgepulse', 'edgerainbow',       // outline
  'sparkles', 'stars', 'confetti',                        // particles
  'accentbar', 'comet', 'stamp', 'glint', 'shockwave', 'flash', 'blooddrip', // flair
  'bloodrain', // particles (confetti-style blood drops) — kept last to preserve encoding
];
const AMB_IDS = ['flow', 'hue', 'pulse', 'flow-pulse', 'breathe'];
// Entrance animations, in the exact order of ANIMATIONS in themes.ts. The chosen
// one's index is encoded into the PNG so the helper plays the matching entrance.
const ANIM_IDS = [
  'slide-down', 'slide-up', 'slide-left', 'slide-right',
  'fade', 'pop', 'bounce', 'flip', 'glow-in',
];

interface IconBox { x: number; y: number; sz: number; }

/** '#rrggbb' -> [r,g,b] 0..255 (falls back to gold). */
function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
  if (!m) return [255, 207, 107];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Paint the full effect-config flags into the card PNG's extra bottom rows. */
function encodeFlags(
  ctx: CanvasRenderingContext2D, cw: number, ch: number, opts: ToastOptions, icon: IconBox,
): void {
  // Resolve exactly like the CSS does (buildParts): '' ambient = the theme's default
  // ambient, missing fx = the theme defaults. Encoding the raw '' made the overlay
  // drop the bar animation whenever the picker was on "Default".
  const theme = getTheme(opts.themeId);
  const fx = new Set(Array.isArray(opts.fx) ? opts.fx : defaultFx(theme.id, !!opts.rare));
  const amb = opts.ambient || defaultAmbient(theme.id);
  const blocks = [
    true,                               // 0: magic marker
    ...FX_IDS.map((id) => fx.has(id)),  // 1..13: effects
    ...AMB_IDS.map((id) => amb === id), // 14..18: ambient (single-select)
  ];
  void cw;
  blocks.forEach((on, i) => {
    ctx.fillStyle = on ? '#ffffff' : '#000000';
    ctx.fillRect(i * FLAG_BLOCK, ch, FLAG_BLOCK, FLAG_ROWS);
  });
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  // Both accent-gradient stops, so helper effects use the theme's exact colours
  // (never guessed) and can match the richer deep tone the rest of the card uses.
  const [accA, accB] = resolveAccent(getTheme(opts.themeId), opts.accentId);
  const [ar, ag, ab] = hexRgb(accA);
  const [br, bgc, bb] = hexRgb(accB || accA);
  // The user's "effect color" override (sparkles/stars/confetti/flash). '' = each
  // effect's own default; (0,0,0) tells the helper "unset, use defaults".
  const fxHex = resolveFxColor(opts.fxColor || '');
  const [fr, fg, fb] = fxHex ? hexRgb(fxHex) : [0, 0, 0];
  // The theme's glow colour (the CSS bar pulse / card glow use it; '' = white 0.4).
  // alpha 0 = the theme has no glow (no card box-shadow; the bar pulse uses white .4).
  const gm = theme.glow ? /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/.exec(theme.glow) : null;
  const [gr, gg, gb, ga] = gm ? [+gm[1], +gm[2], +gm[3], gm[4] != null ? +gm[4] : 1] : [255, 255, 255, 0];
  // Numeric blocks (red channel, CSS px): radius, icon x/y/size, anim, accent, fx.
  const nums = [
    Math.min(40, Math.round(getTheme(opts.themeId).radius)), // 19: corner radius
    icon.x, icon.y, icon.sz,                                 // 20,21,22: icon box
    Math.max(0, ANIM_IDS.indexOf(opts.animId)),              // 23: entrance anim
    ar, ag, ab,                                              // 24,25,26: accent A rgb
    fr, fg, fb,                                              // 27,28,29: fx color rgb
    br, bgc, bb,                                             // 30,31,32: accent B rgb
    Math.round(typeof opts.cardOpacity === 'number' ? opts.cardOpacity : 100), // 33: card opacity
    gr, gg, gb, Math.round(ga * 100),                        // 34..37: theme glow rgb + alpha%
    opts.layout === 'centered' ? 1 : 0,                      // 38: accent bar on TOP (no comet)
    opts.rare ? 1 : 0,                                       // 39: rare (shimmer + glow pulse)
  ];
  nums.forEach((val, j) => {
    ctx.fillStyle = `rgb(${clamp(val)},0,0)`;
    ctx.fillRect((blocks.length + j) * FLAG_BLOCK, ch, FLAG_BLOCK, FLAG_ROWS);
  });
}

// Over-game card size: enlarge the design, capped to a fraction of the screen.
const SCREEN_W = 1280;
const SIZE_SCALE = 1.45;
const MAX_FRACTION = 0.5;

let rendering = false;         // guard: renders are heavy; never run two at once

async function blobToDataUri(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

async function iconToDataUri(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const blob = await res.blob();
    return blob.size ? await blobToDataUri(blob) : undefined;
  } catch {
    return undefined;
  }
}

/** Google-Fonts @import -> self-contained @font-face with the files inlined. The
 *  isolated SVG <img> render can't load fonts over the network, so the font files
 *  MUST be inlined as data: URIs or the text falls back to a system font. */
async function embedFontCss(fontImp: string): Promise<string> {
  const m = /url\(['"]?([^'")]+)['"]?\)/.exec(fontImp || '');
  if (!m) return '';
  const dbg: any = { url: m[1], ok: false };
  try {
    const cssRes = await fetch(m[1]);
    if (!cssRes.ok) { dbg.cssStatus = cssRes.status; (window as any).__kttFont = dbg; return ''; }
    let css = await cssRes.text();
    const urls = Array.from(new Set(
      Array.from(css.matchAll(/url\((https:\/\/[^)]+)\)/g)).map((x) => x[1]),
    ));
    dbg.files = urls.length;
    let inlined = 0;
    for (const u of urls) {
      try {
        const fr = await fetch(u);
        if (!fr.ok) continue;
        css = css.split(u).join(await blobToDataUri(await fr.blob()));
        inlined += 1;
      } catch { /* leave as-is */ }
    }
    // Single-weight fonts (e.g. "Press Start 2P" = 400 only) otherwise render as a
    // fallback in the isolated SVG when the card asks for 700/800: no @font-face
    // matches that weight. Widen a lone weight to the full range so it always matches.
    const weights = new Set(
      Array.from(css.matchAll(/font-weight:\s*(\d+)/g)).map((x) => x[1]),
    );
    if (weights.size === 1) {
      css = css.replace(/font-weight:\s*\d+/g, 'font-weight:100 900');
    }
    dbg.inlined = inlined;
    dbg.ok = inlined > 0;
    dbg.weights = Array.from(weights);
    (window as any).__kttFont = dbg;
    return css;
  } catch (e) {
    dbg.err = String(e);
    (window as any).__kttFont = dbg;
    return '';
  }
}

function svgToImage(svg: string): Promise<HTMLImageElement> {
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error('svg image timeout')), 8000);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('svg image load failed')); };
    img.src = url;
  });
}

interface Card { png: string; w: number; h: number; }

async function renderCard(data: ToastData, opts: ToastOptions): Promise<Card | null> {
  if (rendering) {
    console.warn('[trophy-toasts] render already in progress, skipping');
    return null;
  }
  rendering = true;
  try {
    return await renderCardInner(data, opts);
  } finally {
    rendering = false;
  }
}

async function renderCardInner(data: ToastData, opts: ToastOptions): Promise<Card | null> {
  let d = data;
  if (data.icon && !/^data:/.test(data.icon)) {
    d = { ...data, icon: await iconToDataUri(data.icon) };
  }

  const { fontImp, style, body } = renderCaptureParts(d, opts); // opaque + static

  const host = document.createElement('div');
  host.style.cssText =
    `position:fixed;left:-10000px;top:0;width:${Math.round(opts.width)}px;z-index:-1;pointer-events:none;`;
  host.innerHTML = `<style>${fontImp}${style}</style>${body}`;
  document.body.appendChild(host);

  try {
    // Force the chosen web font to fully load + DECODE before we measure or
    // rasterize. Otherwise the card is sized with a fallback AND the isolated SVG
    // <img> bakes the fallback (it paints before a not-yet-decoded font is ready).
    // Load the exact weights the card uses (eyebrow 700, name 800) so single-weight
    // fonts like "Press Start 2P" (400 only) still resolve.
    if (fontImp) {
      const fam = (getFont(opts.font || '')?.stack || '').split(',')[0].trim();
      if (fam) {
        try {
          await Promise.race([
            Promise.all(['400', '600', '700', '800'].map((wt) =>
              (document as any).fonts.load(`${wt} 24px ${fam}`))),
            new Promise((r) => setTimeout(r, 3000)),
          ]);
        } catch { /* ignore */ }
      }
    }
    try { await (document as any).fonts?.ready; } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 60));
    const card = host.querySelector('#card') as HTMLElement | null;
    const cardwrap = host.querySelector('.cardwrap') as HTMLElement | null;
    if (!card || !cardwrap) return null;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    if (!w || !h) return null;

    // Measure the icon box RELATIVE to the card via getBoundingClientRect (robust:
    // doesn't depend on which ancestor is the offsetParent). The helper uses this
    // for the icon pop (stamp) and the shockwave ring origin.
    const ic = (host.querySelector('.ic') || host.querySelector('.icwrap')) as HTMLElement | null;
    let iconBox: IconBox = { x: 0, y: 0, sz: 0 };
    if (ic) {
      const cr = card.getBoundingClientRect();
      const ir = ic.getBoundingClientRect();
      iconBox = {
        x: Math.round(ir.left - cr.left),
        y: Math.round(ir.top - cr.top),
        sz: Math.round(ir.width),
      };
    }

    // Lock the card to its measured size so the opaque background fills the whole
    // frame exactly (otherwise the isolated SVG render can come out a hair shorter,
    // leaving a transparent strip / the border line sitting outside the fill).
    card.style.width = `${w}px`;
    card.style.height = `${h}px`;
    cardwrap.style.width = `${w}px`;

    const fontCss = await embedFontCss(fontImp);
    const inner = new XMLSerializer().serializeToString(cardwrap);
    // Inlined font first (reliable in the isolated SVG); keep the raw @import as a
    // last-resort fallback in case inlining failed.
    const fontBlock = fontCss || fontImp;
    // The font-family lives on `.wrap` in buildParts, but we serialize `.cardwrap`
    // (its child) — so set the family on the SVG root here or the chosen font never
    // reaches the text. Single-quote the family names to stay valid in the attr.
    const fontStack = resolveFontStack(getTheme(opts.themeId), opts.font).replace(/"/g, "'");
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<foreignObject x="0" y="0" width="${w}" height="${h}">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;font-family:${fontStack};">` +
      `<style xmlns="http://www.w3.org/1999/xhtml">${fontBlock}${style}</style>${inner}</div>` +
      `</foreignObject></svg>`;

    const img = await svgToImage(svg);
    const cw = Math.round(w * RENDER_SCALE);
    const ch = Math.round(h * RENDER_SCALE);
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch + FLAG_ROWS;   // extra rows carry the effect config to the helper
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.save();
    ctx.scale(RENDER_SCALE, RENDER_SCALE);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
    encodeFlags(ctx, cw, ch, opts, iconBox);
    return { png: canvas.toDataURL('image/png'), w, h };
  } catch (e) {
    console.error('[trophy-toasts] renderCard failed', e);
    return null;
  } finally {
    host.remove();
  }
}

const ANCHORS = new Set([
  'top-left', 'top-center', 'top-right',
  'bottom-left', 'bottom-center', 'bottom-right', 'center',
]);

function animFor(animId: string): 'slide' | 'fade' {
  return animId === 'fade' || animId === 'glow-in' ? 'fade' : 'slide';
}

function displaySize(w: number, h: number): { w: number; h: number } {
  const dispW = Math.min(Math.round(w * SIZE_SCALE), Math.round(SCREEN_W * MAX_FRACTION));
  const s = dispW / w;
  return { w: dispW, h: Math.round(h * s) };
}

async function pushOverlay(card: Card, opts: ToastOptions): Promise<boolean> {
  const anchor = ANCHORS.has(opts.position) ? opts.position : 'top-center';
  const size = displaySize(card.w, card.h);
  const res: any = await call(
    'show_overlay', card.png, anchor, 28,
    size.w, size.h, Math.max(2000, opts.durationMs), animFor(opts.animId),
  );
  if (res && res.ok === false) {
    console.error('[trophy-toasts] show_overlay backend error', res.error);
    return false;
  }
  return true;
}

/** Render + display one toast over the game. Returns false if unavailable. */
export async function showOverlay(data: ToastData, opts: ToastOptions): Promise<boolean> {
  const card = await renderCard(data, opts);
  if (!card) return false;
  try {
    if (!(await pushOverlay(card, opts))) return false;
    try { opts.onShow?.(); } catch { /* ignore */ }
    return true;
  } catch (e) {
    console.error('[trophy-toasts] show_overlay call failed', e);
    return false;
  }
}

// --- Queue: multiple unlocks show one after another, in order ---------------
interface QueueItem { data: ToastData; opts: ToastOptions; onFail?: () => void; }
const queue: QueueItem[] = [];
let processing = false;

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length) {
      const item = queue.shift() as QueueItem;
      let shown = false;
      try {
        const card = await renderCard(item.data, item.opts);
        if (card && (await pushOverlay(card, item.opts))) {
          shown = true;
          try { item.opts.onShow?.(); } catch { /* ignore */ }
          // Wait for this toast to finish (duration + a small gap) before the next.
          const hold = Math.max(2000, item.opts.durationMs) + 450;
          await new Promise((r) => setTimeout(r, hold));
        }
      } catch (e) {
        console.error('[trophy-toasts] queued toast failed', e);
      }
      if (!shown) { try { item.onFail?.(); } catch { /* ignore */ } }
    }
  } finally {
    processing = false;
  }
}

/** Enqueue a toast for over-game display; they play one at a time, in order.
 *  `onFail` runs for an item the overlay couldn't show (e.g. helper unavailable). */
export function enqueueOverlay(data: ToastData, opts: ToastOptions, onFail?: () => void): void {
  queue.push({ data, opts, onFail });
  void processQueue();
}

/** Stop the current over-game overlay. */
export async function hideOverlay(): Promise<void> {
  try { await call('hide_overlay'); } catch { /* ignore */ }
}

/** Diagnostic: render + push a sample card, reporting each stage. */
/** Test harness: the exact card PNG (with flag rows) and helper launch size that a
 *  real unlock would send over the game — WITHOUT showing anything. */
export async function renderCardDebug(data: ToastData, opts: ToastOptions): Promise<any> {
  const card = await renderCard(data, opts);
  if (!card) return null;
  const size = displaySize(card.w, card.h);
  return { png: card.png, w: size.w, h: size.h, anim: animFor(opts.animId), dur: Math.max(2000, opts.durationMs) };
}

export async function overlayDebug(data: ToastData, opts: ToastOptions): Promise<any> {
  const out: any = { stage: 'start' };
  try {
    out.stage = 'render';
    const card = await renderCard(data, opts);
    if (!card) { out.ok = false; out.stage = 'render-null'; return out; }
    const size = displaySize(card.w, card.h);
    out.natural = `${card.w}x${card.h}`;
    out.display = `${size.w}x${size.h}`;
    out.pngLen = card.png.length;
    out.stage = 'call';
    out.ok = await pushOverlay(card, opts);
    return out;
  } catch (e: any) {
    out.ok = false;
    out.error = String(e && e.message ? e.message : e);
    out.errStack = String(e && e.stack ? e.stack : '').slice(0, 800);
    return out;
  }
}
