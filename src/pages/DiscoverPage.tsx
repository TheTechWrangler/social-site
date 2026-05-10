import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

export default function DiscoverPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);

  const user = JSON.parse(localStorage.getItem('user') || 'null');
  const isVerified = !!user?.is_verified;

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q.length < 2) return;
    setLoading(true); setSearched(true);
    try {
      const r = await api.get<any>(`/users?q=${encodeURIComponent(q)}&limit=30`);
      setResults(r.users || []);
    } catch (e) { setResults([]); }
    setLoading(false);
  }

  async function handleFollow(userId: number) {
    try {
      const r = await api.follow(userId);
      setResults(prev => prev.map(u => u.id === userId ? { ...u, isFollowing: true } : u));
    } catch (e: any) {
      if (e.message?.includes('verification')) alert('Account verification required before you can follow.');
      else console.error(e);
    }
  }

  async function handleUnfollow(userId: number) {
    try {
      await api.unfollow(userId);
      setResults(prev => prev.map(u => u.id === userId ? { ...u, isFollowing: false } : u));
    } catch (e) { console.error(e); }
  }

  return (
    <div className="discover-page">
      <h2>🔍 Discover People</h2>
      <form className="discover-search" onSubmit={handleSearch}>
        <input className="input" placeholder="Search by name or username..." value={query}
          onChange={e => setQuery(e.target.value)} autoFocus />
        <button className="btn btn-primary" disabled={query.trim().length < 2 || loading}>Search</button>
      </form>

      {!searched && <p className="muted" style={{ marginTop: 16 }}>Search for people by name or username.</p>}

      {loading && <p className="muted">Searching...</p>}

      {searched && !loading && results.length === 0 && (
        <p className="muted" style={{ marginTop: 16 }}>No users found matching "{query}".</p>
      )}

      {results.length > 0 && (
        <div className="discover-results">
          {results.map((u: any) => (
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
                  onClick={() => u.isFollowing ? handleUnfollow(u.id) : handleFollow(u.id)}>
                  {u.isFollowing ? 'Following' : 'Follow'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
