import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client';

export default function GameDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const [game, setGame] = useState<any>(null);
  const [lfgPosts, setLfgPosts] = useState<any[]>([]);
  const [players, setPlayers] = useState<any[]>([]);
  const [servers, setServers] = useState<any[]>([]);
  const [tab, setTab] = useState<'servers' | 'lfg' | 'players'>('servers');
  const [showCreateLfg, setShowCreateLfg] = useState(false);
  const [lfgTitle, setLfgTitle] = useState('');
  const [lfgBody, setLfgBody] = useState('');
  const [lfgPlatform, setLfgPlatform] = useState('');
  const [lfgPlayStyle, setLfgPlayStyle] = useState('');
  const [lfgDuration, setLfgDuration] = useState(6);

  const user = JSON.parse(localStorage.getItem('user') || 'null');
  const isVerified = user?.is_verified ?? user?.is_verified === 1;

  function timeUntil(dateStr: string): string {
    const diff = new Date(dateStr + 'Z').getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  useEffect(() => { loadData(); }, [slug]);

  async function loadData() {
    try {
      const r = await api.get<any>(`/games/${slug}`);
      setGame(r.game); setLfgPosts(r.lfgPosts); setPlayers(r.players); setServers(r.servers || []);
    } catch (e) { console.error(e); }
  }

  async function createLfg(e: React.FormEvent) {
    e.preventDefault();
    if (!lfgTitle.trim() || !isVerified) return;
    try {
      await api.post(`/games/${slug}/lfg`, { title: lfgTitle, body: lfgBody, platform: lfgPlatform, playStyle: lfgPlayStyle, durationHours: lfgDuration });
      setLfgTitle(''); setLfgBody(''); setLfgPlatform(''); setLfgPlayStyle(''); setShowCreateLfg(false);
      loadData();
    } catch (e: any) { alert(e.message); }
  }

  async function deleteLfg(id: number) {
    try { await fetch(`/api/games/lfg/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } }); loadData(); } catch (e) {}
  }

  if (!game) return <div className="loading">Loading...</div>;

  return (
    <div className="game-detail-page">
      <Link to="/games" className="btn-ghost">← All Games</Link>
      <h2>{game.name}</h2>
      {game.platforms && <p className="muted">{game.platforms}</p>}
      {game.description && <p>{game.description}</p>}

      <div className="admin-tabs" style={{ marginTop: 16 }}>
        <button className={`btn ${tab === 'servers' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('servers')}>Live Servers ({servers.length})</button>
        <button className={`btn ${tab === 'lfg' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('lfg')}>Looking for Group ({lfgPosts.length})</button>
        <button className={`btn ${tab === 'players' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('players')}>Players ({players.length})</button>
      </div>

      {tab === 'servers' && (
        <div className="servers-section">
          {servers.length === 0 ? <p className="muted">No live servers listed yet.</p> : (
            servers.map((s: any) => (
              <div key={s.id} className="server-card">
                <div className="server-header">
                  <h4>{s.name}</h4>
                  <span className={`server-status status-${s.status}`}>
                    {s.status === 'online' ? '🟢 Online' : s.status === 'offline' ? '🔴 Offline' : s.status === 'maintenance' ? '🟡 Maintenance' : '⚪ Unknown'}
                  </span>
                </div>
                {s.description && <p className="muted">{s.description}</p>}
                <div className="server-details">
                  {s.connection_host && <span className="server-info">🔗 {s.connection_host}{s.connection_port ? `:${s.connection_port}` : ''}</span>}
                  {s.current_players != null && s.max_players && <span className="server-info">👥 {s.current_players}/{s.max_players} players</span>}
                  {s.platform && <span className="server-info">🎮 {s.platform}</span>}
                  {s.server_type && <span className="server-info">📦 {s.server_type}</span>}
                  {s.play_style && <span className="server-info">⚡ {s.play_style}</span>}
                  {s.region_or_timezone && <span className="server-info">🌍 {s.region_or_timezone}</span>}
                </div>
                {s.join_instructions && <p className="server-join">{s.join_instructions}</p>}
                {s.rules_summary && <p className="server-rules">📋 {s.rules_summary}</p>}
                <div className="server-links">
                  {s.discord_url && <a href={s.discord_url} target="_blank" rel="noopener noreferrer" className="btn btn-sm">💬 Discord</a>}
                  {s.website_url && <a href={s.website_url} target="_blank" rel="noopener noreferrer" className="btn btn-sm">🌐 Website</a>}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'lfg' && (
        <div className="lfg-section">
          {isVerified && (
            <button className="btn btn-primary" style={{ marginBottom: 12 }} onClick={() => setShowCreateLfg(!showCreateLfg)}>
              {showCreateLfg ? 'Cancel' : '+ New LFG Post'}
            </button>
          )}
          {showCreateLfg && (
            <form className="post-composer" onSubmit={createLfg}>
              <input className="input" placeholder="Title (e.g. Looking for 2 more — Valheim)" value={lfgTitle} onChange={e => setLfgTitle(e.target.value)} required />
              <textarea className="input" placeholder="Details..." value={lfgBody} onChange={e => setLfgBody(e.target.value)} rows={3} />
              <input className="input" placeholder="Platform (PC, Xbox, PS5...)" value={lfgPlatform} onChange={e => setLfgPlatform(e.target.value)} />
              <input className="input" placeholder="Play style (casual, competitive...)" value={lfgPlayStyle} onChange={e => setLfgPlayStyle(e.target.value)} />
              <div className="lfg-duration">
                <span className="muted" style={{ fontSize: '0.85rem' }}>Expires in:</span>
                <select className="input" value={lfgDuration} onChange={e => setLfgDuration(Number(e.target.value))} style={{ width: 'auto' }}>
                  {[1,3,6,12,24].map(h => <option key={h} value={h}>{h} hour{h>1?'s':''}</option>)}
                </select>
              </div>
              <button className="btn btn-primary">Post</button>
            </form>
          )}
          {lfgPosts.length === 0 ? <p className="muted">No LFG posts yet.</p> : (
            lfgPosts.map(p => (
              <div key={p.id} className="post-card">
                <div className="post-header">
                  <Link to={`/profile/${p.username}`} className="post-user">
                    <span className="avatar-placeholder">{p.display_name?.[0] || '?'}</span>
                    <div><strong>{p.display_name}</strong><span className="muted">@{p.username}</span></div>
                  </Link>
                  <span className="post-time">{new Date(p.created_at + 'Z').toLocaleDateString()}</span>
                  {p.expires_at && (
                    <span className={`lfg-expires ${new Date(p.expires_at + 'Z') < new Date() ? 'expired' : ''}`}>
                      {new Date(p.expires_at + 'Z') < new Date() ? 'Expired' : `Expires ${timeUntil(p.expires_at)}`}
                    </span>
                  )}
                </div>
                <h4>{p.title}</h4>
                {p.body && <p className="muted">{p.body}</p>}
                <div className="lfg-tags">
                  {p.platform && <span className="lfg-tag">🎮 {p.platform}</span>}
                  {p.play_style && <span className="lfg-tag">⚡ {p.play_style}</span>}
                  {p.mic_required ? <span className="lfg-tag">🎙 Mic required</span> : null}
                </div>
                {(user?.id === p.user_id || user?.role === 'admin') && (
                  <button className="btn btn-sm btn-ghost" onClick={() => deleteLfg(p.id)} style={{ marginTop: 8 }}>Delete</button>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'players' && (
        <div className="players-section">
          {players.length === 0 ? <p className="muted">No players listed yet.</p> : (
            <div className="discover-results">
              {players.map(p => (
                <div key={p.id} className="discover-card">
                  <div className="avatar-placeholder">{p.display_name?.[0] || '?'}</div>
                  <div className="discover-info">
                    <Link to={`/profile/${p.username}`}><strong>{p.display_name}</strong> <span className="muted">@{p.username}</span></Link>
                    <div className="lfg-tags" style={{ marginTop: 4 }}>
                      {p.platform && <span className="lfg-tag">🎮 {p.platform}</span>}
                      {p.play_style && <span className="lfg-tag">⚡ {p.play_style}</span>}
                      {p.looking_for_group ? <span className="lfg-tag">🔍 LFG</span> : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
