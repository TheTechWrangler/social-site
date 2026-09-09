import { useState, useEffect } from 'react';
import { api } from '../api/client';

const WORLD_HOME_OPTIONS = [
  { key: 'world_home_off', label: 'Off' },
  { key: 'world_home_few', label: 'Few' },
  { key: 'world_home_balanced', label: 'Balanced' },
];

const DM_PRIVACY_OPTIONS = [
  { key: 'noone', label: 'No one' },
  { key: 'friends', label: 'Friends' },
  { key: 'friends_of_friends', label: 'Friends of friends' },
  { key: 'everyone', label: 'Everyone' },
];

function gameDiscoveryValue(user: any): boolean {
  return Boolean(user?.game_discovery_enabled ?? user?.gameDiscoveryEnabled ?? 0);
}

export default function SettingsPage({
  user,
  onUserChange,
}: {
  user: any;
  onUserChange: (user: any) => void;
}) {
  const [blocked, setBlocked] = useState<any[]>([]);
  const [muted, setMuted] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [gameDiscovery, setGameDiscovery] = useState(gameDiscoveryValue(user));
  const [worldHomeInjection, setWorldHomeInjection] = useState(user?.world_home_injection || 'world_home_few');
  const [dmPrivacy, setDmPrivacy] = useState(user?.dm_privacy || 'friends_of_friends');
  const [relationshipError, setRelationshipError] = useState('');
  const [pendingRelationship, setPendingRelationship] = useState<string | null>(null);

  useEffect(() => { loadData(); }, []);
  useEffect(() => {
    setGameDiscovery(gameDiscoveryValue(user));
    setWorldHomeInjection(user?.world_home_injection || 'world_home_few');
    setDmPrivacy(user?.dm_privacy || 'friends_of_friends');
  }, [user]);

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
    if (pendingRelationship) return;
    setPendingRelationship(`block:${id}`);
    setRelationshipError('');
    try {
      await api.delete(`/users/${id}/block`);
      setBlocked(prev => prev.filter(u => u.id !== id));
    } catch (e: any) {
      console.error(e);
      setRelationshipError(e.message || 'Could not unblock user.');
    } finally {
      setPendingRelationship(null);
    }
  }

  async function unmute(id: number) {
    if (pendingRelationship) return;
    setPendingRelationship(`mute:${id}`);
    setRelationshipError('');
    try {
      await api.delete(`/users/${id}/mute`);
      setMuted(prev => prev.filter(u => u.id !== id));
    } catch (e: any) {
      console.error(e);
      setRelationshipError(e.message || 'Could not unmute user.');
    } finally {
      setPendingRelationship(null);
    }
  }

  async function toggleGameDiscovery() {
    const newVal = !gameDiscovery;
    setGameDiscovery(newVal);
    try {
      const r = await api.updateProfile({ gameDiscoveryEnabled: newVal });
      onUserChange(r.authUser);
      setGameDiscovery(gameDiscoveryValue(r.authUser));
    } catch (e) {
      console.error(e);
      setGameDiscovery(!newVal);
    }
  }

  async function updateWorldHomeInjection(value: string) {
    const previous = worldHomeInjection;
    setWorldHomeInjection(value);
    try {
      const r = await api.updateProfile({ worldHomeInjection: value });
      onUserChange(r.authUser);
      setWorldHomeInjection(r.authUser.world_home_injection);
    } catch (e) {
      console.error(e);
      setWorldHomeInjection(previous);
    }
  }

  async function updateDmPrivacy(value: string) {
    const previous = dmPrivacy;
    setDmPrivacy(value);
    try {
      const r = await api.updateProfile({ dmPrivacy: value });
      onUserChange(r.authUser);
      setDmPrivacy(r.authUser.dm_privacy);
    } catch (e) {
      console.error(e);
      setDmPrivacy(previous);
    }
  }

  if (loading) return <div className="loading">Loading...</div>;

  return (
    <div className="settings-page">
      <h2>⚙ Settings</h2>
      {relationshipError && <p className="error-msg" role="alert">{relationshipError}</p>}

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
        <h3>Messages</h3>
        <div className="settings-card">
          <div className="settings-row">
            <span>Who can message me?</span>
            <div className="feed-exposure">
              {DM_PRIVACY_OPTIONS.map(opt => (
                <button key={opt.key} className={`btn btn-sm ${dmPrivacy === opt.key ? 'btn-primary' : 'btn-ghost'}`} onClick={() => updateDmPrivacy(opt.key)}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <p className="muted" style={{ fontSize: '0.8rem', marginTop: 8 }}>Controls who can start or continue a Direct Message conversation with you.</p>
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
          <p className="muted" style={{ fontSize: '0.8rem', marginTop: 8 }}>Your listed games can stay visible on your profile, but you only appear in player discovery when Game Discovery is ON.</p>
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
                <button className="btn btn-sm" onClick={() => unblock(u.id)} disabled={pendingRelationship === `block:${u.id}`}>Unblock</button>
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
                <button className="btn btn-sm" onClick={() => unmute(u.id)} disabled={pendingRelationship === `mute:${u.id}`}>Unmute</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
