// Everything that lets the toast work with NO network: the bundled display fonts,
// on-disk caches for achievement rarity + icons, and a disk backup of the settings
// (localStorage is wiped whenever Steam's web cache is cleared).
//
// The backend (main.py) owns the files; this module is the frontend side.

import { call } from '@decky/api';

import { getSettings, replaceSettings, subscribe } from './settings';
import { getFont, hasFontCss, setFontCss } from './themes';

interface Res { ok: boolean; css?: string; data?: string; uri?: string }

// --- bundled fonts ------------------------------------------------------------
const fontJobs = new Map<string, Promise<void>>();

/** Make sure a bundled display font's inline CSS is loaded (no-op for system fonts). */
export function ensureFont(id?: string): Promise<void> {
  const key = id || '';
  if (!getFont(key)?.bundled || hasFontCss(key)) return Promise.resolve();
  let job = fontJobs.get(key);
  if (!job) {
    job = (async () => {
      try {
        const res = await call<[string], Res>('get_font_css', key);
        if (res?.ok && res.css) setFontCss(key, res.css);
      } catch (e) {
        console.warn('[trophy-toasts] bundled font load failed', key, e);
      } finally {
        fontJobs.delete(key);
      }
    })();
    fontJobs.set(key, job);
  }
  return job;
}

// --- network with a deadline ----------------------------------------------------
/** fetch() that gives up after `ms` (a hung request must never hold a toast back). */
export async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- rarity cache ---------------------------------------------------------------
export async function rarityFromDisk(appid: number | string): Promise<Record<string, number> | undefined> {
  try {
    const res = await call<[string], Res>('rarity_get', String(appid));
    if (res?.ok && res.data) return JSON.parse(res.data) as Record<string, number>;
  } catch { /* no cache */ }
  return undefined;
}

export function rarityToDisk(appid: number | string, map: Record<string, number>): void {
  if (!Object.keys(map).length) return;
  void call<[string, string], Res>('rarity_put', String(appid), JSON.stringify(map)).catch(() => undefined);
}

// --- icon cache -----------------------------------------------------------------
const iconMem = new Map<string, string>();

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

async function downloadIcon(url: string, ms: number): Promise<string | undefined> {
  try {
    const res = await fetchWithTimeout(url, ms);
    if (!res.ok) return undefined;
    const blob = await res.blob();
    if (!blob.size) return undefined;
    const uri = await blobToDataUri(blob);
    if (!uri.startsWith('data:image/')) return undefined;
    void call<[string, string], Res>('icon_put', url, uri).catch(() => undefined);
    return uri;
  } catch {
    return undefined;
  }
}

/** An achievement icon as a data: URI: memory -> disk cache -> network (then cached). */
export async function iconDataUri(url: string): Promise<string | undefined> {
  if (!url) return undefined;
  if (/^data:/.test(url)) return url;
  const mem = iconMem.get(url);
  if (mem) return mem;
  let uri: string | undefined;
  try {
    const res = await call<[string], Res>('icon_get', url);
    if (res?.ok && res.uri) uri = res.uri;
  } catch { /* not cached */ }
  if (!uri) uri = await downloadIcon(url, 2500);
  if (uri) {
    if (iconMem.size > 64) iconMem.clear();
    iconMem.set(url, uri);
  }
  return uri;
}

/** Download + cache icons that aren't on disk yet (called when a game starts, so a
 *  later offline unlock still shows the real icon). Gentle: 4 at a time, capped. */
export async function prewarmIcons(urls: string[]): Promise<void> {
  try {
    const want = Array.from(new Set(urls.filter((u) => /^https?:/.test(u)))).slice(0, 400);
    if (!want.length) return;
    const missing = await call<[string[]], string[]>('icons_missing', want);
    if (!Array.isArray(missing) || !missing.length) return;
    let next = 0;
    const worker = async () => {
      while (next < missing.length) {
        const url = missing[next++];
        if (!(await downloadIcon(url, 6000)) && !navigator.onLine) return; // offline: stop
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  } catch { /* best effort */ }
}

// --- settings backup --------------------------------------------------------------
const STORAGE_KEY = 'achievement-toasts:settings';
let stopSync: (() => void) | undefined;

/** Mirror the settings to disk (debounced) and, when localStorage came back empty
 *  (Steam's web cache was cleared), restore them from that backup. */
export async function initSettingsSync(): Promise<void> {
  let hadLocal = true;
  try { hadLocal = localStorage.getItem(STORAGE_KEY) != null; } catch { /* ignore */ }
  if (!hadLocal) {
    try {
      const res = await call<[], Res>('settings_load');
      if (res?.ok && res.data) replaceSettings(JSON.parse(res.data));
    } catch { /* no backup yet */ }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const push = () => {
    timer = undefined;
    void call<[string], Res>('settings_save', JSON.stringify(getSettings())).catch(() => undefined);
  };
  stopSync?.();
  const unsub = subscribe(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(push, 1200);
  });
  stopSync = () => { unsub(); if (timer) { clearTimeout(timer); push(); } };
  if (hadLocal) push(); // make sure a backup exists for settings saved before this version
}

export function stopSettingsSync(): void {
  stopSync?.();
  stopSync = undefined;
}
