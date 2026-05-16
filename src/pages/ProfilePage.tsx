import { useState, useEffect, useRef } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import PostCard from '../components/PostCard';

const IMAGE_UPLOAD_ERROR = 'SVG uploads are not supported. Please use JPG, PNG, GIF, or WebP.';
const SUPPORTED_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const PLATFORM_OPTIONS = ['PC', 'Xbox', 'PlayStation', 'Switch', 'Mobile', 'Crossplay', 'Tabletop', 'Other'];
const PLAY_STYLE_OPTIONS = ['Casual', 'Competitive', 'PvE', 'PvP', 'Co-op', 'Roleplay', 'Modded', 'Hardcore', 'Other'];
const MIC_OPTIONS = ['Mic preferred', 'Mic required', 'No mic needed'];

const emptyGameForm = {
  slug: '',
  gameName: '',
  platform: 'PC',
  playStyle: 'Casual',
  micPreference: 'Mic preferred',
  usualPlayTimes: '',
  regionOrTimezone: '',
  lookingForGroup: false,
  isFavorite: false,
  displayOnProfile: true,
  notes: '',
};

export default function ProfilePage({ user: currentUser }: { user: any }) {
  const { username } = useParams<{ username: string }>();
  const navigate = useNavigate();
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
  const [editingGameSlug, setEditingGameSlug] = useState<string | null>(null);
  const [gameForm, setGameForm] = useState(emptyGameForm);
  const [gameMessage, setGameMessage] = useState('');
  const gameDiscoveryEnabled =
    currentUser?.game_discovery_enabled === 1 ||
    currentUser?.gameDiscoveryEnabled === true;

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
      await fetch(`/api/users/${profile.id}/mute`, { method: 'POST', credentials: 'include' });
      alert('User muted.');
    } catch (e: any) { alert(e.message || 'Failed'); }
  }

  async function handleMessage() {
    try {
      const r = await api.startConversation(profile.id);
      navigate(`/messages/${r.conversationId}`);
    } catch (e: any) {
      alert(e.message || 'Cannot start a conversation with this user.');
    }
  }

  async function handleBlock() {
    if (!confirm(`Block @${profile.username}? They will not be able to interact with you, and you will stop seeing their posts.`)) return;
    try {
      await fetch(`/api/users/${profile.id}/block`, { method: 'POST', credentials: 'include' });
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
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!SUPPORTED_IMAGE_EXTENSIONS.includes(ext || '')) { alert(IMAGE_UPLOAD_ERROR); if (avatarInputRef.current) avatarInputRef.current.value = ''; return; }
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

  function resetGameForm() {
    setShowGamePicker(false);
    setEditingGameSlug(null);
    setGameSearch('');
    setGameResults([]);
    setGameForm(emptyGameForm);
  }

  function startAddGame() {
    setGameMessage('');
    setEditingGameSlug(null);
    setGameForm(emptyGameForm);
    setGameSearch('');
    setGameResults([]);
    setShowGamePicker(true);
  }

  function selectGame(game: any) {
    setGameForm({ ...emptyGameForm, slug: game.slug, gameName: game.name });
    setGameSearch(game.name);
    setGameResults([]);
  }

  function startEditGame(game: any) {
    setGameMessage('');
    setShowGamePicker(true);
    setEditingGameSlug(game.game_slug);
    setGameSearch(game.game_name);
    setGameResults([]);
    setGameForm({
      slug: game.game_slug,
      gameName: game.game_name,
      platform: game.platform || 'PC',
      playStyle: game.play_style || 'Casual',
      micPreference: game.mic_preference || 'Mic preferred',
      usualPlayTimes: game.usual_play_times || '',
      regionOrTimezone: game.region_or_timezone || '',
      lookingForGroup: !!game.looking_for_group,
      isFavorite: !!game.is_favorite,
      displayOnProfile: game.display_on_profile !== 0,
      notes: game.notes || '',
    });
  }

  async function saveGame(e: React.FormEvent) {
    e.preventDefault();
    if (!gameForm.slug) { setGameMessage('Choose a game from the catalog.'); return; }
    try {
      await api.post(`/games/${gameForm.slug}/profile`, {
        platform: gameForm.platform,
        playStyle: gameForm.playStyle,
        micPreference: gameForm.micPreference,
        usualPlayTimes: gameForm.usualPlayTimes,
        regionOrTimezone: gameForm.regionOrTimezone,
        lookingForGroup: gameForm.lookingForGroup,
        isFavorite: gameForm.isFavorite,
        displayOnProfile: gameForm.displayOnProfile,
        notes: gameForm.notes,
      });
      setGameMessage(editingGameSlug ? 'Game entry updated.' : 'Game added.');
      resetGameForm();
      await loadProfile();
    } catch (e: any) { setGameMessage(e.message || 'Could not save game.'); }
  }

  async function removeGame(gameId: number, slug: string) {
    if (!confirm('Remove this game from your profile?')) return;
    try {
      await fetch(`/api/games/${slug}/profile`, { method: 'DELETE', credentials: 'include' });
      setGameMessage('Game removed.');
      await loadProfile();
    } catch (e: any) { setGameMessage(e.message || 'Could not remove game.'); }
  }

  function handleFindPlayers(e: React.MouseEvent, slug: string) {
    if (!gameDiscoveryEnabled) {
      e.preventDefault();
      alert('Turn on Game Discovery in Settings to find players who share your games.');
      return;
    }
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
              <button className="btn btn-ghost btn-sm" onClick={handleMessage}>💬 Message</button>
              <button className="btn btn-ghost btn-sm" onClick={handleMute}>🔇 Mute</button>
              <button className="btn btn-ghost btn-sm" onClick={handleBlock}>🚫 Block</button>
            </>
          )}
          {isOwn && !editing && (
            <>
              <button className="btn btn-ghost" onClick={() => setEditing(true)}>Edit Profile</button>
              <label className="btn btn-ghost" style={{ cursor: 'pointer' }}>
                {avatarUploading ? 'Uploading...' : '📷 Change Avatar'}
                <input type="file" ref={avatarInputRef} accept=".jpg,.jpeg,.png,.gif,.webp,image/jpeg,image/png,image/gif,image/webp" onChange={handleAvatarUpload} style={{ display: 'none' }} />
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

      {!isLimited && (
        <div className="profile-games">
          <div className="profile-games-header">
            <h3>Games I Play</h3>
            {isOwn && !showGamePicker && (
              <button className="btn btn-sm btn-primary" onClick={startAddGame}>Add game</button>
            )}
          </div>
          {gameMessage && <p className="muted profile-game-message">{gameMessage}</p>}

          {isOwn && showGamePicker && (
            <form className="profile-game-editor" onSubmit={saveGame}>
              <div className="profile-game-search">
                <label>
                  Game
                  <input
                    className="input"
                    placeholder="Search games..."
                    value={gameSearch}
                    onChange={e => { setGameSearch(e.target.value); searchGames(e.target.value); if (!editingGameSlug) setGameForm({ ...gameForm, slug: '', gameName: '' }); }}
                  />
                </label>
                {gameResults.length > 0 && (
                  <div className="profile-game-results">
                    {gameResults.map((g: any) => (
                      <button type="button" key={g.id} onClick={() => selectGame(g)}>
                        <strong>{g.name}</strong>
                        {g.platforms && <span>{g.platforms}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="profile-game-form-grid">
                <label>Platform
                  <select className="input" value={gameForm.platform} onChange={e => setGameForm({ ...gameForm, platform: e.target.value })}>
                    {PLATFORM_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </label>
                <label>Play style
                  <select className="input" value={gameForm.playStyle} onChange={e => setGameForm({ ...gameForm, playStyle: e.target.value })}>
                    {PLAY_STYLE_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </label>
                <label>Mic preference
                  <select className="input" value={gameForm.micPreference} onChange={e => setGameForm({ ...gameForm, micPreference: e.target.value })}>
                    {MIC_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </label>
                <label>Usual play times
                  <input className="input" value={gameForm.usualPlayTimes} onChange={e => setGameForm({ ...gameForm, usualPlayTimes: e.target.value })} placeholder="Evenings, weekends..." />
                </label>
                <label>Region/timezone
                  <input className="input" value={gameForm.regionOrTimezone} onChange={e => setGameForm({ ...gameForm, regionOrTimezone: e.target.value })} placeholder="US Central, EU..." />
                </label>
              </div>

              <div className="profile-game-toggles">
                <label><input type="checkbox" checked={gameForm.lookingForGroup} onChange={e => setGameForm({ ...gameForm, lookingForGroup: e.target.checked })} /> Looking for group</label>
                <label><input type="checkbox" checked={gameForm.isFavorite} onChange={e => setGameForm({ ...gameForm, isFavorite: e.target.checked })} /> Favorite</label>
                <label><input type="checkbox" checked={gameForm.displayOnProfile} onChange={e => setGameForm({ ...gameForm, displayOnProfile: e.target.checked })} /> Show on profile</label>
              </div>

              <label>Notes
                <textarea className="input" rows={3} value={gameForm.notes} onChange={e => setGameForm({ ...gameForm, notes: e.target.value })} placeholder="Optional notes about how you play." />
              </label>

              <div className="profile-game-actions">
                <button className="btn btn-primary" type="submit">{editingGameSlug ? 'Save changes' : 'Add game'}</button>
                <button className="btn btn-ghost" type="button" onClick={resetGameForm}>Cancel</button>
              </div>
            </form>
          )}

          {profile.gamePrefs && profile.gamePrefs.length > 0 ? (
            <div className="profile-game-cards">
              {profile.gamePrefs.map((g: any) => (
                <div key={g.game_id} className={`profile-game-card ${g.is_favorite ? 'favorite' : ''}`}>
                  <div className="profile-game-card-main">
                    <Link to={`/games/${g.game_slug}`} className="profile-game-title">
                      {g.game_name}
                    </Link>
                    <div className="lfg-tags">
                      {g.is_favorite ? <span className="lfg-tag">Favorite</span> : null}
                      {g.shared_game && !isOwn ? <span className="lfg-tag">Shared game</span> : null}
                      {g.looking_for_group ? <span className="lfg-tag">LFG</span> : null}
                    </div>
                  </div>
                  <div className="profile-game-meta">
                    {g.platform && <span>Platform: {g.platform}</span>}
                    {g.play_style && <span>Style: {g.play_style}</span>}
                    {g.mic_preference && <span>Mic: {g.mic_preference}</span>}
                    {g.usual_play_times && <span>Times: {g.usual_play_times}</span>}
                    {g.region_or_timezone && <span>Region: {g.region_or_timezone}</span>}
                  </div>
                  {g.notes && <p className="profile-game-notes">{g.notes}</p>}
                  <div className="profile-game-actions">
                    <Link className="btn btn-sm btn-ghost" to={`/games/${g.game_slug}?tab=players`} onClick={e => handleFindPlayers(e, g.game_slug)}>
                      {gameDiscoveryEnabled ? 'See players' : 'Find players'}
                    </Link>
                    {isOwn && (
                      <>
                        <button className="btn btn-sm btn-ghost" onClick={() => startEditGame(g)}>Edit</button>
                        <button className="btn btn-sm btn-ghost" onClick={() => removeGame(g.game_id, g.game_slug)}>Remove</button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">{isOwn ? 'Add games to show what you play.' : 'No visible games listed.'}</p>
          )}
        </div>
      )}
      {!isLimited && <h3>Posts</h3>}
      {!isLimited && (posts.length === 0 ? <p className="muted">No posts yet.</p> : posts.map(p => <PostCard key={p.id} post={p} currentUser={currentUser} />))}
    </div>
  );
}
