export type PostEntityMutation =
  | { type: 'update'; post: any }
  | { type: 'delete'; postId: number; parentId?: number | null }
  | { type: 'hide-author'; userId: number }
  | { type: 'repost'; postId: number; repost: any };

export function postContainsId(post: any, postId: number): boolean {
  return post?.id === postId || (!!post?.repostedPost && postContainsId(post.repostedPost, postId));
}

export function postContainsAuthor(post: any, userId: number): boolean {
  return post?.userId === userId || (!!post?.repostedPost && postContainsAuthor(post.repostedPost, userId));
}

function reconcilePost(post: any, mutation: PostEntityMutation): any | null {
  if (!post) return post;
  if (mutation.type === 'delete' && postContainsId(post, mutation.postId)) return null;
  if (mutation.type === 'hide-author' && postContainsAuthor(post, mutation.userId)) return null;

  let next = post;
  if (mutation.type === 'delete' && mutation.parentId && post.id === mutation.parentId) {
    next = { ...post, commentCount: Math.max(0, Number(post.commentCount || 0) - 1) };
  }
  if (mutation.type === 'update' && post.id === mutation.post.id) {
    next = { ...post, ...mutation.post };
  } else if (mutation.type === 'repost' && post.id === mutation.postId) {
    next = { ...post, repostCount: Number(post.repostCount || 0) + 1 };
  }

  if (next.repostedPost) {
    const nested = reconcilePost(next.repostedPost, mutation);
    if (!nested) return null;
    if (nested !== next.repostedPost) next = { ...next, repostedPost: nested };
  }
  return next;
}

/** Reconciles top-level and nested copies of a post entity in one collection. */
export function applyPostEntityMutation(posts: any[], mutation: PostEntityMutation): any[] {
  const next: any[] = [];
  for (const post of posts) {
    const reconciled = reconcilePost(post, mutation);
    if (reconciled) next.push(reconciled);
  }
  return next;
}

