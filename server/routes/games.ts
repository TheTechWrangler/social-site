import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, requireVerified, optionalAuth } from '../middleware.js';
import { isBlockedBetween } from '../visibility.js';

const router = Router();

function canDiscoverProfile(viewer: any, player: any): boolean {
  if (!viewer) return player.profile_visibility !== 'private';
  if (viewer.role === 'admin' || viewer.id === player.id) return true;
  if (isBlockedBetween(viewer.id, player.id)) return false;
  if (player.profile_visibility !== 'private') return true;
  return !!getDb().prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(viewer.id, player.id);
}

// GET /api/games — with optional search
router.get('/', (req, res) => {
  const q = (req.query.q as string || '').trim();
  let games;
  if (q) {
    games = getDb().prepare(`
      SELECT g.*, 
        (SELECT COUNT(*) FROM game_lfg_posts WHERE game_id = g.id AND is_active = 1 AND expires_at > datetime('now')) as lfg_count,
        (SELECT COUNT(*) FROM user_game_preferences WHERE game_id = g.id) as player_count,
        (SELECT COUNT(*) FROM game_servers WHERE game_id = g.id AND is_active = 1) as server_count
      FROM games g WHERE g.is_active = 1 AND g.name LIKE ? ORDER BY g.name LIMIT 20
    `).all(`%${q}%`);
  } else {
    games = getDb().prepare(`
      SELECT g.*, 
        (SELECT COUNT(*) FROM game_lfg_posts WHERE game_id = g.id AND is_active = 1 AND expires_at > datetime('now')) as lfg_count,
        (SELECT COUNT(*) FROM user_game_preferences WHERE game_id = g.id) as player_count,
        (SELECT COUNT(*) FROM game_servers WHERE game_id = g.id AND is_active = 1) as server_count
      FROM games g WHERE g.is_active = 1 ORDER BY g.name
    `).all();
  }
  res.json({ games });
});

// GET /api/games/:slug
router.get('/:slug', optionalAuth, (req, res) => {
  const game = getDb().prepare('SELECT * FROM games WHERE slug = ?').get(req.params.slug) as any;
  if (!game) { res.status(404).json({ error: 'Game not found.' }); return; }
  const viewer = (req as any).user || null;
  const viewerDiscoveryEnabled = !!viewer?.game_discovery_enabled;

  const lfgPosts = getDb().prepare(`
    SELECT l.*, u.username, u.display_name, u.avatar_url, u.is_verified, u.profile_visibility
    FROM game_lfg_posts l JOIN users u ON l.user_id = u.id
    WHERE l.game_id = ? AND l.is_active = 1 AND l.expires_at > datetime('now')
    ORDER BY l.created_at DESC LIMIT 50
  `).all(game.id);

  const rawPlayers = viewerDiscoveryEnabled ? getDb().prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar_url, u.is_verified, u.profile_visibility,
      EXISTS (
        SELECT 1 FROM follows f
        WHERE f.follower_id = ? AND f.following_id = u.id
      ) as is_following
    FROM user_game_preferences p JOIN users u ON p.user_id = u.id
    WHERE p.game_id = ?
      AND p.display_on_profile = 1
      AND u.game_discovery_enabled = 1
      AND u.banned = 0
      AND u.is_verified = 1
    ORDER BY p.looking_for_group DESC, p.is_favorite DESC, p.updated_at DESC
    LIMIT 60
  `).all(viewer?.id || 0, game.id) : [];
  const players = rawPlayers.filter((p: any) => canDiscoverProfile(viewer, p)).slice(0, 30);

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

router.get('/:slug/lfg', (req, res) => {
  const game = getDb().prepare('SELECT id FROM games WHERE slug = ?').get(req.params.slug) as any;
  if (!game) { res.status(404).json({ error: 'Game not found.' }); return; }
  const posts = getDb().prepare(`
    SELECT l.*, u.username, u.display_name, u.avatar_url, u.is_verified
    FROM game_lfg_posts l JOIN users u ON l.user_id = u.id
    WHERE l.game_id = ? AND l.is_active = 1 AND l.expires_at > datetime('now') ORDER BY l.created_at DESC LIMIT 50
  `).all(game.id);
  res.json({ posts });
});

router.post('/:slug/lfg', requireAuth, requireVerified, (req, res) => {
  const game = getDb().prepare('SELECT id FROM games WHERE slug = ?').get(req.params.slug) as any;
  if (!game) { res.status(404).json({ error: 'Game not found.' }); return; }
  const { title, body, platform, playStyle, desiredGroupSize, micRequired, durationHours } = req.body;
  if (!title?.trim()) { res.status(400).json({ error: 'Title required.' }); return; }
  const hours = Math.min(Math.max(Number(durationHours) || 6, 1), 24);
  const r = getDb().prepare(
    'INSERT INTO game_lfg_posts (user_id, game_id, title, body, platform, play_style, desired_group_size, mic_required, expires_at) VALUES (?,?,?,?,?,?,?,?, datetime(\'now\', ?))'
  ).run((req as any).user.id, game.id, title.trim(), body || '', platform || '', playStyle || '', desiredGroupSize || null, micRequired ? 1 : 0, `+${hours} hours`);
  const post = getDb().prepare('SELECT * FROM game_lfg_posts WHERE id = ?').get(r.lastInsertRowid);
  res.status(201).json({ post });
});

router.patch('/lfg/:id', requireAuth, (req, res) => {
  const post = getDb().prepare('SELECT * FROM game_lfg_posts WHERE id = ? AND user_id = ?').get(req.params.id, (req as any).user.id) as any;
  if (!post) { res.status(404).json({ error: 'Not found or not yours.' }); return; }
  const { title, body, platform, playStyle, desiredGroupSize, micRequired, isActive } = req.body;
  getDb().prepare(`
    UPDATE game_lfg_posts SET title=COALESCE(?,title), body=COALESCE(?,body), platform=COALESCE(?,platform),
    play_style=COALESCE(?,play_style), desired_group_size=COALESCE(?,desired_group_size),
    mic_required=COALESCE(?,mic_required), is_active=COALESCE(?,is_active), updated_at=datetime('now')
    WHERE id=?
  `).run(title, body, platform, playStyle, desiredGroupSize, micRequired, isActive, req.params.id);
  res.json({ ok: true });
});

router.delete('/lfg/:id', requireAuth, (req, res) => {
  const user = (req as any).user;
  const post = getDb().prepare('SELECT * FROM game_lfg_posts WHERE id = ?').get(req.params.id) as any;
  if (!post) { res.status(404).json({ error: 'Not found.' }); return; }
  if (post.user_id !== user.id && user.role !== 'admin') { res.status(403).json({ error: 'Not authorized.' }); return; }
  getDb().prepare('DELETE FROM game_lfg_posts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

const ALLOWED_EXTEND_HOURS = new Set([1, 3, 6, 12, 24]);

// POST /api/games/lfg/:id/extend — extend or reactivate an LFG post
router.post('/lfg/:id/extend', requireAuth, (req, res) => {
  const user = (req as any).user;
  const post = getDb().prepare('SELECT * FROM game_lfg_posts WHERE id = ?').get(req.params.id) as any;
  if (!post) { res.status(404).json({ error: 'Not found.' }); return; }
  if (post.user_id !== user.id && user.role !== 'admin') { res.status(403).json({ error: 'Not authorized.' }); return; }
  const hours = Number(req.body.durationHours);
  if (!ALLOWED_EXTEND_HOURS.has(hours)) {
    res.status(400).json({ error: 'durationHours must be 1, 3, 6, 12, or 24.' }); return;
  }
  // Extend from current expiry (or from now if already expired), then reactivate.
  getDb().prepare(`
    UPDATE game_lfg_posts
    SET expires_at = datetime(max(expires_at, datetime('now')), ?),
        is_active = 1,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(`+${hours} hours`, post.id);
  const updated = getDb().prepare('SELECT * FROM game_lfg_posts WHERE id = ?').get(post.id);
  res.json({ post: updated });
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
  getDb().prepare(`
    INSERT INTO user_game_preferences (user_id, game_id, platform, play_style, skill_level, mic_preference, usual_play_times, region_or_timezone, looking_for_group, notes, is_favorite, display_on_profile)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id, game_id) DO UPDATE SET platform=excluded.platform, play_style=excluded.play_style,
    skill_level=excluded.skill_level, mic_preference=excluded.mic_preference, usual_play_times=excluded.usual_play_times,
    region_or_timezone=excluded.region_or_timezone, looking_for_group=excluded.looking_for_group, notes=excluded.notes,
    is_favorite=excluded.is_favorite, display_on_profile=excluded.display_on_profile, updated_at=datetime('now')
  `).run((req as any).user.id, game.id, platform || '', playStyle || '', skillLevel || '', micPreference || '',
    usualPlayTimes || '', regionOrTimezone || '', lookingForGroup ? 1 : 0, notes || '', isFavorite ? 1 : 0, displayOnProfile !== false ? 1 : 0);
  const prefs = getDb().prepare('SELECT * FROM user_game_preferences WHERE user_id = ? AND game_id = ?')
    .get((req as any).user.id, game.id);
  res.status(201).json({ profile: prefs });
});

export default router;

// DELETE /api/games/:slug/profile
router.delete('/:slug/profile', requireAuth, (req, res) => {
  const game = getDb().prepare('SELECT id FROM games WHERE slug = ?').get(req.params.slug) as any;
  if (!game) { res.status(404).json({ error: 'Game not found.' }); return; }
  getDb().prepare('DELETE FROM user_game_preferences WHERE user_id = ? AND game_id = ?').run((req as any).user.id, game.id);
  res.json({ ok: true });
});
