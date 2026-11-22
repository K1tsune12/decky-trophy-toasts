// Shared UI pieces used by both the Quick Access panel and the full-page Studio.

import { FileSelectionType, call, openFilePicker } from '@decky/api';
import { ButtonItem, DropdownItem, PanelSection, PanelSectionRow, SliderField, ToggleField } from '@decky/ui';
import { useEffect, useState } from 'react';

import {
  LANGUAGE_NAMES, Lang, LangSetting, getLangSetting, setLangSetting, steamLanguageNow, t, useLanguage,
} from './i18n';
import { runtime } from './runtime';
import { AchSettings, saveSettings, saveSlot } from './settings';
import {
  ACCENTS, AMBIENTS, ANIMATIONS, EffectGroup, FONTS, THEMES,
  effectsInGroup, groupChoice, setGroupChoice,
} from './themes';

const AUDIO_EXTENSIONS = ['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'flac', 'webm'];
const START_PATH = '/home/deck';
const CUSTOM = '__file__';
const BUILTIN_PREFIX = 'builtin:';

export interface BuiltinSound { id: string; name: string }

const basename = (p: string) => (p ? p.split('/').pop() || p : '');
const isFilePath = (p: string) => !!p && !p.startsWith(BUILTIN_PREFIX);
const titleCase = (id: string) => id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Fetch the plugin's bundled sound list once. */
export function useBuiltinSounds(): BuiltinSound[] {
  const [builtins, setBuiltins] = useState<BuiltinSound[]>([]);
  useEffect(() => {
    call<[], BuiltinSound[] | { error: string }>('list_builtin_sounds')
      .then((res) => { if (Array.isArray(res)) setBuiltins(res); })
      .catch(() => {});
  }, []);
  return builtins;
}

export function Dropdown<T extends string>({
  label, value, options, onChange, disabled,
}: {
  label: string;
  value: T;
  options: { data: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <PanelSectionRow>
      <DropdownItem
        label={label}
        disabled={disabled}
        selectedOption={value}
        rgOptions={options}
        onChange={(o) => onChange(o.data as T)}
      />
    </PanelSectionRow>
  );
}

/** Theme + entrance + accent + ambient + grouped effects for one tier. */
export function LookEditor({
  tier, settings, onChange,
}: {
  tier: 'common' | 'rare';
  settings: AchSettings;
  onChange: (next: AchSettings) => void;
}) {
  const themeKey = tier === 'rare' ? 'themeRare' : 'themeCommon';
  const animKey = tier === 'rare' ? 'animRare' : 'animCommon';
  const accentKey = tier === 'rare' ? 'accentRare' : 'accentCommon';
  const ambientKey = tier === 'rare' ? 'ambientRare' : 'ambientCommon';
  const fontKey = tier === 'rare' ? 'fontRare' : 'fontCommon';
  const fxColorKey = tier === 'rare' ? 'fxColorRare' : 'fxColorCommon';
  const fxKey = tier === 'rare' ? 'fxRare' : 'fxCommon';
  const fx = settings[fxKey];
  const dis = !settings.enabled;
  const setFx = (next: string[]) => onChange(saveSettings({ [fxKey]: next } as Partial<AchSettings>));
  const setGroup = (group: EffectGroup, id: string) => setFx(setGroupChoice(fx, group, id));
  const toggleFlair = (id: string, on: boolean) => {
    const next = fx.filter((x) => x !== id);
    if (on) next.push(id);
    setFx(next);
  };

  return (
    <>
      <Dropdown
        label={t('look.theme')} disabled={dis} value={settings[themeKey]}
        options={THEMES.map((th) => ({ data: th.id, label: th.name }))}
        onChange={(v) => onChange(saveSettings({ [themeKey]: v } as Partial<AchSettings>))}
      />
      <Dropdown
        label={t('look.font')} disabled={dis} value={settings[fontKey]}
        options={FONTS.map((f) => ({ data: f.id, label: f.id === '' ? t('accent.default') : f.name }))}
        onChange={(v) => onChange(saveSettings({ [fontKey]: v } as Partial<AchSettings>))}
      />
      <Dropdown
        label={t('look.effect')} disabled={dis} value={settings[animKey]}
        options={ANIMATIONS.map((a) => ({ data: a.id, label: a.name }))}
        onChange={(v) => onChange(saveSettings({ [animKey]: v } as Partial<AchSettings>))}
      />
      <Dropdown
        label={t('look.accent')} disabled={dis} value={settings[accentKey]}
        options={ACCENTS.map((a) => ({ data: a.id, label: a.id === '' ? t('accent.default') : a.name }))}
        onChange={(v) => onChange(saveSettings({ [accentKey]: v } as Partial<AchSettings>))}
      />
      <Dropdown
        label={t('look.ambient')} disabled={dis} value={settings[ambientKey]}
        options={[{ data: '', label: t('accent.default') }, ...AMBIENTS.map((a) => ({ data: a.id, label: a.name }))]}
        onChange={(v) => onChange(saveSettings({ [ambientKey]: v } as Partial<AchSettings>))}
      />
      <Dropdown
        label={t('look.outline')} disabled={dis} value={groupChoice(fx, 'outline')}
        options={[{ data: '', label: t('fx.none') }, ...effectsInGroup('outline').map((e) => ({ data: e.id, label: e.name }))]}
        onChange={(v) => setGroup('outline', v)}
      />
      <Dropdown
        label={t('look.particles')} disabled={dis} value={groupChoice(fx, 'particles')}
        options={[{ data: '', label: t('fx.none') }, ...effectsInGroup('particles').map((e) => ({ data: e.id, label: e.name }))]}
        onChange={(v) => setGroup('particles', v)}
      />
      <Dropdown
        label={t('look.fxColor')} disabled={dis} value={settings[fxColorKey]}
        options={ACCENTS.map((a) => ({ data: a.id, label: a.id === '' ? t('accent.default') : a.name }))}
        onChange={(v) => onChange(saveSettings({ [fxColorKey]: v } as Partial<AchSettings>))}
      />
      <PanelSectionRow>
        <div style={{ fontSize: '12px', fontWeight: 600, opacity: 0.7, padding: '4px 0 2px' }}>{t('look.flair')}</div>
      </PanelSectionRow>
      {effectsInGroup('flair').map((e) => (
        <PanelSectionRow key={e.id}>
          <ToggleField label={e.name} disabled={dis} checked={fx.includes(e.id)} onChange={(v) => toggleFlair(e.id, v)} />
        </PanelSectionRow>
      ))}
    </>
  );
}

/** Sound picker + volume + test for one slot (common or rare). */
export function SoundSlotControls({
  which, label, settings, builtins, onChange,
}: {
  which: 'soundCommon' | 'soundRare';
  label: string;
  settings: AchSettings;
  builtins: BuiltinSound[];
  onChange: (next: AchSettings) => void;
}) {
  const slot = settings[which];
  const disabled = !settings.enabled || !slot.enabled;

  const setPath = (path: string) => { onChange(saveSlot(which, { path })); void runtime.sound?.preload(path); };
  const pickFile = async () => {
    try {
      const res = await openFilePicker(
        FileSelectionType.FILE, isFilePath(slot.path) ? slot.path : START_PATH,
        true, true, undefined, AUDIO_EXTENSIONS, false, true,
      );
      if (res?.path) setPath(res.path);
    } catch { /* cancelled */ }
  };

  const fileChosen = isFilePath(slot.path);
  const options = [
    ...builtins.map((b) => ({ data: `${BUILTIN_PREFIX}${b.id}`, label: titleCase(b.id) })),
    { data: CUSTOM, label: fileChosen ? t('sounds.customNamed', { file: basename(slot.path) }) : t('sounds.customFile') },
  ];
  const selected = slot.path?.startsWith(BUILTIN_PREFIX) ? slot.path : fileChosen ? CUSTOM : undefined;

  return (
    <>
      <PanelSectionRow>
        <ToggleField label={label} checked={slot.enabled} disabled={!settings.enabled}
          onChange={(v) => onChange(saveSlot(which, { enabled: v }))} />
      </PanelSectionRow>
      <PanelSectionRow>
        <DropdownItem
          label={t('sounds.sound')} disabled={disabled} strDefaultLabel={t('sounds.chooseSound')}
          selectedOption={selected} rgOptions={options}
          onChange={(o) => (o.data === CUSTOM ? void pickFile() : setPath(o.data as string))}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <SliderField label={t('sounds.volume')} disabled={disabled}
          value={Math.round(slot.volume * 100)} min={0} max={100} step={5} showValue
          onChange={(v) => onChange(saveSlot(which, { volume: v / 100 }))} />
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={disabled || !slot.path} onClick={() => void runtime.sound?.playSlot(which)}>
          {t('sounds.test')}
        </ButtonItem>
      </PanelSectionRow>
    </>
  );
}

/** Language chooser (auto / English / Portuguese). */
export function LanguageSection() {
  const lang = useLanguage();
  const [setting, setSetting] = useState<LangSetting>(getLangSetting);
  const [steamLang, setSteamLang] = useState<Lang>(lang);
  useEffect(() => { void steamLanguageNow().then(setSteamLang); }, []);
  return (
    <PanelSection title={t('lang.title')}>
      <PanelSectionRow>
        <DropdownItem
          rgOptions={[
            { data: 'auto', label: t('lang.auto', { lang: LANGUAGE_NAMES[steamLang] }) },
            { data: 'en', label: LANGUAGE_NAMES.en },
            { data: 'pt-BR', label: LANGUAGE_NAMES['pt-BR'] },
          ]}
          selectedOption={setting}
          onChange={(o) => { setSetting(o.data as LangSetting); void setLangSetting(o.data as LangSetting); }}
        />
      </PanelSectionRow>
    </PanelSection>
  );
}
