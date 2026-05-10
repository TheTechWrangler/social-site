import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import PostCard from '../components/PostCard';

export default function ProfilePage({ user: currentUser }: { user: any }) {
  const { username } = useParams<{ username: string }>();
  const [profile, setProfile] = useState<any>(null);
  const [posts, setPosts] = useState<any[]>([]);
  const [editing, setEditing] = useState(false);
  const [bio, setBio] = useState('');
  const [displayName, setDisplayName] = useState('');

  useEffect(() => {
    loadProfile();
  }, [username]);

  async function loadProfile() {
    try {
      const r = await api.getUser(username!);
      setProfile(r.user);
      setBio(r.user.bio || '');
      setDisplayName(r.user.displayName || '');
      // Load user's posts
      const feed = await api.feed();
      setPosts(feed.posts.filter((p: any) => p.username === username));
    } catch (e) { console.error(e); }
  }

  async function handleFollow() {
    try {
      await (profile.isFollowing ? api.unfollow(profile.id) : api.follow(profile.id));
      setProfile({ ...profile, isFollowing: !profile.isFollowing, followerCount: profile.followerCount + (profile.isFollowing ? -1 : 1) });
    } catch (e) { console.error(e); }
  }

  async function handleSaveProfile() {
    try {
      const r = await api.updateProfile({ displayName, bio });
      setProfile({ ...profile, ...r.user });
      setEditing(false);
    } catch (e) { console.error(e); }
  }

  if (!profile) return <div className="loading">Loading...</div>;
  const isOwn = currentUser?.id === profile.id;

  return (
    <div className="profile-page">
      <div className="profile-header">
        <div className="avatar-placeholder large">{profile.displayName?.[0] || '?'}</div>
        <div>
          <h2>{profile.displayName}</h2>
          <p className="muted">@{profile.username}</p>
          {profile.bio && <p>{profile.bio}</p>}
          <div className="profile-stats">
            <span><strong>{profile.postCount}</strong> posts</span>
            <span><strong>{profile.followerCount}</strong> followers</span>
            <span><strong>{profile.followingCount}</strong> following</span>
          </div>
          {!isOwn && (
            <button className={`btn ${profile.isFollowing ? 'btn-ghost' : 'btn-primary'}`} onClick={handleFollow}>
              {profile.isFollowing ? 'Unfollow' : 'Follow'}
            </button>
          )}
          {isOwn && !editing && (
            <button className="btn btn-ghost" onClick={() => setEditing(true)}>Edit Profile</button>
          )}
        </div>
      </div>

      {editing && (
        <div className="edit-profile">
          <input className="input" placeholder="Display Name" value={displayName} onChange={e => setDisplayName(e.target.value)} />
          <textarea className="input" placeholder="Bio" value={bio} onChange={e => setBio(e.target.value)} rows={3} />
          <button className="btn btn-primary" onClick={handleSaveProfile}>Save</button>
          <button className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      )}

      <h3>Posts</h3>
      {posts.length === 0 ? <p className="muted">No posts yet.</p> : posts.map(p => <PostCard key={p.id} post={p} currentUser={currentUser} />)}
    </div>
  );
}
