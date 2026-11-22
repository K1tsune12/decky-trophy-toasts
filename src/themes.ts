// Visual presets for the toast: THEMES (palette/style), LAYOUTS (arrangement),
// ANIMATIONS (entrance effect), POSITIONS (where on screen). All original,
// inspired by the general look of game achievement popups — no copyrighted
// logos, fonts or art. Everything is plain CSS (transforms/opacity + one
// backdrop blur) to stay light.

export interface Theme {
  id: string;
  name: string;
  /** Card background (gradient or color). */
  cardBg: string;
  /** backdrop blur radius, px (0 = none). */
  blur: number;
  /** Inset border color. */
  border: string;
  /** Corner radius, px. */
  radius: number;
  /** Accent bar gradient [top, bottom]. */
  accent: [string, string];
  /** Eyebrow color, or 'accent' to use the accent gradient as text. */
  eyebrow: string;
  nameColor: string;
  rarityColor: string;
  pctColor: string;
  /** Outer glow color (''=none). Kept small so it fits the card margin. */
  glow: string;
  /** Animated sheen sweep across the card. */
  shimmer: boolean;
  /** Icon frame box-shadow. 'accent' derives a frame from the accent. */
  iconFrame: string;
  /** Font stack. */
  font: string;
}

const SANS = '"Motiva Sans","Segoe UI",system-ui,sans-serif';
const SERIF = 'Georgia,"Times New Roman",serif';
const MONO = '"Consolas","Courier New",monospace';

export const THEMES: Theme[] = [
  {
    id: 'kitsune-glass', name: 'Kitsune Glass',
    cardBg: 'linear-gradient(135deg,rgba(10,10,12,0.80),rgba(0,0,0,0.64))', blur: 20,
    border: 'rgba(255,255,255,0.09)', radius: 0,
    accent: ['#ffc061', '#ff7a1a'], eyebrow: '#ffbe63', nameColor: '#fff',
    rarityColor: '#cfd3da', pctColor: '#ffbe63', glow: '', shimmer: false,
    iconFrame: 'inset 0 0 0 1px rgba(255,186,97,0.5)', font: SANS,
  },
  {
    id: 'kitsune-gold', name: 'Kitsune Gold',
    cardBg: 'linear-gradient(135deg,rgba(14,11,6,0.86),rgba(0,0,0,0.66))', blur: 20,
    border: 'rgba(255,215,130,0.18)', radius: 0,
    accent: ['#ffe08a', '#ffb01a'], eyebrow: 'accent', nameColor: '#fff',
    rarityColor: '#e7dcc4', pctColor: '#ffd166', glow: 'rgba(255,190,70,0.45)', shimmer: true,
    iconFrame: 'inset 0 0 0 2px #ffcf6b,0 0 14px rgba(255,190,70,0.55)', font: SANS,
  },
  {
    id: 'emerald', name: 'Emerald Hero',
    cardBg: 'linear-gradient(135deg,rgba(6,20,14,0.86),rgba(2,8,6,0.68))', blur: 18,
    border: 'rgba(180,255,210,0.14)', radius: 4,
    accent: ['#ffe9a8', '#e9b949'], eyebrow: '#ffe9a8',
    nameColor: '#f3fff4', rarityColor: '#bfe9cf', pctColor: '#ffe9a8',
    glow: 'rgba(230,190,90,0.30)', shimmer: false,
    iconFrame: 'inset 0 0 0 2px #e9b949,0 0 12px rgba(230,190,90,0.4)', font: SERIF,
  },
  {
    id: 'platinum', name: 'Platinum Trophy',
    cardBg: 'linear-gradient(135deg,rgba(8,14,26,0.88),rgba(2,6,14,0.70))', blur: 20,
    border: 'rgba(200,220,255,0.16)', radius: 10,
    accent: ['#eaf3ff', '#9fb6d6'], eyebrow: '#cfe0ff', nameColor: '#fff',
    rarityColor: '#aebdd6', pctColor: '#dfe9ff', glow: 'rgba(180,205,255,0.28)', shimmer: true,
    iconFrame: 'inset 0 0 0 2px rgba(220,235,255,0.7),0 0 12px rgba(180,205,255,0.4)', font: SANS,
  },
  {
    id: 'arcade-neon', name: 'Arcade Neon',
    cardBg: 'linear-gradient(135deg,rgba(10,4,20,0.88),rgba(2,0,8,0.72))', blur: 16,
    border: 'rgba(120,240,255,0.22)', radius: 2,
    accent: ['#5ffbf1', '#b14bff'], eyebrow: 'accent', nameColor: '#eafcff',
    rarityColor: '#b9a9e0', pctColor: '#7df9ff', glow: 'rgba(120,240,255,0.4)', shimmer: true,
    iconFrame: 'inset 0 0 0 2px #5ffbf1,0 0 14px rgba(120,240,255,0.55)', font: MONO,
  },
  {
    id: 'royal', name: 'Royal Violet',
    cardBg: 'linear-gradient(135deg,rgba(18,8,28,0.88),rgba(6,2,12,0.70))', blur: 18,
    border: 'rgba(230,200,255,0.16)', radius: 6,
    accent: ['#ffe08a', '#b06bff'], eyebrow: '#f0d8ff', nameColor: '#fff',
    rarityColor: '#cdb6e6', pctColor: '#ffd98a', glow: 'rgba(176,107,255,0.35)', shimmer: true,
    iconFrame: 'inset 0 0 0 2px #e0b0ff,0 0 12px rgba(176,107,255,0.5)', font: SERIF,
  },
  {
    id: 'crimson', name: 'Crimson Ember',
    cardBg: 'linear-gradient(135deg,rgba(22,6,6,0.88),rgba(8,2,2,0.70))', blur: 18,
    border: 'rgba(255,180,160,0.16)', radius: 2,
    accent: ['#ffb36b', '#ff3b3b'], eyebrow: '#ffb98a', nameColor: '#fff',
    rarityColor: '#e6c0b8', pctColor: '#ff9b6b', glow: 'rgba(255,80,60,0.35)', shimmer: false,
    iconFrame: 'inset 0 0 0 2px #ff7a4d,0 0 12px rgba(255,80,60,0.45)', font: SANS,
  },
  {
    id: 'frost', name: 'Frostbite',
    cardBg: 'linear-gradient(135deg,rgba(8,16,24,0.86),rgba(2,8,14,0.68))', blur: 22,
    border: 'rgba(190,230,255,0.18)', radius: 8,
    accent: ['#e6f7ff', '#4fb6ff'], eyebrow: '#cdeeff', nameColor: '#f2fbff',
    rarityColor: '#aecbe0', pctColor: '#8fd6ff', glow: 'rgba(100,190,255,0.3)', shimmer: true,
    iconFrame: 'inset 0 0 0 2px rgba(210,240,255,0.75),0 0 12px rgba(100,190,255,0.45)', font: SANS,
  },
  {
    id: 'minimal', name: 'Minimal',
    cardBg: 'linear-gradient(135deg,rgba(12,12,14,0.82),rgba(4,4,6,0.66))', blur: 16,
    border: 'rgba(255,255,255,0.12)', radius: 6,
    accent: ['#ffffff', '#b9bec7'], eyebrow: '#c7ccd4', nameColor: '#fff',
    rarityColor: '#aab0ba', pctColor: '#ffffff', glow: '', shimmer: false,
    iconFrame: 'inset 0 0 0 1px rgba(255,255,255,0.35)', font: SANS,
  },
  {
    id: 'retro', name: 'Retro Pixel',
    cardBg: 'linear-gradient(135deg,rgba(6,10,8,0.92),rgba(2,4,3,0.80))', blur: 0,
    border: 'rgba(120,255,160,0.5)', radius: 0,
    accent: ['#8bff6a', '#2ecf4a'], eyebrow: '#9dff7a', nameColor: '#eaffea',
    rarityColor: '#9fd6a4', pctColor: '#8bff6a', glow: 'rgba(90,255,120,0.3)', shimmer: false,
    iconFrame: 'inset 0 0 0 2px #8bff6a', font: MONO,
  },
];

export interface AnimDef {
  id: string;
  name: string;
  /** @keyframes body for the entrance. */
  keyframes: string;
  /** easing + duration for the entrance. */
  timing: string;
}

export const ANIMATIONS: AnimDef[] = [
  { id: 'slide-down', name: 'Slide down', keyframes: 'from{opacity:0;transform:translateY(-44px)}to{opacity:1;transform:translateY(0)}', timing: '.5s cubic-bezier(.16,1,.3,1)' },
  { id: 'slide-up', name: 'Slide up', keyframes: 'from{opacity:0;transform:translateY(44px)}to{opacity:1;transform:translateY(0)}', timing: '.5s cubic-bezier(.16,1,.3,1)' },
  { id: 'slide-left', name: 'Slide from left', keyframes: 'from{opacity:0;transform:translateX(-70px)}to{opacity:1;transform:translateX(0)}', timing: '.5s cubic-bezier(.16,1,.3,1)' },
  { id: 'slide-right', name: 'Slide from right', keyframes: 'from{opacity:0;transform:translateX(70px)}to{opacity:1;transform:translateX(0)}', timing: '.5s cubic-bezier(.16,1,.3,1)' },
  { id: 'fade', name: 'Fade', keyframes: 'from{opacity:0}to{opacity:1}', timing: '.45s ease' },
  { id: 'pop', name: 'Pop', keyframes: 'from{opacity:0;transform:scale(.82)}to{opacity:1;transform:scale(1)}', timing: '.45s cubic-bezier(.2,1.3,.4,1)' },
  { id: 'bounce', name: 'Bounce', keyframes: '0%{opacity:0;transform:translateY(-40px) scale(.9)}60%{opacity:1;transform:translateY(8px) scale(1.02)}100%{transform:translateY(0) scale(1)}', timing: '.6s cubic-bezier(.2,.9,.3,1.2)' },
  { id: 'flip', name: 'Flip in', keyframes: 'from{opacity:0;transform:perspective(600px) rotateX(-80deg)}to{opacity:1;transform:perspective(600px) rotateX(0)}', timing: '.55s cubic-bezier(.2,1,.3,1)' },
  { id: 'glow-in', name: 'Glow in', keyframes: 'from{opacity:0;transform:scale(1.05);filter:brightness(1.8)}to{opacity:1;transform:scale(1);filter:brightness(1)}', timing: '.55s ease-out' },
];

export interface LayoutDef {
  id: string;
  name: string;
}

export const LAYOUTS: LayoutDef[] = [
  { id: 'standard', name: 'Standard (icon left)' },
  { id: 'compact', name: 'Compact' },
  { id: 'centered', name: 'Centered (icon top)' },
  { id: 'banner', name: 'Banner (large)' },
];

export const POSITIONS = [
  { id: 'top-center', name: 'Top center' },
  { id: 'top-left', name: 'Top left' },
  { id: 'top-right', name: 'Top right' },
  { id: 'bottom-center', name: 'Bottom center' },
  { id: 'bottom-left', name: 'Bottom left' },
  { id: 'bottom-right', name: 'Bottom right' },
] as const;

export type PositionId = (typeof POSITIONS)[number]['id'];

/** Accent-color overrides. '' = keep the theme's own accent. */
export const ACCENTS: { id: string; name: string; colors: [string, string] }[] = [
  { id: '', name: 'Theme default', colors: ['', ''] },
  { id: 'amber', name: 'Amber', colors: ['#ffc061', '#ff7a1a'] },
  { id: 'gold', name: 'Gold', colors: ['#ffe08a', '#ffb01a'] },
  { id: 'blue', name: 'Blue', colors: ['#7db8ff', '#2a6cff'] },
  { id: 'cyan', name: 'Cyan', colors: ['#9cffff', '#18c0c0'] },
  { id: 'green', name: 'Green', colors: ['#9cff9c', '#18c04a'] },
  { id: 'red', name: 'Red', colors: ['#ff9c9c', '#ff2a2a'] },
  { id: 'purple', name: 'Purple', colors: ['#c89cff', '#7a3aff'] },
  { id: 'pink', name: 'Pink', colors: ['#ff9cff', '#ff4ad0'] },
  { id: 'white', name: 'White / Silver', colors: ['#ffffff', '#b9bec7'] },
];

/** Ongoing "ambient" color animations for the accent (light, CSS-only). */
export const AMBIENTS: { id: string; name: string }[] = [
  { id: 'none', name: 'None' },
  { id: 'flow', name: 'Gradient flow' },
  { id: 'hue', name: 'Color cycle (rainbow)' },
  { id: 'pulse', name: 'Glow pulse' },
  { id: 'flow-pulse', name: 'Flow + pulse' },
  { id: 'breathe', name: 'Breathe (soft)' },
];

/**
 * Selectable effects (CSS-only), grouped so conflicting ones can't stack.
 * - `outline`   : drawn on the card edge — only ONE at a time (they overlap).
 * - `particles` : a particle layer — only ONE at a time (stacking is noisy + heavy).
 * - `flair`     : cheap, mostly one-shot accents — combine freely.
 */
/**
 * Font override per tier. System stacks (sans/serif/mono) always work offline;
 * the "display" fonts are pulled from Google Fonts on demand (the toast falls
 * back to the stack if offline). '' keeps the theme's own font.
 */
export interface FontDef {
  id: string;
  name: string;
  stack: string;
  /** Google Fonts CSS URL to @import when this font is chosen. */
  import?: string;
}

export const FONTS: FontDef[] = [
  { id: '', name: 'Theme default', stack: '' },
  { id: 'sans', name: 'Steam Sans', stack: '"Motiva Sans","Segoe UI",system-ui,sans-serif' },
  { id: 'serif', name: 'Serif', stack: 'Georgia,"Noto Serif","Times New Roman",serif' },
  { id: 'mono', name: 'Monospace', stack: '"Consolas","DejaVu Sans Mono",monospace' },
  { id: 'orbitron', name: 'Orbitron (futuristic)', stack: '"Orbitron","Segoe UI",sans-serif', import: 'https://fonts.googleapis.com/css2?family=Orbitron:wght@500;800&display=swap' },
  { id: 'russo', name: 'Russo One (bold)', stack: '"Russo One","Segoe UI",sans-serif', import: 'https://fonts.googleapis.com/css2?family=Russo+One&display=swap' },
  { id: 'audiowide', name: 'Audiowide (tech)', stack: '"Audiowide","Segoe UI",sans-serif', import: 'https://fonts.googleapis.com/css2?family=Audiowide&display=swap' },
  { id: 'press', name: 'Press Start 2P (pixel)', stack: '"Press Start 2P",monospace', import: 'https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap' },
  { id: 'cinzel', name: 'Cinzel (epic)', stack: '"Cinzel",Georgia,serif', import: 'https://fonts.googleapis.com/css2?family=Cinzel:wght@600;800&display=swap' },
  { id: 'nunito', name: 'Nunito (rounded)', stack: '"Nunito","Segoe UI",sans-serif', import: 'https://fonts.googleapis.com/css2?family=Nunito:wght@700;900&display=swap' },
  { id: 'teko', name: 'Teko (condensed)', stack: '"Teko","Segoe UI",sans-serif', import: 'https://fonts.googleapis.com/css2?family=Teko:wght@500;700&display=swap' },
];

export function getFont(id: string): FontDef | undefined {
  return FONTS.find((f) => f.id === id);
}
/** The font-family stack for a theme, honoring an optional override id. */
export function resolveFontStack(theme: Theme, id?: string): string {
  const f = id ? getFont(id) : undefined;
  return f && f.stack ? f.stack : theme.font;
}
/** The @import rule needed for a font override, or '' for none. */
export function fontImport(id?: string): string {
  const f = id ? getFont(id) : undefined;
  return f && f.import ? `@import url('${f.import}');` : '';
}

export type EffectGroup = 'outline' | 'particles' | 'flair';

export interface EffectDef {
  id: string;
  name: string;
  group: EffectGroup;
}

export const EFFECTS: EffectDef[] = [
  // Outline (exclusive) — all render on the card border
  { id: 'border', name: 'Static border', group: 'outline' },
  { id: 'glowline', name: 'Glow trail (running)', group: 'outline' },
  { id: 'edgepulse', name: 'Glow edge (pulsing)', group: 'outline' },
  { id: 'edgerainbow', name: 'Glow edge (rainbow)', group: 'outline' },
  // Particles (exclusive) — each is its own particle layer
  { id: 'sparkles', name: 'Sparkles', group: 'particles' },
  { id: 'stars', name: 'Stars', group: 'particles' },
  { id: 'confetti', name: 'Confetti', group: 'particles' },
  // Flair (combine freely)
  { id: 'accentbar', name: 'Accent bar (side)', group: 'flair' },
  { id: 'comet', name: 'Comet streak', group: 'flair' },
  { id: 'stamp', name: 'Icon pop', group: 'flair' },
  { id: 'glint', name: 'Light glint', group: 'flair' },
  { id: 'shockwave', name: 'Shockwave', group: 'flair' },
  { id: 'flash', name: 'Entrance flash', group: 'flair' },
];

/** Effect groups that allow only a single selection at a time. */
export const EXCLUSIVE_GROUPS: EffectGroup[] = ['outline', 'particles'];

export function effectGroup(id: string): EffectGroup | undefined {
  return EFFECTS.find((e) => e.id === id)?.group;
}
export function effectsInGroup(group: EffectGroup): EffectDef[] {
  return EFFECTS.filter((e) => e.group === group);
}
/** The current single choice for an exclusive group ('' = none). */
export function groupChoice(fx: string[], group: EffectGroup): string {
  return fx.find((id) => effectGroup(id) === group) ?? '';
}
/** Replace the selection for an exclusive group ('' clears it). */
export function setGroupChoice(fx: string[], group: EffectGroup, id: string): string[] {
  const kept = fx.filter((x) => effectGroup(x) !== group);
  return id ? [...kept, id] : kept;
}
/** Drop unknown ids and enforce one-per-exclusive-group (latest wins). */
export function sanitizeFx(fx: string[]): string[] {
  if (!Array.isArray(fx)) return [];
  const taken = new Set<EffectGroup>();
  const out: string[] = [];
  for (let i = fx.length - 1; i >= 0; i--) {
    const g = effectGroup(fx[i]);
    if (!g) continue;
    if (EXCLUSIVE_GROUPS.includes(g)) {
      if (taken.has(g)) continue;
      taken.add(g);
    }
    out.unshift(fx[i]);
  }
  return out;
}

/** Whether a theme shows the animated glowing border ring by default. */
export function defaultBorder(id: string): boolean {
  return id === 'arcade-neon';
}

/** Default enabled effects for a tier (used for first run). */
export function defaultFx(themeId: string, rare: boolean): string[] {
  const fx = ['accentbar', 'stamp', 'shockwave', 'comet'];
  if (defaultBorder(themeId)) fx.push('border');
  if (rare) {
    fx.push('glint', 'flash', 'sparkles');
    if (!defaultBorder(themeId)) fx.push('glowline');
  }
  return sanitizeFx(fx);
}

/** The default ambient animation per theme (used unless overridden). */
export function defaultAmbient(id: string): string {
  switch (id) {
    case 'arcade-neon': return 'hue';
    case 'kitsune-gold': return 'pulse';
    case 'royal': return 'flow-pulse';
    case 'crimson': return 'pulse';
    case 'frost': return 'breathe';
    case 'emerald': return 'flow';
    case 'kitsune-glass': return 'flow';
    case 'retro': return 'flow';
    case 'platinum': return 'breathe';
    default: return 'none';
  }
}

export function getTheme(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
export function getAnim(id: string): AnimDef {
  return ANIMATIONS.find((a) => a.id === id) ?? ANIMATIONS[0];
}
/** The accent gradient for a theme, honoring an optional override id. */
export function resolveAccent(theme: Theme, overrideId: string): [string, string] {
  if (overrideId) {
    const a = ACCENTS.find((x) => x.id === overrideId);
    if (a && a.colors[0]) return a.colors;
  }
  return theme.accent;
}

/** A single solid color for the flash/particle effects from an ACCENTS id
 *  ('' = keep each effect's own default color). */
export function resolveFxColor(id: string): string {
  if (!id) return '';
  const a = ACCENTS.find((x) => x.id === id);
  return a && a.colors[0] ? a.colors[0] : '';
}
