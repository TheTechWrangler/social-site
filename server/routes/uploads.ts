import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { getDb } from '../database.js';
import { ensureUploadsDirectory, getStorageConfig } from '../config.js';
import { optionalAuth, requireAuth, requireVerified } from '../middleware.js';
import { canViewPost } from '../visibility.js';
import { logUsage } from '../usageEvents.js';
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
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      cb(null, name);
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

function handleImageUpload(req: Request, res: Response, next: NextFunction): void {
  imageUpload.single('file')(req, res, (err: any) => {
    if (err) {
      res.status(400).json({ error: IMAGE_UPLOAD_ERROR });
      return;
    }
    next();
  });
}

function isPathInUploads(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return resolved.startsWith(UPLOADS_DIR + path.sep);
}

function detectImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 6) {
    const gifSig = bytes.subarray(0, 6).toString('ascii');
    if (gifSig === 'GIF87a' || gifSig === 'GIF89a') return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
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

  const detectedMime = detectImageMime(fs.readFileSync(file.path).subarray(0, 16));
  if (!detectedMime || detectedMime !== claimedMime) return null;
  return ALLOWED_EXT_BY_MIME[detectedMime]?.has(ext) ? detectedMime : null;
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

// POST /api/uploads/image — upload an image for a post
router.post('/image', requireAuth, requireVerified, handleImageUpload, validateUploadedImageBytes, (req, res) => {
  try {
    if (!isEnabled('ENABLE_IMAGE_UPLOADS', 'true')) {
      res.status(403).json({ error: 'Image uploads are currently disabled.' }); return;
    }
    if (!req.file) { res.status(400).json({ error: 'No image file provided.' }); return; }

    const url = `/uploads/${req.file.filename}`;
    const media = {
      id: 0, post_id: null as number | null,
      media_type: 'image' as const, url,
      provider: null, original_url: null,
      mime_type: req.file.mimetype,
      file_size_bytes: req.file.size,
    };

    // If postId provided, link immediately
    const postId = req.body.postId ? Number(req.body.postId) : null;
    if (postId) {
      const user = (req as any).user;
      const post = getDb().prepare(`
        SELECT id FROM posts
        WHERE id = ? AND (user_id = ? OR ? = 'admin')
      `).get(postId, user.id, user.role) as any;
      if (!post) { res.status(404).json({ error: 'Post not found.' }); return; }
      const result = getDb().prepare(
        'INSERT INTO post_media (post_id, media_type, url, mime_type, file_size_bytes) VALUES (?, ?, ?, ?, ?)'
      ).run(postId, 'image', url, req.file.mimetype, req.file.size);
      media.id = result.lastInsertRowid as number;
      media.post_id = postId;
    }

    logUsage({ eventType: 'upload_completed', userId: (req as any).user?.id ?? null, featureArea: 'feed' });
    res.status(201).json({ media });
  } catch (err: any) {
    logUsage({ eventType: 'upload_failed', userId: (req as any).user?.id ?? null, featureArea: 'feed', errorCode: 'SERVER_ERROR' });
    console.error('[uploads] Image upload error:', err.message);
    res.status(500).json({ error: 'Image upload failed.' });
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

// POST /api/uploads/external-video — attach YouTube/external video to a post
router.post('/external-video', requireAuth, requireVerified, (req, res) => {
  try {
    if (!isEnabled('ENABLE_EXTERNAL_VIDEO_EMBEDS', 'true')) {
      res.status(403).json({ error: 'External video embeds are currently disabled.' }); return;
    }
    const { url, postId } = req.body;
    if (!url) { res.status(400).json({ error: 'Video URL required.' }); return; }

    const embedUrl = parseYouTubeUrl(url);
    if (!embedUrl) {
      res.status(400).json({ error: 'Only YouTube video URLs are currently supported for embedding.' }); return;
    }

    const provider = 'youtube';
    if (postId) {
      const user = (req as any).user;
      const post = getDb().prepare(`
        SELECT id FROM posts
        WHERE id = ? AND (user_id = ? OR ? = 'admin')
      `).get(postId, user.id, user.role) as any;
      if (!post) { res.status(404).json({ error: 'Post not found.' }); return; }
    }
    const result = getDb().prepare(
      'INSERT INTO post_media (post_id, media_type, url, provider, original_url) VALUES (?, ?, ?, ?, ?)'
    ).run(postId || null, 'external_video', embedUrl, provider, url);

    res.status(201).json({
      media: {
        id: result.lastInsertRowid,
        post_id: postId || null,
        media_type: 'external_video',
        url: embedUrl,
        provider,
        original_url: url,
      }
    });
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

  // 1. Is it an avatar? Avatars are public profile metadata — serve to everyone.
  const avatarRow = db.prepare('SELECT id FROM users WHERE avatar_url = ? LIMIT 1').get(urlKey);
  if (avatarRow) { sendUploadFile(res, filePath, filename); return; }

  // 2. Is it tracked post media?
  const mediaRow = db.prepare('SELECT post_id FROM post_media WHERE url = ? LIMIT 1').get(urlKey) as any;

  if (mediaRow) {
    if (mediaRow.post_id == null) {
      // Freshly uploaded but not yet attached to a post — require auth (uploader preview).
      if (!viewer) { res.status(404).end(); return; }
      sendUploadFile(res, filePath, filename); return;
    }
    // Attached media: enforce post visibility.
    if (!canViewPost(viewer, mediaRow.post_id)) { res.status(404).end(); return; }
    sendUploadFile(res, filePath, filename); return;
  }

  // 3. File exists on disk but isn't in the DB — don't serve it.
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
