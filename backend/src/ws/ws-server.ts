/**
 * ws-server.ts
 * WSD-Pro — WebSocket hub.
 * Manual upgrade routing (noServer) so nested paths work:
 *   /ws/chat/:slug/:chatId  → chatbot scoped to a project (slug = project or 'global')
 *   /ws/chat/:chatId        → legacy alias for slug = 'global'
 * No authentication (open app).
 */
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { handleChatSocket } from './ws-chat';
import { handleTerminalSocket } from './ws-terminal';
import { handleProjectLogsSocket } from './ws-project-logs';
import { handleAgentSocket } from './ws-agent';
import { handleProjectStatusSocket } from './ws-project-status';
import { handleProjectsStatusSocket } from './ws-projects-status';

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

    const chatMatch = url.pathname.match(/^\/ws\/chat\/([^/]+)\/([^/]+)$/);
    if (chatMatch) {
      const slug = decodeURIComponent(chatMatch[1]);
      const chatId = decodeURIComponent(chatMatch[2]);
      if (!isSafeChatId(slug) || !isSafeChatId(chatId)) {
        ws.close(1008, 'invalid chat id');
        return;
      }
      const room = `chat:${slug}:${chatId}`;
      if (!acquireRoom(room)) {
        ws.close(1013, 'too many connections for chat');
        return;
      }
      handleChatSocket(ws, slug, chatId, releaseRoom(room));
      return;
    }

    const termMatch = url.pathname.match(/^\/ws\/projects\/([^/]+)\/terminal$/);
    if (termMatch) {
      const slug = decodeURIComponent(termMatch[1]);
      if (!isSafeChatId(slug)) {
        ws.close(1008, 'invalid slug');
        return;
      }
      const mode = url.searchParams.get('mode') === 'control' ? 'control' : 'project';
      const room = `term:${slug}:${mode}`;
      if (!acquireRoom(room)) {
        ws.close(1013, 'too many connections for terminal');
        return;
      }
      handleTerminalSocket(ws, slug, mode, releaseRoom(room));
      return;
    }

    const logsMatch = url.pathname.match(/^\/ws\/projects\/([^/]+)\/logs$/);
    if (logsMatch) {
      const slug = decodeURIComponent(logsMatch[1]);
      if (!isSafeChatId(slug)) {
        ws.close(1008, 'invalid slug');
        return;
      }
      const room = `logs:${slug}`;
      if (!acquireRoom(room)) {
        ws.close(1013, 'too many connections for logs');
        return;
      }
      handleProjectLogsSocket(ws, slug, releaseRoom(room));
      return;
    }

    const projectsStatusMatch = url.pathname.match(/^\/ws\/projects\/status$/);
    if (projectsStatusMatch) {
      const room = 'projects:status';
      if (!acquireRoom(room)) {
        ws.close(1013, 'too many connections for projects status');
        return;
      }
      handleProjectsStatusSocket(ws, releaseRoom(room));
      return;
    }

    const statusMatch = url.pathname.match(/^\/ws\/projects\/([^/]+)\/status$/);
    if (statusMatch) {
      const slug = decodeURIComponent(statusMatch[1]);
      if (!isSafeChatId(slug)) {
        ws.close(1008, 'invalid slug');
        return;
      }
      const room = `status:${slug}`;
      if (!acquireRoom(room)) {
        ws.close(1013, 'too many connections for status');
        return;
      }
      handleProjectStatusSocket(ws, slug, releaseRoom(room));
      return;
    }

    const legacyChatMatch = url.pathname.match(/^\/ws\/chat\/([^/]+)$/);
    if (legacyChatMatch) {
      const chatId = decodeURIComponent(legacyChatMatch[1]);
      if (!isSafeChatId(chatId)) {
        ws.close(1008, 'invalid chat id');
        return;
      }
      const room = `chat:global:${chatId}`;
      if (!acquireRoom(room)) {
        ws.close(1013, 'too many connections for chat');
        return;
      }
      handleChatSocket(ws, 'global', chatId, releaseRoom(room));
      return;
    }

    const agentMatch = url.pathname.match(/^\/ws\/agent\/([^/]+)\/([^/]+)$/);
    if (agentMatch) {
      const agentId = decodeURIComponent(agentMatch[1]);
      const chatId = decodeURIComponent(agentMatch[2]);
      if (!isSafeChatId(agentId) || !isSafeChatId(chatId)) {
        ws.close(1008, 'invalid agent id');
        return;
      }
      const room = `agent:${agentId}:${chatId}`;
      if (!acquireRoom(room)) {
        ws.close(1013, 'too many connections for agent');
        return;
      }
      handleAgentSocket(ws, agentId, chatId, releaseRoom(room));
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
