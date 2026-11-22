// Settings model + persistence for Decky Achievement Toasts.
//
// Stored in localStorage: SteamUI keeps it across sessions and it avoids a
// backend round-trip for something this small.

/** A configurable sound slot (normal or rare). Empty path = use the bundled default. */
export interface SoundSlot {
  /** Play a sound for this tier at all. */
  enabled: boolean;
  /** "builtin:<id>" for a bundled sound, or an absolute file path. Empty = default. */
  path: string;
  /** Playback volume, 0..1. */
  volume: number;
}

export interface AchSettings {
  /** Master switch for the whole plugin (custom toasts + suppression). */
  enabled: boolean;
  /** Hide Steam's own small achievement toast + its native sound (we replace both). */
  suppressNative: boolean;
  /** Show the big toast for common achievements too (false = only rare ones). */
  showForCommon: boolean;
  /** An achievement is "rare" when its global unlock % is below this (Steam's own cutoff is 10). */
  rareThreshold: number;
  /** How long the toast stays on screen, milliseconds. */
  durationMs: number;
  /** Toast width in logical px (height adapts to content). */
  width: number;

  // --- appearance (ids reference themes.ts) ---
  /** Where on screen the toast appears. */
  position: string;
  /** Card layout/arrangement. */
  layout: string;
  /** Theme for common unlocks. */
  themeCommon: string;
  /** Theme for rare unlocks. */
  themeRare: string;
  /** Entrance effect for common unlocks. */
  animCommon: string;
  /** Entrance effect for rare unlocks. */
  animRare: string;
  /** Accent-color override id for common ('' = theme default). */
  accentCommon: string;
  /** Accent-color override id for rare ('' = theme default). */
  accentRare: string;
  /** Sound for common unlocks. */
  soundCommon: SoundSlot;
  /** Sound for rare unlocks. */
  soundRare: SoundSlot;
  /** Master volume, 0..100, scales both slots. */
  masterVolume: number;
  /** Log each achievement event to the console (calibration aid). */
  debug: boolean;
}

function slot(path: string): SoundSlot {
  return { enabled: true, path, volume: 0.7 };
}

export const DEFAULT_SETTINGS: AchSettings = {
  enabled: true,
  suppressNative: true,
  showForCommon: true,
  rareThreshold: 10,
  durationMs: 10000,
  width: 500,
  position: 'top-center',
  layout: 'standard',
  themeCommon: 'kitsune-glass',
  themeRare: 'kitsune-gold',
  animCommon: 'slide-down',
  animRare: 'pop',
  accentCommon: '',
  accentRare: '',
  soundCommon: slot('builtin:chime'),
  soundRare: slot('builtin:marimba'),
  masterVolume: 100,
  debug: false,
};

const STORAGE_KEY = 'achievement-toasts:settings';

type Listener = (s: AchSettings) => void;
const listeners = new Set<Listener>();
let cache: AchSettings | null = null;

function hydrate(raw: Partial<AchSettings>): AchSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    soundCommon: { ...DEFAULT_SETTINGS.soundCommon, ...(raw.soundCommon ?? {}) },
    soundRare: { ...DEFAULT_SETTINGS.soundRare, ...(raw.soundRare ?? {}) },
  };
}

export function getSettings(): AchSettings {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cache = raw ? hydrate(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };
  } catch {
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache;
}

export function saveSettings(patch: Partial<AchSettings>): AchSettings {
  const next = { ...getSettings(), ...patch };
  cache = next;
  persist(next);
  return next;
}

/** Update one sound slot and persist. */
export function saveSlot(which: 'soundCommon' | 'soundRare', patch: Partial<SoundSlot>): AchSettings {
  const cur = getSettings();
  const next: AchSettings = { ...cur, [which]: { ...cur[which], ...patch } };
  cache = next;
  persist(next);
  return next;
}

/** Final playback volume (0..1) for a slot volume, after the master volume. */
export function effectiveVolume(slotVolume: number): number {
  const master = getSettings().masterVolume;
  const scale = typeof master === 'number' && Number.isFinite(master) ? master / 100 : 1;
  return slotVolume * scale;
}

function persist(next: AchSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota / private-mode write failures */
  }
  listeners.forEach((l) => l(next));
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
