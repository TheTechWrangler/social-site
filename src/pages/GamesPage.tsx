import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { RouteRequestGate } from '../routeLoadState';

export default function GamesPage() {
  const [games, setGames] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const gate = useRef(new RouteRequestGate());

  async function loadGames() {
    const isCurrent = gate.current.begin();
    setLoading(true);
    setLoadError('');
    try {
      const response = await api.get<any>('/games');
      if (!isCurrent()) return;
      setGames(response.games || []);
      setLoaded(true);
    } catch {
      if (isCurrent()) setLoadError(loaded ? 'Could not refresh games. Previously loaded results may be stale.' : 'Could not load games.');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  useEffect(() => {
    void loadGames();
    return () => gate.current.invalidate();
  }, []);

  const filtered = search.trim()
    ? games.filter(g => g.name.toLowerCase().includes(search.toLowerCase()))
    : games;

  return (
    <div className="games-page">
      <h2>🎮 Games</h2>
      <p className="muted">Find players, groups, and communities for your favorite games.</p>
      <input className="input" placeholder="Search games..." value={search} onChange={e => setSearch(e.target.value)}
        style={{ maxWidth: 400, marginBottom: 20 }} />
      {loadError && <div className="error-msg" role="alert">{loadError}{' '}<button className="btn btn-sm" onClick={() => void loadGames()}>Retry</button></div>}
      {loading && !loaded ? <p className="muted">Loading games…</p> : null}
      {loading && loaded && <p className="muted" role="status">Refreshing games…</p>}
      {loaded && <button className="btn btn-sm btn-ghost" disabled={loading} onClick={() => void loadGames()}>Refresh games</button>}
      {loaded && !loading && filtered.length === 0 && <p className="muted">{search.trim() ? 'No games match this search.' : 'No games are available.'}</p>}
      {loaded && (
        <div className="games-grid">
          {filtered.map(g => (
            <Link to={`/games/${g.slug}`} key={g.id} className="game-card-link">
              <div className="game-card">
                <h4>{g.name}</h4>
                {g.platforms && <p className="muted">{g.platforms}</p>}
                {g.description && <p className="game-card-desc">{g.description.slice(0, 100)}</p>}
                <div className="game-card-stats">
                  <span>{g.lfg_count || 0} LFG</span>
                  <span>{g.player_count || 0} players</span>
                  <span>{g.server_count || 0} servers</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
