import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { q } from './db.js';

export const SECRET = process.env.JWT_SECRET || 'dev-secret';
export const sign = (u) => jwt.sign({ uid: u.id, role: u.role }, SECRET, { expiresIn: '7d' });
export const requireAuth = async (req, res, next) => {
  try {
    const user = jwt.verify((req.headers.authorization || '').slice(7), SECRET);
    const { rows: [account] } = await q('SELECT role,banned FROM users WHERE id=$1', [user.uid]);
    if (!account || account.banned) return res.status(401).json({ error: 'unauthorized' });
    req.user = { ...user, role: account.role };
    next();
  } catch (e) {
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') return res.status(401).json({ error: 'unauthorized' });
    next(e);
  }
};
export const requireAdmin = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'forbidden' });

export const authRouter = Router();
authRouter.get('/campuses', async (_, res) => res.json((await q('SELECT id,name FROM campuses ORDER BY id')).rows));

authRouter.post('/register', async (req, res) => {
  const { username, email, password, fullName, campusId, faculty, department } = req.body || {};
  if (!/^[a-z0-9_]{3,20}$/i.test(username || '') || !/^\S+@\S+\.\S+$/.test(email || '') ||
      typeof password !== 'string' || password.length < 8 || !fullName || String(fullName).length > 100)
    return res.status(400).json({ error: 'invalid input' });
  try {
    const { rows: [u] } = await q(
      `INSERT INTO users(username,email,password_hash,full_name,campus_id,faculty,department)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,username,full_name AS "fullName",role`,
      [username.toLowerCase(), email.toLowerCase(), await bcrypt.hash(password, 12), String(fullName),
       Number.isInteger(campusId) ? campusId : null, faculty || null, department || null]);
    res.json({ token: sign(u), user: u });
  } catch (e) {
    res.status(e.code === '23505' ? 409 : 500).json({ error: e.code === '23505' ? 'username or email already taken' : 'server error' });
  }
});

authRouter.post('/login', async (req, res) => {
  const { login, password } = req.body || {};
  const { rows: [u] } = await q(
    `SELECT id,username,full_name AS "fullName",role,password_hash,banned FROM users WHERE username=$1 OR email=$1`,
    [String(login || '').toLowerCase()]);
  if (!u || u.banned || !(await bcrypt.compare(String(password || ''), u.password_hash)))
    return res.status(401).json({ error: 'invalid credentials' });
  delete u.password_hash;
  res.json({ token: sign(u), user: u });
});
