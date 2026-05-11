import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

type Tab = 'friends' | 'following' | 'followers';

export default function FriendsPage({ user }: { user: any }) {
  const [tab, setTab] = useState<Tab>('friends');
  const [friends, setFriends] = useState<any[]>([]);
  const [following, setFollowing] = useState<any[]>([]);
  const [followers, setFollowers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadConnections(); }, []);

  async function loadConnections() {
    setLoading(true);
    try {
      const [fr, fg, fl] = await Promise.all([
        api.getFriends(),
        api.getFollowing(),
        api.getFollowers(),
      ]);
      setFriends(fr.users || []);
      setFollowing(fg.users || []);
      setFollowers(fl.users || []);
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  async function toggleFollow(userId: number, isFollowing: boolean) {
    try {
      await (isFollowing ? api.unfollow(userId) : api.follow(userId));
      loadConnections();
    } catch (e) { console.error(e); }
  }

  const isVerified = user?.isVerified ?? user?.is_verified;
  const displayList = tab === 'friends' ? friends
    : tab === 'following' ? following : followers;
  const emptyText = tab === 'friends' ? 'No friends yet.'
    : tab === 'following' ? 'You are not following anyone yet.' : 'No followers yet.';

  return (
    <div className="friends-page">
      <h2>👥 Connections</h2>
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
      </div>

      {loading ? <p className="muted">Loading...</p> : displayList.length === 0 ? (
        <p className="muted">{emptyText}</p>
      ) : (
        <div className="discover-results">
          {displayList.map((u: any) => {
            const isFollowing = !!u.isFollowing;
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
                  {(u.isVerified ?? u.is_verified) ? <span className="verified-badge">✅ Verified</span> : <span className="muted">⚠ Unverified</span>}
                  {u.bioSnippet && <p className="muted" style={{ fontSize: '0.82rem', marginTop: 4 }}>{u.bioSnippet}</p>}
                </div>
                {isVerified && (
                  <button className={`btn ${isFollowing ? 'btn-ghost' : 'btn-primary'}`} onClick={() => toggleFollow(u.id, isFollowing)}>
                    {isFollowing ? 'Unfollow' : 'Follow'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
