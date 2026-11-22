// Presets: reusable "looks" for the toast. A preset bundles a full look (theme,
// entrance, accent, ambient animation and effects) for both tiers (common +
// rare). Built-in presets are generated from the themes in themes.ts plus a few
// hand-tuned combos. Presets can be applied as the global default, or assigned
// per game (resolved at unlock time by appid, with the default as fallback).

import { tr } from './i18n';
import { AchSettings } from './settings';
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
}

export interface Preset {
  id: string;
  name: string;
  builtin?: boolean;
  common: LookTier;
  rare: LookTier;
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
];

/** A tasteful font pairing for a theme's generated preset ('' = theme default). */
function themeFont(id: string): string {
  switch (id) {
    case 'arcade-neon': return 'orbitron';
    case 'retro': return 'press';
    case 'royal': return 'cinzel';
    case 'emerald': return 'cinzel';
    default: return '';
  }
}

/** One preset per theme, generated from its sensible defaults. */
export function themePresets(): Preset[] {
  return THEMES.map((th) => ({
    id: `theme:${th.id}`,
    name: th.name,
    builtin: true,
    common: tier(th.id, 'slide-down', defaultAmbient(th.id), defaultFx(th.id, false), '', themeFont(th.id)),
    rare: tier(th.id, 'glow-in', defaultAmbient(th.id), defaultFx(th.id, true), '', themeFont(th.id)),
  }));
}

export function allPresets(): Preset[] {
  return [...CURATED, ...themePresets()];
}

export function findPreset(id: string): Preset | undefined {
  return allPresets().find((p) => p.id === id);
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
  };
}

/** The look to use for a tier, honoring a per-game preset when one is set. */
export function resolveLook(s: AchSettings, rare: boolean, appid?: number | string): LookTier {
  if (appid != null && appid !== 0) {
    const id = s.gamePresets?.[String(appid)];
    if (id) {
      const p = findPreset(id);
      if (p) return rare ? p.rare : p.common;
    }
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
    eyebrow: rare ? tr('toast.rareUnlocked') : tr('toast.unlocked'),
    badge: tr('toast.rareBadge'),
  };
}

/** Patch that applies a preset's look to ONE tier only (keeps the other tier). */
export function presetPatchTier(p: Preset, rare: boolean): Partial<AchSettings> {
  const look = rare ? p.rare : p.common;
  return rare
    ? { themeRare: look.theme, animRare: look.anim, accentRare: look.accent, ambientRare: look.ambient, fontRare: look.font, fxColorRare: look.fxColor, fxRare: look.fx }
    : { themeCommon: look.theme, animCommon: look.anim, accentCommon: look.accent, ambientCommon: look.ambient, fontCommon: look.font, fxColorCommon: look.fxColor, fxCommon: look.fx };
}
