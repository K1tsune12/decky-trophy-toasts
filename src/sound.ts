// Loads the plugin's achievement sounds (bundled or user-picked) as data: URIs
// via the Python backend — CEF can't load raw filesystem paths in <audio> — and
// plays them. We play our OWN sound directly here; the native achievement sound
// is suppressed separately (see achievements.ts).

import { call } from '@decky/api';

import { AchSettings, SoundSlot, effectiveVolume, getSettings } from './settings';

interface SoundDataRes {
  ok: boolean;
  uri?: string;
  error?: string;
}

export class SoundPlayer {
  private audio?: HTMLAudioElement;
  private cache = new Map<string, string>(); // source -> data: URI

  /** Warm the cache for both configured slots so playback is instant. */
  preloadEnabled(): void {
    const s = getSettings();
    for (const slot of [s.soundCommon, s.soundRare]) {
      if (slot.enabled && slot.path) void this.preload(slot.path);
    }
  }

  async preload(source: string): Promise<string | undefined> {
    if (!source) return undefined;
    const cached = this.cache.get(source);
    if (cached) return cached;
    try {
      const res = await call<[string], SoundDataRes>('read_sound_data_uri', source);
      if (res?.ok && res.uri) {
        this.cache.set(source, res.uri);
        return res.uri;
      }
      console.warn(`[achievement-toasts] could not load sound "${source}": ${res?.error}`);
    } catch (e) {
      console.error('[achievement-toasts] backend read_sound_data_uri failed', e);
    }
    return undefined;
  }

  /** Play the sound for a tier. Does nothing if that slot is disabled/empty. */
  async play(rare: boolean): Promise<void> {
    const s: AchSettings = getSettings();
    const slot: SoundSlot = rare ? s.soundRare : s.soundCommon;
    if (!slot.enabled || !slot.path) return;
    const uri = this.cache.get(slot.path) ?? (await this.preload(slot.path));
    if (uri) this.playUri(uri, effectiveVolume(slot.volume));
  }

  /** Play a specific slot regardless of the rare flag (used by the Test buttons). */
  async playSlot(which: 'soundCommon' | 'soundRare'): Promise<void> {
    const slot = getSettings()[which];
    if (!slot.path) return;
    const uri = this.cache.get(slot.path) ?? (await this.preload(slot.path));
    if (uri) this.playUri(uri, effectiveVolume(slot.volume));
  }

  private playUri(uri: string, volume: number): void {
    try {
      if (!this.audio) this.audio = new Audio();
      this.audio.src = uri;
      this.audio.volume = Math.max(0, Math.min(1, volume));
      this.audio.currentTime = 0;
      void this.audio.play();
    } catch (e) {
      console.error('[achievement-toasts] failed to play sound', e);
    }
  }

  deinit(): void {
    this.audio = undefined;
    this.cache.clear();
  }
}
