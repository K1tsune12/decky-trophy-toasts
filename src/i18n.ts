// Minimal i18n: English + Brazilian Portuguese, matching the other Kitsune
// plugins. Default follows Steam's UI language (Portuguese -> pt-BR, else English).

import { useEffect, useReducer } from 'react';

export type Lang = 'en' | 'pt-BR';

const en = {
  'lang.title': 'Language',
  'lang.auto': 'Automatic ({lang})',

  'app.title': 'Trophy Toasts',
  'app.enable': 'Enabled',

  'behavior.title': 'Behavior',
  'behavior.replaceNative': "Replace Steam's achievement popup",
  'behavior.replaceNativeDesc': "Hide Steam's small toast + sound and show only this one",
  'behavior.showCommon': 'Show for common achievements',
  'behavior.showCommonDesc': 'Off = only rare achievements get the big toast',
  'behavior.rareThreshold': 'Rare threshold',
  'behavior.rareThresholdDesc': 'Counts as rare below this global unlock %',
  'behavior.durationCommon': 'Common duration (seconds)',
  'behavior.durationRare': 'Rare duration (seconds)',
  'behavior.width': 'Width',

  'appearance.title': 'Appearance',
  'appearance.position': 'Position',
  'appearance.layout': 'Layout',

  'common.title': 'Common achievements',
  'rare.title': 'Rare achievements',
  'look.theme': 'Theme',
  'look.effect': 'Entrance effect',
  'look.accent': 'Accent color',
  'look.font': 'Font',
  'look.ambient': 'Color animation',
  'look.effects': 'Effects',
  'look.outline': 'Outline',
  'look.particles': 'Particles',
  'look.fxColor': 'Effect color (flash + particles)',
  'look.flair': 'Extra flair',
  'fx.none': 'None',

  'accent.default': 'Theme default',

  'pos.top-center': 'Top center',
  'pos.top-left': 'Top left',
  'pos.top-right': 'Top right',
  'pos.bottom-center': 'Bottom center',
  'pos.bottom-left': 'Bottom left',
  'pos.bottom-right': 'Bottom right',

  'sounds.title': 'Sounds',
  'sounds.master': 'Master volume',
  'sounds.common': 'Common unlock sound',
  'sounds.rare': 'Rare unlock sound',
  'sounds.sound': 'Sound',
  'sounds.chooseSound': 'Choose a sound',
  'sounds.customNamed': 'Custom: {file}',
  'sounds.customFile': 'Custom file…',
  'sounds.volume': 'Volume',
  'sounds.test': 'Test sound',

  'preview.title': 'Preview',
  'preview.common': 'Test common toast',
  'preview.rare': 'Test rare toast',

  'advanced.title': 'Advanced',
  'advanced.debug': 'Debug logging',
  'advanced.debugDesc': 'Log each achievement event to the console',

  'studio.open': 'Settings & Preview',
  'studio.title': 'Trophy Toasts — Studio',
  'studio.tabLook': 'Look',
  'studio.tabGeneral': 'General',
  'studio.preview': 'Live preview',
  'studio.replay': 'Replay',
  'studio.previewSound': 'Play sound on replay',
  'studio.sndOn': 'Sound',
  'studio.sndOff': 'Muted',
  'studio.testDevice': 'Show on screen',
  'studio.presets': 'Presets',
  'studio.presetsDesc': 'Applies a ready-made look to the selected tier:',
  'studio.edit': 'Customize',
  'studio.tierCommon': 'Common',
  'studio.tierRare': 'Rare',
  'studio.perGame': 'Per-game presets',
  'studio.perGameDesc': 'Give specific games their own look. Others use the default above.',
  'studio.openGame': 'Open game',
  'studio.noGame': 'Start a game to set a preset for it.',
  'studio.useDefault': 'Default (global look)',
  'studio.overrides': 'Games with a custom preset',
  'studio.remove': 'Remove',
  'studio.back': 'Back',

  // text shown inside the toast itself
  'toast.unlocked': 'ACHIEVEMENT UNLOCKED',
  'toast.rareUnlocked': 'RARE ACHIEVEMENT UNLOCKED',
  'toast.rareBadge': 'RARE',
  'toast.rarity': 'Only {pct}% of players have this',
  'toast.sampleCommon': 'First Steps',
  'toast.sampleRare': "Kitsune's Blessing",
};

export type Key = keyof typeof en;

const ptBR: Record<Key, string> = {
  'lang.title': 'Idioma',
  'lang.auto': 'Automático ({lang})',

  'app.title': 'Toasts de Troféu',
  'app.enable': 'Ativado',

  'behavior.title': 'Comportamento',
  'behavior.replaceNative': 'Substituir o popup de conquista da Steam',
  'behavior.replaceNativeDesc': 'Esconde o toast pequeno + som da Steam e mostra só este',
  'behavior.showCommon': 'Mostrar para conquistas comuns',
  'behavior.showCommonDesc': 'Desligado = só conquistas raras ganham o toast grande',
  'behavior.rareThreshold': 'Limite de raridade',
  'behavior.rareThresholdDesc': 'Conta como rara abaixo deste % global de desbloqueio',
  'behavior.durationCommon': 'Duração comum (segundos)',
  'behavior.durationRare': 'Duração rara (segundos)',
  'behavior.width': 'Largura',

  'appearance.title': 'Aparência',
  'appearance.position': 'Posição',
  'appearance.layout': 'Layout',

  'common.title': 'Conquistas comuns',
  'rare.title': 'Conquistas raras',
  'look.theme': 'Tema',
  'look.effect': 'Efeito de entrada',
  'look.accent': 'Cor de destaque',
  'look.font': 'Fonte',
  'look.ambient': 'Animação de cor',
  'look.effects': 'Efeitos',
  'look.outline': 'Contorno',
  'look.particles': 'Partículas',
  'look.fxColor': 'Cor dos efeitos (flash + partículas)',
  'look.flair': 'Efeitos extras',
  'fx.none': 'Nenhum',

  'accent.default': 'Padrão do tema',

  'pos.top-center': 'Topo centro',
  'pos.top-left': 'Topo esquerda',
  'pos.top-right': 'Topo direita',
  'pos.bottom-center': 'Base centro',
  'pos.bottom-left': 'Base esquerda',
  'pos.bottom-right': 'Base direita',

  'sounds.title': 'Sons',
  'sounds.master': 'Volume geral',
  'sounds.common': 'Som de conquista comum',
  'sounds.rare': 'Som de conquista rara',
  'sounds.sound': 'Som',
  'sounds.chooseSound': 'Escolha um som',
  'sounds.customNamed': 'Personalizado: {file}',
  'sounds.customFile': 'Arquivo personalizado…',
  'sounds.volume': 'Volume',
  'sounds.test': 'Testar som',

  'preview.title': 'Prévia',
  'preview.common': 'Testar toast comum',
  'preview.rare': 'Testar toast raro',

  'advanced.title': 'Avançado',
  'advanced.debug': 'Registro de depuração',
  'advanced.debugDesc': 'Registra cada evento de conquista no console',

  'studio.open': 'Configurações e Preview',
  'studio.title': 'Trophy Toasts — Studio',
  'studio.tabLook': 'Visual',
  'studio.tabGeneral': 'Geral',
  'studio.preview': 'Prévia ao vivo',
  'studio.replay': 'Repetir',
  'studio.previewSound': 'Tocar som ao repetir',
  'studio.sndOn': 'Som',
  'studio.sndOff': 'Mudo',
  'studio.testDevice': 'Mostrar na tela',
  'studio.presets': 'Presets',
  'studio.presetsDesc': 'Aplica um visual pronto no tier selecionado:',
  'studio.edit': 'Personalizar',
  'studio.tierCommon': 'Comum',
  'studio.tierRare': 'Rara',
  'studio.perGame': 'Presets por jogo',
  'studio.perGameDesc': 'Dê a jogos específicos um visual próprio. Os demais usam o padrão acima.',
  'studio.openGame': 'Jogo aberto',
  'studio.noGame': 'Abra um jogo para definir um preset para ele.',
  'studio.useDefault': 'Padrão (visual global)',
  'studio.overrides': 'Jogos com preset personalizado',
  'studio.remove': 'Remover',
  'studio.back': 'Voltar',

  'toast.unlocked': 'CONQUISTA DESBLOQUEADA',
  'toast.rareUnlocked': 'CONQUISTA RARA DESBLOQUEADA',
  'toast.rareBadge': 'RARA',
  'toast.rarity': 'Apenas {pct}% dos jogadores têm esta',
  'toast.sampleCommon': 'Primeiros Passos',
  'toast.sampleRare': 'Bênção da Kitsune',
};

const TABLES: Record<Lang, Record<Key, string>> = { en, 'pt-BR': ptBR };

let current: Lang = 'en';
const listeners = new Set<() => void>();

export function t(key: Key, vars?: Record<string, string | number>): string {
  let text = TABLES[current][key] ?? en[key];
  if (vars) for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(String(v));
  return text;
}

/** Non-reactive lookup for code outside React (e.g. the toast HTML builder). */
export function tr(key: Key, vars?: Record<string, string | number>): string {
  return t(key, vars);
}

export function currentLang(): Lang {
  return current;
}

async function steamLanguage(): Promise<Lang> {
  try {
    const lang: string = await (window as any).SteamClient.Settings.GetCurrentLanguage();
    return lang === 'brazilian' || lang === 'portuguese' ? 'pt-BR' : 'en';
  } catch {
    return 'en';
  }
}

export type LangSetting = 'auto' | Lang;
const SETTING_KEY = 'decky-achievement-toasts:lang';

export const LANGUAGE_NAMES: Record<Lang, string> = { en: 'English', 'pt-BR': 'Português (Brasil)' };

export function getLangSetting(): LangSetting {
  try {
    const v = localStorage.getItem(SETTING_KEY);
    return v === 'en' || v === 'pt-BR' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export const steamLanguageNow = steamLanguage;

async function apply(setting: LangSetting): Promise<void> {
  current = setting === 'auto' ? await steamLanguage() : setting;
  listeners.forEach((l) => l());
}

export function initLanguage(): Promise<void> {
  return apply(getLangSetting());
}

export function setLangSetting(setting: LangSetting): Promise<void> {
  try {
    if (setting === 'auto') localStorage.removeItem(SETTING_KEY);
    else localStorage.setItem(SETTING_KEY, setting);
  } catch {
    /* convenience only */
  }
  return apply(setting);
}

export function useLanguage(): Lang {
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    listeners.add(rerender);
    return () => {
      listeners.delete(rerender);
    };
  }, []);
  return current;
}
