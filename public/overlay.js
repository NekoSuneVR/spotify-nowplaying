(function () {
  const root = document.querySelector('.overlay-root');
  if (!root) return;

  const publicId = root.dataset.publicId;
  const els = {
    art: root.querySelector('[data-art]'),
    status: root.querySelector('[data-status]'),
    title: root.querySelector('[data-title]'),
    artist: root.querySelector('[data-artist]'),
    progress: root.querySelector('[data-progress]'),
    elapsed: root.querySelector('[data-elapsed]'),
    duration: root.querySelector('[data-duration]'),
  };

  let payload = parseInitial(root.dataset.initial);
  let receivedAt = Date.now();

  render();
  setInterval(render, 500);

  if (window.io && publicId) {
    const socket = io({ query: { publicId } });
    socket.on('nowplaying', (nextPayload) => {
      payload = nextPayload;
      receivedAt = Date.now();
      render();
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
      render();
    } catch {}
  }

  setInterval(refresh, 15000);

  function render() {
    const song = payload && payload.song;
    if (!song || song.empty) {
      setText(els.status, 'Offline');
      setText(els.title, 'Waiting for playback');
      setText(els.artist, payload && payload.user ? payload.user.displayName : '');
      setArt('');
      setProgress(0, 0);
      return;
    }

    const liveProgress = getLiveProgress(song);
    setText(els.status, song.stale ? 'No recent updates' : song.isPlaying ? 'Now Playing' : 'Paused');
    setText(els.title, song.name || 'Unknown track');
    setText(els.artist, song.artistName || 'Unknown artist');
    setArt(song.image || '');
    setProgress(liveProgress, song.durationMs || 0);
  }

  function getLiveProgress(song) {
    if (!song.durationMs) return song.progressMs || 0;
    const elapsed = song.isPlaying && !song.stale ? Date.now() - receivedAt : 0;
    return Math.min((song.progressMs || 0) + elapsed, song.durationMs);
  }

  function setProgress(progressMs, durationMs) {
    const percent = durationMs > 0 ? Math.min(Math.max((progressMs / durationMs) * 100, 0), 100) : 0;
    if (els.progress) els.progress.style.width = `${percent}%`;
    setText(els.elapsed, formatTime(progressMs));
    setText(els.duration, formatTime(durationMs));
  }

  function setArt(url) {
    if (!els.art) return;
    els.art.style.backgroundImage = url ? `url("${cssEscapeUrl(url)}")` : '';
  }

  function setText(element, value) {
    if (element) {
      element.textContent = value;
    }
  }

  function parseInitial(value) {
    try {
      return JSON.parse(value || 'null');
    } catch {
      return null;
    }
  }

  function formatTime(ms) {
    const totalSeconds = Math.max(Math.floor((ms || 0) / 1000), 0);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  }

  function cssEscapeUrl(url) {
    return String(url).replace(/["\\\n\r]/g, '');
  }
})();
