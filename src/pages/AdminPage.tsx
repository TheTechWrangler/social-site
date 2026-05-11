import { useState, useEffect } from 'react';
import { api } from '../api/client';

type ReportFilter = 'open' | 'approved' | 'deleted' | 'all';
const REPORT_FILTERS: ReportFilter[] = ['open', 'approved', 'deleted', 'all'];
const REPORT_STATUS_LABELS: Record<string, string> = { open: 'Open', dismissed: 'Approved', resolved: 'Deleted' };

export default function AdminPage() {
  const [users, setUsers] = useState<any[]>([]);
  const [posts, setPosts] = useState<any[]>([]);
  const [reports, setReports] = useState<any[]>([]);
  const [tab, setTab] = useState<'users' | 'posts' | 'reports' | 'rss' | 'servers'>('users');

  // RSS state
  const [rssSources, setRssSources] = useState<any[]>([]);
  const [rssName, setRssName] = useState('');
  const [rssUrl, setRssUrl] = useState('');
  const [rssHomepage, setRssHomepage] = useState('');
  const [rssCategory, setRssCategory] = useState('general');
  const [rssFetchResult, setRssFetchResult] = useState<any>(null);
  const [rssCatFilter, setRssCatFilter] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [userRoleFilter, setUserRoleFilter] = useState('');
  const [roleMsg, setRoleMsg] = useState('');
  const [adminStats, setAdminStats] = useState<any>({});
  const [reportFilter, setReportFilter] = useState<ReportFilter>('open');
  const [reportActionError, setReportActionError] = useState('');
  const [reportNotes, setReportNotes] = useState<Record<number, string>>({});
  const [serverList, setServerList] = useState<any[]>([]);
  const [srvForm, setSrvForm] = useState({ gameId: '', name: '', connection_host: '', connection_port: '', platform: '', status: 'online', max_players: '', description: '', join_instructions: '' });

  useEffect(() => { if (tab === 'rss') loadRss(); else if (tab === 'servers') loadServers(); else loadData(); loadStats(); }, [tab, reportFilter]);

  async function loadStats() { try { const r = await api.get<any>('/admin/stats'); setAdminStats(r); } catch (e) {} }

  async function loadData() {
    try {
      if (tab === 'users') { const r = await api.getUsers(); setUsers(r.users); }
      if (tab === 'posts') { const r = await api.getAdminPosts(); setPosts(r.posts); }
      if (tab === 'reports') { await loadReports(reportFilter); }
    } catch (e) { console.error(e); }
  }

  async function loadReports(filter: ReportFilter = reportFilter) {
    const apiFilter = filter === 'approved' ? 'dismissed' : filter === 'deleted' ? 'resolved' : filter;
    const qs = apiFilter === 'all' ? '' : `?status=${apiFilter}`;
    const r = await api.get<any>(`/admin/reports${qs}`);
    setReports(r.reports);
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

  async function loadServers() {
    try {
      const r = await api.get<any>('/admin/game-servers');
      setServerList(r.servers);
    } catch (e) { console.error(e); }
  }

  async function addServer(e: React.FormEvent) {
    e.preventDefault();
    if (!srvForm.gameId || !srvForm.name) return;
    try {
      await fetch('/api/admin/game-servers', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(srvForm) });
      setSrvForm({ gameId: '', name: '', connection_host: '', connection_port: '', platform: '', status: 'online', max_players: '', description: '', join_instructions: '' });
      loadServers();
    } catch (e) { console.error(e); }
  }

  async function toggleServerActive(id: number, active: boolean) {
    await fetch(`/api/admin/game-servers/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ is_active: active ? 0 : 1 }) });
    loadServers();
  }

  async function deleteServer(id: number) {
    if (!confirm('Delete this server?')) return;
    await fetch(`/api/admin/game-servers/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } });
    loadServers();
  }

  async function updateReportStatus(id: number, status: 'dismissed' | 'resolved', adminNote: string) {
    const res = await fetch(`/api/admin/reports/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
      body: JSON.stringify({ status, adminNote }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Could not update report.');
    }
  }

  async function reviewReport(report: any, status: 'dismissed' | 'resolved') {
    setReportActionError('');
    try {
      await updateReportStatus(report.id, status, reportNotes[report.id] || '');
      await loadReports(reportFilter);
      loadStats();
    } catch (e: any) { console.error(e); setReportActionError(e.message || 'Could not update report.'); }
  }

  async function changeRole(id: number, role: string) {
    setRoleMsg('');
    try {
      const r = await fetch(`/api/admin/users/${id}/role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify({ role }),
      });
      const data = await r.json();
      if (!r.ok) { setRoleMsg(data.error || 'Failed'); return; }
      setUsers(prev => prev.map(u => u.id === id ? { ...u, role: data.role } : u));
      setRoleMsg(`Role updated to ${role}`);
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
      <div className="admin-stats">
        <div className="admin-stat-card"><span className="admin-stat-num">{adminStats.totalUsers || 0}</span><span>Users</span></div>
        <div className="admin-stat-card warn"><span className="admin-stat-num">{adminStats.unverifiedUsers || 0}</span><span>Unverified</span></div>
        <div className="admin-stat-card danger"><span className="admin-stat-num">{adminStats.bannedUsers || 0}</span><span>Banned</span></div>
        <div className="admin-stat-card alert"><span className="admin-stat-num">{adminStats.openReports || 0}</span><span>Open Reports</span></div>
        <div className="admin-stat-card"><span className="admin-stat-num">{adminStats.activeRssSources || 0}</span><span>RSS Sources</span></div>
        <div className="admin-stat-card"><span className="admin-stat-num">{adminStats.gameCount || 0}</span><span>Games</span></div>
      </div>
      <div className="admin-tabs">
        <button className={`btn ${tab === 'users' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setTab('users'); setRssFetchResult(null); }}>Users</button>
        <button className={`btn ${tab === 'posts' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setTab('posts'); setRssFetchResult(null); }}>Posts</button>
        <button className={`btn ${tab === 'reports' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setTab('reports'); setRssFetchResult(null); }}>Reports</button>
        <button className={`btn ${tab === 'rss' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('rss')}>RSS Sources</button>
        <button className={`btn ${tab === 'servers' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setTab('servers'); loadServers(); }}>Game Servers</button>
      </div>

      {/* Users tab */}
      {tab === 'users' && (
        <div>
          <div className="admin-user-filters" style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            <input className="input" placeholder="Search users..." value={userSearch}
              onChange={e => setUserSearch(e.target.value)} style={{ maxWidth: 220 }} />
            <select className="input" value={userRoleFilter} onChange={e => setUserRoleFilter(e.target.value)} style={{ width: 'auto' }}>
              <option value="">All roles</option>
              <option value="admin">Admin</option>
              <option value="mod">Mod</option>
              <option value="user">User</option>
            </select>
          </div>
          {roleMsg && <p className="muted" style={{ marginBottom: 8, color: 'var(--green)' }}>{roleMsg}</p>}
          <div className="admin-users-list">
            {users
              .filter(u => {
                if (userSearch) {
                  const q = userSearch.toLowerCase();
                  if (!u.username?.toLowerCase().includes(q) && !u.display_name?.toLowerCase().includes(q) && !u.email?.toLowerCase().includes(q)) return false;
                }
                if (userRoleFilter && u.role !== userRoleFilter) return false;
                return true;
              })
              .map(u => (
                <div key={u.id} className="admin-user-card">
                  <div className="admin-user-info">
                    <div className="avatar-placeholder" style={{ width: 36, height: 36, fontSize: '1rem' }}>{u.display_name?.[0] || '?'}</div>
                    <div>
                      <strong>{u.display_name}</strong> <span className="muted">@{u.username}</span>
                      <div className="muted" style={{ fontSize: '0.8rem' }}>{u.email}</div>
                    </div>
                  </div>
                  <div className="admin-user-badges">
                    <span className={`admin-badge badge-${u.role}`}>{u.role}</span>
                    <span className={`admin-badge ${u.is_verified ? 'badge-verified' : 'badge-unverified'}`}>{u.is_verified ? '✅ Verified' : '⚠ Unverified'}</span>
                    <span className={`admin-badge ${u.banned ? 'badge-banned' : 'badge-active'}`}>{u.banned ? '🚫 Banned' : 'Active'}</span>
                    <span className="admin-badge badge-vis">{u.profile_visibility || 'public'}</span>
                  </div>
                  <div className="admin-user-actions">
                    <select className="input" value={u.role} onChange={e => changeRole(u.id, e.target.value)}
                      style={{ width: 90, padding: '4px 8px', fontSize: '0.8rem' }} disabled={u.id === 1}>
                      <option value="user">User</option>
                      <option value="mod">Mod</option>
                      <option value="admin">Admin</option>
                    </select>
                    {u.role !== 'admin' && (u.is_verified ? (
                      <button className="btn btn-sm" onClick={() => unverifyUser(u.id)}>Unverify</button>
                    ) : (
                      <button className="btn btn-sm" onClick={() => verifyUser(u.id)}>Verify</button>
                    ))}
                    <button className="btn btn-sm" onClick={() => toggleBan(u.id, !!u.banned)}>{u.banned ? 'Unban' : 'Ban'}</button>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Posts tab */}
      {tab === 'posts' && (
        <div className="admin-table-wrap"><table className="admin-table">
          <thead><tr><th>ID</th><th>User</th><th>Content</th><th>Hidden</th><th>Action</th></tr></thead>
          <tbody>{posts.map(p => (
            <tr key={p.id}><td>{p.id}</td><td>@{p.username}</td><td>{p.content?.slice(0, 80)}</td>
              <td>{p.hidden ? '🙈 Hidden' : '👁 Visible'}</td>
              <td><button className="btn btn-sm" onClick={() => toggleHide(p.id, !!p.hidden)}>{p.hidden ? 'Show' : 'Hide'}</button></td></tr>
          ))}</tbody>
        </table></div>
      )}

      {/* Reports tab */}
      {tab === 'reports' && (
        <div>
          <div className="report-filters">
            {REPORT_FILTERS.map(s => (
              <button key={s} className={`btn btn-sm ${reportFilter === s ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setReportFilter(s)}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
          {reportActionError && <p className="error-msg">{reportActionError}</p>}
          {reports.length === 0 ? <p className="muted">No {reportFilter} reports.</p> : (
            reports.map(r => (
              <div key={r.id} className="report-card">
                <div className="report-card-header">
                  <strong className="report-title">Report #{r.id}</strong>
                  <span className={`admin-badge ${r.status === 'open' ? 'badge-unverified' : r.status === 'resolved' ? 'badge-banned' : 'badge-verified'}`}>Status: {REPORT_STATUS_LABELS[r.status] || 'Open'}</span>
                </div>

                <div className="report-meta-grid">
                  <div><strong>Type:</strong> {r.post_parent_id ? 'Comment' : 'Post'}</div>
                  <div><strong>Reporter:</strong> @{r.reporter_name}</div>
                  <div><strong>Reported author:</strong> {r.post_author_name ? `@${r.post_author_name}` : 'Unknown'}</div>
                  <div><strong>Reason:</strong> {r.reason || 'Unknown'}</div>
                  <div><strong>Created:</strong> {r.created_at ? new Date(`${r.created_at}Z`).toLocaleString() : 'Unknown'}</div>
                </div>

                <div className="report-section">
                  <div className="report-section-label">Explanation:</div>
                  <p>{r.report_details || 'No explanation provided.'}</p>
                </div>

                <div className="report-section">
                  <div className="report-section-label">Content:</div>
                  <p className="report-content-text">"{r.post_content ? r.post_content.slice(0, 180) : 'Reported content is unavailable.'}"</p>
                </div>

                {r.status === 'open' ? (
                  <label className="report-admin-note-field">
                    Admin note
                    <textarea
                      className="input"
                      rows={2}
                      placeholder="Optional note about this decision"
                      value={reportNotes[r.id] || ''}
                      onChange={e => setReportNotes(prev => ({ ...prev, [r.id]: e.target.value }))}
                    />
                  </label>
                ) : r.admin_note ? (
                  <div className="report-section">
                    <div className="report-section-label">Admin note:</div>
                    <p>{r.admin_note}</p>
                  </div>
                ) : null}

                <div className="report-card-actions">
                  {r.status === 'open' && (
                    <>
                      <button className="btn btn-sm" onClick={() => reviewReport(r, 'dismissed')}>Approve</button>
                      <button className="btn btn-sm" onClick={() => reviewReport(r, 'resolved')}>Delete</button>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
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
          <div className="admin-table-wrap"><table className="admin-table">
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
          </table></div>
        </div>
      )}

      {/* Game Servers tab */}
      {tab === 'servers' && (
        <div>
          <h3>Add Server</h3>
          <form className="rss-add-form" onSubmit={addServer}>
            <input className="input" placeholder="Game ID" value={srvForm.gameId} onChange={e => setSrvForm({ ...srvForm, gameId: e.target.value })} required />
            <input className="input" placeholder="Server Name" value={srvForm.name} onChange={e => setSrvForm({ ...srvForm, name: e.target.value })} required />
            <input className="input" placeholder="Host/IP" value={srvForm.connection_host} onChange={e => setSrvForm({ ...srvForm, connection_host: e.target.value })} />
            <input className="input" placeholder="Port" value={srvForm.connection_port} onChange={e => setSrvForm({ ...srvForm, connection_port: e.target.value })} style={{ width: 100 }} />
            <input className="input" placeholder="Platform" value={srvForm.platform} onChange={e => setSrvForm({ ...srvForm, platform: e.target.value })} style={{ width: 120 }} />
            <button className="btn btn-primary">Add Server</button>
          </form>

          <h3 style={{ marginTop: 20 }}>Servers ({serverList.length})</h3>
          <div className="admin-table-wrap"><table className="admin-table">
            <thead><tr><th>Game</th><th>Name</th><th>Host</th><th>Status</th><th>Players</th><th>Active</th><th>Actions</th></tr></thead>
            <tbody>{serverList.map((s: any) => (
              <tr key={s.id}>
                <td>{s.game_name}</td>
                <td><strong>{s.name}</strong></td>
                <td className="muted">{s.connection_host}{s.connection_port ? `:${s.connection_port}` : ''}</td>
                <td>{s.status}</td>
                <td>{s.current_players}/{s.max_players || '?'}</td>
                <td>{s.is_active ? '✅' : '❌'}</td>
                <td>
                  <button className="btn btn-sm" onClick={() => toggleServerActive(s.id, !!s.is_active)}>{s.is_active ? 'Deactivate' : 'Activate'}</button>
                  <button className="btn btn-sm" onClick={() => deleteServer(s.id)}>Delete</button>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      )}
    </div>
  );
}
