/**
 * Shared test helpers for Madar backend test suites.
 * Runs under `node --test` (Node 22 type stripping) — plain TS only,
 * relative imports must include the explicit `.ts` extension.
 */
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Load secrets: repo-root .env first, then backend/.env (no override).
// Tests run with cwd = backend/, so the root .env is one level up.
const rootEnv = path.resolve(process.cwd(), '..', '.env');
if (fs.existsSync(rootEnv)) dotenv.config({ path: rootEnv });
dotenv.config();

export const API_URL = process.env.WSD_TEST_API_URL || 'http://127.0.0.1:3000/api';
export const JWT_SECRET = process.env.JWT_SECRET || 'wsd-pro-default-secret-change-me';

/** Sign a short-lived token exactly like a logged-in user would carry. */
export function signTestToken(expiresIn = '24h'): string {
  return jwt.sign({ id: 'test-user', username: 'test' }, JWT_SECRET, { expiresIn });
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${signTestToken()}`, ...extra };
}

export const JSON_HEADERS = { 'Content-Type': 'application/json' };

let counter = 0;
export function uniqueId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`.toLowerCase();
}

export interface Res {
  status: number;
  ok: boolean;
  json(): Promise<any>;
}

export async function req(
  method: string,
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Res> {
  const doFetch = (): Promise<Res> =>
    fetch(`${API_URL}${urlPath}`, {
      method,
      headers: { ...headers, ...(body !== undefined ? JSON_HEADERS : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }) as Promise<Res>;

  // Small retry on 429: the server rate-limits per IP and other clients
  // (browser tabs, manual curls) share the same budget.
  let res = await doFetch();
  for (let attempt = 0; res.status === 429 && attempt < 3; attempt += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await doFetch();
  }
  return res;
}

export async function reqAuth(
  method: string,
  urlPath: string,
  body?: unknown
): Promise<Res> {
  return req(method, urlPath, body, authHeaders());
}

/** First existing project slug, or null when none exist. */
export async function firstProjectSlug(): Promise<string | null> {
  try {
    const res = await reqAuth('GET', '/projects');
    if (!res.ok) return null;
    const data = await res.json();
    const arr = data?.projects;
    return Array.isArray(arr) && arr.length > 0 ? arr[0].slug : null;
  } catch {
    return null;
  }
}
