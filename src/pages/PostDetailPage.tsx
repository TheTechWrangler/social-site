import { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client';
import PostCard from '../components/PostCard';
import { RouteRequestGate, routeFailureState, routeStateForKey, type RouteLoadState } from '../routeLoadState';
import { applyPostEntityMutation, postContainsAuthor, postContainsId, type PostEntityMutation } from '../postEntityState';

interface Props {
  user: any;
}

export default function PostDetailPage({ user }: Props) {
  const { id } = useParams<{ id: string }>();
  const routeKey = `${id || ''}:${user?.id ?? 'anonymous'}`;
  const currentRouteKey = useRef(routeKey);
  currentRouteKey.current = routeKey;
  const [post, setPost] = useState<any>(null);
  const comments: any[] = post?.comments || [];
  const [loadState, setLoadState] = useState<RouteLoadState>('loading');
  const [stateRouteKey, setStateRouteKey] = useState(routeKey);
  const [commentsLoadState, setCommentsLoadState] = useState<RouteLoadState | 'idle'>('idle');
  const requestGate = useRef(new RouteRequestGate());

  useEffect(() => {
    void loadPost();
    return () => requestGate.current.invalidate();
  }, [routeKey]);

  const [commentCursor, setCommentCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [commentsPageError, setCommentsPageError] = useState('');

  async function loadMoreComments() {
    if (!post || !commentCursor || loadingMore) return;
    const isCurrent = requestGate.current.capture();
    setLoadingMore(true);
    setCommentsPageError('');
    try {
      const response = await api.getComments(post.id, commentCursor);
      if (!isCurrent()) return;
      handlePostMutation({ type: 'comments-loaded', postId: post.id, comments: response.comments, append: true });
      setCommentCursor(response.nextCursor ?? null);
    } catch { if (isCurrent()) setCommentsPageError('Could not load more comments. Please retry.'); }
    finally { if (isCurrent()) setLoadingMore(false); }
  }

  async function loadPost() {
    const requestedRouteKey = routeKey;
    if (currentRouteKey.current !== requestedRouteKey) return;
    const isCurrent = requestGate.current.begin();
    setStateRouteKey(requestedRouteKey);
    setLoadState('loading');
    setLoadingMore(false); setCommentCursor(null);
    setCommentsPageError('');
    setCommentsLoadState('idle');
    setPost(null);

    const postId = Number(id);
    if (!Number.isSafeInteger(postId) || postId <= 0) {
      if (isCurrent()) setLoadState('unavailable');
      return;
    }

    try {
      const response = await api.getPost(postId);
      if (!isCurrent()) return;
      setPost(response.post);
      setLoadState('loaded');
    } catch (error) {
      if (isCurrent()) setLoadState(routeFailureState(error));
      return;
    }

    setCommentsLoadState('loading');
    try {
      const response = await api.getComments(postId);
      if (!isCurrent()) return;
      setPost((previous: any) => previous ? applyPostEntityMutation([previous], {
        type: 'comments-loaded', postId, comments: response.comments || [],
      })[0] : previous);
      setCommentCursor(response.nextCursor ?? null);
      setCommentsLoadState('loaded');
    } catch (error) {
      if (!isCurrent()) return;
      setCommentsLoadState(routeFailureState(error));
    }
  }

  function handlePostMutation(mutation: PostEntityMutation) {
    const removesPrimary = !!post && (
      (mutation.type === 'delete' && postContainsId(post, mutation.postId)) ||
      (mutation.type === 'hide-author' && postContainsAuthor(post, mutation.userId))
    );
    if (removesPrimary) {
      setPost(null);
      setLoadState('unavailable');
      return;
    }
    setPost((previous: any) => previous ? (applyPostEntityMutation([previous], mutation)[0] || null) : previous);
  }

  const visibleLoadState = routeStateForKey(routeKey, stateRouteKey, loadState);
  if (visibleLoadState === 'loading') {
    return <div className="loading">Loading…</div>;
  }
  if (visibleLoadState === 'unavailable') {
    return (
      <div className="post-detail-page">
        <Link to="/" className="btn-ghost">← Home</Link>
        <p className="muted" style={{ marginTop: 24 }}>This post is not available.</p>
      </div>
    );
  }
  if (visibleLoadState === 'error') {
    return (
      <div className="post-detail-page">
        <Link to="/" className="btn-ghost">← Home</Link>
        <p className="error-msg" role="alert">Could not load this post.</p>
        <button className="btn btn-ghost" onClick={() => void loadPost()}>Try again</button>
      </div>
    );
  }
  if (!post) return null;

  return (
    <div className="post-detail-page">
      <Link to="/" className="btn-ghost back-link">← Home</Link>
      <PostCard post={post} currentUser={user} onMutation={handlePostMutation} />
      {commentsLoadState === 'loading' && <div className="loading">Loading comments…</div>}
      {(commentsLoadState === 'error' || commentsLoadState === 'unavailable') && (
        <div>
          <p className="muted">Comments are not available right now.</p>
          <button className="btn btn-ghost" onClick={() => void loadPost()}>Try again</button>
        </div>
      )}
      {commentsLoadState === 'loaded' && comments.length > 0 && (
        <div className="post-detail-comments">
          {commentsPageError && <p className="error-msg" role="alert">{commentsPageError}</p>}
          <h4 className="comments-heading">Comments</h4>
          {commentCursor && <button className="btn btn-ghost" disabled={loadingMore} onClick={() => void loadMoreComments()}>Load more comments</button>}
          {comments.map(c => (
            <PostCard key={c.id} post={c} currentUser={user} onMutation={handlePostMutation} />
          ))}
        </div>
      )}
    </div>
  );
}
