import { useState, useEffect } from 'react';
import { api } from '../api/client';

export default function SettingsPage({ user }: { user: any }) {
  const [blocked, setBlocked] = useState<any[]>([]);
  const [muted, setMuted] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

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
