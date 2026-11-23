#!/usr/bin/env python3
"""Companion overlay for Decky Trophy Toasts.

Shows a pre-rendered toast card (a transparent PNG) OVER the running game on
gamescope (Steam Deck / handhelds). A plugin popup created inside Steam is
nested in the Steam surface and only shows when the Steam overlay is open; a
*separate process* with its own top-level X window that marks itself
GAMESCOPE_EXTERNAL_OVERLAY=1 (the same mechanism mangoapp/the FPS counter uses)
is composited above the game continuously.

Key points (all validated on-device):
  * gamescope draws the external overlay from (0,0), ignoring window position, so
    the window is full-screen & transparent and the card is painted at an offset.
  * a static window is dropped after ~1-2s; we must keep presenting frames, so we
    queue a redraw on a timer (GTK add_tick_callback does NOT work here).
  * an empty input region makes the window click-through so game input is intact.

Usage:
  overlay_helper.py --png PATH --x X --y Y --w W --h H --dur-ms MS
                    [--screen-w SW] [--screen-h SH] [--anim slide|fade|none]
"""
import argparse
import math
import os
import signal
import subprocess
import sys
import time
import traceback

import cairo
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Gdk, Gtk, GdkPixbuf, GLib  # noqa: E402

_LOG = "/tmp/ktt_helper.log"
# Effect-config flags encoded in the PNG's extra bottom rows (see overlay.ts).
# Order/geometry MUST match encodeFlags() in overlay.ts.
FLAG_ROWS = 4
FLAG_BLOCK = 6
FX_IDS = ["border", "glowline", "edgepulse", "edgerainbow",
          "sparkles", "stars", "confetti",
          "accentbar", "comet", "stamp", "glint", "shockwave", "flash", "blooddrip",
          "bloodrain"]
AMB_IDS = ["flow", "hue", "pulse", "flow-pulse", "breathe"]
# Entrance animations, same order as ANIMATIONS in themes.ts / ANIM_IDS in overlay.ts.
ANIM_IDS = ["slide-down", "slide-up", "slide-left", "slide-right",
            "fade", "pop", "bounce", "flip", "glow-in"]


def read_flags(pixbuf, h):
    """Decode the enabled effects + ambient + corner radius from the flag rows."""
    try:
        nch = pixbuf.get_n_channels()
        rowstride = pixbuf.get_rowstride()
        px = pixbuf.get_pixels()
        y = h - 2

        def on(block):
            idx = y * rowstride + (block * FLAG_BLOCK + FLAG_BLOCK // 2) * nch
            return px[idx] > 128

        if not on(0):  # magic marker
            return {}
        fx = {fid for j, fid in enumerate(FX_IDS) if on(1 + j)}
        base = 1 + len(FX_IDS)
        ambient = ""
        for j, aid in enumerate(AMB_IDS):
            if on(base + j):
                ambient = aid

        def num(block):
            return px[y * rowstride + (block * FLAG_BLOCK + FLAG_BLOCK // 2) * nch]

        rblock = base + len(AMB_IDS)                  # 19: radius
        radius = num(rblock)
        icon = (num(rblock + 1), num(rblock + 2), num(rblock + 3))  # 20,21,22: x,y,size
        ai = num(rblock + 4)                          # 23: entrance anim index
        anim = ANIM_IDS[ai] if ai < len(ANIM_IDS) else "slide-down"
        acc = (num(rblock + 5), num(rblock + 6), num(rblock + 7))  # 24,25,26: accent A
        fxc = (num(rblock + 8), num(rblock + 9), num(rblock + 10))  # 27,28,29: fx color
        accb = (num(rblock + 11), num(rblock + 12), num(rblock + 13))  # 30,31,32: accent B
        copac = num(rblock + 14)                       # 33: whole-card opacity (0..100)
        glow = (num(rblock + 15), num(rblock + 16), num(rblock + 17))  # 34..36: theme glow
        glowa = num(rblock + 18)                       # 37: glow alpha (0..100)
        acctop = num(rblock + 19) > 0                  # 38: accent bar on top (centered)
        rare = num(rblock + 20) > 0                    # 39: rare tier (shimmer + glow pulse)
        layers = num(rblock + 21) > 0                  # 40: sheet = card / card-no-icon / icon
        rs = num(rblock + 22)                          # 41: render scale (sheet px per CSS px)
        return {"magic": True, "fx": fx, "ambient": ambient, "radius": radius,
                "icon": icon, "anim": anim, "accent": acc, "fxcolor": fxc,
                "accentb": accb, "cardopacity": copac, "glow": glow, "glowa": glowa,
                "acctop": acctop, "rare": rare, "layers": layers, "rs": rs}
    except Exception:  # noqa: BLE001  pylint: disable=broad-except
        return {}


def log(msg):
    """Append a diagnostic line (helper stderr is discarded by the backend)."""
    try:
        with open(_LOG, "a", encoding="utf-8") as fh:
            fh.write("%.2f %s\n" % (time.time(), msg))
    except Exception:  # noqa: BLE001  pylint: disable=broad-except
        pass


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--png", required=True)
    p.add_argument("--w", type=int, default=0, help="draw width (0 = PNG width)")
    p.add_argument("--h", type=int, default=0, help="draw height (0 = PNG height)")
    p.add_argument("--dur-ms", type=int, default=5000)
    p.add_argument("--screen-w", type=int, default=0)
    p.add_argument("--screen-h", type=int, default=0)
    p.add_argument("--anchor", default="top-center",
                   choices=["top-left", "top-center", "top-right",
                            "bottom-left", "bottom-center", "bottom-right",
                            "center"])
    p.add_argument("--margin", type=int, default=28)
    p.add_argument("--anim", default="slide", choices=["slide", "fade", "none"])
    p.add_argument("--auto-scale", type=int, default=0,
                   help="1 = scale the card by the real screen size (w/h/margin are for 1280x800)")
    p.add_argument("--dump-dir", default="", help="test harness: write frames here and exit")
    p.add_argument("--dump-times", default="", help="comma-separated ms for --dump-dir")
    return p.parse_args()


def anchor_xy(anchor, margin, sw, sh, cw, ch):
    """Compute the card's top-left (x, y) for an anchor within the screen."""
    if anchor.endswith("left"):
        x = margin
    elif anchor.endswith("right"):
        x = sw - cw - margin
    else:
        x = (sw - cw) // 2
    if anchor.startswith("bottom"):
        y = sh - ch - margin
    elif anchor == "center":
        y = (sh - ch) // 2
    else:  # top-*
        y = margin + 12  # clear the status strip
    return x, y


def rr_perimeter(x, y, w, h, r, step=3.0):
    """Densely sample a rounded-rect outline (clockwise) -> [(px,py,cumlen)], total.
    Used to draw the glowline's travelling segment as an explicit polyline that
    wraps smoothly across the start/end seam (cairo dashing on a closed path does
    not, which made the segment jump at the corner)."""
    r = max(0.0, min(r, w / 2.0, h / 2.0))
    raw = []

    def line(x0, y0, x1, y1):
        d = math.hypot(x1 - x0, y1 - y0)
        n = max(1, int(d / step))
        for i in range(n + 1):
            t = i / n
            raw.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))

    def arc(cx, cy, a0, a1):
        al = abs(a1 - a0) * r
        n = max(1, int(al / step))
        for i in range(n + 1):
            a = a0 + (a1 - a0) * i / n
            raw.append((cx + r * math.cos(a), cy + r * math.sin(a)))

    line(x + r, y, x + w - r, y)                       # top edge
    arc(x + w - r, y + r, -math.pi / 2, 0)             # top-right
    line(x + w, y + r, x + w, y + h - r)               # right edge
    arc(x + w - r, y + h - r, 0, math.pi / 2)          # bottom-right
    line(x + w - r, y + h, x + r, y + h)               # bottom edge
    arc(x + r, y + h - r, math.pi / 2, math.pi)        # bottom-left
    line(x, y + h - r, x, y + r)                        # left edge
    arc(x + r, y + r, math.pi, 1.5 * math.pi)          # top-left

    pts = []
    for (px, py) in raw:
        if pts:
            lx, ly, ll = pts[-1]
            d = math.hypot(px - lx, py - ly)
            if d < 0.01:
                continue
            pts.append((px, py, ll + d))
        else:
            pts.append((px, py, 0.0))
    total = pts[-1][2] if pts else 0.0
    return pts, total


def poly_path(cr, pts):
    """Trace a polyline (list of (x,y[,...])) as the current cairo path."""
    first = True
    for p in pts:
        if first:
            cr.move_to(p[0], p[1])
            first = False
        else:
            cr.line_to(p[0], p[1])


def window_poly(pts, total, a, seg):
    """Points of the perimeter within arc-length [a, a+seg], wrapping the seam."""
    b = a + seg
    out = []
    for (px, py, cl) in pts:
        if a <= cl <= b:
            out.append((cl, px, py))
        c2 = cl + total
        if a <= c2 <= b:
            out.append((c2, px, py))
    out.sort()
    return [(p[1], p[2]) for p in out]


def sample_accent(pixbuf):
    """Pick the accent color from the card's left-edge accent bar; fallback gold."""
    gold = (1.0, 0.81, 0.42)
    try:
        w = pixbuf.get_width()
        h = pixbuf.get_height()
        nch = pixbuf.get_n_channels()
        rowstride = pixbuf.get_rowstride()
        px = pixbuf.get_pixels()
        x = max(1, int(w * 0.012))
        for frac in (0.4, 0.5, 0.6, 0.3):
            y = int(h * frac)
            idx = y * rowstride + x * nch
            r, g, b = px[idx], px[idx + 1], px[idx + 2]
            a = px[idx + 3] if nch == 4 else 255
            if a > 170 and (r + g + b) > 130:
                return (r / 255.0, g / 255.0, b / 255.0)
        return gold
    except Exception:  # noqa: BLE001  pylint: disable=broad-except
        return gold


def set_overlay_atom(xid):
    """Mark the window as a gamescope external overlay (composited over the game)."""
    try:
        subprocess.run(
            ["xprop", "-id", hex(xid), "-f", "GAMESCOPE_EXTERNAL_OVERLAY", "32c",
             "-set", "GAMESCOPE_EXTERNAL_OVERLAY", "1"],
            check=False, timeout=5,
        )
    except Exception:  # noqa: BLE001  pylint: disable=broad-except
        pass


def main():
    args = parse_args()
    log("start png=%s anchor=%s wh=%dx%d dur=%d" % (args.png, args.anchor, args.w, args.h, args.dur_ms))
    Gtk.init(None)
    log("gtk init ok")

    try:
        sheet = GdkPixbuf.Pixbuf.new_from_file(args.png)
    except Exception as err:  # noqa: BLE001  pylint: disable=broad-except
        log("cannot load png: " + str(err))
        sys.exit(2)

    # The PNG is the static card plus a few flag rows at the bottom that carry the
    # effect config (which effects to animate). Crop those off and decode them.
    sheet_w = sheet.get_width()
    sheet_h = sheet.get_height()
    flags = read_flags(sheet, sheet_h)
    if not flags:
        flags = {"fx": {"glint", "comet"}, "ambient": "", "radius": 0, "anim": "slide-down"}
    # With the icon "pop" on, the sheet stacks three renders of the card: the full
    # card, the card WITHOUT its icon, and the icon alone on transparent — so the
    # icon can really grow in from 0.4x like the CSS does (not just bump).
    has_layers = bool(flags.get("layers", False))
    card_src_h = max(1, (sheet_h - FLAG_ROWS) // (3 if has_layers else 1))

    # Real output size. w/h/margin arrive sized for the Deck's 1280x800; on a dock or
    # a TV (--auto-scale) everything is scaled by the actual resolution so the toast
    # keeps the same relative size.
    try:
        _scr = Gdk.Screen.get_default()
        _dsw, _dsh = _scr.get_width(), _scr.get_height()
    except Exception:  # noqa: BLE001  pylint: disable=broad-except
        _dsw, _dsh = 1280, 800
    screen_w = args.screen_w or _dsw or 1280
    screen_h = args.screen_h or _dsh or 800
    ui_k = 1.0
    if args.auto_scale:
        ui_k = max(0.5, min(4.0, min(screen_w / 1280.0, screen_h / 800.0)))
    card_w = float(args.w or sheet_w) * ui_k
    card_h = float(args.h or card_src_h) * ui_k
    fit = min(1.0, (screen_w * 0.94) / card_w, (screen_h * 0.6) / card_h)   # always fits
    card_w = max(1, int(round(card_w * fit)))
    card_h = max(1, int(round(card_h * fit)))
    margin = int(round(args.margin * ui_k))

    def _layer(index):
        pb = sheet.new_subpixbuf(0, index * card_src_h, sheet_w, card_src_h)
        if card_w != sheet_w or card_h != card_src_h:
            pb = pb.scale_simple(card_w, card_h, GdkPixbuf.InterpType.BILINEAR)
        return pb

    card_pb = _layer(0)
    card0 = Gdk.cairo_surface_create_from_pixbuf(card_pb, 1, None)
    card_noicon = icon_layer = None
    if has_layers:
        try:
            card_noicon = Gdk.cairo_surface_create_from_pixbuf(_layer(1), 1, None)
            icon_layer = Gdk.cairo_surface_create_from_pixbuf(_layer(2), 1, None)
        except Exception:  # noqa: BLE001  pylint: disable=broad-except
            card_noicon = icon_layer = None
    # Use the EXACT accent color the card was styled with (encoded in the PNG), so
    # a white theme bar is never mistaken for gold. Fall back to pixel-sampling.
    _ac = flags.get("accent", (0, 0, 0))
    if _ac[0] or _ac[1] or _ac[2]:
        accent = (_ac[0] / 255.0, _ac[1] / 255.0, _ac[2] / 255.0)
    else:
        accent = sample_accent(card_pb)
    # The user's "effect color" override; None = each effect's own default color.
    _fx = flags.get("fxcolor", (0, 0, 0))
    fxcol = ((_fx[0] / 255.0, _fx[1] / 255.0, _fx[2] / 255.0)
             if (_fx[0] or _fx[1] or _fx[2]) else None)
    # Deep accent-gradient stop (richer tone the rest of the card uses); = accent
    # when not provided.
    _ab = flags.get("accentb", (0, 0, 0))
    accent_b = ((_ab[0] / 255.0, _ab[1] / 255.0, _ab[2] / 255.0)
                if (_ab[0] or _ab[1] or _ab[2]) else accent)
    # Whole-card opacity (fades card + effects together); default fully opaque.
    card_opacity = max(0.0, min(1.0, flags.get("cardopacity", 100) / 100.0))
    # Theme glow colour (CSS bar pulse uses it) and whether the accent bar sits on top
    # (the "centered" layout: 4px top bar, no comet).
    _gl = flags.get("glow", (0, 0, 0))
    if flags.get("glowa", 0) > 0:
        glow_col = (_gl[0] / 255.0, _gl[1] / 255.0, _gl[2] / 255.0)
        glow_a = flags.get("glowa", 40) / 100.0
    else:
        glow_col, glow_a = (1.0, 1.0, 1.0), 0.4      # CSS: theme.glow || white .4
    has_card_glow = flags.get("glowa", 0) > 0        # CSS: box-shadow 0 0 16px glow
    acc_top = bool(flags.get("acctop", False))
    # The sheet is rendered at `rs` px per CSS px (2, or 3 for big screens), then
    # shown at card_w: rscale = display px per CSS px.
    _rs = float(flags.get("rs", 0) or 2)
    rscale = (_rs * card_w / sheet_w) if sheet_w else 1.0
    disp_radius = flags.get("radius", 0) * rscale
    bar_w = max(2.0, 5.0 * rscale)                 # accent bar: 5px CSS
    icon_r = min(flags.get("radius", 0), 8) * rscale  # icon/shockwave corner radius
    _ic = flags.get("icon", (0, 0, 0))
    icon_box = (_ic[0] * rscale, _ic[1] * rscale, _ic[2] * rscale)  # x, y, size (display px)
    log("icon_css=%s icon_box=%s rscale=%.2f accent=%s anim=%s"
        % (_ic, tuple(round(v, 1) for v in icon_box), rscale, _ac, flags.get("anim")))

    # Isolate the achievement icon as its own sprite so the "pop" (stamp) scales
    # ONLY the icon, cleanly, instead of re-scaling a slice of the whole card.
    icon_surf = None
    _ibx, _iby, _ibsz = icon_box
    if _ibsz > 0:
        try:
            icon_surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, int(round(_ibsz)), int(round(_ibsz)))
            _isc = cairo.Context(icon_surf)
            _isc.set_source_surface(card0, -_ibx, -_iby)
            _isc.paint()
        except Exception:  # noqa: BLE001  pylint: disable=broad-except
            icon_surf = None
    log("flags=%s card=%dx%d accent=%.2f,%.2f,%.2f r=%.1f"
        % ({k: v for k, v in flags.items() if v and k != "radius"}, card_w, card_h,
           accent[0], accent[1], accent[2], disp_radius))

    win = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
    win.set_decorated(False)
    win.set_resizable(False)
    win.set_accept_focus(False)
    win.set_skip_taskbar_hint(True)
    win.set_skip_pager_hint(True)
    win.set_app_paintable(True)
    win.set_keep_above(True)

    screen = win.get_screen()
    visual = screen.get_rgba_visual()
    log("rgba_visual=%s" % (visual is not None))
    if visual is not None:
        win.set_visual(visual)

    win.set_default_size(screen_w, screen_h)

    pos_x, pos_y = anchor_xy(args.anchor, margin, screen_w, screen_h, card_w, card_h)
    log("screen=%dx%d card=%dx%d pos=%d,%d" % (screen_w, screen_h, card_w, card_h, pos_x, pos_y))

    anim = {"start": time.monotonic()}
    anim_id = flags.get("anim", "slide-down")
    fxset = flags.get("fx", set())
    ambient = flags.get("ambient", "")
    rare = bool(flags.get("rare", False))
    S = rscale                                    # display px per CSS px

    # ---------------------------------------------------------------------------
    # CSS-faithful animation engine. Every effect mirrors its CSS rule in
    # toastWindow.ts: same @keyframes, timing functions, delays, colours and sizes
    # (CSS px * S), so the over-game toast matches the in-panel preview.
    # ---------------------------------------------------------------------------
    def _bezier(p1x, p1y, p2x, p2y):
        def x_of(t):
            u = 1.0 - t
            return 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t

        def y_of(t):
            u = 1.0 - t
            return 3 * u * u * t * p1y + 3 * u * t * t * p2y + t * t * t

        def dx_of(t):
            u = 1.0 - t
            return 3 * u * u * p1x + 6 * u * t * (p2x - p1x) + 3 * t * t * (1 - p2x)

        def f(x):
            if x <= 0.0:
                return 0.0
            if x >= 1.0:
                return 1.0
            t = x
            for _ in range(8):
                d = x_of(t) - x
                if abs(d) < 1e-5:
                    return y_of(t)
                dd = dx_of(t)
                if abs(dd) < 1e-6:
                    break
                t = min(1.0, max(0.0, t - d / dd))
            lo, hi = 0.0, 1.0
            t = x
            for _ in range(30):
                if x_of(t) < x:
                    lo = t
                else:
                    hi = t
                t = (lo + hi) / 2.0
            return y_of(t)
        return f

    def LINEAR(x):
        return max(0.0, min(1.0, x))

    EASE = _bezier(0.25, 0.1, 0.25, 1.0)
    EASE_IN = _bezier(0.42, 0.0, 1.0, 1.0)
    EASE_OUT = _bezier(0.0, 0.0, 0.58, 1.0)
    EASE_IN_OUT = _bezier(0.42, 0.0, 0.58, 1.0)

    def prog(el, dur, delay=0.0, infinite=False, fill=True):
        """CSS iteration progress 0..1 at time el; None = before the delay with
        animation-fill-mode none (the element's base style applies)."""
        t = el - delay
        if t < 0:
            return 0.0 if fill else None
        if infinite:
            return (t % dur) / dur
        return min(1.0, t / dur)

    def kf(p, stops, timing):
        """One property's value at progress p. stops = [(offset, value), ...];
        the timing function applies per keyframe segment, as in CSS."""
        if p <= stops[0][0]:
            return stops[0][1]
        for (o0, v0), (o1, v1) in zip(stops, stops[1:]):
            if p <= o1:
                q = timing((p - o0) / (o1 - o0)) if o1 > o0 else 1.0
                if isinstance(v0, tuple):
                    return tuple(a + (b - a) * q for a, b in zip(v0, v1))
                return v0 + (v1 - v0) * q
        return stops[-1][1]

    def hx(h):
        h = h.lstrip("#")
        return (int(h[0:2], 16) / 255.0, int(h[2:4], 16) / 255.0, int(h[4:6], 16) / 255.0)

    # Soft (blurred) shapes: draw at 1/d scale, upscale smoothly (~gaussian blur of
    # sigma = d/2). Used for box-shadow / drop-shadow / text-shadow. Cached.
    _soft_cache = {}

    def soft(key, sigma, w, h, draw):
        sq = max(0.0, round(sigma * 2.0) / 2.0)
        ck = (key, sq)
        hit = _soft_cache.get(ck)
        if hit is not None:
            return hit
        m = int(3 * sq) + 3
        d = max(1.0, 2.0 * sq)
        sw = max(1, int((w + 2 * m) / d) + 2)
        sh = max(1, int((h + 2 * m) / d) + 2)
        surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, sw, sh)
        c = cairo.Context(surf)
        c.scale(1.0 / d, 1.0 / d)
        c.translate(m, m)
        draw(c)
        surf.flush()
        hit = (surf, d, m)
        if len(_soft_cache) > 600:
            _soft_cache.clear()
        _soft_cache[ck] = hit
        return hit

    def paint_soft(cr, st, alpha, ox=0.0, oy=0.0):
        if alpha <= 0.001:
            return
        surf, d, m = st
        cr.save()
        cr.translate(ox - m, oy - m)
        cr.scale(d, d)
        cr.set_source_surface(surf, 0, 0)
        cr.get_source().set_filter(cairo.FILTER_BILINEAR)
        cr.paint_with_alpha(min(1.0, alpha))
        cr.restore()

    def _rrect_path(cr, x, y, w, h, r):
        r = max(0.0, min(r, w / 2.0, h / 2.0))
        cr.new_sub_path()
        cr.arc(x + w - r, y + r, r, -math.pi / 2, 0)
        cr.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
        cr.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
        cr.arc(x + r, y + r, r, math.pi, 1.5 * math.pi)
        cr.close_path()

    def _hsv(hue, s, v):
        i = int(hue / 60.0) % 6
        f = hue / 60.0 - int(hue / 60.0)
        p, q, t = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
        return [(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)][i]

    def _edge():
        # CSS .edgefx rect: inset .75px, corner radius = the card radius.
        inset = 0.75 * S
        w, h = card_w - 2 * inset, card_h - 2 * inset
        return inset, inset, w, h, max(0.0, min(disp_radius, w / 2.0, h / 2.0))

    def clip_card(cr):
        _rrect_path(cr, 0, 0, card_w, card_h, disp_radius)
        cr.clip()

    # --- entrance / exit: the exact CSS @keyframes from themes.ts ---------------
    # (dur ms, timing, {prop: stops}) ; props: op, tx, ty (CSS px), s, sy, br
    ENTRANCES = {
        "slide-down": (500, _bezier(.16, 1, .3, 1), {"op": [(0, 0.0), (1, 1.0)], "ty": [(0, -44.0), (1, 0.0)]}),
        "slide-up": (500, _bezier(.16, 1, .3, 1), {"op": [(0, 0.0), (1, 1.0)], "ty": [(0, 44.0), (1, 0.0)]}),
        "slide-left": (500, _bezier(.16, 1, .3, 1), {"op": [(0, 0.0), (1, 1.0)], "tx": [(0, -70.0), (1, 0.0)]}),
        "slide-right": (500, _bezier(.16, 1, .3, 1), {"op": [(0, 0.0), (1, 1.0)], "tx": [(0, 70.0), (1, 0.0)]}),
        "fade": (450, EASE, {"op": [(0, 0.0), (1, 1.0)]}),
        "pop": (450, _bezier(.2, 1.3, .4, 1), {"op": [(0, 0.0), (1, 1.0)], "s": [(0, 0.82), (1, 1.0)]}),
        "bounce": (600, _bezier(.2, .9, .3, 1.2), {"op": [(0, 0.0), (0.6, 1.0), (1, 1.0)],
                                                   "ty": [(0, -40.0), (0.6, 8.0), (1, 0.0)],
                                                   "s": [(0, 0.9), (0.6, 1.02), (1, 1.0)]}),
        "flip": (550, _bezier(.2, 1, .3, 1), {"op": [(0, 0.0), (1, 1.0)], "rx": [(0, -80.0), (1, 0.0)]}),
        "glow-in": (550, EASE_OUT, {"op": [(0, 0.0), (1, 1.0)], "s": [(0, 1.05), (1, 1.0)],
                                    "br": [(0, 0.8), (1, 0.0)]}),
    }
    enter_on = args.anim != "none"
    exit_ms = 340.0 if enter_on else 0.0               # CSS kf_out .34s ease-in
    tm = {"hold_end": max(0.0, args.dur_ms - exit_ms), "done": False}

    def card_state(el):
        """(opacity, tx, ty, scale, rotateX deg, brightness+) of the card at time el."""
        op, tx, ty, sc, rx, br = 1.0, 0.0, 0.0, 1.0, 0.0, 0.0
        if enter_on:
            dur, timing, props = ENTRANCES.get(anim_id, ENTRANCES["slide-down"])
            p = prog(el, dur)
            if p < 1.0:
                if "op" in props:
                    op = kf(p, props["op"], timing)
                if "tx" in props:
                    tx = kf(p, props["tx"], timing) * S
                if "ty" in props:
                    ty = kf(p, props["ty"], timing) * S
                if "s" in props:
                    sc = kf(p, props["s"], timing)
                if "rx" in props:                      # perspective(600px) rotateX(..)
                    rx = kf(p, props["rx"], timing)
                if "br" in props:
                    br = max(0.0, kf(p, props["br"], timing))
        hold_end = tm["hold_end"]
        if exit_ms and el > hold_end:                  # kf_out: fade up + shrink
            q = prog(el, exit_ms, hold_end)
            op *= kf(q, [(0, 1.0), (1, 0.0)], EASE_IN)
            ty += kf(q, [(0, 0.0), (1, -22.0)], EASE_IN) * S
            sc *= kf(q, [(0, 1.0), (1, 0.98)], EASE_IN)
        return max(0.0, min(1.0, op)), tx, ty, sc, rx, br

    # --- card outer glow: CSS box-shadow (theme glow, or the rare trglow pulse) ---
    def card_shadow(cr, color, alpha, blur_css):
        if blur_css <= 0 or alpha <= 0.002:
            return
        sigma = blur_css * S / 2.0

        def draw(c):
            _rrect_path(c, 0, 0, card_w, card_h, disp_radius)
            c.set_source_rgb(*color)
            c.fill()
        st = soft(("cardshadow", color), sigma, card_w, card_h, draw)
        cr.save()
        big = 6 * sigma + 20
        cr.set_fill_rule(cairo.FILL_RULE_EVEN_ODD)     # never painted under the box
        cr.rectangle(-big, -big, card_w + 2 * big, card_h + 2 * big)
        _rrect_path(cr, 0, 0, card_w, card_h, disp_radius)
        cr.clip()
        paint_soft(cr, st, alpha)
        cr.restore()

    def fx_card_glow(el, cr):
        if rare:                                       # trglow 2.3s ease-in-out .5s infinite
            p = prog(el, 2300, 500, infinite=True, fill=False)
            if p is not None:
                s_ = kf(p, [(0, 0.0), (0.5, 1.0), (1, 0.0)], EASE_IN_OUT)
                card_shadow(cr, accent_b, 0.42 + 0.30 * s_, 14.0 + 20.0 * s_)
                return
        if has_card_glow:                              # static: box-shadow 0 0 16px glow
            card_shadow(cr, glow_col, glow_a, 16.0)

    # --- outline group ----------------------------------------------------------
    def _conic_color(u):
        # conic-gradient(A, B, A, B, A): stops at 0, 25, 50, 75, 100%
        u = u % 1.0
        seg = int(u * 4)
        f = u * 4 - seg
        c0, c1 = (accent, accent_b) if seg % 2 == 0 else (accent_b, accent)
        return tuple(a + (b - a) * f for a, b in zip(c0, c1))

    _conic = {}

    def fx_border(el, cr):
        # CSS .brd: a 2px ring (inset -1px, clipped by the card -> 1px visible inside
        # the edge) filled with a conic-gradient(A,B,A,B,A) rotating 360deg / 3.2s.
        cx, cy = card_w / 2.0, card_h / 2.0
        if "mesh" not in _conic:
            R = math.hypot(card_w, card_h)
            mp = cairo.MeshPattern()
            n = 48
            for k in range(n):
                a0, a1 = 2 * math.pi * k / n, 2 * math.pi * (k + 1) / n
                c0, c1 = _conic_color(k / float(n)), _conic_color((k + 1) / float(n))
                mp.begin_patch()
                mp.move_to(cx, cy)
                mp.line_to(cx + R * math.sin(a0), cy - R * math.cos(a0))
                mp.line_to(cx + R * math.sin(a1), cy - R * math.cos(a1))
                mp.line_to(cx, cy)
                mp.set_corner_color_rgb(0, *c0)
                mp.set_corner_color_rgb(1, *c0)
                mp.set_corner_color_rgb(2, *c1)
                mp.set_corner_color_rgb(3, *c1)
                mp.end_patch()
            _conic["mesh"] = mp
        mp = _conic["mesh"]
        ang = 2 * math.pi * prog(el, 3200, infinite=True)
        m = cairo.Matrix()
        m.translate(cx, cy)
        m.rotate(-ang)
        m.translate(-cx, -cy)
        mp.set_matrix(m)
        cr.save()
        clip_card(cr)
        _rrect_path(cr, 0.5 * S, 0.5 * S, card_w - S, card_h - S, max(0.0, disp_radius - 0.5 * S))
        cr.set_line_width(1.0 * S)
        cr.set_source(mp)
        cr.stroke()
        cr.restore()

    def _edge_soft(key, sigma, width):
        x, y, w, h, r = _edge()

        def draw(c):
            _rrect_path(c, x, y, w, h, r)
            c.set_line_width(width)
            c.set_source_rgb(1, 1, 1)
            c.stroke()
        return soft(("edge", key, round(width, 2)), sigma, card_w, card_h, draw)

    def _paint_tinted(cr, st, color, alpha):
        # paint a white soft shape tinted with `color` at `alpha`
        surf, d, m = st
        cr.save()
        cr.translate(-m, -m)
        cr.scale(d, d)
        cr.set_source_rgba(color[0], color[1], color[2], min(1.0, alpha))
        pat = cairo.SurfacePattern(surf)
        pat.set_filter(cairo.FILTER_BILINEAR)
        cr.mask(pat)
        cr.restore()

    def _edge_stroke(cr, color, alpha, width):
        x, y, w, h, r = _edge()
        _rrect_path(cr, x, y, w, h, r)
        cr.set_line_width(width)
        cr.set_source_rgba(color[0], color[1], color[2], alpha)
        cr.stroke()

    def fx_edgepulse(el, cr):
        # CSS .epulse rect: stroke accB 2.5px; epulse 1.9s ease-in-out infinite:
        # 0/100% drop-shadow(0 0 2px accB) opacity .78 ; 50% drop-shadow(0 0 6px accB)
        # drop-shadow(0 0 13px accA) opacity 1.
        p = prog(el, 1900, infinite=True)
        s_ = kf(p, [(0, 0.0), (0.5, 1.0), (1, 0.0)], EASE_IN_OUT)
        op = 0.78 + 0.22 * s_
        w = 2.5 * S
        cr.push_group()
        if s_ > 0.01:
            _paint_tinted(cr, _edge_soft("ds13", 13.0 * s_ * S / 2.0, w), accent, s_)
        _paint_tinted(cr, _edge_soft("ds2", (2.0 + 4.0 * s_) * S / 2.0, w), accent_b, 1.0)
        _edge_stroke(cr, accent_b, 1.0, w)
        cr.pop_group_to_source()
        cr.paint_with_alpha(op)

    def fx_edgerainbow(el, cr):
        # CSS .erain rect: stroke accB 2.5px, drop-shadow 4px -> 5px, hue-rotate
        # 0 -> 360deg over 4s linear (the shadow rotates too).
        p = prog(el, 4000, infinite=True)
        col = _hue_rotate(accent_b, 360.0 * p)
        w = 2.5 * S
        _paint_tinted(cr, _edge_soft("ds4", (4.0 + p) * S / 2.0, w), col, 1.0)
        _edge_stroke(cr, col, 1.0, w)

    glow_cache = {}   # perimeter points for the glowline (computed once)

    def fx_glowline(el, cr):
        x, y, w, h, r = _edge()
        if w <= 0 or h <= 0:
            return
        if "pts" not in glow_cache:
            pts, total = rr_perimeter(x, y, w, h, r)
            glow_cache["pts"] = pts
            glow_cache["total"] = total
        pts = glow_cache["pts"]
        total = glow_cache["total"]
        if total <= 0:
            return
        # Match the rest of the card's gold: the GLOW uses the deep accent stop
        # (accent_b, like CSS gbase), the bright running core uses the light stop
        # (accent, like CSS grun). Full saturation, never whitened -> vivid, not faded.
        glow = accent_b
        core = accent
        seg = total * 0.22                                 # CSS dasharray 22/78
        head = ((el % 2300.0) / 2300.0) * total            # clockwise travel (gline 2.3s)
        wpts = window_poly(pts, total, head, seg)          # wraps the seam smoothly

        # Diffuse glow via a REAL blur: draw the line into a low-res surface, then
        # scale it back up with interpolation -> a soft, spread-out light (layered
        # hard strokes always looked too solid). A thin crisp core goes on top.
        margin = 34.0
        down = 7                                            # bigger = more diffuse
        sw = max(1, int(round((card_w + 2 * margin) / down)))
        sh = max(1, int(round((card_h + 2 * margin) / down)))
        gsurf = cairo.ImageSurface(cairo.FORMAT_ARGB32, sw, sh)
        gx = cairo.Context(gsurf)
        gx.scale(1.0 / down, 1.0 / down)
        gx.translate(margin, margin)                        # card coords -> surface
        gx.set_line_join(cairo.LINE_JOIN_ROUND)
        gx.set_line_cap(cairo.LINE_CAP_ROUND)
        poly_path(gx, pts)                                  # faint continuous halo
        gx.set_line_width(7.0)
        gx.set_source_rgba(glow[0], glow[1], glow[2], 0.5)
        gx.stroke()
        if len(wpts) >= 2:                                  # brighter travelling blob
            poly_path(gx, wpts)
            gx.set_line_width(17.0)
            gx.set_source_rgba(glow[0], glow[1], glow[2], 0.85)
            gx.stroke()
            poly_path(gx, wpts)
            gx.set_line_width(6.0)
            gx.set_source_rgba(core[0], core[1], core[2], 1.0)
            gx.stroke()
        gsurf.flush()
        cr.save()
        cr.translate(-margin, -margin)
        cr.scale(down, down)
        cr.set_source_surface(gsurf, 0, 0)
        cr.get_source().set_filter(cairo.FILTER_GOOD)       # smooth upscale = blur
        cr.paint_with_alpha(0.9)
        cr.restore()

        # Thin crisp line on top so the outline itself stays defined.
        cr.save()
        cr.set_line_join(cairo.LINE_JOIN_ROUND)
        cr.set_line_cap(cairo.LINE_CAP_ROUND)
        poly_path(cr, pts)
        cr.set_line_width(1.5)
        cr.set_source_rgba(glow[0], glow[1], glow[2], 0.45)
        cr.stroke()
        if len(wpts) >= 2:
            poly_path(cr, wpts)
            cr.set_line_width(2.2)
            cr.set_source_rgba(core[0], core[1], core[2], 0.95)
            cr.stroke()
        cr.restore()

    # --- particles group --------------------------------------------------------
    def _soft_disk(color, radius, sigma):
        def draw(c):
            c.arc(radius, radius, radius, 0, 2 * math.pi)
            c.set_source_rgb(*color)
            c.fill()
        return soft(("disk", color, round(radius, 2)), sigma, 2 * radius, 2 * radius, draw)

    SPARKS = [(12, 24), (82, 16), (56, 80), (90, 66), (30, 86), (70, 38)]

    def fx_sparkles(el, cr):
        # CSS .spark: 5px dot (fx colour or #ffe9a8), box-shadow 0 0 6px g1, 0 0 10px
        # g2; twinkle 1.7s ease-in-out infinite both, delay i*.28s:
        # 0/100% opacity 0 scale .4 ; 50% opacity 1 scale 1.1.
        dot = fxcol or hx("ffe9a8")
        g1 = fxcol or hx("ffd166")
        g2, g2a = (fxcol, 0.6) if fxcol else ((1.0, 200 / 255.0, 90 / 255.0), 0.6)
        rad = 2.5 * S
        for i, (lx, ty) in enumerate(SPARKS):
            p = prog(el, 1700, i * 280, infinite=True)
            s_ = kf(p, [(0, 0.0), (0.5, 1.0), (1, 0.0)], EASE_IN_OUT)
            if s_ <= 0.01:
                continue
            sc = 0.4 + 0.7 * s_
            cx, cy = lx / 100.0 * card_w + rad, ty / 100.0 * card_h + rad
            cr.save()
            cr.translate(cx, cy)
            cr.scale(sc, sc)
            cr.translate(-rad, -rad)
            paint_soft(cr, _soft_disk(g2, rad, 5.0 * S), g2a * s_)
            paint_soft(cr, _soft_disk(g1, rad, 3.0 * S), s_)
            cr.arc(rad, rad, rad, 0, 2 * math.pi)
            cr.set_source_rgba(dot[0], dot[1], dot[2], s_)
            cr.fill()
            cr.restore()

    STARS = [(8, 30), (22, 72), (40, 16), (52, 84), (66, 28), (78, 66), (88, 20), (94, 54),
             (16, 50), (72, 48), (34, 62), (60, 74)]

    def _star_path(c, r):
        # the U+2726 four-pointed star: concave sides between 4 long points
        k = r * 0.22
        c.move_to(0, -r)
        c.curve_to(k * 0.4, -k, k, -k * 0.4, r, 0)
        c.curve_to(k, k * 0.4, k * 0.4, k, 0, r)
        c.curve_to(-k * 0.4, k, -k, k * 0.4, -r, 0)
        c.curve_to(-k, -k * 0.4, -k * 0.4, -k, 0, -r)
        c.close_path()

    def _soft_star(color, r, sigma):
        def draw(c):
            c.translate(r, r)
            _star_path(c, r)
            c.set_source_rgb(*color)
            c.fill()
        return soft(("star", color, round(r, 2)), sigma, 2 * r, 2 * r, draw)

    def fx_stars(el, cr):
        # CSS .star: the glyph ✦ 12px (fx colour or #fff3c4), text-shadow 0 0 6px g1,
        # 0 0 12px g2; startw 1.6s ease-in-out infinite both, delay i*.15s:
        # 0/100% opacity 0 scale .3 rotate 0 ; 50% opacity 1 scale 1 rotate 28deg.
        col = fxcol or hx("fff3c4")
        g1 = fxcol or hx("ffe08a")
        g2, g2a = (fxcol, 0.8) if fxcol else ((1.0, 210 / 255.0, 120 / 255.0), 0.8)
        r = 6.6 * S                                   # glyph half-height at 12px
        box_w, box_h = 11.0 * S, 12.0 * S             # glyph advance x line box
        for i, (lx, ty) in enumerate(STARS):
            p = prog(el, 1600, i * 150, infinite=True)
            s_ = kf(p, [(0, 0.0), (0.5, 1.0), (1, 0.0)], EASE_IN_OUT)
            if s_ <= 0.01:
                continue
            sc = 0.3 + 0.7 * s_
            cx = lx / 100.0 * card_w + box_w / 2.0
            cy = ty / 100.0 * card_h + box_h / 2.0
            cr.save()
            cr.translate(cx, cy)
            cr.rotate(math.radians(28.0 * s_))
            cr.scale(sc, sc)
            cr.translate(-r, -r)
            paint_soft(cr, _soft_star(g2, r, 6.0 * S), g2a * s_)
            paint_soft(cr, _soft_star(g1, r, 3.0 * S), s_)
            cr.translate(r, r)
            _star_path(cr, r)
            cr.set_source_rgba(col[0], col[1], col[2], s_)
            cr.fill()
            cr.restore()

    CONF_X = [10, 24, 38, 52, 66, 80, 92]

    def fx_confetti(el, cr):
        # CSS .conf: 6x9 pieces, ONE burst: conf 1.5s ease-in both, delay i*.07s:
        # top -10px -> 112%, rotate 0 -> 380deg, opacity 0 -> 1 (10%) -> 0.
        cols = [fxcol] if fxcol else [hx("ffd166"), hx("ff7a1a"), hx("4fb6ff"),
                                      hx("9cff9c"), hx("ff6ad0"), hx("c89cff")]
        cr.save()
        clip_card(cr)
        for i, lx in enumerate(CONF_X):
            p = prog(el, 1500, i * 70)
            op = kf(p, [(0, 0.0), (0.1, 1.0), (1, 0.0)], EASE_IN)
            if op <= 0.01:
                continue
            top = kf(p, [(0, -10.0 * S), (1, 1.12 * card_h)], EASE_IN)
            rot = kf(p, [(0, 0.0), (1, 380.0)], EASE_IN)
            col = cols[i % len(cols)]
            cr.save()
            cr.translate(lx / 100.0 * card_w + 3.0 * S, top + 4.5 * S)
            cr.rotate(math.radians(rot))
            cr.rectangle(-3.0 * S, -4.5 * S, 6.0 * S, 9.0 * S)
            cr.set_source_rgba(col[0], col[1], col[2], op)
            cr.fill()
            cr.restore()
        cr.restore()

    RAIN_X = [8, 20, 31, 44, 56, 68, 80, 90, 15, 50, 85]

    def _drop_path(c, w, h):
        # border-radius 50%/60% 60% 42% 42%: a droplet, rounder at the bottom
        rx = w / 2.0
        c.move_to(0, h * 0.6)
        c.curve_to(0, h * 0.25, rx * 0.45, 0, rx, 0)
        c.curve_to(rx * 1.55, 0, w, h * 0.25, w, h * 0.6)
        c.curve_to(w, h * 0.84, w * 0.78, h, rx, h)
        c.curve_to(w * 0.22, h, 0, h * 0.84, 0, h * 0.6)
        c.close_path()

    def fx_bloodrain(el, cr):
        # CSS .brain: 5x9 droplets, ONE burst: brain 1.5s ease-in both, delay i*.09s:
        # top -12px -> 112%, opacity 0 -> 1 (12%) -> .15; #5a0000 -> blood, glow 4px.
        bc = fxcol or hx("ff2a2a")
        dark = hx("5a0000")
        w, h = 5.0 * S, 9.0 * S
        cr.save()
        clip_card(cr)
        for i, lx in enumerate(RAIN_X):
            p = prog(el, 1500, i * 90)
            op = kf(p, [(0, 0.0), (0.12, 1.0), (1, 0.15)], EASE_IN)
            if op <= 0.01 or p >= 1.0:
                continue
            top = kf(p, [(0, -12.0 * S), (1, 1.12 * card_h)], EASE_IN)
            x = lx / 100.0 * card_w
            glow = soft(("drop", bc, round(w, 2)), 2.0 * S, w, h,
                        lambda c: (_drop_path(c, w, h), c.set_source_rgb(*bc), c.fill()))
            paint_soft(cr, glow, 0.5 * op, x, top)
            cr.save()
            cr.translate(x, top)
            g = cairo.LinearGradient(0, 0, 0, h)
            g.add_color_stop_rgba(0.0, dark[0], dark[1], dark[2], op)
            g.add_color_stop_rgba(1.0, bc[0], bc[1], bc[2], op)
            _drop_path(cr, w, h)
            cr.set_source(g)
            cr.fill()
            cr.restore()
        cr.restore()

    # --- flair -----------------------------------------------------------------
    DRIP_X = [12, 30, 50, 68, 86]

    def fx_blooddrip(el, cr):
        # CSS .blood: 4px wide, bdrip 2.8s ease-in infinite, delay i*.5s: top -2px ->
        # 100%, height 0 -> 16px (55%) -> 8px, opacity 0 -> .95 (10%) -> 0; rounded
        # bottom, #5a0000 -> blood, glow 5px.
        bc = fxcol or hx("ff2a2a")
        dark = hx("5a0000")
        w = 4.0 * S
        cr.save()
        clip_card(cr)
        for i, lx in enumerate(DRIP_X):
            p = prog(el, 2800, i * 500, infinite=True, fill=False)
            if p is None:
                continue                              # base style: height 0 (invisible)
            op = kf(p, [(0, 0.0), (0.1, 0.95), (1, 0.0)], EASE_IN)
            h = kf(p, [(0, 0.0), (0.55, 16.0), (1, 8.0)], EASE_IN) * S
            if op <= 0.01 or h <= 0.3:
                continue
            top = kf(p, [(0, -2.0 * S), (1, float(card_h))], EASE_IN)
            x = lx / 100.0 * card_w

            def shape(c, ww=w, hh=h):
                rb = min(ww / 2.0, ww * 0.6)
                c.move_to(0, 0)
                c.line_to(ww, 0)
                c.line_to(ww, max(0.0, hh - hh * 0.6))
                c.curve_to(ww, hh, 0, hh, 0, max(0.0, hh - hh * 0.6))
                c.close_path()
                return rb
            cr.save()
            cr.translate(x, top)
            glow = soft(("drip", bc, round(h, 1)), 2.5 * S, w, h,
                        lambda c: (shape(c), c.set_source_rgb(*bc), c.fill()))
            paint_soft(cr, glow, 0.6 * op)
            g = cairo.LinearGradient(0, 0, 0, h)
            g.add_color_stop_rgba(0.0, dark[0], dark[1], dark[2], op)
            g.add_color_stop_rgba(1.0, bc[0], bc[1], bc[2], op)
            shape(cr)
            cr.set_source(g)
            cr.fill()
            cr.restore()
        cr.restore()

    def fx_comet(el, cr):
        # CSS .comet: 4x15 capsule at left:-1px, white(.9) -> accB(.3), box-shadow
        # 0 0 7px accA .7, 0 0 16px accB .5, 0 0 26px accB .28; comet 2.6s ease-in-out
        # .4s infinite both: top -18px -> 100%, opacity 0 -> .9 (14%) -> .9 (86%) -> 0.
        p = prog(el, 2600, 400, infinite=True)
        op = kf(p, [(0, 0.0), (0.14, 0.9), (0.86, 0.9), (1, 0.0)], EASE_IN_OUT)
        if op <= 0.01:
            return
        top = kf(p, [(0, -18.0 * S), (1, float(card_h))], EASE_IN_OUT)
        w, h, r = 4.0 * S, 15.0 * S, 3.0 * S
        x = -1.0 * S

        def cap(c, col):
            _rrect_path(c, 0, 0, w, h, r)
            c.set_source_rgb(*col)
            c.fill()
        cr.save()
        clip_card(cr)
        cr.push_group()
        paint_soft(cr, soft(("comet", accent_b, 26), 13.0 * S, w, h, lambda c: cap(c, accent_b)), 0.28, x, top)
        paint_soft(cr, soft(("comet", accent_b, 16), 8.0 * S, w, h, lambda c: cap(c, accent_b)), 0.5, x, top)
        paint_soft(cr, soft(("comet", accent, 7), 3.5 * S, w, h, lambda c: cap(c, accent)), 0.7, x, top)
        g = cairo.LinearGradient(0, top, 0, top + h)
        g.add_color_stop_rgba(0.0, 1, 1, 1, 0.9)
        g.add_color_stop_rgba(1.0, accent_b[0], accent_b[1], accent_b[2], 0.3)
        _rrect_path(cr, x, top, w, h, r)
        cr.set_source(g)
        cr.fill()
        cr.pop_group_to_source()
        cr.paint_with_alpha(op)
        cr.restore()

    GLINT_T = EASE_IN

    def fx_glint(el, cr):
        # CSS .glint: top -20%, width 26%, height 140%, rotate(18deg), white .55 band,
        # glint 1.2s ease-in .25s both: left -35% -> 135%.
        p = prog(el, 1200, 250)
        if p <= 0.0 or p >= 1.0:
            return
        left = kf(p, [(0, -0.35), (1, 1.35)], GLINT_T)
        bw, bh = 0.26 * card_w, 1.40 * card_h
        cr.save()
        clip_card(cr)
        cr.translate((left + 0.13) * card_w, 0.5 * card_h)
        cr.rotate(math.radians(18))
        g = cairo.LinearGradient(-bw / 2.0, 0, bw / 2.0, 0)
        g.add_color_stop_rgba(0.0, 1, 1, 1, 0.0)
        g.add_color_stop_rgba(0.5, 1, 1, 1, 0.55)
        g.add_color_stop_rgba(1.0, 1, 1, 1, 0.0)
        cr.rectangle(-bw / 2.0, -bh / 2.0, bw, bh)
        cr.set_source(g)
        cr.fill()
        cr.restore()

    def fx_flash(el, cr):
        # CSS .flash: radial-gradient(circle at 50% 35%, colour .65, transparent 62%)
        # (farthest-corner circle), flashin .75s ease-out both: opacity 0 -> 1 (14%) -> 0.
        p = prog(el, 750)
        op = kf(p, [(0, 0.0), (0.14, 1.0), (1, 0.0)], EASE_OUT)
        if op <= 0.01:
            return
        fc = fxcol or (1.0, 224 / 255.0, 150 / 255.0)
        cx, cy = card_w * 0.5, card_h * 0.35
        rad = 0.62 * math.hypot(card_w * 0.5, card_h * 0.65)
        g = cairo.RadialGradient(cx, cy, 0, cx, cy, rad)
        g.add_color_stop_rgba(0.0, fc[0], fc[1], fc[2], 0.65 * op)
        g.add_color_stop_rgba(1.0, fc[0], fc[1], fc[2], 0.0)
        cr.save()
        clip_card(cr)
        cr.set_source(g)
        cr.paint()
        cr.restore()

    def fx_shimmer(el, cr):
        # Rare: .card::after 40% wide band, linear-gradient(100deg, transparent,
        # white .18, transparent), skewX(-18deg); sweep 2.6s ease-in-out .8s infinite:
        # left -60% -> 130% (0..60%), then rests off-card.
        p = prog(el, 2600, 800, infinite=True, fill=False)
        if p is None or p >= 0.6:
            return
        left = kf(p, [(0, -0.60), (0.6, 1.30)], EASE_IN_OUT)
        bw = 0.40 * card_w
        a = math.radians(100)
        dx, dy = math.sin(a), -math.cos(a)
        ln = abs(bw * dx) + abs(card_h * dy)
        cr.save()
        clip_card(cr)
        cr.translate((left + 0.20) * card_w, card_h / 2.0)
        cr.transform(cairo.Matrix(1, 0, math.tan(math.radians(-18)), 1, 0, 0))
        g = cairo.LinearGradient(-dx * ln / 2, -dy * ln / 2, dx * ln / 2, dy * ln / 2)
        g.add_color_stop_rgba(0.0, 1, 1, 1, 0.0)
        g.add_color_stop_rgba(0.5, 1, 1, 1, 0.18)
        g.add_color_stop_rgba(1.0, 1, 1, 1, 0.0)
        cr.rectangle(-bw / 2.0, -card_h / 2.0, bw, card_h)
        cr.set_source(g)
        cr.fill()
        cr.restore()

    STAMP_T = _bezier(.2, 1.5, .45, 1)
    stamp_on = "stamp" in fxset

    def icon_state(el):
        """(scale, opacity) of .icwrap — CSS icstamp .55s cubic-bezier(.2,1.5,.45,1)
        .08s both: 0% opacity 0 scale .4 ; 60% scale 1.12 ; 100% opacity 1 scale 1."""
        if not stamp_on:
            return 1.0, 1.0
        p = prog(el, 550, 80)
        if p >= 1.0:
            return 1.0, 1.0
        return (kf(p, [(0, 0.4), (0.6, 1.12), (1, 1.0)], STAMP_T),
                max(0.0, min(1.0, kf(p, [(0, 0.0), (1, 1.0)], STAMP_T))))

    def icon_scale(el):
        return icon_state(el)[0]

    def stamp_active(el):
        """True while the icon is mid-pop and we can draw it from its own layer."""
        return stamp_on and icon_layer is not None and prog(el, 550, 80) < 1.0

    def fx_stamp(el, cr):
        ix, iy, isz = icon_box
        cx, cy = ix + isz / 2.0, iy + isz / 2.0
        sc, op = icon_state(el)
        if icon_layer is not None:                    # faithful: icon grows in from .4x
            if not stamp_active(el) or op <= 0.003:
                return
            cr.save()
            cr.translate(cx, cy)
            cr.scale(sc, sc)
            cr.translate(-cx, -cy)
            cr.set_source_surface(icon_layer, 0, 0)
            cr.paint_with_alpha(op)
            cr.restore()
            return
        if icon_surf is None or sc <= 1.003:          # fallback: only the overshoot bump
            return
        cr.save()
        cr.translate(cx, cy)
        cr.scale(sc, sc)
        cr.translate(-cx, -cy)
        cr.set_source_surface(icon_surf, ix, iy)
        cr.paint()
        cr.restore()

    SHOCK_T = EASE_OUT

    def fx_shockwave(el, cr):
        # CSS .icwrap::after: the icon box, border 2px accA (inside the box), radius
        # min(radius,8); shock .8s ease-out .2s both: opacity .7 -> 0, scale 1 -> 1.8.
        ix, iy, isz = icon_box
        if isz <= 0:
            return
        p = prog(el, 800, 200)
        if p <= 0.0 or p >= 1.0:
            return
        op = kf(p, [(0, 0.7), (1, 0.0)], SHOCK_T)
        sc = kf(p, [(0, 1.0), (1, 1.8)], SHOCK_T) * icon_scale(el)   # child of .icwrap
        cx, cy = ix + isz / 2.0, iy + isz / 2.0
        cr.save()
        cr.translate(cx, cy)
        cr.scale(sc, sc)
        cr.translate(-cx, -cy)
        _rrect_path(cr, ix + S, iy + S, isz - 2 * S, isz - 2 * S, max(0.0, icon_r - S))
        cr.set_line_width(2.0 * S)
        cr.set_source_rgba(accent[0], accent[1], accent[2], op)
        cr.stroke()
        cr.restore()

    # Ambient on the accent bar: each mode mirrors its CSS keyframes exactly ---------
    def _bar_rect():
        if acc_top:                                    # centered layout: 4px top bar
            return 0.0, 0.0, float(card_w), 4.0 * rscale
        return 0.0, 0.0, bar_w, float(card_h)

    def _bar_bg():
        # Card colour right beside the bar (what shows through it when it fades).
        try:
            nch = card_pb.get_n_channels()
            rs = card_pb.get_rowstride()
            px = card_pb.get_pixels()
            _bx, _by, bw, bh = _bar_rect()
            x = int(card_w / 2) if acc_top else int(bw + 3 * rscale)
            y = int(bh + 3 * rscale) if acc_top else int(card_h / 2)
            idx = y * rs + x * nch
            return (px[idx] / 255.0, px[idx + 1] / 255.0, px[idx + 2] / 255.0)
        except Exception:  # noqa: BLE001  pylint: disable=broad-except
            return (0.04, 0.04, 0.05)

    bar_bg_col = _bar_bg()

    def _hue_rotate(c, deg):
        # The CSS filter hue-rotate() matrix (not an HSV rotation).
        a = math.radians(deg)
        co, si = math.cos(a), math.sin(a)
        r, g, b = c
        rr = ((0.213 + 0.787 * co - 0.213 * si) * r + (0.715 - 0.715 * co - 0.715 * si) * g
              + (0.072 - 0.072 * co + 0.928 * si) * b)
        gg = ((0.213 - 0.213 * co + 0.143 * si) * r + (0.715 + 0.285 * co + 0.140 * si) * g
              + (0.072 - 0.072 * co - 0.283 * si) * b)
        bb = ((0.213 - 0.213 * co - 0.787 * si) * r + (0.715 - 0.715 * co + 0.715 * si) * g
              + (0.072 + 0.928 * co + 0.072 * si) * b)
        return tuple(max(0.0, min(1.0, v)) for v in (rr, gg, bb))

    def _paint_bar(cr, src):
        bx, by, bw, bh = _bar_rect()
        cr.save()
        cr.rectangle(bx, by, bw, bh)
        cr.clip()
        cr.set_source(src)
        cr.mask_surface(card0, 0, 0)                   # keep the card's rounded corners
        cr.restore()

    def fx_bar(el, cr, mode):
        _bx, _by, bw, bh = _bar_rect()
        along = bw if acc_top else bh                  # bar length
        if mode == "pulse":
            # CSS amb_pulse: box-shadow 0 0 5px -> 18px (1.9s) in the THEME GLOW colour,
            # painted OUTSIDE the bar (never over it); the card clips it, so it shows as
            # a soft glow spilling onto the card beside the bar.
            t = 0.5 - 0.5 * math.cos(el / 1900.0 * 2 * math.pi)   # 5px at 0%, 18px at 50%
            blur = (5.0 + 13.0 * t) * rscale
            g0, g1, g2 = glow_col
            peak = glow_a * 0.5                        # a blurred shadow is ~50% at the edge
            cr.save()
            if acc_top:
                cr.rectangle(0, bh, card_w, blur)
                grad = cairo.LinearGradient(0, bh, 0, bh + blur)
            else:
                cr.rectangle(bw, 0, blur, card_h)
                grad = cairo.LinearGradient(bw, 0, bw + blur, 0)
            cr.clip()
            grad.add_color_stop_rgba(0.0, g0, g1, g2, peak)
            grad.add_color_stop_rgba(0.45, g0, g1, g2, peak * 0.37)
            grad.add_color_stop_rgba(1.0, g0, g1, g2, 0.0)
            cr.set_source(grad)
            cr.mask_surface(card0, 0, 0)
            cr.restore()
            return
        if mode == "flow":
            # CSS amb_flow: the bar's own gradient A->B->A (background-size 300%) scrolls
            # along it, 6x the bar length every 2.6s (2 full colour periods).
            period = 3.0 * along
            off = ((el / 2600.0) * 6.0 * along) % period
            if acc_top:
                grad = cairo.LinearGradient(off - period, 0, off, 0)
            else:
                grad = cairo.LinearGradient(0, off - period, 0, off)
            grad.set_extend(cairo.EXTEND_REPEAT)
            grad.add_color_stop_rgb(0.0, *accent)
            grad.add_color_stop_rgb(0.5, *accent_b)
            grad.add_color_stop_rgb(1.0, *accent)
            _paint_bar(cr, grad)
            return
        if mode == "hue":
            # CSS amb_hue: hue-rotate(0 -> 360deg) of the bar's A->B gradient over 4s.
            deg = (el / 4000.0 * 360.0) % 360.0
            c0, c1 = _hue_rotate(accent, deg), _hue_rotate(accent_b, deg)
            grad = (cairo.LinearGradient(0, 0, along, 0) if acc_top
                    else cairo.LinearGradient(0, 0, 0, along))
            grad.add_color_stop_rgb(0.0, *c0)
            grad.add_color_stop_rgb(1.0, *c1)
            _paint_bar(cr, grad)
            return
        # breathe -- CSS amb_breathe: the bar's opacity .7 <-> 1 (2.8s), so the card shows
        # through it: blend the card colour beside the bar back over it by (1 - opacity).
        op = 0.85 - 0.15 * math.cos(el / 2800.0 * 2 * math.pi)  # .7 at 0%, 1 at 50%
        cover = 1.0 - op
        if cover > 0.005:
            _paint_bar(cr, cairo.SolidPattern(bar_bg_col[0], bar_bg_col[1], bar_bg_col[2], cover))

    def draw_card(cr, el):
        """Card + every effect at time el, in the CSS paint order."""
        fx_card_glow(el, cr)                          # .card box-shadow (outside)
        popping = stamp_active(el)
        cr.set_source_surface(card_noicon if popping else card0, 0, 0)
        cr.paint()
        if "accentbar" in fxset:                      # .card::before (z auto)
            if ambient in ("flow", "flow-pulse"):
                fx_bar(el, cr, "flow")
            if ambient in ("pulse", "flow-pulse"):
                fx_bar(el, cr, "pulse")
                if icon_surf is not None and not popping:   # the icon paints above the glow
                    ix, iy, _isz = icon_box
                    cr.set_source_surface(icon_surf, ix, iy)
                    cr.paint()
            if ambient == "hue":
                fx_bar(el, cr, "hue")
            if ambient == "breathe":
                fx_bar(el, cr, "breathe")
        if "stamp" in fxset:                          # .icwrap (z auto)
            fx_stamp(el, cr)
        if "shockwave" in fxset:
            fx_shockwave(el, cr)
        if "border" in fxset:                         # .brd (z 2)
            fx_border(el, cr)
        if "comet" in fxset and not acc_top:          # z 3, DOM order
            fx_comet(el, cr)
        if "glint" in fxset:
            fx_glint(el, cr)
        if "blooddrip" in fxset:
            fx_blooddrip(el, cr)
        if rare:                                      # .card::after (z 3, last child)
            fx_shimmer(el, cr)
        if "flash" in fxset:                          # z 4, DOM order
            fx_flash(el, cr)
        if "sparkles" in fxset:
            fx_sparkles(el, cr)
        elif "stars" in fxset:
            fx_stars(el, cr)
        elif "confetti" in fxset:
            fx_confetti(el, cr)
        elif "bloodrain" in fxset:
            fx_bloodrain(el, cr)
        if "edgerainbow" in fxset:                    # .edgefx (outside the card, z 5)
            fx_edgerainbow(el, cr)
        elif "edgepulse" in fxset:
            fx_edgepulse(el, cr)
        elif "glowline" in fxset:
            fx_glowline(el, cr)

    def on_draw(_widget, cr):
        cr.set_operator(cairo.OPERATOR_SOURCE)        # clear to transparent
        cr.set_source_rgba(0, 0, 0, 0)
        cr.paint()
        render_at(cr, (time.monotonic() - anim["start"]) * 1000.0, pos_x, pos_y)
        return False

    GROUP_M = max(110.0, 90.0 * S)                    # room for outer glows

    def render_at(cr, el, ox, oy):
        """Draw the card + every effect at time el (ms), card top-left at (ox, oy).
        Shared by the live window and the --dump-dir harness, so a dumped frame is
        exactly what shows over the game. Card and effects form ONE group that takes
        the entrance/exit transform + opacity, like the CSS .card subtree."""
        op, tx, ty, sc, rx, br = card_state(el)
        if op <= 0.0:
            return
        cr.set_operator(cairo.OPERATOR_OVER)
        cr.save()
        cr.translate(ox + tx, oy + ty)
        lcx, lcy = card_w / 2.0, card_h / 2.0
        if sc != 1.0:                                 # scale around the card centre
            cr.translate(lcx, lcy)
            cr.scale(sc, sc)
            cr.translate(-lcx, -lcy)
        cr.rectangle(-GROUP_M, -GROUP_M, card_w + 2 * GROUP_M, card_h + 2 * GROUP_M)
        cr.clip()
        cr.push_group()
        draw_card(cr, el)
        grp = cr.pop_group()

        def paint_group(alpha, operator):
            cr.set_operator(operator)
            if abs(rx) < 0.05:
                cr.set_source(grp)
                cr.paint_with_alpha(alpha)
                return
            # CSS perspective(600px) rotateX(rx) about the card centre: a row at
            # height y moves to y*cos / (1 - y*sin/d) and widens by 1 / (1 - y*sin/d).
            # Paint the group in thin horizontal bands, each with its own scale, which
            # reproduces the trapezoid (true perspective, not a flat squash).
            a = math.radians(rx)
            co, si = math.cos(a), math.sin(a)
            d = 600.0 * S
            band = 2.0
            y = -GROUP_M
            while y < card_h + GROUP_M:
                yc = y + band / 2.0 - lcy
                den = 1.0 - (yc * si) / d
                if den > 0.05:
                    k = 1.0 / den
                    cr.save()
                    cr.translate(lcx, lcy + yc * co * k)
                    cr.scale(k, max(0.001, co * k))
                    cr.translate(-lcx, -(lcy + yc))
                    cr.rectangle(-GROUP_M, y - 0.6, card_w + 2 * GROUP_M, band + 1.2)
                    cr.clip()
                    cr.set_source(grp)
                    cr.paint_with_alpha(alpha)
                    cr.restore()
                y += band

        paint_group(op * card_opacity, cairo.OPERATOR_OVER)
        if br > 0.002:                                # glow-in: CSS brightness(1 + br)
            paint_group(min(1.0, op * card_opacity * br), cairo.OPERATOR_ADD)
        cr.set_operator(cairo.OPERATOR_OVER)
        cr.restore()

    # Test harness: render frames at the given times through the SAME render_at the
    # live window uses, write them as PNGs and exit without ever showing a window.
    if args.dump_dir:
        margin_px = int(GROUP_M)
        times = [float(t) for t in (args.dump_times or "300,800,1500").split(",") if t.strip()]
        os.makedirs(args.dump_dir, exist_ok=True)
        for t in times:
            surf = cairo.ImageSurface(cairo.FORMAT_ARGB32,
                                      int(card_w + 2 * margin_px), int(card_h + 2 * margin_px))
            dc = cairo.Context(surf)
            render_at(dc, t, margin_px, margin_px)
            surf.write_to_png(os.path.join(args.dump_dir, "f_%05d.png" % int(t)))
        log("dumped %d frames to %s" % (len(times), args.dump_dir))
        return

    win.connect("draw", on_draw)
    win.connect("destroy", Gtk.main_quit)

    win.realize()
    xid = win.get_window().get_xid()
    log("realized xid=%s" % hex(xid))
    set_overlay_atom(xid)

    win.move(0, 0)
    win.show_all()
    win.move(0, 0)
    set_overlay_atom(xid)
    log("shown + atom set")

    try:
        win.get_window().input_shape_combine_region(cairo.Region(), 0, 0)
    except Exception:  # noqa: BLE001  pylint: disable=broad-except
        pass

    # Only the card's region changes between frames (card + outer glow + the room the
    # entrance/exit slides through), so invalidate just that instead of the whole
    # full-screen window: far fewer pixels to clear and repaint ~30x a second.
    pad_px = int(GROUP_M + 80 * S)
    dirty = (max(0, int(pos_x - pad_px)), max(0, int(pos_y - pad_px)),
             int(card_w + 2 * pad_px), int(card_h + 2 * pad_px))

    def redraw():
        win.queue_draw_area(*dirty)
        return True

    def finish():
        if not tm["done"]:
            tm["done"] = True
            win.destroy()
        return False

    def dismiss_now():
        # SIGUSR1 from the backend: more toasts are queued -> start the exit animation
        # right away instead of sitting out the full duration.
        el = (time.monotonic() - anim["start"]) * 1000.0
        if el < tm["hold_end"]:
            tm["hold_end"] = el
            GLib.timeout_add(int(exit_ms) + 80, finish)
        return True

    try:
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGUSR1, dismiss_now)
    except Exception:  # noqa: BLE001  pylint: disable=broad-except
        pass

    GLib.timeout_add(33, redraw)                 # ~30fps: keep presenting frames
    GLib.timeout_add(max(300, args.dur_ms), finish)
    log("entering main loop")
    Gtk.main()
    log("main loop exited")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001  pylint: disable=broad-except
        log("FATAL\n" + traceback.format_exc())
        sys.exit(1)
