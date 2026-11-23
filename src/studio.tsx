// Full-page "Studio": a roomy settings page (reached from the Quick Access panel)
// with a live in-page preview of the toast pinned at the top, and the settings
// split across native Tabs (Look = per-tier appearance; General = shared) so the
// controller's L1/R1 tab switching behaves correctly.

import { ButtonItem, DialogButton, Focusable, Navigation, PanelSection, PanelSectionRow, SliderField, Tabs, TextField, ToggleField } from '@decky/ui';
import { useEffect, useMemo, useState } from 'react';
import { FaArrowLeft, FaVolumeMute, FaVolumeUp } from 'react-icons/fa';

import { Dropdown, LanguageSection, LookEditor, SoundSlotControls, useBuiltinSounds } from './components';
import { t, tr, useLanguage } from './i18n';
import { Preset, allPresets, buildOpts, presetPatchTier, presetsForTier, tierLook } from './presets';
import { runtime } from './runtime';
import { AchSettings, deleteCustomPreset, getSettings, saveMasterPreset, saveSettings, saveTierPreset, setGamePreset } from './settings';
import { LAYOUTS, POSITIONS, getTheme, resolveAccent } from './themes';
import { ToastData, renderPreviewHtml } from './toastWindow';

const w = window as any;

const PREVIEW_W = 560;

// Steam's native Tabs (1) slide the content on switch (a transform) AND cross-fade
// it — with a focused row below, the slide + focus motion look torn, so we kill the
// transform and keep the clean fade (same fix as Deck Animations); and (2) pad the
// content area very generously (58px top / 40px bottom), which wastes vertical
// space, so we tighten it.
const TABS_FIX_CSS = [
  '.ktt-studio :has(> * > ._TabContentsScroll){transform:none !important;}',
  // keep the native top clearance (the tab bar is a 58px absolute overlay), just
  // trim the oversized bottom padding.
  '.ktt-studio ._TabContentsScroll{padding-bottom:22px !important;}',
].join('');

function appName(appid: number | string): string {
  try {
    const n = w.appStore?.GetAppOverviewByAppID?.(Number(appid))?.display_name as string;
    if (n) return n;
  } catch { /* ignore */ }
  return `App ${appid}`;
}

function previewData(rare: boolean): ToastData {
  const pct = rare ? 2.3 : 47.5;
  return {
    name: rare ? tr('toast.sampleRare') : tr('toast.sampleCommon'),
    pct,
    rarityText: tr('toast.rarity', { pct: String(pct) }),
  };
}

function presetSwatch(p: Preset): string {
  const look = p.rare || p.common;
  if (!look) return 'linear-gradient(135deg,#555,#333)';
  const [a, b] = resolveAccent(getTheme(look.theme), look.accent);
  return `linear-gradient(135deg,${a},${b})`;
}

/** Short tag for a saved preset's scope. */
function presetScopeTag(p: Preset): string {
  if (p.scope === 'both') return t('presets.tagMaster');
  if (p.scope === 'rare') return t('presets.tagRare');
  return t('presets.tagCommon');
}

export function TrophyStudio() {
  useLanguage();
  const [s, setS] = useState<AchSettings>(() => getSettings());
  const [rareTier, setRareTier] = useState(false);
  const [tab, setTab] = useState('look');
  const [nonce, setNonce] = useState(0);
  const [previewSound, setPreviewSound] = useState(true);
  const [frameH, setFrameH] = useState(132);
  const [game, setGame] = useState<{ appid: number; name: string } | null>(null);
  const [presetName, setPresetName] = useState('');
  const builtins = useBuiltinSounds();

  // Poll the currently-running game (for the per-game section).
  useEffect(() => {
    const read = () => {
      try { setGame(w.__kitsuneAchievementToasts?.currentGame?.() ?? null); } catch { setGame(null); }
    };
    read();
    const iv = setInterval(read, 2000);
    return () => clearInterval(iv);
  }, []);

  const bump = () => setNonce((n) => n + 1);
  const update = (patch: Partial<AchSettings>) => setS(saveSettings(patch));

  // Only VISUAL settings affect the preview — key the memo on just those so that
  // changing sound/volume/duration/threshold never recomputes it (which would
  // reload the iframe and make the card flash/disappear). nonce forces a replay.
  const look = tierLook(s, rareTier);
  const previewKey = JSON.stringify([look, s.width, s.position, s.layout, rareTier, nonce]);
  const html = useMemo(
    // The nonce marker makes the srcDoc change on Replay/tier/preset changes so the
    // iframe reloads and the entrance animation plays again; it stays out of the key
    // deps otherwise, so sound/volume/duration changes never reload (no flicker).
    () => renderPreviewHtml(previewData(rareTier), buildOpts(s, rareTier, look)) + `<!--p${nonce}-->`,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [previewKey],
  );

  const applyPreset = (p: Preset) => { setS(saveSettings(presetPatchTier(p, rareTier))); bump(); };
  // Apply a saved preset to whichever tier(s) it carries (master = both).
  const applySaved = (p: Preset) => {
    setS(saveSettings({ ...presetPatchTier(p, false), ...presetPatchTier(p, true) }));
    bump();
  };
  const doSave = (scope: 'common' | 'rare' | 'both') => {
    const nm = presetName.trim();
    if (scope === 'both') setS(saveMasterPreset(nm, tierLook(s, false), tierLook(s, true)));
    else setS(saveTierPreset(nm, scope, tierLook(s, scope === 'rare')));
    setPresetName('');
  };
  const testOnScreen = () => { try { w.__kitsuneAchievementToasts?.simulate?.(rareTier); } catch { /* ignore */ } };
  // Replay the in-panel preview; optionally play the tier's sound alongside it.
  const replay = () => { bump(); if (previewSound) { try { void runtime.sound?.play(rareTier); } catch { /* ignore */ } } };

  // Size the preview iframe to hug the card, with enough slack for its glow/outline.
  // Re-measure after a beat so late web-font loads (display fonts) don't get clipped.
  const fitPreview = (e: any) => {
    const el = e?.currentTarget as HTMLIFrameElement | undefined;
    if (!el) return;
    const measure = () => {
      try {
        const card = el.contentDocument?.getElementById('card') as HTMLElement | null;
        const h = card ? card.offsetHeight : 0;
        if (h > 0) setFrameH(h + 44);   // state -> survives re-renders, no reset/flicker
      } catch { /* ignore */ }
    };
    measure();
    setTimeout(measure, 450);
  };

  const presets = allPresets();
  const overrides = Object.entries(s.gamePresets || {});
  const saved = [...s.customPresets].reverse();
  const presetLabel = (p: Preset) => (p.scope && p.scope !== 'both' ? `${p.name} [${presetScopeTag(p)}]` : p.name);
  const tierOptions = (rare: boolean) => [
    { data: '', label: t('studio.useDefault') },
    ...presetsForTier(rare).map((p) => ({ data: p.id, label: presetLabel(p) })),
  ];
  const presetNameById = (id?: string) => (id ? (presets.find((x) => x.id === id)?.name ?? id) : '—');
  const previewW = Math.min(s.width, PREVIEW_W);
  const tierName = rareTier ? t('studio.tierRare') : t('studio.tierCommon');
  const pad = { maxWidth: 900, margin: '0 auto', padding: '4px 2.6vw 40px' } as const;

  // ---- Look tab: everything tied to the selected tier (common/rare) ----
  const lookTab = (
    <div style={pad}>
      <PanelSection title={t('studio.presets')}>
        <PanelSectionRow>
          <div style={{ fontSize: 12, opacity: 0.6, paddingBottom: 6 }}>
            {t('studio.presetsDesc')} <b style={{ opacity: 0.95 }}>{tierName}</b>
          </div>
        </PanelSectionRow>
        <Focusable style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {presets.map((p) => (
            <DialogButton
              key={p.id}
              style={{ flex: '1 1 46%', minWidth: 190, height: 46, display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', textAlign: 'left' }}
              onClick={() => applyPreset(p)}
            >
              <span style={{ width: 16, height: 16, borderRadius: 4, flex: '0 0 auto', background: presetSwatch(p), boxShadow: '0 0 6px rgba(0,0,0,0.5)' }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
            </DialogButton>
          ))}
        </Focusable>
      </PanelSection>

      <PanelSection title={`${t('studio.edit')} — ${tierName}`}>
        <LookEditor tier={rareTier ? 'rare' : 'common'} settings={s} onChange={setS} />
        <PanelSectionRow>
          <SliderField
            label={rareTier ? t('behavior.durationRare') : t('behavior.durationCommon')} disabled={!s.enabled}
            value={Math.round((rareTier ? s.durationRareMs : s.durationCommonMs) / 1000)} min={2} max={15} step={1} showValue
            onChange={(v) => update(rareTier ? { durationRareMs: v * 1000 } : { durationCommonMs: v * 1000 })}
          />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title={`${t('sounds.title')} — ${tierName}`}>
        <SoundSlotControls
          which={rareTier ? 'soundRare' : 'soundCommon'}
          label={rareTier ? t('sounds.rare') : t('sounds.common')}
          settings={s} builtins={builtins} onChange={setS}
        />
      </PanelSection>
    </div>
  );

  // ---- General tab: shared settings not tied to a single tier ----
  const generalTab = (
    <div style={pad}>
      <PanelSection title={t('appearance.title')}>
        <Dropdown label={t('appearance.position')} disabled={!s.enabled} value={s.position}
          options={POSITIONS.map((p) => ({ data: p.id, label: t(`pos.${p.id}` as any) }))}
          onChange={(v) => update({ position: v })} />
        <Dropdown label={t('appearance.layout')} disabled={!s.enabled} value={s.layout}
          options={LAYOUTS.map((l) => ({ data: l.id, label: l.name }))}
          onChange={(v) => { update({ layout: v }); bump(); }} />
        <PanelSectionRow>
          <SliderField label={t('behavior.width')} disabled={!s.enabled}
            value={s.width} min={300} max={820} step={20} showValue onChange={(v) => { update({ width: v }); bump(); }} />
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
      </PanelSection>

      <PanelSection title={t('sounds.title')}>
        <PanelSectionRow>
          <SliderField label={t('sounds.master')} disabled={!s.enabled}
            value={s.masterVolume} min={0} max={100} step={5} showValue onChange={(v) => update({ masterVolume: v })} />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title={t('studio.perGame')}>
        <PanelSectionRow>
          <div style={{ fontSize: 12, opacity: 0.6, paddingBottom: 6 }}>{t('studio.perGameDesc')}</div>
        </PanelSectionRow>
        {game ? (
          <>
            <Dropdown
              label={`${t('studio.tierCommon')} — ${game.name}`}
              value={s.gamePresets?.[String(game.appid)]?.common ?? ''}
              options={tierOptions(false)}
              onChange={(v) => setS(setGamePreset(game.appid, 'common', v))}
            />
            <Dropdown
              label={`${t('studio.tierRare')} — ${game.name}`}
              value={s.gamePresets?.[String(game.appid)]?.rare ?? ''}
              options={tierOptions(true)}
              onChange={(v) => setS(setGamePreset(game.appid, 'rare', v))}
            />
          </>
        ) : (
          <PanelSectionRow>
            <div style={{ fontSize: 13, opacity: 0.55, padding: '4px 0' }}>{t('studio.noGame')}</div>
          </PanelSectionRow>
        )}

        {overrides.length > 0 && (
          <PanelSectionRow>
            <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.75, padding: '10px 0 4px' }}>{t('studio.overrides')}</div>
          </PanelSectionRow>
        )}
        {overrides.map(([appid, g]) => (
          <PanelSectionRow key={appid}>
            <Focusable style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 10 }}>
              <div style={{ minWidth: 0, overflow: 'hidden' }}>
                <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{appName(appid)}</div>
                <div style={{ fontSize: 12, opacity: 0.6 }}>
                  {t('studio.tierCommon')}: {presetNameById(g.common)} · {t('studio.tierRare')}: {presetNameById(g.rare)}
                </div>
              </div>
              <DialogButton
                style={{ width: 110, minWidth: 110, height: 34 }}
                onClick={() => { setGamePreset(appid, 'common', ''); setS(setGamePreset(appid, 'rare', '')); }}
              >
                {t('studio.remove')}
              </DialogButton>
            </Focusable>
          </PanelSectionRow>
        ))}
      </PanelSection>

      <PanelSection title={t('advanced.title')}>
        <PanelSectionRow>
          <ToggleField label={t('advanced.debug')} description={t('advanced.debugDesc')}
            checked={s.debug} onChange={(v) => update({ debug: v })} />
        </PanelSectionRow>
      </PanelSection>

      <LanguageSection />
      <div style={{ height: 20 }} />
      <ButtonItem layout="below" onClick={() => Navigation.NavigateBack()}>{t('studio.back')}</ButtonItem>
    </div>
  );

  // ---- Presets tab: save the current look as a named preset + manage saved ones ----
  const presetsTab = (
    <div style={pad}>
      <PanelSection title={t('presets.saveTitle')}>
        <PanelSectionRow>
          <div style={{ fontSize: 12, opacity: 0.6, paddingBottom: 6 }}>{t('presets.saveDesc')}</div>
        </PanelSectionRow>
        <PanelSectionRow>
          <TextField label={t('presets.name')} value={presetName}
            onChange={(e: any) => setPresetName(e?.target?.value ?? '')} />
        </PanelSectionRow>
        <Focusable style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '4px 0' }}>
          <DialogButton style={{ flex: '1 1 30%', minWidth: 120, height: 40 }} disabled={!presetName.trim()} onClick={() => doSave('common')}>{t('presets.saveCommon')}</DialogButton>
          <DialogButton style={{ flex: '1 1 30%', minWidth: 120, height: 40 }} disabled={!presetName.trim()} onClick={() => doSave('rare')}>{t('presets.saveRare')}</DialogButton>
          <DialogButton style={{ flex: '1 1 30%', minWidth: 120, height: 40 }} disabled={!presetName.trim()} onClick={() => doSave('both')}>{t('presets.saveMaster')}</DialogButton>
        </Focusable>
      </PanelSection>

      <PanelSection title={t('presets.savedTitle')}>
        {saved.length === 0 ? (
          <PanelSectionRow><div style={{ fontSize: 13, opacity: 0.55, padding: '4px 0' }}>{t('presets.none')}</div></PanelSectionRow>
        ) : saved.map((p) => (
          <PanelSectionRow key={p.id}>
            <Focusable style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 10 }}>
              <div style={{ minWidth: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 14, height: 14, borderRadius: 4, flex: '0 0 auto', background: presetSwatch(p) }} />
                <div style={{ minWidth: 0, overflow: 'hidden' }}>
                  <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                  <div style={{ fontSize: 11, opacity: 0.6 }}>{presetScopeTag(p)}</div>
                </div>
              </div>
              <Focusable style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
                <DialogButton style={{ width: 96, minWidth: 96, height: 34 }} onClick={() => applySaved(p)}>{t('presets.apply')}</DialogButton>
                <DialogButton style={{ width: 96, minWidth: 96, height: 34 }} onClick={() => setS(deleteCustomPreset(p.id))}>{t('presets.delete')}</DialogButton>
              </Focusable>
            </Focusable>
          </PanelSectionRow>
        ))}
      </PanelSection>
    </div>
  );

  return (
    <div className="ktt-studio" style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'linear-gradient(180deg,#141620,#0b0c0f)' }}>
      <style>{TABS_FIX_CSS}</style>
      {/* Fixed header + live preview — always visible, above the tabs.
          Top padding clears the Steam status bar (clock/battery) so the title row
          isn't cut off. */}
      <div style={{ flex: '0 0 auto', padding: '46px 2.6vw 6px' }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          <Focusable style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <DialogButton
              style={{ width: 40, minWidth: 40, height: 34, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              onClick={() => Navigation.NavigateBack()}
            >
              <FaArrowLeft />
            </DialogButton>
            <div style={{ fontSize: 18, fontWeight: 800, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t('studio.title')}
            </div>
            <Focusable style={{ display: 'flex', gap: 8 }}>
              <DialogButton style={{ minWidth: 96, height: 32, padding: '0 12px' }} onClick={() => { setRareTier(false); bump(); }}>
                {rareTier ? t('studio.tierCommon') : `• ${t('studio.tierCommon')}`}
              </DialogButton>
              <DialogButton style={{ minWidth: 80, height: 32, padding: '0 12px' }} onClick={() => { setRareTier(true); bump(); }}>
                {rareTier ? `• ${t('studio.tierRare')}` : t('studio.tierRare')}
              </DialogButton>
            </Focusable>
          </Focusable>

          <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: 10, padding: '8px 8px 6px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'center' }}>
              <iframe
                title="toast-preview"
                srcDoc={html}
                scrolling="no"
                onLoad={fitPreview}
                style={{ width: previewW, height: frameH, border: 'none', borderRadius: 8, background: '#0c0d10', display: 'block', zoom: 0.9 as any }}
              />
            </div>
            <Focusable style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: '0 0 auto' }}>
              <DialogButton style={{ minWidth: 150, height: 32 }} onClick={replay}>{t('studio.replay')}</DialogButton>
              <DialogButton style={{ minWidth: 150, height: 32 }} onClick={testOnScreen}>{t('studio.testDevice')}</DialogButton>
              <DialogButton
                style={{ minWidth: 150, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: previewSound ? 1 : 0.55 }}
                onClick={() => setPreviewSound((v) => !v)}
              >
                {previewSound ? <FaVolumeUp /> : <FaVolumeMute />}
                <span style={{ fontSize: 12 }}>{previewSound ? t('studio.sndOn') : t('studio.sndOff')}</span>
              </DialogButton>
            </Focusable>
          </div>
        </div>
      </div>

      {/* Tabs fill the rest; native Tabs handle L1/R1 + focus correctly */}
      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        <Tabs
          activeTab={tab}
          onShowTab={(id: string) => setTab(id)}
          tabs={[
            { id: 'look', title: t('studio.tabLook'), content: lookTab },
            { id: 'presets', title: t('studio.tabPresets'), content: presetsTab },
            { id: 'general', title: t('studio.tabGeneral'), content: generalTab },
          ]}
        />
      </div>
    </div>
  );
}
