import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { useHashLocation } from 'wouter/use-hash-location';
import { getAntigravityStatus, listProjects, wsUrl, type Project } from '../api';
import { useLanguage } from '../hooks/useLanguage';

interface AntiMsg {
  role: 'user' | 'agent' | 'error';
  text: string;
  steps?: StepInfo[];
}

interface StepInfo {
  toolName: string | null;
  state: string;
  detail: string | null;
}

interface ServerMsg {
  type: string;
  text?: string;
  message?: string;
  response?: string;
  model?: string;
  tools?: string[];
  stepType?: string;
  toolName?: string | null;
  state?: string;
  detail?: string | null;
  exitCode?: number;
  project?: string;
  framework?: string;
  language?: string;
}

export function Antigravity() {
  const [, setLocation] = useHashLocation();
  const { lang, setLang, t } = useLanguage();
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<AntiMsg[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [reviewMode, setReviewMode] = useState(false);
  const [projectInfo, setProjectInfo] = useState<{ project: string; framework: string; language: string } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const msgEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    getAntigravityStatus()
      .then((s) => { if (!cancelled) setInstalled(s.installed); })
      .catch(() => { if (!cancelled) setInstalled(false); });
    listProjects()
      .then((r) => { if (!cancelled) setProjects(r.projects.filter((p) => p.status === 'running' || p.status === 'created')); })
      .catch(() => { if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, []);

  const connectWs = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    const ws = new WebSocket(wsUrl('/ws/antigravity'));
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      setRunning(false);
    };
    ws.onerror = () => setConnected(false);

    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try { msg = JSON.parse(String(e.data)); } catch { return; }

      if (msg.type === 'context' && msg.project) {
        setProjectInfo({ project: msg.project, framework: msg.framework || '', language: msg.language || '' });
      } else if (msg.type === 'started') {
        setRunning(true);
        setMessages((prev) => [...prev, { role: 'agent', text: '', steps: [] }]);
      } else if (msg.type === 'delta' && msg.text) {
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === 'agent') {
            next[next.length - 1] = { ...last, text: last.text + msg.text };
          }
          return next;
        });
      } else if (msg.type === 'step') {
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === 'agent') {
            const steps = last.steps ? [...last.steps] : [];
            if (msg.state === 'DONE') {
              if (steps.length > 0) {
                steps[steps.length - 1] = { ...steps[steps.length - 1], state: 'DONE' };
              }
            } else {
              steps.push({
                toolName: msg.toolName || msg.stepType || null,
                state: msg.state || 'ACTIVE',
                detail: msg.detail || null,
              });
            }
            next[next.length - 1] = { ...last, steps };
          }
          return next;
        });
      } else if (msg.type === 'done') {
        setRunning(false);
      } else if (msg.type === 'error') {
        setMessages((prev) => [...prev, { role: 'error', text: msg.message || t.error }]);
        setRunning(false);
      }
    };
  }, [t]);

  useEffect(() => {
    connectWs();
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connectWs]);

  useEffect(() => {
    msgEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const getCwd = useCallback(() => {
    if (!selectedProject) return '/workspaces';
    return `/workspaces/${selectedProject}`;
  }, [selectedProject]);

  const sendContext = useCallback((cwd: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'context', cwd }));
  }, []);

  useEffect(() => {
    if (connected) {
      sendContext(getCwd());
    }
  }, [connected, selectedProject, getCwd, sendContext]);

  const send = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const text = input.trim();
    if (!text || running) return;

    setMessages((prev) => [...prev, { role: 'user', text }]);
    setInput('');
    ws.send(JSON.stringify({ type: 'prompt', text, cwd: getCwd(), reviewMode }));

    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
  }, [input, running, getCwd, reviewMode]);

  const abort = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'abort' }));
    setRunning(false);
  }, []);

  const clearChat = useCallback(() => {
    setMessages([]);
    setProjectInfo(null);
  }, []);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const handleInput = () => {
    const el = inputRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 160) + 'px';
    }
  };

  const toolLabel = (name: string | null): string => {
    if (!name) return '';
    const map = t.tools as Record<string, string>;
    return map[name] || name;
  };

  if (installed === false) {
    return (
      <div class="anti-page">
        <div class="anti-toolbar">
          <button class="btn-ghost sm" onClick={() => setLocation('/')}>← Dashboard</button>
        </div>
        <div class="empty-state" style="margin: 60px auto; max-width: 480px">
          <div class="big">✦</div>
          {t.offline}
          <code class="mono" style="display:block;margin-top:8px">{t.offlineHint}</code>
        </div>
      </div>
    );
  }

  return (
    <div class="anti-page">
      <div class="anti-toolbar">
        <button class="btn-ghost sm" onClick={() => setLocation('/')}>← Dashboard</button>
        <span class="anti-title">✦ Antigravity</span>
        <div class="anti-toolbar-right">
          <div class="anti-lang-toggle">
            <button class={`anti-lang-btn ${lang === 'ar' ? 'active' : ''}`} onClick={() => setLang('ar')}>عربي</button>
            <button class={`anti-lang-btn ${lang === 'en' ? 'active' : ''}`} onClick={() => setLang('en')}>EN</button>
          </div>
          <span class={`anti-status ${connected ? 'on' : 'off'}`}>
            {connected ? t.connected : t.disconnected}
          </span>
        </div>
      </div>

      <div class="anti-project-bar">
        <select
          class="anti-project-select"
          value={selectedProject}
          onChange={(e) => {
            const val = (e.target as HTMLSelectElement).value;
            setSelectedProject(val);
            setProjectInfo(null);
            if (connected) sendContext(val ? `/workspaces/${val}` : '/workspaces');
          }}
        >
          <option value="">{t.allProjects}</option>
          {projects.map((p) => (
            <option key={p.slug} value={p.slug}>{p.name}</option>
          ))}
        </select>

        {projectInfo && (
          <span class="anti-project-info">
            {projectInfo.framework && <span class="anti-tag">{projectInfo.framework}</span>}
            {projectInfo.language && <span class="anti-tag">{projectInfo.language}</span>}
          </span>
        )}

        <label class="anti-review-toggle" title={t.reviewModeHint}>
          <input
            type="checkbox"
            checked={reviewMode}
            onChange={(e) => setReviewMode((e.target as HTMLInputElement).checked)}
          />
          <span>{t.reviewMode}</span>
        </label>

        <button class="btn-ghost sm" onClick={clearChat}>{t.clearMessages}</button>
        <button class="btn-ghost sm" onClick={() => setLocation('/antigravity/settings')}>{t.settings}</button>
      </div>

      <div class="anti-messages">
        {messages.length === 0 && (
          <div class="anti-empty">
            <div class="anti-empty-icon">✦</div>
            <div class="anti-empty-text">{t.subtitle}</div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} class={`anti-msg ${m.role}`}>
            {m.role === 'user' ? (
              <div class="anti-msg-bubble user">{m.text}</div>
            ) : m.role === 'error' ? (
              <div class="anti-msg-bubble error">{m.text}</div>
            ) : (
              <div class="anti-msg-bubble agent">
                {m.steps && m.steps.length > 0 && (
                  <div class="anti-steps">
                    {m.steps.map((s, si) => (
                      <div key={si} class={`anti-step ${s.state === 'DONE' ? 'done' : 'active'}`}>
                        <span class="anti-step-dot" />
                        <span class="anti-step-label">{toolLabel(s.toolName)}</span>
                        {s.detail && <span class="anti-step-detail">{s.detail}</span>}
                      </div>
                    ))}
                  </div>
                )}
                {m.text && <div class="anti-msg-text">{m.text}</div>}
                {!m.text && m.steps && m.steps.length > 0 && (
                  <div class="anti-msg-text dim">{t.thinking}</div>
                )}
              </div>
            )}
          </div>
        ))}
        <div ref={msgEndRef} />
      </div>

      <div class="anti-input-bar">
        <textarea
          ref={inputRef}
          class="anti-input"
          placeholder={t.inputPlaceholder}
          value={input}
          onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={running}
          onScroll={handleInput}
        />
        {running ? (
          <button class="anti-send-btn abort" onClick={abort}>{t.abort}</button>
        ) : (
          <button class="anti-send-btn" onClick={send} disabled={!input.trim() || !connected}>
            {t.send}
          </button>
        )}
      </div>
    </div>
  );
}
