import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDb } from '../database.js';
import { requireAuth, requireVerified } from '../middleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.resolve(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

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
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
    if (allowed.includes(file.mimetype)) { cb(null, true); }
    else { cb(new Error(`File type ${file.mimetype} not allowed for image upload.`)); }
  },
});

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
router.post('/image', requireAuth, requireVerified, imageUpload.single('file'), (req, res) => {
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
router.get('/post/:postId', (req, res) => {
  const media = getDb().prepare(
    'SELECT * FROM post_media WHERE post_id = ? ORDER BY sort_order'
  ).all(Number(req.params.postId));
  res.json({ media });
});

export default router;
