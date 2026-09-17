import { useActionDialog } from '../components/ActionDialog';
import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { RouteRequestGate } from '../routeLoadState';
import type { PublicExternalSourceDto } from '../../shared/externalContent';
import { ExternalVideoMedia } from '../components/WorldCard';
import { useMediaCapabilities } from '../hooks/useMediaCapabilities';

export default function WorldPage({ user }: { user?: any }) {
  const [items, setItems] = useState<any[]>([]);
  const [sources, setSources] = useState<PublicExternalSourceDto[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [feedLoaded, setFeedLoaded] = useState(false);
  const [sourcesError, setSourcesError] = useState('');
  const [blockedError, setBlockedError] = useState('');
  const [selectedSource, setSelectedSource] = useState('');
  const [selectedItemType, setSelectedItemType] = useState('');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [feedError, setFeedError] = useState('');
  const [blockedSources, setBlockedSources] = useState<any[]>([]);
  const [showBlockedPanel, setShowBlockedPanel] = useState(false);
  const [mutationError, setMutationError] = useState('');
  const [pendingMutation, setPendingMutation] = useState<string | null>(null);
  const [showSubmissionForm, setShowSubmissionForm] = useState(false);
  const [submissionForm, setSubmissionForm] = useState({ sourceKind: 'rss', locator: '', name: '', category: 'general', note: '' });
  const [submissions, setSubmissions] = useState<any[]>([]);
  const [submissionError, setSubmissionError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const PAGE_SIZE = 30;
  const feedGate = useRef(new RouteRequestGate());
  const sourceGate = useRef(new RouteRequestGate());
  const blockedGate = useRef(new RouteRequestGate());
  const mutationGate = useRef(new RouteRequestGate());
  const submissionLoadGate = useRef(new RouteRequestGate());
  const submissionMutationGate = useRef(new RouteRequestGate());
  const mutationLock = useRef<symbol | null>(null);
  const currentAccountId = useRef(user?.id ?? null);
  currentAccountId.current = user?.id ?? null;

  const [discussions, setDiscussions] = useState<Record<number, { open: boolean; comments: any[]; loading: boolean; body: string; nextCursor?: number | null }>>({});

  const { confirmAction, actionDialog } = useActionDialog(user?.id);
  const { capabilities, state: capabilityState, retry: retryCapabilities } = useMediaCapabilities();

  useEffect(() => {
    setItems([]);
    setBlockedSources([]);
    setSubmissions([]);
    setSubmissionError('');
    setShowSubmissionForm(false);
    setSubmitting(false);
    setSelectedCategory('');
    setSelectedSource('');
    setSelectedItemType('');
    setDiscussions({});
    setFeedLoaded(false);
    setPage(0);
    void loadSources();
    void loadFeed();
    if (user) void loadBlockedSources();
    if (user && (user.is_verified === 1 || user.isVerified === true)) void loadSubmissions();
    return () => {
      feedGate.current.invalidate();
      sourceGate.current.invalidate();
      blockedGate.current.invalidate();
      mutationGate.current.invalidate();
      submissionLoadGate.current.invalidate();
      submissionMutationGate.current.invalidate();
      mutationLock.current = null;
    };
  }, [user?.id, user?.is_verified, user?.isVerified]);

  const isLoggedIn = !!user;
  const isVerified = user?.is_verified === 1 || user?.isVerified === true;

  async function loadSources() {
    const requestedAccountId = user?.id ?? null;
    const isCurrent = sourceGate.current.begin();
    setSourcesError('');
    try {
      const r = await api.get<any>('/world-feed/sources');
      if (!isCurrent() || currentAccountId.current !== requestedAccountId) return;
      setSources(r.sources);
      setCategories(r.categories);
    } catch {
      if (isCurrent() && currentAccountId.current === requestedAccountId) {
        setSourcesError(sources.length
          ? 'Could not refresh the approved source catalog. Previously loaded source information may be stale.'
          : 'Approved source catalog is unavailable.');
      }
    }
  }

  async function loadFeed(cat?: string, srcId?: string, p = 0, itemType?: string) {
    const requestedAccountId = user?.id ?? null;
    const isCurrent = feedGate.current.begin();
    setLoading(true);
    setFeedError('');
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(p * PAGE_SIZE) });
      if (cat) params.set('category', cat);
      if (srcId) params.set('sourceId', srcId);
      if (itemType) params.set('itemType', itemType);
      const response = await api.get<any>(`/world-feed?${params}`);
      if (!isCurrent() || currentAccountId.current !== requestedAccountId) return;
      setPage(p);
      setHasMore(response.pagination?.hasMore ?? response.items.length === PAGE_SIZE);
      if (p === 0) setItems(response.items);
      else setItems(previous => [...previous, ...response.items.filter((item: any) => !previous.some(known => known.id === item.id))]);
      setFeedLoaded(true);
    } catch (e) { if (isCurrent()) setFeedError(feedLoaded ? 'Refresh failed. Previously loaded World items may be stale.' : 'Could not load World items. Please retry.'); }
    finally {
      if (isCurrent() && currentAccountId.current === requestedAccountId) setLoading(false);
    }
  }

  async function loadBlockedSources() {
    const requestedAccountId = user?.id ?? null;
    const isCurrent = blockedGate.current.begin();
    setBlockedError('');
    try {
      const response = await api.get<any>('/world-feed/blocked-sources');
      if (isCurrent() && currentAccountId.current === requestedAccountId) setBlockedSources(response.blocked);
    } catch (e) {
      if (isCurrent() && currentAccountId.current === requestedAccountId) setBlockedError('Source preferences are temporarily unavailable.');
    }
  }

  function handleFilter(cat: string, srcId = '', itemType = '') { setSelectedCategory(cat); setSelectedSource(srcId); setSelectedItemType(itemType); setPage(0); loadFeed(cat, srcId, 0, itemType || undefined); }
  function loadMore() { if (loading) return; const next = page + 1; loadFeed(selectedCategory, selectedSource, next, selectedItemType || undefined); }

  async function handleBlock(sourceId: number, sourceName: string) {
    return confirmAction({ title: "Block source", description: `Block "${sourceName}"? You will no longer see World Feed items or discussions from this source.` }, async () => {
    if (mutationLock.current) return;
    const mutationToken = Symbol('source-mutation');
    mutationLock.current = mutationToken;
    const requestedAccountId = user?.id ?? null;
    const isCurrent = mutationGate.current.begin();
    setPendingMutation(`block:${sourceId}`);
    setMutationError('');
    try {
      await api.post<any>(`/world-feed/sources/${sourceId}/block`);
      if (!isCurrent() || currentAccountId.current !== requestedAccountId) return;
      setItems(prev => prev.filter(i => i.sourceId !== sourceId));
      setSources(prev => prev.map(source => source.id === sourceId && source.viewer
        ? { ...source, viewer: { ...source.viewer, blocked: true } }
        : source));
      await loadBlockedSources();
      await loadFeed(selectedCategory, selectedSource, 0, selectedItemType || undefined);
    } catch (e: any) {
      if (isCurrent() && currentAccountId.current === requestedAccountId) setMutationError(e.message || 'Could not block source.');
     throw e; } finally {
      if (mutationLock.current === mutationToken) mutationLock.current = null;
      if (isCurrent() && currentAccountId.current === requestedAccountId) setPendingMutation(null);
    }
  });
  }

  async function handleUnblock(sourceId: number) {
    if (mutationLock.current) return;
    const mutationToken = Symbol('source-mutation');
    mutationLock.current = mutationToken;
    const requestedAccountId = user?.id ?? null;
    const isCurrent = mutationGate.current.begin();
    setPendingMutation(`unblock:${sourceId}`);
    setMutationError('');
    try {
      await api.delete(`/world-feed/sources/${sourceId}/block`);
      if (!isCurrent() || currentAccountId.current !== requestedAccountId) return;
      setBlockedSources(prev => prev.filter(s => s.id !== sourceId));
      setSources(prev => prev.map(source => source.id === sourceId && source.viewer
        ? { ...source, viewer: { ...source.viewer, blocked: false } }
        : source));
      await loadFeed(selectedCategory, selectedSource, 0, selectedItemType || undefined);
    } catch (e: any) {
      if (isCurrent() && currentAccountId.current === requestedAccountId) setMutationError(e.message || 'Could not unblock source.');
    } finally {
      if (mutationLock.current === mutationToken) mutationLock.current = null;
      if (isCurrent() && currentAccountId.current === requestedAccountId) setPendingMutation(null);
    }
  }

  async function handleSubscription(sourceId: number, subscribe: boolean) {
    if (mutationLock.current) return;
    const mutationToken = Symbol('source-mutation');
    mutationLock.current = mutationToken;
    const requestedAccountId = user?.id ?? null;
    const isCurrent = mutationGate.current.begin();
    setPendingMutation(`subscription:${sourceId}`);
    setMutationError('');
    try {
      const confirmed = subscribe
        ? await api.put<any>(`/world-feed/sources/${sourceId}/subscription`)
        : await api.delete<any>(`/world-feed/sources/${sourceId}/subscription`);
      if (!isCurrent() || currentAccountId.current !== requestedAccountId) return;
      setSources(previous => previous.map(source => source.id === sourceId && source.viewer
        ? { ...source, viewer: { subscribed: !!confirmed.subscribed, blocked: !!confirmed.blocked } }
        : source));
    } catch (e: any) {
      if (isCurrent() && currentAccountId.current === requestedAccountId) {
        setMutationError(e.message || 'Could not update this source subscription. The previous server-confirmed setting remains active.');
      }
    } finally {
      if (mutationLock.current === mutationToken) mutationLock.current = null;
      if (isCurrent() && currentAccountId.current === requestedAccountId) setPendingMutation(null);
    }
  }

  async function loadSubmissions() {
    const requestedAccountId = user?.id ?? null;
    const isCurrent = submissionLoadGate.current.begin();
    try {
      const response = await api.get<any>('/world-feed/source-submissions');
      if (isCurrent() && currentAccountId.current === requestedAccountId) setSubmissions(response.submissions || []);
    } catch {
      if (isCurrent() && currentAccountId.current === requestedAccountId) setSubmissionError('Could not load your feed suggestions.');
    }
  }

  async function submitFeedSuggestion(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const requestedAccountId = user?.id ?? null;
    const isCurrent = submissionMutationGate.current.begin();
    setSubmitting(true);
    setSubmissionError('');
    try {
      await api.post('/world-feed/source-submissions', submissionForm);
      if (!isCurrent() || currentAccountId.current !== requestedAccountId) return;
      setSubmissionForm({ sourceKind: 'rss', locator: '', name: '', category: 'general', note: '' });
      setShowSubmissionForm(false);
      await loadSubmissions();
    } catch (error: any) {
      if (isCurrent() && currentAccountId.current === requestedAccountId) setSubmissionError(error.message || 'Could not submit this feed suggestion.');
    } finally {
      if (isCurrent() && currentAccountId.current === requestedAccountId) setSubmitting(false);
    }
  }

  async function toggleDiscussion(itemId: number) {
    const d = discussions[itemId];
    if (d?.open) { setDiscussions(prev => ({ ...prev, [itemId]: { ...prev[itemId], open: false } })); return; }
    await loadDiscussion(itemId);
  }

  async function loadDiscussion(itemId: number, after?: number) {
    const account = currentAccountId.current;
    setDiscussions(prev => ({ ...prev, [itemId]: { ...prev[itemId], open: true, comments: prev[itemId]?.comments || [], loading: true, body: prev[itemId]?.body || '' } }));
    try {
      const r = await api.get<any>(`/world-feed/${itemId}/comments${after ? '?after=' + after : ''}`);
      if (currentAccountId.current !== account) return;
      setDiscussions(prev => ({ ...prev, [itemId]: { ...prev[itemId],
        comments: after ? [...prev[itemId].comments, ...r.comments.filter((c: any) => !prev[itemId].comments.some(known => known.id === c.id))] : r.comments,
        nextCursor: r.nextCursor ?? null, loading: false } }));
    } catch {
      if (currentAccountId.current !== account) return;
      setMutationError('Could not load discussion. Please retry.');
      setDiscussions(prev => ({ ...prev, [itemId]: { ...prev[itemId], loading: false } }));
    }
  }

  async function addComment(itemId: number) {
    const d = discussions[itemId]; if (!d?.body?.trim()) return;
    if (pendingMutation) return;
    setPendingMutation(`comment:${itemId}`);
    setMutationError('');
    try {
      const r = await api.post<any>(`/world-feed/${itemId}/comments`, { body: d.body });
      setDiscussions(prev => ({ ...prev, [itemId]: { ...prev[itemId], comments: [...prev[itemId].comments, r.comment], body: '' } }));
    } catch (e: any) {
      setMutationError(e.message || 'Could not add comment.');
    } finally {
      setPendingMutation(null);
    }
  }

  async function deleteComment(itemId: number, commentId: number) {
    if (pendingMutation) return;
    setPendingMutation(`delete-comment:${commentId}`);
    setMutationError('');
    try {
      await api.delete(`/world-feed/comments/${commentId}`);
      setDiscussions(prev => ({ ...prev, [itemId]: { ...prev[itemId], comments: prev[itemId].comments.filter((c: any) => c.id !== commentId) } }));
    } catch (e: any) {
      setMutationError(e.message || 'Could not delete comment.');
    } finally {
      setPendingMutation(null);
    }
  }

  return (
    <div className="world-page">
      {actionDialog}
      <h2>🌍 World Feed</h2>
      <p className="muted">Articles, podcasts, and videos from approved external sources. Sorted by published date, newest first.</p>
      {capabilityState === 'error' && <p className="error-msg" role="alert">Embedded playback availability could not be confirmed. Videos remain available as safe external links. <button className="btn btn-sm" onClick={() => void retryCapabilities()}>Retry capability check</button></p>}
      {feedError && <p className="error-msg" role="alert">{feedError} <button className="btn btn-sm" onClick={() => void loadFeed(selectedCategory, selectedSource, 0, selectedItemType || undefined)}>Retry</button></p>}
      {sourcesError && <p className="error-msg" role="alert">{sourcesError} <button className="btn btn-sm" onClick={() => void loadSources()}>Retry filters</button></p>}
      {blockedError && isLoggedIn && <p className="error-msg" role="alert">{blockedError} <button className="btn btn-sm" onClick={() => void loadBlockedSources()}>Retry preferences</button></p>}
      {mutationError && <p className="error-msg" role="alert">{mutationError}</p>}

      {isLoggedIn && sources.length > 0 && (
        <section aria-labelledby="approved-sources-heading" className="blocked-sources-panel">
          <h3 id="approved-sources-heading">Approved external sources</h3>
          <p className="muted">Choose which approved sources appear in your personal Home feed. Blocking remains a separate preference.</p>
          <div className="blocked-sources-list">
            {sources.map(source => {
              const subscribed = !!source.viewer?.subscribed;
              const unavailable = source.availability !== 'active';
              const pending = pendingMutation === `subscription:${source.id}`;
              return <div key={source.id} className="blocked-source-row">
                <span>
                  {source.homepageUrl ? <a href={source.homepageUrl} target="_blank" rel="noopener noreferrer">{source.name}</a> : source.name}
                  {' '}<span className="muted">({source.category})</span>
                  {source.viewer?.blocked && <span className="muted"> — blocked</span>}
                  {source.availability === 'disabled' && <span className="muted"> — temporarily disabled</span>}
                  {source.availability === 'removed' && <span className="muted"> — no longer available</span>}
                </span>
                {subscribed ? (
                  <button className="btn btn-sm btn-ghost" onClick={() => void handleSubscription(source.id, false)} disabled={pending}>
                    {pending ? 'Saving…' : 'Unsubscribe'}
                  </button>
                ) : (
                  <button className="btn btn-sm" onClick={() => void handleSubscription(source.id, true)}
                    disabled={pending || unavailable || !!source.viewer?.blocked}>
                    {pending ? 'Saving…' : 'Subscribe'}
                  </button>
                )}
              </div>;
            })}
          </div>
        </section>
      )}

      {isVerified && (
        <section className="blocked-sources-panel" aria-labelledby="submit-feed-heading">
          <h3 id="submit-feed-heading">Submit a feed</h3>
          <p className="muted">Suggest an RSS/Atom feed or YouTube channel for admin review. Submitting only records your suggestion; RefugeCloud does not fetch it until an admin reviews it.</p>
          <button className="btn btn-sm" type="button" onClick={() => setShowSubmissionForm(value => !value)}>
            {showSubmissionForm ? 'Cancel' : 'Submit a feed'}
          </button>
          {showSubmissionForm && <form className="rss-add-form" onSubmit={submitFeedSuggestion}>
            <select className="input" value={submissionForm.sourceKind} onChange={event => setSubmissionForm({ ...submissionForm, sourceKind: event.target.value })}>
              <option value="rss">RSS / website feed</option>
              <option value="youtube_channel">YouTube channel</option>
            </select>
            <input className="input" required maxLength={2048} placeholder={submissionForm.sourceKind === 'youtube_channel' ? 'Channel ID or youtube.com/channel URL' : 'Feed URL'} value={submissionForm.locator} onChange={event => setSubmissionForm({ ...submissionForm, locator: event.target.value })} />
            <input className="input" maxLength={120} placeholder="Suggested display name (optional)" value={submissionForm.name} onChange={event => setSubmissionForm({ ...submissionForm, name: event.target.value })} />
            <input className="input" maxLength={80} placeholder="Category (optional)" value={submissionForm.category} onChange={event => setSubmissionForm({ ...submissionForm, category: event.target.value })} />
            <textarea className="input" maxLength={500} placeholder="Short note (optional)" value={submissionForm.note} onChange={event => setSubmissionForm({ ...submissionForm, note: event.target.value })} />
            <button className="btn btn-primary" disabled={submitting}>{submitting ? 'Submitting...' : 'Submit for review'}</button>
          </form>}
          {submissionError && <p className="error-msg" role="alert">{submissionError} <button className="btn btn-sm" type="button" onClick={() => void loadSubmissions()}>Retry</button></p>}
          {submissions.length > 0 && <ul>{submissions.map(submission => <li key={submission.id}>
            {submission.name || (submission.sourceKind === 'youtube_channel' ? 'YouTube channel' : 'RSS feed')} - {submission.status}
          </li>)}</ul>}
        </section>
      )}

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
                  <button className="btn btn-sm btn-ghost" onClick={() => handleUnblock(s.id)} disabled={pendingMutation === `unblock:${s.id}`}>Unblock</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {categories.length > 0 && (
        <div className="filter-bar">
          <button className={`btn ${!selectedCategory && !selectedSource && !selectedItemType ? 'btn-primary' : 'btn-ghost'}`} onClick={() => handleFilter('', '')}>All</button>
          <button className={`btn ${selectedItemType === 'podcast' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => handleFilter('', '', 'podcast')}>🎙 Podcasts</button>
          <button className={`btn ${selectedItemType === 'video' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => handleFilter('', '', 'video')}>Videos</button>
          {categories.map(c => (
            <button key={c} className={`btn ${selectedCategory === c ? 'btn-primary' : 'btn-ghost'}`} onClick={() => handleFilter(c)}>{c}</button>
          ))}
        </div>
      )}

      {loading && feedLoaded && <p className="muted" role="status">Refreshing World items…</p>}
      {loading && !feedLoaded ? <p className="muted">Loading...</p> : !feedLoaded ? null : items.length === 0 ? (
        <div className="empty-state"><p>No external items are available yet.</p><p className="muted">Approved sources may not have published or refreshed any items yet.</p></div>
      ) : (
        <div className="world-feed-list">
          {items.map(item => {
            const disc = discussions[item.id] || { open: false, comments: [], loading: false, body: '' };
            return (
              <article key={item.id} className="world-card">
                <div className="world-card-source">
                  <span className="world-source-badge">🌐 {item.sourceName}</span>
                  {item.itemType === 'podcast' && <span className="world-source-badge" style={{ background: 'rgba(139,92,246,0.15)', color: 'var(--purple-soft)', border: '1px solid rgba(139,92,246,0.25)' }}>🎙 Podcast</span>}
                  {item.itemType === 'video' && <span className="world-source-badge">Video</span>}
                  {item.sourceCategory && <span className="world-category">{item.sourceCategory}</span>}
                  {item.author && <span className="world-author">by {item.author}</span>}
                </div>
                <h3 className="world-card-title"><a href={item.linkUrl} target="_blank" rel="noopener noreferrer">{item.title}</a></h3>
                {item.summary && <p className="world-card-summary">{item.summary.slice(0, 280)}{item.summary.length > 280 ? '...' : ''}</p>}
                {item.enclosureUrl && item.enclosureType?.startsWith('audio/') && (
                  <audio controls className="world-audio-player" preload="none">
                    <source src={item.enclosureUrl} type={item.enclosureType} />
                  </audio>
                )}
                {item.episodeImageUrl && <img src={item.episodeImageUrl} alt="" className="world-episode-img" loading="lazy" />}
                <ExternalVideoMedia item={item} capabilities={capabilities} capabilityState={capabilityState} />
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
                              <button className="btn-link" onClick={() => deleteComment(item.id, c.id)} disabled={pendingMutation === `delete-comment:${c.id}`} style={{ marginLeft: 'auto', fontSize: '0.75rem' }}>delete</button>
                            )}
                          </div>
                          <p className="world-comment-body">{c.body}</p>
                        </div>
                      ))
                    )}
                    {disc.nextCursor && <button className="btn btn-ghost" disabled={disc.loading} onClick={() => void loadDiscussion(item.id, disc.nextCursor!)}>Load more comments</button>}
                    {isLoggedIn ? (
                      <form className="world-comment-form" onSubmit={e => { e.preventDefault(); addComment(item.id); }}>
                        <input className="input" placeholder="Add a comment..." value={disc.body} onChange={e => setDiscussions(prev => ({ ...prev, [item.id]: { ...prev[item.id], body: e.target.value } }))} />
                        <button className="btn btn-sm btn-primary" disabled={!disc.body?.trim() || pendingMutation === `comment:${item.id}`}>Post</button>
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
          {hasMore && (
            <button className="btn btn-ghost" onClick={loadMore} disabled={loading} style={{ display: 'block', margin: '16px auto' }}>Load more</button>
          )}
        </div>
      )}
    </div>
  );
}
