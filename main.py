"""Decky Trophy Toasts backend: serves bundled and user-picked audio files to the
frontend as data: URIs (CEF can't load raw filesystem paths in <audio>). Rarity
(global unlock %) is fetched by the frontend directly — Python's urllib can't
verify the Steam API's TLS cert on-device, but CEF can."""

import base64
import os

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

    async def _main(self):
        decky.logger.info("Decky Trophy Toasts backend loaded")

    async def _unload(self):
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
