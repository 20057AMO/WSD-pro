import { useState, useEffect, useRef } from 'preact/hooks';
import { useHashLocation } from 'wouter/use-hash-location';
import {
  getProject,
  startProject,
  stopProject,
  deleteProject,
  getLogs,
  uploadFiles,
  wsUrl,
} from '../api';
import type { Project } from '../api';
import { useChatSocket } from '../useChatSocket';

type Tab = 'build' | 'upload' | 'logs';

export function Project({ params }: { params: { slug: string } }) {
  const slug = params.slug;
  const [, setLocation] = useHashLocation();
  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<Tab>('build');
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState('');

  const load = async () => {
    try {
      const { project } = await getProject(slug);
      setProject(project);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [slug]);

  useEffect(() => {
    if (tab !== 'logs') return;
    getLogs(slug)
      .then((d) => setLogs(d.logs))
      .catch((err: any) => setError(err.message));
  }, [tab, slug]);

  const handleAction = async (action: 'start' | 'stop' | 'delete') => {
    try {
      if (action === 'start') await startProject(slug);
      else if (action === 'stop') await stopProject(slug);
      else {
        if (!confirm(`Delete project '${slug}'? (workspace files are kept)`)) return;
        await deleteProject(slug);
        setLocation('/');
        return;
      }
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const host = window.location.hostname;
  const portLinks = project?.hostPorts
    ? Object.entries(project.hostPorts).map(([priv, pub]) => (
        <a
          key={priv}
          class="port-link"
          href={`http://${host}:${pub}`}
          target="_blank"
          rel="noreferrer"
        >
          <span class="p-label">container {priv}</span>
          <span class="p-val">{host}:{pub}</span>
        </a>
      ))
    : [];

  return (
    <div class="view">
      {error && <div class="login-error" style="margin-bottom: 12px">{error}</div>}

      <div class="detail-topbar">
        <button class="btn-ghost sm" onClick={() => setLocation('/')}>← Back</button>
        <div class="detail-title-wrap">
          <div class="detail-avatar">{(project?.name || '?').charAt(0).toUpperCase()}</div>
          <div>
            <div class="detail-title">{project?.name || 'Loading…'}</div>
            <div class="detail-meta-line">
              <span class="detail-slug">{slug}</span>
              <span class={`status-badge ${project?.status || 'missing'}`}>{project?.status || '…'}</span>
            </div>
          </div>
        </div>
        <div class="detail-actions">
          <button
            class="btn-ghost sm"
            onClick={() => handleAction(project?.status === 'running' ? 'stop' : 'start')}
          >
            {project?.status === 'running' ? 'Stop' : 'Start'}
          </button>
          <button class="btn-danger sm" onClick={() => handleAction('delete')}>Delete</button>
        </div>
      </div>

      {portLinks.length > 0 && (
        <div class="panel" style="margin-bottom: 16px">
          <div class="panel-title">Previews</div>
          <div class="port-grid">{portLinks}</div>
        </div>
      )}

      <div class="detail-tabs">
        {(['build', 'upload', 'logs'] as Tab[]).map((t) => (
          <button class={`tab-btn ${tab === t ? 'active' : ''}`} key={t} onClick={() => setTab(t)}>
            {t === 'build' ? 'Build (opencode)' : t === 'upload' ? 'Upload' : 'Logs'}
          </button>
        ))}
      </div>

      {tab === 'build' && <BuildPanel slug={slug} />}
      {tab === 'upload' && <UploadPanel slug={slug} />}
      {tab === 'logs' && (
        <div class="logs-box mono">{logs || 'No logs yet.'}</div>
      )}
    </div>
  );
}

function BuildPanel({ slug }: { slug: string }) {
  const { messages, connected, running, error, send, stop } = useChatSocket(
    wsUrl(`/ws/opencode/${slug}`),
    'run'
  );
  const [prompt, setPrompt] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = (e: Event) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    setInputError(null);
    send(prompt.trim());
    setPrompt('');
  };

  return (
    <div>
      <div class="term-toolbar">
        <span class="term-status">
          <span class={`dot ${connected ? 'ok' : ''}`} />
          opencode
        </span>
        <span class="term-title">
          {running ? 'running…' : connected ? 'idle' : 'offline'} {error ? ` · ${error}` : ''}
        </span>
        <span class="term-actions">
          {running && (
            <button class="btn-danger sm" onClick={stop}>Stop</button>
          )}
        </span>
      </div>
      <div class="terminal-box" ref={bodyRef} style="height: 480px">
        {messages.length === 0 && <div class="terminal-line dim">Tell opencode what to build.</div>}
        {messages.map((m, i) => (
          <div
            class={
              m.role === 'user'
                ? 'terminal-line t-cmd'
                : m.role === 'error'
                ? 'terminal-line t-err'
                : 'terminal-line t-out'
            }
            key={i}
          >
            {m.role === 'user' ? `$ ${m.text}` : m.text}
          </div>
        ))}
      </div>
      <form class="terminal-input-row" onSubmit={submit}>
        <span class="terminal-prompt">›</span>
        <input
          class="terminal-input"
          placeholder="Describe what to build or fix…"
          value={prompt}
          onInput={(e: any) => setPrompt(e.target.value)}
          disabled={running}
        />
        {running && <span class="dim" style="color: var(--text-3); font-size: 0.72rem">running…</span>}
        <button class="btn-primary sm" type="submit" disabled={running || !prompt.trim()}>
          Run
        </button>
      </form>
      {inputError && <div class="login-error">{inputError}</div>}
    </div>
  );
}

function UploadPanel({ slug }: { slug: string }) {
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    setResult(null);
    try {
      const { files: saved } = await uploadFiles(slug, files);
      setResult(`Uploaded ${saved.length} file(s): ${saved.map((f) => f.path).join(', ')}`);
      setFiles([]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <form class="create-card" onSubmit={submit}>
      <div class="create-title">Upload files to /workspaces/{slug}</div>
      <input
        class="modern-input"
        type="file"
        multiple
        onChange={(e: any) => setFiles(Array.from(e.target.files || []))}
      />
      <div class="kv" style="margin-top: 12px">
        <span>{files.length} file(s) selected</span>
        <button class="btn-primary sm" type="submit" disabled={uploading || files.length === 0}>
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
      </div>
      {error && <div class="login-error" style="margin-top: 8px">{error}</div>}
      {result && <div class="terminal-line t-ok" style="margin-top: 8px">{result}</div>}
    </form>
  );
}
