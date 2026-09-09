import { useState, useEffect, useRef } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { RouteRequestGate, routeFailureState, routeStateForKey, type RouteLoadState } from '../routeLoadState';

export default function GameDetailPage({ user }: { user?: any }) {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams] = useSearchParams();
  const routeKey = `${slug || ''}:${user?.id ?? 'anonymous'}`;
  const currentRouteKey = useRef(routeKey);
  currentRouteKey.current = routeKey;
  const [game, setGame] = useState<any>(null);
  const [loadState, setLoadState] = useState<RouteLoadState>('loading');
  const [stateRouteKey, setStateRouteKey] = useState(routeKey);
  const requestGate = useRef(new RouteRequestGate());
  const [lfgPosts, setLfgPosts] = useState<any[]>([]);
  const [players, setPlayers] = useState<any[]>([]);
  const [servers, setServers] = useState<any[]>([]);
  const [tab, setTab] = useState<'servers' | 'lfg' | 'players'>('servers');
  const [viewerDiscoveryEnabled, setViewerDiscoveryEnabled] = useState(false);
  const [playerPlatform, setPlayerPlatform] = useState('');
  const [playerStyle, setPlayerStyle] = useState('');
  const [lfgOnly, setLfgOnly] = useState(false);
  const [showCreateLfg, setShowCreateLfg] = useState(false);
  const [lfgTitle, setLfgTitle] = useState('');
  const [lfgBody, setLfgBody] = useState('');
  const [lfgPlatform, setLfgPlatform] = useState('');
  const [lfgPlayStyle, setLfgPlayStyle] = useState('');
  const [lfgDuration, setLfgDuration] = useState(6);
  const [myLfgPosts, setMyLfgPosts] = useState<any[]>([]);
  const [extendDurations, setExtendDurations] = useState<Record<number, number>>({});
  const [extendingId, setExtendingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [creatingLfg, setCreatingLfg] = useState(false);
  const [lfgError, setLfgError] = useState('');

  const isVerified = user?.is_verified === 1 || user?.isVerified === true;

  function timeUntil(dateStr: string): string {
    const diff = new Date(dateStr + 'Z').getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  useEffect(() => {
    if (searchParams.get('tab') === 'players') setTab('players');
  }, [searchParams]);

  useEffect(() => {
    void loadData();
    return () => requestGate.current.invalidate();
  }, [routeKey]);

  async function loadData() {
    const requestedRouteKey = routeKey;
    if (currentRouteKey.current !== requestedRouteKey) return;
    const isCurrent = requestGate.current.begin();
    setStateRouteKey(requestedRouteKey);
    setLoadState('loading');
    setGame(null);
    setLfgPosts([]);
    setPlayers([]);
    setServers([]);
    setMyLfgPosts([]);
    if (!slug) {
      if (isCurrent()) setLoadState('unavailable');
      return;
    }
    try {
      const r = await api.get<any>(`/games/${slug}`);
      if (!isCurrent()) return;
      setGame(r.game); setLfgPosts(r.lfgPosts); setPlayers(r.players); setServers(r.servers || []);
      setViewerDiscoveryEnabled(!!r.viewerDiscoveryEnabled);
      setLoadState('loaded');
    } catch (error) {
      if (isCurrent()) setLoadState(routeFailureState(error));
      return;
    }
    if (user) {
      try {
        const r = await api.get<any>(`/games/${slug}/lfg/mine`);
        if (isCurrent()) setMyLfgPosts(r.posts || []);
      } catch (e) { /* not logged in or no posts */ }
    }
  }

  async function createLfg(e: React.FormEvent) {
    e.preventDefault();
    if (!lfgTitle.trim() || !isVerified || creatingLfg) return;
    setCreatingLfg(true);
    setLfgError('');
    try {
      await api.post(`/games/${slug}/lfg`, { title: lfgTitle, body: lfgBody, platform: lfgPlatform, playStyle: lfgPlayStyle, durationHours: lfgDuration });
      setLfgTitle(''); setLfgBody(''); setLfgPlatform(''); setLfgPlayStyle(''); setShowCreateLfg(false);
      await loadData();
    } catch (e: any) {
      setLfgError(e.message || 'Could not create LFG post.');
    } finally {
      setCreatingLfg(false);
    }
  }

  async function deleteLfg(id: number) {
    if (deletingId !== null) return;
    setDeletingId(id);
    setLfgError('');
    try {
      await api.delete(`/games/lfg/${id}`);
      await loadData();
    } catch (e: any) {
      setLfgError(e.message || 'Could not delete LFG post.');
    } finally {
      setDeletingId(null);
    }
  }

  async function extendLfg(id: number) {
    const hours = extendDurations[id] ?? 6;
    setExtendingId(id);
    setLfgError('');
    try {
      await api.post(`/games/lfg/${id}/extend`, { durationHours: hours });
      await loadData();
    } catch (e: any) { setLfgError(e.message || 'Could not extend post.'); }
    finally { setExtendingId(null); }
  }

  function setExtendDuration(id: number, hours: number) {
    setExtendDurations(prev => ({ ...prev, [id]: hours }));
  }

  async function followPlayer(player: any) {
    try {
      await api.follow(player.user_id);
      setPlayers(prev => prev.map(p => p.user_id === player.user_id ? { ...p, is_following: 1 } : p));
    } catch (e: any) { alert(e.message || 'Could not follow player.'); }
  }

  const visibleLoadState = routeStateForKey(routeKey, stateRouteKey, loadState);
  if (visibleLoadState === 'loading') {
    return <div className="loading">Loading...</div>;
  }
  if (visibleLoadState === 'unavailable') return (
    <div className="game-detail-page">
      <Link to="/games" className="btn-ghost">← All Games</Link>
      <p className="muted" style={{ marginTop: 24 }}>This game is not available.</p>
    </div>
  );
  if (visibleLoadState === 'error') return (
    <div className="game-detail-page">
      <Link to="/games" className="btn-ghost">← All Games</Link>
      <p className="error-msg" role="alert">Could not load this game.</p>
      <button className="btn btn-ghost" onClick={() => void loadData()}>Try again</button>
    </div>
  );
  if (!game) return null;
  const filteredPlayers = players.filter((p: any) => {
    if (playerPlatform && p.platform !== playerPlatform) return false;
    if (playerStyle && p.play_style !== playerStyle) return false;
    if (lfgOnly && !p.looking_for_group) return false;
    return true;
  });
  const playerPlatforms = Array.from(new Set(players.map((p: any) => p.platform).filter(Boolean)));
  const playerStyles = Array.from(new Set(players.map((p: any) => p.play_style).filter(Boolean)));

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
          {lfgError && <p className="error-msg" role="alert">{lfgError}</p>}
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
              <button className="btn btn-primary" disabled={creatingLfg}>{creatingLfg ? 'Posting...' : 'Post'}</button>
            </form>
          )}

          {/* My LFG Posts management — only shown when logged in and has any posts */}
          {user && myLfgPosts.length > 0 && (
            <div className="my-lfg-section">
              <h4 className="my-lfg-heading">My LFG Posts</h4>
              {myLfgPosts.map(p => {
                const isExpired = new Date(p.expires_at + 'Z') <= new Date();
                const extHours = extendDurations[p.id] ?? 6;
                const isWorking = extendingId === p.id;
                return (
                  <div key={p.id} className={`post-card my-lfg-card ${isExpired ? 'lfg-card-expired' : ''}`}>
                    <div className="post-header">
                      <strong>{p.title}</strong>
                      <span className={`lfg-expires ${isExpired ? 'expired' : ''}`}>
                        {isExpired ? 'Expired' : `Expires ${timeUntil(p.expires_at)}`}
                      </span>
                    </div>
                    {p.body && <p className="muted" style={{ fontSize: '0.85rem', margin: '4px 0' }}>{p.body}</p>}
                    <div className="lfg-tags">
                      {p.platform && <span className="lfg-tag">🎮 {p.platform}</span>}
                      {p.play_style && <span className="lfg-tag">⚡ {p.play_style}</span>}
                      {p.mic_required ? <span className="lfg-tag">🎙 Mic required</span> : null}
                    </div>
                    <div className="lfg-manage-row">
                      <select
                        className="input"
                        style={{ width: 'auto' }}
                        value={extHours}
                        onChange={e => setExtendDuration(p.id, Number(e.target.value))}
                        disabled={isWorking}
                      >
                        {[1,3,6,12,24].map(h => <option key={h} value={h}>{h}h</option>)}
                      </select>
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={() => extendLfg(p.id)}
                        disabled={isWorking}
                      >
                        {isWorking ? '…' : isExpired ? 'Reactivate' : 'Extend'}
                      </button>
                      <button className="btn btn-sm btn-ghost" onClick={() => deleteLfg(p.id)} disabled={isWorking || deletingId === p.id}>Delete</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Active public LFG list */}
          <div className="lfg-public-list">
            {myLfgPosts.length > 0 && <h4 className="my-lfg-heading">Active LFG</h4>}
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
                      <span className="lfg-expires">
                        Expires {timeUntil(p.expires_at)}
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
                  {user?.role === 'admin' && user?.id !== p.user_id && (
                    <button className="btn btn-sm btn-ghost" onClick={() => deleteLfg(p.id)} disabled={deletingId === p.id} style={{ marginTop: 8 }}>Delete</button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {tab === 'players' && (
        <div className="players-section">
          {!viewerDiscoveryEnabled ? (
            <div className="settings-card">
              <p>Turn on Game Discovery to find and be found by players who share your games.</p>
              <Link to="/settings" className="btn btn-primary">Open Settings</Link>
            </div>
          ) : players.length === 0 ? <p className="muted">No opted-in players for this game yet.</p> : (
            <>
            <div className="player-filters">
              <select className="input" value={playerPlatform} onChange={e => setPlayerPlatform(e.target.value)}>
                <option value="">All platforms</option>
                {playerPlatforms.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
              <select className="input" value={playerStyle} onChange={e => setPlayerStyle(e.target.value)}>
                <option value="">All play styles</option>
                {playerStyles.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
              <label className="player-filter-check">
                <input type="checkbox" checked={lfgOnly} onChange={e => setLfgOnly(e.target.checked)} />
                LFG only
              </label>
            </div>
            <div className="discover-results">
              {filteredPlayers.length === 0 ? <p className="muted">No players match those filters.</p> : filteredPlayers.map(p => (
                <div key={p.id} className="discover-card">
                  {p.avatar_url ? <img src={p.avatar_url} alt="" className="avatar-img" /> : <div className="avatar-placeholder">{p.display_name?.[0] || '?'}</div>}
                  <div className="discover-info">
                    <Link to={`/profile/${p.username}`}><strong>{p.display_name}</strong> <span className="muted">@{p.username}</span></Link>
                    <div className="lfg-tags" style={{ marginTop: 4 }}>
                      {p.platform && <span className="lfg-tag">🎮 {p.platform}</span>}
                      {p.play_style && <span className="lfg-tag">⚡ {p.play_style}</span>}
                      {p.looking_for_group ? <span className="lfg-tag">🔍 LFG</span> : null}
                      {p.is_favorite ? <span className="lfg-tag">Favorite</span> : null}
                    </div>
                  </div>
                  {isVerified && user?.id !== p.user_id && !p.is_following && (
                    <button className="btn btn-sm btn-ghost" onClick={() => followPlayer(p)}>Follow</button>
                  )}
                </div>
              ))}
            </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
