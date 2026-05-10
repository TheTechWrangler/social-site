import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

export default function PostCard({ post: initial, currentUser, onUpdate }: { post: any; currentUser: any; onUpdate?: (p: any) => void }) {
  const [post, setPost] = useState(initial);
  const [showComments, setShowComments] = useState(false);
  const [comments, setComments] = useState<any[]>([]);
  const [commentText, setCommentText] = useState('');
  const [media, setMedia] = useState<any[]>([]);

  useEffect(() => { loadMedia(); }, [post.id]);

  async function loadMedia() {
    try { const r = await api.getPostMedia(post.id); setMedia(r.media || []); } catch (e) { /* no media */ }
  }

  async function toggleLike() {
    try {
      const r = post.liked ? await api.unlike(post.id) : await api.like(post.id);
      const updated = { ...post, liked: r.liked, likeCount: r.likeCount };
      setPost(updated); onUpdate?.(updated);
    } catch (e) { console.error(e); }
  }

  async function handleRepost() {
    try { await api.repost(post.id); window.location.reload(); } catch (e) { console.error(e); }
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
      const updated = { ...post, commentCount: post.commentCount + 1 };
      setPost(updated); onUpdate?.(updated);
    } catch (err) { console.error(err); }
  }

  async function handleDelete() {
    if (!confirm('Delete this post?')) return;
    try { await api.deletePost(post.id); setPost({ ...post, deleted: true }); } catch (e) { console.error(e); }
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
            <div key={img.id} className="post-media-wrap">
              <img src={img.url} alt={img.alt_text || ''} className="post-media-img" loading="lazy" />
            </div>
          ))}
          {videos.map((vid: any) => (
            <div key={vid.id} className="post-media-wrap post-video-wrap">
              <iframe src={vid.url} allowFullScreen loading="lazy"
                allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                className="post-video-embed" title="YouTube video" />
            </div>
          ))}
        </>
      )}

      <div className="post-actions">
        <button className={`action-btn ${post.liked ? 'active' : ''}`} onClick={toggleLike}>{post.liked ? '❤️' : '🤍'} {post.likeCount || 0}</button>
        <button className="action-btn" onClick={loadComments}>💬 {post.commentCount || 0}</button>
        <button className="action-btn" onClick={handleRepost}>🔄 {post.repostCount || 0}</button>
        {(currentUser?.id === post.userId || currentUser?.role === 'admin') && <button className="action-btn danger" onClick={handleDelete}>🗑</button>}
      </div>

      {showComments && (
        <div className="comments-section">
          {comments.map(c => (
            <div key={c.id} className="comment">
              <Link to={`/profile/${c.username}`} className="comment-user"><strong>{c.displayName}</strong> <span className="muted">@{c.username}</span></Link>
              <p>{c.content}</p>
            </div>
          ))}
          <form className="comment-form" onSubmit={addComment}>
            <input className="input" placeholder="Write a comment..." value={commentText} onChange={e => setCommentText(e.target.value)} />
            <button className="btn btn-sm" disabled={!commentText.trim()}>Reply</button>
          </form>
        </div>
      )}
    </div>
  );
}
