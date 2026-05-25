export type ArtistLink = {
  name: string;
  uri: string;
  spotifyUrl: string;
};

export type NowPlayingPayload = {
  cleared?: boolean;
  trackUri: string;
  name: string;
  title: string;
  artists: string[];
  artistLinks: ArtistLink[];
  artistName: string;
  albumName: string;
  albumUri: string;
  albumUrl: string;
  image: string;
  coverImage: string;
  spotifyUrl: string;
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
  const artistLinks = extractArtistLinks(item, metadata, artists);
  const albumName = firstString(
    item.album?.name,
    item.albumOfTrack?.name,
    metadata.album_title,
    metadata.album_name,
    metadata.album,
  );
  const albumUri = extractAlbumUri(item, metadata);
  const image = extractImage(item, metadata);
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
  const name = firstString(item.name, metadata.title, metadata.name);

  return {
    trackUri,
    name,
    title: name,
    artists: artistLinks.length > 0 ? artistLinks.map((artist) => artist.name) : artists,
    artistLinks,
    artistName: artistLinks.length > 0 ? artistLinks.map((artist) => artist.name).join(', ') : artists.join(', '),
    albumName,
    albumUri,
    albumUrl: spotifyUrlFromUri(albumUri),
    image,
    coverImage: image,
    spotifyUrl: spotifyUrlFromUri(trackUri),
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
  };
}

function extractArtists(item: any, metadata: Record<string, any>) {
  const names = collectArtistCandidates(item)
    .map((artist: any) => firstString(artist?.name, artist?.profile?.name))
    .filter(Boolean);

  if (names.length > 0) {
    return names;
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

function extractArtistLinks(item: any, metadata: Record<string, any>, fallbackNames: string[]) {
  const links = collectArtistCandidates(item)
    .map((artist: any) => {
      const name = firstString(artist?.name, artist?.profile?.name);
      const uri = firstString(artist?.uri, artist?.profile?.uri, artist?.artistUri);
      const spotifyUrl = firstString(
        artist?.external_urls?.spotify,
        artist?.externalUrls?.spotify,
        artist?.url,
      ) || spotifyUrlFromUri(uri);

      return name ? { name, uri, spotifyUrl } : null;
    })
    .filter(Boolean) as ArtistLink[];

  if (links.length > 0) {
    return dedupeArtists(links);
  }

  const metadataUris = splitMetadataList(firstString(
    metadata.artist_uri,
    metadata.artist_uris,
    metadata.artistUri,
    metadata.artistUris,
  ));

  return fallbackNames.map((name, index) => {
    const uri = metadataUris[index] || '';
    return {
      name,
      uri,
      spotifyUrl: spotifyUrlFromUri(uri),
    };
  });
}

function collectArtistCandidates(item: any) {
  const candidates: any[] = [];
  const add = (value: any) => {
    if (!value) {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(add);
      return;
    }

    candidates.push(value);
  };

  add(item.artists);
  add(item.artistsWithRoles);
  add(item.artistsWithRoles?.map((role: any) => role?.artists));
  add(item.artistsWithRoles?.map((role: any) => role?.artist));
  add(item.albumOfTrack?.artists);
  return candidates;
}

function dedupeArtists(artists: ArtistLink[]) {
  const seen = new Set<string>();
  return artists.filter((artist) => {
    const key = artist.uri || artist.spotifyUrl || artist.name.toLowerCase();
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  }).slice(0, 8);
}

function extractAlbumUri(item: any, metadata: Record<string, any>) {
  return firstString(
    item.album?.uri,
    item.albumOfTrack?.uri,
    metadata.album_uri,
    metadata.albumUri,
  );
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

function spotifyUrlFromUri(uri: string) {
  const [service, type, id] = uri.split(':');
  const supportedTypes: Record<string, string> = {
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

function splitMetadataList(value: string) {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
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
