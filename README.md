<div align="center">

# 🏆 Decky Trophy Toasts

**Big, animated achievement-unlock toasts for the Steam Deck** — its own window, over the game,
with themes, effects, and extra flair for rare achievements.

![version](https://img.shields.io/github/v/release/K1tsune12/decky-trophy-toasts?color=orange&label=release)
![license](https://img.shields.io/badge/license-BSD--3--Clause-blue)
![platform](https://img.shields.io/badge/platform-Steam%20Deck%20%7C%20Big%20Picture-5c5c8a)

</div>

---

When you unlock an achievement, this shows its **own custom toast** — the achievement's icon, its
name, and how rare it is — and plays your chosen sound. Common and rare unlocks can look *and* sound
completely different. 🦊

## ✨ Features

- 🪟 **Its own toast window** — not Steam's tiny notification. A custom, composited window that can be
  big, positioned anywhere, animated, and themed — appearing **over the game** in Game Mode.
- 🎛️ **Studio with live preview** — a full settings page (open it from the panel or the ⚙️ icon next to
  the name) that **previews the toast as you tweak it**. Split into a **Visual** tab (per-tier look) and a
  **General** tab (shared settings), with a pinned preview and a **Replay** (with optional sound).
- 🎁 **Presets** — ready-made looks applied in one tap: hand-tuned combos (*Kitsune*, *Clean & Subtle*,
  *Big Party*, *Neon Arcade*) **plus one per theme**. Applied to the selected tier so you never lose the other.
- 💎 **Rarity aware** — uses Steam's public global unlock %. An achievement is *rare* below a threshold
  you set (default **10%**, Steam's own cutoff). Rare toasts get a gold accent, a **RARE** badge, a
  gold icon frame and a shimmer.
- 🎨 **Deeply customizable** — **10 themes**, **4 layouts**, **9 entrance effects**, **6 screen positions**,
  accent color, **grouped effects** (one outline + one particle style + free "flair"), and an
  **effect color** for the flash and particles — all set **separately for common and rare** unlocks.
- 🔤 **Fonts** — pick a font per tier: system stacks plus display fonts (Orbitron, Russo One, Audiowide,
  Press Start 2P, Cinzel, Nunito, Teko).
- 🎮 **Per-game presets** — give specific games their own look; everything else uses your default.
- 🔊 **Sounds** — separate, configurable sounds for common and rare (bundled sounds or your own files),
  with per-sound and master volume.
- 🔕 **Replaces Steam's popup** — optionally hides Steam's small achievement toast and native sound so
  only this one shows. No doubled popup or sound.
- 📝 **Full name, always** — long names wrap to as many lines as needed; the toast sizes to fit.
  Adjustable on-screen duration, and a **queue** so several unlocks play one after another.
- 🌍 **Languages** — English and Brazilian Portuguese, following the system language by default.

> ℹ️ **Works offline.** The display fonts ship inside the plugin (SIL OFL, see `assets/fonts/OFL.txt`) —
> nothing is requested from the network. Achievement rarity and icons are cached on disk the first
> time a game runs online, so later offline unlocks still show the real icon and rarity. Your
> settings and presets are also backed up on disk and restored if Steam's web cache is cleared.

## 🎨 Themes

Kitsune Glass · Kitsune Gold · Emerald Hero · Platinum Trophy · Arcade Neon · Royal Violet ·
Crimson Ember · Frostbite · Minimal · Retro Pixel

> All themes are original — no game logos or artwork are included.

## 📦 Install

1. Download `decky-trophy-toasts.zip` from the [latest release](https://github.com/K1tsune12/decky-trophy-toasts/releases/latest).
2. In the **Decky** menu, enable **Developer mode** (Settings → General).
3. **Install plugin from zip** → pick the downloaded file.
4. Open the plugin from the Decky menu to configure it. 🎉

## 🧩 Works great with the other Kitsune plugins

- 🔔 **Decky Sound Toasts** — per-category notification sounds. Fully independent; when this plugin is
  active it takes over achievement sounds, so Sound Toasts won't double up.
- 📍 **Decky Position Toasts** — moves/animates Steam's *other* notification toasts. It doesn't touch
  this one (separate window), so the two never interfere.

Each plugin works on its own — install only the ones you want.

## 📄 License

BSD-3-Clause.
