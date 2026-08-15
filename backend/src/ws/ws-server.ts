/**
 * ws-server.ts
 * WSD-Pro — WebSocket hub.
 * Manual upgrade routing (noServer) so nested paths work:
 *   /ws/chat/:chatId        → global chatbot (qwen3:30b, slug = 'global')
 * No authentication (open app).
 */
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { handleChatSocket } from './ws-chat';

const MAX_CONNECTIONS_PER_ROOM = 8;
const roomConnections = new Map<string, number>();

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

    const chatMatch = url.pathname.match(/^\/ws\/chat\/([^/]+)$/);
    if (chatMatch) {
      const chatId = decodeURIComponent(chatMatch[1]);
      if (!isSafeChatId(chatId)) {
        ws.close(1008, 'invalid chat id');
        return;
      }
      const room = `chat:${chatId}`;
      if (!acquireRoom(room)) {
        ws.close(1013, 'too many connections for chat');
        return;
      }
      handleChatSocket(ws, 'global', chatId, releaseRoom(room));
      return;
    }

    ws.close(4004, 'unknown socket path');
  });

  wss.on('error', (err) => {
    console.error('[WSD-Pro] WebSocket server error:', err.message);
  });
}

function acquireRoom(room: string): boolean {
  const count = roomConnections.get(room) || 0;
  if (count >= MAX_CONNECTIONS_PER_ROOM) return false;
  roomConnections.set(room, count + 1);
  return true;
}

function releaseRoom(room: string): () => void {
  return () => {
    const current = roomConnections.get(room) || 1;
    if (current <= 1) roomConnections.delete(room);
    else roomConnections.set(room, current - 1);
  };
}
