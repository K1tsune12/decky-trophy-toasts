// Watches for achievement unlocks, decides rarity, and drives the custom toast
// + sound. Suppresses Steam's native achievement toast and sound so only ours
// shows, and tells Decky Sound Toasts to skip achievements while we run.
//
// Rarity (global unlock %), keyed by achievement apiname (== strID), comes from the
// first source that has it: Steam's public Web API (fetched from the frontend with
// a short deadline), our on-disk cache of it, then the Steam client's own cached
// value. It is pre-warmed per app on game launch — together with the achievement
// icons — so an unlock shows instantly and complete even when the Deck is offline.

import { t } from './i18n';
import { ensureFont, fetchWithTimeout, prewarmIcons, rarityFromDisk, rarityToDisk } from './offline';
import { checkOverlay, clearOverlayQueue, enqueueOverlay, isOverlayHealthy, overlayDebug, refreshDisplay, renderCardDebug } from './overlay';
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

interface Resolved { strID?: string; name: string; icon?: string; flAchieved?: number; desc?: string }

// Steam sends the same notification for an achievement *progress* update ("5/10",
// IndicateAchievementProgress) as for an unlock: same event, same toast type. The only
// difference is that the achievement is not achieved yet. Those are not ours to show.
let lastProgressAt = 0;

/** The achievement carried by an unlock/progress event ({unAppID, achievement:{…}}). */
function eventAchievement(p: any): any {
  return p && typeof p.achievement === 'object' && p.achievement ? p.achievement : p;
}

function isProgressEvent(p: any): boolean {
  return eventAchievement(p)?.bAchieved === false;
}

/** Whether the notification Steam is about to toast is a progress update. */
function isProgressToast(notif: any): boolean {
  try {
    const d = notif?.data;
    const o = d && typeof d.toObject === 'function' ? d.toObject() : null;
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        if (/achieved$/i.test(k) && typeof o[k] === 'boolean') return o[k] === false;
      }
    }
    const arr = d?.array;                       // protobuf storage: [id, appid, name, desc, image, achieved, …]
    if (Array.isArray(arr) && typeof arr[5] === 'boolean') return arr[5] === false;
  } catch { /* fall through */ }
  return Date.now() - lastProgressAt < 400;      // the event fires right before the toast
}

export class AchievementWatcher {
  private reg?: { unregister: () => void };
  private appReg?: { unregister: () => void };
  private restoreToast?: () => void;
  private restoreSound?: () => void;
  private pctCache = new Map<string, Record<string, number>>();
  private pctJobs = new Map<string, Promise<Record<string, number>>>();
  private netDownUntil = 0;   // after a failed request, skip the network for a while
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
          if (u?.unAppID && u?.bRunning) this.onGameStart(u.unAppID);
          else if (u?.unAppID && !u?.bRunning && u.unAppID === this.currentAppId) { this.currentAppId = 0; }
        } catch { /* ignore */ }
      });
    } catch { /* optional */ }
    // A game may already be running when the plugin (re)loads.
    try {
      const running = Number(w.SteamUIStore?.MainRunningAppID ?? w.SteamUIStore?.MainRunningApp?.appid ?? 0);
      if (running) this.onGameStart(running);
    } catch { /* optional */ }
    // Fonts of the looks in use, so the first toast never waits for them.
    try {
      const s0 = getSettings();
      for (const rare of [false, true]) void ensureFont(resolveLook(s0, rare).font);
    } catch { /* optional */ }

    this.installSuppression();
    void checkOverlay();     // can the over-game helper run here at all?
    void refreshDisplay();   // real output resolution (dock / TV)
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
        const data = this.toData(name, undefined, pct, rare ? t('toast.sampleDescRare') : t('toast.sampleDescCommon'));
        const o: ToastOptions = { ...this.opts(!!rare, s), ...(style || {}) };
        delete (o as any).onShow;
        await ensureFont(o.font);
        return { previewHtml: renderPreviewHtml(data, o), card: await renderCardDebug(data, o) };
      },
    };
    return ok;
  }

  /** Warm everything an unlock in this game will need. */
  private onGameStart(appid: number): void {
    this.currentAppId = appid;
    void refreshDisplay();   // the output may have changed (docked / undocked)
    void this.ensurePct(appid);
    this.preloadGameSounds(appid);
    try {
      const s = getSettings();
      for (const rare of [false, true]) void ensureFont(resolveLook(s, rare, appid).font);
    } catch { /* optional */ }
    void this.prewarmGameIcons(appid);
  }

  /** Cache the icons of this game's achievements on disk (for offline unlocks). */
  private async prewarmGameIcons(appid: number): Promise<void> {
    try {
      const res = await w.SteamClient?.Apps?.GetMyAchievementsForApp?.(String(appid));
      const list = extractAchievements(res);
      // still-locked ones first: those are the ones that can pop
      list.sort((a, b) => Number(!!a?.bAchieved) - Number(!!b?.bAchieved));
      await prewarmIcons(list.map((a) => String(a?.strImage || '')).filter(Boolean));
    } catch { /* best effort */ }
  }

  // Rarity = global unlock % per achievement, keyed by apiname (== strID). Sources,
  // in order: Steam's public Web API (from the frontend — CEF has working SSL,
  // Python's urllib on the Deck can't verify certs; only the appid leaves the
  // device), our disk cache of it, the Steam client's own cached value.
  private ensurePct(appid: number | string): Promise<Record<string, number>> {
    const k = String(appid);
    const cached = this.pctCache.get(k);
    if (cached) return Promise.resolve(cached);
    let job = this.pctJobs.get(k);
    if (!job) {
      job = this.loadPct(k).finally(() => this.pctJobs.delete(k));
      this.pctJobs.set(k, job);
    }
    return job;
  }

  private async loadPct(k: string): Promise<Record<string, number>> {
    let map: Record<string, number> | undefined;
    if (navigator.onLine !== false && Date.now() >= this.netDownUntil) {
      try {
        const url = 'https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/?gameid='
          + Number(k) + '&format=json';
        const r = await fetchWithTimeout(url, 2500);
        if (r.ok) {
          const j = await r.json();
          const rows = (j && j.achievementpercentages && j.achievementpercentages.achievements) || [];
          const pct: Record<string, number> = {};
          for (const x of rows) {
            const n = x && x.name;
            const p = parseFloat(x && x.percent);
            if (n != null && isFinite(p)) pct[String(n)] = p;
          }
          map = pct;
          rarityToDisk(k, pct);
        }
      } catch (e) {
        this.netDownUntil = Date.now() + 60000;
        console.warn('[achievement-toasts] rarity fetch failed (using cache)', e);
      }
    }
    const empty = (m?: Record<string, number>) => !m || !Object.keys(m).length;
    if (empty(map)) map = (await rarityFromDisk(k)) ?? map;
    if (empty(map)) map = await this.clientPct(k);
    if (!empty(map)) this.pctCache.set(k, map as Record<string, number>);
    return map ?? {};
  }

  /** The Steam client's own cached global % (present once Steam has synced the game). */
  private async clientPct(k: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    try {
      const res = await w.SteamClient?.Apps?.GetMyAchievementsForApp?.(k);
      for (const a of extractAchievements(res)) {
        if (a?.strID && typeof a.flAchieved === 'number' && a.flAchieved > 0) out[String(a.strID)] = a.flAchieved;
      }
    } catch { /* ignore */ }
    return out;
  }

  private installSuppression(): void {
    const store = w.NotificationStore;
    if (!store) return;
    try {
      const owner = findOwner(store, 'BShowToast');
      const orig = owner?.BShowToast;
      if (typeof orig === 'function') {
        let live = true;
        const patched = function (this: any, ...args: any[]) {
          try {
            const s = getSettings();
            const notif = args.find((a) => a && typeof a === 'object' && 'eType' in a);
            if (live && s.enabled && s.suppressNative && isOverlayHealthy() && notif?.eType === ACHIEVEMENT_ETYPE
              && !isProgressToast(notif)) return false;
          } catch { /* ignore */ }
          return orig.apply(this, args);
        };
        try { (patched as any).toString = () => orig.toString(); } catch { /* ignore */ }
        owner.BShowToast = patched;
        // If another plugin patched over us, leave the chain alone and just go inert.
        this.restoreToast = () => { live = false; if (owner.BShowToast === patched) owner.BShowToast = orig; };
      }
    } catch (e) { console.error('[achievement-toasts] patch BShowToast failed', e); }

    try {
      const owner = findOwner(store, 'PlayNotificationSound');
      const orig = owner?.PlayNotificationSound;
      if (typeof orig === 'function') {
        let live = true;
        const patched = function (this: any, ...args: any[]) {
          try {
            const s = getSettings();
            if (live && s.enabled && s.suppressNative && isOverlayHealthy() && args?.[0]?.eType === ACHIEVEMENT_ETYPE
              && !isProgressToast(args[0])) return;
          } catch { /* ignore */ }
          return orig.apply(this, args);
        };
        try { (patched as any).toString = () => orig.toString(); } catch { /* ignore */ }
        owner.PlayNotificationSound = patched;
        this.restoreSound = () => { live = false; if (owner.PlayNotificationSound === patched) owner.PlayNotificationSound = orig; };
      }
    } catch (e) { console.error('[achievement-toasts] patch PlayNotificationSound failed', e); }
  }

  private async onUnlock(p: any): Promise<void> {
    const s = getSettings();
    // A progress update, not an unlock: leave it to Steam's own progress toast.
    if (isProgressEvent(p)) { lastProgressAt = Date.now(); return; }
    if (!s.enabled) return;
    const appid: number = p?.unAppID ?? p?.nAppID ?? p?.appid ?? 0;
    if (s.debug) console.log('[achievement-toasts] unlock event', appid, p);
    if (!appid) return;

    const ach = await this.resolveAchievement(appid, p);
    if (s.showDescription && !ach.desc && ach.strID) ach.desc = await this.lookupDescription(appid, ach.strID);

    // rarity: Web API / disk cache / Steam client map, else the event's own value
    let pct: number | undefined;
    const map = await this.ensurePct(appid);
    if (ach.strID && typeof map[ach.strID] === 'number') pct = map[ach.strID];
    else if (typeof ach.flAchieved === 'number' && ach.flAchieved > 0) pct = ach.flAchieved;

    const rare = typeof pct === 'number' && isFinite(pct) ? pct < s.rareThreshold : false;
    if (!rare && !s.showForCommon) return;

    const data = this.toData(ach.name, ach.icon, pct, ach.desc);
    const opts = this.opts(rare, s, appid);
    // Queue for the over-game overlay (composites above the running game); multiple
    // unlocks play one at a time, in order. If the overlay can't show it, fall back to
    // our popup window — unless Steam's own toast was left on for this unlock (overlay
    // already known to be down), which would double it.
    const nativeHidden = s.suppressNative && isOverlayHealthy();
    enqueueOverlay(data, opts, () => {
      if (nativeHidden) void ensureFont(opts.font).then(() => this.toast.show(data, opts));
    });
  }

  /** The achievement's description from the Steam client (hidden ones may be empty). */
  private async lookupDescription(appid: number, strID: string): Promise<string | undefined> {
    try {
      const res = await w.SteamClient?.Apps?.GetMyAchievementsForApp?.(String(appid));
      const hit = extractAchievements(res).find((a) => a?.strID === strID);
      const d = hit && typeof hit.strDescription === 'string' ? hit.strDescription.trim() : '';
      return d || undefined;
    } catch {
      return undefined;
    }
  }

  private async resolveAchievement(appid: number, ev: any): Promise<Resolved> {
    // The event carries the achievement itself ({unAppID, achievement:{strID, strName,
    // strImage, …}}), so two unlocks in the same instant each get their own data.
    const p = eventAchievement(ev);
    const pName = p?.strName || p?.strDisplayName || p?.display_name;
    const pImg = p?.strImage || p?.strIcon || p?.icon;
    const pID = p?.strID || p?.achievement_id || p?.strAchievementID || p?.strApiName;
    const pDesc = p?.strDescription || p?.description;
    if (pName) return { strID: pID, name: pName, icon: pImg, flAchieved: p?.flAchieved, desc: pDesc };

    try {
      const res = await w.SteamClient?.Apps?.GetMyAchievementsForApp?.(String(appid));
      const list = extractAchievements(res).filter((a) => a?.bAchieved);
      const ach = (pID && list.find((a) => a.strID === pID)) ||
        list.slice().sort((a, b) => (b.rtUnlocked || 0) - (a.rtUnlocked || 0))[0];
      if (ach) return { strID: ach.strID, name: ach.strName, icon: ach.strImage, flAchieved: ach.flAchieved, desc: ach.strDescription };
    } catch (e) {
      console.error('[achievement-toasts] resolveAchievement failed', e);
    }
    return { strID: pID, name: pName || t('toast.unlocked'), icon: pImg, flAchieved: p?.flAchieved };
  }

  private toData(name: string, icon: string | undefined, pct: number | undefined, description?: string): ToastData {
    return {
      name,
      icon,
      pct,
      description: description || undefined,
      rarityText: typeof pct === 'number' && isFinite(pct) ? t('toast.rarity', { pct: fmtPct(pct) }) : undefined,
    };
  }

  private opts(rare: boolean, s: AchSettings, appid?: number): ToastOptions {
    // The resolved look carries the sound too, so a per-game preset can use its own.
    const look = resolveLook(s, rare, appid);
    const o = buildOpts(s, rare, look);
    o.onShow = () => { void this.sound.playValue(look.sound); };
    return o;
  }

  /** Warm the sounds a game's per-game presets use, so its first unlock plays instantly. */
  private preloadGameSounds(appid: number): void {
    try {
      const s = getSettings();
      for (const rare of [false, true]) {
        const snd = resolveLook(s, rare, appid).sound;
        if (snd?.enabled && snd.path) void this.sound.preload(snd.path);
      }
    } catch { /* optional */ }
  }

  /** The game in front. Steam's own idea of it wins: a second app starting or
   *  stopping in the background (a launcher, a tool) must not change it. */
  private activeAppId(): number {
    try {
      const main = Number(w.SteamUIStore?.MainRunningAppID ?? w.SteamUIStore?.MainRunningApp?.appid ?? 0);
      if (main) return main;
    } catch { /* fall back */ }
    return this.currentAppId;
  }

  /** The currently-running game (for the per-game preset UI), or null. */
  currentGame(): { appid: number; name: string } | null {
    const appid = this.activeAppId();
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
    const data = this.toData(name, undefined, pct, rare ? t('toast.sampleDescRare') : t('toast.sampleDescCommon'));
    // Use the running game's profile (if any) so per-game looks/sounds can be tested.
    const opts = this.opts(rare, s, this.activeAppId() || undefined);
    enqueueOverlay(data, opts, () => { void ensureFont(opts.font).then(() => this.toast.show(data, opts)); });
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
    clearOverlayQueue();
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
