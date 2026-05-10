import { Router } from 'express';
import { getDb } from '../database.js';
import { registerUser, generateToken, verifyPassword, getUserByUsername, getUserById, type AuthUser } from '../auth.js';
import { requireAuth, type AuthRequest } from '../middleware.js';

const router = Router();

// POST /api/auth/register
router.post('/register', (req, res) => {
  try {
    const { username, displayName, email, password } = req.body;
    if (!username || !displayName || !email || !password) {
      res.status(400).json({ error: 'All fields required.' }); return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters.' }); return;
    }
    const user = registerUser(username.trim(), displayName.trim(), email.trim().toLowerCase(), password);
    const token = generateToken(user);
    res.status(201).json({ user, token });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ error: 'Username and password required.' }); return;
    }
    const user = getUserByUsername(username.trim());
    if (!user || !verifyPassword(password, user.password_hash)) {
      res.status(401).json({ error: 'Invalid credentials.' }); return;
    }
    if (user.banned) {
      res.status(403).json({ error: 'Account is banned.' }); return;
    }
    const token = generateToken(user);
    const { password_hash, ...safe } = user as any;
    res.json({ user: safe, token });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req: AuthRequest, res) => {
  const user = getUserById(req.user!.id);
  res.json({ user });
});

export default router;
