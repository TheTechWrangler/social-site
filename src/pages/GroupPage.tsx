import { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client';
import PostCard from '../components/PostCard';
import { RouteRequestGate, routeFailureState, routeStateForKey, type RouteLoadState } from '../routeLoadState';
import { createClientOperationKey } from '../postComposerSubmission';

export default function GroupPage({ user }: { user: any }) {
  const { id } = useParams<{ id: string }>();
  const routeKey = `${id || ''}:${user?.id ?? 'anonymous'}`;
  const currentRouteKey = useRef(routeKey);
  currentRouteKey.current = routeKey;
  const [group, setGroup] = useState<any>(null);
  const [loadState, setLoadState] = useState<RouteLoadState>('loading');
  const [stateRouteKey, setStateRouteKey] = useState(routeKey);
  const requestGate = useRef(new RouteRequestGate());
  const [members, setMembers] = useState<any[]>([]);
  const [posts, setPosts] = useState<any[]>([]);
  const [content, setContent] = useState('');
  const [posting, setPosting] = useState(false);
  const [postSubmissionKey, setPostSubmissionKey] = useState<string | null>(null);
  const [postError, setPostError] = useState('');
  const [membershipError, setMembershipError] = useState('');
  const [showMembers, setShowMembers] = useState(false);

  const isVerified = user?.is_verified === 1 || user?.isVerified === true;

  useEffect(() => {
    setShowMembers(false);
    setMembershipError('');
    setPostError('');
    setPostSubmissionKey(null);
    void loadGroup();
    return () => requestGate.current.invalidate();
  }, [routeKey]);

  async function loadGroup() {
    const requestedRouteKey = routeKey;
    if (currentRouteKey.current !== requestedRouteKey) return;
    const isCurrent = requestGate.current.begin();
    setStateRouteKey(requestedRouteKey);
    setLoadState('loading');
    setGroup(null);
    setMembers([]);
    setPosts([]);
    const groupId = Number(id);
    if (!Number.isSafeInteger(groupId) || groupId <= 0) {
      if (isCurrent()) setLoadState('unavailable');
      return;
    }
    try {
      const r = await api.getGroup(groupId);
      if (!isCurrent()) return;
      setGroup(r.group); setMembers(r.members); setPosts(r.posts);
      setLoadState('loaded');
    } catch (error) {
      if (isCurrent()) setLoadState(routeFailureState(error));
    }
  }

  const visibleLoadState = routeStateForKey(routeKey, stateRouteKey, loadState);
  if (visibleLoadState === 'loading') {
    return <div className="loading">Loading…</div>;
  }
  if (visibleLoadState === 'unavailable') return (
    <div className="group-page">
      <Link to="/groups" className="btn-ghost">← Groups</Link>
      <p className="muted" style={{ marginTop: 24 }}>This group is not available.</p>
    </div>
  );
  if (visibleLoadState === 'error') return (
    <div className="group-page">
      <Link to="/groups" className="btn-ghost">← Groups</Link>
      <p className="error-msg" role="alert">Could not load this group.</p>
      <button className="btn btn-ghost" onClick={() => void loadGroup()}>Try again</button>
    </div>
  );
  if (!group) return null;

  const isMember = members.some((m: any) => m.id === user.id);
  const isOwner = group.owner_id === user.id;
  const canManage = isOwner || user.role === 'admin' ||
    members.some((m: any) => m.id === user.id && m.role === 'admin');

  async function handleJoin() {
    setMembershipError('');
    try { await api.joinGroup(Number(id)); await loadGroup(); }
    catch (e: any) { setMembershipError(e.message || 'Could not join.'); }
  }

  async function handleLeave() {
    if (!confirm('Leave this group?')) return;
    setMembershipError('');
    try { await api.leaveGroup(Number(id)); await loadGroup(); }
    catch (e: any) { setMembershipError(e.message || 'Could not leave.'); }
  }

  async function handlePost(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    setPosting(true); setPostError('');
    const key = postSubmissionKey ?? createClientOperationKey();
    if (!postSubmissionKey) setPostSubmissionKey(key);
    try {
      await api.createPost(content, Number(id), key);
      setContent(''); setPostSubmissionKey(null);
      await loadGroup();
    }
    catch (e: any) { setPostError(e.message || 'Could not post. Your draft was preserved.'); }
    finally { setPosting(false); }
  }

  async function handleRemoveMember(memberId: number, displayName: string) {
    if (!confirm(`Remove ${displayName} from this group?`)) return;
    try { await api.removeGroupMember(Number(id), memberId); await loadGroup(); }
    catch (e: any) { alert(e.message || 'Could not remove member.'); }
  }

  return (
    <div className="group-page">
      <Link to="/groups" className="btn-ghost back-link">← Groups</Link>

      {/* Group header */}
      <div className="group-detail-header">
        <div className="group-detail-info">
          <h2 className="group-detail-name">{group.name}</h2>
          {group.description && <p className="group-detail-desc">{group.description}</p>}
          <div className="group-detail-meta">
            <span>{group.memberCount} {group.memberCount === 1 ? 'member' : 'members'}</span>
            <span className="group-detail-owner">Owner: @{group.owner_username || group.owner_name}</span>
            {isMember && <span className="group-member-badge">Joined</span>}
          </div>
        </div>
        <div className="group-detail-actions">
          {isOwner ? (
            <span className="group-owner-label">You own this group</span>
          ) : isMember ? (
            <button className="btn btn-sm btn-ghost" onClick={handleLeave}>Leave</button>
          ) : (
            <button className="btn btn-sm btn-primary" onClick={handleJoin}
              disabled={!isVerified} title={!isVerified ? 'Verify your account to join groups' : undefined}>
              Join
            </button>
          )}
        </div>
      </div>
      {membershipError && <p className="error-msg">{membershipError}</p>}
      {!isVerified && !isMember && (
        <p className="muted" style={{ fontSize: '0.85rem', marginBottom: 12 }}>Account verification required to join and post.</p>
      )}

      {/* Post composer — members only */}
      {isMember && isVerified && (
        <form className="post-composer" onSubmit={handlePost}>
          <textarea className="input" placeholder="Post to this group…" value={content}
            onChange={e => { setContent(e.target.value); setPostSubmissionKey(null); }} rows={2} />
          {postError && <p className="error-msg">{postError}</p>}
          <button className="btn btn-primary" disabled={posting || !content.trim()}>
            {posting ? 'Posting…' : 'Post'}
          </button>
        </form>
      )}

      {/* Members section */}
      <div className="group-members-section">
        <button className="group-members-toggle btn-ghost" onClick={() => setShowMembers(!showMembers)}>
          {showMembers ? '▾' : '▸'} Members ({members.length})
        </button>
        {showMembers && (
          <div className="group-members-list">
            {members.map((m: any) => (
              <div key={m.id} className="group-member-row">
                <div className="group-member-info">
                  {m.avatar_url
                    ? <img src={m.avatar_url} alt="" className="avatar-img" style={{ width: 28, height: 28 }} />
                    : <span className="avatar-placeholder" style={{ width: 28, height: 28, fontSize: '0.8rem' }}>{m.display_name?.[0] || '?'}</span>
                  }
                  <Link to={`/profile/${m.username}`} className="group-member-name">
                    <strong>{m.display_name}</strong> <span className="muted">@{m.username}</span>
                  </Link>
                  {m.id === group.owner_id && <span className="group-role-badge role-owner">Owner</span>}
                  {m.id !== group.owner_id && m.role === 'admin' && <span className="group-role-badge role-admin">Admin</span>}
                  {m.role === 'mod' && <span className="group-role-badge role-mod">Mod</span>}
                </div>
                {canManage && m.id !== group.owner_id && m.id !== user.id && (
                  <button className="btn btn-sm btn-ghost group-remove-btn"
                    onClick={() => handleRemoveMember(m.id, m.display_name)}>
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Posts */}
      <div className="group-posts-section">
        <h3 className="group-posts-heading">Posts</h3>
        {posts.length === 0
          ? <p className="muted">No posts yet.{isMember ? ' Be the first to post!' : ''}</p>
          : posts.map(p => <PostCard key={p.id} post={p} currentUser={user} />)
        }
      </div>
    </div>
  );
}
