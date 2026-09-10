import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { RouteRequestGate } from '../routeLoadState';

export default function DiscoverPage({ user }: { user?: any }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState('');
  const [pendingUserId, setPendingUserId] = useState<number | null>(null);
  const suggestionGate = useRef(new RouteRequestGate());
  const searchGate = useRef(new RouteRequestGate());
  const actionGate = useRef(new RouteRequestGate());
  const currentAccountId = useRef(user?.id);
  currentAccountId.current = user?.id;
  const currentQuery = useRef(query);
  currentQuery.current = query;

  const isVerified = !!user?.is_verified;

  // Load public members on mount so new users see people immediately — no search required.
  useEffect(() => {
    const requestedAccountId = user?.id;
    const isCurrent = suggestionGate.current.begin();
    setSuggestions([]);
    setResults([]);
    setSearched(false);
    setPendingUserId(null);
    setActionError('');
    api.get<{ users: any[] }>('/users?q=&limit=20')
      .then(response => {
        if (!isCurrent() || currentAccountId.current !== requestedAccountId) return;
        setSuggestions(
          (response.users || [])
            .filter((candidate: any) => candidate.profile_visibility === 'public' && candidate.id !== requestedAccountId)
            .slice(0, 12)
        );
      })
      .catch(() => {});
    return () => {
      suggestionGate.current.invalidate();
      searchGate.current.invalidate();
      actionGate.current.invalidate();
    };
  }, [user?.id]);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q.length < 2) return;
    const requestedAccountId = user?.id;
    const isCurrent = searchGate.current.begin();
    setLoading(true); setSearched(true);
    try {
      const response = await api.get<any>(`/users?q=${encodeURIComponent(q)}&limit=30`);
      if (!isCurrent() || currentAccountId.current !== requestedAccountId || currentQuery.current.trim() !== q) return;
      setResults(response.users || []);
    } catch (e) {
      if (isCurrent() && currentAccountId.current === requestedAccountId && currentQuery.current.trim() === q) setResults([]);
    } finally {
      if (isCurrent() && currentAccountId.current === requestedAccountId && currentQuery.current.trim() === q) setLoading(false);
    }
  }

  async function handleFollow(userId: number) {
    if (pendingUserId !== null) return;
    const requestedAccountId = user?.id;
    const isCurrent = actionGate.current.begin();
    setPendingUserId(userId);
    setActionError('');
    try {
      await api.follow(userId);
      if (!isCurrent() || currentAccountId.current !== requestedAccountId) return;
      const update = (arr: any[]) => arr.map(u => u.id === userId ? { ...u, isFollowing: true } : u);
      setResults(update);
      setSuggestions(update);
    } catch (e: any) {
      if (isCurrent() && currentAccountId.current === requestedAccountId) {
        console.error(e);
        setActionError(e.message || 'Could not follow user.');
      }
    } finally {
      if (isCurrent() && currentAccountId.current === requestedAccountId) setPendingUserId(null);
    }
  }

  async function handleUnfollow(userId: number) {
    if (pendingUserId !== null) return;
    const requestedAccountId = user?.id;
    const isCurrent = actionGate.current.begin();
    setPendingUserId(userId);
    setActionError('');
    try {
      await api.unfollow(userId);
      if (!isCurrent() || currentAccountId.current !== requestedAccountId) return;
      const update = (arr: any[]) => arr.map(u => u.id === userId ? { ...u, isFollowing: false } : u);
      setResults(update);
      setSuggestions(update);
    } catch (e: any) {
      if (isCurrent() && currentAccountId.current === requestedAccountId) {
        console.error(e);
        setActionError(e.message || 'Could not unfollow user.');
      }
    } finally {
      if (isCurrent() && currentAccountId.current === requestedAccountId) setPendingUserId(null);
    }
  }

  function renderCard(u: any) {
    return (
      <div key={u.id} className="discover-card">
        <div className="avatar-placeholder">{u.display_name?.[0] || '?'}</div>
        <div className="discover-info">
          <Link to={`/profile/${u.username}`} className="discover-name">
            <strong>{u.display_name}</strong>
            <span className="muted">@{u.username}</span>
          </Link>
          {u.bio && <p className="discover-bio">{u.bio.slice(0, 100)}</p>}
          {u.is_verified ? <span className="verified-badge">✅ Verified</span> : <span className="muted">⚠ Unverified</span>}
        </div>
        {isVerified && user && user.id !== u.id && (
          <button className={`btn ${u.isFollowing ? 'btn-ghost' : 'btn-primary'}`}
            onClick={() => u.isFollowing ? handleUnfollow(u.id) : handleFollow(u.id)}
            disabled={pendingUserId === u.id}>
            {u.isFollowing ? 'Following' : 'Follow'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="discover-page">
      <h2>🔍 Discover People</h2>
      {actionError && <p className="error-msg" role="alert">{actionError}</p>}
      <form className="discover-search" onSubmit={handleSearch}>
        <input className="input" placeholder="Search by name or username..." value={query}
          onChange={e => {
            setQuery(e.target.value);
            searchGate.current.invalidate();
            setResults([]);
            setSearched(false);
            setLoading(false);
          }} autoFocus />
        <button className="btn btn-primary" disabled={query.trim().length < 2 || loading}>Search</button>
      </form>

      {loading && <p className="muted">Searching...</p>}

      {searched && !loading && results.length === 0 && (
        <p className="muted" style={{ marginTop: 16 }}>No users found matching "{query}".</p>
      )}

      {searched && results.length > 0 && (
        <div className="discover-results">
          {results.map(u => renderCard(u))}
        </div>
      )}

      {!searched && suggestions.length > 0 && (
        <>
          <p className="muted" style={{ marginTop: 16 }}>
            People on RefugeCloud — follow to add them to your feed:
          </p>
          <div className="discover-results">
            {suggestions.map(u => renderCard(u))}
          </div>
        </>
      )}

      {!searched && suggestions.length === 0 && (
        <p className="muted" style={{ marginTop: 16 }}>Search for people by name or username.</p>
      )}
    </div>
  );
}
