import { useActionDialog, ActionDialog } from './ActionDialog';
import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import ImageDescription from './ImageDescription';
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
  const [commentCursor, setCommentCursor] = useState<number | null>(null);
  const [loadingComments, setLoadingComments] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const comments: any[] = post.comments || [];
  const [commentText, setCommentText] = useState('');
  const media: any[] = post.media || [];
  const [descriptionDraft, setDescriptionDraft] = useState<{ id: number; value: string } | null>(null);
  const [descriptionPending, setDescriptionPending] = useState(false);
  const descriptionLock = useRef(false);
  const [showReactions, setShowReactions] = useState(false);
  const [showRepostConfirm, setShowRepostConfirm] = useState(false);
  const [reposting, setReposting] = useState(false);
  const repostSubmission = useRef(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportTarget, setReportTarget] = useState<any>(null);
  const [reportTargetType, setReportTargetType] = useState<'post' | 'comment'>('post');
  const [reportReason, setReportReason] = useState('Spam');
  const [reportDetails, setReportDetails] = useState('');
  const [reportSubmitted, setReportSubmitted] = useState(false);
  const [reportError, setReportError] = useState('');
  const [mutationError, setMutationError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const reportSubmission = useRef(false);
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

  const { confirmAction, actionDialog } = useActionDialog(scopeKey);

  useEffect(() => {
    setDescriptionDraft(null);
    setDescriptionPending(false);
    descriptionLock.current = false;
    setShowRepostConfirm(false);
    setShowReportModal(false);
    setShowComments(false);
    setCommentCursor(null); setLoadingComments(false);
    setCommentText('');
    setMutationError('');
    setStatusMessage('');
    setPendingAction(null);
    setCommentSubmitting(false);
    setReportSubmitting(false);
    reportSubmission.current = false;
    setReposting(false);
    repostSubmission.current = false;
    setEditState(EMPTY_POST_EDIT);
    editSubmission.current = false;
    mediaGate.current.invalidate();
    commentGate.current.invalidate();
    mutationGate.current.invalidate();
    if (!Array.isArray(post.media)) void loadMedia(post.id);
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
      if (isCurrent() && entityId.current === postId) onMutation({ type: 'media-loaded', postId, media: r.media || [] });
    } catch (e) { /* no media */ }
  }

  async function handleReaction(type: string) {
    if (!isVerified) { setMutationError('Account verification required before you can react.'); return; }
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
    if (reposting || repostSubmission.current) return;
    setShowRepostConfirm(true);
  }

  async function confirmRepost() {
    if (reposting || repostSubmission.current) return;
    repostSubmission.current = true;
    const requestScope = scopeKey;
    const isCurrent = mutationGate.current.capture();
    setReposting(true);
    setMutationError('');
    try {
      const result = await api.repost(post.id);
      if (!isCurrent() || currentScopeKey.current !== requestScope) return;
      onMutation({ type: 'repost', postId: post.id, repost: result.post });
      setShowRepostConfirm(false);
    } catch (e) {
      if (isCurrent() && currentScopeKey.current === requestScope) { console.error(e); setMutationError('Repost failed'); }
      throw e;
    } finally {
      if (isCurrent() && currentScopeKey.current === requestScope) {
        repostSubmission.current = false;
        setReposting(false);
      }
    }
  }

  async function refreshComments(postId: number, after?: number) {
    setLoadingComments(true);
    const requestScope = scopeKey;
    const isCurrent = commentGate.current.begin();
    try {
      const response = await api.getComments(postId, after);
      if (isCurrent() && currentScopeKey.current === requestScope) {
        setCommentCursor(response.nextCursor ?? null);
        onMutation({ type: 'comments-loaded', postId, comments: response.comments, append: !!after });
      }
    } catch (e) { if (isCurrent()) setMutationError('Could not load comments.'); }
    finally { if (isCurrent()) setLoadingComments(false); }
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
    return confirmAction({ title: "Delete post", description: 'Delete this post?', confirmLabel: 'Delete post' }, async () => {
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
     throw e; } finally {
      if (isCurrent() && currentScopeKey.current === requestScope) setPendingAction(null);
    }
  });
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
    if (reportSubmitting || reportSubmission.current) return;
    setShowReportModal(false);
    setReportSubmitted(false);
    setReportError('');
  }

  async function submitReport() {
    if (reportSubmitting || reportSubmitted || reportSubmission.current) return;
    if (!reportReason || !reportDetails.trim() || reportDetails.trim().length < 5) {
      setReportError(REPORT_ERROR);
      throw new Error(REPORT_ERROR);
    }
    setReportError('');
    if (reportSubmitting) return;
    reportSubmission.current = true;
    const requestScope = scopeKey;
    const isCurrent = mutationGate.current.capture();
    setReportSubmitting(true);
    try {
      await api.reportContent(reportTargetType, reportTarget?.id, reportReason, reportDetails.trim());
      if (!isCurrent() || currentScopeKey.current !== requestScope) return;
      setReportSubmitted(true);
      setStatusMessage('Report submitted. Thank you.');
    } catch (e: any) {
      if (isCurrent() && currentScopeKey.current === requestScope) {
        console.error(e);
        setReportError(e.message || REPORT_ERROR);
      }
      throw e;
    } finally {
      if (isCurrent() && currentScopeKey.current === requestScope) {
        reportSubmission.current = false;
        setReportSubmitting(false);
      }
    }
  }

  async function handleMuteUser() {
    return confirmAction({ title: "Mute user", description: `Mute @${post.username}? You will stop seeing their posts.` }, async () => {
    const requestScope = scopeKey;
    const isCurrent = mutationGate.current.capture();
    try {
      await api.post(`/users/${post.userId}/mute`);
      if (!isCurrent() || currentScopeKey.current !== requestScope) return;
      onMutation({ type: 'hide-author', userId: post.userId });
    } catch (e: any) {
      if (isCurrent() && currentScopeKey.current === requestScope) { console.error(e); setMutationError(e.message || 'Could not mute user.'); }
     throw e; }
  });
  }

  async function handleBlockUser() {
    return confirmAction({ title: "Block user", description: `Block @${post.username}? They will not be able to interact with you, and you will stop seeing their posts.` }, async () => {
    const requestScope = scopeKey;
    const isCurrent = mutationGate.current.capture();
    try {
      await api.post(`/users/${post.userId}/block`);
      if (!isCurrent() || currentScopeKey.current !== requestScope) return;
      onMutation({ type: 'hide-author', userId: post.userId });
    } catch (e: any) {
      if (isCurrent() && currentScopeKey.current === requestScope) { console.error(e); setMutationError(e.message || 'Could not block user.'); }
     throw e; }
  });
  }

  async function saveDescription() {
    if (!descriptionDraft || descriptionLock.current) return;
    const draft = descriptionDraft;
    const requestScope = scopeKey;
    const isCurrent = mutationGate.current.capture();
    descriptionLock.current = true; setDescriptionPending(true); setMutationError('');
    try {
      const result = await api.editImageDescription(draft.id, draft.value);
      if (!isCurrent() || currentScopeKey.current !== requestScope) return;
      onMutation({ type: 'media-description', postId: post.id, media: result.media });
      setDescriptionDraft(null);
    } catch (error: any) {
      if (isCurrent() && currentScopeKey.current === requestScope) setMutationError(error.message || 'Could not save image description. Your draft was preserved.');
    } finally {
      if (isCurrent() && currentScopeKey.current === requestScope) { descriptionLock.current = false; setDescriptionPending(false); }
    }
  }

  const time = post.createdAt ? new Date(post.createdAt + 'Z').toLocaleString() : '';
  const images = media.filter((m: any) => m.media_type === 'image');
  const videos = media.filter((m: any) => m.media_type === 'external_video');
  const avatarUrl = post.avatarUrl || '';
  const avatarInitial = post.displayName?.[0] || '?';

  return (
    <div className="post-card">
      {actionDialog}
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
            <div key={img.id} className="post-media-wrap">
              <img src={img.url} alt={img.alt_text ?? ''} className="post-media-img" loading="lazy" />
              {descriptionDraft && descriptionDraft.id === img.id ? <form onSubmit={event => { event.preventDefault(); void saveDescription(); }}>
                <ImageDescription value={descriptionDraft.value} onChange={value => setDescriptionDraft({ id: img.id, value })} disabled={descriptionPending} />
                <button type="button" className="btn btn-ghost" disabled={descriptionPending} onClick={() => setDescriptionDraft(null)}>Cancel description edit</button>
                <button className="btn" disabled={descriptionPending}>{descriptionPending ? 'Saving…' : 'Save description'}</button>
              </form> : img.canEditAlt && currentUser?.id === post.userId && <button type="button" className="btn btn-sm" disabled={!!descriptionDraft}
                onClick={() => setDescriptionDraft({ id: img.id, value: img.alt_text ?? '' })}>Edit image description</button>}
            </div>
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
            aria-label="Choose reaction" onClick={() => setShowReactions(!showReactions)}>
            {post.userReaction ? EMOJI[post.userReaction] : '🤍'} {totalReactions || ''}
          </button>
          {showReactions && (
            <div className="reaction-picker">
              {REACTIONS.map(r => (
                <button key={r} className={`reaction-btn ${post.userReaction === r ? 'active' : ''}`}
                  aria-label={LABELS[r]} title={LABELS[r]} onClick={() => handleReaction(r)} disabled={pendingAction === 'reaction'}>
                  {EMOJI[r]} <span className="reaction-count">{reactions[r] || 0}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="action-btn" aria-label="Comments" onClick={loadComments}>💬 {post.commentCount || 0}</button>
        <button className="action-btn" aria-label="Repost" onClick={handleRepost} disabled={reposting}>🔄 {post.repostCount || 0}</button>
        {canEdit(post) && editState.postId !== post.id && (
          <button className="action-btn" onClick={() => setEditState(beginPostEdit(post))} disabled={editState.postId !== null}>Edit</button>
        )}
        {(currentUser?.id === post.userId || currentUser?.role === 'admin') && <button className="action-btn danger" aria-label="Delete post" onClick={handleDelete} disabled={pendingAction === 'delete'}>🗑</button>}
        {currentUser && currentUser.id !== post.userId && <button className="action-btn" onClick={() => openReportModal(post, 'post')} aria-label="Report post" title="Report">🚩</button>}
        {currentUser?.id !== post.userId && currentUser && (
          <>
            <button className="action-btn" aria-label="Mute user" onClick={handleMuteUser} title="Mute">🔇</button>
            <button className="action-btn" aria-label="Block user" onClick={handleBlockUser} title="Block">🚫</button>
          </>
        )}
      </div>
      {mutationError && <p className="error-msg" role="alert">{mutationError}</p>}
      {statusMessage && <p className="muted" role="status">{statusMessage}</p>}

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
          {commentCursor && <button className="btn btn-ghost" disabled={loadingComments} onClick={() => void refreshComments(post.id, commentCursor)}>Load more comments</button>}
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

      {showRepostConfirm && <ActionDialog title="Share this post?" description={`Reposted from @${post.username}: ${post.content?.slice(0, 100)}`}
        intent="normal" confirmLabel="Share" actionPending={reposting} onConfirm={confirmRepost} onClose={() => setShowRepostConfirm(false)} />}
      {showReportModal && <ActionDialog title={`Report this ${reportTargetType}`} description="Tell moderators why this content needs review."
        intent="normal" confirmLabel="Submit Report" actionPending={reportSubmitting} actionError={reportError} onConfirm={submitReport} onClose={closeReportModal}>
        <label>Reason<select className="input" value={reportReason} onChange={e => setReportReason(e.target.value)}>
          {['Spam','Harassment','Hate or abuse','Sexual content','Violence or threats','Scam or unsafe link','Other'].map(r => <option key={r}>{r}</option>)}
        </select></label>
        <label>Details<textarea className="input" value={reportDetails} onChange={e => setReportDetails(e.target.value)} rows={3} /></label>
      </ActionDialog>}
    </div>
  );
}
