import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

export default function GamesPage() {
  const [games, setGames] = useState<any[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    api.get<any>('/games').then(r => setGames(r.games)).catch(() => {});
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
    </div>
  );
}
