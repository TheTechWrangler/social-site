import { useState, useEffect } from 'react';
import { api } from '../api/client';

export default function AdminPage() {
  const [users, setUsers] = useState<any[]>([]);
  const [posts, setPosts] = useState<any[]>([]);
  const [reports, setReports] = useState<any[]>([]);
  const [tab, setTab] = useState<'users' | 'posts' | 'reports' | 'rss'>('users');

  // RSS state
  const [rssSources, setRssSources] = useState<any[]>([]);
  const [rssName, setRssName] = useState('');
  const [rssUrl, setRssUrl] = useState('');
  const [rssHomepage, setRssHomepage] = useState('');
  const [rssCategory, setRssCategory] = useState('general');
  const [rssFetchResult, setRssFetchResult] = useState<any>(null);
  const [rssCatFilter, setRssCatFilter] = useState('');

  useEffect(() => { if (tab === 'rss') loadRss(); else loadData(); }, [tab]);

  async function loadData() {
    try {
      if (tab === 'users') { const r = await api.getUsers(); setUsers(r.users); }
      if (tab === 'posts') { const r = await api.getAdminPosts(); setPosts(r.posts); }
      if (tab === 'reports') { const r = await api.getReports(); setReports(r.reports); }
    } catch (e) { console.error(e); }
  }

  async function loadRss() {
    try {
      const r = await api.get<any>('/admin/rss/sources');
      setRssSources(r.sources);
    } catch (e) { console.error(e); }
  }

  async function addRssSource(e: React.FormEvent) {
    e.preventDefault();
    if (!rssName || !rssUrl) return;
    try {
      await api.post('/admin/rss/sources', { name: rssName, url: rssUrl, homepageUrl: rssHomepage, category: rssCategory });
      setRssName(''); setRssUrl(''); setRssHomepage(''); setRssCategory('general');
      loadRss();
    } catch (err) { console.error(err); }
  }

  async function toggleSource(id: number, active: boolean) {
    try {
      await api.post(`/admin/rss/sources`, {});
      // Use update
      const r = await fetch(`/api/admin/rss/sources/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify({ is_active: active ? 0 : 1 }),
      });
      if (r.ok) loadRss();
    } catch (e) { console.error(e); }
  }

  async function fetchSource(id: number) {
    try {
      const r = await api.post<any>(`/admin/rss/sources/${id}/fetch`);
      setRssFetchResult(r);
      loadRss();
    } catch (e) { console.error(e); }
  }

  async function fetchAll() {
    try {
      const r = await api.post<any>('/admin/rss/fetch-all');
      setRssFetchResult({ batch: r });
      loadRss();
    } catch (e) { console.error(e); }
  }

  async function toggleBan(id: number, banned: boolean) {
    try {
      await (banned ? api.unbanUser(id) : api.banUser(id));
      setUsers(prev => prev.map(u => u.id === id ? { ...u, banned: banned ? 0 : 1 } : u));
    } catch (e) { console.error(e); }
  }

  async function toggleHide(id: number, hidden: boolean) {
    try {
      await (hidden ? api.unhidePost(id) : api.hidePost(id));
      setPosts(prev => prev.map(p => p.id === id ? { ...p, hidden: hidden ? 0 : 1 } : p));
    } catch (e) { console.error(e); }
  }

  async function verifyUser(id: number) {
    try {
      await fetch(`/api/admin/users/${id}/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` } });
      setUsers(prev => prev.map(u => u.id === id ? { ...u, is_verified: 1 } : u));
    } catch (e) { console.error(e); }
  }

  async function unverifyUser(id: number) {
    try {
      await fetch(`/api/admin/users/${id}/unverify`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` } });
      setUsers(prev => prev.map(u => u.id === id ? { ...u, is_verified: 0 } : u));
    } catch (e) { console.error(e); }
  }

  return (
    <div className="admin-page">
      <h2>🛡 Admin Dashboard</h2>
      <div className="admin-tabs">
        <button className={`btn ${tab === 'users' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setTab('users'); setRssFetchResult(null); }}>Users</button>
        <button className={`btn ${tab === 'posts' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setTab('posts'); setRssFetchResult(null); }}>Posts</button>
        <button className={`btn ${tab === 'reports' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setTab('reports'); setRssFetchResult(null); }}>Reports</button>
        <button className={`btn ${tab === 'rss' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('rss')}>RSS Sources</button>
      </div>

      {/* Users tab */}
      {tab === 'users' && (
        <table className="admin-table">
          <thead><tr><th>ID</th><th>Username</th><th>Display</th><th>Email</th><th>Role</th><th>Verified</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>{users.map(u => (
            <tr key={u.id}><td>{u.id}</td><td>@{u.username}</td><td>{u.display_name}</td><td>{u.email}</td><td>{u.role}</td>
              <td>{u.is_verified ? '✅' : '⚠️'}</td>
              <td>{u.banned ? '🚫 Banned' : '✅ Active'}</td>
              <td>
                {u.role !== 'admin' && (u.is_verified ? (
                  <button className="btn btn-sm" onClick={() => unverifyUser(u.id)}>Unverify</button>
                ) : (
                  <button className="btn btn-sm" onClick={() => verifyUser(u.id)}>Verify</button>
                ))}
                <button className="btn btn-sm" onClick={() => toggleBan(u.id, !!u.banned)}>{u.banned ? 'Unban' : 'Ban'}</button>
              </td></tr>
          ))}</tbody>
        </table>
      )}

      {/* Posts tab */}
      {tab === 'posts' && (
        <table className="admin-table">
          <thead><tr><th>ID</th><th>User</th><th>Content</th><th>Hidden</th><th>Action</th></tr></thead>
          <tbody>{posts.map(p => (
            <tr key={p.id}><td>{p.id}</td><td>@{p.username}</td><td>{p.content?.slice(0, 80)}</td>
              <td>{p.hidden ? '🙈 Hidden' : '👁 Visible'}</td>
              <td><button className="btn btn-sm" onClick={() => toggleHide(p.id, !!p.hidden)}>{p.hidden ? 'Show' : 'Hide'}</button></td></tr>
          ))}</tbody>
        </table>
      )}

      {/* Reports tab */}
      {tab === 'reports' && (
        <table className="admin-table">
          <thead><tr><th>ID</th><th>Reporter</th><th>Post</th><th>Reason</th><th>Status</th></tr></thead>
          <tbody>{reports.map(r => (
            <tr key={r.id}><td>{r.id}</td><td>@{r.reporter_name}</td><td>{r.post_content?.slice(0, 60) || '—'}</td>
              <td>{r.reason}</td><td>{r.status}</td></tr>
          ))}</tbody>
        </table>
      )}

      {/* RSS Sources tab */}
      {tab === 'rss' && (
        <div className="rss-admin">
          <h3>Add RSS Source</h3>
          <form className="rss-add-form" onSubmit={addRssSource}>
            <input className="input" placeholder="Source Name" value={rssName} onChange={e => setRssName(e.target.value)} required />
            <input className="input" placeholder="RSS Feed URL" value={rssUrl} onChange={e => setRssUrl(e.target.value)} required />
            <input className="input" placeholder="Homepage URL (optional)" value={rssHomepage} onChange={e => setRssHomepage(e.target.value)} />
            <input className="input" placeholder="Category (e.g. tech, news)" value={rssCategory} onChange={e => setRssCategory(e.target.value)} />
            <button className="btn btn-primary">Add Source</button>
          </form>

          <div style={{ margin: '16px 0' }}>
            <button className="btn btn-primary" onClick={fetchAll}>Fetch All Active Sources</button>
          </div>

          {rssFetchResult && (
            <div className="rss-fetch-result" style={{ margin: '12px 0', padding: 12, background: 'var(--bg-card)', borderRadius: 'var(--radius-sm)' }}>
              <strong>Fetch result:</strong>
              {rssFetchResult.batch ? rssFetchResult.batch.map((r: any) => (
                <div key={r.sourceId}>{r.sourceName}: {r.itemsInserted} new, {r.duplicatesSkipped} dupes{ r.error ? ` (error: ${r.error})` : ''}</div>
              )) : (
                <div>{rssFetchResult.sourceName}: {rssFetchResult.itemsInserted} new, {rssFetchResult.duplicatesSkipped} dupes{ rssFetchResult.error ? ` (error: ${rssFetchResult.error})` : ''}</div>
              )}
            </div>
          )}

          <h3>Sources ({rssSources.length})</h3>
          {/* Category filter */}
          {(() => {
            const cats = [...new Set(rssSources.map(s => s.category))].sort();
            const allCounts: Record<string, number> = {};
            rssSources.forEach(s => { allCounts[s.category] = (allCounts[s.category] || 0) + 1; });
            return (
              <div className="filter-bar" style={{ marginBottom: 8 }}>
                <button className={`btn btn-sm ${!rssCatFilter ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setRssCatFilter('')}>All ({rssSources.length})</button>
                {cats.map(c => (
                  <button key={c} className={`btn btn-sm ${rssCatFilter === c ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setRssCatFilter(c)}>
                    {c} ({allCounts[c]})
                  </button>
                ))}
              </div>
            );
          })()}
          <table className="admin-table">
            <thead><tr><th>Name</th><th>URL</th><th>Category</th><th>Active</th><th>Last Fetched</th><th>Actions</th></tr></thead>
            <tbody>{rssSources.filter(s => !rssCatFilter || s.category === rssCatFilter).map(s => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong></td>
                <td className="muted" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.url}</td>
                <td>{s.category}</td>
                <td>{s.is_active ? '✅' : '❌'}</td>
                <td className="muted">{s.last_fetched_at || 'never'}</td>
                <td>
                  <button className="btn btn-sm" onClick={() => fetchSource(s.id)}>Fetch</button>
                  <button className="btn btn-sm" onClick={() => toggleSource(s.id, !!s.is_active)}>{s.is_active ? 'Deactivate' : 'Activate'}</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
