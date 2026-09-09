import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';
import PostCard from '../components/PostCard';
import WorldCard from '../components/WorldCard';
import { attachComposerMedia, createClientOperationKey, SubmissionLock, submitComposerPost, type AttachmentResult } from '../postComposerSubmission';

const LEVELS = [
  { key: 'everyone', label: 'Community', help: 'All public posts from verified members. Mute, block, or follow to shape what you see.' },
  { key: 'extended', label: 'Friends of Friends', help: 'Your circle plus your extended circle. No random public posts.' },
  { key: 'friends', label: 'Just Friends', help: 'Only your posts and people you follow.' },
  { key: 'world', label: 'Approved World Feeds', help: 'Approved RSS and podcast sources. External content stays clearly labeled.' },
];
const WORLD_HOME_OPTIONS = [
  { key: 'world_home_off', label: 'Off', help: 'Only native posts appear in this feed.' },
  { key: 'world_home_few', label: 'Few', help: 'Occasionally adds approved RSS/podcast items.' },
  { key: 'world_home_balanced', label: 'Balanced', help: 'Adds more approved RSS/podcast items.' },
];
const IMAGE_UPLOAD_ERROR = 'SVG uploads are not supported. Please use JPG, PNG, GIF, or WebP.';
const SUPPORTED_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];

export default function HomePage({ user, onUserChange }: { user: any; onUserChange: (user: any) => void }) {
  const [posts, setPosts] = useState<any[]>([]);
  const [worldItems, setWorldItems] = useState<any[]>([]);
  const [feedItems, setFeedItems] = useState<any[]>([]);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [repopulating, setRepopulating] = useState(false);
  const [repopulateMsg, setRepopulateMsg] = useState('');
  const [replenishing, setReplenishing] = useState(false);
  const [replenishMsg, setReplenishMsg] = useState('');
  const [replenishCooldown, setReplenishCooldown] = useState<string | null>(null);
  // Default to 'everyone' (Community) so new users see the full public feed immediately.
  // Existing users who previously picked a level keep that stored preference.
  const initialLevel = ['everyone', 'extended', 'friends', 'world'].includes(user?.feed_exposure) ? user.feed_exposure : 'everyone';
  const [level, setLevel] = useState(initialLevel);
  const [worldHomeInjection, setWorldHomeInjection] = useState(user?.world_home_injection || 'world_home_few');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [composerError, setComposerError] = useState('');
  const [partialPostId, setPartialPostId] = useState<number | null>(null);
  const [submissionKey, setSubmissionKey] = useState<string | null>(null);
  const [imageAssetId, setImageAssetId] = useState<string | null>(null);
  const [videoAttachmentKey, setVideoAttachmentKey] = useState<string | null>(null);
  const [preferenceError, setPreferenceError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submissionLock = useRef(new SubmissionLock());
  const isVerified = user?.isVerified ?? user?.is_verified;

  useEffect(() => { loadFeed(); }, []);

  async function loadFeed(lv?: string) {
    const l = lv || level;
    setLoading(true);
    try {
      const r = await api.feed({ limit: 50, offset: 0, level: l } as any);
      const nativePosts = Array.isArray(r.posts) ? r.posts : [];
      const normalizedItems = Array.isArray(r.items)
        ? r.items
        : nativePosts.map((p: any) => ({ ...p, type: p.type || 'post' }));
      setPosts(nativePosts);
      setWorldItems(Array.isArray(r.worldItems) ? r.worldItems : []);
      setFeedItems(normalizedItems);
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  async function handleLevelChange(lv: string) {
    const previous = level;
    setLevel(lv);
    setPreferenceError('');
    setLoading(true);
    try {
      const updated = await api.updateProfile({ feedExposure: lv });
      onUserChange(updated.authUser);
    } catch (e: any) {
      console.error(e);
      setLevel(previous);
      setPreferenceError(e.message || 'Could not update feed preference.');
      setLoading(false);
      return;
    }
    try {
      const r = await api.feed({ limit: 50, offset: 0, level: lv } as any);
      const nativePosts = Array.isArray(r.posts) ? r.posts : [];
      const normalizedItems = Array.isArray(r.items)
        ? r.items
        : nativePosts.map((p: any) => ({ ...p, type: p.type || 'post' }));
      setPosts(nativePosts);
      setWorldItems(Array.isArray(r.worldItems) ? r.worldItems : []);
      setFeedItems(normalizedItems);
    } catch (e: any) {
      console.error(e);
      setPreferenceError('Feed preference was saved, but the feed could not be refreshed.');
    }
    setLoading(false);
  }

  async function handleWorldHomeChange(value: string) {
    const previous = worldHomeInjection;
    setWorldHomeInjection(value);
    setPreferenceError('');
    setLoading(true);
    try {
      const updated = await api.updateProfile({ worldHomeInjection: value });
      onUserChange(updated.authUser);
    } catch (e: any) {
      console.error(e);
      setWorldHomeInjection(previous);
      setPreferenceError(e.message || 'Could not update World Feed preference.');
      setLoading(false);
      return;
    }
    try {
      const r = await api.feed({ limit: 50, offset: 0, level } as any);
      const nativePosts = Array.isArray(r.posts) ? r.posts : [];
      const normalizedItems = Array.isArray(r.items)
        ? r.items
        : nativePosts.map((p: any) => ({ ...p, type: p.type || 'post' }));
      setPosts(nativePosts);
      setWorldItems(Array.isArray(r.worldItems) ? r.worldItems : []);
      setFeedItems(normalizedItems);
    } catch (e: any) {
      console.error(e);
      setPreferenceError('World Feed preference was saved, but the feed could not be refreshed.');
    }
    setLoading(false);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (['mp4', 'mov', 'webm', 'avi', 'mkv'].includes(ext || '')) { alert('Direct video uploads are currently disabled.'); return; }
    if (!SUPPORTED_IMAGE_EXTENSIONS.includes(ext || '')) { alert(IMAGE_UPLOAD_ERROR); if (fileInputRef.current) fileInputRef.current.value = ''; return; }
    if (file.size > 5 * 1024 * 1024) { alert('Image must be under 5MB.'); return; }
    setImageFile(file); setImagePreview(URL.createObjectURL(file));
    setImageAssetId(null);
    if (partialPostId === null) setSubmissionKey(null);
  }

  function removeImage() {
    setImageFile(null); setImagePreview(null); setImageAssetId(null);
    if (partialPostId === null) setSubmissionKey(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

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
  const isYoutubeInvalid = youtubeUrl.trim() && !youtubePreview;

  async function handlePost(e: React.FormEvent) {
    e.preventDefault();
    if (partialPostId !== null) {
      await retryAttachments();
      return;
    }
    if ((!content.trim() && !imageFile) || !isVerified) return;
    if (!submissionLock.current.tryAcquire()) return;
    setPosting(true);
    setComposerError('');
    try {
      const key = submissionKey ?? createClientOperationKey();
      if (!submissionKey) setSubmissionKey(key);
      const result = await submitComposerPost(
        content,
        { imageFile, youtubeUrl, imageAssetId, videoAttachmentKey },
        key,
        {
          createPost: (text, operationKey) => api.createPost(text, undefined, operationKey),
          uploadImage: api.uploadImage,
          attachImage: api.attachImage,
          attachYouTube: api.attachYouTube,
        },
      );
      // Receiving a valid post ID proves the keyed creation result is known.
      setSubmissionKey(null);
      applyAttachmentResult(result);
      await loadFeed();
    } catch (e: any) {
      console.error(e);
      setComposerError(e.message || 'Could not create post. Your draft was preserved.');
    } finally {
      setPosting(false);
      submissionLock.current.release();
    }
  }

  function applyAttachmentResult(result: AttachmentResult) {
    setContent('');
    setImageAssetId(result.imageAssetId);
    setVideoAttachmentKey(result.videoAttachmentKey);
    if (result.attached.includes('image')) removeImage();
    if (result.attached.includes('video')) setYoutubeUrl('');
    if (result.failures.length > 0) {
      setPartialPostId(result.postId);
      const labels = result.failures.map(f => f.kind === 'image' ? 'image' : 'YouTube attachment').join(' and ');
      setComposerError(`Post created, but the ${labels} failed. Retry will attach to post #${result.postId} without creating another post.`);
      return;
    }
    setPartialPostId(null);
    setSubmissionKey(null);
    setImageAssetId(null);
    setVideoAttachmentKey(null);
    setComposerError('');
    removeImage();
    setYoutubeUrl('');
  }

  async function retryAttachments() {
    if (partialPostId === null || !submissionLock.current.tryAcquire()) return;
    setPosting(true);
    setComposerError('');
    try {
      const result = await attachComposerMedia(
        partialPostId,
        { imageFile, youtubeUrl, imageAssetId, videoAttachmentKey },
        { uploadImage: api.uploadImage, attachImage: api.attachImage, attachYouTube: api.attachYouTube },
      );
      applyAttachmentResult(result);
      await loadFeed();
    } catch (e: any) {
      setComposerError(e.message || 'Could not retry the attachment.');
    } finally {
      setPosting(false);
      submissionLock.current.release();
    }
  }

  function dismissFailedAttachments() {
    setPartialPostId(null);
    setSubmissionKey(null);
    setImageAssetId(null);
    setVideoAttachmentKey(null);
    setComposerError('');
    removeImage();
    setYoutubeUrl('');
  }

  async function handleRepopulate() {
    setRepopulating(true);
    setRepopulateMsg('');
    try {
      const r: any = await api.post('/admin/rss/fetch-all');
      if (r.started || r.running) {
        setRepopulateMsg('Repopulate started in background — new items will appear shortly.');
        setTimeout(async () => { await loadFeed(); setRepopulating(false); }, 4000);
        return;
      }
      // Legacy: synchronous array response (fallback)
      const results: any[] = Array.isArray(r) ? r : [];
      const totalNew = results.reduce((s: number, x: any) => s + (x.itemsInserted || 0), 0);
      const errors = results.filter((x: any) => x.error).length;
      setRepopulateMsg(`Done: ${totalNew} new items across ${results.length} sources${errors > 0 ? `, ${errors} errors` : ''}.`);
      await loadFeed();
    } catch (e: any) {
      setRepopulateMsg('Repopulate failed: ' + (e.message || 'unknown error'));
    }
    setRepopulating(false);
  }

  async function handleReplenish() {
    setReplenishing(true);
    setReplenishMsg('');
    try {
      const r = await api.replenishFeed();
      if (r.started) {
        // Async — fetches happen in background; reload feed after a short delay
        setReplenishMsg('Fetching in background — new items will appear shortly.');
        setTimeout(async () => { await loadFeed(); setReplenishing(false); }, 4000);
        return;
      }
      setReplenishMsg(r.newItems != null ? `Done — ${r.newItems} new items added.` : 'Replenish complete.');
      await loadFeed();
    } catch (e: any) {
      if (e.status === 429 || (e.message && e.message.includes('429'))) {
        const data = e.data || {};
        const next = data.nextAvailableAt ? new Date(data.nextAvailableAt).toLocaleString() : '';
        setReplenishCooldown(next || 'tomorrow');
        setReplenishMsg('');
      } else {
        setReplenishMsg('Replenish failed: ' + (e.message || 'unknown error'));
      }
    }
    setReplenishing(false);
  }

  function handlePostUpdate(updated: any) {
    setPosts(prev => prev.map(p => p.id === updated.id ? { ...updated, type: 'post' } : p));
    setFeedItems(prev => prev.map(item => item.type === 'post' && item.id === updated.id ? { ...updated, type: 'post' } : item));
  }
  const currentLevel = LEVELS.find(l => l.key === level) || LEVELS[1];
  const currentWorldHome = WORLD_HOME_OPTIONS.find(o => o.key === worldHomeInjection) || WORLD_HOME_OPTIONS[1];

  return (
    <div className="feed-page">
      <h2>Home</h2>
      {!isVerified && (
        <div className="verify-banner">⚠️ Your account is pending verification. You can browse, but posting and interactions are disabled until your account is approved.</div>
      )}
      <div className="feed-controls">
        {preferenceError && <p className="error-msg" role="alert">{preferenceError}</p>}
        <div className="feed-exposure">
          {LEVELS.map(lv => (
            <button key={lv.key} className={`btn btn-sm ${level === lv.key ? 'btn-primary' : 'btn-ghost'}`} onClick={() => handleLevelChange(lv.key)}>{lv.label}</button>
          ))}
        </div>
        <p className="muted" style={{ fontSize: '0.78rem', marginTop: 4 }}>{currentLevel.help}</p>
        <div className="world-home-control">
          <span className="world-home-label">World Feed on Home</span>
          <div className="feed-exposure">
            {WORLD_HOME_OPTIONS.map(opt => (
              <button key={opt.key} className={`btn btn-sm ${worldHomeInjection === opt.key ? 'btn-primary' : 'btn-ghost'}`} onClick={() => handleWorldHomeChange(opt.key)}>{opt.label}</button>
            ))}
          </div>
          <p className="muted" style={{ fontSize: '0.78rem', marginTop: 4 }}>{currentWorldHome.help}</p>
        </div>
      </div>

      {isVerified && level !== 'world' && (
        <form className="post-composer" onSubmit={handlePost}>
          <textarea className="input" placeholder="What's on your mind?" value={content} onChange={e => { setContent(e.target.value); if (partialPostId === null) setSubmissionKey(null); }} rows={3} disabled={partialPostId !== null} />
          {imagePreview && (<div className="image-preview-wrap"><img src={imagePreview} alt="Preview" className="image-preview" /><button type="button" className="btn btn-sm" onClick={removeImage}>✕ Remove</button></div>)}
          <div className="composer-actions">
            <label className="composer-upload-btn">🖼 Image<input type="file" ref={fileInputRef} accept=".jpg,.jpeg,.png,.gif,.webp,image/jpeg,image/png,image/gif,image/webp" onChange={handleFileSelect} style={{ display: 'none' }} /></label>
            <input className="input" placeholder="YouTube link (optional)" value={youtubeUrl} onChange={e => { setYoutubeUrl(e.target.value); setVideoAttachmentKey(null); if (partialPostId === null) setSubmissionKey(null); }} style={{ flex: 1 }} />
            <button className="btn btn-primary" disabled={posting || (partialPostId === null && !content.trim() && !imageFile)}>
              {posting ? 'Working...' : partialPostId !== null ? 'Retry attachment' : 'Post'}
            </button>
          </div>
          {composerError && <p className="error-msg" role="alert">{composerError}</p>}
          {partialPostId !== null && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={dismissFailedAttachments} disabled={posting}>
              Keep post without attachment
            </button>
          )}
          {isYoutubeInvalid && <p className="muted" style={{ fontSize: '0.8rem', marginTop: 4 }}>Paste a valid YouTube link to preview it.</p>}
          {youtubePreview && (<div className="youtube-preview"><div className="youtube-preview-header"><span>🎬 YouTube preview</span><button type="button" className="btn btn-sm btn-ghost" onClick={() => { setYoutubeUrl(''); setVideoAttachmentKey(null); if (partialPostId === null) setSubmissionKey(null); }}>✕ Remove</button></div><div className="post-video-wrap" style={{ maxWidth: 400 }}><iframe src={youtubePreview} allowFullScreen loading="lazy" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture" className="post-video-embed" title="YouTube preview" /></div></div>)}
        </form>
      )}

      {loading ? <p className="muted">Loading...</p> :
        level === 'world' ? (
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => loadFeed()}>↻ Refresh Feed</button>
              {user?.role === 'admin' ? (
                <button className="btn btn-sm" onClick={handleRepopulate} disabled={repopulating}>
                  {repopulating ? 'Fetching sources…' : '🔄 Repopulate World Feed'}
                </button>
              ) : isVerified && (
                <button className="btn btn-ghost btn-sm" onClick={handleReplenish}
                  disabled={replenishing || !!replenishCooldown}
                  title={replenishCooldown ? `Next replenish available: ${replenishCooldown}` : 'Fetch new content from sources (once per day)'}>
                  {replenishing ? 'Fetching…' : replenishCooldown ? `Replenish used (next: ${replenishCooldown})` : '⬇ Replenish Feed'}
                </button>
              )}
              {repopulateMsg && <span className="muted" style={{ fontSize: '0.82rem' }}>{repopulateMsg}</span>}
              {replenishMsg && <span className="muted" style={{ fontSize: '0.82rem' }}>{replenishMsg}</span>}
            </div>
            {worldItems.length === 0
              ? <div className="empty-state">
                  <p>No world feed items have been fetched yet.</p>
                  {user?.role === 'admin'
                    ? <p className="muted">Click "Repopulate World Feed" above, or go to Admin → RSS Sources.</p>
                    : <p className="muted">An admin needs to fetch RSS sources before content appears here.</p>}
                </div>
              : <div className="world-feed-list">{worldItems.map(item => <WorldCard key={item.id} item={item} />)}</div>
            }
          </div>
        ) : feedItems.length === 0 ? (
          <div className="empty-state">
            <p>No posts yet.</p>
            <p className="muted">
              {level === 'everyone'
                ? 'The community feed will show public posts as members start posting. Check back soon, or create the first post!'
                : 'Switch to Community to see all public posts, or follow some members to populate this feed.'}
            </p>
          </div>
        ) : (
          <div className="feed-list">
            {feedItems.map(item => item.type === 'world_item'
              ? <WorldCard key={`world-${item.id}`} item={item} />
              : <PostCard key={`post-${item.id}`} post={item} currentUser={user} onUpdate={handlePostUpdate} />
            )}
          </div>
        )
      }
    </div>
  );
}
