import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

type Tab = 'friends' | 'following' | 'followers';

export default function FriendsPage({ user }: { user: any }) {
  const [tab, setTab] = useState<Tab>('friends');
  const [following, setFollowing] = useState<any[]>([]);
  const [followers, setFollowers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadFollowing(); }, []);

  async function loadFollowing() {
    setLoading(true);
    try {
      // Get user's profile to get following/follower info
      const r = await api.getUser(user.username);
      const profile = r.user;
      // For a full friends page we'd need dedicated endpoints. For now, search all demo users and filter.
      // Simplified: load all known users and determine relationships
      const allUsers = await api.get<any>('/users?q=');
      const users = allUsers.users || [];

      // Get following/followers from follows data
      const followingIds = new Set<number>();
      const followerIds = new Set<number>();

      // Check follows for each known user
      for (const u of users) {
        if (u.id === user.id) continue;
        try {
          const ur = await api.getUser(u.username);
          if (ur.user.isFollowing) followingIds.add(u.id);
        } catch (e) {}
      }

      setFollowing(users.filter((u: any) => followingIds.has(u.id)));
      // For followers, check who follows the current user (simplified for MVP)
      setFollowers(users.filter((u: any) => u.id !== user.id && users.some((f: any) => f.id === user.id)));
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  async function toggleFollow(userId: number, isFollowing: boolean) {
    try {
      await (isFollowing ? api.unfollow(userId) : api.follow(userId));
      loadFollowing();
    } catch (e) { console.error(e); }
  }

  const isVerified = user?.isVerified ?? user?.is_verified;
  // Mutual friends = intersection of following and followers
  const mutualIds = new Set(following.filter(f => followers.some(fl => fl.id === f.id)).map(f => f.id));
  const displayList = tab === 'friends' ? following.filter(f => mutualIds.has(f.id))
    : tab === 'following' ? following : followers;

  return (
    <div className="friends-page">
      <h2>👥 Connections</h2>
      <div className="admin-tabs">
        <button className={`btn ${tab === 'friends' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('friends')}>
          Friends ({mutualIds.size})
        </button>
        <button className={`btn ${tab === 'following' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('following')}>
          Following ({following.length})
        </button>
        <button className={`btn ${tab === 'followers' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('followers')}>
          Followers ({followers.length})
        </button>
      </div>

      {loading ? <p className="muted">Loading...</p> : displayList.length === 0 ? (
        <p className="muted">{tab === 'friends' ? 'No mutual friends yet.' : tab === 'following' ? 'Not following anyone yet.' : 'No followers yet.'}</p>
      ) : (
        <div className="discover-results">
          {displayList.map((u: any) => {
            const isFollowing = following.some(f => f.id === u.id);
            const isFriend = mutualIds.has(u.id);
            return (
              <div key={u.id} className="discover-card">
                <div className="avatar-placeholder">{u.display_name?.[0] || '?'}</div>
                <div className="discover-info">
                  <Link to={`/profile/${u.username}`} className="discover-name">
                    <strong>{u.display_name}</strong>
                    <span className="muted">@{u.username}</span>
                    {isFriend && <span className="verified-badge">🤝 Friend</span>}
                  </Link>
                  {u.is_verified ? <span className="verified-badge">✅ Verified</span> : <span className="muted">⚠ Unverified</span>}
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
