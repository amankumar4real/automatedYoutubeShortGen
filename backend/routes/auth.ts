import { Router, Request, Response } from 'express';
import { register, login } from '../auth';

const router = Router();

router.post('/register', async (req: Request, res: Response) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  try {
    const { user, token } = await register(username, password);
    res.status(201).json({ user, token });
  } catch (err) {
    const msg = (err as Error).message;
    const status = msg.includes('already taken') ? 409 : 400;
    res.status(status).json({ error: msg });
  }
});

router.post('/login', async (req: Request, res: Response) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  try {
    const { user, token } = await login(username, password);
    res.json({ user, token });
  } catch (err) {
    res.status(401).json({ error: (err as Error).message });
  }
});

export default router;
