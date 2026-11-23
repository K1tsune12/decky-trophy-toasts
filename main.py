"""Decky Trophy Toasts backend.

- Serves bundled / user-picked audio and the bundled display fonts to the frontend
  as data: URIs (CEF can't load raw filesystem paths), so nothing needs the network.
- Keeps small on-disk caches (achievement rarity + icons, a settings backup) so the
  toast is complete when the Deck is offline.
- Launches the over-game overlay helper.

Rarity (global unlock %) is fetched by the frontend — Python's urllib can't verify
the Steam API's TLS cert on-device, but CEF can — and cached here."""

import base64
import hashlib
import json
import os
import re
import shutil
import subprocess

import decky

# Extension -> MIME type for the audio formats CEF can play via <audio>.
_MIME = {
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/opus",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".webm": "audio/webm",
}

# Refuse absurdly large files — notification sounds are short.
_MAX_BYTES = 8 * 1024 * 1024  # 8 MiB

_PLUGIN_DIR = os.environ.get("DECKY_PLUGIN_DIR") or os.path.dirname(os.path.abspath(__file__))
_SOUND_DIR = os.path.join(_PLUGIN_DIR, "assets", "sounds")

_BUILTIN_PREFIX = "builtin:"

# Bundled display fonts (SIL OFL, see assets/fonts/OFL.txt): served inline so the
# toast never needs Google Fonts (works offline, and nothing is requested online).
_FONT_DIR = os.path.join(_PLUGIN_DIR, "assets", "fonts")
_font_css_cache = {}

# On-disk caches / backup. Runtime dir = disposable caches; settings dir = user data.
_RUNTIME_DIR = os.environ.get("DECKY_PLUGIN_RUNTIME_DIR") or os.path.join(_PLUGIN_DIR, ".runtime")
_SETTINGS_DIR = os.environ.get("DECKY_PLUGIN_SETTINGS_DIR") or os.path.join(_PLUGIN_DIR, ".settings")
_RARITY_DIR = os.path.join(_RUNTIME_DIR, "rarity")
_ICON_DIR = os.path.join(_RUNTIME_DIR, "icons")
_SETTINGS_FILE = os.path.join(_SETTINGS_DIR, "settings.json")
_MAX_ICON_CHARS = 700 * 1024          # one icon as a data: URI
_MAX_ICON_CACHE_BYTES = 48 * 1024 * 1024
_MAX_JSON_CHARS = 2 * 1024 * 1024


def _write_atomic(path: str, text: str):
    """Write text via a temp file + rename so a crash never leaves a half file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as file:
        file.write(text)
    os.replace(tmp, path)


def _icon_path(url: str) -> str:
    return os.path.join(_ICON_DIR, hashlib.sha1(url.encode("utf-8")).hexdigest() + ".txt")


def _prune_icons():
    """Keep the icon cache under its size cap (oldest files go first)."""
    try:
        files = [(e.stat().st_mtime, e.stat().st_size, e.path) for e in os.scandir(_ICON_DIR) if e.is_file()]
        total = sum(f[1] for f in files)
        if total <= _MAX_ICON_CACHE_BYTES:
            return
        for _mt, size, path in sorted(files):
            os.remove(path)
            total -= size
            if total <= _MAX_ICON_CACHE_BYTES * 0.8:
                break
    except Exception:  # pylint: disable=broad-except
        pass


def _build_font_css(font_id: str) -> str:
    """@font-face rules for a bundled font with the files inlined as data: URIs."""
    with open(os.path.join(_FONT_DIR, "fonts.json"), "r", encoding="utf-8") as file:
        manifest = json.load(file)
    font = manifest.get(font_id)
    if not font:
        return ""
    # One rule per file. A variable font is listed once per requested weight: merge
    # those into a weight RANGE. A single static weight is widened to 100..900 so the
    # card's 600/700/800 text still matches it (e.g. "Press Start 2P" is 400 only).
    by_file = {}
    for face in font["faces"]:
        entry = by_file.setdefault(face["file"], {"weights": [], "range": face["range"]})
        entry["weights"] += [int(w) for w in str(face["weight"]).split()]
    all_weights = {w for e in by_file.values() for w in e["weights"]}
    out = []
    for name, entry in by_file.items():
        if not re.fullmatch(r"[\w.-]+\.woff2", name):
            continue
        with open(os.path.join(_FONT_DIR, name), "rb") as file:
            b64 = base64.b64encode(file.read()).decode("ascii")
        lo, hi = min(entry["weights"]), max(entry["weights"])
        weight = "100 900" if len(all_weights) == 1 else (f"{lo} {hi}" if lo != hi else str(lo))
        out.append(
            "@font-face{font-family:'%s';font-style:normal;font-weight:%s;font-display:block;"
            "src:url(data:font/woff2;base64,%s) format('woff2');unicode-range:%s;}"
            % (font["family"], weight, b64, entry["range"])
        )
    return "".join(out)

# --- Over-game overlay ---------------------------------------------------------
# A separate GTK process (bin/overlay_helper.py) draws the toast card OVER the
# running game via gamescope's GAMESCOPE_EXTERNAL_OVERLAY (same layer as the FPS
# counter). A popup created inside Steam can't do this — it only shows with the
# Steam overlay open. See overlay_helper.py for the mechanism.
_HELPER = os.path.join(_PLUGIN_DIR, "assets", "overlay_helper.py")
_OVERLAY_PNG = os.path.join(os.environ.get("DECKY_PLUGIN_RUNTIME_DIR") or "/tmp", "overlay.png")
_MAX_PNG_BYTES = 6 * 1024 * 1024  # 6 MiB


def _builtin_path(sound_id: str):
    """Resolve a bundled sound id to its file path (guards against traversal)."""
    if not sound_id or "/" in sound_id or "\\" in sound_id or ".." in sound_id:
        return None
    for ext in _MIME:
        path = os.path.join(_SOUND_DIR, sound_id + ext)
        if os.path.isfile(path):
            return path
    return None


def _to_data_uri(path: str):
    """Base64-encode an audio file into a data: URI result dict."""
    ext = os.path.splitext(path)[1].lower()
    mime = _MIME.get(ext)
    if not mime:
        return {"ok": False, "error": f"unsupported extension: {ext}"}

    size = os.path.getsize(path)
    if size > _MAX_BYTES:
        return {"ok": False, "error": f"file too large ({size} bytes)"}

    with open(path, "rb") as file:
        data = file.read()
    b64 = base64.b64encode(data).decode("ascii")
    return {"ok": True, "uri": f"data:{mime};base64,{b64}"}


class Plugin:
    """Decky plugin entry point."""

    _overlay_proc = None

    async def _main(self):
        self._overlay_proc = None
        decky.logger.info("Decky Trophy Toasts backend loaded")

    async def _unload(self):
        self._kill_overlay()
        decky.logger.info("Decky Trophy Toasts backend unloaded")

    async def _uninstall(self):
        decky.logger.info("Decky Trophy Toasts uninstalled")

    async def list_builtin_sounds(self):
        """List the sounds bundled with the plugin: [{id, name}, ...]."""
        try:
            if not os.path.isdir(_SOUND_DIR):
                return []
            out = []
            for entry in sorted(os.listdir(_SOUND_DIR)):
                base, ext = os.path.splitext(entry)
                if ext.lower() in _MIME:
                    out.append({"id": base, "name": base.replace("-", " ").replace("_", " ").title()})
            return out
        except Exception as err:  # pylint: disable=broad-except
            decky.logger.exception("list_builtin_sounds failed")
            return {"error": str(err)}

    async def read_sound_data_uri(self, source: str):
        """Return an audio source as a data: URI. `source` is an absolute path
        or "builtin:<id>" for a bundled sound."""
        try:
            if source and source.startswith(_BUILTIN_PREFIX):
                path = _builtin_path(source[len(_BUILTIN_PREFIX):])
                if not path:
                    return {"ok": False, "error": "built-in sound not found"}
            else:
                path = source
                if not path or not os.path.isfile(path):
                    return {"ok": False, "error": "file not found"}
            return _to_data_uri(path)
        except Exception as err:  # pylint: disable=broad-except
            decky.logger.exception("read_sound_data_uri failed")
            return {"ok": False, "error": str(err)}

    async def get_font_css(self, font_id: str):
        """Inline @font-face CSS for a bundled display font ('' if unknown)."""
        try:
            font_id = str(font_id or "")
            if font_id not in _font_css_cache:
                _font_css_cache[font_id] = _build_font_css(font_id)
            return {"ok": True, "css": _font_css_cache[font_id]}
        except Exception as err:  # pylint: disable=broad-except
            decky.logger.exception("get_font_css failed")
            return {"ok": False, "error": str(err)}

    # --- Offline caches -------------------------------------------------------
    async def rarity_put(self, appid, data: str):
        """Store an app's {achievement id: global %} map (JSON text)."""
        try:
            if not str(appid).isdigit() or len(data or "") > _MAX_JSON_CHARS:
                return {"ok": False}
            json.loads(data)
            _write_atomic(os.path.join(_RARITY_DIR, f"{int(appid)}.json"), data)
            return {"ok": True}
        except Exception as err:  # pylint: disable=broad-except
            return {"ok": False, "error": str(err)}

    async def rarity_get(self, appid):
        """Return the stored rarity map for an app (JSON text), if any."""
        try:
            path = os.path.join(_RARITY_DIR, f"{int(appid)}.json")
            if not os.path.isfile(path):
                return {"ok": False}
            with open(path, "r", encoding="utf-8") as file:
                return {"ok": True, "data": file.read()}
        except Exception as err:  # pylint: disable=broad-except
            return {"ok": False, "error": str(err)}

    async def icon_put(self, url: str, data_uri: str):
        """Cache one achievement icon (a data: URI) under its source URL."""
        try:
            if not url or not str(data_uri).startswith("data:image/") or len(data_uri) > _MAX_ICON_CHARS:
                return {"ok": False}
            _write_atomic(_icon_path(url), data_uri)
            return {"ok": True}
        except Exception as err:  # pylint: disable=broad-except
            return {"ok": False, "error": str(err)}

    async def icon_get(self, url: str):
        """Return a cached achievement icon as a data: URI, if present."""
        try:
            path = _icon_path(url or "")
            if not os.path.isfile(path):
                return {"ok": False}
            with open(path, "r", encoding="utf-8") as file:
                return {"ok": True, "uri": file.read()}
        except Exception as err:  # pylint: disable=broad-except
            return {"ok": False, "error": str(err)}

    async def icons_missing(self, urls):
        """Of the given icon URLs, return the ones not cached yet (and prune the cache)."""
        try:
            _prune_icons()
            return [u for u in (urls or []) if isinstance(u, str) and not os.path.isfile(_icon_path(u))]
        except Exception:  # pylint: disable=broad-except
            return []

    async def settings_save(self, data: str):
        """Back the settings JSON up on disk (localStorage is lost with Steam's cache)."""
        try:
            if len(data or "") > _MAX_JSON_CHARS:
                return {"ok": False}
            json.loads(data)
            _write_atomic(_SETTINGS_FILE, data)
            return {"ok": True}
        except Exception as err:  # pylint: disable=broad-except
            return {"ok": False, "error": str(err)}

    async def settings_load(self):
        """Return the settings backup (JSON text), if any."""
        try:
            if not os.path.isfile(_SETTINGS_FILE):
                return {"ok": False}
            with open(_SETTINGS_FILE, "r", encoding="utf-8") as file:
                return {"ok": True, "data": file.read()}
        except Exception as err:  # pylint: disable=broad-except
            return {"ok": False, "error": str(err)}

    # --- Over-game overlay ----------------------------------------------------
    def _launch_helper(self, args_list):
        """Launch the GTK overlay helper detached, as the `deck` user, on :0."""
        env_args = ["env", "DISPLAY=:0", "GDK_BACKEND=x11",
                    "XDG_RUNTIME_DIR=/run/user/1000", "python3", _HELPER] + args_list
        if os.geteuid() == 0 and shutil.which("runuser"):
            cmd = ["runuser", "-u", "deck", "--"] + env_args
        else:
            cmd = env_args
        return subprocess.Popen(  # pylint: disable=consider-using-with
            cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, start_new_session=True,
        )

    def _kill_overlay(self):
        """Stop a running overlay helper (and any stray ones)."""
        proc = getattr(self, "_overlay_proc", None)
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:  # pylint: disable=broad-except
                pass
        self._overlay_proc = None
        try:
            subprocess.run(["pkill", "-f", _HELPER], check=False, timeout=3)
        except Exception:  # pylint: disable=broad-except
            pass

    async def show_overlay(self, png_b64, anchor="top-center", margin=28,
                           w=0, h=0, dur_ms=5000, anim="slide"):
        """Render the toast card OVER the running game. `png_b64` is the card as a
        base64 PNG (data: URI prefix allowed). w/h are the card's display size; the
        helper positions it by `anchor` within the output."""
        try:
            if not os.path.isfile(_HELPER):
                return {"ok": False, "error": "overlay helper missing"}
            data = png_b64 or ""
            if data.strip().startswith("data:") and "," in data[:64]:
                data = data.split(",", 1)[1]
            raw = base64.b64decode(data, validate=False)
            if not raw:
                return {"ok": False, "error": "empty png"}
            if len(raw) > _MAX_PNG_BYTES:
                return {"ok": False, "error": f"png too large ({len(raw)} bytes)"}
            os.makedirs(os.path.dirname(_OVERLAY_PNG), exist_ok=True)
            with open(_OVERLAY_PNG, "wb") as file:
                file.write(raw)
            os.chmod(_OVERLAY_PNG, 0o644)  # readable by the deck user
            self._kill_overlay()
            anchors = ("top-left", "top-center", "top-right",
                       "bottom-left", "bottom-center", "bottom-right", "center")
            anchor = anchor if anchor in anchors else "top-center"
            anim = anim if anim in ("slide", "fade", "none") else "slide"
            args_list = [
                "--png", _OVERLAY_PNG,
                "--anchor", anchor, "--margin", str(int(margin)),
                "--w", str(int(w)), "--h", str(int(h)),
                "--dur-ms", str(int(dur_ms)), "--anim", anim,
            ]
            self._overlay_proc = self._launch_helper(args_list)
            return {"ok": True}
        except Exception as err:  # pylint: disable=broad-except
            decky.logger.exception("show_overlay failed")
            return {"ok": False, "error": str(err)}

    async def hide_overlay(self):
        """Stop the current over-game overlay immediately."""
        try:
            self._kill_overlay()
            return {"ok": True}
        except Exception as err:  # pylint: disable=broad-except
            return {"ok": False, "error": str(err)}
