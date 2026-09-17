import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';
import { RouteRequestGate } from '../routeLoadState';

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
  const [dataLoaded, setDataLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [gameDiscovery, setGameDiscovery] = useState(gameDiscoveryValue(user));
  const [worldHomeInjection, setWorldHomeInjection] = useState(user?.world_home_injection || 'world_home_few');
  const [dmPrivacy, setDmPrivacy] = useState(user?.dm_privacy || 'friends_of_friends');
  const [preferencePending, setPreferencePending] = useState<string | null>(null);
  const [preferenceError, setPreferenceError] = useState('');
  const preferenceLock = useRef(false);
  const preferenceGate = useRef(new RouteRequestGate());
  const currentAccountId = useRef(user?.id);
  const [relationshipError, setRelationshipError] = useState('');
  const [pendingRelationship, setPendingRelationship] = useState<string | null>(null);
  currentAccountId.current = user?.id;

  useEffect(() => { loadData(); }, []);
  useEffect(() => {
    preferenceGate.current.invalidate();
    preferenceLock.current = false;
    setPreferencePending(null);
    setPreferenceError('');
    return () => preferenceGate.current.invalidate();
  }, [user?.id]);
  useEffect(() => {
    setGameDiscovery(gameDiscoveryValue(user));
    setWorldHomeInjection(user?.world_home_injection || 'world_home_few');
    setDmPrivacy(user?.dm_privacy || 'friends_of_friends');
  }, [user]);

  async function loadData() {
    setLoading(true);
    setLoadError('');
    try {
      const [br, mr] = await Promise.all([
        api.get<any>('/users/blocked/list'),
        api.get<any>('/users/muted/list'),
      ]);
      setBlocked(br.blocked || []);
      setMuted(mr.muted || []);
      setDataLoaded(true);
    } catch {
      setLoadError(dataLoaded ? 'Could not refresh blocked and muted lists. Previously loaded information may be stale.' : 'Could not load blocked and muted lists.');
    } finally {
      setLoading(false);
    }
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
    if (preferenceLock.current) return;
    const newVal = !gameDiscovery;
    const requestedAccountId = user?.id;
    const isCurrent = preferenceGate.current.begin();
    preferenceLock.current = true;
    setPreferencePending('gameDiscovery');
    setPreferenceError('');
    try {
      const r = await api.updateProfile({ gameDiscoveryEnabled: newVal });
      if (!isCurrent() || currentAccountId.current !== requestedAccountId) return;
      onUserChange(r.authUser);
      setGameDiscovery(gameDiscoveryValue(r.authUser));
      setWorldHomeInjection(r.authUser.world_home_injection || worldHomeInjection);
      setDmPrivacy(r.authUser.dm_privacy || dmPrivacy);
    } catch (e: any) {
      if (isCurrent() && currentAccountId.current === requestedAccountId) {
        setPreferenceError('Could not save Game Discovery. The previous server-confirmed setting remains active.');
      }
    } finally {
      if (isCurrent() && currentAccountId.current === requestedAccountId) {
        preferenceLock.current = false;
        setPreferencePending(null);
      }
    }
  }

  async function updateWorldHomeInjection(value: string) {
    if (preferenceLock.current || value === worldHomeInjection) return;
    const requestedAccountId = user?.id;
    const isCurrent = preferenceGate.current.begin();
    preferenceLock.current = true;
    setPreferencePending('worldHomeInjection');
    setPreferenceError('');
    try {
      const r = await api.updateProfile({ worldHomeInjection: value });
      if (!isCurrent() || currentAccountId.current !== requestedAccountId) return;
      onUserChange(r.authUser);
      setWorldHomeInjection(r.authUser.world_home_injection);
      setGameDiscovery(gameDiscoveryValue(r.authUser));
      setDmPrivacy(r.authUser.dm_privacy || dmPrivacy);
    } catch (e: any) {
      if (isCurrent() && currentAccountId.current === requestedAccountId) {
        setPreferenceError('Could not save the World preference. The previous server-confirmed setting remains active.');
      }
    } finally {
      if (isCurrent() && currentAccountId.current === requestedAccountId) {
        preferenceLock.current = false;
        setPreferencePending(null);
      }
    }
  }

  async function updateDmPrivacy(value: string) {
    if (preferenceLock.current || value === dmPrivacy) return;
    const requestedAccountId = user?.id;
    const isCurrent = preferenceGate.current.begin();
    preferenceLock.current = true;
    setPreferencePending('dmPrivacy');
    setPreferenceError('');
    try {
      const r = await api.updateProfile({ dmPrivacy: value });
      if (!isCurrent() || currentAccountId.current !== requestedAccountId) return;
      onUserChange(r.authUser);
      setDmPrivacy(r.authUser.dm_privacy);
      setGameDiscovery(gameDiscoveryValue(r.authUser));
      setWorldHomeInjection(r.authUser.world_home_injection || worldHomeInjection);
    } catch (e: any) {
      if (isCurrent() && currentAccountId.current === requestedAccountId) {
        setPreferenceError('Could not save message privacy. The previous server-confirmed setting remains active.');
      }
    } finally {
      if (isCurrent() && currentAccountId.current === requestedAccountId) {
        preferenceLock.current = false;
        setPreferencePending(null);
      }
    }
  }

  return (
    <div className="settings-page">
      <h2>⚙ Settings</h2>
      {relationshipError && <p className="error-msg" role="alert">{relationshipError}</p>}

      {preferenceError && <p className="error-msg" role="alert">{preferenceError}</p>}
      {preferencePending && <p className="muted" role="status">Saving privacy preference…</p>}
      {loadError && <div className="error-msg" role="alert">{loadError}{' '}<button className="btn btn-sm" onClick={() => void loadData()}>Retry</button></div>}
      {loading && dataLoaded && <p className="muted" role="status">Refreshing relationship settings…</p>}
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
                <button key={opt.key} disabled={preferencePending !== null} className={`btn btn-sm ${worldHomeInjection === opt.key ? 'btn-primary' : 'btn-ghost'}`} onClick={() => updateWorldHomeInjection(opt.key)}>
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
                <button key={opt.key} disabled={preferencePending !== null} className={`btn btn-sm ${dmPrivacy === opt.key ? 'btn-primary' : 'btn-ghost'}`} onClick={() => updateDmPrivacy(opt.key)}>
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
            <button disabled={preferencePending !== null} className={`btn btn-sm ${gameDiscovery ? 'btn-primary' : 'btn-ghost'}`} onClick={toggleGameDiscovery}>
              {gameDiscovery ? 'ON' : 'OFF'}
            </button>
          </div>
          <p className="muted" style={{ fontSize: '0.8rem', marginTop: 8 }}>Your listed games can stay visible on your profile, but you only appear in player discovery when Game Discovery is ON.</p>
        </div>
      </div>

      <div className="settings-section">
        <h3>Blocked Users{dataLoaded ? ` (${blocked.length})` : ''}</h3>
        {loading && !dataLoaded ? <p className="muted">Loading blocked users…</p> : !dataLoaded ? null : (
          <>
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
          </>
        )}
      </div>

      <div className="settings-section">
        <h3>Muted Users{dataLoaded ? ` (${muted.length})` : ''}</h3>
        {loading && !dataLoaded ? <p className="muted">Loading muted users…</p> : !dataLoaded ? null : (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}
