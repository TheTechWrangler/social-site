import { useState, useEffect, useRef } from 'react';
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
  const [profileVis, setProfileVis] = useState('public');
  const [avatarUploading, setAvatarUploading] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [showGamePicker, setShowGamePicker] = useState(false);
  const [gameSearch, setGameSearch] = useState('');
  const [gameResults, setGameResults] = useState<any[]>([]);
  const [gamePlatform, setGamePlatform] = useState('PC');
  const [gamePlayStyle, setGamePlayStyle] = useState('');
  const [gameLookingForGroup, setGameLookingForGroup] = useState(false);
  const [gameFavorite, setGameFavorite] = useState(false);

  useEffect(() => { loadProfile(); }, [username]);

  async function loadProfile() {
    try {
      const r = await api.getUser(username!);
      setProfile(r.user);
      setBio(r.user.bio || '');
      setDisplayName(r.user.displayName || '');
      setProfileVis(r.user.profileVisibility || 'public');
      if (r.user.limited) { setPosts([]); return; }
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

  async function handleMute() {
    if (!confirm(`Mute @${profile.username}? You will stop seeing their posts.`)) return;
    try {
      await fetch(`/api/users/${profile.id}/mute`, { method: 'POST', headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } });
      alert('User muted.');
    } catch (e: any) { alert(e.message || 'Failed'); }
  }

  async function handleBlock() {
    if (!confirm(`Block @${profile.username}? They will not be able to interact with you, and you will stop seeing their posts.`)) return;
    try {
      await fetch(`/api/users/${profile.id}/block`, { method: 'POST', headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } });
      window.location.reload();
    } catch (e: any) { alert(e.message || 'Failed'); }
  }

  async function handleSaveProfile() {
    try {
      // Update profile fields
      const r = await api.updateProfile({ displayName, bio, profileVisibility: profileVis } as any);
      setProfile({ ...profile, ...r.user, avatarUrl: profile.avatarUrl });
      setEditing(false);
    } catch (e) { console.error(e); }
  }

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { alert('Avatar must be under 2MB.'); return; }
    setAvatarUploading(true);
    try {
      const r = await api.uploadAvatar(file);
      await api.updateProfile({ avatar_url: r.media.url } as any);
      setProfile({ ...profile, avatarUrl: r.media.url });
    } catch (e: any) { alert(e.message || 'Avatar upload failed'); }
    setAvatarUploading(false);
  }

  async function searchGames(q: string) {
    if (q.length < 1) { setGameResults([]); return; }
    try { const r = await api.get<any>(`/games?q=${encodeURIComponent(q)}`); setGameResults(r.games || []); } catch (e) {}
  }

  async function addGame(gameId: number, slug: string) {
    try {
      await fetch(`/api/games/${slug}/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify({ platform: gamePlatform, playStyle: gamePlayStyle, lookingForGroup: gameLookingForGroup, isFavorite: gameFavorite, displayOnProfile: true }),
      });
      setShowGamePicker(false); setGameSearch(''); setGameResults([]);
      loadProfile();
    } catch (e) { console.error(e); }
  }

  async function removeGame(gameId: number, slug: string) {
    try {
      await fetch(`/api/games/${slug}/profile`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } });
      loadProfile();
    } catch (e) { console.error(e); }
  }

  if (!profile) return <div className="loading">Loading...</div>;
  const isOwn = currentUser?.id === profile.id;
  const isLimited = profile.limited || profile.isPrivate;

  return (
    <div className="profile-page">
      <div className="profile-header">
        {profile.avatarUrl ? (
          <img src={profile.avatarUrl} alt="" className="avatar-img large" />
        ) : (
          <div className="avatar-placeholder large">{profile.displayName?.[0] || '?'}</div>
        )}
        <div>
          <h2>{profile.displayName}</h2>
          <p className="muted">@{profile.username}</p>
          {isLimited && !isOwn && (
            <div className="verify-banner">🔒 This profile is private.</div>
          )}
          {(!isLimited || isOwn) && (
            <>
              {profile.bio && <p>{profile.bio}</p>}
              <div className="profile-stats">
                <span><strong>{profile.postCount}</strong> posts</span>
                <span><strong>{profile.followerCount}</strong> followers</span>
                <span><strong>{profile.followingCount}</strong> following</span>
              </div>
            </>
          )}
          {!isOwn && (
            <>
              <button className={`btn ${profile.isFollowing ? 'btn-ghost' : 'btn-primary'}`} onClick={handleFollow}>
                {profile.isFollowing ? 'Unfollow' : 'Follow'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={handleMute}>🔇 Mute</button>
              <button className="btn btn-ghost btn-sm" onClick={handleBlock}>🚫 Block</button>
            </>
          )}
          {isOwn && !editing && (
            <>
              <button className="btn btn-ghost" onClick={() => setEditing(true)}>Edit Profile</button>
              <label className="btn btn-ghost" style={{ cursor: 'pointer' }}>
                {avatarUploading ? 'Uploading...' : '📷 Change Avatar'}
                <input type="file" ref={avatarInputRef} accept="image/*" onChange={handleAvatarUpload} style={{ display: 'none' }} />
              </label>
            </>
          )}
        </div>
      </div>

      {editing && (
        <div className="edit-profile">
          <input className="input" placeholder="Display Name" value={displayName} onChange={e => setDisplayName(e.target.value)} />
          <textarea className="input" placeholder="Bio" value={bio} onChange={e => setBio(e.target.value)} rows={3} />
          <div className="privacy-control">
            <label className="privacy-label">Profile visibility:</label>
            <select className="input" value={profileVis} onChange={e => setProfileVis(e.target.value)} style={{ width: 'auto' }}>
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
            <span className="muted" style={{ fontSize: '0.8rem' }}>Private profiles limit who can view your profile and posts.</span>
          </div>
          <button className="btn btn-primary" onClick={handleSaveProfile}>Save</button>
          <button className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      )}

      {!isLimited && profile.gamePrefs && profile.gamePrefs.length > 0 && (
        <div className="profile-games">
          <h3>🎮 Games I Play</h3>
          <div className="profile-game-chips">
            {profile.gamePrefs.map((g: any) => (
              <a key={g.game_id} href={`/games/${g.game_slug}`} className="profile-game-chip">
                {g.is_favorite ? '⭐' : ''} {g.game_name}
                {g.platform && <span className="muted" style={{ fontSize: '0.75rem' }}> ({g.platform})</span>}
                {g.looking_for_group ? ' 🔍' : ''}
              </a>
            ))}
          </div>
        </div>
      )}
      {!isLimited && <h3>Posts</h3>}
      {!isLimited && (posts.length === 0 ? <p className="muted">No posts yet.</p> : posts.map(p => <PostCard key={p.id} post={p} currentUser={currentUser} />))}
    </div>
  );
}
