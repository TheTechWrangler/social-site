import { userVisibilitySql, type Viewer } from './visibility.js';

/** SQL equivalent of notification source policy, including at most 64 ancestors.
 * Every alias/expression is server-owned; no request text enters SQL structure.
 */
export function notificationEligibility(viewer: Viewer) {
  const actor = userVisibilitySql(viewer, 'actor', 'identity');
  const profile = userVisibilitySql(viewer, 'pu', 'profile');
  const context = userVisibilitySql(viewer, 'pu', 'public-context');
  const allowed = `p.hidden = 0 AND (
    ((p.parent_id IS NOT NULL OR p.group_id IS NOT NULL) AND ${context.sql}) OR
    (p.parent_id IS NULL AND p.group_id IS NULL AND ${profile.sql}))`;
  return {
    sql: `n.user_id = ? AND ${actor.sql} AND (
      (n.type = 'follow' AND EXISTS (SELECT 1 FROM follows f
        WHERE f.follower_id = n.actor_id AND f.following_id = n.user_id AND f.status = 'accepted'))
      OR (n.type = 'group_invite' AND EXISTS (SELECT 1 FROM groups_table g WHERE g.id = n.group_id))
      OR (n.type IN ('like', 'comment', 'repost') AND (
        n.type = 'comment' OR
        (source.user_id = n.user_id AND n.type = 'like' AND EXISTS (SELECT 1 FROM likes l WHERE l.user_id = n.actor_id AND l.post_id = n.post_id)) OR
        (source.user_id = n.user_id AND n.type = 'repost' AND EXISTS (SELECT 1 FROM posts rp WHERE rp.user_id = n.actor_id AND rp.repost_of = n.post_id))
      ) AND EXISTS (
        WITH RECURSIVE chain(id, parent_id, allowed, depth) AS (
          SELECT p.id, p.parent_id, (${allowed}), 0
          FROM posts p JOIN users pu ON pu.id = p.user_id WHERE p.id = n.post_id
          UNION ALL
          SELECT p.id, p.parent_id, (${allowed}), chain.depth + 1
          FROM chain JOIN posts p ON p.id = chain.parent_id JOIN users pu ON pu.id = p.user_id
          WHERE chain.allowed = 1 AND chain.depth < 63
        ) SELECT 1 FROM chain WHERE parent_id IS NULL AND allowed = 1
      ))
    )`,
    params: [viewer.id, ...actor.params, ...context.params, ...profile.params, ...context.params, ...profile.params],
  };
}
