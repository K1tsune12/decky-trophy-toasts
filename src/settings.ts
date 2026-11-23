// Settings model + persistence for Decky Achievement Toasts.
//
// Stored in localStorage: SteamUI keeps it across sessions and it avoids a
// backend round-trip for something this small.

import { defaultFx, sanitizeFx } from './themes';
import type { LookTier, Preset } from './presets';

/** A configurable sound slot (normal or rare). Empty path = use the bundled default. */
export interface SoundSlot {
  /** Play a sound for this tier at all. */
  enabled: boolean;
  /** "builtin:<id>" for a bundled sound, or an absolute file path. Empty = default. */
  path: string;
  /** Playback volume, 0..1. */
  volume: number;
}

/** Per-game override: a preset id per tier ('' / undefined = global default). */
export interface GamePreset {
  common?: string;
  rare?: string;
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
  /** How long a common toast stays on screen, milliseconds. */
  durationCommonMs: number;
  /** How long a rare toast stays on screen, milliseconds (match it to your rare sound). */
  durationRareMs: number;
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
  /** Ongoing accent color animation ('' = theme default). */
  ambientCommon: string;
  ambientRare: string;
  /** Font override id ('' = theme default). */
  fontCommon: string;
  fontRare: string;
  /** Flash + particle color override (ACCENTS id; '' = each effect's default). */
  fxColorCommon: string;
  fxColorRare: string;
  /** Enabled effect ids per tier (see themes.ts EFFECTS). */
  fxCommon: string[];
  fxRare: string[];
  /** Sound for common unlocks. */
  soundCommon: SoundSlot;
  /** Sound for rare unlocks. */
  soundRare: SoundSlot;
  /** Master volume, 0..100, scales both slots. */
  masterVolume: number;
  /** Card background opacity, 0..100 (lower = more of the game shows through). */
  bgOpacity: number;
  /** Whole-card opacity, 0..100 (fades background, text and effects together). */
  cardOpacity: number;
  /** Frosted-glass blur on the card background (preview + Steam UI; a game can't be
   *  blurred from the overlay layer, so over a game it's transparency only). */
  glass: boolean;
  /** Per-game look override: appid -> { common?, rare? } preset ids (see presets.ts). */
  gamePresets: Record<string, GamePreset>;
  /** Preset (per tier) for games WITHOUT their own preset ('' = the Personalize look). */
  defaultPreset: GamePreset;
  /** User-saved presets (per-tier or master). Built-in presets live in presets.ts. */
  customPresets: Preset[];
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
  durationCommonMs: 10000,
  durationRareMs: 11000,
  width: 500,
  position: 'top-center',
  layout: 'standard',
  themeCommon: 'kitsune-glass',
  themeRare: 'kitsune-gold',
  animCommon: 'slide-down',
  animRare: 'pop',
  accentCommon: '',
  accentRare: '',
  ambientCommon: '',
  ambientRare: '',
  fontCommon: '',
  fontRare: '',
  fxColorCommon: '',
  fxColorRare: '',
  fxCommon: defaultFx('kitsune-glass', false),
  fxRare: defaultFx('kitsune-gold', true),
  soundCommon: slot('builtin:chime'),
  soundRare: slot('builtin:marimba'),
  masterVolume: 100,
  bgOpacity: 90,
  cardOpacity: 100,
  glass: true,
  gamePresets: {},
  defaultPreset: {},
  customPresets: [],
  debug: false,
};

const STORAGE_KEY = 'achievement-toasts:settings';

type Listener = (s: AchSettings) => void;
const listeners = new Set<Listener>();
let cache: AchSettings | null = null;

function hydrate(raw: Partial<AchSettings> & { durationMs?: number }): AchSettings {
  const legacy = typeof raw.durationMs === 'number' ? raw.durationMs : undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    durationCommonMs: raw.durationCommonMs ?? legacy ?? DEFAULT_SETTINGS.durationCommonMs,
    durationRareMs: raw.durationRareMs ?? (legacy ? legacy + 1000 : DEFAULT_SETTINGS.durationRareMs),
    fxCommon: sanitizeFx(Array.isArray(raw.fxCommon) ? raw.fxCommon : DEFAULT_SETTINGS.fxCommon),
    fxRare: sanitizeFx(Array.isArray(raw.fxRare) ? raw.fxRare : DEFAULT_SETTINGS.fxRare),
    soundCommon: { ...DEFAULT_SETTINGS.soundCommon, ...(raw.soundCommon ?? {}) },
    soundRare: { ...DEFAULT_SETTINGS.soundRare, ...(raw.soundRare ?? {}) },
    gamePresets: migrateGamePresets(raw.gamePresets),
    defaultPreset: raw.defaultPreset && typeof raw.defaultPreset === 'object' ? { ...raw.defaultPreset } : {},
    customPresets: Array.isArray(raw.customPresets) ? raw.customPresets : [],
  };
}

/** Old gamePresets stored `appid -> presetId` (applied both tiers); migrate to
 *  `appid -> { common, rare }`. New-format entries pass through unchanged. */
function migrateGamePresets(raw: unknown): Record<string, GamePreset> {
  const out: Record<string, GamePreset> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [appid, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[appid] = { common: v, rare: v };
    else if (v && typeof v === 'object') {
      const g = v as GamePreset;
      out[appid] = { common: g.common || undefined, rare: g.rare || undefined };
    }
  }
  return out;
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

/** Replace everything with a restored backup (see offline.ts) and persist it. */
export function replaceSettings(raw: Partial<AchSettings>): AchSettings {
  const next = hydrate(raw || {});
  cache = next;
  persist(next);
  return next;
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

/** Assign (or clear, with '') a per-game preset for ONE tier and persist. */
export function setGamePreset(appid: number | string, tier: 'common' | 'rare', presetId: string): AchSettings {
  const cur = getSettings();
  const next = { ...cur.gamePresets };
  const key = String(appid);
  const entry: GamePreset = { ...(next[key] || {}) };
  if (presetId) entry[tier] = presetId;
  else delete entry[tier];
  if (entry.common || entry.rare) next[key] = entry;
  else delete next[key];
  return saveSettings({ gamePresets: next });
}

/** Set (or clear, with '') the default preset for ONE tier and persist. */
export function setDefaultPreset(tier: 'common' | 'rare', presetId: string): AchSettings {
  const next: GamePreset = { ...getSettings().defaultPreset };
  if (presetId) next[tier] = presetId;
  else delete next[tier];
  return saveSettings({ defaultPreset: next });
}

let presetSeq = 0;
function newPresetId(prefix: string): string {
  presetSeq += 1;
  return `${prefix}:${Date.now().toString(36)}${presetSeq}`;
}

/** Save the current look of ONE tier as a named preset. */
export function saveTierPreset(name: string, tier: 'common' | 'rare', look: LookTier): AchSettings {
  const cur = getSettings();
  const preset = { id: newPresetId(tier === 'rare' ? 'r' : 'c'), name: name.trim() || 'Preset', scope: tier, [tier]: look } as Preset;
  return saveSettings({ customPresets: [...cur.customPresets, preset] });
}

/** Save both tiers' current look as a named "master" preset. */
export function saveMasterPreset(name: string, common: LookTier, rare: LookTier): AchSettings {
  const cur = getSettings();
  const preset: Preset = { id: newPresetId('m'), name: name.trim() || 'Preset', scope: 'both', common, rare };
  return saveSettings({ customPresets: [...cur.customPresets, preset] });
}

/** Delete a saved preset and drop any per-game references to it. */
export function deleteCustomPreset(id: string): AchSettings {
  const cur = getSettings();
  const customPresets = cur.customPresets.filter((p) => p.id !== id);
  const gamePresets: Record<string, GamePreset> = {};
  for (const [appid, g] of Object.entries(cur.gamePresets)) {
    const entry: GamePreset = { common: g.common === id ? undefined : g.common, rare: g.rare === id ? undefined : g.rare };
    if (entry.common || entry.rare) gamePresets[appid] = entry;
  }
  const dp = cur.defaultPreset || {};
  const defaultPreset: GamePreset = {};
  if (dp.common && dp.common !== id) defaultPreset.common = dp.common;
  if (dp.rare && dp.rare !== id) defaultPreset.rare = dp.rare;
  return saveSettings({ customPresets, gamePresets, defaultPreset });
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
