# Decky Trophy Toasts

Big, animated achievement-unlock toasts for the Steam Deck (and Big Picture / Game Mode).
When you unlock an achievement, this shows its own custom toast — icon, name, and how rare
it is — and plays your chosen sound. Rare achievements get extra flair.

## Features

- **Its own toast window.** Not Steam's small notification — a custom, composited window that
  can be big, positioned anywhere, animated, and themed, appearing over the game in Game Mode.
- **Rarity aware.** Uses Steam's public global unlock percentage. An achievement counts as *rare*
  below a threshold you set (default 10%, Steam's own cutoff). Rare toasts get a gold accent,
  a "RARE" badge, a gold icon frame and a shimmer.
- **Themes & layouts.** 10 themes (glass, gold, emerald, platinum, neon, violet, crimson, frost,
  minimal, retro), 4 layouts, 9 entrance effects, 6 screen positions, and a custom accent color —
  all configurable *separately for common and rare* unlocks.
- **Sounds.** Separate, configurable sounds for common and rare (bundled sounds or your own files),
  with per-sound and master volume.
- **Replaces Steam's popup.** Optionally hides Steam's small achievement toast and native sound so
  only this one shows — no doubled popup or sound.
- **Full name, always.** Long achievement names wrap to as many lines as needed; the toast sizes
  to fit. Adjustable on-screen duration, and a queue so several unlocks play one after another.
- **Languages.** English and Brazilian Portuguese, following the system language by default.

All themes are original; no game logos or artwork are included.

## Works well with the other Kitsune plugins

- **Decky Sound Toasts** — per-category notification sounds. Fully independent; when this plugin is
  active it takes over achievement sounds, so Sound Toasts won't double up.
- **Decky Position Toasts** — moves/animates Steam's *other* notification toasts. It doesn't touch
  this one (separate window), so the two never interfere.

Each plugin works on its own; install only the ones you want.

## License

BSD-3-Clause.
