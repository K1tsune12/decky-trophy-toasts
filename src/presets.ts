// Presets: reusable "looks" for the toast. A preset bundles a full look (theme,
// entrance, accent, ambient animation and effects) for both tiers (common +
// rare). Built-in presets are generated from the themes in themes.ts plus a few
// hand-tuned combos. Presets can be applied as the global default, or assigned
// per game (resolved at unlock time by appid, with the default as fallback).

import { tr } from './i18n';
import { AchSettings, SoundSlot, getSettings } from './settings';
import { ToastOptions } from './toastWindow';
import { THEMES, defaultAmbient, defaultFx, sanitizeFx } from './themes';

/** A reusable look for a single tier. */
export interface LookTier {
  theme: string;
  anim: string;
  accent: string;
  ambient: string;
  font: string;
  fxColor: string;
  fx: string[];
  /** The tier's sound (file, on/off, volume). Saved presets capture it; built-ins
   *  leave it unset (= keep the global sound for that tier). */
  sound?: SoundSlot;
}

export interface Preset {
  id: string;
  name: string;
  builtin?: boolean;
  /** Which tiers this preset carries. Built-ins are 'both' (common + rare). */
  scope?: 'common' | 'rare' | 'both';
  common?: LookTier;
  rare?: LookTier;
}

function tier(theme: string, anim: string, ambient: string, fx: string[], accent = '', font = '', fxColor = ''): LookTier {
  return { theme, anim, accent, ambient, font, fxColor, fx: sanitizeFx(fx) };
}

/** Hand-tuned, multi-theme presets (shown first). */
const CURATED: Preset[] = [
  {
    id: 'kitsune-duo', name: 'Kitsune — Glass → Gold', builtin: true,
    common: tier('kitsune-glass', 'slide-down', 'flow', ['accentbar', 'stamp', 'shockwave', 'comet']),
    rare: tier('kitsune-gold', 'pop', 'pulse', ['accentbar', 'stamp', 'shockwave', 'comet', 'glint', 'flash', 'sparkles', 'glowline']),
  },
  {
    id: 'clean', name: 'Clean & Subtle', builtin: true,
    common: tier('minimal', 'fade', 'none', ['accentbar']),
    rare: tier('minimal', 'slide-down', 'breathe', ['accentbar', 'glint', 'edgepulse']),
  },
  {
    id: 'party', name: 'Big Party', builtin: true,
    common: tier('royal', 'bounce', 'flow-pulse', ['accentbar', 'stamp', 'shockwave', 'comet']),
    rare: tier('royal', 'glow-in', 'flow-pulse', ['accentbar', 'stamp', 'shockwave', 'glint', 'flash', 'confetti', 'edgerainbow']),
  },
  {
    id: 'neon', name: 'Neon Arcade', builtin: true,
    common: tier('arcade-neon', 'pop', 'hue', ['accentbar', 'stamp', 'comet', 'border'], '', 'orbitron', 'cyan'),
    rare: tier('arcade-neon', 'glow-in', 'hue', ['accentbar', 'stamp', 'shockwave', 'flash', 'sparkles', 'edgerainbow'], '', 'orbitron', 'cyan'),
  },
  {
    id: 'vampyr', name: 'Vampyr', builtin: true,
    common: tier('vampyr', 'fade', 'pulse', ['accentbar', 'stamp', 'comet', 'edgepulse'], '', 'cinzel', 'red'),
    rare: tier('vampyr', 'glow-in', 'pulse', ['accentbar', 'stamp', 'shockwave', 'comet', 'glint', 'flash', 'glowline', 'blooddrip'], '', 'cinzel', 'red'),
  },
  {
    id: 'halloween', name: 'Halloween', builtin: true,
    common: tier('halloween', 'bounce', 'pulse', ['accentbar', 'stamp', 'comet', 'blooddrip'], '', 'cinzel', 'amber'),
    rare: tier('halloween', 'glow-in', 'flow-pulse', ['accentbar', 'stamp', 'shockwave', 'comet', 'flash', 'confetti', 'edgepulse'], '', 'cinzel', 'amber'),
  },
  {
    id: 'ghost', name: 'Ghost', builtin: true,
    common: tier('ghost', 'fade', 'breathe', ['accentbar', 'stamp', 'glint'], '', '', 'white'),
    rare: tier('ghost', 'glow-in', 'breathe', ['accentbar', 'stamp', 'glint', 'sparkles', 'edgepulse'], '', '', 'white'),
  },
  {
    id: 'toxic', name: 'Toxic', builtin: true,
    common: tier('toxic', 'pop', 'pulse', ['accentbar', 'stamp', 'comet', 'sparkles'], '', '', 'green'),
    rare: tier('toxic', 'glow-in', 'flow-pulse', ['accentbar', 'stamp', 'shockwave', 'glint', 'flash', 'sparkles', 'glowline'], '', '', 'green'),
  },
  {
    id: 'frostbite', name: 'Frostbite', builtin: true,
    common: tier('frost', 'slide-down', 'breathe', ['accentbar', 'stamp', 'glint', 'sparkles'], 'cyan', '', 'cyan'),
    rare: tier('frost', 'glow-in', 'pulse', ['accentbar', 'stamp', 'shockwave', 'glint', 'flash', 'sparkles', 'edgepulse'], 'cyan', '', 'cyan'),
  },
];

/** A tasteful font pairing for a theme's generated preset ('' = theme default). */
function themeFont(id: string): string {
  switch (id) {
    case 'arcade-neon': return 'orbitron';
    case 'retro': return 'press';
    case 'royal': return 'cinzel';
    case 'emerald': return 'cinzel';
    case 'vampyr': return 'cinzel';
    case 'halloween': return 'cinzel';
    default: return '';
  }
}

/** One preset per theme, generated from its sensible defaults. */
// Themes that already have a hand-tuned preset of the same name (skip the generated
// duplicate so the list doesn't show two "Vampyr" / "Frostbite" entries).
const SIGNATURE_THEMES = new Set(['vampyr', 'halloween', 'ghost', 'toxic', 'frost']);

export function themePresets(): Preset[] {
  return THEMES.filter((th) => !SIGNATURE_THEMES.has(th.id)).map((th) => ({
    id: `theme:${th.id}`,
    name: th.name,
    builtin: true,
    common: tier(th.id, 'slide-down', defaultAmbient(th.id), defaultFx(th.id, false), '', themeFont(th.id)),
    rare: tier(th.id, 'glow-in', defaultAmbient(th.id), defaultFx(th.id, true), '', themeFont(th.id)),
  }));
}

/** Built-in presets only (curated + one per theme). */
export function builtinPresets(): Preset[] {
  return [...CURATED, ...themePresets()];
}

/** User-saved presets (per-tier or master), newest first. */
export function customPresets(): Preset[] {
  try { return [...getSettings().customPresets].reverse(); } catch { return []; }
}

/** All presets: user-saved first, then built-ins. */
export function allPresets(): Preset[] {
  return [...customPresets(), ...builtinPresets()];
}

export function findPreset(id: string): Preset | undefined {
  return allPresets().find((p) => p.id === id);
}

/** A preset's look for a tier, if it carries that tier (built-ins carry both). */
export function presetLook(p: Preset, rare: boolean): LookTier | undefined {
  return rare ? p.rare : p.common;
}
/** Presets that provide a look for the given tier (for the per-tier pickers). */
export function presetsForTier(rare: boolean): Preset[] {
  return allPresets().filter((p) => !!presetLook(p, rare));
}

/** The global default look for a tier (from the saved settings). */
export function tierLook(s: AchSettings, rare: boolean): LookTier {
  return {
    theme: rare ? s.themeRare : s.themeCommon,
    anim: rare ? s.animRare : s.animCommon,
    accent: rare ? s.accentRare : s.accentCommon,
    ambient: rare ? s.ambientRare : s.ambientCommon,
    font: rare ? s.fontRare : s.fontCommon,
    fxColor: rare ? s.fxColorRare : s.fxColorCommon,
    fx: rare ? s.fxRare : s.fxCommon,
    sound: rare ? s.soundRare : s.soundCommon,
  };
}

/** The look to use for a tier, honoring a per-game preset (per tier) when set. */
export function resolveLook(s: AchSettings, rare: boolean, appid?: number | string): LookTier {
  // 1) the game's own preset, 2) the default preset, 3) the Personalize look.
  const g = appid != null && appid !== 0 ? s.gamePresets?.[String(appid)] : undefined;
  const dp = s.defaultPreset || {};
  for (const id of [g && (rare ? g.rare : g.common), rare ? dp.rare : dp.common]) {
    if (!id) continue;
    const p = findPreset(id);
    const look = p && presetLook(p, rare);
    // A preset without a sound keeps the global sound for that tier.
    if (look) return { ...look, sound: look.sound ?? (rare ? s.soundRare : s.soundCommon) };
  }
  return tierLook(s, rare);
}

/** Build toast options from a resolved look + the global (non-look) settings. */
export function buildOpts(s: AchSettings, rare: boolean, look: LookTier): ToastOptions {
  return {
    rare,
    durationMs: rare ? s.durationRareMs : s.durationCommonMs,
    width: s.width,
    position: s.position,
    layout: s.layout,
    themeId: look.theme,
    animId: look.anim,
    accentId: look.accent,
    ambient: look.ambient,
    font: look.font,
    fxColor: look.fxColor,
    fx: look.fx,
    showDescription: s.showDescription,
    overlayScale: s.overlayScale,
    autoDisplayScale: s.autoDisplayScale,
    bgOpacity: s.bgOpacity,
    cardOpacity: s.cardOpacity,
    glass: s.glass,
    eyebrow: rare ? tr('toast.rareUnlocked') : tr('toast.unlocked'),
    badge: tr('toast.rareBadge'),
  };
}

/** Patch that applies a preset's look to ONE tier only (keeps the other tier).
 *  Returns {} if the preset doesn't carry that tier. */
export function presetPatchTier(p: Preset, rare: boolean): Partial<AchSettings> {
  const look = presetLook(p, rare);
  if (!look) return {};
  const patch: Partial<AchSettings> = rare
    ? { themeRare: look.theme, animRare: look.anim, accentRare: look.accent, ambientRare: look.ambient, fontRare: look.font, fxColorRare: look.fxColor, fxRare: look.fx }
    : { themeCommon: look.theme, animCommon: look.anim, accentCommon: look.accent, ambientCommon: look.ambient, fontCommon: look.font, fxColorCommon: look.fxColor, fxCommon: look.fx };
  // Presets that carry a sound also set that tier's sound.
  if (look.sound) Object.assign(patch, rare ? { soundRare: { ...look.sound } } : { soundCommon: { ...look.sound } });
  return patch;
}
