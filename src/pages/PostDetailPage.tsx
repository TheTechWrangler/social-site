import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client';
import PostCard from '../components/PostCard';

interface Props {
  user: any;
}

export default function PostDetailPage({ user }: Props) {
  const { id } = useParams<{ id: string }>();
  const [post, setPost] = useState<any>(null);
  const [comments, setComments] = useState<any[]>([]);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!id) return;
    const postId = Number(id);
    api.getPost(postId)
      .then(r => {
        setPost(r.post);
        return api.getComments(postId);
      })
      .then(r => setComments(r.comments))
      .catch(() => setNotFound(true));
  }, [id]);

  if (notFound) {
    return (
      <div className="post-detail-page">
        <Link to="/" className="btn-ghost">← Home</Link>
        <p className="muted" style={{ marginTop: 24 }}>This post is not available.</p>
      </div>
    );
  }

  if (!post) return <div className="loading">Loading…</div>;

  return (
    <div className="post-detail-page">
      <Link to="/" className="btn-ghost back-link">← Home</Link>
      <PostCard post={post} currentUser={user} />
      {comments.length > 0 && (
        <div className="post-detail-comments">
          <h4 className="comments-heading">Comments</h4>
          {comments.map(c => (
            <PostCard key={c.id} post={c} currentUser={user} />
          ))}
        </div>
      )}
    </div>
  );
}
