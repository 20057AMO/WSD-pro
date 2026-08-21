import { verifyToken } from '../services/user-store';

export interface AuthRequest extends Express.Request {
  user?: { id: string; username: string };
}

export function authMiddleware(req: any, res: any, next: any): void {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  const user = verifyToken(token);
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  req.user = user;
  next();
}
