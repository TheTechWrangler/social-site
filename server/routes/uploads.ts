import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '../database.js';
import { ensureUploadsDirectory, getStorageConfig } from '../config.js';
import { optionalAuth, requireAuth, requireVerified } from '../middleware.js';
import { canViewPost } from '../visibility.js';
import { logUsage } from '../usageEvents.js';
import { PENDING_ASSET_TTL_MS } from '../assetLifecycle.js';
import type { Request, Response, NextFunction } from 'express';

const storageConfig = getStorageConfig();
ensureUploadsDirectory(storageConfig);
const UPLOADS_DIR = storageConfig.uploadsDir;
const IMAGE_UPLOAD_ERROR = 'Invalid image file.';
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const ALLOWED_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const ALLOWED_EXT_BY_MIME: Record<string, Set<string>> = {
  'image/jpeg': new Set(['.jpg', '.jpeg']),
  'image/png': new Set(['.png']),
  'image/gif': new Set(['.gif']),
  'image/webp': new Set(['.webp']),
};
const IMAGE_CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// ─── Feature Flags ───
function isEnabled(flag: string, def: string): boolean {
  return (process.env[flag] || def).toLowerCase() === 'true';
}

// ─── Multer Config (images only) ───
const imageUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `asset-${randomBytes(16).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: (parseInt(process.env.MAX_IMAGE_UPLOAD_MB || '5', 10)) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mimetype = (file.mimetype || '').toLowerCase();
    if (mimetype === 'image/svg+xml' || ext === '.svg') {
      cb(new Error(IMAGE_UPLOAD_ERROR)); return;
    }
    if (ALLOWED_IMAGE_MIME.has(mimetype) && ALLOWED_IMAGE_EXT.has(ext)) { cb(null, true); }
    else { cb(new Error(IMAGE_UPLOAD_ERROR)); }
  },
});

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `asset-${randomBytes(16).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: (parseInt(process.env.MAX_AVATAR_UPLOAD_MB || '2', 10)) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mimetype = (file.mimetype || '').toLowerCase();
    if (mimetype === 'image/svg+xml' || ext === '.svg') {
      cb(new Error(IMAGE_UPLOAD_ERROR)); return;
    }
    if (ALLOWED_IMAGE_MIME.has(mimetype) && ALLOWED_IMAGE_EXT.has(ext)) { cb(null, true); }
    else { cb(new Error(IMAGE_UPLOAD_ERROR)); }
  },
});

function handleImageUpload(req: Request, res: Response, next: NextFunction): void {
  imageUpload.single('file')(req, res, (err: any) => {
    if (err) {
      res.status(400).json({ error: IMAGE_UPLOAD_ERROR });
      return;
    }
    next();
  });
}

function handleAvatarUpload(req: Request, res: Response, next: NextFunction): void {
  avatarUpload.single('file')(req, res, (err: any) => {
    if (err) {
      res.status(400).json({ error: IMAGE_UPLOAD_ERROR });
      return;
    }
    next();
  });
}

function requireImageUploadsEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (!isEnabled('ENABLE_IMAGE_UPLOADS', 'true')) {
    res.status(403).json({ error: 'Image uploads are currently disabled.' });
    return;
  }
  next();
}

function isPathInUploads(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return resolved.startsWith(UPLOADS_DIR + path.sep);
}

function validDimensions(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= 20_000 && height <= 20_000 && width * height <= 40_000_000;
}

function detectImageMime(bytes: Buffer): string | null {
  if (
    bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
  ) return 'image/jpeg';
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
    bytes.subarray(12, 16).toString('ascii') === 'IHDR' &&
    validDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
  ) return 'image/png';
  if (bytes.length >= 10) {
    const sig = bytes.subarray(0, 6).toString('ascii');
    if ((sig === 'GIF87a' || sig === 'GIF89a') && validDimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8))) {
      return 'image/gif';
    }
  }
  if (
    bytes.length >= 16 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP' && bytes.readUInt32LE(4) + 8 <= bytes.length
  ) return 'image/webp';
  return null;
}

function deleteRejectedUpload(file?: Express.Multer.File): void {
  if (!file?.path) return;
  const filePath = path.resolve(file.path);
  if (!isPathInUploads(filePath)) return;
  try { fs.unlinkSync(filePath); } catch { /* best-effort cleanup for rejected temp upload */ }
}

function getValidUploadedImageMime(file: Express.Multer.File): string | null {
  if (!file.path || !isPathInUploads(file.path)) return null;
  const ext = path.extname(file.originalname).toLowerCase();
  const claimedMime = (file.mimetype || '').toLowerCase();
  if (!ALLOWED_IMAGE_MIME.has(claimedMime) || !ALLOWED_IMAGE_EXT.has(ext)) return null;

  const detectedMime = detectImageMime(fs.readFileSync(file.path));
  if (!detectedMime || detectedMime !== claimedMime) return null;
  return ALLOWED_EXT_BY_MIME[detectedMime]?.has(ext) ? detectedMime : null;
}

function newAssetId(): string {
  return randomBytes(16).toString('hex');
}

function uploadedFileSha256(file: Express.Multer.File): string {
  return createHash('sha256').update(fs.readFileSync(file.path)).digest('hex');
}

function serializeMedia(row: any) {
  return {
    id: row.id,
    post_id: row.post_id,
    media_type: row.media_type,
    url: row.url,
    provider: row.provider ?? null,
    original_url: row.original_url ?? null,
    mime_type: row.mime_type ?? null,
    file_size_bytes: row.file_size_bytes ?? null,
    asset_id: row.asset_id ?? null,
    alt_text: row.alt_text ?? '',
  };
}

function validateUploadedImageBytes(req: Request, res: Response, next: NextFunction): void {
  if (!req.file) { next(); return; }
  try {
    const detectedMime = getValidUploadedImageMime(req.file);
    if (detectedMime) {
      req.file.mimetype = detectedMime;
      next();
      return;
    }
  } catch (err: any) {
    console.warn('[uploads] Image byte validation failed:', err.message);
  }
  deleteRejectedUpload(req.file);
  res.status(400).json({ error: IMAGE_UPLOAD_ERROR });
}

const router = Router();

// POST /api/uploads/avatar — create and atomically assign an owned avatar.
// Avatar ownership is established by the authenticated upload itself; existing
// local URLs can never be adopted through client-supplied profile data.
router.post('/avatar', requireAuth, requireImageUploadsEnabled, handleAvatarUpload, validateUploadedImageBytes, (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'No image file provided.' }); return; }

  const user = (req as any).user;
  const url = `/uploads/${req.file.filename}`;
  try {
    const assignAvatar = getDb().transaction(() => {
      const nowMs = Date.now();
      const assetId = newAssetId();
      getDb().prepare(`
        INSERT INTO managed_assets (
          id, owner_user_id, storage_key, url, media_type, mime_type,
          file_size_bytes, sha256, purpose, state, created_at_ms
        ) VALUES (?, ?, ?, ?, 'image', ?, ?, ?, 'avatar', 'active', ?)
      `).run(
        assetId, user.id, req.file!.filename, url, req.file!.mimetype,
        req.file!.size, uploadedFileSha256(req.file!), nowMs,
      );
      const result = getDb().prepare(`
        INSERT INTO user_avatar_uploads (user_id, asset_id, url, mime_type, file_size_bytes)
        VALUES (?, ?, ?, ?, ?)
      `).run(user.id, assetId, url, req.file!.mimetype, req.file!.size);
      getDb().prepare("UPDATE users SET avatar_url = ?, updated_at = datetime('now') WHERE id = ?")
        .run(url, user.id);
      // Removing a prior managed reference marks its asset reclaimable. Legacy
      // rows remain untouched because their ownership cannot be inferred.
      getDb().prepare(`
        DELETE FROM user_avatar_uploads
        WHERE user_id = ? AND asset_id IS NOT NULL AND asset_id <> ?
      `).run(user.id, assetId);
      return { id: Number(result.lastInsertRowid), assetId };
    });
    const assigned = assignAvatar();

    logUsage({ eventType: 'upload_completed', userId: user.id, featureArea: 'profile' });
    res.status(201).json({
      media: {
        id: assigned.id,
        post_id: null,
        media_type: 'image',
        url,
        provider: null,
        original_url: null,
        mime_type: req.file.mimetype,
        file_size_bytes: req.file.size,
        asset_id: assigned.assetId,
      },
      asset: { id: assigned.assetId, url, purpose: 'avatar', state: 'active' },
    });
  } catch (err: any) {
    deleteRejectedUpload(req.file);
    logUsage({ eventType: 'upload_failed', userId: user.id, featureArea: 'profile', errorCode: 'SERVER_ERROR' });
    console.error('[uploads] Avatar upload error:', err.message);
    res.status(500).json({ error: 'Avatar upload failed.' });
  }
});

// ─── YouTube URL Detection ───
function parseYouTubeUrl(input: string): string | null {
  const trimmed = input.trim();
  const patterns = [
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
    /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = trimmed.match(p);
    if (m) return `https://www.youtube.com/embed/${m[1]}`;
  }
  return null;
}

// POST /api/uploads/image — create an owned pending image asset.
router.post('/image', requireAuth, requireVerified, requireImageUploadsEnabled, handleImageUpload, validateUploadedImageBytes, (req, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'No image file provided.' }); return; }
    // The former combined upload/attach input created files before target
    // authorization and had no durable retry identity.
    if (req.body.postId !== undefined) {
      deleteRejectedUpload(req.file);
      res.status(400).json({ error: 'Upload the image first, then attach it by asset ID.' });
      return;
    }

    const user = (req as any).user;
    const url = `/uploads/${req.file.filename}`;
    const nowMs = Date.now();
    const assetId = newAssetId();
    getDb().prepare(`
      INSERT INTO managed_assets (
        id, owner_user_id, storage_key, url, media_type, mime_type,
        file_size_bytes, sha256, purpose, state, created_at_ms,
        pending_expires_at_ms
      ) VALUES (?, ?, ?, ?, 'image', ?, ?, ?, 'pending_post_image', 'pending', ?, ?)
    `).run(
      assetId, user.id, req.file.filename, url, req.file.mimetype,
      req.file.size, uploadedFileSha256(req.file), nowMs, nowMs + PENDING_ASSET_TTL_MS,
    );

    logUsage({ eventType: 'upload_completed', userId: user.id, featureArea: 'feed' });
    res.status(201).json({
      asset: {
        id: assetId,
        url,
        media_type: 'image',
        mime_type: req.file.mimetype,
        file_size_bytes: req.file.size,
        purpose: 'pending_post_image',
        state: 'pending',
        expires_at_ms: nowMs + PENDING_ASSET_TTL_MS,
      },
    });
  } catch (err: any) {
    deleteRejectedUpload(req.file);
    logUsage({ eventType: 'upload_failed', userId: (req as any).user?.id ?? null, featureArea: 'feed', errorCode: 'SERVER_ERROR' });
    console.error('[uploads] Image upload error:', err.message);
    res.status(500).json({ error: 'Image upload failed.' });
  }
});

// POST /api/uploads/assets/:assetId/attach — atomically activate an owned
// pending image and establish its one durable post relationship. Repeating the
// operation returns the existing relationship.
router.post('/assets/:assetId/attach', requireAuth, requireVerified, requireImageUploadsEnabled, (req, res) => {
  const assetId = String(req.params.assetId || '');
  const postId = Number(req.body?.postId);
  if (!/^[a-f0-9]{32}$/.test(assetId) || !Number.isSafeInteger(postId) || postId <= 0) {
    res.status(400).json({ error: 'Invalid attachment request.' });
    return;
  }
  const user = (req as any).user;
  try {
    const attach = getDb().transaction(() => {
      const post = getDb().prepare(
        'SELECT id FROM posts WHERE id = ? AND user_id = ? AND hidden = 0'
      ).get(postId, user.id) as any;
      if (!post) return { status: 404, error: 'Post not found.' };

      const asset = getDb().prepare(`
        SELECT * FROM managed_assets WHERE id = ? AND owner_user_id = ?
      `).get(assetId, user.id) as any;
      if (!asset) return { status: 404, error: 'Asset not found.' };

      const existing = getDb().prepare('SELECT * FROM post_media WHERE asset_id = ? LIMIT 1')
        .get(assetId) as any;
      if (existing) {
        if (existing.post_id !== postId || asset.state !== 'active' || asset.purpose !== 'post_image') {
          return { status: 409, error: 'Asset is already attached.' };
        }
        return { status: 200, media: serializeMedia(existing), replayed: true };
      }

      const nowMs = Date.now();
      if (
        asset.state !== 'pending' || asset.purpose !== 'pending_post_image' ||
        asset.pending_expires_at_ms == null || Number(asset.pending_expires_at_ms) <= nowMs
      ) {
        if (asset.state === 'pending') {
          getDb().prepare(`
            UPDATE managed_assets SET state = 'reclaimable', detached_at_ms = ?, reclaim_after_ms = ?
            WHERE id = ? AND state = 'pending'
          `).run(nowMs, nowMs + 24 * 60 * 60 * 1000, assetId);
        }
        return { status: 410, error: 'Asset is no longer available.' };
      }

      const altText = typeof req.body?.altText === 'string'
        ? req.body.altText.trim().slice(0, 500)
        : '';
      const inserted = getDb().prepare(`
        INSERT INTO post_media (
          post_id, asset_id, media_type, url, mime_type, file_size_bytes, alt_text
        ) VALUES (?, ?, 'image', ?, ?, ?, ?)
      `).run(postId, assetId, asset.url, asset.mime_type, asset.file_size_bytes, altText);
      getDb().prepare(`
        UPDATE managed_assets
        SET purpose = 'post_image', state = 'active', pending_expires_at_ms = NULL, alt_text = ?
        WHERE id = ?
      `).run(altText, assetId);
      const media = getDb().prepare('SELECT * FROM post_media WHERE id = ?')
        .get(inserted.lastInsertRowid);
      return { status: 201, media: serializeMedia(media), replayed: false };
    });
    const result = attach();
    if (!result.media) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(result.status).json({ media: result.media, replayed: result.replayed });
  } catch (err: any) {
    console.error('[uploads] Image attach error:', err.message);
    res.status(500).json({ error: 'Could not attach image.' });
  }
});

// POST /api/uploads/video — direct video upload (disabled by default)
router.post('/video', requireAuth, requireVerified, (req, res) => {
  if (!isEnabled('ENABLE_VIDEO_UPLOADS', 'false')) {
    res.status(403).json({
      error: 'Direct video uploads are currently disabled. Upload your video to YouTube or another supported platform and paste the link here.',
      disabled: true,
    });
    return;
  }
  // Future: multer video upload + post_media insert
  res.status(501).json({ error: 'Video upload not yet implemented.' });
});

// POST /api/uploads/external-video — attach a validated external reference.
router.post('/external-video', requireAuth, requireVerified, (req, res) => {
  try {
    if (!isEnabled('ENABLE_EXTERNAL_VIDEO_EMBEDS', 'true')) {
      res.status(403).json({ error: 'External video embeds are currently disabled.' }); return;
    }
    const { url, postId, attachmentKey } = req.body;
    const targetPostId = Number(postId);
    if (!url || !Number.isSafeInteger(targetPostId) || targetPostId <= 0) {
      res.status(400).json({ error: 'Video URL and target post are required.' }); return;
    }
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(String(attachmentKey || ''))) {
      res.status(400).json({ error: 'Invalid attachment key.' }); return;
    }

    const embedUrl = parseYouTubeUrl(url);
    if (!embedUrl) {
      res.status(400).json({ error: 'Only YouTube video URLs are currently supported for embedding.' }); return;
    }

    const user = (req as any).user;
    const attach = getDb().transaction(() => {
      const post = getDb().prepare(
        'SELECT id FROM posts WHERE id = ? AND user_id = ? AND hidden = 0'
      ).get(targetPostId, user.id);
      if (!post) return { status: 404, error: 'Post not found.' };
      const existing = getDb().prepare(`
        SELECT * FROM post_media WHERE post_id = ? AND attachment_key = ?
      `).get(targetPostId, String(attachmentKey)) as any;
      if (existing) {
        if (existing.media_type !== 'external_video' || existing.url !== embedUrl) {
          return { status: 409, error: 'Attachment key was already used.' };
        }
        return { status: 200, media: serializeMedia(existing), replayed: true };
      }
      const inserted = getDb().prepare(`
        INSERT INTO post_media
          (post_id, attachment_key, media_type, url, provider, original_url)
        VALUES (?, ?, 'external_video', ?, 'youtube', ?)
      `).run(targetPostId, String(attachmentKey), embedUrl, String(url));
      const media = getDb().prepare('SELECT * FROM post_media WHERE id = ?')
        .get(inserted.lastInsertRowid);
      return { status: 201, media: serializeMedia(media), replayed: false };
    });
    const result = attach();
    if (!result.media) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(result.status).json({ media: result.media, replayed: result.replayed });
  } catch (err: any) {
    console.error('[uploads] External video attach error:', err.message);
    res.status(500).json({ error: 'Could not attach video.' });
  }
});

// GET /api/posts/:postId/media — get media for a post
router.get('/post/:postId', optionalAuth, (req, res) => {
  const postId = Number(req.params.postId);
  if (!canViewPost((req as any).user, postId)) { res.status(404).json({ error: 'Post not found.' }); return; }
  const media = getDb().prepare(
    'SELECT * FROM post_media WHERE post_id = ? ORDER BY sort_order'
  ).all(postId);
  res.json({ media });
});

export default router;

// ─── Protected File Serving ───
// Replaces express.static('/uploads') — enforces privacy on post media.
// Mount at /uploads in index.ts.

import { Router as FileRouter } from 'express';

const SAFE_FILENAME = /^[\w.\-]+$/; // alphanumeric, dot, hyphen, underscore only

export const uploadsFileRouter = FileRouter();

uploadsFileRouter.get('/:filename', optionalAuth, (req, res) => {
  const { filename } = req.params;

  // Path traversal guard: reject anything that isn't a plain filename
  if (!filename || !SAFE_FILENAME.test(filename) || filename.includes('..')) {
    res.status(404).end(); return;
  }

  const filePath = path.resolve(UPLOADS_DIR, filename);
  // Extra guard: resolved path must still be inside UPLOADS_DIR
  if (!isPathInUploads(filePath)) {
    res.status(404).end(); return;
  }

  let fileStat: fs.Stats;
  try {
    fileStat = fs.lstatSync(filePath);
  } catch {
    res.status(404).end(); return;
  }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    res.status(404).end(); return;
  }

  const db = getDb();
  const urlKey = `/uploads/${filename}`;
  const viewer = (req as any).user ?? null;

  // Managed assets are classified by server-issued identity and current
  // reference state. A URL or a stale secondary reference never broadens access.
  const asset = db.prepare('SELECT * FROM managed_assets WHERE url = ? LIMIT 1').get(urlKey) as any;
  if (asset) {
    if (asset.state === 'pending') {
      if (!viewer || viewer.id !== asset.owner_user_id ||
          asset.pending_expires_at_ms == null || Number(asset.pending_expires_at_ms) <= Date.now()) {
        res.status(404).end(); return;
      }
      sendUploadFile(res, filePath, filename); return;
    }
    if (asset.state !== 'active') { res.status(404).end(); return; }

    if (asset.purpose === 'post_image') {
      const media = db.prepare(`
        SELECT post_id FROM post_media WHERE asset_id = ? LIMIT 1
      `).get(asset.id) as any;
      if (!media || !canViewPost(viewer, media.post_id)) { res.status(404).end(); return; }
      sendUploadFile(res, filePath, filename); return;
    }
    if (asset.purpose === 'avatar') {
      const avatar = db.prepare(`
        SELECT 1 FROM user_avatar_uploads a
        JOIN users u ON u.id = a.user_id AND u.avatar_url = a.url
        WHERE a.asset_id = ? LIMIT 1
      `).get(asset.id);
      if (!avatar) { res.status(404).end(); return; }
      sendUploadFile(res, filePath, filename); return;
    }
    res.status(404).end(); return;
  }

  // Legacy compatibility is intentionally limited to rows with no managed
  // asset identity. No owner or lifecycle state is inferred from their URLs.
  const mediaRow = db.prepare(`
    SELECT post_id FROM post_media WHERE url = ? AND asset_id IS NULL LIMIT 1
  `).get(urlKey) as any;
  if (mediaRow) {
    if (mediaRow.post_id == null) {
      if (!viewer) { res.status(404).end(); return; }
      sendUploadFile(res, filePath, filename); return;
    }
    if (!canViewPost(viewer, mediaRow.post_id)) { res.status(404).end(); return; }
    sendUploadFile(res, filePath, filename); return;
  }

  const avatarRow = db.prepare(`
    SELECT a.id
    FROM user_avatar_uploads a
    JOIN users u ON u.id = a.user_id AND u.avatar_url = a.url
    WHERE a.url = ? AND a.asset_id IS NULL
    LIMIT 1
  `).get(urlKey);
  if (avatarRow) { sendUploadFile(res, filePath, filename); return; }

  // 3. File exists on disk but isn't attached to an authorized resource.
  res.status(404).end();
});

function sendUploadFile(res: Response, filePath: string, filename: string): void {
  const contentType = IMAGE_CONTENT_TYPE_BY_EXT[path.extname(filename).toLowerCase()];
  if (!contentType) { res.status(404).end(); return; }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Every subsequent fetch must recheck current authorization, even in the same browser.
  res.setHeader('Cache-Control', 'private, no-store');
  res.type(contentType);
  res.sendFile(filePath);
}
