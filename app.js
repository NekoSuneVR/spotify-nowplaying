const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

require('dotenv').config();

const express = require('express');
const { Sequelize, DataTypes, Op } = require('sequelize');
const { Server } = require('socket.io');

const PORT = readIntEnv('PORT', 3000);
const DATABASE_URL = readString(process.env.DATABASE_URL, 2048);
const DATABASE_DIALECT = normalizeDatabaseDialect(
  process.env.DATABASE_DIALECT
  || process.env.DB_DIALECT
  || inferDatabaseDialect(DATABASE_URL)
  || inferDatabaseDialectFromEnv()
  || 'sqlite',
);
const DATABASE_HOST = process.env.DATABASE_HOST || process.env.DB_HOST || '127.0.0.1';
const DATABASE_NAME = process.env.DATABASE_NAME || process.env.DB_DATABASE || process.env.DB_NAME || 'spotify_nowplaying';
const DATABASE_USER = process.env.DATABASE_USER || process.env.DB_USERNAME || process.env.DB_USER || 'root';
const DATABASE_PASSWORD = process.env.DATABASE_PASSWORD || process.env.DB_PASSWORD || '';
const SQLITE_STORAGE = process.env.SQLITE_STORAGE || process.env.SQLITE_PATH || path.join(__dirname, 'data', 'nowplaying.sqlite');
const LEGACY_JSON_PATH = process.env.LEGACY_JSON_PATH || path.join(__dirname, 'data', 'db.json');
const PUBLIC_BASE_URL = normalizeBaseUrl(process.env.PUBLIC_BASE_URL || process.env.APP_URL || '');
const SESSION_COOKIE = 'spotify_np_session';
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const STALE_AFTER_MS = readIntEnv('STALE_AFTER_MS', 45000);
const OVERLAY_STYLES = ['default', 'bash', 'discord', 'macos', 'windows', 'soundcloud', 'youtube'];

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
  },
});

const sessions = new Map();
const { sequelize, UserModel, NowPlayingModel, sqliteDb } = createDatabase();
let db = { users: [], nowPlaying: {} };

app.set('trust proxy', true);
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, _res, next) => {
  req.currentSession = getCurrentSession(req);
  req.user = req.currentSession ? getUserById(req.currentSession.userId) : null;
  next();
});

io.on('connection', (socket) => {
  const publicId = readString(socket.handshake.query.publicId, 80);
  if (publicId) {
    subscribeSocketToPublicId(socket, publicId);
  }

  socket.on('subscribe', (nextPublicId) => {
    subscribeSocketToPublicId(socket, nextPublicId);
  });
});

app.get('/', (req, res) => {
  if (req.user) {
    renderDashboard(req, res);
    return;
  }

  renderLoggedOut(req, res);
});

app.post('/register', async (req, res) => {
  try {
    const { user, apiKey } = await createUser(req.body);
    createLoginSession(res, user.id, apiKey);
    res.redirect('/');
  } catch (error) {
    renderLoggedOut(req, res, { error: error.message, mode: 'register' });
  }
});

app.post('/login', (req, res) => {
  const username = readString(req.body.username, 64);
  const password = String(req.body.password || '');
  const user = findUserByUsername(username);

  if (!user || !verifyPassword(user, password)) {
    renderLoggedOut(req, res, { error: 'Username or password is incorrect.', mode: 'login' });
    return;
  }

  createLoginSession(res, user.id);
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  destroyLoginSession(req, res);
  res.redirect('/');
});

app.post('/api-key/rotate', requireLogin, async (req, res) => {
  const apiKey = rotateApiKey(req.user);
  req.currentSession.lastApiKey = apiKey;
  await saveDb();
  res.redirect('/');
});

app.post('/settings', requireLogin, async (req, res) => {
  updateUserSettings(req.user, req.body);
  await saveDb();
  emitSettingsUpdated(req.user);
  res.redirect('/');
});

app.get('/overlay/:publicId', (req, res) => {
  const user = getUserByPublicId(req.params.publicId);
  if (!user) {
    res.status(404).send(renderPage('Overlay not found', `
      <main class="center-page">
        <section class="panel narrow">
          <h1>Overlay not found</h1>
          <p>No now-playing user exists for this URL.</p>
        </section>
      </main>
    `));
    return;
  }

  const requestedStyle = readOverlayStyle(req.query.style);
  const style = requestedStyle || getUserOverlayStyle(user);
  res.send(renderOverlayPage(req, user, style, Boolean(requestedStyle)));
});

app.get('/u/:publicId', (req, res) => {
  const user = getUserByPublicId(req.params.publicId);
  if (!user) {
    res.status(404).send(renderPage('User not found', `
      <main class="center-page">
        <section class="panel narrow">
          <h1>User not found</h1>
          <p>No public now-playing page exists for this user.</p>
        </section>
      </main>
    `));
    return;
  }

  const payload = getPublicNowPlaying(user);
  const overlayUrl = buildAbsoluteUrl(req, `/overlay/${encodeURIComponent(user.publicId)}`);
  res.send(renderPage(`${user.displayName} - Now Playing`, `
    <main class="app-shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">Public now playing</p>
          <h1>${escapeHtml(user.displayName)}</h1>
        </div>
        <a class="button" href="${escapeHtml(overlayUrl)}">Open Overlay</a>
      </header>
      <section class="panel now-card">
        ${renderSongMarkup(payload.song)}
      </section>
    </main>
  `));
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, checkedAt: new Date().toISOString() });
});

app.get('/api/me', requireLogin, (req, res) => {
  res.json({
    user: serializePrivateUser(req, req.user),
    nowPlaying: getPublicNowPlaying(req.user).song,
  });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { user, apiKey } = await createUser(req.body);
    createLoginSession(res, user.id, apiKey);
    res.status(201).json({
      ok: true,
      apiKey,
      user: serializePrivateUser(req, user),
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  const username = readString(req.body.username, 64);
  const password = String(req.body.password || '');
  const user = findUserByUsername(username);

  if (!user || !verifyPassword(user, password)) {
    res.status(401).json({ error: 'Username or password is incorrect.' });
    return;
  }

  createLoginSession(res, user.id);
  res.json({ ok: true, user: serializePrivateUser(req, user) });
});

app.post('/api/auth/logout', (req, res) => {
  destroyLoginSession(req, res);
  res.json({ ok: true });
});

app.post('/api/api-key/rotate', requireLogin, async (req, res) => {
  const apiKey = rotateApiKey(req.user);
  await saveDb();
  res.json({
    ok: true,
    apiKey,
    user: serializePrivateUser(req, req.user),
  });
});

app.post('/api/me/settings', requireLogin, async (req, res) => {
  updateUserSettings(req.user, req.body);
  await saveDb();
  emitSettingsUpdated(req.user);
  res.json({
    ok: true,
    user: serializePrivateUser(req, req.user),
  });
});

app.get('/api/nowplaying', requireApiKey, (req, res) => {
  res.json(getOwnNowPlaying(req.apiUser, req));
});

app.get('/api/me/nowplaying', requireApiKey, (req, res) => {
  res.json(getOwnNowPlaying(req.apiUser, req));
});

app.get('/api/users/:publicId/nowplaying', (req, res) => {
  const user = getUserByPublicId(req.params.publicId);
  if (!user) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  res.json(getPublicNowPlaying(user));
});

app.post('/api/nowplaying', requireApiKey, async (req, res) => {
  const song = normalizeNowPlaying(req.body);
  const now = Date.now();

  db.nowPlaying[req.apiUser.id] = {
    ...song,
    receivedAt: now,
    updatedAt: new Date(now).toISOString(),
  };
  req.apiUser.updatedAt = new Date(now).toISOString();
  await saveDb();

  const payload = getPublicNowPlaying(req.apiUser);
  io.to(roomForPublicId(req.apiUser.publicId)).emit('nowplaying', payload);

  res.json({
    ok: true,
    overlayUrl: buildAbsoluteUrl(req, `/overlay/${encodeURIComponent(req.apiUser.publicId)}`),
    publicUrl: buildAbsoluteUrl(req, `/u/${encodeURIComponent(req.apiUser.publicId)}`),
    nowPlaying: payload.song,
  });
});

app.delete('/api/nowplaying', requireApiKey, async (req, res) => {
  delete db.nowPlaying[req.apiUser.id];
  await saveDb();

  const payload = getPublicNowPlaying(req.apiUser);
  io.to(roomForPublicId(req.apiUser.publicId)).emit('nowplaying', payload);
  res.json({ ok: true });
});

startServer().catch((error) => {
  console.error('Failed to start Spotify Now Playing server.');
  console.error(error);
  process.exit(1);
});

async function startServer() {
  await initializeDatabase();

  httpServer.listen(PORT, () => {
    console.log(`Spotify Now Playing server ready at http://localhost:${PORT}`);
    console.log(`Database: ${describeDatabase()}`);
    if (PUBLIC_BASE_URL) {
      console.log(`Public base URL: ${PUBLIC_BASE_URL}`);
    }
  });
}

function renderLoggedOut(req, res, options = {}) {
  const error = options.error
    ? `<div class="alert">${escapeHtml(options.error)}</div>`
    : '';

  res.status(options.error ? 400 : 200).send(renderPage('Spotify Now Playing', `
    <main class="auth-grid">
      <section class="brand-panel">
        <p class="eyebrow">Spotify desktop to stream overlay</p>
        <h1>Spotify Now Playing</h1>
        <p class="lede">A self-hosted overlay service for creators who want fast now-playing cards without Spotify Web API calls. Your plugin sends local desktop player state directly to this server.</p>
        <div class="status-strip">
          <span>Local player data</span>
          <span>Realtime sockets</span>
          <span>Regeneratable API keys</span>
        </div>
      </section>

      <section class="panel auth-panel">
        ${error}
        <form method="post" action="/login" class="form-block">
          <h2>Login</h2>
          <label>Username
            <input name="username" autocomplete="username" required>
          </label>
          <label>Password
            <input name="password" type="password" autocomplete="current-password" required>
          </label>
          <button class="button primary" type="submit">Login</button>
        </form>

        <form method="post" action="/register" class="form-block">
          <h2>Register</h2>
          <label>Username
            <input name="username" autocomplete="username" minlength="3" maxlength="32" required>
          </label>
          <label>Display name
            <input name="displayName" maxlength="48" placeholder="shown on overlay">
          </label>
          <label>Password
            <input name="password" type="password" autocomplete="new-password" minlength="8" required>
          </label>
          <button class="button primary" type="submit">Create Account</button>
        </form>
      </section>
    </main>
  `));
}

function renderDashboard(req, res) {
  const user = req.user;
  const session = req.currentSession;
  const apiKey = session.lastApiKey || '';
  session.lastApiKey = '';

  const overlayUrl = buildAbsoluteUrl(req, `/overlay/${encodeURIComponent(user.publicId)}`);
  const publicUrl = buildAbsoluteUrl(req, `/u/${encodeURIComponent(user.publicId)}`);
  const apiUrl = buildAbsoluteUrl(req, '/api/nowplaying');
  const serverUrl = buildAbsoluteUrl(req, '');
  const payload = getPublicNowPlaying(user);
  const overlayStyle = getUserOverlayStyle(user);
  const keyBlock = apiKey
    ? `
      <label>New API key
        <div class="copy-row">
          <input readonly value="${escapeAttribute(apiKey)}" id="api-key">
          <button class="button" type="button" data-copy="#api-key">Copy</button>
        </div>
      </label>
      <div class="topbar-actions">
        <button class="button danger" type="submit" form="rotate-key-form">Regenerate API Key</button>
      </div>
      <p class="hint">This key is only shown once. Regenerating invalidates the previous plugin key.</p>
    `
    : `
      <label>API key
        <div class="copy-row">
          <input readonly value="${escapeAttribute(user.apiKeyPreview || 'hidden')}" disabled>
          <button class="button danger" type="submit" form="rotate-key-form">Regenerate</button>
        </div>
      </label>
      <p class="hint">Stored keys are hashed. Regenerate to reveal a fresh key, then paste it into the plugin.</p>
    `;

  res.send(renderPage('Now Playing Dashboard', `
    <main class="app-shell" data-public-id="${escapeAttribute(user.publicId)}">
      <header class="topbar">
        <div>
          <p class="eyebrow">Dashboard</p>
          <h1>${escapeHtml(user.displayName)}</h1>
        </div>
        <div class="topbar-actions">
          <a class="button primary" href="${escapeAttribute(overlayUrl)}">Open Overlay</a>
          <form method="post" action="/logout">
            <button class="button" type="submit">Logout</button>
          </form>
        </div>
      </header>

      <section class="dashboard-grid">
        <div class="panel">
          <h2>Plugin Connection</h2>
          <label>Server URL
            <div class="copy-row">
              <input id="server-url" readonly value="${escapeAttribute(serverUrl)}">
              <button class="button" type="button" data-copy="#server-url">Copy</button>
            </div>
          </label>
          ${keyBlock}
          <form method="post" action="/api-key/rotate" id="rotate-key-form"></form>
        </div>

        <div class="panel">
          <h2>Overlay URLs</h2>
          <label>Default overlay
            <div class="copy-row">
              <input id="overlay-url" readonly value="${escapeAttribute(overlayUrl)}">
              <button class="button" type="button" data-copy="#overlay-url">Copy</button>
            </div>
          </label>
          <label>Now-playing API
            <div class="copy-row">
              <input id="api-url" readonly value="${escapeAttribute(apiUrl)}">
              <button class="button" type="button" data-copy="#api-url">Copy</button>
            </div>
          </label>
          <p class="hint">Pull your own data with <code>X-API-Key</code> or <code>Authorization: Bearer</code>.</p>
          <label>Overlay style
            <select class="select-input" data-overlay-style-select>
              ${renderOverlayStyleOptions(overlayStyle)}
            </select>
          </label>
          <p class="hint" data-overlay-style-status>Open overlays using the default URL update when this changes.</p>
          <div class="topbar-actions">
            <a class="button primary" href="${escapeAttribute(publicUrl)}">Open Public Page</a>
            <a class="button" href="${escapeAttribute(overlayUrl)}" data-overlay-preview>Preview Overlay</a>
          </div>
        </div>

        <div class="panel now-card">
          <h2>Current State</h2>
          <div id="dashboard-now">
            ${renderSongMarkup(payload.song)}
          </div>
        </div>

        <div class="panel now-card">
          <h2>Server Config</h2>
          <div class="stat-grid">
            <div class="stat">
              <span>Public base URL</span>
              <strong>${escapeHtml(PUBLIC_BASE_URL || 'request host')}</strong>
            </div>
            <div class="stat">
              <span>Port</span>
              <strong>${PORT}</strong>
            </div>
            <div class="stat">
              <span>Database</span>
              <strong>${escapeHtml(describeDatabase())}</strong>
            </div>
            <div class="stat">
              <span>Realtime</span>
              <strong>Socket.IO</strong>
            </div>
          </div>
        </div>
      </section>
    </main>
    <script src="/socket.io/socket.io.js"></script>
    <script>
      document.querySelectorAll('[data-copy]').forEach((button) => {
        button.addEventListener('click', async () => {
          const input = document.querySelector(button.getAttribute('data-copy'));
          if (!input) return;
          await navigator.clipboard.writeText(input.value);
          button.textContent = 'Copied';
          setTimeout(() => button.textContent = 'Copy', 1200);
        });
      });

      const root = document.querySelector('[data-public-id]');
      const now = document.querySelector('#dashboard-now');
      const styleSelect = document.querySelector('[data-overlay-style-select]');
      const styleStatus = document.querySelector('[data-overlay-style-status]');
      const previewLink = document.querySelector('[data-overlay-preview]');

      if (styleSelect) {
        styleSelect.addEventListener('change', async () => {
          const overlayStyle = styleSelect.value;
          styleStatus.textContent = 'Saving overlay style...';
          try {
            const response = await fetch('/api/me/settings', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ overlayStyle }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
              throw new Error(data.error || 'Could not save overlay style.');
            }

            if (previewLink) {
              previewLink.href = data.user.overlayUrl;
            }
            styleStatus.textContent = 'Overlay style saved. Open overlays updated live.';
          } catch (error) {
            styleStatus.textContent = error.message || 'Could not save overlay style.';
          }
        });
      }

      if (root && now && window.io) {
        const socket = io({ query: { publicId: root.dataset.publicId } });
        socket.on('nowplaying', (payload) => {
          const song = payload && payload.song;
          if (!song || song.empty) {
            now.innerHTML = '<div class="empty-state">Waiting for plugin updates.</div>';
            return;
          }

          const image = song.image || '';
          const row = document.createElement('div');
          const art = document.createElement('div');
          const meta = document.createElement('div');
          const title = document.createElement('strong');
          const artist = document.createElement('span');
          const status = document.createElement('small');

          row.className = 'song-row';
          art.className = 'art';
          meta.className = 'song-meta';
          if (image) {
            art.style.backgroundImage = 'url(' + encodeURI(String(image)).replace(/[()"]/g, '') + ')';
          }
          title.textContent = song.name || 'Unknown track';
          artist.textContent = song.artistName || 'Unknown artist';
          status.textContent = song.isPlaying ? 'Playing' : 'Paused';
          meta.append(title, artist, status);
          row.append(art, meta);
          now.replaceChildren(row);
        });
      }
    </script>
  `));
}

function renderOverlayPage(req, user, style, styleLocked = false) {
  const initial = JSON.stringify(getPublicNowPlaying(user)).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(user.displayName)} - Now Playing</title>
    <link rel="stylesheet" href="/app.css">
    <style>html, body { background: transparent !important; }</style>
  </head>
  <body class="overlay-body">
    <main
      class="np-overlay-page"
      data-public-id="${escapeAttribute(user.publicId)}"
      data-initial="${escapeAttribute(initial)}"
      data-style="${escapeAttribute(style)}"
      data-style-locked="${styleLocked ? 'true' : 'false'}"
    >
      <div class="np-overlay">
        <div class="player-container ${escapeAttribute(style)}" data-player></div>
      </div>
    </main>
    <script src="/socket.io/socket.io.js"></script>
    <script src="/overlay.js"></script>
  </body>
</html>`;
}

function renderSongMarkup(song) {
  if (!song || song.empty) {
    return '<div class="empty-state">Waiting for plugin updates.</div>';
  }

  const imageStyle = song.image
    ? ` style="background-image:url('${escapeAttribute(cssImageUrl(song.image))}')"`
    : '';

  return `
    <div class="song-row">
      <div class="art"${imageStyle}></div>
      <div class="song-meta">
        <strong>${escapeHtml(song.name || 'Unknown track')}</strong>
        <span>${escapeHtml(song.artistName || 'Unknown artist')}</span>
        <small>${song.isPlaying ? 'Playing' : 'Paused'}${song.stale ? ' - stale' : ''}</small>
      </div>
    </div>
  `;
}

function renderPage(title, body) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/app.css">
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

async function createUser(body) {
  const username = sanitizeUsername(body.username);
  const password = String(body.password || '');
  const displayName = sanitizeDisplayName(body.displayName || username);

  if (!username) {
    throw new Error('Username must be 3-32 letters, numbers, underscores, or dashes.');
  }

  if (findUserByUsername(username)) {
    throw new Error('That username is already taken.');
  }

  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }

  const passwordRecord = hashPassword(password);
  const apiKey = createApiKey();
  const now = new Date().toISOString();
  const user = {
    id: createId(16),
    username,
    displayName,
    publicId: createPublicId(username),
    passwordHash: passwordRecord.hash,
    passwordSalt: passwordRecord.salt,
    passwordIterations: passwordRecord.iterations,
    apiKeyHash: hashApiKey(apiKey),
    apiKeyPreview: previewApiKey(apiKey),
    overlayStyle: 'default',
    createdAt: now,
    updatedAt: now,
  };

  db.users.push(user);
  await saveDb();

  return { user, apiKey };
}

function rotateApiKey(user) {
  const apiKey = createApiKey();
  user.apiKeyHash = hashApiKey(apiKey);
  user.apiKeyPreview = previewApiKey(apiKey);
  user.updatedAt = new Date().toISOString();
  return apiKey;
}

function updateUserSettings(user, body) {
  const overlayStyle = readOverlayStyle(body?.overlayStyle);
  if (overlayStyle) {
    user.overlayStyle = overlayStyle;
  }

  user.updatedAt = new Date().toISOString();
}

function emitSettingsUpdated(user) {
  io.to(roomForPublicId(user.publicId)).emit('settingsUpdated', serializePublicUser(user));
}

function createLoginSession(res, userId, lastApiKey = '') {
  const sessionId = createId(32);
  sessions.set(sessionId, {
    userId,
    lastApiKey,
    createdAt: Date.now(),
    lastSeen: Date.now(),
  });
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
  });
}

function destroyLoginSession(req, res) {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  if (sessionId) {
    sessions.delete(sessionId);
  }
  res.clearCookie(SESSION_COOKIE);
}

function getCurrentSession(req) {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  if (!sessionId) {
    return null;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return null;
  }

  if (Date.now() - session.lastSeen > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return null;
  }

  session.lastSeen = Date.now();
  return session;
}

function requireLogin(req, res, next) {
  if (!req.user) {
    res.status(401).format({
      html: () => res.redirect('/'),
      json: () => res.json({ error: 'Login required.' }),
      default: () => res.type('text').send('Login required.'),
    });
    return;
  }

  next();
}

function requireApiKey(req, res, next) {
  const apiKey = readApiKey(req);
  const apiKeyHash = apiKey ? hashApiKey(apiKey) : '';
  const user = apiKeyHash
    ? db.users.find((candidate) => timingSafeEqual(candidate.apiKeyHash, apiKeyHash))
    : null;

  if (!user) {
    res.status(401).json({ error: 'Invalid API key.' });
    return;
  }

  req.apiUser = user;
  next();
}

function readApiKey(req) {
  const headerKey = typeof req.headers['x-api-key'] === 'string'
    ? req.headers['x-api-key'].trim()
    : '';
  const auth = req.headers.authorization || '';
  const bearer = auth.toLowerCase().startsWith('bearer ')
    ? auth.slice('bearer '.length).trim()
    : '';
  const queryKey = readString(req.query?.apiKey, 256);

  return headerKey || bearer || queryKey || readString(req.body?.apiKey, 256);
}

function normalizeNowPlaying(body) {
  body = body || {};
  const cleared = body.cleared === true || body.clear === true;
  if (cleared) {
    return {
      empty: true,
      trackUri: '',
      name: '',
      title: '',
      artists: [],
      artistLinks: [],
      artistName: '',
      albumName: '',
      albumUri: '',
      albumUrl: '',
      image: '',
      coverImage: '',
      spotifyUrl: '',
      durationMs: 0,
      progressMs: 0,
      paused: true,
      isPlaying: false,
      source: readString(body.source, 80),
    };
  }

  const artists = readStringArray(body.artists, 120, 8);
  const durationMs = clampNumber(body.durationMs || body.duration || 0, 0, 24 * 60 * 60 * 1000);
  const progressMs = clampNumber(body.progressMs || body.progress || 0, 0, durationMs || 24 * 60 * 60 * 1000);
  const paused = body.paused === true || body.isPlaying === false || body.playing === false;
  const trackUri = readString(body.trackUri || body.uri, 256);
  const name = readString(body.name || body.title, 256);
  const albumUri = readString(body.albumUri || body.albumURI || body.album_uri, 256);
  const image = readString(body.image || body.imageUrl || body.coverUrl, 2048);
  const coverImage = readString(body.coverImage || body.albumImage || body.albumImageUrl, 2048) || image;
  const artistLinks = normalizeArtistLinks(body.artistLinks, artists);
  const artistName = readString(
    body.artistName || body.artist || artistLinks.map((artist) => artist.name).filter(Boolean).join(', ') || artists.join(', '),
    240,
  );
  const spotifyUrl = readString(body.spotifyUrl || body.trackUrl || body.externalUrl, 2048) || spotifyUrlFromUri(trackUri);
  const albumUrl = readString(body.albumUrl || body.albumSpotifyUrl || body.albumExternalUrl, 2048) || spotifyUrlFromUri(albumUri);

  return {
    empty: !trackUri && !name,
    trackUri,
    name,
    title: name,
    artists: artistLinks.length > 0 ? artistLinks.map((artist) => artist.name).filter(Boolean) : artists,
    artistLinks,
    artistName,
    albumName: readString(body.albumName || body.album, 256),
    albumUri,
    albumUrl,
    image,
    coverImage,
    spotifyUrl,
    durationMs,
    progressMs,
    paused,
    isPlaying: !paused,
    source: readString(body.source, 80),
  };
}

function getPublicNowPlaying(user) {
  const stored = db.nowPlaying[user.id];
  const serverTime = Date.now();

  if (!stored || stored.empty) {
    return {
      serverTime: new Date(serverTime).toISOString(),
      user: serializePublicUser(user),
      song: {
        empty: true,
        stale: true,
        trackUri: '',
        name: '',
        title: '',
        artists: [],
        artistLinks: [],
        artistName: '',
        albumName: '',
        albumUri: '',
        albumUrl: '',
        image: '',
        coverImage: '',
        spotifyUrl: '',
        durationMs: 0,
        progressMs: 0,
        paused: true,
        isPlaying: false,
        updatedAt: null,
      },
    };
  }

  const ageMs = Math.max(serverTime - Number(stored.receivedAt || serverTime), 0);
  const liveProgressMs = stored.isPlaying && stored.durationMs > 0
    ? Math.min(stored.progressMs + ageMs, stored.durationMs)
    : stored.progressMs;

  return {
    serverTime: new Date(serverTime).toISOString(),
    user: serializePublicUser(user),
    song: enrichSongForApi({
      ...stored,
      progressMs: liveProgressMs,
      stale: ageMs > STALE_AFTER_MS,
    }),
  };
}

function getOwnNowPlaying(user, req) {
  const payload = getPublicNowPlaying(user);
  const song = payload.song;

  return {
    ok: true,
    serverTime: payload.serverTime,
    user: payload.user,
    song,
    track: {
      uri: song.trackUri || '',
      title: song.title || song.name || '',
      name: song.name || song.title || '',
      spotifyUrl: song.spotifyUrl || '',
      durationMs: song.durationMs || 0,
      progressMs: song.progressMs || 0,
      paused: Boolean(song.paused),
      isPlaying: Boolean(song.isPlaying),
      stale: Boolean(song.stale),
    },
    album: {
      name: song.albumName || '',
      uri: song.albumUri || '',
      spotifyUrl: song.albumUrl || '',
      image: song.coverImage || song.image || '',
    },
    artists: Array.isArray(song.artistLinks) ? song.artistLinks : [],
    links: {
      overlay: buildAbsoluteUrl(req, `/overlay/${encodeURIComponent(user.publicId)}`),
      public: buildAbsoluteUrl(req, `/u/${encodeURIComponent(user.publicId)}`),
      track: song.spotifyUrl || '',
      album: song.albumUrl || '',
    },
  };
}

function enrichSongForApi(song) {
  const fallbackArtists = Array.isArray(song.artists) ? song.artists : [];
  const artistLinks = normalizeArtistLinks(song.artistLinks, fallbackArtists);
  const title = song.title || song.name || '';
  const spotifyUrl = song.spotifyUrl || spotifyUrlFromUri(song.trackUri);
  const albumUrl = song.albumUrl || spotifyUrlFromUri(song.albumUri);
  const coverImage = song.coverImage || song.image || '';

  return {
    ...song,
    name: song.name || title,
    title,
    artists: artistLinks.map((artist) => artist.name).filter(Boolean),
    artistLinks,
    artistName: song.artistName || artistLinks.map((artist) => artist.name).filter(Boolean).join(', '),
    albumUri: song.albumUri || '',
    albumUrl,
    image: song.image || coverImage,
    coverImage,
    spotifyUrl,
  };
}

function normalizeArtistLinks(value, fallbackNames = []) {
  const fallback = readStringArray(fallbackNames, 120, 8);
  const rawArtists = Array.isArray(value) ? value : [];
  const normalized = rawArtists
    .map((artist, index) => {
      if (typeof artist === 'string') {
        const name = readString(artist, 120);
        return name ? { name, uri: '', spotifyUrl: '' } : null;
      }

      const name = readString(artist?.name || fallback[index], 120);
      const uri = readString(artist?.uri || artist?.artistUri, 256);
      const spotifyUrl = readString(artist?.spotifyUrl || artist?.url || artist?.externalUrl, 2048)
        || spotifyUrlFromUri(uri);

      return name ? { name, uri, spotifyUrl } : null;
    })
    .filter(Boolean)
    .slice(0, 8);

  if (normalized.length > 0) {
    return normalized;
  }

  return fallback.map((name) => ({ name, uri: '', spotifyUrl: '' }));
}

function spotifyUrlFromUri(uri) {
  const [service, type, id] = readString(uri, 256).split(':');
  const supportedTypes = {
    album: 'album',
    artist: 'artist',
    episode: 'episode',
    playlist: 'playlist',
    show: 'show',
    track: 'track',
  };

  return service === 'spotify' && supportedTypes[type] && id
    ? `https://open.spotify.com/${supportedTypes[type]}/${encodeURIComponent(id)}`
    : '';
}

function serializePrivateUser(req, user) {
  return {
    ...serializePublicUser(user),
    username: user.username,
    apiKeyPreview: user.apiKeyPreview,
    overlayUrl: buildAbsoluteUrl(req, `/overlay/${encodeURIComponent(user.publicId)}`),
    publicUrl: buildAbsoluteUrl(req, `/u/${encodeURIComponent(user.publicId)}`),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function serializePublicUser(user) {
  return {
    publicId: user.publicId,
    displayName: user.displayName,
    overlayStyle: getUserOverlayStyle(user),
  };
}

function subscribeSocketToPublicId(socket, publicId) {
  const user = getUserByPublicId(publicId);
  if (!user) {
    socket.emit('notFound');
    return;
  }

  socket.join(roomForPublicId(user.publicId));
  socket.emit('nowplaying', getPublicNowPlaying(user));
}

function roomForPublicId(publicId) {
  return `nowplaying:${publicId}`;
}

function buildAbsoluteUrl(req, routePath) {
  if (PUBLIC_BASE_URL) {
    return `${PUBLIC_BASE_URL}${routePath || ''}`;
  }

  const host = req.get('host') || `localhost:${PORT}`;
  const forwardedProto = req.get('x-forwarded-proto');
  const protocol = forwardedProto ? forwardedProto.split(',')[0].trim() : req.protocol;
  return `${protocol}://${host}${routePath || ''}`;
}

function readIntEnv(name, fallback) {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }

  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeDatabaseDialect(value) {
  const dialect = String(value || '').trim().toLowerCase();
  if (['postgresql', 'postgres', 'pgsql', 'progresssql', 'progressql'].includes(dialect)) {
    return 'postgres';
  }

  if (dialect === 'mysql') {
    return 'mysql';
  }

  return 'sqlite';
}

function inferDatabaseDialect(url) {
  const value = String(url || '').trim().toLowerCase();
  if (value.startsWith('postgres://') || value.startsWith('postgresql://')) {
    return 'postgres';
  }

  if (value.startsWith('mysql://')) {
    return 'mysql';
  }

  if (value.startsWith('sqlite:')) {
    return 'sqlite';
  }

  return '';
}

function inferDatabaseDialectFromEnv() {
  return process.env.DATABASE_HOST
    || process.env.DB_HOST
    || process.env.DATABASE_NAME
    || process.env.DB_DATABASE
    ? 'mysql'
    : '';
}

function defaultDatabasePort(dialect) {
  if (dialect === 'postgres') {
    return 5432;
  }

  if (dialect === 'mysql') {
    return 3306;
  }

  return 0;
}

function describeDatabase() {
  if (DATABASE_DIALECT === 'sqlite') {
    return `sqlite:${SQLITE_STORAGE}`;
  }

  if (DATABASE_URL) {
    return `${DATABASE_DIALECT}:DATABASE_URL`;
  }

  return `${DATABASE_DIALECT}:${DATABASE_HOST}/${DATABASE_NAME}`;
}

function isTruthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function readOverlayStyle(value) {
  const style = Array.isArray(value) ? value[0] : value;
  return OVERLAY_STYLES.includes(style) ? style : '';
}

function getUserOverlayStyle(user) {
  return readOverlayStyle(user?.overlayStyle) || 'default';
}

function renderOverlayStyleOptions(selectedStyle) {
  return OVERLAY_STYLES.map((style) => {
    const selected = style === selectedStyle ? ' selected' : '';
    const label = style.charAt(0).toUpperCase() + style.slice(1);
    return `<option value="${escapeAttribute(style)}"${selected}>${escapeHtml(label)}</option>`;
  }).join('');
}

function sanitizeUsername(value) {
  const username = readString(value, 64).toLowerCase();
  return /^[a-z0-9_-]{3,32}$/.test(username) ? username : '';
}

function sanitizeDisplayName(value) {
  return readString(value, 48).replace(/\s+/g, ' ') || 'Spotify User';
}

function createPublicId(username) {
  let publicId = username;
  while (getUserByPublicId(publicId)) {
    publicId = `${username}-${createId(3)}`;
  }
  return publicId;
}

function getUserById(id) {
  return db.users.find((user) => user.id === id) || null;
}

function findUserByUsername(username) {
  const normalized = sanitizeUsername(username);
  return normalized
    ? db.users.find((user) => user.username === normalized) || null
    : null;
}

function getUserByPublicId(publicId) {
  const normalized = readString(publicId, 96).toLowerCase();
  return db.users.find((user) => user.publicId.toLowerCase() === normalized) || null;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const iterations = 310000;
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('base64url');
  return { salt, iterations, hash };
}

function verifyPassword(user, password) {
  const hash = crypto
    .pbkdf2Sync(password, user.passwordSalt, user.passwordIterations, 32, 'sha256')
    .toString('base64url');

  return timingSafeEqual(hash, user.passwordHash);
}

function createApiKey() {
  return `npk_${crypto.randomBytes(32).toString('base64url')}`;
}

function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

function previewApiKey(apiKey) {
  return `${apiKey.slice(0, 10)}...${apiKey.slice(-6)}`;
}

function createId(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header.split(';').reduce((cookies, item) => {
    const index = item.indexOf('=');
    if (index === -1) {
      return cookies;
    }

    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function createDatabase() {
  if (DATABASE_DIALECT === 'sqlite') {
    return createSqliteDatabase();
  }

  const options = {
    dialect: DATABASE_DIALECT,
    logging: isTruthyEnv(process.env.DATABASE_LOGGING) ? console.log : false,
    define: {
      freezeTableName: true,
    },
  };

  const instance = DATABASE_URL
    ? new Sequelize(DATABASE_URL, options)
    : new Sequelize(
      DATABASE_NAME,
      DATABASE_USER,
      DATABASE_PASSWORD,
      {
        ...options,
        host: DATABASE_HOST,
        port: readIntEnv('DATABASE_PORT', readIntEnv('DB_PORT', defaultDatabasePort(DATABASE_DIALECT))),
      },
    );

  const User = instance.define('User', {
    id: { type: DataTypes.STRING(64), primaryKey: true },
    username: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    displayName: { type: DataTypes.STRING(96), allowNull: false },
    publicId: { type: DataTypes.STRING(128), allowNull: false, unique: true },
    passwordHash: { type: DataTypes.STRING(256), allowNull: false },
    passwordSalt: { type: DataTypes.STRING(256), allowNull: false },
    passwordIterations: { type: DataTypes.INTEGER, allowNull: false },
    apiKeyHash: { type: DataTypes.STRING(128), allowNull: false },
    apiKeyPreview: { type: DataTypes.STRING(64), allowNull: false },
    overlayStyle: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'default' },
    createdAt: { type: DataTypes.STRING(40), allowNull: false },
    updatedAt: { type: DataTypes.STRING(40), allowNull: false },
  }, {
    tableName: 'users',
    timestamps: false,
  });

  const NowPlaying = instance.define('NowPlaying', {
    userId: { type: DataTypes.STRING(64), primaryKey: true },
    payload: { type: DataTypes.TEXT('long'), allowNull: false },
  }, {
    tableName: 'now_playing',
    timestamps: false,
  });

  User.hasOne(NowPlaying, {
    foreignKey: 'userId',
    sourceKey: 'id',
    onDelete: 'CASCADE',
  });
  NowPlaying.belongsTo(User, {
    foreignKey: 'userId',
    targetKey: 'id',
  });

  return { sequelize: instance, UserModel: User, NowPlayingModel: NowPlaying };
}

function createSqliteDatabase() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    throw new Error('SQLite storage needs Node.js with built-in node:sqlite support. Use Node 24 or set DATABASE_DIALECT=mysql/postgres with DATABASE_* or DB_* env vars.');
  }

  fs.mkdirSync(path.dirname(SQLITE_STORAGE), { recursive: true });
  return {
    sequelize: null,
    UserModel: null,
    NowPlayingModel: null,
    sqliteDb: new DatabaseSync(SQLITE_STORAGE),
  };
}

async function initializeDatabase() {
  if (sqliteDb) {
    initializeSqliteDatabase();
    db = await loadDb();
    await importLegacyJsonIfNeeded();
    return;
  }

  await sequelize.authenticate();
  await sequelize.sync();
  db = await loadDb();
  await importLegacyJsonIfNeeded();
}

function initializeSqliteDatabase() {
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      displayName TEXT NOT NULL,
      publicId TEXT NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL,
      passwordSalt TEXT NOT NULL,
      passwordIterations INTEGER NOT NULL,
      apiKeyHash TEXT NOT NULL,
      apiKeyPreview TEXT NOT NULL,
      overlayStyle TEXT NOT NULL DEFAULT 'default',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS now_playing (
      userId TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

async function loadDb() {
  if (sqliteDb) {
    return loadSqliteDb();
  }

  const users = (await UserModel.findAll({ raw: true }))
    .map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      publicId: user.publicId,
      passwordHash: user.passwordHash,
      passwordSalt: user.passwordSalt,
      passwordIterations: user.passwordIterations,
      apiKeyHash: user.apiKeyHash,
      apiKeyPreview: user.apiKeyPreview,
      overlayStyle: user.overlayStyle,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }));
  const nowPlayingRows = await NowPlayingModel.findAll({ raw: true });
  const nowPlaying = {};

  nowPlayingRows.forEach((row) => {
    try {
      nowPlaying[row.userId] = JSON.parse(row.payload);
    } catch {
      nowPlaying[row.userId] = { empty: true };
    }
  });

  return { users, nowPlaying };
}

function loadSqliteDb() {
  const users = sqliteDb.prepare('SELECT * FROM users').all()
    .map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      publicId: user.publicId,
      passwordHash: user.passwordHash,
      passwordSalt: user.passwordSalt,
      passwordIterations: user.passwordIterations,
      apiKeyHash: user.apiKeyHash,
      apiKeyPreview: user.apiKeyPreview,
      overlayStyle: user.overlayStyle,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }));
  const nowPlayingRows = sqliteDb.prepare('SELECT * FROM now_playing').all();
  const nowPlaying = {};

  nowPlayingRows.forEach((row) => {
    try {
      nowPlaying[row.userId] = JSON.parse(row.payload);
    } catch {
      nowPlaying[row.userId] = { empty: true };
    }
  });

  return { users, nowPlaying };
}

let saveQueue = Promise.resolve();

function saveDb() {
  const nextSave = saveQueue.then(() => persistDb(), () => persistDb());
  saveQueue = nextSave.catch((error) => {
    console.error('Database save failed.');
    console.error(error);
  });
  return nextSave;
}

async function persistDb() {
  if (sqliteDb) {
    persistSqliteDb();
    return;
  }

  await sequelize.transaction(async (transaction) => {
    const userIds = db.users.map((user) => user.id);
    for (const user of db.users) {
      await UserModel.upsert({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        publicId: user.publicId,
        passwordHash: user.passwordHash,
        passwordSalt: user.passwordSalt,
        passwordIterations: user.passwordIterations,
        apiKeyHash: user.apiKeyHash,
        apiKeyPreview: user.apiKeyPreview,
        overlayStyle: getUserOverlayStyle(user),
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      }, { transaction });
    }

    await destroyMissingRows(UserModel, 'id', userIds, transaction);

    const nowPlayingUserIds = Object.keys(db.nowPlaying);
    for (const userId of nowPlayingUserIds) {
      await NowPlayingModel.upsert({
        userId,
        payload: JSON.stringify(db.nowPlaying[userId] || { empty: true }),
      }, { transaction });
    }

    await destroyMissingRows(NowPlayingModel, 'userId', nowPlayingUserIds, transaction);
  });
}

function persistSqliteDb() {
  sqliteDb.exec('BEGIN IMMEDIATE');
  try {
    const upsertUser = sqliteDb.prepare(`
      INSERT INTO users (
        id,
        username,
        displayName,
        publicId,
        passwordHash,
        passwordSalt,
        passwordIterations,
        apiKeyHash,
        apiKeyPreview,
        overlayStyle,
        createdAt,
        updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        username = excluded.username,
        displayName = excluded.displayName,
        publicId = excluded.publicId,
        passwordHash = excluded.passwordHash,
        passwordSalt = excluded.passwordSalt,
        passwordIterations = excluded.passwordIterations,
        apiKeyHash = excluded.apiKeyHash,
        apiKeyPreview = excluded.apiKeyPreview,
        overlayStyle = excluded.overlayStyle,
        createdAt = excluded.createdAt,
        updatedAt = excluded.updatedAt
    `);
    const upsertNowPlaying = sqliteDb.prepare(`
      INSERT INTO now_playing (userId, payload)
      VALUES (?, ?)
      ON CONFLICT(userId) DO UPDATE SET
        payload = excluded.payload
    `);
    const userIds = db.users.map((user) => user.id);

    for (const user of db.users) {
      upsertUser.run(
        user.id,
        user.username,
        user.displayName,
        user.publicId,
        user.passwordHash,
        user.passwordSalt,
        user.passwordIterations,
        user.apiKeyHash,
        user.apiKeyPreview,
        getUserOverlayStyle(user),
        user.createdAt,
        user.updatedAt,
      );
    }

    deleteMissingSqliteRows('users', 'id', userIds);

    const nowPlayingUserIds = Object.keys(db.nowPlaying);
    for (const userId of nowPlayingUserIds) {
      upsertNowPlaying.run(userId, JSON.stringify(db.nowPlaying[userId] || { empty: true }));
    }

    deleteMissingSqliteRows('now_playing', 'userId', nowPlayingUserIds);
    sqliteDb.exec('COMMIT');
  } catch (error) {
    sqliteDb.exec('ROLLBACK');
    throw error;
  }
}

function deleteMissingSqliteRows(table, field, ids) {
  if (ids.length === 0) {
    sqliteDb.prepare(`DELETE FROM ${table}`).run();
    return;
  }

  const placeholders = ids.map(() => '?').join(', ');
  sqliteDb.prepare(`DELETE FROM ${table} WHERE ${field} NOT IN (${placeholders})`).run(...ids);
}

async function destroyMissingRows(model, field, currentIds, transaction) {
  if (currentIds.length === 0) {
    await model.destroy({ where: {}, transaction });
    return;
  }

  await model.destroy({
    where: {
      [field]: {
        [Op.notIn]: currentIds,
      },
    },
    transaction,
  });
}

async function importLegacyJsonIfNeeded() {
  if (db.users.length > 0 || !fs.existsSync(LEGACY_JSON_PATH)) {
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(LEGACY_JSON_PATH, 'utf8'));
    const users = Array.isArray(parsed.users) ? parsed.users : [];
    const nowPlaying = parsed.nowPlaying && typeof parsed.nowPlaying === 'object'
      ? parsed.nowPlaying
      : {};

    if (users.length === 0 && Object.keys(nowPlaying).length === 0) {
      return;
    }

    db = { users, nowPlaying };
    await saveDb();
    console.log(`Imported legacy JSON database from ${LEGACY_JSON_PATH}`);
  } catch (error) {
    console.warn(`Could not import legacy JSON database from ${LEGACY_JSON_PATH}: ${error.message}`);
  }
}

function readString(value, maxLength) {
  if (Array.isArray(value)) {
    value = value[0];
  }

  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().slice(0, maxLength);
}

function readStringArray(value, maxLength, maxItems) {
  if (Array.isArray(value)) {
    return value
      .map((item) => readString(item, maxLength))
      .filter(Boolean)
      .slice(0, maxItems);
  }

  const stringValue = readString(value, maxLength * maxItems);
  return stringValue
    ? stringValue.split(',').map((item) => readString(item, maxLength)).filter(Boolean).slice(0, maxItems)
    : [];
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return min;
  }

  return Math.min(Math.max(Math.round(number), min), max);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function cssImageUrl(value) {
  return encodeURI(String(value || '')).replace(/[()'"]/g, '');
}
