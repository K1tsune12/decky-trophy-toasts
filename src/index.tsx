import { definePlugin, routerHook } from '@decky/api';
import {
  ButtonItem,
  DialogButton,
  Focusable,
  Navigation,
  PanelSection,
  PanelSectionRow,
  ToggleField,
  staticClasses,
} from '@decky/ui';
import { useState } from 'react';
import { FaCog, FaTrophy } from 'react-icons/fa';

import { AchievementWatcher } from './achievements';
import { initLanguage, t, useLanguage } from './i18n';
import { initSettingsSync, stopSettingsSync } from './offline';
import { runtime } from './runtime';
import { AchSettings, getSettings, saveSettings } from './settings';
import { SoundPlayer } from './sound';
import { TrophyStudio } from './studio';
import { ToastWindow } from './toastWindow';
import { UpdateCheckButton } from './updateCheck';

const STUDIO_ROUTE = '/decky-trophy-toasts';

let toast: ToastWindow | undefined;
let sound: SoundPlayer | undefined;
let watcher: AchievementWatcher | undefined;

function openStudio(): void {
  Navigation.CloseSideMenus();
  Navigation.Navigate(STUDIO_ROUTE);
}

/** Quick Access panel — just the essentials. Everything else lives in the Studio. */
function SettingsPanel() {
  const lang = useLanguage();
  const [s, setS] = useState<AchSettings>(() => getSettings());
  const update = (patch: Partial<AchSettings>) => setS(saveSettings(patch));

  return (
    <>
      <PanelSection title={t('app.title')}>
        <PanelSectionRow>
          <ToggleField label={t('app.enable')} checked={s.enabled} onChange={(v) => update({ enabled: v })} />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={!s.enabled} onClick={openStudio}>
            {t('studio.open')}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title={t('preview.title')}>
        <PanelSectionRow>
          <div style={{ fontSize: 12, opacity: 0.6, padding: '2px 0 4px' }}>{t('preview.gameNote')}</div>
        </PanelSectionRow>
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

      <PanelSection>
        <UpdateCheckButton repo="K1tsune12/decky-trophy-toasts" pluginName="Decky Trophy Toasts" lang={lang} />
      </PanelSection>
    </>
  );
}

export default definePlugin(() => {
  void initLanguage();
  void initSettingsSync();   // disk backup / restore of the settings
  toast = new ToastWindow();
  sound = new SoundPlayer();
  sound.preloadEnabled();
  runtime.sound = sound;
  watcher = new AchievementWatcher(toast, sound);
  if (!watcher.init()) {
    console.warn('[achievement-toasts] watcher disabled this session (see logs above)');
  }

  try { routerHook.addRoute(STUDIO_ROUTE, TrophyStudio, { exact: true }); } catch (e) { console.error('[achievement-toasts] addRoute failed', e); }
  try {
    const hook = (window as any).__kitsuneAchievementToasts;
    if (hook) hook.openStudio = openStudio;
  } catch { /* ignore */ }

  return {
    name: 'Decky Trophy Toasts',
    titleView: (
      <Focusable style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
        <div className={staticClasses.Title}>Decky Trophy Toasts</div>
        <DialogButton
          style={{ width: 32, minWidth: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={openStudio}
        >
          <FaCog />
        </DialogButton>
      </Focusable>
    ),
    content: <SettingsPanel />,
    icon: <FaTrophy />,
    onDismount() {
      try { routerHook.removeRoute(STUDIO_ROUTE); } catch { /* ignore */ }
      watcher?.deinit();
      stopSettingsSync();
      toast?.deinit();
      sound?.deinit();
      runtime.sound = undefined;
      watcher = undefined;
      toast = undefined;
      sound = undefined;
    },
  };
});
