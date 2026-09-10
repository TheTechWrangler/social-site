import { Router, type Response } from 'express';
import { getDb } from '../database.js';
import { requireAuth, requireVerified, optionalAuth } from '../middleware.js';
import { notMutedByViewerSql, userVisibilitySql } from '../visibility.js';
import { validateLfgCreate, validateLfgExtend, validateLfgPatch } from '../lfgValidation.js';
import { positiveIntegerParam, validationErrorMessage } from '../requestValidation.js';

const router = Router();

function sendValidationFailure(res: Response, error: unknown): boolean {
  const message = validationErrorMessage(error);
  if (!message) return false;
  res.status(400).json({ error: message });
  return true;
}

// GET /api/games — with optional search
router.get('/', optionalAuth, (req, res) => {
  const q = (req.query.q as string || '').trim();
  const lfgAuthor = userVisibilitySql((req as any).user, 'lu', 'public-context');
  const playerProfile = userVisibilitySql((req as any).user, 'pu', 'profile');
  const sql = `
    SELECT g.*,
      (
        SELECT COUNT(*) FROM game_lfg_posts gl
        JOIN users lu ON gl.user_id = lu.id
        WHERE gl.game_id = g.id AND gl.is_active = 1
          AND gl.expires_at > datetime('now') AND ${lfgAuthor.sql}
      ) as lfg_count,
      (
        SELECT COUNT(*) FROM user_game_preferences up
        JOIN users pu ON up.user_id = pu.id
        WHERE up.game_id = g.id AND up.display_on_profile = 1
          AND pu.game_discovery_enabled = 1 AND pu.is_verified = 1
          AND ${playerProfile.sql}
      ) as player_count,
      (SELECT COUNT(*) FROM game_servers WHERE game_id = g.id AND is_active = 1) as server_count
    FROM games g
    WHERE g.is_active = 1 ${q ? 'AND g.name LIKE ?' : ''}
    ORDER BY g.name ${q ? 'LIMIT 20' : ''}
  `;
  const games = getDb().prepare(sql).all(
    ...lfgAuthor.params,
    ...playerProfile.params,
    ...(q ? [`%${q}%`] : []),
  );
  res.json({ games });
});

// GET /api/games/:slug
router.get('/:slug', optionalAuth, (req, res) => {
  const game = getDb().prepare('SELECT * FROM games WHERE slug = ?').get(req.params.slug) as any;
  if (!game) { res.status(404).json({ error: 'Game not found.' }); return; }
  const viewer = (req as any).user || null;
  const viewerDiscoveryEnabled = !!viewer?.game_discovery_enabled;

  const lfgAuthor = userVisibilitySql(viewer, 'u', 'public-context');
  const lfgNotMuted = notMutedByViewerSql(viewer, 'u');
  const lfgPosts = getDb().prepare(`
    SELECT l.*, u.username, u.display_name, u.avatar_url
    FROM game_lfg_posts l JOIN users u ON l.user_id = u.id
    WHERE l.game_id = ? AND l.is_active = 1 AND l.expires_at > datetime('now')
      AND ${lfgAuthor.sql}
      AND ${lfgNotMuted.sql}
    ORDER BY l.created_at DESC LIMIT 50
  `).all(game.id, ...lfgAuthor.params, ...lfgNotMuted.params);

  const playerProfile = userVisibilitySql(viewer, 'u', 'profile');
  const playerNotMuted = notMutedByViewerSql(viewer, 'u');
  const rawPlayers = viewerDiscoveryEnabled ? getDb().prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar_url, u.is_verified,
      EXISTS (
        SELECT 1 FROM follows f
        WHERE f.follower_id = ? AND f.following_id = u.id
      ) as is_following
    FROM user_game_preferences p JOIN users u ON p.user_id = u.id
    WHERE p.game_id = ?
      AND p.display_on_profile = 1
      AND u.game_discovery_enabled = 1
      AND u.is_verified = 1
      AND ${playerProfile.sql}
      AND ${playerNotMuted.sql}
    ORDER BY p.looking_for_group DESC, p.is_favorite DESC, p.updated_at DESC
    LIMIT 30
  `).all(
    viewer?.id || 0,
    game.id,
    ...playerProfile.params,
    ...playerNotMuted.params,
  ) : [];
  const players = rawPlayers;

  const servers = getDb().prepare(
    'SELECT * FROM game_servers WHERE game_id = ? AND is_active = 1 ORDER BY is_featured DESC, name'
  ).all(game.id);

  res.json({ game, lfgPosts, players, servers, viewerDiscoveryEnabled });
});

// GET /api/games/:slug/servers
router.get('/:slug/servers', (req, res) => {
  const game = getDb().prepare('SELECT id FROM games WHERE slug = ?').get(req.params.slug) as any;
  if (!game) { res.status(404).json({ error: 'Game not found.' }); return; }
  const servers = getDb().prepare(
    'SELECT * FROM game_servers WHERE game_id = ? AND is_active = 1 ORDER BY is_featured DESC, name'
  ).all(game.id);
  res.json({ servers });
});

// ─── LFG Posts ───

router.get('/:slug/lfg', optionalAuth, (req, res) => {
  const game = getDb().prepare('SELECT id FROM games WHERE slug = ?').get(req.params.slug) as any;
  if (!game) { res.status(404).json({ error: 'Game not found.' }); return; }
  const authorVisibility = userVisibilitySql((req as any).user, 'u', 'public-context');
  const notMuted = notMutedByViewerSql((req as any).user, 'u');
  const posts = getDb().prepare(`
    SELECT l.*, u.username, u.display_name, u.avatar_url
    FROM game_lfg_posts l JOIN users u ON l.user_id = u.id
    WHERE l.game_id = ? AND l.is_active = 1 AND l.expires_at > datetime('now')
      AND ${authorVisibility.sql}
      AND ${notMuted.sql}
    ORDER BY l.created_at DESC LIMIT 50
  `).all(game.id, ...authorVisibility.params, ...notMuted.params);
  res.json({ posts });
});

const SHORT_FIELD_MAX = 80;
const NOTES_MAX = 500;

router.post('/:slug/lfg', requireAuth, requireVerified, (req, res) => {
  try {
    const game = getDb().prepare('SELECT id FROM games WHERE slug = ?').get(req.params.slug) as any;
    if (!game) { res.status(404).json({ error: 'Game not found.' }); return; }
    const input = validateLfgCreate(req.body);
    const r = getDb().prepare(
      'INSERT INTO game_lfg_posts (user_id, game_id, title, body, platform, play_style, desired_group_size, mic_required, expires_at) VALUES (?,?,?,?,?,?,?,?, datetime(\'now\', ?))'
    ).run((req as any).user.id, game.id, input.title, input.body, input.platform, input.playStyle,
      input.desiredGroupSize, input.micRequired ? 1 : 0, `+${input.durationHours} hours`);
    const post = getDb().prepare('SELECT * FROM game_lfg_posts WHERE id = ?').get(r.lastInsertRowid);
    res.status(201).json({ post });
  } catch (error) {
    if (!sendValidationFailure(res, error)) throw error;
  }
});

router.patch('/lfg/:id', requireAuth, (req, res) => {
  try {
    const user = (req as any).user;
    const postId = positiveIntegerParam(req.params.id, 'LFG id');
    const post = getDb().prepare('SELECT * FROM game_lfg_posts WHERE id = ? AND user_id = ?').get(postId, user.id) as any;
    if (!post) { res.status(404).json({ error: 'Not found or not yours.' }); return; }
    const input = validateLfgPatch(req.body);
    if (input.isActive === true && post.is_active !== 1 && user.role !== 'admin' && !user.is_verified) {
      res.status(403).json({ error: 'Account verification required to reactivate an LFG post.' }); return;
    }

    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (input.title !== undefined) { sets.push('title = ?'); values.push(input.title); }
    if (input.body !== undefined) { sets.push('body = ?'); values.push(input.body); }
    if (input.platform !== undefined) { sets.push('platform = ?'); values.push(input.platform); }
    if (input.playStyle !== undefined) { sets.push('play_style = ?'); values.push(input.playStyle); }
    if (input.desiredGroupSize !== undefined) { sets.push('desired_group_size = ?'); values.push(input.desiredGroupSize); }
    if (input.micRequired !== undefined) { sets.push('mic_required = ?'); values.push(input.micRequired ? 1 : 0); }
    if (input.isActive !== undefined) { sets.push('is_active = ?'); values.push(input.isActive ? 1 : 0); }
    sets.push("updated_at = datetime('now')");
    values.push(postId, user.id);
    const updated = getDb().prepare(`UPDATE game_lfg_posts SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);
    if (updated.changes !== 1) { res.status(404).json({ error: 'Not found or not yours.' }); return; }
    const updatedPost = getDb().prepare('SELECT * FROM game_lfg_posts WHERE id = ? AND user_id = ?').get(postId, user.id);
    res.json({ ok: true, post: updatedPost });
  } catch (error) {
    if (!sendValidationFailure(res, error)) throw error;
  }
});

router.delete('/lfg/:id', requireAuth, (req, res) => {
  try {
    const user = (req as any).user;
    const postId = positiveIntegerParam(req.params.id, 'LFG id');
    const deleted = getDb().prepare(`
      DELETE FROM game_lfg_posts
      WHERE id = ? AND (user_id = ? OR ? = 'admin')
    `).run(postId, user.id, user.role);
    if (deleted.changes !== 1) { res.status(404).json({ error: 'Not found.' }); return; }
    res.json({ ok: true });
  } catch (error) {
    if (!sendValidationFailure(res, error)) throw error;
  }
});

// POST /api/games/lfg/:id/extend — extend or reactivate an LFG post
router.post('/lfg/:id/extend', requireAuth, requireVerified, (req, res) => {
  try {
    const user = (req as any).user;
    const postId = positiveIntegerParam(req.params.id, 'LFG id');
    const post = getDb().prepare(`
      SELECT * FROM game_lfg_posts
      WHERE id = ? AND (user_id = ? OR ? = 'admin')
    `).get(postId, user.id, user.role) as any;
    if (!post) { res.status(404).json({ error: 'Not found.' }); return; }
    const { durationHours } = validateLfgExtend(req.body);
    // Extend from current expiry (or from now if already expired), then reactivate.
    const result = getDb().prepare(`
      UPDATE game_lfg_posts
      SET expires_at = datetime(max(expires_at, datetime('now')), ?),
          is_active = 1,
          updated_at = datetime('now')
      WHERE id = ? AND (user_id = ? OR ? = 'admin')
    `).run(`+${durationHours} hours`, postId, user.id, user.role);
    if (result.changes !== 1) { res.status(404).json({ error: 'Not found.' }); return; }
    const updated = getDb().prepare('SELECT * FROM game_lfg_posts WHERE id = ?').get(postId);
    res.json({ post: updated });
  } catch (error) {
    if (!sendValidationFailure(res, error)) throw error;
  }
});

// GET /api/games/:slug/lfg/mine — viewer's own LFG posts for this game (active + expired)
router.get('/:slug/lfg/mine', requireAuth, (req, res) => {
  const game = getDb().prepare('SELECT id FROM games WHERE slug = ?').get(req.params.slug) as any;
  if (!game) { res.status(404).json({ error: 'Game not found.' }); return; }
  const posts = getDb().prepare(`
    SELECT * FROM game_lfg_posts
    WHERE game_id = ? AND user_id = ?
    ORDER BY created_at DESC LIMIT 20
  `).all(game.id, (req as any).user.id);
  res.json({ posts });
});

// ─── Player Preferences ───

router.get('/:slug/profile', requireAuth, (req, res) => {
  const game = getDb().prepare('SELECT id FROM games WHERE slug = ?').get(req.params.slug) as any;
  if (!game) { res.status(404).json({ error: 'Game not found.' }); return; }
  const prefs = getDb().prepare('SELECT * FROM user_game_preferences WHERE user_id = ? AND game_id = ?')
    .get((req as any).user.id, game.id);
  res.json({ profile: prefs || null });
});

router.post('/:slug/profile', requireAuth, requireVerified, (req, res) => {
  const game = getDb().prepare('SELECT id FROM games WHERE slug = ?').get(req.params.slug) as any;
  if (!game) { res.status(404).json({ error: 'Game not found.' }); return; }
  const { platform, playStyle, skillLevel, micPreference, usualPlayTimes, regionOrTimezone, lookingForGroup, notes, isFavorite, displayOnProfile } = req.body;
  const s = (v: any) => (v || '').toString().trim().slice(0, SHORT_FIELD_MAX);
  getDb().prepare(`
    INSERT INTO user_game_preferences (user_id, game_id, platform, play_style, skill_level, mic_preference, usual_play_times, region_or_timezone, looking_for_group, notes, is_favorite, display_on_profile)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id, game_id) DO UPDATE SET platform=excluded.platform, play_style=excluded.play_style,
    skill_level=excluded.skill_level, mic_preference=excluded.mic_preference, usual_play_times=excluded.usual_play_times,
    region_or_timezone=excluded.region_or_timezone, looking_for_group=excluded.looking_for_group, notes=excluded.notes,
    is_favorite=excluded.is_favorite, display_on_profile=excluded.display_on_profile, updated_at=datetime('now')
  `).run((req as any).user.id, game.id, s(platform), s(playStyle), s(skillLevel), s(micPreference),
    s(usualPlayTimes), s(regionOrTimezone), lookingForGroup ? 1 : 0, (notes || '').toString().trim().slice(0, NOTES_MAX),
    isFavorite ? 1 : 0, displayOnProfile !== false ? 1 : 0);
  const prefs = getDb().prepare('SELECT * FROM user_game_preferences WHERE user_id = ? AND game_id = ?')
    .get((req as any).user.id, game.id);
  res.status(201).json({ profile: prefs });
});

// DELETE /api/games/:slug/profile
router.delete('/:slug/profile', requireAuth, (req, res) => {
  const game = getDb().prepare('SELECT id FROM games WHERE slug = ?').get(req.params.slug) as any;
  if (!game) { res.status(404).json({ error: 'Game not found.' }); return; }
  getDb().prepare('DELETE FROM user_game_preferences WHERE user_id = ? AND game_id = ?').run((req as any).user.id, game.id);
  res.json({ ok: true });
});

export default router;
