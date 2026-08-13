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
      void handleTerminalSocket(ws, decodeURIComponent(termMatch[1]));
      return;
    }

    const chatMatch = url.pathname.match(/^\/ws\/chat\/([^/]+)\/([^/]+)$/);
    if (chatMatch) {
      handleChatSocket(ws, decodeURIComponent(chatMatch[1]), decodeURIComponent(chatMatch[2]));
      return;
    }

    ws.close(4004, 'unknown socket path');
  });

  wss.on('error', (err) => {
    console.error('[WSD-Pro] WebSocket server error:', err.message);
  });
}