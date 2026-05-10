import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';
import PostCard from '../components/PostCard';

export default function HomePage({ user }: { user: any }) {
  const [posts, setPosts] = useState<any[]>([]);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [exposure, setExposure] = useState('mixed');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isVerified = user?.isVerified ?? user?.is_verified;

  // YouTube URL detection (client-side, matches backend)
  function parseYoutubeUrl(input: string): string | null {
    const t = input.trim();
    const patterns = [
      /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
      /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})/,
      /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
      /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    ];
    for (const p of patterns) { const m = t.match(p); if (m) return `https://www.youtube.com/embed/${m[1]}`; }
    return null;
  }
  const youtubePreview = youtubeUrl.trim() ? parseYoutubeUrl(youtubeUrl) : null;
  const isYoutubeValid = youtubePreview !== null;
  const isYoutubeInvalid = youtubeUrl.trim() && !isYoutubeValid;

  useEffect(() => { loadFeed(); }, []);

  async function loadFeed() {
    try { const r = await api.feed({ limit: 50, offset: 0, exposure } as any); setPosts(r.posts); } catch (e) { console.error(e); }
    setLoading(false);
  }

  async function handleExposureChange(val: string) {
    setExposure(val);
    setLoading(true);
    try {
      // Save preference
      await api.post<any>('/users/profile', {});
      await fetch('/api/users/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ feedExposure: val }) });
      const r = await api.feed({ limit: 50, offset: 0, exposure: val } as any);
      setPosts(r.posts);
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase();
    const videoExts = ['mp4', 'mov', 'webm', 'avi', 'mkv'];
    if (videoExts.includes(ext || '')) {
      alert('Direct video uploads are currently disabled. Upload your video to YouTube or another supported platform and paste the link here.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) { alert('Image must be under 5MB.'); return; }
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  }

  function removeImage() { setImageFile(null); setImagePreview(null); if (fileInputRef.current) fileInputRef.current.value = ''; }

  async function handlePost(e: React.FormEvent) {
    e.preventDefault();
    if ((!content.trim() && !imageFile) || !isVerified) return;
    setPosting(true);
    try {
      // 1. Create post first
      const postR = await api.createPost(content.trim() || '(image)');
      const postId = postR.post.id;

      // 2. Upload image with postId if selected
      if (imageFile) {
        const form = new FormData();
        form.append('file', imageFile);
        form.append('postId', String(postId));
        const token = localStorage.getItem('token');
        await fetch('/api/uploads/image', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: form });
      }

      // 3. Attach YouTube if provided
      if (youtubeUrl.trim()) {
        try { await api.attachYouTube(youtubeUrl.trim(), postId); } catch (e) { console.error('YouTube attach failed:', e); }
      }

      setContent(''); setImageFile(null); setImagePreview(null); setYoutubeUrl('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      await loadFeed();
    } catch (e: any) { console.error(e); alert(e.message || 'Post failed'); }
    setPosting(false);
  }

  function handlePostUpdate(updated: any) { setPosts(prev => prev.map(p => p.id === updated.id ? updated : p)); }

  return (
    <div className="feed-page">
      <h2>Home</h2>
      <div className="feed-controls">
        <div className="feed-exposure">
          <span className="muted" style={{ fontSize: '0.8rem', marginRight: 6 }}>Feed:</span>
          {(['friends_only', 'mixed', 'everyone'] as const).map(v => (
            <button key={v} className={`btn btn-sm ${exposure === v ? 'btn-primary' : 'btn-ghost'}`} onClick={() => handleExposureChange(v)}>
              {v === 'friends_only' ? 'No non-friends' : v === 'mixed' ? 'Few non-friends' : 'All non-friends'}
            </button>
          ))}
        </div>
        <p className="muted" style={{ fontSize: '0.78rem', marginTop: 4 }}>Chronological only. No ranking. Mixed mode uses your extended circle.</p>
      </div>
      {!isVerified && (
        <div className="verify-banner">
          ⚠️ Your account is pending verification. You can browse, but posting and interactions are disabled until your account is approved.
        </div>
      )}
      {isVerified && (
        <form className="post-composer" onSubmit={handlePost}>
          <textarea className="input" placeholder="What's on your mind?" value={content} onChange={e => setContent(e.target.value)} rows={3} />
          {imagePreview && (
            <div className="image-preview-wrap">
              <img src={imagePreview} alt="Preview" className="image-preview" />
              <button type="button" className="btn btn-sm" onClick={removeImage}>✕ Remove</button>
            </div>
          )}
          <div className="composer-actions">
            <label className="composer-upload-btn">
              🖼 Image
              <input type="file" ref={fileInputRef} accept="image/*" onChange={handleFileSelect} style={{ display: 'none' }} />
            </label>
            <input className="input" placeholder="YouTube link (optional)" value={youtubeUrl} onChange={e => setYoutubeUrl(e.target.value)} style={{ flex: 1 }} />
            <button className="btn btn-primary" disabled={posting || (!content.trim() && !imageFile)}>{posting ? 'Posting...' : 'Post'}</button>
          </div>
          {isYoutubeInvalid && <p className="muted" style={{ fontSize: '0.8rem', marginTop: 4 }}>Paste a valid YouTube link to preview it.</p>}
          {youtubePreview && (
            <div className="youtube-preview">
              <div className="youtube-preview-header">
                <span>🎬 YouTube preview</span>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setYoutubeUrl('')}>✕ Remove</button>
              </div>
              <div className="post-video-wrap" style={{ maxWidth: 400 }}>
                <iframe src={youtubePreview} allowFullScreen loading="lazy"
                  allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  className="post-video-embed" title="YouTube preview" />
              </div>
            </div>
          )}
        </form>
      )}
      {loading ? <p className="muted">Loading...</p> : posts.length === 0 ? (
        <div className="empty-state"><p>No posts yet.</p><p className="muted">Follow some users or create your first post!</p></div>
      ) : (
        <div className="feed-list">
          {posts.map(p => <PostCard key={p.id} post={p} currentUser={user} onUpdate={handlePostUpdate} />)}
        </div>
      )}
    </div>
  );
}
