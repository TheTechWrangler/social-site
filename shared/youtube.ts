export const YOUTUBE_CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
export const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export function isYouTubeChannelId(value: unknown): boolean {
  return typeof value === 'string' && YOUTUBE_CHANNEL_ID_PATTERN.test(value);
}

export function isYouTubeVideoId(value: unknown): boolean {
  return typeof value === 'string' && YOUTUBE_VIDEO_ID_PATTERN.test(value);
}

export function parseYouTubeChannelLocator(value: string): string | null {
  const locator = value.trim();
  if (isYouTubeChannelId(locator)) return locator;
  if (locator.length > 2048) return null;

  let url: URL;
  try { url = new URL(locator); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || !['youtube.com', 'www.youtube.com'].includes(host)
    || url.username || url.password || url.port || url.search || url.hash) return null;
  const match = url.pathname.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})\/?$/);
  return match?.[1] ?? null;
}

export function youtubeChannelFeedUrl(channelId: string): string {
  if (!isYouTubeChannelId(channelId)) throw new Error('Invalid YouTube channel ID.');
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

export function youtubeChannelHomepageUrl(channelId: string): string {
  if (!isYouTubeChannelId(channelId)) throw new Error('Invalid YouTube channel ID.');
  return `https://www.youtube.com/channel/${channelId}`;
}

export function youtubeWatchUrl(videoId: string): string {
  if (!isYouTubeVideoId(videoId)) throw new Error('Invalid YouTube video ID.');
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function youtubeEmbedUrl(videoId: string): string {
  if (!isYouTubeVideoId(videoId)) throw new Error('Invalid YouTube video ID.');
  return `https://www.youtube-nocookie.com/embed/${videoId}`;
}

export function youtubeThumbnailUrl(videoId: string): string {
  if (!isYouTubeVideoId(videoId)) throw new Error('Invalid YouTube video ID.');
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}
