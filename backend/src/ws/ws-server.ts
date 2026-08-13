/**
 * ws-server.ts
 * WSD-Pro — WebSocket hub.
 * Manual upgrade routing (noServer) so nested paths work:
 *   /ws/terminal/{slug}   → interactive container terminal
 *   /ws/chat/{slug}/{chatId} → streaming agent chat
 * JWT auth via token query param.
 */
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { verifyToken } from '../services/auth';
import { handleTerminalSocket } from './ws-terminal';
import { handleChatSocket } from './ws-chat';

const MAX_PROJECT_CONNECTIONS = 8;
const projectConnections = new Map<string, number>();

function isSafeSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(value);
}

function isSafeChatId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(value);
}

export function attachWebSockets(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (!url.pathname.startsWith('/ws/')) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket, req) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const token = url.searchParams.get('token') || '';
    if (!verifyToken(token)) {
      ws.close(4001, 'unauthorized');
      return;
    }

    const termMatch = url.pathname.match(/^\/ws\/terminal\/([^/]+)$/);
    if (termMatch) {
      const slug = decodeURIComponent(termMatch[1]);
      if (!isSafeSlug(slug)) {
        ws.close(1008, 'invalid project slug');
        return;
      }
      const count = projectConnections.get(slug) || 0;
      if (count >= MAX_PROJECT_CONNECTIONS) {
        ws.close(1013, 'too many connections for project');
        return;
      }
      projectConnections.set(slug, count + 1);
      ws.on('close', () => {
        const current = projectConnections.get(slug) || 1;
        if (current <= 1) projectConnections.delete(slug);
        else projectConnections.set(slug, current - 1);
      });
      void handleTerminalSocket(ws, slug);
      return;
    }

    const chatMatch = url.pathname.match(/^\/ws\/chat\/([^/]+)\/([^/]+)$/);
    if (chatMatch) {
      const slug = decodeURIComponent(chatMatch[1]);
      const chatId = decodeURIComponent(chatMatch[2]);
      if (!isSafeSlug(slug) || !isSafeChatId(chatId)) {
        ws.close(1008, 'invalid project or chat id');
        return;
      }
      const count = projectConnections.get(slug) || 0;
      if (count >= MAX_PROJECT_CONNECTIONS) {
        ws.close(1013, 'too many connections for project');
        return;
      }
      projectConnections.set(slug, count + 1);
      ws.on('close', () => {
        const current = projectConnections.get(slug) || 1;
        if (current <= 1) projectConnections.delete(slug);
        else projectConnections.set(slug, current - 1);
      });
      handleChatSocket(ws, slug, chatId);
      return;
    }

    ws.close(4004, 'unknown socket path');
  });

  wss.on('error', (err) => {
    console.error('[WSD-Pro] WebSocket server error:', err.message);
  });
}