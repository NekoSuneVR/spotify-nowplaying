import iconSvg from './icon';
import { DEFAULT_SERVER_URL } from './config';
import { readNowPlaying } from './playerState';
import SettingsManager, { normalizeInterval } from './settings';
import pJson from '../package.json';

const IMMEDIATE_SEND_DELAY_MS = 150;
const STATE_WATCH_INTERVAL_MS = 500;

class SpotifyNowPlayingPlugin {
  settingsManager = new SettingsManager();
  timer: NodeJS.Timer | null = null;
  stateWatchTimer: NodeJS.Timer | null = null;
  pendingTimer: NodeJS.Timeout | null = null;
  sending = false;
  lastSentAt = 0;
  lastErrorMessage = '';
  lastStateSignature = '';

  constructor() {
    injectStyles();
    new Spicetify.Topbar.Button('Spotify Now Playing (NP)', iconSvg, () => this.openSettings());
    this.registerPlayerListeners();
    this.startStateWatcher();
    this.restartTimer();
    this.queueSend(true);
  }

  private registerPlayerListeners() {
    Spicetify.Player.addEventListener('songchange', () => this.queueSend(true));
    Spicetify.Player.addEventListener('onplaypause', () => this.queueSend(true));
    Spicetify.Player.addEventListener('onprogress', () => this.queueSend(false));
  }

  private startStateWatcher() {
    if (this.stateWatchTimer) {
      clearInterval(this.stateWatchTimer);
    }

    this.lastStateSignature = this.createStateSignature();
    this.stateWatchTimer = setInterval(() => {
      const nextSignature = this.createStateSignature();
      if (nextSignature !== this.lastStateSignature) {
        this.lastStateSignature = nextSignature;
        this.queueSend(true);
      }
    }, STATE_WATCH_INTERVAL_MS);
  }

  private restartTimer() {
    if (this.timer) {
      clearInterval(this.timer);
    }

    this.timer = setInterval(() => {
      this.sendNowPlaying(false);
    }, this.settingsManager.settings.updateIntervalMs);
  }

  private queueSend(force: boolean) {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
    }

    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.sendNowPlaying(force);
    }, IMMEDIATE_SEND_DELAY_MS);
  }

  private async sendNowPlaying(force: boolean) {
    const settings = this.settingsManager.settings;
    const now = Date.now();

    if (!settings.enabled || !settings.serverUrl || !settings.apiKey) {
      return;
    }

    if (!force && now - this.lastSentAt < settings.updateIntervalMs) {
      return;
    }

    if (this.sending) {
      return;
    }

    this.sending = true;
    try {
      const response = await fetch(buildApiUrl(settings.serverUrl, '/api/nowplaying'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': settings.apiKey,
        },
        body: JSON.stringify({
          ...readNowPlaying(),
          source: 'spicetify-nowplaying',
          pluginVersion: pJson.version,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || `Server returned ${response.status}`);
      }

      this.lastSentAt = Date.now();
      this.lastStateSignature = this.createStateSignature();
      this.lastErrorMessage = '';
      if (typeof data.overlayUrl === 'string' && data.overlayUrl) {
        settings.lastOverlayUrl = data.overlayUrl;
      }
      if (typeof data.publicUrl === 'string' && data.publicUrl) {
        settings.lastPublicUrl = data.publicUrl;
      }
      this.settingsManager.save();
    } catch (error: any) {
      this.showError(error?.message || 'Could not send now-playing update.');
    } finally {
      this.sending = false;
    }
  }

  private showError(message: string) {
    if (!this.settingsManager.settings.notifyErrors) {
      return;
    }

    if (this.lastErrorMessage === message) {
      return;
    }

    this.lastErrorMessage = message;
    Spicetify.showNotification(`Now Playing: ${message}`);
  }

  private openSettings() {
    const settings = this.settingsManager.settings;
    const content = document.createElement('div');
    content.className = 'snp-modal';
    content.innerHTML = `
      <label class="snp-field">
        <span>Server URL</span>
        <input data-field="serverUrl" type="text" placeholder="${DEFAULT_SERVER_URL}">
      </label>
      <label class="snp-field">
        <span>API key</span>
        <input data-field="apiKey" type="password" placeholder="npk_...">
      </label>
      <label class="snp-field">
        <span>Update interval ms</span>
        <input data-field="updateIntervalMs" type="number" min="1000" max="60000" step="500">
      </label>
      <label class="snp-toggle">
        <input data-field="enabled" type="checkbox">
        <span>Enabled</span>
      </label>
      <label class="snp-toggle">
        <input data-field="notifyErrors" type="checkbox">
        <span>Notify errors</span>
      </label>
      <div class="snp-actions">
        <button data-action="save">Save</button>
        <button data-action="send">Send now</button>
        <button data-action="open-server">Open server</button>
        <button data-action="copy-overlay">Copy overlay</button>
      </div>
      <div class="snp-status" data-status></div>
    `;

    const serverInput = content.querySelector<HTMLInputElement>('[data-field="serverUrl"]')!;
    const apiKeyInput = content.querySelector<HTMLInputElement>('[data-field="apiKey"]')!;
    const intervalInput = content.querySelector<HTMLInputElement>('[data-field="updateIntervalMs"]')!;
    const enabledInput = content.querySelector<HTMLInputElement>('[data-field="enabled"]')!;
    const notifyInput = content.querySelector<HTMLInputElement>('[data-field="notifyErrors"]')!;
    const status = content.querySelector<HTMLElement>('[data-status]')!;

    serverInput.value = settings.serverUrl;
    apiKeyInput.value = settings.apiKey;
    intervalInput.value = String(settings.updateIntervalMs);
    enabledInput.checked = settings.enabled;
    notifyInput.checked = settings.notifyErrors;
    status.textContent = settings.lastOverlayUrl
      ? `Overlay: ${settings.lastOverlayUrl}`
      : `Register on ${settings.serverUrl || DEFAULT_SERVER_URL} to get an API key.`;

    content.querySelector<HTMLButtonElement>('[data-action="save"]')!.onclick = () => {
      this.saveSettingsFromInputs(serverInput, apiKeyInput, intervalInput, enabledInput, notifyInput);
      status.textContent = 'Settings saved.';
      Spicetify.showNotification('Spotify Now Playing settings saved.');
      this.restartTimer();
      this.queueSend(true);
    };

    content.querySelector<HTMLButtonElement>('[data-action="send"]')!.onclick = async () => {
      this.saveSettingsFromInputs(serverInput, apiKeyInput, intervalInput, enabledInput, notifyInput);
      this.restartTimer();
      status.textContent = 'Sending...';
      await this.sendNowPlaying(true);
      status.textContent = this.lastErrorMessage || this.settingsManager.settings.lastOverlayUrl || 'Sent.';
    };

    content.querySelector<HTMLButtonElement>('[data-action="open-server"]')!.onclick = () => {
      this.saveSettingsFromInputs(serverInput, apiKeyInput, intervalInput, enabledInput, notifyInput);
      window.open(this.settingsManager.settings.serverUrl || DEFAULT_SERVER_URL, '_blank', 'noopener,noreferrer');
    };

    content.querySelector<HTMLButtonElement>('[data-action="copy-overlay"]')!.onclick = async () => {
      const overlayUrl = this.settingsManager.settings.lastOverlayUrl;
      if (!overlayUrl) {
        status.textContent = 'Send an update first so the server can return your overlay URL.';
        return;
      }

      await navigator.clipboard?.writeText(overlayUrl);
      status.textContent = 'Overlay URL copied.';
    };

    Spicetify.PopupModal.display({
      title: 'Spotify Now Playing',
      content,
    });
  }

  private saveSettingsFromInputs(
    serverInput: HTMLInputElement,
    apiKeyInput: HTMLInputElement,
    intervalInput: HTMLInputElement,
    enabledInput: HTMLInputElement,
    notifyInput: HTMLInputElement,
  ) {
    const settings = this.settingsManager.settings;
    settings.serverUrl = serverInput.value.trim().replace(/\/+$/, '');
    settings.apiKey = apiKeyInput.value.trim();
    settings.updateIntervalMs = normalizeInterval(intervalInput.value);
    settings.enabled = enabledInput.checked;
    settings.notifyErrors = notifyInput.checked;
    this.settingsManager.save();
  }

  private createStateSignature() {
    const state = readNowPlaying();
    return [
      state.cleared ? 'cleared' : state.trackUri,
      state.name,
      state.artistName,
      state.albumName,
      state.image,
      state.durationMs,
      state.paused,
    ].join('|');
  }
}

async function main() {
  if (!Spicetify.Platform || !Spicetify.Player || !Spicetify.LocalStorage || !Spicetify.Topbar) {
    setTimeout(main, 1000);
    return;
  }

  new SpotifyNowPlayingPlugin();
}

function buildApiUrl(serverUrl: string, routePath: string) {
  const base = serverUrl.trim().replace(/\/+$/, '');
  return `${base}${routePath}`;
}

function injectStyles() {
  if (document.getElementById('spotify-nowplaying-style')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'spotify-nowplaying-style';
  style.textContent = `
    .snp-modal {
      display: grid;
      gap: 14px;
      min-width: min(520px, 80vw);
      color: var(--spice-text, #fff);
    }
    .snp-field {
      display: grid;
      gap: 6px;
      width: 100%;
      font-size: 13px;
      font-weight: 700;
    }
    .snp-field input {
      width: 100%;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.35);
      color: inherit;
      padding: 10px;
    }
    .snp-toggle {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      font-weight: 700;
    }
    .snp-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .snp-actions button {
      min-height: 34px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 999px;
      background: transparent;
      color: inherit;
      padding: 6px 14px;
      font-weight: 800;
      cursor: pointer;
    }
    .snp-actions button:hover {
      border-color: rgba(255, 255, 255, 0.42);
    }
    .snp-status {
      min-height: 20px;
      color: rgba(255, 255, 255, 0.66);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
  `;
  document.head.appendChild(style);
}

export default main;
