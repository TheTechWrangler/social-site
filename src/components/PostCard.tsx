import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

const REACTIONS = ['like', 'love', 'laugh', 'wow', 'support', 'thoughtful'];
const EMOJI: Record<string, string> = { like: '👍', love: '❤️', laugh: '😂', wow: '😮', support: '🙌', thoughtful: '🤔' };
const LABELS: Record<string, string> = { like: 'Like', love: 'Love', laugh: 'Laugh', wow: 'Wow', support: 'Support', thoughtful: 'Think' };
const REPORT_ERROR = 'Please select a reason and briefly explain the problem.';

export default function PostCard({ post: initial, currentUser, onUpdate }: { post: any; currentUser: any; onUpdate?: (p: any) => void }) {
  const [post, setPost] = useState(initial);
  const [showComments, setShowComments] = useState(false);
  const [comments, setComments] = useState<any[]>([]);
  const [commentText, setCommentText] = useState('');
  const [media, setMedia] = useState<any[]>([]);
  const [showReactions, setShowReactions] = useState(false);
  const [showRepostConfirm, setShowRepostConfirm] = useState(false);
  const [reposting, setReposting] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportTarget, setReportTarget] = useState<any>(initial);
  const [reportTargetType, setReportTargetType] = useState<'post' | 'comment'>('post');
  const [reportReason, setReportReason] = useState('Spam');
  const [reportDetails, setReportDetails] = useState('');
  const [reportSubmitted, setReportSubmitted] = useState(false);
  const [reportError, setReportError] = useState('');

  const isVerified = currentUser?.is_verified ?? currentUser?.isVerified;
  const reactions = post.reactions || {};
  const totalReactions = Object.values(reactions).reduce((a: number, b: any) => a + (b || 0), 0);

  useEffect(() => { loadMedia(); }, [post.id]);

  async function loadMedia() {
    try { const r = await api.getPostMedia(post.id); setMedia(r.media || []); } catch (e) { /* no media */ }
  }

  async function handleReaction(type: string) {
    if (!isVerified) { alert('Account verification required before you can react.'); return; }
    try {
      // If same reaction, remove it
      if (post.userReaction === type) {
        const r: any = await api.unlike(post.id);
        setPost({ ...post, userReaction: null, liked: false, reactions: r.counts || {} });
        onUpdate?.({ ...post, userReaction: null, liked: false, reactions: r.counts || {} });
      } else {
        const r = await fetch(`/api/likes/${post.id}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reactionType: type }),
        }).then(r => r.json());
        setPost({ ...post, userReaction: type, liked: true, reactions: r.counts });
        onUpdate?.({ ...post, userReaction: type, liked: true, reactions: r.counts });
      }
    } catch (e) { console.error(e); }
    setShowReactions(false);
  }

  async function handleRepost() {
    setShowRepostConfirm(true);
  }

  async function confirmRepost() {
    setReposting(true);
    try {
      await api.repost(post.id);
      setShowRepostConfirm(false);
      window.location.reload();
    } catch (e) { console.error(e); alert('Repost failed'); }
    setReposting(false);
  }

  async function loadComments() {
    setShowComments(!showComments);
    if (!showComments && comments.length === 0) {
      try { const r = await api.getComments(post.id); setComments(r.comments); } catch (e) { console.error(e); }
    }
  }

  async function addComment(e: React.FormEvent) {
    e.preventDefault();
    if (!commentText.trim()) return;
    try {
      const r = await api.addComment(post.id, commentText.trim());
      setComments(prev => [...prev, r.comment]); setCommentText('');
      setPost({ ...post, commentCount: post.commentCount + 1 });
    } catch (err) { console.error(err); }
  }

  async function handleDelete() {
    if (!confirm('Delete this post?')) return;
    try { await api.deletePost(post.id); setPost({ ...post, deleted: true }); } catch (e) { console.error(e); }
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
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetType: reportTargetType, targetId: reportTarget?.id, reason: reportReason, details: reportDetails.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setReportError(body.error || REPORT_ERROR);
        return;
      }
      setReportSubmitted(true);
    } catch (e) { console.error(e); setReportError(REPORT_ERROR); }
  }

  async function handleMuteUser() {
    if (!confirm(`Mute @${post.username}? You will stop seeing their posts.`)) return;
    try {
      await fetch(`/api/users/${post.userId}/mute`, { method: 'POST', credentials: 'include' });
      window.location.reload();
    } catch (e) { console.error(e); }
  }

  async function handleBlockUser() {
    if (!confirm(`Block @${post.username}? They will not be able to interact with you, and you will stop seeing their posts.`)) return;
    try {
      await fetch(`/api/users/${post.userId}/block`, { method: 'POST', credentials: 'include' });
      window.location.reload();
    } catch (e) { console.error(e); }
  }

  if ((post as any).deleted) return null;
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
        <span className="post-time">{time}</span>
      </div>

      {post.repostOf && post.repostedPost ? (
        <PostCard post={post.repostedPost} currentUser={currentUser} />
      ) : (
        <>
          <div className="post-content">{post.content}</div>
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
                  title={LABELS[r]} onClick={() => handleReaction(r)}>
                  {EMOJI[r]} <span className="reaction-count">{reactions[r] || 0}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="action-btn" onClick={loadComments}>💬 {post.commentCount || 0}</button>
        <button className="action-btn" onClick={handleRepost}>🔄 {post.repostCount || 0}</button>
        {(currentUser?.id === post.userId || currentUser?.role === 'admin') && <button className="action-btn danger" onClick={handleDelete}>🗑</button>}
        {currentUser && currentUser.id !== post.userId && <button className="action-btn" onClick={() => openReportModal(post, 'post')} title="Report">🚩</button>}
        {currentUser?.id !== post.userId && currentUser && (
          <>
            <button className="action-btn" onClick={handleMuteUser} title="Mute">🔇</button>
            <button className="action-btn" onClick={handleBlockUser} title="Block">🚫</button>
          </>
        )}
      </div>

      {showComments && (
        <div className="comments-section">
          {comments.map(c => (
            <div key={c.id} className="comment">
              <Link to={`/profile/${c.username}`}><strong>{c.displayName}</strong></Link> <span className="muted">@{c.username}</span>
              <p>{c.content}</p>
              {currentUser && currentUser.id !== c.userId && (
                <button className="btn btn-sm btn-ghost" onClick={() => openReportModal(c, 'comment')}>Report</button>
              )}
            </div>
          ))}
          <form className="comment-form" onSubmit={addComment}>
            <input className="input" placeholder="Write a comment..." value={commentText} onChange={e => setCommentText(e.target.value)} />
            <button className="btn btn-sm" disabled={!commentText.trim()}>Reply</button>
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
                  <button className="btn btn-primary" onClick={submitReport}>Submit Report</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
