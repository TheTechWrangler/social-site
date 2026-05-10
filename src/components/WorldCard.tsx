export default function WorldCard({ item }: { item: any }) {
  const isPodcast = item.itemType === 'podcast';
  return (
    <article className="world-card">
      <div className="world-card-source">
        <span className="world-source-badge">🌐 {item.sourceName}</span>
        {isPodcast && <span className="world-source-badge" style={{ background: 'rgba(139,92,246,0.15)', color: 'var(--purple-soft)', border: '1px solid rgba(139,92,246,0.25)' }}>🎙 Podcast</span>}
        {item.sourceCategory && <span className="world-category">{item.sourceCategory}</span>}
        {item.author && <span className="world-author">by {item.author}</span>}
      </div>
      <h3 className="world-card-title"><a href={item.linkUrl} target="_blank" rel="noopener noreferrer">{item.title}</a></h3>
      {item.summary && <p className="world-card-summary">{item.summary.slice(0, 280)}{item.summary.length > 280 ? '...' : ''}</p>}
      {item.enclosureUrl && item.enclosureType?.startsWith('audio/') && (
        <audio controls className="world-audio-player" preload="none"><source src={item.enclosureUrl} type={item.enclosureType} /></audio>
      )}
      {item.episodeImageUrl && <img src={item.episodeImageUrl} alt="" className="world-episode-img" loading="lazy" />}
      <div className="world-card-footer">
        <time>{item.publishedAt ? new Date(item.publishedAt).toLocaleDateString() : ''}</time>
        <a href={item.linkUrl} target="_blank" rel="noopener noreferrer" className="world-link">Open original →</a>
      </div>
    </article>
  );
}
