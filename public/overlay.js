(function () {
  const root = document.querySelector('.np-overlay-page');
  if (!root) return;

  const publicId = root.dataset.publicId;
  const player = root.querySelector('[data-player]');
  const styleLocked = root.dataset.styleLocked === 'true';
  const overlayStyles = ['default', 'bash', 'discord', 'macos', 'windows', 'soundcloud', 'youtube'];
  const spotifyUser = 'NekoSuneVR';
  const siteUrl = 'https://nekosunevr.co.uk';
  const siteLabel = 'NekoSuneVR Now Playing';

  let payload = parseInitial(root.dataset.initial);
  let currentStyle = readStyle(root.dataset.style) || readStyle(payload?.user?.overlayStyle) || 'default';
  let receivedAt = Date.now();

  render();
  setInterval(render, 500);

  if (window.io && publicId) {
    const socket = io({ query: { publicId } });
    socket.on('nowplaying', (nextPayload) => {
      payload = nextPayload;
      receivedAt = Date.now();
      if (!styleLocked) {
        currentStyle = readStyle(payload?.user?.overlayStyle) || currentStyle;
      }
      render();
    });
    socket.on('settingsUpdated', (user) => {
      if (!styleLocked) {
        currentStyle = readStyle(user?.overlayStyle) || currentStyle;
        if (payload && payload.user) {
          payload.user.overlayStyle = currentStyle;
        }
        render();
      }
    });
    socket.on('notFound', () => {
      payload = null;
      render();
    });
  }

  async function refresh() {
    if (!publicId) return;

    try {
      const response = await fetch(`/api/users/${encodeURIComponent(publicId)}/nowplaying`, {
        cache: 'no-store',
      });
      if (!response.ok) return;
      payload = await response.json();
      receivedAt = Date.now();
      if (!styleLocked) {
        currentStyle = readStyle(payload?.user?.overlayStyle) || currentStyle;
      }
      render();
    } catch {}
  }

  setInterval(refresh, 15000);

  function render() {
    if (!player) return;

    player.className = `player-container ${currentStyle}`;
    const song = payload && payload.song;
    const userName = payload?.user?.displayName || spotifyUser;

    if (!song || song.empty) {
      player.innerHTML = `<div class="default-container no-song">${escapeHtml(userName)} is not playing anything.</div>`;
      return;
    }

    const progressMs = getLiveProgress(song);
    const totalMs = song.durationMs || 0;
    const songData = songToSpotifyLikeData(song);

    if (!songData) {
      player.innerHTML = `<div class="default-container no-song">${escapeHtml(userName)} is not playing anything.</div>`;
      return;
    }

    const props = {
      songData,
      progressSeconds: Math.ceil(progressMs / 1000),
      totalSeconds: Math.ceil(totalMs / 1000),
      userName,
    };

    player.innerHTML = renderLayout(currentStyle, props);
  }

  function renderLayout(style, props) {
    switch (style) {
      case 'bash':
        return renderBash(props);
      case 'discord':
        return renderDiscord(props);
      case 'macos':
        return renderMacos(props);
      case 'windows':
        return renderWindows(props);
      case 'soundcloud':
        return renderSoundcloud(props);
      case 'youtube':
        return renderYoutube(props);
      default:
        return renderDefault(props);
    }
  }

  function renderDefault({ songData, progressSeconds, totalSeconds, userName }) {
    const progress = getProgressPercent(progressSeconds, totalSeconds);
    const image = songData.item.album.images[1].url;

    return `
      <div class="default-container">
        <div class="default-background" style="background-image:url('${escapeAttr(cssUrl(image))}')"></div>
        <img src="${escapeAttr(image)}" class="default-album-art" alt="Album art">
        <div class="default-content">
          <div class="default-song">${escapeHtml(songData.item.name)}</div>
          <div class="default-artist">${escapeHtml(songData.item.artists[0].name)}</div>
          <div class="default-links hide-on-mobile">
            ${renderLink(songData.item.external_urls.spotify, 'Song', 'default-link')}
            ${renderLink(songData.item.artists[0].external_urls.spotify, 'Artist', 'default-link')}
            ${renderLink(songData.item.album.external_urls.spotify, 'Album', 'default-link')}
          </div>
          <div class="default-status">${songData.is_playing ? `${escapeHtml(userName)}'s now playing...` : `${escapeHtml(userName)} has paused.`}</div>
          <div class="default-progress-container">
            <div class="default-progress-bar">
              <div class="default-progress" style="width:${progress}%"></div>
            </div>
            <div class="default-time hide-on-mobile">${formatTime(progressSeconds)} / ${formatTime(totalSeconds)}</div>
          </div>
          <div class="default-footer">${renderLink(siteUrl, siteLabel, '')}</div>
        </div>
      </div>
    `;
  }

  function renderBash({ songData, progressSeconds, totalSeconds }) {
    const progressPercent = totalSeconds > 0
      ? Math.min(Math.max((progressSeconds / totalSeconds) * 20, 0), 20)
      : 0;
    const filled = Math.floor(progressPercent);
    const empty = 20 - filled;
    const progressBar = `${'='.repeat(filled)}${'-'.repeat(empty)}`;

    return `
      <div class="bash-container">
        <div class="bash-song">$ ${escapeHtml(songData.item.name)} by ${escapeHtml(songData.item.artists[0].name)}</div>
        <div class="bash-status">$ ${songData.is_playing ? 'playing' : 'paused'}</div>
        <div class="bash-progress">$ progress: [${progressBar}] ${formatTime(progressSeconds)}/${formatTime(totalSeconds)}</div>
        <div class="bash-links hide-on-mobile">
          ${renderLink(songData.item.external_urls.spotify, `$ song: ${songData.item.external_urls.spotify}`, 'bash-link')}
          ${renderLink(songData.item.artists[0].external_urls.spotify, `$ artist: ${songData.item.artists[0].external_urls.spotify}`, 'bash-link')}
          ${renderLink(songData.item.album.external_urls.spotify, `$ album: ${songData.item.album.external_urls.spotify}`, 'bash-link')}
        </div>
        <div class="bash-footer">$ powered by ${renderLink(siteUrl, siteLabel, '')}</div>
      </div>
    `;
  }

  function renderDiscord({ songData, progressSeconds, totalSeconds }) {
    const progress = getProgressPercent(progressSeconds, totalSeconds);

    return `
      <div class="discord-container">
        <img src="${escapeAttr(songData.item.album.images[1].url)}" class="discord-album-art" alt="Album art">
        <div class="discord-content">
          <div class="discord-song">${escapeHtml(songData.item.name)}</div>
          <div class="discord-artist">${escapeHtml(songData.item.artists[0].name)}</div>
          <div class="discord-status">${songData.is_playing ? 'Now Playing' : 'Paused'}</div>
          <div class="discord-progress-bar">
            <div class="discord-progress" style="width:${progress}%"></div>
          </div>
          <div class="discord-time hide-on-mobile">${formatTime(progressSeconds)} / ${formatTime(totalSeconds)}</div>
          <div class="discord-links hide-on-mobile">
            ${renderLink(songData.item.external_urls.spotify, 'Song', 'discord-link')}
            ${renderLink(songData.item.artists[0].external_urls.spotify, 'Artist', 'discord-link')}
            ${renderLink(songData.item.album.external_urls.spotify, 'Album', 'discord-link')}
          </div>
          <div class="discord-footer">${renderLink(siteUrl, siteLabel, '')}</div>
        </div>
      </div>
    `;
  }

  function renderMacos({ songData, progressSeconds, totalSeconds }) {
    const progress = getProgressPercent(progressSeconds, totalSeconds);

    return `
      <div class="macos-container">
        <div class="macos-background"></div>
        <img src="${escapeAttr(songData.item.album.images[1].url)}" class="macos-album-art" alt="Album art">
        <div class="macos-content">
          <div class="macos-song">${escapeHtml(songData.item.name)}</div>
          <div class="macos-artist">${escapeHtml(songData.item.artists[0].name)}</div>
          <div class="macos-status">${songData.is_playing ? 'Now Playing' : 'Paused'}</div>
        </div>
        <div class="macos-progress-container">
          <div class="macos-progress-bar">
            <div class="macos-progress" style="width:${progress}%"></div>
          </div>
          <div class="macos-time hide-on-mobile">
            <span>${formatTime(progressSeconds)}</span>
            <span>${formatTime(totalSeconds)}</span>
          </div>
        </div>
        <div class="macos-links hide-on-mobile">
          ${renderLink(songData.item.external_urls.spotify, 'Song', 'macos-link')}
          ${renderLink(songData.item.artists[0].external_urls.spotify, 'Artist', 'macos-link')}
          ${renderLink(songData.item.album.external_urls.spotify, 'Album', 'macos-link')}
        </div>
        <div class="macos-footer">${renderLink(siteUrl, siteLabel, '')}</div>
      </div>
    `;
  }

  function renderWindows({ songData, progressSeconds, totalSeconds }) {
    const progress = getProgressPercent(progressSeconds, totalSeconds);

    return `
      <div class="windows-container">
        <img src="${escapeAttr(songData.item.album.images[1].url)}" class="windows-album-art" alt="Album art">
        <div class="windows-content">
          <div class="windows-song">${escapeHtml(songData.item.name)}</div>
          <div class="windows-artist">${escapeHtml(songData.item.artists[0].name)}</div>
          <div class="windows-status">${songData.is_playing ? 'Playing' : 'Paused'}</div>
          <div class="windows-progress-bar">
            <div class="windows-progress" style="width:${progress}%"></div>
          </div>
          <div class="windows-time hide-on-mobile">${formatTime(progressSeconds)} / ${formatTime(totalSeconds)}</div>
          <div class="windows-links hide-on-mobile">
            ${renderLink(songData.item.external_urls.spotify, 'Song', 'windows-link')}
            ${renderLink(songData.item.artists[0].external_urls.spotify, 'Artist', 'windows-link')}
            ${renderLink(songData.item.album.external_urls.spotify, 'Album', 'windows-link')}
          </div>
          <div class="windows-footer">${renderLink(siteUrl, siteLabel, '')}</div>
        </div>
      </div>
    `;
  }

  function renderSoundcloud({ songData, progressSeconds, totalSeconds }) {
    const progress = getProgressPercent(progressSeconds, totalSeconds);

    return `
      <div class="soundcloud-container">
        <div class="soundcloud-background"></div>
        <div class="soundcloud-header">
          <img src="${escapeAttr(songData.item.album.images[1].url)}" class="soundcloud-album-art" alt="Album art">
          <div class="soundcloud-title">
            <div class="soundcloud-song">${escapeHtml(songData.item.name)}</div>
            <div class="soundcloud-artist">${escapeHtml(songData.item.artists[0].name)}</div>
          </div>
        </div>
        <div class="soundcloud-progress-container">
          <div class="soundcloud-play-button" aria-label="${songData.is_playing ? 'Playing' : 'Paused'}"></div>
          <div class="soundcloud-progress-bar">
            <div class="soundcloud-progress" style="width:${progress}%"></div>
          </div>
          <div class="soundcloud-time">${formatTime(progressSeconds)}</div>
        </div>
        <div class="soundcloud-links hide-on-mobile">
          ${renderLink(songData.item.external_urls.spotify, 'Song', 'soundcloud-link')}
          ${renderLink(songData.item.artists[0].external_urls.spotify, 'Artist', 'soundcloud-link')}
          ${renderLink(songData.item.album.external_urls.spotify, 'Album', 'soundcloud-link')}
        </div>
        <div class="soundcloud-footer">${renderLink(siteUrl, siteLabel, '')}</div>
      </div>
    `;
  }

  function renderYoutube({ songData, progressSeconds, totalSeconds }) {
    const progress = getProgressPercent(progressSeconds, totalSeconds);

    return `
      <div class="youtube-container bg-gray-900 text-white p-4 rounded-lg max-w-lg mx-auto">
        <div class="youtube-thumbnail relative">
          <img src="${escapeAttr(songData.item.album.images[1].url)}" class="w-full h-auto rounded-lg" alt="Video thumbnail">
          <div class="youtube-controls absolute bottom-0 w-full p-2 bg-black bg-opacity-50 backdrop-blur-md rounded-b-lg flex items-center justify-between">
            <span class="youtube-status text-sm">${songData.is_playing ? 'Playing' : 'Paused'}</span>
            <div class="youtube-time text-sm">${formatTime(progressSeconds)} / ${formatTime(totalSeconds)}</div>
          </div>
        </div>
        <div class="youtube-content mt-4">
          <div class="youtube-title text-lg font-bold">${escapeHtml(songData.item.name)}</div>
          <div class="youtube-channel text-sm text-gray-400">${escapeHtml(songData.item.artists[0].name)}</div>
          <div class="youtube-progress-container mt-2">
            <div class="youtube-progress-bar w-full h-1 bg-gray-700 rounded-full overflow-hidden">
              <div class="youtube-progress h-full bg-red-600" style="width:${progress}%"></div>
            </div>
          </div>
          <div class="youtube-links mt-2 flex space-x-4 text-sm">
            ${renderLink(songData.item.external_urls.spotify, 'Watch Video', 'text-red-500 hover:underline')}
            ${renderLink(songData.item.artists[0].external_urls.spotify, 'Channel', 'text-red-500 hover:underline')}
          </div>
          <div class="youtube-footer mt-4 text-xs text-gray-500">${renderLink(siteUrl, siteLabel, '')}</div>
        </div>
      </div>
    `;
  }

  function songToSpotifyLikeData(song) {
    if (!song?.trackUri || !song.name) {
      return null;
    }

    const image = song.image || '';
    const trackUrl = spotifyUrlFromUri(song.trackUri);
    const artistName = song.artistName || song.artists?.[0] || 'Unknown Artist';

    return {
      item: {
        name: song.name || 'Unknown Title',
        artists: [
          {
            name: artistName,
            external_urls: { spotify: trackUrl },
          },
        ],
        album: {
          images: [{}, { url: image }],
          external_urls: { spotify: trackUrl },
        },
        external_urls: { spotify: trackUrl },
      },
      is_playing: !song.paused,
    };
  }

  function spotifyUrlFromUri(uri) {
    if (!uri) {
      return '#';
    }

    const [service, type, id] = uri.split(':');
    if (service !== 'spotify' || !type || !id) {
      return '#';
    }

    const supportedTypes = {
      album: 'album',
      artist: 'artist',
      episode: 'episode',
      playlist: 'playlist',
      show: 'show',
      track: 'track',
    };

    return supportedTypes[type]
      ? `https://open.spotify.com/${supportedTypes[type]}/${encodeURIComponent(id)}`
      : '#';
  }

  function getLiveProgress(song) {
    if (!song.durationMs) return song.progressMs || 0;
    const elapsed = song.isPlaying && !song.stale ? Date.now() - receivedAt : 0;
    return Math.min((song.progressMs || 0) + elapsed, song.durationMs);
  }

  function getProgressPercent(progressSeconds, totalSeconds) {
    return totalSeconds > 0
      ? Math.min(Math.max((progressSeconds / totalSeconds) * 100, 0), 100)
      : 0;
  }

  function readStyle(style) {
    return overlayStyles.includes(style) ? style : '';
  }

  function renderLink(href, label, className) {
    return `<a href="${escapeAttr(href || '#')}" target="_blank" rel="noreferrer"${className ? ` class="${escapeAttr(className)}"` : ''}>${escapeHtml(label)}</a>`;
  }

  function parseInitial(value) {
    try {
      return JSON.parse(value || 'null');
    } catch {
      return null;
    }
  }

  function formatTime(seconds) {
    const safeSeconds = Math.max(Math.floor(seconds || 0), 0);
    const minutes = Math.floor(safeSeconds / 60);
    const secs = safeSeconds % 60;
    return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
  }

  function cssUrl(url) {
    return String(url || '').replace(/["\\\n\r]/g, '');
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }
})();
