import { DEFAULT_SERVER_URL } from './config';

export type Settings = {
  settingsVersion: string;
  enabled: boolean;
  serverUrl: string;
  apiKey: string;
  updateIntervalMs: number;
  notifyErrors: boolean;
  lastOverlayUrl: string;
  lastPublicUrl: string;
};

const STORAGE_KEY = 'spotifyNowPlaying';

const defaults: Settings = {
  settingsVersion: '1',
  enabled: true,
  serverUrl: DEFAULT_SERVER_URL,
  apiKey: '',
  updateIntervalMs: 3000,
  notifyErrors: true,
  lastOverlayUrl: '',
  lastPublicUrl: '',
};

export default class SettingsManager {
  settings: Settings;

  constructor() {
    this.settings = this.load();
    this.save();
  }

  save() {
    Spicetify.LocalStorage.set(STORAGE_KEY, JSON.stringify(this.settings));
  }

  private load(): Settings {
    const stored = Spicetify.LocalStorage.get(STORAGE_KEY);
    if (!stored) {
      return { ...defaults };
    }

    try {
      const parsed = JSON.parse(stored);
      if (parsed.settingsVersion !== defaults.settingsVersion) {
        return { ...defaults };
      }

      return {
        ...defaults,
        ...parsed,
        serverUrl: parsed.serverUrl || defaults.serverUrl,
        updateIntervalMs: normalizeInterval(parsed.updateIntervalMs),
      };
    } catch (error) {
      console.error('Failed to parse Spotify Now Playing settings:', error);
      return { ...defaults };
    }
  }
}

export function normalizeInterval(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return defaults.updateIntervalMs;
  }

  return Math.min(Math.max(Math.round(parsed), 1000), 60000);
}
