"""Decky Trophy Toasts backend: serves bundled and user-picked audio files to the
frontend as data: URIs (CEF can't load raw filesystem paths in <audio>). Rarity
(global unlock %) is fetched by the frontend directly — Python's urllib can't
verify the Steam API's TLS cert on-device, but CEF can."""

import base64
import os
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

# --- Over-game overlay ---------------------------------------------------------
# A separate GTK process (bin/overlay_helper.py) draws the toast card OVER the
# running game via gamescope's GAMESCOPE_EXTERNAL_OVERLAY (same layer as the FPS
# counter). A popup created inside Steam can't do this — it only shows with the
# Steam overlay open. See overlay_helper.py for the mechanism.
_HELPER = os.path.join(_PLUGIN_DIR, "assets", "overlay_helper.py")
_OVERLAY_PNG = "/tmp/decky_trophy_overlay.png"
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
            subprocess.run(["pkill", "-f", "[o]verlay_helper.py"], check=False, timeout=3)
        except Exception:  # pylint: disable=broad-except
            pass

    async def show_overlay(self, png_b64, anchor="top-center", margin=28,
                           w=0, h=0, dur_ms=5000, anim="slide", count=1, fps=12):
        """Render the toast card OVER the running game. `png_b64` is the card as a
        base64 PNG (data: URI prefix allowed); when `count` > 1 it is a vertical
        sprite sheet of `count` frames played as a flipbook at `fps`. w/h are the
        card's logical size; the helper positions it by `anchor` within the output."""
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
                "--count", str(max(1, int(count))), "--fps", str(max(1, int(fps))),
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
