# Spotify Now Playing Plugin

Spicetify plugin that sends your local Spotify desktop player state to `spotify-nowplaying-server`.

It does not call Spotify's Web API. Track title, artists, album art, duration, play/pause state, and progress are read from the local Spicetify/Spotify desktop player state.

## Build

```bash
npm install
npm run build
```

Install the built extension with Spicetify, then open the `Spotify Now Playing` top-bar button.

Fields:

- `Server URL`: defaults to `https://spnp.nekosunevr.co.uk`. Change `src/config.ts` if your public default domain changes.
- `API key`: generated after registering on the server dashboard.
- `Update interval ms`: how often the plugin sends heartbeat updates.

The top-bar button opens the settings modal. The plugin also watches local Spotify state changes every 500ms, so skips and play/pause changes are sent immediately even if a Spotify event is missed. The server returns your overlay URL after the first successful update.
