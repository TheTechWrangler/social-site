import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

export default function WorldPage() {
  const [items, setItems] = useState<any[]>([]);
  const [sources, setSources] = useState<any[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedSource, setSelectedSource] = useState('');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [blockedSources, setBlockedSources] = useState<any[]>([]);
  const [showBlockedPanel, setShowBlockedPanel] = useState(false);
  const PAGE_SIZE = 30;

  const [discussions, setDiscussions] = useState<Record<number, { open: boolean; comments: any[]; loading: boolean; body: string }>>({});

  useEffect(() => { loadSources(); loadFeed(); loadBlockedSources(); }, []);

  const user = JSON.parse(localStorage.getItem('user') || 'null');
  const isLoggedIn = !!localStorage.getItem('token');

  async function loadSources() {
    try { const r = await api.get<any>('/world-feed/sources'); setSources(r.sources); setCategories(r.categories); } catch (e) {}
  }

  async function loadFeed(cat?: string, srcId?: string, p = 0) {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(p * PAGE_SIZE) });
      if (cat) params.set('category', cat);
      if (srcId) params.set('sourceId', srcId);
      const r = await api.get<any>(`/world-feed?${params}`);
      if (p === 0) setItems(r.items); else setItems(prev => [...prev, ...r.items]);
    } catch (e) {}
    setLoading(false);
  }

  async function loadBlockedSources() {
    try { const r = await api.get<any>('/world-feed/blocked-sources'); setBlockedSources(r.blocked); } catch (e) {}
  }

  function handleFilter(cat: string, srcId = '') { setSelectedCategory(cat); setSelectedSource(srcId); setPage(0); loadFeed(cat, srcId, 0); }
  function loadMore() { const next = page + 1; setPage(next); loadFeed(selectedCategory, selectedSource, next); }

  async function handleBlock(sourceId: number, sourceName: string) {
    if (!confirm(`Block "${sourceName}"? You will no longer see World Feed items or discussions from this source.`)) return;
    try { await api.post<any>(`/world-feed/sources/${sourceId}/block`); setItems(prev => prev.filter(i => i.sourceId !== sourceId)); loadBlockedSources(); } catch (e) {}
  }

  async function handleUnblock(sourceId: number) {
    try {
      await fetch(`/api/world-feed/sources/${sourceId}/block`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` } });
      setBlockedSources(prev => prev.filter(s => s.id !== sourceId));
      loadFeed(selectedCategory, selectedSource, 0);
    } catch (e) {}
  }

  async function toggleDiscussion(itemId: number) {
    const d = discussions[itemId];
    if (d?.open) { setDiscussions(prev => ({ ...prev, [itemId]: { ...prev[itemId], open: false } })); return; }
    setDiscussions(prev => ({ ...prev, [itemId]: { open: true, comments: prev[itemId]?.comments || [], loading: true, body: prev[itemId]?.body || '' } }));
    try { const r = await api.get<any>(`/world-feed/${itemId}/comments`); setDiscussions(prev => ({ ...prev, [itemId]: { ...prev[itemId], comments: r.comments, loading: false } })); } catch (e) { setDiscussions(prev => ({ ...prev, [itemId]: { ...prev[itemId], loading: false } })); }
  }

  async function addComment(itemId: number) {
    const d = discussions[itemId]; if (!d?.body?.trim()) return;
    try { const r = await api.post<any>(`/world-feed/${itemId}/comments`, { body: d.body }); setDiscussions(prev => ({ ...prev, [itemId]: { ...prev[itemId], comments: [...prev[itemId].comments, r.comment], body: '' } })); } catch (e) {}
  }

  async function deleteComment(itemId: number, commentId: number) {
    try {
      await fetch(`/api/world-feed/comments/${commentId}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` } });
      setDiscussions(prev => ({ ...prev, [itemId]: { ...prev[itemId], comments: prev[itemId].comments.filter((c: any) => c.id !== commentId) } }));
    } catch (e) {}
  }

  const filteredCategories = categories.filter(c => c.toLowerCase().includes('gaming'));

  return (
    <div className="world-page">
      <h2>🌍 World Feed</h2>
      <p className="muted">External content from RSS sources. Sorted by published date, newest first.</p>

      {blockedSources.length > 0 && (
        <div className="blocked-sources-panel">
          <button className="btn btn-sm btn-ghost" onClick={() => setShowBlockedPanel(!showBlockedPanel)}>
            🚫 {blockedSources.length} blocked source{blockedSources.length > 1 ? 's' : ''}
          </button>
          {showBlockedPanel && (
            <div className="blocked-sources-list">
              {blockedSources.map((s: any) => (
                <div key={s.id} className="blocked-source-row">
                  <span>{s.name} <span className="muted">({s.category})</span></span>
                  <button className="btn btn-sm btn-ghost" onClick={() => handleUnblock(s.id)}>Unblock</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {categories.length > 0 && (
        <div className="filter-bar">
          <button className={`btn ${!selectedCategory && !selectedSource ? 'btn-primary' : 'btn-ghost'}`} onClick={() => handleFilter('', '')}>All</button>
          {categories.map(c => (
            <button key={c} className={`btn ${selectedCategory === c ? 'btn-primary' : 'btn-ghost'}`} onClick={() => handleFilter(c)}>{c}</button>
          ))}
        </div>
      )}

      {loading && items.length === 0 ? <p className="muted">Loading...</p> : items.length === 0 ? (
        <div className="empty-state"><p>No world feed items yet.</p><p className="muted">Admins can add RSS sources in the Admin panel.</p></div>
      ) : (
        <div className="world-feed-list">
          {items.map(item => {
            const disc = discussions[item.id] || { open: false, comments: [], loading: false, body: '' };
            return (
              <article key={item.id} className="world-card">
                <div className="world-card-source">
                  <span className="world-source-badge">🌐 {item.sourceName}</span>
                  {item.sourceCategory && <span className="world-category">{item.sourceCategory}</span>}
                  {item.author && <span className="world-author">by {item.author}</span>}
                </div>
                <h3 className="world-card-title"><a href={item.linkUrl} target="_blank" rel="noopener noreferrer">{item.title}</a></h3>
                {item.summary && <p className="world-card-summary">{item.summary.slice(0, 280)}{item.summary.length > 280 ? '...' : ''}</p>}
                <div className="world-card-footer">
                  <div className="world-card-actions">
                    <time>{new Date(item.publishedAt).toLocaleDateString()}</time>
                    <button className="action-btn" onClick={() => toggleDiscussion(item.id)}>💬 {disc.comments.length || 'Discuss'}</button>
                  </div>
                  <a href={item.linkUrl} target="_blank" rel="noopener noreferrer" className="world-link">Open original →</a>
                  {isLoggedIn && user && <button className="btn-link" onClick={() => handleBlock(item.sourceId, item.sourceName)} style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>🚫 Block source</button>}
                </div>

                {disc.open && (
                  <div className="world-discussion">
                    <div className="world-discussion-label">Local discussion about this external item</div>
                    {disc.loading ? <p className="muted">Loading comments...</p> : disc.comments.length === 0 ? <p className="muted">No comments yet.</p> : (
                      disc.comments.map((c: any) => (
                        <div key={c.id} className="world-comment">
                          <div className="world-comment-header">
                            <strong>{c.displayName}</strong> <span className="muted">@{c.username}</span>
                            <span className="world-comment-time">{new Date(c.createdAt + 'Z').toLocaleString()}</span>
                            {isLoggedIn && user && (user.id === c.userId || user.role === 'admin') && (
                              <button className="btn-link" onClick={() => deleteComment(item.id, c.id)} style={{ marginLeft: 'auto', fontSize: '0.75rem' }}>delete</button>
                            )}
                          </div>
                          <p className="world-comment-body">{c.body}</p>
                        </div>
                      ))
                    )}
                    {isLoggedIn ? (
                      <form className="world-comment-form" onSubmit={e => { e.preventDefault(); addComment(item.id); }}>
                        <input className="input" placeholder="Add a comment..." value={disc.body} onChange={e => setDiscussions(prev => ({ ...prev, [item.id]: { ...prev[item.id], body: e.target.value } }))} />
                        <button className="btn btn-sm btn-primary" disabled={!disc.body?.trim()}>Post</button>
                      </form>
                    ) : (
                      <p className="muted" style={{ marginTop: 10, fontSize: '0.85rem' }}>
                        <Link to="/login">Log in</Link> to join the discussion or customize your sources.
                      </p>
                    )}
                  </div>
                )}
              </article>
            );
          })}
          {items.length >= PAGE_SIZE && (
            <button className="btn btn-ghost" onClick={loadMore} style={{ display: 'block', margin: '16px auto' }}>Load more</button>
          )}
        </div>
      )}
    </div>
  );
}
