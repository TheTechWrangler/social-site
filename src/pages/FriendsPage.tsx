import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';

type Tab = 'friends' | 'following' | 'followers' | 'requests';

export default function FriendsPage({ user }: { user: any }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('friends');
  const [friends, setFriends] = useState<any[]>([]);
  const [following, setFollowing] = useState<any[]>([]);
  const [followers, setFollowers] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState('');
  const [pendingUserId, setPendingUserId] = useState<number | null>(null);

  useEffect(() => { loadConnections(); }, []);

  async function loadConnections() {
    setLoading(true);
    try {
      const [fr, fg, fl, rq] = await Promise.all([
        api.getFriends(),
        api.getFollowing(),
        api.getFollowers(),
        api.getFollowRequests(),
      ]);
      setFriends(fr.users || []);
      setFollowing(fg.users || []);
      setFollowers(fl.users || []);
      setRequests(rq.requests || []);
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  async function toggleFollow(userId: number, relationshipStatus: 'none' | 'pending' | 'accepted') {
    if (pendingUserId !== null) return;
    setPendingUserId(userId);
    setActionError('');
    try {
      await (relationshipStatus === 'none' ? api.follow(userId) : api.unfollow(userId));
      await loadConnections();
    } catch (e: any) {
      console.error(e);
      setActionError(e.message || 'Could not update follow status.');
    } finally {
      setPendingUserId(null);
    }
  }

  async function manageRequest(userId: number, action: 'accept' | 'decline') {
    if (pendingUserId !== null) return;
    setPendingUserId(userId); setActionError('');
    try {
      await (action === 'accept' ? api.acceptFollowRequest(userId) : api.declineFollowRequest(userId));
      await loadConnections();
    } catch (e: any) {
      setActionError(e.message || `Could not ${action} follow request.`);
    } finally { setPendingUserId(null); }
  }

  async function removeFollower(userId: number) {
    if (pendingUserId !== null) return;
    setPendingUserId(userId); setActionError('');
    try {
      await api.removeFollower(userId);
      await loadConnections();
    } catch (e: any) {
      setActionError(e.message || 'Could not remove follower.');
    } finally { setPendingUserId(null); }
  }

  async function handleMessage(userId: number) {
    try {
      const r = await api.startConversation(userId);
      navigate(`/messages/${r.conversationId}`);
    } catch (e: any) {
      alert(e.message || 'Cannot start a conversation with this user.');
    }
  }

  const isVerified = user?.isVerified ?? user?.is_verified;
  const displayList = tab === 'friends' ? friends
    : tab === 'following' ? following
      : tab === 'followers' ? followers : requests;
  const emptyText = tab === 'friends' ? 'No friends yet.'
    : tab === 'following' ? 'You are not following anyone yet.'
      : tab === 'followers' ? 'No followers yet.' : 'No pending follow requests.';

  return (
    <div className="friends-page">
      <h2>👥 Connections</h2>
      {actionError && <p className="error-msg" role="alert">{actionError}</p>}
      <div className="admin-tabs">
        <button className={`btn ${tab === 'friends' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('friends')}>
          Friends ({friends.length})
        </button>
        <button className={`btn ${tab === 'following' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('following')}>
          Following ({following.length})
        </button>
        <button className={`btn ${tab === 'followers' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('followers')}>
          Followers ({followers.length})
        </button>
        <button className={`btn ${tab === 'requests' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('requests')}>
          Requests ({requests.length})
        </button>
      </div>

      {loading ? <p className="muted">Loading...</p> : displayList.length === 0 ? (
        <p className="muted">{emptyText}</p>
      ) : (
        <div className="discover-results">
          {displayList.map((u: any) => {
            const isFollowing = !!u.isFollowing;
            const relationshipStatus = u.followStatus || (isFollowing ? 'accepted' : 'none');
            const isFriend = !!u.isFollowing && !!u.followsMe;
            const displayName = u.displayName || u.display_name || u.username;
            return (
              <div key={u.id} className="discover-card">
                <div className="avatar-placeholder">{displayName?.[0] || '?'}</div>
                <div className="discover-info">
                  <Link to={`/profile/${u.username}`} className="discover-name">
                    <strong>{displayName}</strong>
                    <span className="muted">@{u.username}</span>
                    {isFriend && <span className="verified-badge">🤝 Friend</span>}
                  </Link>
                  {tab !== 'requests' && ((u.isVerified ?? u.is_verified)
                    ? <span className="verified-badge">✅ Verified</span>
                    : <span className="muted">⚠ Unverified</span>)}
                  {u.bioSnippet && <p className="muted" style={{ fontSize: '0.82rem', marginTop: 4 }}>{u.bioSnippet}</p>}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {tab === 'requests' ? (
                    <>
                      <button className="btn btn-primary btn-sm" onClick={() => manageRequest(u.id, 'accept')} disabled={pendingUserId === u.id}>Accept</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => manageRequest(u.id, 'decline')} disabled={pendingUserId === u.id}>Decline</button>
                    </>
                  ) : (
                    <>
                      <button className="btn btn-ghost btn-sm" onClick={() => handleMessage(u.id)} title="Send message">💬</button>
                      {isVerified && (
                        <button className={`btn ${isFollowing ? 'btn-ghost' : 'btn-primary'}`} onClick={() => toggleFollow(u.id, relationshipStatus)} disabled={pendingUserId === u.id}>
                          {relationshipStatus === 'pending' ? 'Pending — cancel' : isFollowing ? 'Unfollow' : 'Follow'}
                        </button>
                      )}
                      {!isVerified && relationshipStatus !== 'none' && (
                        <button className="btn btn-ghost" onClick={() => toggleFollow(u.id, relationshipStatus)} disabled={pendingUserId === u.id}>
                          {relationshipStatus === 'pending' ? 'Cancel request' : 'Unfollow'}
                        </button>
                      )}
                      {tab === 'followers' && (
                        <button className="btn btn-ghost btn-sm" onClick={() => removeFollower(u.id)} disabled={pendingUserId === u.id}>Remove follower</button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
