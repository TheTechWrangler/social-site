import { useActionDialog } from '../components/ActionDialog';
import { useState, useEffect, useRef } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import PostCard from '../components/PostCard';
import { RouteRequestGate, routeFailureState, routeStateForKey, type RouteLoadState } from '../routeLoadState';
import { applyPostEntityMutation, type PostEntityMutation } from '../postEntityState';
import type { CanonicalProfileDto } from '../../shared/profile';

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

const emptySectionForm = {
  techInterests: '',
  platforms: '',
  lookingFor: '',
  currentProjects: '',
  favoriteGenres: '',
  websiteUrl: '',
};

type SectionForm = typeof emptySectionForm;

function ProfileSectionCards({ data }: { data: any }) {
  if (!data) return null;
  const entries: Array<{ label: string; key: keyof SectionForm; isUrl?: boolean }> = [
    { label: 'Tech', key: 'techInterests' },
    { label: 'Platforms', key: 'platforms' },
    { label: 'Looking for', key: 'lookingFor' },
    { label: 'Current projects', key: 'currentProjects' },
    { label: 'Fav genres', key: 'favoriteGenres' },
    { label: 'Website', key: 'websiteUrl', isUrl: true },
  ];
  const visible = entries.filter(e => data[e.key] && data[e.key].trim());
  if (visible.length === 0) return null;
  return (
    <div className="profile-sections">
      {visible.map(({ label, key, isUrl }) => (
        <div key={key} className="profile-section-card">
          <span className="profile-section-label">{label}</span>
          {isUrl ? (
            <a
              href={data[key]}
              target="_blank"
              rel="noopener noreferrer"
              className="profile-section-link"
            >
              {data[key].replace(/^https?:\/\//, '')}
            </a>
          ) : (
            <span className="profile-section-value">{data[key]}</span>
          )}
        </div>
      ))}
    </div>
  );
}

export default function ProfilePage({
  user: currentUser,
  onUserChange,
}: {
  user: any;
  onUserChange: (user: any) => void;
}) {
  const { username } = useParams<{ username: string }>();
  const navigate = useNavigate();
  const routeKey = `${username || ''}:${currentUser?.id ?? 'anonymous'}`;
  const currentRouteKey = useRef(routeKey);
  currentRouteKey.current = routeKey;
  const [profile, setProfile] = useState<CanonicalProfileDto | null>(null);
  const [posts, setPosts] = useState<any[]>([]);
  const [loadState, setLoadState] = useState<RouteLoadState>('loading');
  const [stateRouteKey, setStateRouteKey] = useState(routeKey);
  const [postsLoadState, setPostsLoadState] = useState<RouteLoadState | 'idle'>('idle');
  const requestGate = useRef(new RouteRequestGate());
  const mutationGate = useRef(new RouteRequestGate());
  const gameSearchGate = useRef(new RouteRequestGate());
  const [editing, setEditing] = useState(false);
  const [bio, setBio] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [profileVis, setProfileVis] = useState('public');
  const [sectionForm, setSectionForm] = useState<SectionForm>(emptySectionForm);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [showGamePicker, setShowGamePicker] = useState(false);
  const [gameSearch, setGameSearch] = useState('');
  const [gameResults, setGameResults] = useState<any[]>([]);
  const [editingGameSlug, setEditingGameSlug] = useState<string | null>(null);
  const [gameForm, setGameForm] = useState(emptyGameForm);
  const [gameMessage, setGameMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const [pendingProfileAction, setPendingProfileAction] = useState<string | null>(null);
  const gameDiscoveryEnabled =
    currentUser?.game_discovery_enabled === 1 ||
    currentUser?.gameDiscoveryEnabled === true;

  const { confirmAction, actionDialog } = useActionDialog(routeKey);

  useEffect(() => {
    void loadProfile();
    return () => {
      requestGate.current.invalidate();
      mutationGate.current.invalidate();
      gameSearchGate.current.invalidate();
    };
  }, [routeKey]);

  function applyCanonicalProfile(nextProfile: CanonicalProfileDto) {
    setProfile(nextProfile);
    setBio(nextProfile.bio || '');
    setDisplayName(nextProfile.displayName || '');
    setProfileVis(nextProfile.profileVisibility || 'public');
    const pd = nextProfile.profileData || {};
    setSectionForm({
      techInterests: pd.techInterests || '',
      platforms: pd.platforms || '',
      lookingFor: pd.lookingFor || '',
      currentProjects: pd.currentProjects || '',
      favoriteGenres: pd.favoriteGenres || '',
      websiteUrl: pd.websiteUrl || '',
    });
  }

  async function loadProfile() {
    const requestedRouteKey = routeKey;
    if (currentRouteKey.current !== requestedRouteKey) return;
    const isCurrent = requestGate.current.begin();
    const requestedUsername = username || '';
    setStateRouteKey(requestedRouteKey);
    setLoadState('loading');
    setPostsLoadState('idle');
    setProfile(null);
    setPosts([]);
    setEditing(false);
    setSaveError('');
    setSaving(false);
    setAvatarUploading(false);
    setActionError('');
    setPendingProfileAction(null);
    if (!username) {
      if (isCurrent()) setLoadState('unavailable');
      return;
    }

    let loadedProfile: CanonicalProfileDto;
    try {
      const response = await api.getUser(username);
      if (!isCurrent()) return;
      loadedProfile = response.user;
      applyCanonicalProfile(loadedProfile);
      setLoadState('loaded');
    } catch (error) {
      if (isCurrent()) setLoadState(routeFailureState(error));
      return;
    }

    if (loadedProfile.limited) {
      if (isCurrent()) setPostsLoadState('loaded');
      return;
    }
    setPostsLoadState('loading');
    try {
      const response = await api.getUserPosts(username);
      if (!isCurrent()) return;
      setPosts(response.posts || []);
      setPostsLoadState('loaded');
    } catch (error) {
      if (!isCurrent()) return;
      setPosts([]);
      setPostsLoadState(routeFailureState(error));
    }
  }

  async function handleFollow() {
    if (!profile || pendingProfileAction) return;
    setPendingProfileAction('follow');
    setActionError('');
    try {
      const relationshipStatus = profile.followStatus || (profile.isFollowing ? 'accepted' : 'none');
      await (relationshipStatus === 'none' ? api.follow(profile.id) : api.unfollow(profile.id));
      await loadProfile();
    } catch (e: any) {
      console.error(e);
      setActionError(e.message || 'Could not update follow status.');
    } finally {
      setPendingProfileAction(null);
    }
  }

  async function handleMute() {
    if (!profile || pendingProfileAction) return;
    return confirmAction({ title: "Mute user", description: `Mute @${profile.username}? You will stop seeing their posts.` }, async () => {
    setPendingProfileAction('mute');
    setActionError('');
    try {
      await api.post(`/users/${profile.id}/mute`);
      setActionNotice('User muted.');
    } catch (e: any) {
      setActionError(e.message || 'Could not mute user.');
     throw e; } finally {
      setPendingProfileAction(null);
    }
  });
  }

  async function handleMessage() {
    if (!profile) return;
    try {
      const r = await api.startConversation(profile.id);
      navigate(`/messages/${r.conversationId}`);
    } catch (e: any) {
      setActionError(e.message || 'Cannot start a conversation with this user.');
    }
  }

  async function handleBlock() {
    if (!profile || pendingProfileAction) return;
    return confirmAction({ title: "Block user", description: `Block @${profile.username}? They will not be able to interact with you, and you will stop seeing their posts.` }, async () => {
    setPendingProfileAction('block');
    setActionError('');
    try {
      await api.post(`/users/${profile.id}/block`);
      window.location.reload();
    } catch (e: any) {
      setActionError(e.message || 'Could not block user.');
     throw e; } finally {
      setPendingProfileAction(null);
    }
  });
  }

  async function handleSaveProfile() {
    const isCurrent = mutationGate.current.begin();
    setSaveError('');
    setSaving(true);
    try {
      const r = await api.updateProfile({ displayName, bio, profileVisibility: profileVis, profileData: sectionForm });
      if (!isCurrent()) return;
      applyCanonicalProfile(r.user);
      onUserChange(r.authUser);
      setEditing(false);
    } catch (e: any) {
      if (isCurrent()) setSaveError(e.message || 'Could not save profile.');
    } finally {
      if (isCurrent()) setSaving(false);
    }
  }

  async function handleAvatarReset() {
    const isCurrent = mutationGate.current.begin();
    setSaveError('');
    setAvatarUploading(true);
    try {
      const r = await api.updateProfile({ avatar_url: '' });
      if (!isCurrent()) return;
      applyCanonicalProfile(r.user);
      onUserChange(r.authUser);
    } catch (e: any) {
      if (isCurrent()) setSaveError(e.message || 'Could not remove avatar.');
    } finally {
      if (isCurrent()) setAvatarUploading(false);
    }
  }

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!SUPPORTED_IMAGE_EXTENSIONS.includes(ext || '')) { setActionError(IMAGE_UPLOAD_ERROR); if (avatarInputRef.current) avatarInputRef.current.value = ''; return; }
    if (file.size > 2 * 1024 * 1024) { setActionError('Avatar must be under 2MB.'); return; }
    const isCurrent = mutationGate.current.begin();
    setAvatarUploading(true);
    try {
      const r = await api.uploadAvatar(file);
      if (!isCurrent()) return;
      setProfile(previous => {
        if (!previous || previous.username !== username) return previous;
        return { ...previous, avatarUrl: r.media.url };
      });
    } catch (e: any) {
      if (isCurrent()) setActionError(e.message || 'Avatar upload failed');
    }
    if (isCurrent()) setAvatarUploading(false);
  }

  async function searchGames(q: string) {
    const requestedRouteKey = routeKey;
    const isCurrent = gameSearchGate.current.begin();
    if (q.length < 1) { setGameResults([]); return; }
    try {
      const response = await api.get<any>(`/games?q=${encodeURIComponent(q)}`);
      if (isCurrent() && currentRouteKey.current === requestedRouteKey) setGameResults(response.games || []);
    } catch (e) { /* search suggestions are optional */ }
  }

  function resetGameForm() {
    setShowGamePicker(false);
    setEditingGameSlug(null);
    setGameSearch('');
    gameSearchGate.current.invalidate();
    setGameResults([]);
    setGameForm(emptyGameForm);
  }

  function startAddGame() {
    gameSearchGate.current.invalidate();
    setGameMessage('');
    setEditingGameSlug(null);
    setGameForm(emptyGameForm);
    setGameSearch('');
    setGameResults([]);
    setShowGamePicker(true);
  }

  function selectGame(game: any) {
    gameSearchGate.current.invalidate();
    setGameForm({ ...emptyGameForm, slug: game.slug, gameName: game.name });
    setGameSearch(game.name);
    setGameResults([]);
  }

  function startEditGame(game: any) {
    gameSearchGate.current.invalidate();
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
    return confirmAction({ title: "Remove game", description: 'Remove this game from your profile?' }, async () => {
    try {
      await api.delete(`/games/${slug}/profile`);
      setGameMessage('Game removed.');
      await loadProfile();
    } catch (e: any) { setGameMessage(e.message || 'Could not remove game.');  throw e; }
  });
  }

  function handleFindPlayers(e: React.MouseEvent, slug: string) {
    if (!gameDiscoveryEnabled) {
      e.preventDefault();
      setActionNotice('Turn on Game Discovery in Settings to find players who share your games.');
      return;
    }
  }

  function handlePostMutation(mutation: PostEntityMutation) {
    setPosts(previous => {
      let next = applyPostEntityMutation(previous, mutation);
      if (mutation.type === 'repost' && profile?.id === currentUser.id && !next.some(post => post.id === mutation.repost.id)) {
        next = [mutation.repost, ...next];
      }
      return next;
    });
  }

  const visibleLoadState = routeStateForKey(routeKey, stateRouteKey, loadState);
  if (visibleLoadState === 'loading') {
    return <div className="loading">Loading...</div>;
  }
  if (visibleLoadState === 'unavailable') return (
    <div className="profile-page">
      <p className="muted">This profile is not available.</p>
    </div>
  );
  if (visibleLoadState === 'error') return (
    <div className="profile-page">
      <p className="error-msg" role="alert">Could not load this profile.</p>
      <button className="btn btn-ghost" onClick={() => void loadProfile()}>Try again</button>
    </div>
  );
  if (!profile) return null;
  const isOwn = currentUser?.id === profile.id;
  const isLimited = !!profile.limited;

  return (
    <div className="profile-page">
      {actionDialog}
      {/* ─── Profile Header ─── */}
      <div className="profile-header">
        <div className="profile-avatar-wrap">
          {profile.avatarUrl ? (
            <img src={profile.avatarUrl} alt="" className="avatar-img xlarge" />
          ) : (
            <div className="avatar-placeholder xlarge">{profile.displayName?.[0] || '?'}</div>
          )}
          {isOwn && !editing && (
            <label className="avatar-change-btn" title="Change avatar">
              📷
              <input
                type="file"
                ref={avatarInputRef}
                accept=".jpg,.jpeg,.png,.gif,.webp,image/jpeg,image/png,image/gif,image/webp"
                onChange={handleAvatarUpload}
                style={{ display: 'none' }}
              />
            </label>
          )}
          {avatarUploading && <span className="avatar-uploading">Uploading…</span>}
        </div>

        <div className="profile-header-info">
          <div className="profile-name-row">
            <h2 className="profile-display-name">{profile.displayName}</h2>
            {profile.isVerified && <span className="verified-badge" title="Verified member">✓</span>}
          </div>
          <p className="muted profile-username">@{profile.username}</p>

          {isLimited && !isOwn && (
            <div className="verify-banner" style={{ marginTop: 8 }}>
              🔒 {profile.followStatus === 'pending'
                ? 'Follow request pending. Access begins only if the owner accepts it.'
                : 'This profile is private. You can request access by following.'}
            </div>
          )}

          {(!isLimited || isOwn) && profile.bio && (
            <p className="profile-bio">{profile.bio}</p>
          )}

          {(!isLimited || isOwn) && (
            <div className="profile-stats">
              <span><strong>{profile.postCount}</strong> posts</span>
              <span><strong>{profile.followerCount}</strong> followers</span>
              <span><strong>{profile.followingCount}</strong> following</span>
            </div>
          )}

          <div className="profile-actions">
            {!isOwn && currentUser && (
              <>
                <button className={`btn ${profile.isFollowing ? 'btn-ghost' : 'btn-primary'}`} onClick={handleFollow} disabled={pendingProfileAction === 'follow'}>
                  {profile.followStatus === 'pending' ? 'Pending — cancel' : profile.isFollowing ? 'Following' : 'Follow'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={handleMessage}>💬 Message</button>
                <button className="btn btn-ghost btn-sm" onClick={handleMute} disabled={pendingProfileAction === 'mute'}>🔇 Mute</button>
                <button className="btn btn-ghost btn-sm" onClick={handleBlock} disabled={pendingProfileAction === 'block'}>🚫 Block</button>
              </>
            )}
            {isOwn && !editing && (
              <button className="btn btn-ghost" onClick={() => setEditing(true)}>Edit Profile</button>
            )}
          </div>
        </div>
      </div>
      {actionError && <p className="error-msg" role="alert">{actionError}</p>}
      {actionNotice && <p className="muted" role="status">{actionNotice}</p>}

      {/* ─── Structured sections (read view) ─── */}
      {(!isLimited || isOwn) && !editing && (
        <ProfileSectionCards data={profile.profileData} />
      )}

      {/* ─── Edit Form ─── */}
      {editing && (
        <div className="edit-profile">
          <h3 style={{ margin: '0 0 4px' }}>Edit Profile</h3>

          <input
            className="input"
            placeholder="Display Name"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            maxLength={80}
          />
          <textarea
            className="input"
            placeholder="Bio (up to 500 characters)"
            value={bio}
            onChange={e => setBio(e.target.value)}
            rows={3}
          />
          <div className="privacy-control">
            <label className="privacy-label">Profile visibility:</label>
            <select className="input" value={profileVis} onChange={e => setProfileVis(e.target.value)} style={{ width: 'auto' }}>
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
            <span className="muted" style={{ fontSize: '0.8rem' }}>
              {profileVis === 'private'
                ? 'Private: people request to follow; you approve new followers. Accepted followers can view follower-gated profile details and posts. Posts in public groups, comments in accessible public threads, and active LFG listings remain public. Blocking is separate, and privacy changes cannot recall copies already seen or downloaded.'
                : 'Public: anyone can view your profile and profile posts. Blocking still hides your account from specific people.'}
            </span>
          </div>

          <p className="profile-sections-heading">Profile Sections <span className="muted">(optional — shown on your profile)</span></p>
          <div className="profile-sections-edit-grid">
            <label className="profile-section-field">
              <span>Tech interests</span>
              <input
                className="input"
                placeholder="e.g. Python, Linux, TypeScript, self-hosting"
                value={sectionForm.techInterests}
                onChange={e => setSectionForm({ ...sectionForm, techInterests: e.target.value })}
                maxLength={200}
              />
            </label>
            <label className="profile-section-field">
              <span>Platforms</span>
              <input
                className="input"
                placeholder="e.g. PC, Xbox, PS5, Linux"
                value={sectionForm.platforms}
                onChange={e => setSectionForm({ ...sectionForm, platforms: e.target.value })}
                maxLength={100}
              />
            </label>
            <label className="profile-section-field">
              <span>Looking for</span>
              <input
                className="input"
                placeholder="e.g. gaming buddies, collaborators, chill conversation"
                value={sectionForm.lookingFor}
                onChange={e => setSectionForm({ ...sectionForm, lookingFor: e.target.value })}
                maxLength={200}
              />
            </label>
            <label className="profile-section-field">
              <span>Current projects</span>
              <input
                className="input"
                placeholder="e.g. building a home server, working on an indie game"
                value={sectionForm.currentProjects}
                onChange={e => setSectionForm({ ...sectionForm, currentProjects: e.target.value })}
                maxLength={300}
              />
            </label>
            <label className="profile-section-field">
              <span>Favorite genres</span>
              <input
                className="input"
                placeholder="e.g. RPG, Strategy, Survival, Horror"
                value={sectionForm.favoriteGenres}
                onChange={e => setSectionForm({ ...sectionForm, favoriteGenres: e.target.value })}
                maxLength={150}
              />
            </label>
            <label className="profile-section-field">
              <span>Website</span>
              <input
                className="input"
                placeholder="https://your-site.com"
                value={sectionForm.websiteUrl}
                onChange={e => setSectionForm({ ...sectionForm, websiteUrl: e.target.value })}
                maxLength={200}
                type="url"
              />
            </label>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="btn btn-primary" onClick={handleSaveProfile} disabled={saving || avatarUploading || !displayName.trim()}>
              {saving ? 'Saving&' : 'Save'}
            </button>
            {profile.avatarUrl && (
              <button className="btn btn-ghost" onClick={handleAvatarReset} disabled={avatarUploading}>
                Remove avatar
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
          </div>
          {saveError && <p className="error-msg" role="alert">{saveError}</p>}
        </div>
      )}

      {/* ─── Games I Play ─── */}
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

      {/* ─── Posts ─── */}
      {!isLimited && <h3>Posts</h3>}
      {!isLimited && postsLoadState === 'loading' && <div className="loading">Loading posts&</div>}
      {!isLimited && (postsLoadState === 'error' || postsLoadState === 'unavailable') && (
        <div>
          <p className="muted">Posts are not available right now.</p>
          <button className="btn btn-ghost" onClick={() => void loadProfile()}>Try again</button>
        </div>
      )}
      {!isLimited && postsLoadState === 'loaded' && (posts.length === 0
        ? <p className="muted">No posts yet.</p>
        : posts.map(p => <PostCard key={p.id} post={p} currentUser={currentUser} onMutation={handlePostMutation} />)
      )}
    </div>
  );
}
