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
```

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
  "artistName": "Artist",
  "albumName": "Album",
  "image": "https://...",
  "durationMs": 180000,
  "progressMs": 42000,
  "paused": false,
  "source": "spicetify-nowplaying"
}
```
