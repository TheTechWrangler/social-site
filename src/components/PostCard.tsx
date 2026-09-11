import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { RouteRequestGate } from '../routeLoadState';
import type { PostEntityMutation } from '../postEntityState';
import {
  EMPTY_POST_EDIT,
  beginPostEdit,
  failPostEditSave,
  startPostEditSave,
  updatePostEditDraft,
  reviewLatestPost,
} from '../postEditState';

const REACTIONS = ['like', 'love', 'laugh', 'wow', 'support', 'thoughtful'];
const EMOJI: Record<string, string> = { like: '👍', love: '❤️', laugh: '😂', wow: '😮', support: '🙌', thoughtful: '🤔' };
const LABELS: Record<string, string> = { like: 'Like', love: 'Love', laugh: 'Laugh', wow: 'Wow', support: 'Support', thoughtful: 'Think' };
const REPORT_ERROR = 'Please select a reason and briefly explain the problem.';

export default function PostCard({ post, currentUser, onMutation }: { post: any; currentUser: any; onMutation: (mutation: PostEntityMutation) => void }) {
  const [showComments, setShowComments] = useState(false);
  const comments: any[] = post.comments || [];
  const [commentText, setCommentText] = useState('');
  const [media, setMedia] = useState<any[]>([]);
  const [showReactions, setShowReactions] = useState(false);
  const [showRepostConfirm, setShowRepostConfirm] = useState(false);
  const [reposting, setReposting] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportTarget, setReportTarget] = useState<any>(null);
  const [reportTargetType, setReportTargetType] = useState<'post' | 'comment'>('post');
  const [reportReason, setReportReason] = useState('Spam');
  const [reportDetails, setReportDetails] = useState('');
  const [reportSubmitted, setReportSubmitted] = useState(false);
  const [reportError, setReportError] = useState('');
  const [mutationError, setMutationError] = useState('');
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [editState, setEditState] = useState(EMPTY_POST_EDIT);
  const editSubmission = useRef(false);
  const entityId = useRef(post.id);
  entityId.current = post.id;
  const scopeKey = (currentUser?.id ?? 'anonymous') + ':' + post.id;
  const currentScopeKey = useRef(scopeKey);
  currentScopeKey.current = scopeKey;
  const mediaGate = useRef(new RouteRequestGate());
  const commentGate = useRef(new RouteRequestGate());
  const mutationGate = useRef(new RouteRequestGate());

  const isVerified = currentUser?.is_verified ?? currentUser?.isVerified;
  const isPrivateProfile = (currentUser?.profile_visibility || currentUser?.profileVisibility) === 'private';
  const reactions = post.reactions || {};
  const totalReactions = Object.values(reactions).reduce((a: number, b: any) => a + (b || 0), 0);

  useEffect(() => {
    setMedia([]);
    setShowComments(false);
    setCommentText('');
    setMutationError('');
    setPendingAction(null);
    setCommentSubmitting(false);
    setReportSubmitting(false);
    setReposting(false);
    setEditState(EMPTY_POST_EDIT);
    editSubmission.current = false;
    mediaGate.current.invalidate();
    commentGate.current.invalidate();
    mutationGate.current.invalidate();
    void loadMedia(post.id);
    return () => {
      mediaGate.current.invalidate();
      commentGate.current.invalidate();
      mutationGate.current.invalidate();
    };
  }, [scopeKey]);

  useEffect(() => {
    if (showComments) void refreshComments(post.id);
  }, [post.commentCount]);

  async function loadMedia(postId: number) {
    const isCurrent = mediaGate.current.begin();
    try {
      const r = await api.getPostMedia(postId);
      if (isCurrent() && entityId.current === postId) setMedia(r.media || []);
    } catch (e) { /* no media */ }
  }

  async function handleReaction(type: string) {
    if (!isVerified) { alert('Account verification required before you can react.'); return; }
    if (pendingAction) return;
    const requestScope = scopeKey;
    const isCurrent = mutationGate.current.capture();
    setPendingAction('reaction');
    setMutationError('');
    try {
      // If same reaction, remove it
      if (post.userReaction === type) {
        const r: any = await api.unlike(post.id);
        if (!isCurrent() || currentScopeKey.current !== requestScope) return;
        onMutation({ type: 'update', post: { id: post.id, userReaction: null, liked: false, reactions: r.counts || {} } });
      } else {
        const r = await api.react(post.id, type);
        if (!isCurrent() || currentScopeKey.current !== requestScope) return;
        onMutation({ type: 'update', post: { id: post.id, userReaction: type, liked: true, reactions: r.counts } });
      }
      setShowReactions(false);
    } catch (e: any) {
      if (isCurrent() && currentScopeKey.current === requestScope) {
        console.error(e);
        setMutationError(e.message || 'Could not update reaction.');
      }
    } finally {
      if (isCurrent() && currentScopeKey.current === requestScope) setPendingAction(null);
    }
  }

  async function handleRepost() {
    setShowRepostConfirm(true);
  }

  async function confirmRepost() {
    const requestScope = scopeKey;
    const isCurrent = mutationGate.current.capture();
    setReposting(true);
    try {
      const result = await api.repost(post.id);
      if (!isCurrent() || currentScopeKey.current !== requestScope) return;
      onMutation({ type: 'repost', postId: post.id, repost: result.post });
      setShowRepostConfirm(false);
    } catch (e) {
      if (isCurrent() && currentScopeKey.current === requestScope) { console.error(e); alert('Repost failed'); }
    } finally {
      if (isCurrent() && currentScopeKey.current === requestScope) setReposting(false);
    }
  }

  async function refreshComments(postId: number) {
    const requestScope = scopeKey;
    const isCurrent = commentGate.current.begin();
    try {
      const response = await api.getComments(postId);
      if (isCurrent() && currentScopeKey.current === requestScope) {
        onMutation({ type: 'comments-loaded', postId, comments: response.comments });
      }
    } catch (e) { console.error(e); }
  }

  function loadComments() {
    const opening = !showComments;
    setShowComments(opening);
    if (opening && comments.length === 0) void refreshComments(post.id);
  }

  async function addComment(e: React.FormEvent) {
    e.preventDefault();
    if (!commentText.trim() || commentSubmitting) return;
    const requestScope = scopeKey;
    const isCurrent = mutationGate.current.capture();
    setCommentSubmitting(true);
    setMutationError('');
    try {
      const r = await api.addComment(post.id, commentText.trim());
      if (!isCurrent() || currentScopeKey.current !== requestScope) return;
      setCommentText('');
      onMutation({ type: 'comment-added', postId: post.id, comment: r.comment });
    } catch (err: any) {
      if (isCurrent() && currentScopeKey.current === requestScope) {
        console.error(err);
        setMutationError(err.message || 'Could not add comment.');
      }
    } finally {
      if (isCurrent() && currentScopeKey.current === requestScope) setCommentSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!confirm('Delete this post?')) return;
    if (pendingAction) return;
    const requestScope = scopeKey;
    const isCurrent = mutationGate.current.capture();
    setPendingAction('delete');
    setMutationError('');
    try {
      await api.deletePost(post.id);
      if (!isCurrent() || currentScopeKey.current !== requestScope) return;
      onMutation({ type: 'delete', postId: post.id, parentId: post.parentId });
    } catch (e: any) {
      if (isCurrent() && currentScopeKey.current === requestScope) {
        console.error(e);
        setMutationError(e.message || 'Could not delete post.');
      }
    } finally {
      if (isCurrent() && currentScopeKey.current === requestScope) setPendingAction(null);
    }
  }

  function canEdit(target: any) {
    return target.canEdit === true && currentUser?.id === target.userId;
  }

  function cancelEdit() {
    if (editState.saving) return;
    setEditState(EMPTY_POST_EDIT);
  }

  async function saveEdit(target: any) {
    if (editSubmission.current || editState.conflict || editState.postId !== target.id) return;
    const normalized = editState.draft.trim();
    if (!normalized) {
      setEditState(previous => failPostEditSave(previous, 'Post content cannot be empty.'));
      return;
    }
    if (normalized.length > 5000) {
      setEditState(previous => failPostEditSave(previous, 'Post content must be 5000 characters or fewer.'));
      return;
    }

    const requestScope = scopeKey;
    const isCurrent = mutationGate.current.capture();
    editSubmission.current = true;
    setEditState(previous => startPostEditSave(previous));
    try {
      const result = await api.editPost(target.id, normalized, editState.expectedEditVersion);
      if (!isCurrent() || currentScopeKey.current !== requestScope) return;
      const mutation: PostEntityMutation = { type: 'update', post: result.post };
      onMutation(mutation);
      setEditState(EMPTY_POST_EDIT);
    } catch (error: any) {
      if (isCurrent() && currentScopeKey.current === requestScope) {
        const code = error?.data?.code;
        const message = code === 'STALE_POST_EDIT'
          ? 'This post changed in another window. Your draft is preserved. Load the latest text to review it before saving again.'
          : (error.message || 'Could not edit post.');
        setEditState(previous => failPostEditSave(previous, message, code === 'STALE_POST_EDIT'));
      }
    } finally {
      if (isCurrent() && currentScopeKey.current === requestScope) editSubmission.current = false;
    }
  }

  async function loadLatestEdit(target: any) {
    if (editSubmission.current) return;
    const requestScope = scopeKey;
    const isCurrent = mutationGate.current.capture();
    editSubmission.current = true;
    setEditState(previous => startPostEditSave(previous));
    try {
      const result = await api.getPost(target.id);
      if (!isCurrent() || currentScopeKey.current !== requestScope) return;
      onMutation({ type: 'update', post: result.post });
      if (!result.post.canEdit) throw new Error('This post is no longer editable. You can still copy your draft.');
      setEditState(previous => reviewLatestPost(previous, result.post));
    } catch (error: any) {
      if (isCurrent() && currentScopeKey.current === requestScope) {
        setEditState(previous => failPostEditSave(previous, error.message || 'Could not load the latest post.'));
      }
    } finally {
      if (isCurrent() && currentScopeKey.current === requestScope) editSubmission.current = false;
    }
  }

  function renderEditForm(target: any) {
    return (
      <form className="post-edit-form" onSubmit={event => { event.preventDefault(); void saveEdit(target); }}>
        <label>
          Edit text
          <textarea className="input" value={editState.draft}
            onChange={event => setEditState(previous => updatePostEditDraft(previous, event.target.value))}
            rows={4} disabled={editState.saving} />
        </label>
        {editState.latestContent !== null && <div className="post-content"><span className="muted">Latest saved text:</span><p>{editState.latestContent}</p></div>}
        {editState.error && <p className="error-msg" role="alert">{editState.error}</p>}
        <div className="post-edit-actions">
          {editState.conflict && <button type="button" className="btn btn-ghost btn-sm" onClick={() => loadLatestEdit(target)} disabled={editState.saving}>Load latest text</button>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={cancelEdit} disabled={editState.saving}>Cancel</button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={editState.saving || editState.conflict || !editState.draft.trim()}>
            {editState.saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    );
  }

  function openReportModal(target: any, type: 'post' | 'comment') {
    setReportTarget(target);
    setReportTargetType(type);
    setReportReason('Spam');
    setReportDetails('');
    setReportSubmitted(false);
    setReportError('');
    setShowReportModal(true);
  }

  function closeReportModal() {
    setShowReportModal(false);
    setReportSubmitted(false);
    setReportError('');
  }

  async function submitReport() {
    if (!reportReason || !reportDetails.trim() || reportDetails.trim().length < 5) { setReportError(REPORT_ERROR); return; }
    setReportError('');
    if (reportSubmitting) return;
    const requestScope = scopeKey;
    const isCurrent = mutationGate.current.capture();
    setReportSubmitting(true);
    try {
      await api.reportContent(reportTargetType, reportTarget?.id, reportReason, reportDetails.trim());
      if (!isCurrent() || currentScopeKey.current !== requestScope) return;
      setReportSubmitted(true);
    } catch (e: any) {
      if (isCurrent() && currentScopeKey.current === requestScope) {
        console.error(e);
        setReportError(e.message || REPORT_ERROR);
      }
    } finally {
      if (isCurrent() && currentScopeKey.current === requestScope) setReportSubmitting(false);
    }
  }

  async function handleMuteUser() {
    if (!confirm(`Mute @${post.username}? You will stop seeing their posts.`)) return;
    const requestScope = scopeKey;
    const isCurrent = mutationGate.current.capture();
    try {
      await api.post(`/users/${post.userId}/mute`);
      if (!isCurrent() || currentScopeKey.current !== requestScope) return;
      onMutation({ type: 'hide-author', userId: post.userId });
    } catch (e: any) {
      if (isCurrent() && currentScopeKey.current === requestScope) { console.error(e); setMutationError(e.message || 'Could not mute user.'); }
    }
  }

  async function handleBlockUser() {
    if (!confirm(`Block @${post.username}? They will not be able to interact with you, and you will stop seeing their posts.`)) return;
    const requestScope = scopeKey;
    const isCurrent = mutationGate.current.capture();
    try {
      await api.post(`/users/${post.userId}/block`);
      if (!isCurrent() || currentScopeKey.current !== requestScope) return;
      onMutation({ type: 'hide-author', userId: post.userId });
    } catch (e: any) {
      if (isCurrent() && currentScopeKey.current === requestScope) { console.error(e); setMutationError(e.message || 'Could not block user.'); }
    }
  }

  const time = post.createdAt ? new Date(post.createdAt + 'Z').toLocaleString() : '';
  const images = media.filter((m: any) => m.media_type === 'image');
  const videos = media.filter((m: any) => m.media_type === 'external_video');
  const avatarUrl = post.avatarUrl || '';
  const avatarInitial = post.displayName?.[0] || '?';

  return (
    <div className="post-card">
      {post.repostOf && post.repostedPost && <div className="repost-header">🔄 Reposted</div>}
      <div className="post-header">
        <Link to={`/profile/${post.username}`} className="post-user">
          {avatarUrl ? <img src={avatarUrl} alt="" className="avatar-img" /> : <span className="avatar-placeholder">{avatarInitial}</span>}
          <div><strong>{post.displayName}</strong><span className="muted">@{post.username}</span></div>
        </Link>
        <span className="post-time">{time}{post.editedAt ? ' · Edited' : ''}</span>
      </div>
      {post.isGroupPost && (
        <div className="muted" style={{ fontSize: '0.82rem', marginBottom: 8 }}>
          Posted in {post.group
            ? <Link to={`/groups/${post.group.id}`}>{post.group.name}</Link>
            : 'a group'}
        </div>
      )}

      {post.repostOf && post.repostedPost ? (
        <PostCard post={post.repostedPost} currentUser={currentUser} onMutation={onMutation} />
      ) : (
        <>
          {editState.postId === post.id ? renderEditForm(post) : <div className="post-content">{post.content}</div>}
          {images.map((img: any) => (
            <div key={img.id} className="post-media-wrap"><img src={img.url} alt={img.alt_text || ''} className="post-media-img" loading="lazy" /></div>
          ))}
          {videos.map((vid: any) => (
            <div key={vid.id} className="post-media-wrap post-video-wrap">
              <iframe src={vid.url} allowFullScreen loading="lazy" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture" className="post-video-embed" title="YouTube video" />
            </div>
          ))}
        </>
      )}

      <div className="post-actions">
        <div className="reaction-picker-wrap">
          <button className={`action-btn ${post.liked ? 'active' : ''}`}
            onClick={() => setShowReactions(!showReactions)}>
            {post.userReaction ? EMOJI[post.userReaction] : '🤍'} {totalReactions || ''}
          </button>
          {showReactions && (
            <div className="reaction-picker">
              {REACTIONS.map(r => (
                <button key={r} className={`reaction-btn ${post.userReaction === r ? 'active' : ''}`}
                  title={LABELS[r]} onClick={() => handleReaction(r)} disabled={pendingAction === 'reaction'}>
                  {EMOJI[r]} <span className="reaction-count">{reactions[r] || 0}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="action-btn" onClick={loadComments}>💬 {post.commentCount || 0}</button>
        <button className="action-btn" onClick={handleRepost}>🔄 {post.repostCount || 0}</button>
        {canEdit(post) && editState.postId !== post.id && (
          <button className="action-btn" onClick={() => setEditState(beginPostEdit(post))} disabled={editState.postId !== null}>Edit</button>
        )}
        {(currentUser?.id === post.userId || currentUser?.role === 'admin') && <button className="action-btn danger" onClick={handleDelete} disabled={pendingAction === 'delete'}>🗑</button>}
        {currentUser && currentUser.id !== post.userId && <button className="action-btn" onClick={() => openReportModal(post, 'post')} title="Report">🚩</button>}
        {currentUser?.id !== post.userId && currentUser && (
          <>
            <button className="action-btn" onClick={handleMuteUser} title="Mute">🔇</button>
            <button className="action-btn" onClick={handleBlockUser} title="Block">🚫</button>
          </>
        )}
      </div>
      {mutationError && <p className="error-msg" role="alert">{mutationError}</p>}

      {showComments && (
        <div className="comments-section">
          {comments.map(c => (
            <div key={c.id} className="comment">
              <Link to={`/profile/${c.username}`}><strong>{c.displayName}</strong></Link> <span className="muted">@{c.username}</span>
              {editState.postId === c.id ? renderEditForm(c) : <p>{c.content}{c.editedAt ? <span className="muted"> · Edited</span> : null}</p>}
              {canEdit(c) && editState.postId !== c.id && (
                <button className="btn btn-sm btn-ghost" onClick={() => setEditState(beginPostEdit(c))} disabled={editState.postId !== null}>Edit</button>
              )}
              {currentUser && currentUser.id !== c.userId && (
                <button className="btn btn-sm btn-ghost" onClick={() => openReportModal(c, 'comment')}>Report</button>
              )}
            </div>
          ))}
          <form className="comment-form" onSubmit={addComment}>
            {isPrivateProfile && (
              <span className="muted" style={{ fontSize: '0.78rem' }}>
                Your comment is visible to anyone who can view this thread, even if they cannot view your private profile.
              </span>
            )}
            <input className="input" placeholder="Write a comment..." value={commentText} onChange={e => setCommentText(e.target.value)} />
            <button className="btn btn-sm" disabled={!commentText.trim() || commentSubmitting}>{commentSubmitting ? 'Posting...' : 'Reply'}</button>
          </form>
        </div>
      )}

      {/* Repost confirmation modal */}
      {showRepostConfirm && (
        <div className="modal-overlay" onClick={() => setShowRepostConfirm(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h4>Share this post to your feed?</h4>
            <p className="muted">Reposted from @{post.username}: {post.content?.slice(0, 100)}</p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowRepostConfirm(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={confirmRepost} disabled={reposting}>{reposting ? 'Sharing...' : 'Share'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Report modal */}
      {showReportModal && (
        <div className="modal-overlay" onClick={closeReportModal}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            {reportSubmitted ? (
              <>
                <h4>Report submitted. Thank you.</h4>
                <button className="btn btn-primary" onClick={closeReportModal}>Close</button>
              </>
            ) : (
              <>
                <h4>Report this {reportTargetType}</h4>
                <select className="input" value={reportReason} onChange={e => setReportReason(e.target.value)} style={{ marginBottom: 10 }} required>
                  {['Spam','Harassment','Hate or abuse','Sexual content','Violence or threats','Scam or unsafe link','Other'].map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <textarea className="input" placeholder="Briefly explain what is wrong with this content." value={reportDetails} onChange={e => setReportDetails(e.target.value)} rows={2} required minLength={5} />
                {reportError && <p className="error-msg">{reportError}</p>}
                <div className="modal-actions">
                  <button className="btn btn-ghost" onClick={closeReportModal}>Cancel</button>
                  <button className="btn btn-primary" onClick={submitReport} disabled={reportSubmitting}>{reportSubmitting ? 'Submitting...' : 'Submit Report'}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
