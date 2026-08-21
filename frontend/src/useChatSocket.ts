import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { wsUrl } from './api';

export interface Attachment {
  kind: 'image' | 'text' | 'file';
  name: string;
  data?: string;
  text?: string;
  size: number;
}

export interface Msg {
  role: 'user' | 'agent' | 'error' | 'tool_call' | 'tool_result';
  text: string;
  attachments?: Attachment[];
  toolName?: string;
  toolArgs?: Record<string, string>;
}

interface ChatEvent {
  seq: number;
  type: 'user_message' | 'agent_chunk' | 'agent_done' | 'agent_error' | 'tool_call' | 'tool_result' | 'session_renamed';
  content: string;
  timestamp: string;
  attachments?: Attachment[];
  name?: string;
}

interface ServerMsg {
  type: string;
  events?: ChatEvent[];
  event?: ChatEvent;
  message?: string;
}

function applyEvent(ev: ChatEvent, cur: Msg[]): Msg[] {
  const next = cur.slice();
  if (ev.type === 'user_message') {
    next.push({ role: 'user', text: ev.content, attachments: ev.attachments });
  } else if (ev.type === 'agent_chunk' || ev.type === 'agent_done') {
    const last = next[next.length - 1];
    if (last && last.role === 'agent') {
      next[next.length - 1] = { ...last, text: last.text + ev.content };
    } else {
      next.push({ role: 'agent', text: ev.content });
    }
  } else if (ev.type === 'agent_error') {
    next.push({ role: 'error', text: ev.content });
  } else if (ev.type === 'tool_call') {
    try {
      const data = JSON.parse(ev.content);
      next.push({ role: 'tool_call', text: ev.content, toolName: data.name, toolArgs: data.args });
    } catch {
      next.push({ role: 'tool_call', text: ev.content });
    }
  } else if (ev.type === 'tool_result') {
    try {
      const data = JSON.parse(ev.content);
      next.push({ role: 'tool_result', text: data.output || ev.content, toolName: data.name, toolArgs: data.args });
    } catch {
      next.push({ role: 'tool_result', text: ev.content });
    }
  }
  return next;
}

const RECONNECT_BASE = 2000;
const RECONNECT_MAX = 16000;

export type ChatStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface ChatSocketState {
  messages: Msg[];
  connected: boolean;
  running: boolean;
  status: ChatStatus;
  error: string | null;
  sessionName: string | null;
  send: (text: string, attachments?: Attachment[], project?: string) => boolean;
  stop: () => void;
  reconnect: () => void;
}

export function useChatSocket(path: string, runType: 'run' | 'prompt'): ChatSocketState {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<ChatStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const disposedRef = useRef(false);

  const cleanupReconnect = () => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
  };

  const openWs = useCallback(() => {
    cleanupReconnect();
    if (disposedRef.current) return;

    const ws = new WebSocket(wsUrl(path));
    wsRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => {
      attemptRef.current = 0;
      setConnected(true);
      setStatus('connected');
    };

    ws.onclose = () => {
      setConnected(false);
      setRunning(false);
      if (!disposedRef.current && wsRef.current === ws) {
        setStatus('disconnected');
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      if (!disposedRef.current) {
        setStatus('error');
      }
    };

    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.type === 'replay' && Array.isArray(msg.events)) {
        let acc: Msg[] = [];
        for (const ev of msg.events) acc = applyEvent(ev, acc);
        setMessages(acc);
      } else if (msg.type === 'event' && msg.event) {
        if (msg.event.type === 'session_renamed') {
          setSessionName(msg.event.name || null);
        } else {
          setMessages((cur) => applyEvent(msg.event!, cur));
        }
        if (msg.event.type === 'agent_done' || msg.event.type === 'agent_error') {
          setRunning(false);
        }
      } else if (msg.type === 'started') {
        setRunning(true);
      } else if (msg.type === 'error') {
        setError(msg.message || 'Error');
        setRunning(false);
      }
    };
  }, [path]);

  const scheduleReconnect = useCallback(() => {
    if (disposedRef.current) return;
    cleanupReconnect();
    const delay = Math.min(RECONNECT_BASE * Math.pow(2, attemptRef.current), RECONNECT_MAX);
    reconnectTimer.current = setTimeout(() => {
      reconnectTimer.current = null;
      attemptRef.current += 1;
      openWs();
    }, delay);
  }, [openWs]);

  const reconnect = useCallback(() => {
    attemptRef.current = 0;
    setError(null);
    wsRef.current?.close();
    openWs();
  }, [openWs]);

  useEffect(() => {
    disposedRef.current = false;
    setMessages([]);
    setRunning(false);
    setError(null);
    setSessionName(null);
    attemptRef.current = 0;
    openWs();

    return () => {
      disposedRef.current = true;
      cleanupReconnect();
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [path, openWs]);

  const send = useCallback(
    (text: string, attachments?: Attachment[], project?: string): boolean => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        setError('Not connected. Check your connection.');
        return false;
      }
      setError(null);
      setRunning(true);
      const payload: any = { type: runType, text };
      if (attachments && attachments.length > 0) payload.attachments = attachments;
      if (project) payload.project = project;
      ws.send(JSON.stringify(payload));
      return true;
    },
    [runType]
  );

  const stop = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'stop' }));
    setRunning(false);
  }, []);

  return { messages, connected, running, status, error, sessionName, send, stop, reconnect };
}
