import { useState, useEffect, useRef } from 'preact/hooks';
import { getChatInfo, wsUrl } from '../api';
import { useChatSocket } from '../useChatSocket';

export function Chat() {
  const { messages, connected, running, error, send, stop } = useChatSocket(
    wsUrl('/ws/chat/main'),
    'prompt'
  );
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('qwen3:30b');
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    getChatInfo()
      .then((d) => setModel(d.model))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = (e: Event) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    send(prompt.trim());
    setPrompt('');
  };

  return (
    <div class="view" style="max-width: 760px; display: flex; flex-direction: column; height: calc(100dvh - 120px);">
      <div class="hero" style="margin-bottom: 14px">
        <span class="hero-badge">Chat · {model}</span>
        <h1 class="hero-title" style="font-size: 1.5rem">Plan & Design</h1>
        <p class="hero-sub">
          Discuss ideas, architecture and project structure. This assistant only plans —
          use opencode in the sidebar to build.
        </p>
      </div>

      <div class="chat-panel" style="flex: 1; display: flex; flex-direction: column; min-height: 0;">
        <div class="chat-head">
          Assistant
          <span style="float: right; font-size: 0.7rem; font-weight: 400; color: var(--text-2)">
            {connected ? 'connected' : 'offline'} {running ? ' · typing…' : ''}
          </span>
        </div>
        <div class="chat-body scrollbar" ref={bodyRef} style="flex: 1; height: auto; min-height: 0;">
          {messages.length === 0 && (
            <div class="chat-msg system">Ask me about your project — tech stack, structure, or how to approach a feature.</div>
          )}
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div class="chat-msg user" key={i}>
                <span>You</span>
                {m.text}
              </div>
            ) : m.role === 'error' ? (
              <div class="chat-msg system err" key={i}>{m.text}</div>
            ) : (
              <div class="chat-msg agent" key={i}>
                <span class="agent-badge">Assistant · {model}</span>
                <pre class="agent-stream">{m.text}</pre>
              </div>
            )
          )}
          {error && !running && <div class="chat-msg system err">{error}</div>}
        </div>
        <form class="chat-input-row" onSubmit={submit}>
          <input
            class="modern-input agent-prompt-input"
            placeholder="Ask about your project…"
            value={prompt}
            onInput={(e: any) => setPrompt(e.target.value)}
            disabled={running}
          />
          {running && (
            <button class="btn-danger sm" type="button" onClick={stop}>Stop</button>
          )}
          <button class="btn-primary" type="submit" disabled={running || !prompt.trim()}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
