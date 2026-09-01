/**
 * app-proxy.ts
 * Madar — Authenticated reverse proxy for code-server (/ide) and opencode web
 * (/oc). Closes the Phase-E production blocker: previously the IDE and opencode
 * were published straight onto the host (8100:8080, 4096:4096) with code-server
 * running `--auth none`, so ANY user (or anyone on the LAN) could read every
 * workspace. Now both apps are reachable ONLY through this JWT-gated proxy.
 *
 * Auth model
 * ----------
 * iframes can't set an Authorization header, so the SPA mints a short-lived
 * (1h) scoped token via POST /api/auth/ide-session and we carry it as an
 * HttpOnly cookie `wsd.ide` (SameSite=Lax, Path=/). Every /ide/* and /oc/*
 * request — HTTP AND WebSocket upgrade — is validated against that cookie by
 * verifyIdeToken.
 *
 * The `ide` scope token is deliberately useless against /api/*: the shared
 * verifyToken() rejects ANY token carrying a `scope` claim, and only the
 * dedicated verifyIdeToken() accepts the `ide` scope (see user-store.ts).
 *
 * ?folder=/workspaces/<slug> requests are additionally gated through
 * checkProjectAccess(viewer) so a viewer member cannot reach a foreign project
 * (the root browse-all case is a documented, deferred limitation).
 *
 * Mounting / strip strategy
 * -------------------------
 * The proxies are mounted as `app.use('/ide', …)` / `app.use('/oc', …)` BEFORE
 * express.json() and the SPA catch-all, so (a) proxied POST bodies are never
 * drained by body-parsing middleware and (b) the paths never shadow /api or
 * /ws. WebSocket upgrades are wired onto the http server BEFORE ws-server's
 * own upgrade handler (which destroys any non-/ws socket), via
 * attachProxyUpgrades().
 *
 * code-server (4.96) uses RELATIVE asset URLs (./stable-…/static/…) — the
 * `--base-path` flag does NOT exist (only --abs-proxy-base-path, which affects
 * only absproxy routes, not the main UI). So we STRIP the /ide prefix and
 * forward the request at back-end root; the browser resolves the relative
 * asset URLs under /ide itself. No response rewriting is needed. We do set
 * `x-forwarded-prefix: /ide` for anything that reads it.
 *
 * opencode web has NO base-path/prefix option and its frontend hardcodes
 * root-absolute /api, /assets, /global and /event paths. We therefore STRIP
 * /oc AND rewrite those prefixes → /oc/* inside buffered text responses
 * (HTML / JS / CSS / JSON). Binary assets are passed through unchanged. This
 * is the documented fragility of the opencode leg.
 */

import http from 'http';
import httpProxy from 'http-proxy';
import type { ServerResponse } from 'http';
import type { Request, Response, NextFunction } from 'express';
import { getUserInfo, verifyIdeToken } from './user-store';
import { checkProjectAccess } from '../middleware/auth';

export const IDE_COOKIE = 'wsd.ide';
const IDE_UPSTREAM = 'http://127.0.0.1:8080';
const OC_UPSTREAM = `http://127.0.0.1:${Number(process.env.WSD_OPENCODE_PORT) || 4096}`;

interface ProxyTarget {
  kind: 'ide' | 'oc';
  strip: string; // prefix stripped from the forwarded path
  target: string;
  rewrite: (body: string) => string;
  selfHandle: boolean; // buffer+rewrite text responses (opencode only)
}

// ── opencode response rewriting ────────────────────────────────
// Rewrite opencode's root-absolute references so they resolve back into the
// /oc proxy mount. Applied to buffered TEXT responses only (not binary assets).
function isWritableText(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return /text\/html|application\/javascript|text\/javascript|text\/css|application\/json|application\/x-javascript|text\/xjs-source|\+json/.test(contentType);
}

// Leading-slash → /oc-prefixed for the paths opencode emits at the root.
const OC_REWRITE_RE = /(["'(\s])\/(assets|api|global|favicon|site\.webmanifest|apple-touch-icon|admin|invite)\//g;
// `/event` (SSE/WS endpoint) can appear without a trailing slash.
const OC_EVENT_RE = /(["'(\s])\/event([?/]|['"\s)]|$)/g;

function rewriteOpenCode(body: string): string {
  return body
    .replace(/"\/assets\//g, '"/oc/assets/')
    .replace(/'\/assets\//g, "'/oc/assets/")
    .replace(/"\/api\//g, '"/oc/api/')
    .replace(/'\/api\//g, "'/oc/api/")
    .replace(/"\/global\//g, '"/oc/global/')
    .replace(/'\/global\//g, "'/oc/global/")
    .replace(OC_EVENT_RE, '$1/oc/event$2')
    .replace(/"\/favicon/g, '"/oc/favicon')
    .replace(/'\/favicon/g, "'/oc/favicon")
    .replace(/"\/site\.webmanifest/g, '"/oc/site.webmanifest')
    .replace(/'\/site\.webmanifest/g, "'/oc/site.webmanifest")
    .replace(/"\/apple-touch-icon/g, '"/oc/apple-touch-icon')
    .replace(/'\/apple-touch-icon/g, "'/oc/apple-touch-icon");
}

const TARGETS: Record<'ide' | 'oc', ProxyTarget> = {
  ide: {
    kind: 'ide',
    strip: '/ide',
    target: IDE_UPSTREAM,
    rewrite: (b) => b,
    selfHandle: false,
  },
  oc: {
    kind: 'oc',
    strip: '/oc',
    target: OC_UPSTREAM,
    rewrite: rewriteOpenCode,
    selfHandle: true,
  },
};

function getProxyOptions(t: ProxyTarget): httpProxy.ServerOptions {
  return {
    target: t.target,
    // We forward the RAW path (already mounted/stripped by Express for HTTP;
    // for WS we strip manually). http-proxy appends req.url to the target.
    ws: true,
    selfHandleResponse: t.selfHandle,
    // Don't rewrite the Host — both apps bind 0.0.0.0 and serve regardless.
  };
}

function stripWsPath(target: ProxyTarget, pathname: string): string {
  return pathname.startsWith(target.strip) ? pathname.slice(target.strip.length) || '/' : pathname;
}

/** Decode the cookie token and check the optional ?folder= access rule. */
function authorizeProxy(
  req: http.IncomingMessage,
  target: ProxyTarget
): { ok: boolean; status?: number; error?: string } {
  const raw = (req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${IDE_COOKIE}=`));
  const token = raw ? raw.slice(IDE_COOKIE.length + 1) : null;
  const auth = token ? verifyIdeToken(decodeURIComponent(token)) : null;
  if (!auth) {
    return { ok: false, status: 401, error: 'IDE session required. Sign in to Madar first.' };
  }
  const user = getUserInfo(auth.id);
  if (!user) {
    return { ok: false, status: 401, error: 'Unknown user.' };
  }

  // ?folder=/workspaces/<slug> → require viewer access to that project.
  const qIndex = (req.url || '').indexOf('?');
  const query = qIndex >= 0 ? (req.url as string).slice(qIndex + 1) : '';
  const params = new URLSearchParams(query);
  const folder = params.get('folder');
  if (folder && folder.startsWith('/workspaces/')) {
    const slug = folder.slice('/workspaces/'.length).split('/')[0];
    if (!slug) return { ok: false, status: 403, error: 'No project specified.' };
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
      return { ok: false, status: 403, error: 'Invalid project.' };
    }
    const { allowed } = checkProjectAccess(user.id, user.role, slug, 'viewer');
    if (!allowed) {
      return { ok: false, status: 403, error: 'Access denied to this project.' };
    }
  }

  (req as any)._wsdProxyUser = user;
  return { ok: true };
}

function emitProxyError(res: Response, status: number, error: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).setHeader('Content-Type', 'text/plain; charset=utf-8').end(error);
}

function installOcResponseRewrite(proxy: httpProxy, target: ProxyTarget): void {
  proxy.on('proxyRes' as any, (proxyRes: http.IncomingMessage, _req: http.IncomingMessage, res: ServerResponse) => {
    const contentType = String(proxyRes.headers['content-type'] || '');
    if (target.selfHandle) {
      // selfHandleResponse: true → http-proxy does NOT pipe the body for us.
      if (isWritableText(contentType)) {
        const chunks: Buffer[] = [];
        proxyRes.on('data', (c) => chunks.push(c));
        proxyRes.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const rewritten = target.rewrite(body);
            // Rewriting changes the byte length, so the upstream Content-Length is
            // stale — override it in the header OBJECT (setHeader alone is clobbered
            // by writeHead's headers argument). When absent, Node sends chunked.
            const headers = { ...proxyRes.headers };
            delete headers['transfer-encoding'];
            headers['content-length'] = String(Buffer.byteLength(rewritten));
            res.writeHead(proxyRes.statusCode || 200, headers);
            res.end(rewritten);
          } catch (err: any) {
            if (!res.headersSent) res.writeHead(502).end('proxy rewrite failed');
            else res.end();
          }
        });
        proxyRes.on('error', () => res.destroy());
      } else {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      }
    } else {
      proxyRes.pipe(res);
    }
  });
}

export interface AppProxies {
  ide: httpProxy;
  oc: httpProxy;
}

/** Create both proxy servers. Call once at boot. */
export function createAppProxies(): AppProxies {
  const ide = httpProxy.createProxyServer(getProxyOptions(TARGETS.ide));
  const oc = httpProxy.createProxyServer(getProxyOptions(TARGETS.oc));
  const proxies = { ide, oc: oc };
  installOcResponseRewrite(oc, TARGETS.oc);

  for (const p of [ide, oc]) {
    p.on('error' as any, (err: any, _req: http.IncomingMessage, res: ServerResponse | null) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      void err;
      const status = 502;
      if (res && typeof (res as any).writeHead === 'function') {
        try {
          if (!(res as any).headersSent) res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Upstream unavailable.');
        } catch {
          /* ignore */
        }
      }
    });
  }
  return proxies;
}

/** Express middleware for HTTP proxying at /ide and /oc. Mount BEFORE express.json(). */
export function proxyHttp(proxies: AppProxies): Array<(req: Request, res: Response, next: NextFunction) => void> {
  const ide = (req: Request, res: Response, next: NextFunction) => {
    const check = authorizeProxy(req, TARGETS.ide);
    if (!check.ok) return emitProxyError(res, check.status!, check.error!);
    // Express mounted us at /ide, so req.url is already the stripped sub-path.
    req.headers['x-forwarded-prefix'] = '/ide';
    proxies.ide.web(req as any, res);
  };

  const oc = (req: Request, res: Response, next: NextFunction) => {
    const check = authorizeProxy(req, TARGETS.oc);
    if (!check.ok) return emitProxyError(res, check.status!, check.error!);
    req.headers['x-forwarded-prefix'] = '/oc';
    proxies.oc.web(req as any, res);
  };
  return [ide, oc];
}

/**
 * Wire WebSocket upgrades for /ide and /oc. MUST be called on the http server
 * BEFORE attachWebSockets(), whose own upgrade handler destroys any socket
 * whose path does not start with /ws/.
 */
export function attachProxyUpgrades(server: http.Server, proxies: AppProxies): void {
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname.startsWith('/ide')) {
      const check = authorizeProxy(req, TARGETS.ide);
      if (!check.ok) {
        socket.write(`HTTP/1.1 ${check.status} Unauthorized\r\n\r\n`);
        socket.destroy();
        return;
      }
      const target = TARGETS.ide;
      (req as any).url = stripWsPath(target, pathname) + ((req.url || '').includes('?') ? (req.url as string).slice((req.url as string).indexOf('?')) : '');
      req.headers['x-forwarded-prefix'] = '/ide';
      proxies.ide.ws(req, socket, head);
      return;
    }
    if (pathname.startsWith('/oc')) {
      const check = authorizeProxy(req, TARGETS.oc);
      if (!check.ok) {
        socket.write(`HTTP/1.1 ${check.status} Unauthorized\r\n\r\n`);
        socket.destroy();
        return;
      }
      const target = TARGETS.oc;
      (req as any).url = stripWsPath(target, pathname) + ((req.url || '').includes('?') ? (req.url as string).slice((req.url as string).indexOf('?')) : '');
      req.headers['x-forwarded-prefix'] = '/oc';
      proxies.oc.ws(req, socket, head);
      return;
    }
  });
}
