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

export interface ChatSocketState {
  messages: Msg[];
  connected: boolean;
  running: boolean;
  error: string | null;
  send: (text: string, attachments?: Attachment[]) => void;
  stop: () => void;
}

export function useChatSocket(path: string, runType: 'run' | 'prompt'): ChatSocketState {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(path);
    wsRef.current = ws;
    setMessages([]);
    setRunning(false);
    setError(null);

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setError('Connection error');

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

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [path]);

  const send = useCallback(
    (text: string, attachments?: Attachment[]) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      setError(null);
      setRunning(true);
      const payload: any = { type: runType, text };
      if (attachments && attachments.length > 0) payload.attachments = attachments;
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

  return { messages, connected, running, error, send, stop };
}
