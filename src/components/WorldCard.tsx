import type { CapabilityLoadState, MediaCapabilities } from '../hooks/useMediaCapabilities';
import { isYouTubeVideoId, youtubeEmbedUrl } from '../../shared/youtube';

export function ExternalVideoMedia({ item, capabilities, capabilityState }: {
  item: any;
  capabilities?: MediaCapabilities | null;
  capabilityState?: CapabilityLoadState;
}) {
  if (item.itemType !== 'video') return null;
  const valid = item.mediaProvider === 'youtube' && isYouTubeVideoId(item.videoId);
  const canEmbed = valid && capabilityState === 'loaded' && !!capabilities?.externalVideoEmbeds.enabled;
  return (
    <div className="world-video-media">
      {canEmbed ? (
        <iframe
          src={youtubeEmbedUrl(item.videoId)}
          title={item.title || 'YouTube video'}
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />
      ) : item.imageUrl ? (
        <img src={item.imageUrl} alt="" className="world-episode-img" loading="lazy" />
      ) : null}
      {!canEmbed && (
        <p className="muted" role="status">
          {capabilityState === 'error'
            ? 'Embedded playback availability could not be confirmed. Open the video on YouTube.'
            : capabilities?.externalVideoEmbeds.reason || 'Embedded playback is unavailable. Open the video on YouTube.'}
        </p>
      )}
    </div>
  );
}

export default function WorldCard({ item, capabilities, capabilityState }: {
  item: any;
  capabilities?: MediaCapabilities | null;
  capabilityState?: CapabilityLoadState;
}) {
  const isPodcast = item.itemType === 'podcast';
  const isVideo = item.itemType === 'video';
  return (
    <article className="world-card">
      <div className="world-card-source">
        <span className="world-source-badge">External: {item.sourceName}</span>
        {isPodcast && <span className="world-source-badge">Podcast</span>}
        {isVideo && <span className="world-source-badge">Video</span>}
        {item.sourceCategory && <span className="world-category">{item.sourceCategory}</span>}
        {item.author && <span className="world-author">by {item.author}</span>}
      </div>
      <h3 className="world-card-title"><a href={item.linkUrl} target="_blank" rel="noopener noreferrer">{item.title}</a></h3>
      {item.summary && <p className="world-card-summary">{item.summary.slice(0, 280)}{item.summary.length > 280 ? '...' : ''}</p>}
      {item.enclosureUrl && item.enclosureType?.startsWith('audio/') && (
        <audio controls className="world-audio-player" preload="none"><source src={item.enclosureUrl} type={item.enclosureType} /></audio>
      )}
      {item.episodeImageUrl && <img src={item.episodeImageUrl} alt="" className="world-episode-img" loading="lazy" />}
      <ExternalVideoMedia item={item} capabilities={capabilities} capabilityState={capabilityState} />
      <div className="world-card-footer">
        <time>{item.publishedAt ? new Date(item.publishedAt).toLocaleDateString() : ''}</time>
        <a href={item.linkUrl} target="_blank" rel="noopener noreferrer" className="world-link">Open original</a>
      </div>
    </article>
  );
}
