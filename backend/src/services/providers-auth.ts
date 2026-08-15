/**
 * providers-auth.ts
 * WSD-Pro — Token auth for the Providers page (API key management).
 * Password comes from WSD_PROVIDERS_PASSWORD (default admin123 for the test env).
 * Tokens live in memory: 12h TTL, invalidated on restart.
 */

import crypto from 'crypto';

const PASSWORD = process.env.WSD_PROVIDERS_PASSWORD || 'admin123';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const sessions = new Map<string, number>(); // token -> expiresAt

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function authenticate(password: string): string | null {
  if (!safeEqual(String(password ?? ''), PASSWORD)) return null;
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}

export function verifyToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const expires = sessions.get(token);
  if (!expires) return false;
  if (Date.now() > expires) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function revokeToken(token: string): void {
  sessions.delete(token);
}
