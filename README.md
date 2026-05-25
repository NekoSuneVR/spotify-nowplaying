# Spotify Now Playing Server

Self-hosted Node.js app for Spotify desktop now-playing overlays.

The server does not call Spotify's Web API. It accepts now-playing payloads from the companion Spicetify plugin using a per-user API key, then serves browser overlay URLs.

## Start

```bash
npm install
npm run build
npm run dev
```

Copy `.env.example` to `.env` when deploying and set:

```env
PORT=3000
PUBLIC_BASE_URL=https://spnp.nekosunevr.co.uk
DATABASE_DIALECT=sqlite
SQLITE_STORAGE=./data/nowplaying.sqlite
```

The server uses Sequelize for storage. SQLite is the default and needs no separate database server.

MySQL example:

```env
DATABASE_DIALECT=mysql
DATABASE_HOST=127.0.0.1
DATABASE_PORT=3306
DATABASE_NAME=spotify_nowplaying
DATABASE_USER=spotify_nowplaying
DATABASE_PASSWORD=change-me
```

PostgreSQL example:

```env
DATABASE_DIALECT=postgresql
DATABASE_HOST=127.0.0.1
DATABASE_PORT=5432
DATABASE_NAME=spotify_nowplaying
DATABASE_USER=spotify_nowplaying
DATABASE_PASSWORD=change-me
```

You can also use a single `DATABASE_URL`, for example `postgres://user:pass@host:5432/spotify_nowplaying`. Existing old JSON installs can be imported once with `LEGACY_JSON_PATH=./data/db.json`.

Open `http://localhost:3000`, register an account, and copy:

- `Server URL` into the plugin server field.
- the generated `API key` into the plugin API key field.
- the overlay URL into OBS, VRChat browser panels, or any browser source.

Production start:

```bash
npm start
```

The dashboard includes a `Regenerate API Key` button. Regenerating invalidates the old plugin key and shows the new key once.

## API

Plugin update endpoint:

```http
POST /api/nowplaying
X-API-Key: npk_...
Content-Type: application/json
```

Body:

```json
{
  "trackUri": "spotify:track:...",
  "name": "Song name",
  "artists": ["Artist"],
  "artistLinks": [
    {
      "name": "Artist",
      "uri": "spotify:artist:...",
      "spotifyUrl": "https://open.spotify.com/artist/..."
    }
  ],
  "artistName": "Artist",
  "albumName": "Album",
  "albumUri": "spotify:album:...",
  "albumUrl": "https://open.spotify.com/album/...",
  "image": "https://...",
  "coverImage": "https://...",
  "spotifyUrl": "https://open.spotify.com/track/...",
  "durationMs": 180000,
  "progressMs": 42000,
  "paused": false,
  "source": "spicetify-nowplaying"
}
```

Authenticated read endpoint for the current user's now-playing data:

```http
GET /api/nowplaying
X-API-Key: npk_...
```

You can also send the key as `Authorization: Bearer npk_...`. The server does not call Spotify; URLs are computed from the Spotify URIs sent by the plugin.

Example response:

```json
{
  "ok": true,
  "serverTime": "2026-05-25T07:30:00.000Z",
  "user": {
    "publicId": "demo",
    "displayName": "Demo",
    "overlayStyle": "default"
  },
  "track": {
    "uri": "spotify:track:...",
    "title": "Song name",
    "spotifyUrl": "https://open.spotify.com/track/...",
    "durationMs": 180000,
    "progressMs": 42000,
    "paused": false,
    "isPlaying": true,
    "stale": false
  },
  "album": {
    "name": "Album",
    "uri": "spotify:album:...",
    "spotifyUrl": "https://open.spotify.com/album/...",
    "image": "https://..."
  },
  "artists": [
    {
      "name": "Artist",
      "uri": "spotify:artist:...",
      "spotifyUrl": "https://open.spotify.com/artist/..."
    }
  ],
  "links": {
    "overlay": "https://spnp.nekosunevr.co.uk/overlay/demo",
    "public": "https://spnp.nekosunevr.co.uk/u/demo",
    "track": "https://open.spotify.com/track/...",
    "album": "https://open.spotify.com/album/..."
  }
}
```
