import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDb } from '../database.js';
import { optionalAuth, requireAuth, requireVerified } from '../middleware.js';
import { canViewPost } from '../visibility.js';
import type { Request, Response, NextFunction } from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.resolve(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const IMAGE_UPLOAD_ERROR = 'SVG uploads are not supported. Please use JPG, PNG, GIF, or WebP.';
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const ALLOWED_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

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
    if (file.mimetype === 'image/svg+xml' || ext === '.svg') {
      cb(new Error(IMAGE_UPLOAD_ERROR)); return;
    }
    if (ALLOWED_IMAGE_MIME.has(file.mimetype) && ALLOWED_IMAGE_EXT.has(ext)) { cb(null, true); }
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
router.post('/image', requireAuth, requireVerified, handleImageUpload, (req, res) => {
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
      const post = getDb().prepare('SELECT user_id FROM posts WHERE id = ?').get(postId) as any;
      if (!post) { res.status(404).json({ error: 'Post not found.' }); return; }
      if (post.user_id !== (req as any).user.id && (req as any).user.role !== 'admin') {
        res.status(403).json({ error: 'Not authorized to attach media to this post.' }); return;
      }
      const result = getDb().prepare(
        'INSERT INTO post_media (post_id, media_type, url, mime_type, file_size_bytes) VALUES (?, ?, ?, ?, ?)'
      ).run(postId, 'image', url, req.file.mimetype, req.file.size);
      media.id = result.lastInsertRowid as number;
      media.post_id = postId;
    }

    res.status(201).json({ media });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
      const post = getDb().prepare('SELECT user_id FROM posts WHERE id = ?').get(postId) as any;
      if (!post) { res.status(404).json({ error: 'Post not found.' }); return; }
      if (post.user_id !== (req as any).user.id && (req as any).user.role !== 'admin') {
        res.status(403).json({ error: 'Not authorized to attach media to this post.' }); return;
      }
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
    res.status(500).json({ error: err.message });
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
