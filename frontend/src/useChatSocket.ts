import { useState, useEffect, useCallback, useRef } from 'preact/hooks';

export interface Attachment {
  kind: 'image' | 'text' | 'file';
  name: string;
  data?: string;
  text?: string;
  size: number;
}

export interface Msg {
  role: 'user' | 'agent' | 'error';
  text: string;
  attachments?: Attachment[];
}

interface ChatEvent {
  seq: number;
  type: 'user_message' | 'agent_chunk' | 'agent_done' | 'agent_error';
  content: string;
  timestamp: string;
  attachments?: Attachment[];
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
  send: (text: string, attachments?: Attachment[], project?: string) => void;
  stop: () => void;
  reconnect: () => void;
}

export function useChatSocket(path: string, runType: 'run' | 'prompt'): ChatSocketState {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<ChatStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
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

    const ws = new WebSocket(path);
    wsRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => {
      attemptRef.current = 0;
      setConnected(true);
      setStatus('connected');
    };

    ws.onclose = () => {
      setConnected(false);
      if (!disposedRef.current) {
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
        setMessages(msg.events.reduce((acc, ev) => applyEvent(ev, acc), [] as Msg[]));
      } else if (msg.type === 'event' && msg.event) {
        setMessages((cur) => applyEvent(msg.event!, cur));
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
    (text: string, attachments?: Attachment[], project?: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      setError(null);
      setRunning(true);
      const payload: any = { type: runType, text };
      if (attachments && attachments.length > 0) payload.attachments = attachments;
      if (project) payload.project = project;
      ws.send(JSON.stringify(payload));
    },
    [runType]
  );

  const stop = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'stop' }));
    setRunning(false);
  }, []);

  return { messages, connected, running, status, error, send, stop, reconnect };
}
