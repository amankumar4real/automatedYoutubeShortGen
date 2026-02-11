import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { getDb, USERS_COLL, UserDoc } from './db';
import { config } from './config';

const SALT_ROUNDS = 10;

export interface AuthUser {
  id: string;
  username: string;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req as { cookies?: { token?: string } }).cookies?.token;
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    const decoded = jwt.verify(token, config.jwt.secret) as { userId: string; username: string };
    req.user = { id: decoded.userId, username: decoded.username };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export async function register(username: string, password: string): Promise<{ user: AuthUser; token: string }> {
  const db = await getDb();
  const coll = db.collection<UserDoc>(USERS_COLL);
  const trimmed = username.trim();
  if (!trimmed || trimmed.length < 2) throw new Error('Username must be at least 2 characters');
  if (!password || password.length < 6) throw new Error('Password must be at least 6 characters');
  const existing = await coll.findOne({ username: trimmed.toLowerCase() });
  if (existing) throw new Error('Username already taken');
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const now = new Date();
  const inserted = await coll.insertOne({
    username: trimmed.toLowerCase(),
    passwordHash,
    createdAt: now
  } as UserDoc);
  const user: AuthUser = { id: inserted.insertedId.toString(), username: trimmed };
  const token = jwt.sign(
    { userId: user.id, username: user.username },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn } as jwt.SignOptions
  );
  return { user, token };
}

export async function login(username: string, password: string): Promise<{ user: AuthUser; token: string }> {
  const db = await getDb();
  const coll = db.collection<UserDoc>(USERS_COLL);
  const userDoc = await coll.findOne({ username: username.trim().toLowerCase() });
  if (!userDoc) throw new Error('Invalid username or password');
  const ok = await bcrypt.compare(password, userDoc.passwordHash);
  if (!ok) throw new Error('Invalid username or password');
  const user: AuthUser = { id: userDoc._id.toString(), username: userDoc.username };
  const token = jwt.sign(
    { userId: user.id, username: user.username },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn } as jwt.SignOptions
  );
  return { user, token };
}
