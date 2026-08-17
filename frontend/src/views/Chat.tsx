import { useState, useEffect, useRef } from 'preact/hooks';
import { marked } from 'marked';
import { useHashLocation } from 'wouter/use-hash-location';
import {
  getChatInfo,
  getChatModels,
  saveChatConfig,
  listProjects,
  getChatContext,
  listChatSessions,
  createChatSession,
  renameChatSession,
  deleteChatSession,
  type ChatLanguage,
  type ChatProvider,
  type Project,
  type ChatSession,
  type IndexStats,
} from '../api';
import { useChatSocket, type Attachment } from '../useChatSocket';

const MAX_ATTACHMENTS = 5;
const MAX_TEXT_FILE_CHARS = 100000;
const TEXT_EXT = /\.(txt|md|markdown|json|js|jsx|ts|tsx|py|html?|css|scss|xml|ya?ml|toml|ini|cfg|sh|bash|zsh|fish|c|cc|cpp|h|hpp|java|go|rs|rb|php|sql|csv|log|env|gitignore)$/i;

interface PendingFile {
  id: string;
  file: File;
  name: string;
  size: number;
  type: string;
  data: string | null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function relTime(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function isTextLike(name: string, type: string): boolean {
  return type.startsWith('text/') || TEXT_EXT.test(name);
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:/gi, '$1=$2');
}

function renderMarkdown(src: string): string {
  const html = marked.parse(src, { gfm: true, breaks: true });
  return sanitizeHtml(typeof html === 'string' ? html : src);
}

export function Chat() {
  const [location] = useHashLocation();
  // Chat socket path depends on the active scope + session so switching reconnects.
  const [contextScope, setContextScope] = useState<string>(''); // '' = none | 'all' | slug
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  const [ctxPreview, setCtxPreview] = useState('');
  const [ctxStats, setCtxStats] = useState<IndexStats | null>(null);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);

  const chatSlug = contextScope === '' || contextScope === 'all' ? 'global' : contextScope;
  const projectForScope = chatSlug === 'global' ? undefined : chatSlug;
  const wsPath = `/ws/chat/${chatSlug}/${activeSession?.chatId || 'main'}`;

  const { messages, running, status, error, send, stop, reconnect } = useChatSocket(wsPath, 'prompt');

  const [prompt, setPrompt] = useState('');
  const [provider, setProvider] = useState<ChatProvider>('ollama');
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);
  const [model, setModel] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [language, setLanguage] = useState<ChatLanguage>('auto');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [sysOpen, setSysOpen] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [pending, setPending] = useState<PendingFile[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const effectiveModel = model === 'custom' ? customModel.trim() : model;
  const badgeModel = model === 'custom' ? customModel.trim() || '…' : model;
  const contextLabel =
    contextScope === 'all' ? 'All projects' : contextScope ? projects.find((p) => p.slug === contextScope)?.name || contextScope : '';

  useEffect(() => {
    getChatInfo()
      .then((info) => {
        setProvider(info.provider);
        setProviders(info.providers || []);
        setModel(info.model);
        setLanguage(info.language);
        setSystemPrompt(info.systemPrompt);
        setModels((prev) => (prev.includes(info.model) ? prev : [info.model, ...prev]));
      })
      .catch(() => {});
    listProjects()
      .then(({ projects: list }) => {
        setProjects(list);
        // Deep link: /chat?project=slug selects the scope immediately.
        const q = new URLSearchParams(location.split('?')[1] || '');
        const p = (q.get('project') || '').trim();
        if (p === 'all') {
          setContextScope('all');
        } else if (p && list.some((pr) => pr.slug === p)) {
          setContextScope(p);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadingModels(true);
    getChatModels(provider)
      .then(({ models: list }) => {
        if (cancelled) return;
        setModels(list);
        setModel((cur) => {
          if (cur === 'custom') return cur;
          if (list.includes(cur)) return cur;
          return list[0] || cur;
        });
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  // Load (and lazily create) sessions for the current scope.
  useEffect(() => {
    let cancelled = false;
    setSessions([]);
    setActiveSession(null);
    listChatSessions(projectForScope)
      .then(async ({ sessions: list }) => {
        if (cancelled) return;
        let current = list;
        let active = current[0] || null;
        if (!active) {
          const { session } = await createChatSession({ project: projectForScope });
          if (cancelled) return;
          current = [session];
          active = session;
        }
        setSessions(current);
        setActiveSession(active);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [chatSlug]);

  // Refresh the context preview when the scope changes.
  useEffect(() => {
    if (contextScope === '') {
      setCtxPreview('');
      setCtxStats(null);
      setCtxOpen(false);
      return;
    }
    let cancelled = false;
    getChatContext(contextScope)
      .then((ctx) => {
        if (cancelled) return;
        setCtxPreview(ctx.text);
        setCtxStats(ctx.indexStats ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setCtxPreview('');
          setCtxStats(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [contextScope]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  const save = async () => {
    if (!effectiveModel) return;
    setSaveError(null);
    setSaveMsg(null);
    try {
      await saveChatConfig({ provider, model: effectiveModel, language, systemPrompt });
      setSaveMsg('Saved ✓');
      setTimeout(() => setSaveMsg(null), 2500);
    } catch (err: any) {
      setSaveError(err.message);
    }
  };

  const handleNewSession = async () => {
    try {
      const { session } = await createChatSession({ project: projectForScope });
      setSessions((cur) => [session, ...cur]);
      setActiveSession(session);
    } catch {
      /* ignore */
    }
  };

  const handleRenameSession = async (s: ChatSession) => {
    const name = window.prompt('Session name:', s.name);
    if (!name || !name.trim() || name.trim() === s.name) return;
    try {
      const { session } = await renameChatSession(s.chatId, name.trim(), projectForScope);
      setSessions((cur) => cur.map((x) => (x.chatId === session.chatId ? session : x)));
      if (activeSession?.chatId === session.chatId) setActiveSession(session);
    } catch {
      /* ignore */
    }
  };

  const handleDeleteSession = async (s: ChatSession) => {
    if (!confirm(`Delete session '${s.name}'? Its history will be removed.`)) return;
    try {
      await deleteChatSession(s.chatId, projectForScope);
      const next = sessions.filter((x) => x.chatId !== s.chatId);
      setSessions(next);
      if (activeSession?.chatId === s.chatId) {
        if (next.length > 0) setActiveSession(next[0]);
        else handleNewSession();
      }
    } catch {
      /* ignore */
    }
  };

  const addFiles = (fileList: FileList | null) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setSendError(null);
    const room = MAX_ATTACHMENTS - pending.length;
    if (files.length > room) setSendError(`Max ${MAX_ATTACHMENTS} attachments per message`);
    const added = files.slice(0, Math.max(room, 0));
    const items: PendingFile[] = added.map((f) => ({
      id: `${f.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      file: f,
      name: f.name,
      size: f.size,
      type: f.type,
      data: null,
    }));
    setPending((cur) => [...cur, ...items]);
    for (const it of items) {
      if (it.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = String(reader.result || '');
          setPending((cur) => cur.map((x) => (x.id === it.id ? { ...x, data: dataUrl } : x)));
        };
        reader.readAsDataURL(it.file);
      }
    }
  };

  const removeFile = (id: string) => setPending((cur) => cur.filter((x) => x.id !== id));

  async function toAttachment(p: PendingFile): Promise<Attachment> {
    if (p.type.startsWith('image/')) {
      const data =
        p.data ||
        (await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.readAsDataURL(p.file);
        }));
      return { kind: 'image', name: p.name, data, size: p.size };
    }
    if (isTextLike(p.name, p.type)) {
      if (p.size > MAX_TEXT_FILE_CHARS) return { kind: 'file', name: p.name, size: p.size };
      const text = await p.file.text();
      return { kind: 'text', name: p.name, text, size: text.length };
    }
    return { kind: 'file', name: p.name, size: p.size };
  }

  const submit = async (e: Event) => {
    e.preventDefault();
    const text = prompt.trim();
    if ((!text && pending.length === 0) || running || reading) return;
    setReading(true);
    setSendError(null);
    try {
      const attachments = await Promise.all(pending.map(toAttachment));
      send(text, attachments, contextScope || undefined);
      setPrompt('');
      setPending([]);
    } catch (err: any) {
      setSendError(err.message || 'Failed to read attachment');
    } finally {
      setReading(false);
    }
  };

  return (
    <div class="view" style="max-width: 860px; display: flex; flex-direction: column; height: calc(100dvh - 120px);">
      <div class="hero" style="margin-bottom: 14px">
        <span class="hero-badge">Chat · {badgeModel || '…'}</span>
        <h1 class="hero-title" style="font-size: 1.5rem">Plan & Design</h1>
        <p class="hero-sub">
          Discuss ideas, architecture and project structure. Link a project below and the assistant
          will be aware of its goals and files — use opencode in the sidebar to build.
        </p>
      </div>

      <div class="chat-settings">
        <div class="chat-settings-row">
          <label class="chat-settings-label">
            <span>Provider</span>
            <select
              class="modern-input chat-sel"
              value={provider}
              onChange={(e: any) => setProvider(e.target.value as ChatProvider)}
            >
              {providers.length === 0 ? <option value="ollama">Ollama Cloud</option> : null}
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label class="chat-settings-label">
            <span>Model</span>
            <select
              class="modern-input chat-sel"
              value={model}
              onChange={(e: any) => setModel(e.target.value)}
            >
              {loadingModels ? <option disabled>Loading…</option> : null}
              {!loadingModels && models.length === 0 ? (
                <option value="" disabled>No models found</option>
              ) : null}
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
              <option value="custom">Custom…</option>
            </select>
          </label>
          {model === 'custom' && (
            <input
              class="modern-input chat-sel"
              placeholder="model name"
              value={customModel}
              onInput={(e: any) => setCustomModel(e.target.value)}
            />
          )}
          <label class="chat-settings-label">
            <span>Language</span>
            <select
              class="modern-input chat-sel"
              value={language}
              onChange={(e: any) => setLanguage(e.target.value as ChatLanguage)}
            >
              <option value="auto">Auto</option>
              <option value="ar">العربية</option>
              <option value="en">English</option>
            </select>
          </label>
          <label class="chat-settings-label">
            <span>Project context</span>
            <select
              class="modern-input chat-sel"
              value={contextScope}
              onChange={(e: any) => setContextScope(e.target.value)}
            >
              <option value="">None</option>
              <option value="all">All projects</option>
              {projects.map((p) => (
                <option key={p.slug} value={p.slug}>{p.name}</option>
              ))}
            </select>
          </label>
          <button class="btn-primary sm chat-save-btn" type="button" onClick={save} disabled={!effectiveModel}>
            Save
          </button>
          <button class="btn-ghost sm" type="button" onClick={() => setSysOpen(!sysOpen)}>
            {sysOpen ? 'System prompt ▴' : 'System prompt ▾'}
          </button>
        </div>
        {sysOpen && (
          <div class="chat-settings-body">
            <textarea
              class="modern-input chat-sysprompt"
              rows={4}
              placeholder="Assistant instructions…"
              value={systemPrompt}
              onInput={(e: any) => setSystemPrompt(e.target.value)}
            />
          </div>
        )}
        {contextScope !== '' && (
          <div class="chat-ctx-row">
            <span class="chat-ctx-chip">
              Context: {contextLabel}
              {ctxStats && contextScope !== 'all' && ctxStats.files > 0 && (
                <span class="chat-ctx-stats">
                  · {ctxStats.files} file{ctxStats.files === 1 ? '' : 's'} · {ctxStats.chunks} chunks
                  {ctxStats.rebuilt ? ' · rebuilt' : ''}
                </span>
              )}
            </span>
            <button class="btn-ghost sm" type="button" onClick={() => setCtxOpen(!ctxOpen)}>
              {ctxOpen ? 'Hide preview ▴' : 'Preview ▾'}
            </button>
          </div>
        )}
        {ctxOpen && (
          <div class="ctx-preview mono scrollbar">{ctxPreview || 'Loading context…'}</div>
        )}
        {saveMsg && <div class="chat-save-msg">{saveMsg}</div>}
        {saveError && <div class="login-error" style="margin: 6px 0 0">{saveError}</div>}
      </div>

      <div class="sessions-bar scrollbar">
        {sessions.map((s) => (
          <div class={`session-chip ${s.chatId === activeSession?.chatId ? 'active' : ''}`} key={s.chatId}>
            <button class="session-chip-main" type="button" onClick={() => setActiveSession(s)}>
              <span class="session-chip-name">{s.name}</span>
              <span class="session-chip-meta">{relTime(s.updatedAt)} · {s.messageCount}</span>
            </button>
            <span class="session-chip-actions">
              <button class="session-chip-act" type="button" title="Rename" onClick={() => handleRenameSession(s)}>✎</button>
              <button class="session-chip-act" type="button" title="Delete" onClick={() => handleDeleteSession(s)}>×</button>
            </span>
          </div>
        ))}
        <button class="session-new-btn" type="button" onClick={handleNewSession} title="New session">+ New</button>
      </div>

      <div class="chat-panel" style="flex: 1; display: flex; flex-direction: column; min-height: 0;">
        <div class="chat-head">
          {activeSession ? activeSession.name : 'Assistant'}
          <span style="float: right; font-size: 0.7rem; font-weight: 400; color: var(--text-2); display: flex; align-items: center; gap: 8px;">
            {status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting…' : status === 'disconnected' ? 'offline' : 'error'}
            {running && ' · typing…'}
            {(status === 'disconnected' || status === 'error') && (
              <button class="term-reconnect-btn" type="button" onClick={reconnect} title="Reconnect">↻</button>
            )}
          </span>
        </div>
        <div class="chat-body scrollbar" ref={bodyRef} style="flex: 1; height: auto; min-height: 0;">
          {messages.length === 0 && (
            <div class="chat-msg system" dir="auto">
              Ask me about your project — tech stack, structure, or how to approach a feature.
              You can attach images or files to give context.
            </div>
          )}
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div class="chat-msg user" dir="auto" key={i}>
                <span>You</span>
                {m.attachments && m.attachments.length > 0 && (
                  <div class="chat-attachments">
                    {m.attachments.map((a, j) =>
                      a.kind === 'image' && a.data ? (
                        <img class="chat-img" src={a.data} alt={a.name} key={j} />
                      ) : (
                        <span class="chat-file-chip" key={j}>📎 {a.name}</span>
                      )
                    )}
                  </div>
                )}
                <div class="chat-msg-text">{m.text}</div>
              </div>
            ) : m.role === 'error' ? (
              <div class="chat-msg system err" dir="auto" key={i}>{m.text}</div>
            ) : (
              <div class="chat-msg agent" dir="auto" key={i}>
                <span class="agent-badge">Assistant · {badgeModel || '…'}</span>
                <div class="agent-stream md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
              </div>
            )
          )}
          {error && !running && <div class="chat-msg system err" dir="auto">{error}</div>}
          {sendError && <div class="chat-msg system err" dir="auto">{sendError}</div>}
        </div>

        {pending.length > 0 && (
          <div class="chat-pending">
            {pending.map((p) => (
              <span class="chat-attach-chip" key={p.id}>
                {p.type.startsWith('image/') && p.data ? (
                  <img class="chat-attach-thumb" src={p.data} alt="" />
                ) : (
                  <span class="chat-attach-icon">📎</span>
                )}
                <span class="chat-attach-name">{p.name}</span>
                <span class="chat-attach-size">{formatSize(p.size)}</span>
                <button class="chat-attach-x" type="button" onClick={() => removeFile(p.id)}>×</button>
              </span>
            ))}
          </div>
        )}

        <form class="chat-input-row" onSubmit={submit}>
          <button
            class="btn-ghost chat-attach-btn"
            type="button"
            title="Attach files"
            onClick={() => fileRef.current?.click()}
            disabled={running || reading}
          >
            📎
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            style="display: none"
            onChange={(e: any) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <textarea
            class="modern-input agent-prompt-input"
            dir="auto"
            rows={1}
            placeholder={
              language === 'ar'
                ? 'اكتب رسالتك…'
                : language === 'en'
                  ? 'Type your message…'
                  : 'Type a message or اكتب رسالة…'
            }
            value={prompt}
            onInput={(e: any) => {
              setPrompt(e.target.value);
              const el = e.target as HTMLTextAreaElement;
              el.style.height = 'auto';
              el.style.height = Math.min(el.scrollHeight, 120) + 'px';
            }}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit(e);
              }
            }}
            disabled={running}
          />
          {running && (
            <button class="btn-danger sm" type="button" onClick={stop}>Stop</button>
          )}
          <button
            class="btn-primary"
            type="submit"
            disabled={running || reading || (!prompt.trim() && pending.length === 0)}
          >
            {reading ? '…' : 'Send'}
          </button>
        </form>
      </div>
    </div>
  );
}
