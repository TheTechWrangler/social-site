import { useState, useEffect } from 'react';
import { api } from '../api/client';
import PostCard from '../components/PostCard';

export default function HomePage({ user }: { user: any }) {
  const [posts, setPosts] = useState<any[]>([]);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);

  useEffect(() => { loadFeed(); }, []);

  async function loadFeed() {
    try {
      const r = await api.feed({ mode: 'following' });
      setPosts(r.posts);
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  async function handlePost(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    setPosting(true);
    try {
      await api.createPost(content.trim());
      setContent('');
      await loadFeed();
    } catch (e) { console.error(e); }
    setPosting(false);
  }

  function handlePostUpdate(updated: any) {
    setPosts(prev => prev.map(p => p.id === updated.id ? updated : p));
  }

  return (
    <div className="feed-page">
      <h2>Home</h2>
      <form className="post-composer" onSubmit={handlePost}>
        <textarea className="input" placeholder="What's on your mind?" value={content} onChange={e => setContent(e.target.value)} rows={3} />
        <button className="btn btn-primary" disabled={posting || !content.trim()}>{posting ? 'Posting...' : 'Post'}</button>
      </form>

      {loading ? <p className="muted">Loading...</p> : posts.length === 0 ? (
        <div className="empty-state">
          <p>No posts yet.</p>
          <p className="muted">Follow some users or create your first post!</p>
        </div>
      ) : (
        <div className="feed-list">
          {posts.map(p => <PostCard key={p.id} post={p} currentUser={user} onUpdate={handlePostUpdate} />)}
        </div>
      )}
    </div>
  );
}
