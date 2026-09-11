import GroupPostComposer from '../components/GroupPostComposer';
import { useActionDialog } from '../components/ActionDialog';
import { useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import PostCard from '../components/PostCard';
import { RouteRequestGate, routeFailureState, routeStateForKey, type RouteLoadState } from '../routeLoadState';
import { applyPostEntityMutation, type PostEntityMutation } from '../postEntityState';

export default function GroupPage({ user }: { user: any }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const routeKey = `${id || ''}:${user?.id ?? 'anonymous'}`;
  const currentRouteKey = useRef(routeKey);
  currentRouteKey.current = routeKey;
  const [group, setGroup] = useState<any>(null);
  const [loadState, setLoadState] = useState<RouteLoadState>('loading');
  const [stateRouteKey, setStateRouteKey] = useState(routeKey);
  const requestGate = useRef(new RouteRequestGate());
  const [members, setMembers] = useState<any[]>([]);
  const [posts, setPosts] = useState<any[]>([]);
  const [membershipError, setMembershipError] = useState('');
  const [showMembers, setShowMembers] = useState(false);
  const [transferTargetId, setTransferTargetId] = useState('');
  const [confirmingTransfer, setConfirmingTransfer] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [lifecycleError, setLifecycleError] = useState('');

  const isVerified = user?.is_verified === 1 || user?.isVerified === true;

  const { confirmAction, actionDialog } = useActionDialog(routeKey);

  useEffect(() => {
    setShowMembers(false);
    setMembershipError('');
    setTransferTargetId('');
    setConfirmingTransfer(false);
    setLifecycleError('');
    void loadGroup();
    return () => requestGate.current.invalidate();
  }, [routeKey]);

  const [memberCursor, setMemberCursor] = useState<number | null>(null);
  const [loadingMembers, setLoadingMembers] = useState(false);
  async function loadMoreMembers() {
    if (!memberCursor || loadingMembers) return;
    const isCurrent = requestGate.current.capture();
    setLoadingMembers(true);
    try {
      const response = await api.getGroup(Number(id), memberCursor);
      if (!isCurrent()) return;
      setMembers(previous => [...previous, ...response.members.filter(m => !previous.some(known => known.id === m.id))]);
      setMemberCursor(response.membersPage?.nextCursor ?? null);
    } catch { if (isCurrent()) setMembershipError('Could not load members.'); }
    finally { if (isCurrent()) setLoadingMembers(false); }
  }

  async function loadGroup() {
    const requestedRouteKey = routeKey;
    if (currentRouteKey.current !== requestedRouteKey) return;
    const isCurrent = requestGate.current.begin();
    setStateRouteKey(requestedRouteKey);
    setLoadState('loading');
    setLoadingMembers(false); setMemberCursor(null);
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
      setMemberCursor(r.membersPage?.nextCursor ?? null);
      setLoadState('loaded');
    } catch (error) {
      if (isCurrent()) setLoadState(routeFailureState(error));
    }
  }

  function handlePostMutation(mutation: PostEntityMutation) {
    setPosts(previous => applyPostEntityMutation(previous, mutation));
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

  const isMember = group.memberRole !== undefined ? group.memberRole !== null : members.some((m: any) => m.id === user.id);
  const isOwner = group.owner_id === user.id;
  const isSiteAdmin = user.role === 'admin';
  const canManage = isOwner || isSiteAdmin || group.memberRole === 'admin' ||
    members.some((m: any) => m.id === user.id && m.role === 'admin');
  const canResolveOwnership = isOwner || isSiteAdmin;
  const eligibleTransferMembers = members.filter((member: any) => member.id !== group.owner_id);
  const transferTarget = eligibleTransferMembers.find((member: any) => String(member.id) === transferTargetId);

  async function handleTransferOwnership() {
    if (!transferTarget || transferring) return;
    setTransferring(true); setLifecycleError('');
    try {
      await api.transferGroupOwnership(Number(id), transferTarget.id);
      setTransferTargetId(''); setConfirmingTransfer(false);
      await loadGroup();
    } catch (e: any) {
      setLifecycleError(e.message || 'Could not transfer ownership.');
    } finally { setTransferring(false); }
  }

  function handleDeleteGroup() {
    confirmAction({ title: 'Delete group', confirmLabel: 'Delete group permanently', confirmationText: group.name,
      description: 'Deleting this group permanently removes all posts published in it, including posts by other members, plus their comments, reposts, reactions, notifications, and media links. This cannot be undone.' }, async () => {
      await api.deleteGroup(Number(id));
      navigate('/groups', { replace: true });
    });
  }

  async function handleOwnerLeaveAttempt() {
    setMembershipError('');
    try { await api.leaveGroup(Number(id)); }
    catch (e: any) { setMembershipError(e.message || 'Transfer ownership before leaving, or delete the group.'); }
  }

  async function handleJoin() {
    setMembershipError('');
    try { await api.joinGroup(Number(id)); await loadGroup(); }
    catch (e: any) { setMembershipError(e.message || 'Could not join.'); }
  }

  async function handleLeave() {
    return confirmAction({ title: "Leave group", description: 'Leave this group?' }, async () => {
    setMembershipError('');
    try { await api.leaveGroup(Number(id)); await loadGroup(); }
    catch (e: any) { setMembershipError(e.message || 'Could not leave.');  throw e; }
  });
  }

  async function handleRemoveMember(memberId: number, displayName: string) {
    return confirmAction({ title: "Remove member", description: `Remove ${displayName} from this group?` }, async () => {
    try { await api.removeGroupMember(Number(id), memberId); await loadGroup(); }
    catch (e: any) { setMembershipError(e.message || 'Could not remove member.');  throw e; }
  });
  }

  return (
    <div className="group-page">
      {actionDialog}
      <Link to="/groups" className="btn-ghost back-link">← Groups</Link>

      {/* Group header */}
      <div className="group-detail-header">
        <div className="group-detail-info">
          <h2 className="group-detail-name">{group.name}</h2>
          <span className="group-member-badge">Public group</span>
          {group.description && <p className="group-detail-desc">{group.description}</p>}
          <div className="group-detail-meta">
            <span>{group.memberCount} {group.memberCount === 1 ? 'member' : 'members'}</span>
            <span className="group-detail-owner">Owner: @{group.owner_username || group.owner_name}</span>
            {isMember && <span className="group-member-badge">Joined</span>}
          </div>
        </div>
        <div className="group-detail-actions">
          {isOwner ? (
            <div>
              <span className="group-owner-label">You own this group</span>
              <button className="btn btn-sm btn-ghost" onClick={handleOwnerLeaveAttempt}>Leave group</button>
            </div>
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
      {membershipError && <p className="error-msg" role="alert">{membershipError}</p>}
      {canResolveOwnership && (
        <section className="card" aria-labelledby="group-ownership-heading" style={{ marginBottom: 16 }}>
          <h3 id="group-ownership-heading">Ownership and deletion</h3>
          {isOwner && <p className="muted">Transfer ownership before leaving, or permanently delete this group.</p>}
          {lifecycleError && <p className="error-msg" role="alert">{lifecycleError}</p>}

          {eligibleTransferMembers.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <label htmlFor="group-owner-target"><strong>Transfer ownership</strong></label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                <select id="group-owner-target" className="input" value={transferTargetId}
                  onChange={event => { setTransferTargetId(event.target.value); setConfirmingTransfer(false); }}
                  disabled={transferring}>
                  <option value="">Choose a current member</option>
                  {eligibleTransferMembers.map((member: any) => (
                    <option key={member.id} value={member.id}>{member.display_name} (@{member.username})</option>
                  ))}
                </select>
                {!confirmingTransfer ? (
                  <button className="btn btn-sm" type="button" disabled={!transferTargetId || transferring}
                    onClick={() => setConfirmingTransfer(true)}>Review transfer</button>
                ) : (
                  <button className="btn btn-sm btn-primary" type="button" disabled={!transferTarget || transferring}
                    onClick={handleTransferOwnership}>
                    {transferring ? 'Transferring…' : `Transfer to ${transferTarget?.display_name}`}
                  </button>
                )}
              </div>
              {confirmingTransfer && transferTarget && (
                <p className="muted">{transferTarget.display_name} will become the owner. The previous owner remains a group admin.</p>
              )}
            </div>
          )}
          {eligibleTransferMembers.length === 0 && isOwner && (
            <p className="muted">This group has no other eligible member. Deletion is the available cleanup path.</p>
          )}

          <button className="btn btn-sm btn-danger" type="button" onClick={handleDeleteGroup}>Delete group…</button>
        </section>
      )}
      {!isVerified && !isMember && (
        <p className="muted" style={{ fontSize: '0.85rem', marginBottom: 12 }}>Account verification required to join and post.</p>
      )}

      {/* Post composer — members only */}
      {isMember && isVerified && (
        <GroupPostComposer key={routeKey} groupId={Number(id)} onCreated={loadGroup} />
      )}

      {/* Members section */}
      <div className="group-members-section">
        <button className="group-members-toggle btn-ghost" onClick={() => setShowMembers(!showMembers)}>
          {showMembers ? '▾' : '▸'} Members ({group.memberCount ?? members.length})
        </button>
        {showMembers && (
          <div className="group-members-list">
            {memberCursor && <button className="btn btn-ghost" disabled={loadingMembers} onClick={() => void loadMoreMembers()}>Load more members</button>}
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
          : posts.map(p => <PostCard key={p.id} post={p} currentUser={user} onMutation={handlePostMutation} />)
        }
      </div>
    </div>
  );
}
