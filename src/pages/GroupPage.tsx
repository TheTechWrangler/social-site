import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client';
import PostCard from '../components/PostCard';

export default function GroupPage({ user }: { user: any }) {
  const { id } = useParams<{ id: string }>();
  const [group, setGroup] = useState<any>(null);
  const [members, setMembers] = useState<any[]>([]);
  const [posts, setPosts] = useState<any[]>([]);
  const [content, setContent] = useState('');
  const [isMember, setIsMember] = useState(false);

  useEffect(() => { loadGroup(); }, [id]);

  async function loadGroup() {
    try {
      const r = await api.getGroup(Number(id));
      setGroup(r.group); setMembers(r.members); setPosts(r.posts);
      setIsMember(r.members.some((m: any) => m.id === user.id));
    } catch (e) { console.error(e); }
  }

  async function toggleMembership() {
    try {
      await (isMember ? api.leaveGroup(Number(id)) : api.joinGroup(Number(id)));
      setIsMember(!isMember);
      loadGroup();
    } catch (e) { console.error(e); }
  }

  async function handlePost(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    try {
      await api.createPost(content, Number(id));
      setContent('');
      loadGroup();
    } catch (err) { console.error(err); }
  }

  if (!group) return <div className="loading">Loading...</div>;

  return (
    <div className="group-page">
      <Link to="/groups" className="btn-ghost">← Back to Groups</Link>
      <div className="group-header">
        <h2>{group.name}</h2>
        <p>{group.description}</p>
        <span className="muted">{members.length} members</span>
        <button className={`btn ${isMember ? 'btn-ghost' : 'btn-primary'}`} onClick={toggleMembership}>
          {isMember ? 'Leave' : 'Join'}
        </button>
      </div>

      {isMember && (
        <form className="post-composer" onSubmit={handlePost}>
          <textarea className="input" placeholder="Post to this group..." value={content} onChange={e => setContent(e.target.value)} rows={2} />
          <button className="btn btn-primary" disabled={!content.trim()}>Post</button>
        </form>
      )}

      <h3>Posts</h3>
      {posts.map(p => <PostCard key={p.id} post={p} currentUser={user} />)}
    </div>
  );
}
