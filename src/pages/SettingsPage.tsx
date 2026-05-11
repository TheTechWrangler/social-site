import { useState, useEffect } from 'react';
import { api } from '../api/client';

const WORLD_HOME_OPTIONS = [
  { key: 'world_home_off', label: 'Off' },
  { key: 'world_home_few', label: 'Few' },
  { key: 'world_home_balanced', label: 'Balanced' },
];

export default function SettingsPage({ user }: { user: any }) {
  const [blocked, setBlocked] = useState<any[]>([]);
  const [muted, setMuted] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [gameDiscovery, setGameDiscovery] = useState(user?.game_discovery_enabled === 1);
  const [worldHomeInjection, setWorldHomeInjection] = useState(user?.world_home_injection || 'world_home_few');

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    try {
      const [br, mr] = await Promise.all([
        api.get<any>('/users/blocked/list'),
        api.get<any>('/users/muted/list'),
      ]);
      setBlocked(br.blocked || []);
      setMuted(mr.muted || []);
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  async function unblock(id: number) {
    try {
      await fetch(`/api/users/${id}/block`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } });
      setBlocked(prev => prev.filter(u => u.id !== id));
    } catch (e) { console.error(e); }
  }

  async function unmute(id: number) {
    try {
      await fetch(`/api/users/${id}/mute`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } });
      setMuted(prev => prev.filter(u => u.id !== id));
    } catch (e) { console.error(e); }
  }

  async function toggleGameDiscovery() {
    const newVal = !gameDiscovery;
    setGameDiscovery(newVal);
    try {
      await fetch('/api/users/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ gameDiscoveryEnabled: newVal }) });
    } catch (e) { console.error(e); }
  }

  async function updateWorldHomeInjection(value: string) {
    setWorldHomeInjection(value);
    try {
      await fetch('/api/users/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ worldHomeInjection: value }) });
      const stored = localStorage.getItem('user');
      if (stored) localStorage.setItem('user', JSON.stringify({ ...JSON.parse(stored), world_home_injection: value }));
    } catch (e) { console.error(e); }
  }

  if (loading) return <div className="loading">Loading...</div>;

  return (
    <div className="settings-page">
      <h2>⚙ Settings</h2>

      <div className="settings-section">
        <h3>Account</h3>
        <div className="settings-card">
          <div className="settings-row"><span>Username</span><strong>@{user.username}</strong></div>
          <div className="settings-row"><span>Display Name</span><strong>{user.display_name}</strong></div>
          <div className="settings-row"><span>Role</span><span className={`admin-badge badge-${user.role}`}>{user.role}</span></div>
          <div className="settings-row"><span>Verification</span><span className={`admin-badge ${user.is_verified ? 'badge-verified' : 'badge-unverified'}`}>{user.is_verified ? '✅ Verified' : '⚠ Unverified'}</span></div>
        </div>
      </div>

      <div className="settings-section">
        <h3>World Feed on Home</h3>
        <div className="settings-card">
          <div className="settings-row">
            <span>Mix approved RSS/podcast items into normal Home feeds</span>
            <div className="feed-exposure">
              {WORLD_HOME_OPTIONS.map(opt => (
                <button key={opt.key} className={`btn btn-sm ${worldHomeInjection === opt.key ? 'btn-primary' : 'btn-ghost'}`} onClick={() => updateWorldHomeInjection(opt.key)}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <p className="muted" style={{ fontSize: '0.8rem', marginTop: 8 }}>External items stay labeled and RSS source blocking still applies.</p>
        </div>
      </div>

      <div className="settings-section">
        <h3>Game Discovery</h3>
        <div className="settings-card">
          <div className="settings-row">
            <span>Let people who play the same games find me</span>
            <button className={`btn btn-sm ${gameDiscovery ? 'btn-primary' : 'btn-ghost'}`} onClick={toggleGameDiscovery}>
              {gameDiscovery ? 'ON' : 'OFF'}
            </button>
          </div>
          <p className="muted" style={{ fontSize: '0.8rem', marginTop: 8 }}>When enabled, players who share your listed games can find your profile through the Games section. You can turn this off anytime.</p>
        </div>
      </div>

      <div className="settings-section">
        <h3>Blocked Users ({blocked.length})</h3>
        {blocked.length === 0 ? (
          <p className="muted">You have not blocked anyone.</p>
        ) : (
          <div className="settings-list">
            {blocked.map((u: any) => (
              <div key={u.id} className="settings-row-card">
                <span className="avatar-placeholder" style={{ width: 32, height: 32, fontSize: '0.9rem' }}>{u.display_name?.[0] || '?'}</span>
                <div className="settings-row-info">
                  <strong>{u.display_name}</strong>
                  <span className="muted">@{u.username}</span>
                </div>
                <button className="btn btn-sm" onClick={() => unblock(u.id)}>Unblock</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="settings-section">
        <h3>Muted Users ({muted.length})</h3>
        {muted.length === 0 ? (
          <p className="muted">You have not muted anyone.</p>
        ) : (
          <div className="settings-list">
            {muted.map((u: any) => (
              <div key={u.id} className="settings-row-card">
                <span className="avatar-placeholder" style={{ width: 32, height: 32, fontSize: '0.9rem' }}>{u.display_name?.[0] || '?'}</span>
                <div className="settings-row-info">
                  <strong>{u.display_name}</strong>
                  <span className="muted">@{u.username}</span>
                </div>
                <button className="btn btn-sm" onClick={() => unmute(u.id)}>Unmute</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
