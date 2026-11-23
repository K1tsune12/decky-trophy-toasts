// Watches for achievement unlocks, decides rarity, and drives the custom toast
// + sound. Suppresses Steam's native achievement toast and sound so only ours
// shows, and tells Decky Sound Toasts to skip achievements while we run.
//
// Rarity: Steam's client `flAchieved` is unreliable (0 when global stats aren't
// cached), so we use Steam's public Web API via the Python backend
// (get_global_achievement_pct, keyed by achievement apiname == strID). We
// pre-warm that per app on game launch so the toast shows with no network wait.

import { t } from './i18n';
import { enqueueOverlay, overlayDebug, renderCardDebug } from './overlay';
import { buildOpts, resolveLook } from './presets';
import { AchSettings, getSettings } from './settings';
import { SoundPlayer } from './sound';
import { ToastData, ToastOptions, ToastWindow, renderPreviewHtml } from './toastWindow';

const w = window as any;
const ACHIEVEMENT_ETYPE = 5;

function findOwner(obj: any, prop: string): any {
  let o = obj;
  while (o) {
    if (Object.prototype.hasOwnProperty.call(o, prop)) return o;
    o = Object.getPrototypeOf(o);
  }
  return null;
}

function extractAchievements(res: any): any[] {
  if (!res) return [];
  const cands = [res, res.data, res.data?.rgAchievements, res.data?.achievements, res.rgAchievements, res.achievements];
  for (const c of cands) {
    if (Array.isArray(c) && c.length && typeof c[0] === 'object') return c;
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      const vals = Object.values(c).filter((v) => v && typeof v === 'object' && 'strName' in (v as any));
      if (vals.length) return vals as any[];
    }
  }
  return [];
}

function fmtPct(pct: number): string {
  return pct < 0.1 ? '<0.1' : pct.toFixed(1);
}

interface Resolved { strID?: string; name: string; icon?: string; flAchieved?: number }

export class AchievementWatcher {
  private reg?: { unregister: () => void };
  private appReg?: { unregister: () => void };
  private restoreToast?: () => void;
  private restoreSound?: () => void;
  private pctCache = new Map<string, Record<string, number>>();
  private currentAppId = 0;

  constructor(
    private readonly toast: ToastWindow,
    private readonly sound: SoundPlayer,
  ) {}

  init(): boolean {
    let ok = false;
    try {
      this.reg = w.SteamClient?.GameSessions?.RegisterForAchievementNotification?.((p: any) => {
        try { void this.onUnlock(p); } catch (e) { console.error('[achievement-toasts] onUnlock error', e); }
      });
      ok = !!this.reg;
    } catch (e) {
      console.error('[achievement-toasts] register failed', e);
    }

    // pre-warm rarity when a game starts, so unlocks show instantly
    try {
      this.appReg = w.SteamClient?.GameSessions?.RegisterForAppLifetimeNotifications?.((u: any) => {
        try {
          if (u?.unAppID && u?.bRunning) { this.currentAppId = u.unAppID; void this.ensurePct(u.unAppID); }
          else if (u?.unAppID && !u?.bRunning && u.unAppID === this.currentAppId) { this.currentAppId = 0; }
        } catch { /* ignore */ }
      });
    } catch { /* optional */ }

    this.installSuppression();
    // Cross-plugin flag so Decky Sound Toasts skips achievements while we run.
    // `simulate` doubles as the Preview buttons' action and a safe external hook.
    w.__kitsuneAchievementToasts = {
      active: true,
      simulate: (rare: boolean) => this.simulate(!!rare),
      preview: (style: any) => this.preview(style || {}),
      currentGame: () => this.currentGame(),
      overlayDebug: (rare: boolean) => {
        const s = getSettings();
        const pct = rare ? 2.3 : 47.5;
        const name = rare ? t('toast.sampleRare') : t('toast.sampleCommon');
        return overlayDebug(this.toData(name, undefined, pct), this.opts(!!rare, s));
      },
      // Test harness (preview-vs-overlay parity): the in-panel preview HTML and the
      // over-game card PNG for a given style override. Shows nothing on screen.
      renderDebug: async (rare: boolean, style: any) => {
        const s = getSettings();
        const pct = rare ? 2.3 : 47.5;
        const name = rare ? t('toast.sampleRare') : t('toast.sampleCommon');
        const data = this.toData(name, undefined, pct);
        const o: ToastOptions = { ...this.opts(!!rare, s), ...(style || {}) };
        delete (o as any).onShow;
        return { previewHtml: renderPreviewHtml(data, o), card: await renderCardDebug(data, o) };
      },
    };
    return ok;
  }

  // Rarity = global unlock % per achievement, keyed by apiname (== strID). We
  // fetch Steam's public Web API from the frontend (CEF has working SSL; Python's
  // urllib on the Deck can't verify certs). Only the appid leaves the device.
  private async ensurePct(appid: number | string): Promise<Record<string, number>> {
    const k = String(appid);
    const cached = this.pctCache.get(k);
    if (cached) return cached;
    try {
      const url = 'https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/?gameid='
        + Number(appid) + '&format=json';
      const r = await fetch(url);
      if (r.ok) {
        const j = await r.json();
        const rows = (j && j.achievementpercentages && j.achievementpercentages.achievements) || [];
        const pct: Record<string, number> = {};
        for (const x of rows) {
          const n = x && x.name;
          const p = parseFloat(x && x.percent);
          if (n != null && isFinite(p)) pct[String(n)] = p;
        }
        this.pctCache.set(k, pct);
        return pct;
      }
    } catch (e) {
      console.warn('[achievement-toasts] rarity fetch failed', e);
    }
    return {};
  }

  private installSuppression(): void {
    const store = w.NotificationStore;
    if (!store) return;
    try {
      const owner = findOwner(store, 'BShowToast');
      const orig = owner?.BShowToast;
      if (typeof orig === 'function') {
        const patched = function (this: any, ...args: any[]) {
          try {
            const s = getSettings();
            const notif = args.find((a) => a && typeof a === 'object' && 'eType' in a);
            if (s.enabled && s.suppressNative && notif?.eType === ACHIEVEMENT_ETYPE) return false;
          } catch { /* ignore */ }
          return orig.apply(this, args);
        };
        try { (patched as any).toString = () => orig.toString(); } catch { /* ignore */ }
        owner.BShowToast = patched;
        this.restoreToast = () => { owner.BShowToast = orig; };
      }
    } catch (e) { console.error('[achievement-toasts] patch BShowToast failed', e); }

    try {
      const owner = findOwner(store, 'PlayNotificationSound');
      const orig = owner?.PlayNotificationSound;
      if (typeof orig === 'function') {
        const patched = function (this: any, ...args: any[]) {
          try {
            const s = getSettings();
            if (s.enabled && s.suppressNative && args?.[0]?.eType === ACHIEVEMENT_ETYPE) return;
          } catch { /* ignore */ }
          return orig.apply(this, args);
        };
        try { (patched as any).toString = () => orig.toString(); } catch { /* ignore */ }
        owner.PlayNotificationSound = patched;
        this.restoreSound = () => { owner.PlayNotificationSound = orig; };
      }
    } catch (e) { console.error('[achievement-toasts] patch PlayNotificationSound failed', e); }
  }

  private async onUnlock(p: any): Promise<void> {
    const s = getSettings();
    if (!s.enabled) return;
    const appid: number = p?.unAppID ?? p?.nAppID ?? p?.appid ?? 0;
    if (s.debug) console.log('[achievement-toasts] unlock event', appid, p);
    if (!appid) return;

    const ach = await this.resolveAchievement(appid, p);

    // rarity: prefer the Web-API global %, fall back to the (unreliable) client value
    let pct: number | undefined;
    const map = this.pctCache.get(String(appid)) ?? (await this.ensurePct(appid));
    if (ach.strID && typeof map[ach.strID] === 'number') pct = map[ach.strID];
    else if (typeof ach.flAchieved === 'number' && ach.flAchieved > 0) pct = ach.flAchieved;

    const rare = typeof pct === 'number' && isFinite(pct) ? pct < s.rareThreshold : false;
    if (!rare && !s.showForCommon) return;

    const data = this.toData(ach.name, ach.icon, pct);
    const opts = this.opts(rare, s, appid);
    // Queue for the over-game overlay (composites above the running game); multiple
    // unlocks play one at a time, in order. Falls back to our popup window per item.
    enqueueOverlay(data, opts, () => this.toast.show(data, opts));
  }

  private async resolveAchievement(appid: number, p: any): Promise<Resolved> {
    const pName = p?.strName || p?.strDisplayName || p?.display_name;
    const pImg = p?.strImage || p?.strIcon || p?.icon;
    const pID = p?.strID || p?.achievement_id || p?.strAchievementID || p?.strApiName;
    if (pName) return { strID: pID, name: pName, icon: pImg, flAchieved: p?.flAchieved };

    try {
      const res = await w.SteamClient?.Apps?.GetMyAchievementsForApp?.(String(appid));
      const list = extractAchievements(res).filter((a) => a?.bAchieved);
      const ach = (pID && list.find((a) => a.strID === pID)) ||
        list.slice().sort((a, b) => (b.rtUnlocked || 0) - (a.rtUnlocked || 0))[0];
      if (ach) return { strID: ach.strID, name: ach.strName, icon: ach.strImage, flAchieved: ach.flAchieved };
    } catch (e) {
      console.error('[achievement-toasts] resolveAchievement failed', e);
    }
    return { strID: pID, name: pName || t('toast.unlocked'), icon: pImg, flAchieved: p?.flAchieved };
  }

  private toData(name: string, icon: string | undefined, pct: number | undefined): ToastData {
    return {
      name,
      icon,
      pct,
      rarityText: typeof pct === 'number' && isFinite(pct) ? t('toast.rarity', { pct: fmtPct(pct) }) : undefined,
    };
  }

  private opts(rare: boolean, s: AchSettings, appid?: number): ToastOptions {
    const o = buildOpts(s, rare, resolveLook(s, rare, appid));
    o.onShow = () => { void this.sound.play(rare); };
    return o;
  }

  /** The currently-running game (for the per-game preset UI), or null. */
  currentGame(): { appid: number; name: string } | null {
    const appid = this.currentAppId;
    if (!appid) return null;
    let name = '';
    try { name = (w.appStore?.GetAppOverviewByAppID?.(appid)?.display_name as string) || ''; } catch { /* ignore */ }
    return { appid, name: name || `App ${appid}` };
  }

  /** Demo toast for the Test buttons — shows over the game via the overlay helper
   *  (falls back to our popup window if the overlay can't run). */
  simulate(rare: boolean): void {
    const s = getSettings();
    const pct = rare ? 2.3 : 47.5;
    const name = rare ? t('toast.sampleRare') : t('toast.sampleCommon');
    const data = this.toData(name, undefined, pct);
    const opts = this.opts(rare, s);
    enqueueOverlay(data, opts, () => this.toast.show(data, opts));
  }

  /** Preview a specific theme/effect/ambient (doesn't touch saved settings). */
  preview(style: any): void {
    const s = getSettings();
    const rare = !!style.rare;
    const name = style.name || (rare ? t('toast.sampleRare') : t('toast.sampleCommon'));
    const pct = typeof style.pct === 'number' ? style.pct : rare ? 2.3 : 47.5;
    this.toast.show(this.toData(name, style.icon, pct), {
      rare,
      durationMs: style.durationMs ?? (rare ? s.durationRareMs : s.durationCommonMs),
      width: style.width ?? s.width,
      position: style.position ?? s.position,
      layout: style.layout ?? s.layout,
      themeId: style.themeId ?? (rare ? s.themeRare : s.themeCommon),
      animId: style.animId ?? (rare ? s.animRare : s.animCommon),
      accentId: style.accentId ?? (rare ? s.accentRare : s.accentCommon),
      ambient: style.ambient ?? (rare ? s.ambientRare : s.ambientCommon),
      font: style.font ?? (rare ? s.fontRare : s.fontCommon),
      fxColor: style.fxColor ?? (rare ? s.fxColorRare : s.fxColorCommon),
      border: style.border,
      fx: style.fx ?? (rare ? s.fxRare : s.fxCommon),
      eyebrow: rare ? t('toast.rareUnlocked') : t('toast.unlocked'),
      badge: t('toast.rareBadge'),
      onShow: () => { void this.sound.play(rare); },
    });
  }

  deinit(): void {
    try { this.reg?.unregister?.(); } catch { /* ignore */ }
    try { this.appReg?.unregister?.(); } catch { /* ignore */ }
    this.reg = undefined;
    this.appReg = undefined;
    try { this.restoreToast?.(); } catch { /* ignore */ }
    try { this.restoreSound?.(); } catch { /* ignore */ }
    this.restoreToast = undefined;
    this.restoreSound = undefined;
    try { delete w.__kitsuneAchievementToasts; } catch { w.__kitsuneAchievementToasts = undefined; }
  }
}
