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
import subprocess
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
        return {"magic": True, "fx": fx, "ambient": ambient, "radius": radius,
                "icon": icon, "anim": anim, "accent": acc, "fxcolor": fxc,
                "accentb": accb, "cardopacity": copac}
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
    p.add_argument("--count", type=int, default=1, help="frames in the vertical sprite sheet")
    p.add_argument("--fps", type=int, default=12, help="flipbook playback rate")
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
        return

    # The PNG is the static card plus a few flag rows at the bottom that carry the
    # effect config (which effects to animate). Crop those off and decode them.
    sheet_w = sheet.get_width()
    sheet_h = sheet.get_height()
    flags = read_flags(sheet, sheet_h)
    if not flags:
        flags = {"fx": {"glint", "comet"}, "ambient": "", "radius": 0, "anim": "slide-down"}
    card_src_h = max(1, sheet_h - FLAG_ROWS)
    card_w = args.w or sheet_w
    card_h = args.h or card_src_h
    card_pb = sheet.new_subpixbuf(0, 0, sheet_w, card_src_h)
    if card_w != sheet_w or card_h != card_src_h:
        card_pb = card_pb.scale_simple(card_w, card_h, GdkPixbuf.InterpType.BILINEAR)
    card0 = Gdk.cairo_surface_create_from_pixbuf(card_pb, 1, None)
    try:
        card_pb.savev("/tmp/ktt_card.png", "png", [], [])  # debug: the cropped card
    except Exception:  # noqa: BLE001  pylint: disable=broad-except
        pass
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
    # The card is rendered at RENDER_SCALE=2 (css->sheet), then shown at card_w.
    rscale = (2.0 * card_w / sheet_w) if sheet_w else 1.0
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

    screen_w = args.screen_w or screen.get_width() or 1280
    screen_h = args.screen_h or screen.get_height() or 800
    win.set_default_size(screen_w, screen_h)

    pos_x, pos_y = anchor_xy(args.anchor, args.margin, screen_w, screen_h, card_w, card_h)
    log("screen=%dx%d card=%dx%d pos=%d,%d" % (screen_w, screen_h, card_w, card_h, pos_x, pos_y))

    anim = {"start": time.monotonic()}
    enter_ms = 0 if args.anim == "none" else 460
    exit_ms = 0 if args.anim == "none" else 300
    hold_end = max(enter_ms, args.dur_ms - exit_ms)

    def ease_out(t):
        t = max(0.0, min(1.0, t))
        return 1 - (1 - t) ** 3

    def ease_out_back(t):
        t = max(0.0, min(1.0, t))
        c1 = 1.70158
        c3 = c1 + 1.0
        return 1.0 + c3 * ((t - 1) ** 3) + c1 * ((t - 1) ** 2)

    anim_id = flags.get("anim", "slide-down")

    # --- Live effects drawn in cairo at ~30fps over the static card ---
    # Effects use the real theme `accent` directly (rich/saturated); brightening it
    # toward white washed saturated colors (e.g. gold) out to a dull pale yellow.
    fxset = flags.get("fx", set())
    ambient = flags.get("ambient", "")
    glow_cache = {}   # perimeter points for the glowline (computed once)
    spark_pos = [(0.14, 0.30), (0.30, 0.70), (0.45, 0.20), (0.58, 0.76),
                 (0.70, 0.36), (0.82, 0.62), (0.90, 0.26), (0.24, 0.52)]
    star_pos = [(0.10, 0.30), (0.20, 0.68), (0.33, 0.22), (0.44, 0.78), (0.55, 0.32),
                (0.64, 0.70), (0.74, 0.26), (0.82, 0.60), (0.90, 0.40), (0.28, 0.52),
                (0.50, 0.58), (0.70, 0.46)]

    def enter_transform(el):
        """(alpha, dx, dy, sx, sy) for the selected entrance animation, matching
        the CSS @keyframes in themes.ts as closely as cairo allows."""
        if not enter_ms or el >= enter_ms:
            return 1.0, 0.0, 0.0, 1.0, 1.0
        raw = el / enter_ms
        e = ease_out(raw)
        aid = anim_id
        if aid == "fade":
            return min(1.0, raw / 0.6), 0.0, 0.0, 1.0, 1.0
        if aid == "slide-up":
            return e, 0.0, (1 - e) * 44, 1.0, 1.0
        if aid == "slide-left":
            return e, -(1 - e) * 64, 0.0, 1.0, 1.0
        if aid == "slide-right":
            return e, (1 - e) * 64, 0.0, 1.0, 1.0
        if aid == "pop":
            s = 0.82 + 0.18 * ease_out_back(raw)       # scale .82 -> 1 w/ overshoot
            return min(1.0, raw / 0.4), 0.0, 0.0, s, s
        if aid == "bounce":
            if raw < 0.6:                               # dip down + grow
                q = ease_out(raw / 0.6)
                dy = -40.0 + 48.0 * q                   # -40 -> +8
                s = 0.9 + 0.12 * q                      # .9 -> 1.02
            else:                                       # settle back
                q = ease_out((raw - 0.6) / 0.4)
                dy = 8.0 - 8.0 * q                      # +8 -> 0
                s = 1.02 - 0.02 * q                     # 1.02 -> 1
            return min(1.0, raw / 0.3), 0.0, dy, s, s
        if aid == "flip":
            sy = 0.12 + 0.88 * e                        # squashed -> full (fake rotateX)
            return e, 0.0, 0.0, 1.0, sy
        if aid == "glow-in":
            s = 1.05 - 0.05 * e                         # 1.05 -> 1 (brightness approx)
            return min(1.0, raw / 0.5), 0.0, 0.0, s, s
        return e, 0.0, -(1 - e) * 44, 1.0, 1.0          # slide-down (default)

    def exit_phase(el):
        """(alpha, dy) while exiting, else None."""
        if exit_ms and el > hold_end:
            p = ease_out((el - hold_end) / exit_ms)
            return max(0.0, 1 - p), -p * 34
        return None

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
        inset = 1.5
        w, h = card_w - 2 * inset, card_h - 2 * inset
        return inset, inset, w, h, max(0.0, min(disp_radius, w / 2.0, h / 2.0))

    # Outline group (exclusive) --------------------------------------------------
    def fx_border(_el, cr):
        x, y, w, h, r = _edge()
        if w <= 0 or h <= 0:
            return
        _rrect_path(cr, x, y, w, h, r)
        cr.set_line_width(2.2)
        cr.set_source_rgba(accent[0], accent[1], accent[2], 0.85)
        cr.stroke()

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

    def fx_edgepulse(el, cr):
        x, y, w, h, r = _edge()
        if w <= 0 or h <= 0:
            return
        a = 0.4 + 0.55 * (0.5 + 0.5 * math.sin(el / 1000.0 * (2 * math.pi / 1.9)))  # epulse 1.9s
        _rrect_path(cr, x, y, w, h, r)
        cr.set_line_width(4.0)
        cr.set_source_rgba(accent[0], accent[1], accent[2], 0.22)
        cr.stroke()
        _rrect_path(cr, x, y, w, h, r)
        cr.set_line_width(2.4)
        cr.set_source_rgba(accent[0], accent[1], accent[2], a)
        cr.stroke()

    def fx_edgerainbow(el, cr):
        x, y, w, h, r = _edge()
        if w <= 0 or h <= 0:
            return
        rr, gg, bb = _hsv((el * 0.09) % 360.0, 0.75, 1.0)   # erain 4s per full hue cycle
        _rrect_path(cr, x, y, w, h, r)
        cr.set_line_width(2.6)
        cr.set_source_rgba(rr, gg, bb, 0.92)
        cr.stroke()

    # Particle group (exclusive) -------------------------------------------------
    def fx_particles(el, cr, pts, speed, shape):
        # CSS sparkles/stars are warm-white by default, or the user's fx color.
        pc = fxcol if fxcol else (1.0, 0.91, 0.66)
        t = el / 1000.0
        for i, (fx, fy) in enumerate(pts):
            tw = 0.5 + 0.5 * math.sin(t * speed + i * 1.27)
            if tw < 0.12:
                continue
            cr.save()
            cr.translate(fx * card_w, fy * card_h)
            cr.set_source_rgba(pc[0], pc[1], pc[2], 0.2 + 0.7 * tw)
            if shape == "dot":                       # sparkles: small round dots
                cr.arc(0, 0, 1.6 + 2.4 * tw, 0, 2 * math.pi)
                cr.fill()
            else:                                    # stars: 4-point sparkle
                s = 2.0 + 3.4 * tw
                cr.move_to(0, -s * 1.9)
                cr.line_to(s * 0.5, 0)
                cr.line_to(0, s * 1.9)
                cr.line_to(-s * 0.5, 0)
                cr.close_path()
                cr.fill()
                cr.move_to(-s * 1.9, 0)
                cr.line_to(0, s * 0.5)
                cr.line_to(s * 1.9, 0)
                cr.line_to(0, -s * 0.5)
                cr.close_path()
                cr.fill()
            cr.restore()

    def fx_confetti(el, cr):
        cols = [fxcol] if fxcol else [(1, 0.82, 0.4), (1, 0.48, 0.1), (0.31, 0.71, 1),
                                      (0.61, 1, 0.61), (1, 0.42, 0.82), (0.78, 0.61, 1)]
        cr.save()
        cr.rectangle(0, 0, card_w, card_h)
        cr.clip()
        n = 11
        for i in range(n):
            cx = (i + 0.5) / n * card_w
            prog = (el / 1500.0 + i * 0.41) % 1.0
            cy = prog * (card_h + 20) - 10
            col = cols[i % len(cols)]
            cr.save()
            cr.translate(cx, cy)
            cr.rotate(el / 300.0 + i)
            cr.set_source_rgba(col[0], col[1], col[2], 0.9)
            cr.rectangle(-3, -4, 6, 8)
            cr.fill()
            cr.restore()
        cr.restore()

    def fx_bloodrain(el, cr):
        # Confetti-style burst, but blood drops raining down. Mirrors CSS .brain:
        # teardrop-ish droplets (dark -> red) falling top -> bottom with a slight sway.
        bc = fxcol if fxcol else (1.0, 0.16, 0.16)
        dark = (0.30, 0.0, 0.0)
        cr.save()
        cr.rectangle(0, 0, card_w, card_h)
        cr.clip()
        n = 11
        w_ = 5.0 * rscale
        drop_h = 9.0 * rscale
        for i in range(n):
            prog = (el / 1500.0 + i * 0.41) % 1.0            # continuous fall, staggered
            cx = (i + 0.5) / n * card_w + math.sin(el / 600.0 + i) * 3.0 * rscale
            cy = (prog ** 1.3) * (card_h + 24.0 * rscale) - 12.0 * rscale  # accelerating
            a = 0.9
            if prog < 0.08:
                a *= prog / 0.08
            cr.save()
            cr.translate(cx, cy)
            grad = cairo.LinearGradient(0, -drop_h / 2.0, 0, drop_h / 2.0)
            grad.add_color_stop_rgba(0.0, dark[0], dark[1], dark[2], a)
            grad.add_color_stop_rgba(1.0, bc[0], bc[1], bc[2], a)
            cr.set_source(grad)                              # locked to this translate space
            cr.scale(w_ / 2.0, drop_h / 2.0)                 # unit circle -> drop ellipse
            cr.arc(0, 0, 1.0, 0, 2 * math.pi)
            cr.fill()
            cr.restore()
        cr.restore()

    # Flair ----------------------------------------------------------------------
    def fx_comet(el, cr):
        # CSS .comet: a 5x16 capsule (white->accent) with a strong soft glow
        # (box-shadow 0 0 10px #fff, 0 0 16px accent), sliding top->bottom down the
        # left edge (comet 2.4s). Glowy + translucent, never a solid block.
        cw_ = 4.0 * rscale
        ch_ = 15.0 * rscale
        glow_r = 22.0 * rscale                                  # soft, wide glow spread
        prog = (el % 2600.0) / 2600.0                           # comet 2.6s
        cy = -18.0 * rscale + prog * (card_h + 18.0 * rscale)   # top:-18px -> 100%
        if prog < 0.14:
            a = (prog / 0.14) * 0.9
        elif prog > 0.86:
            a = max(0.0, (1.0 - prog) / 0.14) * 0.9
        else:
            a = 0.9
        cx = 1.0 * rscale + cw_ / 2.0
        cr.save()
        cr.rectangle(0, 0, bar_w + glow_r + 4.0 * rscale, card_h)   # room for the glow
        cr.clip()
        # soft, diffuse glow (the dominant look) — white core -> accent -> transparent.
        rg = cairo.RadialGradient(cx, cy, 0, cx, cy, glow_r)
        rg.add_color_stop_rgba(0.0, 1, 1, 1, 0.42 * a)
        rg.add_color_stop_rgba(0.22, accent[0], accent[1], accent[2], 0.26 * a)
        rg.add_color_stop_rgba(1.0, accent[0], accent[1], accent[2], 0.0)
        cr.set_source(rg)
        cr.paint()
        # faint translucent core (not a solid block).
        grad = cairo.LinearGradient(0, cy - ch_ / 2, 0, cy + ch_ / 2)
        grad.add_color_stop_rgba(0.0, 1, 1, 1, 0.55 * a)
        grad.add_color_stop_rgba(1.0, accent[0], accent[1], accent[2], 0.28 * a)
        cr.set_source(grad)
        _rrect_path(cr, cx - cw_ / 2, cy - ch_ / 2, cw_, ch_, cw_ / 2)
        cr.fill()
        cr.restore()

    def fx_glint(el, cr):
        # CSS .glint: an 18deg-tilted bright band, 26% card-width wide, sweeping
        # left:-35% -> 135% ONCE (glint 1.2s ease-in, .25s delay).
        if el < 250 or el > 1450:
            return
        p = (el - 250) / 1200.0
        p = p * p                                   # ease-in
        cxp = (-0.35 + p * 1.70) * card_w           # -35% -> 135%
        bandw = 0.26 * card_w
        cr.save()
        _rrect_path(cr, 0, 0, card_w, card_h, disp_radius)
        cr.clip()
        cr.translate(cxp, card_h / 2.0)
        cr.rotate(math.radians(18))
        grad = cairo.LinearGradient(-bandw / 2.0, 0, bandw / 2.0, 0)
        grad.add_color_stop_rgba(0.0, 1, 1, 1, 0.0)
        grad.add_color_stop_rgba(0.5, 1, 1, 1, 0.55)
        grad.add_color_stop_rgba(1.0, 1, 1, 1, 0.0)
        cr.set_source(grad)
        cr.rectangle(-bandw / 2.0, -card_h, bandw, card_h * 2.4)
        cr.fill()
        cr.restore()

    def fx_flash(el, cr):
        # CSS .flash: a warm radial glow over the card, 0 -> peak at 14% -> 0 (0.75s).
        if el > 750:
            return
        p = el / 750.0
        a = (p / 0.14) if p < 0.14 else max(0.0, 1.0 - (p - 0.14) / 0.86)
        a *= 0.65
        cx, cy = card_w * 0.5, card_h * 0.35
        rad = math.hypot(card_w, card_h) * 0.62
        fc = fxcol if fxcol else (1.0, 0.878, 0.588)   # fx color, else warm default
        grad = cairo.RadialGradient(cx, cy, 0, cx, cy, rad)
        grad.add_color_stop_rgba(0.0, fc[0], fc[1], fc[2], a)
        grad.add_color_stop_rgba(1.0, fc[0], fc[1], fc[2], 0.0)
        cr.save()
        _rrect_path(cr, 0, 0, card_w, card_h, disp_radius)
        cr.clip()
        cr.set_source(grad)
        cr.paint()
        cr.restore()

    def fx_shockwave(el, cr):
        # CSS .icwrap::after: a rounded-RECT outline around the icon (NOT a circle),
        # scaling 1 -> 1.8 from the icon center, opacity .7 -> 0 (shock .8s, .2s delay).
        ix, iy, isz = icon_box
        if isz <= 0 or el < 200 or el > 1000:
            return
        p = ease_out((el - 200) / 800.0)
        scale = 1.0 + 0.8 * p
        a = 0.7 * (1.0 - p)
        cx, cy = ix + isz / 2.0, iy + isz / 2.0
        side = isz * scale
        cr.save()
        _rrect_path(cr, cx - side / 2.0, cy - side / 2.0, side, side, icon_r * scale)
        cr.set_line_width(2.0)
        cr.set_source_rgba(accent[0], accent[1], accent[2], a)
        cr.stroke()
        cr.restore()

    def fx_stamp(el, cr):
        # CSS icstamp: the icon pops in (scale .4 -> 1.12 -> 1). On a baked card we
        # can only show the overshoot bump cleanly, scaling the isolated icon sprite.
        if icon_surf is None or el < 80 or el > 630:
            return
        ix, iy, isz = icon_box
        p = min(1.0, (el - 80) / 550.0)
        pop = 1.0 + 0.12 * math.sin(p * math.pi)   # 1.0 -> 1.12 -> 1.0
        cx, cy = ix + isz / 2.0, iy + isz / 2.0
        cr.save()
        cr.translate(cx, cy)
        cr.scale(pop, pop)
        cr.translate(-cx, -cy)
        cr.set_source_surface(icon_surf, ix, iy)
        cr.paint()
        cr.restore()

    def fx_blooddrip(el, cr):
        # Blood drops forming at the top edge and trickling down. Always red (blood),
        # or the fx color if one is set.
        bc = fxcol if fxcol else (1.0, 0.16, 0.16)
        dark = (0.32, 0.0, 0.0)
        xs = (0.12, 0.30, 0.50, 0.68, 0.86)
        period = 2800.0
        w_ = 4.0 * rscale
        for i, fxp in enumerate(xs):
            prog = ((el + i * 560.0) % period) / period
            if prog < 0.1:
                a = prog / 0.1
            elif prog > 0.9:
                a = max(0.0, (1.0 - prog) / 0.1)
            else:
                a = 0.95
            x = fxp * card_w
            top = -2.0 * rscale + (prog ** 1.5) * (card_h + 4.0 * rscale)  # accelerating fall
            drop_h = (16.0 if prog < 0.55 else 9.0) * rscale
            grad = cairo.LinearGradient(0, top, 0, top + drop_h)
            grad.add_color_stop_rgba(0.0, dark[0], dark[1], dark[2], a)
            grad.add_color_stop_rgba(1.0, bc[0], bc[1], bc[2], a)
            cr.save()
            cr.set_source(grad)
            _rrect_path(cr, x - w_ / 2.0, top, w_, drop_h, w_ / 2.0)
            cr.fill()
            cr.restore()

    # Ambient on the left accent bar --------------------------------------------
    def fx_bar(el, cr, mode):
        ac0, ac1, ac2 = accent                                # exact theme accent
        if mode == "pulse":
            # CSS amb_pulse: box-shadow glow 5px -> 18px pulsing OUTWARD from the bar.
            t = 0.5 + 0.5 * math.sin(el / 1000.0 * (2 * math.pi / 1.9))
            glow_w = (5.0 + 13.0 * t) * rscale
            a = 0.25 + 0.4 * t
            span = bar_w + glow_w
            cr.save()
            cr.rectangle(0, 0, span, card_h)
            cr.clip()
            grad = cairo.LinearGradient(0, 0, span, 0)
            grad.add_color_stop_rgba(0.0, ac0, ac1, ac2, a)
            grad.add_color_stop_rgba(min(0.99, bar_w / span), ac0, ac1, ac2, a * 0.85)
            grad.add_color_stop_rgba(1.0, ac0, ac1, ac2, 0.0)
            cr.set_source(grad)
            cr.mask_surface(card0, 0, 0)
            cr.restore()
            return
        cr.save()
        cr.rectangle(0, 0, bar_w, card_h)
        cr.clip()
        if mode == "hue":                                      # amb_hue 4s
            rr, gg, bb = _hsv((el * 0.09) % 360.0, 0.6, 1.0)
            cr.set_source_rgba(rr, gg, bb, 0.42)
            cr.mask_surface(card0, 0, 0)
        elif mode == "flow":                                   # amb_flow 2.6s
            cy = (el / 2600.0 % 1.0) * (card_h + 44) - 22
            grad = cairo.LinearGradient(0, cy - 24, 0, cy + 24)
            grad.add_color_stop_rgba(0.0, ac0, ac1, ac2, 0.0)
            grad.add_color_stop_rgba(0.5, 1, 1, 1, 0.6)
            grad.add_color_stop_rgba(1.0, ac0, ac1, ac2, 0.0)
            cr.set_source(grad)
            cr.mask_surface(card0, 0, 0)
        else:                                                  # amb_breathe 2.8s
            a = 0.22 + 0.33 * (0.5 + 0.5 * math.sin(el / 1000.0 * (2 * math.pi / 2.8)))
            cr.set_source_rgba(ac0, ac1, ac2, a)
            cr.mask_surface(card0, 0, 0)
        cr.restore()

    def on_draw(_widget, cr):
        cr.set_operator(1)  # SOURCE -> clear transparent
        cr.set_source_rgba(0, 0, 0, 0)
        cr.paint()
        el = (time.monotonic() - anim["start"]) * 1000.0
        ex = exit_phase(el)
        if ex is not None:
            alpha, dy = ex
            dx, sx, sy = 0.0, 1.0, 1.0
        else:
            alpha, dx, dy, sx, sy = enter_transform(el)
        if alpha <= 0:
            return False
        cr.set_operator(2)  # OVER
        cr.save()
        cr.translate(pos_x + dx, pos_y + dy)
        if sx != 1.0 or sy != 1.0:                       # scale around the card center
            lcx, lcy = card_w / 2.0, card_h / 2.0
            cr.translate(lcx, lcy)
            cr.scale(sx, sy)
            cr.translate(-lcx, -lcy)
        grouped = card_opacity < 0.999                   # fade card + effects together
        if grouped:
            cr.push_group()
        cr.set_source_surface(card0, 0, 0)
        cr.paint_with_alpha(alpha)
        # glow-in entrance also brightens the card (CSS brightness 1.8 -> 1).
        if ex is None and anim_id == "glow-in" and enter_ms and el < enter_ms:
            wash = (1.0 - ease_out(el / enter_ms)) * 0.32
            if wash > 0.01:
                cr.save()
                cr.set_source_rgba(1, 1, 1, wash)
                cr.mask_surface(card0, 0, 0)
                cr.restore()
        # Entrance one-shots (play during/just after the entrance).
        if alpha > 0.35:
            if "stamp" in fxset:
                fx_stamp(el, cr)
            if "flash" in fxset:
                fx_flash(el, cr)
            if "shockwave" in fxset:
                fx_shockwave(el, cr)
            if "glint" in fxset:
                fx_glint(el, cr)
        # Continuous effects, once the entrance has settled.
        if alpha > 0.8 and el < hold_end:
            if "edgerainbow" in fxset:
                fx_edgerainbow(el, cr)
            elif "edgepulse" in fxset:
                fx_edgepulse(el, cr)
            elif "glowline" in fxset:
                fx_glowline(el, cr)
            elif "border" in fxset:
                fx_border(el, cr)
            if "confetti" in fxset:
                fx_confetti(el, cr)
            elif "stars" in fxset:
                fx_particles(el, cr, star_pos, 2 * math.pi / 1.6, "star")
            elif "sparkles" in fxset:
                fx_particles(el, cr, spark_pos, 2 * math.pi / 1.7, "dot")
            elif "bloodrain" in fxset:
                fx_bloodrain(el, cr)
            if "comet" in fxset:
                fx_comet(el, cr)
            if "blooddrip" in fxset:
                fx_blooddrip(el, cr)
            if ambient in ("flow", "flow-pulse"):
                fx_bar(el, cr, "flow")
            if ambient in ("pulse", "flow-pulse"):
                fx_bar(el, cr, "pulse")
            if ambient == "hue":
                fx_bar(el, cr, "hue")
            if ambient == "breathe":
                fx_bar(el, cr, "breathe")
        if grouped:
            cr.pop_group_to_source()
            cr.paint_with_alpha(card_opacity)
        cr.restore()
        return False

    def _dump_frame(path, t, oneshots):
        """Debug: composite the card + effects at time t into a PNG for inspection."""
        try:
            surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, int(card_w), int(card_h))
            dc = cairo.Context(surf)
            dc.set_source_surface(card0, 0, 0)
            dc.paint()
            if oneshots and anim_id == "glow-in" and enter_ms and t < enter_ms:
                wash = (1.0 - ease_out(t / enter_ms)) * 0.32
                if wash > 0.01:
                    dc.save()
                    dc.set_source_rgba(1, 1, 1, wash)
                    dc.mask_surface(card0, 0, 0)
                    dc.restore()
            if "edgerainbow" in fxset:
                fx_edgerainbow(t, dc)
            elif "edgepulse" in fxset:
                fx_edgepulse(t, dc)
            elif "glowline" in fxset:
                fx_glowline(t, dc)
            elif "border" in fxset:
                fx_border(t, dc)
            if "confetti" in fxset:
                fx_confetti(t, dc)
            elif "stars" in fxset:
                fx_particles(t, dc, star_pos, 2 * math.pi / 1.6, "star")
            elif "sparkles" in fxset:
                fx_particles(t, dc, spark_pos, 2 * math.pi / 1.7, "dot")
            elif "bloodrain" in fxset:
                fx_bloodrain(t, dc)
            if "comet" in fxset:
                fx_comet(t, dc)
            if "blooddrip" in fxset:
                fx_blooddrip(t, dc)
            if ambient in ("flow", "flow-pulse"):
                fx_bar(t, dc, "flow")
            if ambient in ("pulse", "flow-pulse"):
                fx_bar(t, dc, "pulse")
            if ambient == "hue":
                fx_bar(t, dc, "hue")
            if ambient == "breathe":
                fx_bar(t, dc, "breathe")
            if oneshots:
                if "stamp" in fxset:
                    fx_stamp(t, dc)
                if "flash" in fxset:
                    fx_flash(t, dc)
                if "shockwave" in fxset:
                    fx_shockwave(t, dc)
                if "glint" in fxset:
                    fx_glint(t, dc)
            surf.write_to_png(path)
        except Exception:  # noqa: BLE001  pylint: disable=broad-except
            pass

    _dump_frame("/tmp/ktt_frame.png", 1500.0, False)   # hold phase
    _dump_frame("/tmp/ktt_enter.png", 330.0, True)      # entrance one-shots

    try:  # debug: glowline at several positions (verify smooth seam wrap + bloom)
        if "glowline" in fxset:
            times = (100.0, 900.0, 1700.0, 2050.0, 2250.0)
            strip = cairo.ImageSurface(cairo.FORMAT_ARGB32,
                                       int(card_w), int(card_h) * len(times) + 10 * (len(times) - 1))
            sc = cairo.Context(strip)
            for i, t in enumerate(times):
                sc.save()
                sc.translate(0, i * (card_h + 10))
                sc.set_source_surface(card0, 0, 0)
                sc.paint()
                fx_glowline(t, sc)
                sc.restore()
            strip.write_to_png("/tmp/ktt_gl.png")
    except Exception:  # noqa: BLE001  pylint: disable=broad-except
        pass

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

    def redraw():
        win.queue_draw()
        return True

    def finish():
        win.destroy()
        return False

    GLib.timeout_add(33, redraw)                 # ~30fps: keep presenting frames
    GLib.timeout_add(max(300, args.dur_ms), finish)
    log("entering main loop")
    Gtk.main()
    log("main loop exited")


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001  pylint: disable=broad-except
        log("FATAL\n" + traceback.format_exc())
