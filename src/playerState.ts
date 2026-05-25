export type NowPlayingPayload = {
  cleared?: boolean;
  trackUri: string;
  name: string;
  artists: string[];
  artistName: string;
  albumName: string;
  image: string;
  durationMs: number;
  progressMs: number;
  paused: boolean;
  isPlaying: boolean;
};

export function readNowPlaying(): NowPlayingPayload {
  const playerState = Spicetify.Platform?.PlayerAPI?._state || {};
  const playerData = Spicetify.Player?.data || {};
  const item = playerState.item || playerData.item || playerData.track || {};
  const metadata = item.metadata || playerData.track?.metadata || {};
  const trackUri = firstString(item.uri, playerData.track?.uri, metadata.uri);
  const trackType = trackUri.split(':')[1] || '';

  if (!trackUri || trackType === 'ad') {
    return clearedPayload();
  }

  const artists = extractArtists(item, metadata);
  const albumName = firstString(
    item.album?.name,
    item.albumOfTrack?.name,
    metadata.album_title,
    metadata.album_name,
    metadata.album,
  );
  const durationMs = firstNumber(
    item.duration?.milliseconds,
    item.duration?.totalMilliseconds,
    item.duration_ms,
    playerState.duration,
    playerData.duration,
    Spicetify.Player.getDuration?.(),
  );
  const progressMs = firstNumber(
    Spicetify.Player.getProgress?.(),
    playerState.positionAsOfTimestamp,
    playerState.position_as_of_timestamp,
    playerData.position_as_of_timestamp,
  );
  const isPlaying = Boolean(Spicetify.Player.isPlaying?.());

  return {
    trackUri,
    name: firstString(item.name, metadata.title, metadata.name),
    artists,
    artistName: artists.join(', '),
    albumName,
    image: extractImage(item, metadata),
    durationMs,
    progressMs,
    paused: !isPlaying,
    isPlaying,
  };
}

function clearedPayload(): NowPlayingPayload {
  return {
    cleared: true,
    trackUri: '',
    name: '',
    artists: [],
    artistName: '',
    albumName: '',
    image: '',
    durationMs: 0,
    progressMs: 0,
    paused: true,
    isPlaying: false,
  };
}

function extractArtists(item: any, metadata: Record<string, any>) {
  const artistObjects = Array.isArray(item.artists)
    ? item.artists
    : Array.isArray(item.artistsWithRoles)
      ? item.artistsWithRoles
      : [];
  if (Array.isArray(artistObjects)) {
    const names = artistObjects
      .map((artist: any) => firstString(artist?.name, artist?.profile?.name))
      .filter(Boolean);

    if (names.length > 0) {
      return names;
    }
  }

  const metadataArtist = firstString(
    metadata.artist_name,
    metadata.artist,
    metadata.artists,
    item.show?.name,
    item.publisher,
  );

  return metadataArtist
    ? metadataArtist.split(',').map((part) => part.trim()).filter(Boolean)
    : [];
}

function extractImage(item: any, metadata: Record<string, any>) {
  return firstString(
    item.images?.[0]?.url,
    item.images?.[1]?.url,
    item.album?.images?.[0]?.url,
    item.albumOfTrack?.coverArt?.sources?.[0]?.url,
    item.coverArt?.sources?.[0]?.url,
    metadata.image_url,
    metadata.image_xlarge_url,
    metadata.album_image_url,
    metadata.cover_url,
  );
}

function firstString(...values: any[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function firstNumber(...values: any[]) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) {
      return Math.round(number);
    }
  }

  return 0;
}
