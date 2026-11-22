import { FileSelectionType, call, definePlugin, openFilePicker } from '@decky/api';
import {
  ButtonItem,
  DropdownItem,
  PanelSection,
  PanelSectionRow,
  SliderField,
  ToggleField,
  staticClasses,
} from '@decky/ui';
import { useEffect, useState } from 'react';
import { FaTrophy } from 'react-icons/fa';

import { AchievementWatcher } from './achievements';
import {
  LANGUAGE_NAMES, Lang, LangSetting, getLangSetting, initLanguage, setLangSetting, steamLanguageNow, t, useLanguage,
} from './i18n';
import { AchSettings, getSettings, saveSettings, saveSlot } from './settings';
import { SoundPlayer } from './sound';
import { ACCENTS, ANIMATIONS, LAYOUTS, POSITIONS, THEMES } from './themes';
import { ToastWindow } from './toastWindow';
import { UpdateCheckButton } from './updateCheck';

const AUDIO_EXTENSIONS = ['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'flac', 'webm'];
const START_PATH = '/home/deck';
const CUSTOM = '__file__';
const BUILTIN_PREFIX = 'builtin:';

interface BuiltinSound { id: string; name: string }

let toast: ToastWindow | undefined;
let sound: SoundPlayer | undefined;
let watcher: AchievementWatcher | undefined;

const basename = (p: string) => (p ? p.split('/').pop() || p : '');
const isFilePath = (p: string) => !!p && !p.startsWith(BUILTIN_PREFIX);
const titleCase = (id: string) => id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function Dropdown<T extends string>({
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

/** Theme + entrance effect + accent for one tier (common or rare). */
function LookControls({
  tier, settings, onChange,
}: {
  tier: 'common' | 'rare';
  settings: AchSettings;
  onChange: (next: AchSettings) => void;
}) {
  const themeKey = tier === 'rare' ? 'themeRare' : 'themeCommon';
  const animKey = tier === 'rare' ? 'animRare' : 'animCommon';
  const accentKey = tier === 'rare' ? 'accentRare' : 'accentCommon';
  const dis = !settings.enabled;
  return (
    <>
      <Dropdown
        label={t('look.theme')} disabled={dis} value={settings[themeKey]}
        options={THEMES.map((th) => ({ data: th.id, label: th.name }))}
        onChange={(v) => onChange(saveSettings({ [themeKey]: v } as Partial<AchSettings>))}
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
    </>
  );
}

/** Sound picker + volume + test for one slot. */
function SoundSlotControls({
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

  const setPath = (path: string) => { onChange(saveSlot(which, { path })); void sound?.preload(path); };
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
        <ButtonItem layout="below" disabled={disabled || !slot.path} onClick={() => void sound?.playSlot(which)}>
          {t('sounds.test')}
        </ButtonItem>
      </PanelSectionRow>
    </>
  );
}

function SettingsPanel() {
  const lang = useLanguage();
  const [s, setS] = useState<AchSettings>(() => getSettings());
  const [builtins, setBuiltins] = useState<BuiltinSound[]>([]);

  useEffect(() => {
    call<[], BuiltinSound[] | { error: string }>('list_builtin_sounds')
      .then((res) => { if (Array.isArray(res)) setBuiltins(res); })
      .catch(() => {});
  }, []);

  const update = (patch: Partial<AchSettings>) => setS(saveSettings(patch));

  return (
    <>
      <PanelSection title={t('app.title')}>
        <PanelSectionRow>
          <ToggleField label={t('app.enable')} checked={s.enabled} onChange={(v) => update({ enabled: v })} />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title={t('behavior.title')}>
        <PanelSectionRow>
          <ToggleField label={t('behavior.replaceNative')} description={t('behavior.replaceNativeDesc')}
            disabled={!s.enabled} checked={s.suppressNative} onChange={(v) => update({ suppressNative: v })} />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField label={t('behavior.showCommon')} description={t('behavior.showCommonDesc')}
            disabled={!s.enabled} checked={s.showForCommon} onChange={(v) => update({ showForCommon: v })} />
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField label={t('behavior.rareThreshold')} description={t('behavior.rareThresholdDesc')}
            disabled={!s.enabled} value={s.rareThreshold} min={1} max={50} step={1} showValue
            onChange={(v) => update({ rareThreshold: v })} />
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField label={t('behavior.duration')} disabled={!s.enabled}
            value={Math.round(s.durationMs / 1000)} min={3} max={15} step={1} showValue
            onChange={(v) => update({ durationMs: v * 1000 })} />
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField label={t('behavior.width')} disabled={!s.enabled}
            value={s.width} min={300} max={820} step={20} showValue onChange={(v) => update({ width: v })} />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title={t('appearance.title')}>
        <Dropdown label={t('appearance.position')} disabled={!s.enabled} value={s.position}
          options={POSITIONS.map((p) => ({ data: p.id, label: t(`pos.${p.id}` as any) }))}
          onChange={(v) => update({ position: v })} />
        <Dropdown label={t('appearance.layout')} disabled={!s.enabled} value={s.layout}
          options={LAYOUTS.map((l) => ({ data: l.id, label: l.name }))}
          onChange={(v) => update({ layout: v })} />
      </PanelSection>

      <PanelSection title={t('common.title')}>
        <LookControls tier="common" settings={s} onChange={setS} />
      </PanelSection>
      <PanelSection title={t('rare.title')}>
        <LookControls tier="rare" settings={s} onChange={setS} />
      </PanelSection>

      <PanelSection title={t('sounds.title')}>
        <PanelSectionRow>
          <SliderField label={t('sounds.master')} disabled={!s.enabled}
            value={s.masterVolume} min={0} max={100} step={5} showValue onChange={(v) => update({ masterVolume: v })} />
        </PanelSectionRow>
        <SoundSlotControls which="soundCommon" label={t('sounds.common')} settings={s} builtins={builtins} onChange={setS} />
        <SoundSlotControls which="soundRare" label={t('sounds.rare')} settings={s} builtins={builtins} onChange={setS} />
      </PanelSection>

      <PanelSection title={t('preview.title')}>
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={!s.enabled} onClick={() => watcher?.simulate(false)}>
            {t('preview.common')}
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={!s.enabled} onClick={() => watcher?.simulate(true)}>
            {t('preview.rare')}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title={t('advanced.title')}>
        <PanelSectionRow>
          <ToggleField label={t('advanced.debug')} description={t('advanced.debugDesc')}
            checked={s.debug} onChange={(v) => update({ debug: v })} />
        </PanelSectionRow>
      </PanelSection>

      <LanguageSection />

      <PanelSection>
        <UpdateCheckButton repo="K1tsune12/decky-trophy-toasts" pluginName="Decky Trophy Toasts" lang={lang} />
      </PanelSection>
    </>
  );
}

function LanguageSection() {
  const lang = useLanguage();
  const [setting, setSetting] = useState<LangSetting>(getLangSetting);
  const [steamLang, setSteamLang] = useState<Lang>(lang);
  useEffect(() => { void steamLanguageNow().then(setSteamLang); }, []);
  return (
    <PanelSection title={t('lang.title')}>
      <PanelSectionRow>
        <DropdownItem
          label={t('lang.label')}
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

export default definePlugin(() => {
  void initLanguage();
  toast = new ToastWindow();
  sound = new SoundPlayer();
  sound.preloadEnabled();
  watcher = new AchievementWatcher(toast, sound);
  if (!watcher.init()) {
    console.warn('[achievement-toasts] watcher disabled this session (see logs above)');
  }

  return {
    name: 'Decky Trophy Toasts',
    titleView: <div className={staticClasses.Title}>Decky Trophy Toasts</div>,
    content: <SettingsPanel />,
    icon: <FaTrophy />,
    onDismount() {
      watcher?.deinit();
      toast?.deinit();
      sound?.deinit();
      watcher = undefined;
      toast = undefined;
      sound = undefined;
    },
  };
});
