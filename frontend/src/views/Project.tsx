import { useState, useEffect, useRef } from 'preact/hooks';
import { useHashLocation } from 'wouter/use-hash-location';
import {
  getProject,
  startProject,
  stopProject,
  deleteProject,
  updateProject,
  recreateProject,
  setProjectEnv,
  cloneProject,
  getProjectStats,
  checkProjectPorts,
  getChatContext,
  getIdeStatus,
  listProjectFiles,
  getProjectFile,
  deleteProjectFile,
  uploadFiles,
  getProjectScripts,
  runProjectScript,
  getProjectSubdir,
  getLogs,
  wsUrl,
} from '../api';
import type {
  Project,
  ProjectStats,
  PortHealth,
  SubdirInfo,
  FileEntry,
  FilePreview,
  ChatContext,
} from '../api';
import { ProjectTerminal } from '../components/ProjectTerminal';
import { ProjectChat } from '../components/ProjectChat';

type Tab = 'overview' | 'chat' | 'files' | 'logs' | 'terminal' | 'scripts';

function fmtBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function fmtUptime(startedAt: string | null): string {
  if (!startedAt) return '—';
  const s = Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

function relTime(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function fmtAction(action: string): string {
  switch (action) {
    case 'created': return 'Created';
    case 'started': return 'Started';
    case 'stopped': return 'Stopped';
    case 'recreated': return 'Recreated';
    case 'cloned': return 'Git cloned';
    case 'env_updated': return 'Env updated';
    case 'deleted': return 'Deleted';
    default: return action.charAt(0).toUpperCase() + action.slice(1);
  }
}

export function Project({ params }: { params: { slug: string } }) {
  const slug = params.slug;
  const [, setLocation] = useHashLocation();
  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [error, setError] = useState<string | null>(null);
  const [ideRunning, setIdeRunning] = useState<boolean | null>(null);
  const [subdirInfo, setSubdirInfo] = useState<SubdirInfo | null>(null);
  const [liveStats, setLiveStats] = useState<ProjectStats | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  const load = async () => {
    try {
      const { project } = await getProject(slug);
      setProject(project);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    }
  };

  // WebSocket for live status + stats updates
  useEffect(() => {
    let closed = false;
    let timer: number | null = null;
    let socket: WebSocket | null = null;

    // Always fetch full project data on mount
    load();

    const connectWs = () => {
      if (closed) return;
      try {
        socket = new WebSocket(wsUrl(`/ws/projects/${slug}/status`));
      } catch {
        socket = null;
      }
      if (!socket) { startPolling(); return; }

      socket.onmessage = (ev) => {
        if (closed) return;
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'error') { socket?.close(); setWsConnected(false); if (!closed) startPolling(); return; }
        if (msg.type === 'ready' || msg.type === 'update') {
          setWsConnected(true);
          if (msg.status === 'missing') {
            setError('Project was deleted.');
            setLiveStats(null);
            return;
          }
          setProject((prev) => {
            if (!prev) return prev;
            return { ...prev, status: msg.status };
          });
          if (msg.stats !== undefined) setLiveStats(msg.stats);
        }
      };

      const fail = () => { socket?.close(); setWsConnected(false); if (!closed) startPolling(); };
      socket.onerror = fail;
      socket.onclose = () => { setWsConnected(false); if (!closed) startPolling(); };
    };

    const startPolling = () => {
      if (timer) return;
      const tick = async () => {
        try {
          const { project } = await getProject(slug);
          if (!closed) { setProject(project); setError(null); }
        } catch { /* ignore */ }
      };
      tick();
      timer = window.setInterval(tick, 5000);
    };

    connectWs();

    return () => {
      closed = true;
      if (timer) clearInterval(timer);
      try { socket?.close(); } catch { /* ignore */ }
    };
  }, [slug]);

  useEffect(() => {
    getProjectSubdir(slug)
      .then(setSubdirInfo)
      .catch(() => {});
  }, [slug]);

  useEffect(() => {
    getIdeStatus()
      .then(({ ide }) => setIdeRunning(ide.running))
      .catch(() => setIdeRunning(false));
  }, []);

  const handleStart = async () => {
    try {
      await startProject(slug);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleStop = async () => {
    try {
      await stopProject(slug);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleRestart = async () => {
    if (!confirm(`Restart project '${slug}'? (stops and starts the container)`)) return;
    try {
      await stopProject(slug);
      await startProject(slug);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const openIde = () => {
    if (!ideRunning) {
      alert('Web IDE is not running yet.');
      return;
    }
    const folder = subdirInfo?.hostPath || `/workspaces/${slug}`;
    setLocation(`/ide?folder=${encodeURIComponent(folder)}`);
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard unavailable */
    }
  };

  const host = window.location.hostname;
  const portLinks = project?.hostPorts
    ? Object.entries(project.hostPorts).map(([priv, pub]) => (
        <div key={priv} class="port-link-row">
          <a class="port-link" href={`http://${host}:${pub}`} target="_blank" rel="noreferrer">
            <span class="p-label">container {priv}</span>
            <span class="p-val">{host}:{pub}</span>
          </a>
          <button class="btn-ghost sm" title="Copy URL" onClick={() => copy(`http://${host}:${pub}`)}>Copy</button>
        </div>
      ))
    : [];

  return (
    <div class="view">
      {error && <div class="login-error" style="margin-bottom: 12px">{error}</div>}

      <div class="detail-topbar">
        <button class="btn-ghost sm" onClick={() => setLocation('/projects')}>← Projects</button>
        <div class="detail-title-wrap">
          <div class="detail-avatar">{(project?.name || '?').charAt(0).toUpperCase()}</div>
          <div>
            <div class="detail-title">
              {project?.name || 'Loading…'}
            </div>
            <div class="detail-meta-line">
              <span class="detail-slug">{slug}</span>
              <button class="btn-ghost sm" style="padding: 1px 8px" onClick={() => copy(slug)}>copy</button>
              <span class={`status-badge ${project?.status || 'missing'}`}>{project?.status || '…'}</span>
              {wsConnected && <span class="ws-live-dot" title="Live updates active" />}
            </div>
          </div>
        </div>
        <div class="detail-actions">
          <button class="btn-ghost sm" onClick={() => setTab('chat')}>Ask AI</button>
          <button class="btn-ghost sm" onClick={openIde}>Open IDE</button>
          <button
            class="btn-ghost sm"
            onClick={() => (project?.status === 'running' ? handleStop() : handleStart())}
          >
            {project?.status === 'running' ? 'Stop' : 'Start'}
          </button>
          <button class="btn-ghost sm" onClick={handleRestart} disabled={project?.status !== 'running'}>
            Restart
          </button>
        </div>
      </div>

      {portLinks.length > 0 && (
        <div class="panel" style="margin-bottom: 16px">
          <div class="panel-title">Previews</div>
          <div class="port-grid">{portLinks}</div>
        </div>
      )}

      <div class="detail-tabs">
        {(['overview', 'chat', 'files', 'logs', 'terminal', 'scripts'] as Tab[]).map((t) => (
          <button class={`tab-btn ${tab === t ? 'active' : ''}`} key={t} onClick={() => setTab(t)}>
            {t === 'chat' ? 'AI Chat' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewPanel slug={slug} project={project} liveStats={liveStats} onChanged={load} onError={setError} onAskAi={() => setTab('chat')} />}
      {tab === 'chat' && <ProjectChat slug={slug} />}
      {tab === 'files' && <FilesPanel slug={slug} />}
      {tab === 'logs' && <LogsPanel slug={slug} />}
      {tab === 'terminal' && <ProjectTerminal slug={slug} />}
      {tab === 'scripts' && <ScriptsPanel slug={slug} />}
    </div>
  );
}

// ── Overview ──────────────────────────────────────────────────
function OverviewPanel({
  slug,
  project,
  liveStats,
  onChanged,
  onError,
  onAskAi,
}: {
  slug: string;
  project: Project | null;
  liveStats: ProjectStats | null;
  onChanged: () => void;
  onError: (msg: string) => void;
  onAskAi: () => void;
}) {
  const [, setLocation] = useHashLocation();
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [checks, setChecks] = useState<PortHealth[] | null>(null);
  const [ctx, setCtx] = useState<ChatContext | null>(null);
  const [ctxOpen, setCtxOpen] = useState(false);

  const [editDesc, setEditDesc] = useState(false);
  const [descText, setDescText] = useState('');

  const [cloneUrl, setCloneUrl] = useState('');
  const [cloning, setCloning] = useState(false);
  const [cloneMsg, setCloneMsg] = useState<string | null>(null);

  const [envText, setEnvText] = useState('');
  const [envMsg, setEnvMsg] = useState<string | null>(null);

  const [recreating, setRecreating] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Prefer liveStats from WebSocket; fall back to polling
  const effectiveStats = liveStats || stats;

  useEffect(() => {
    if (project?.status !== 'running' || liveStats) {
      setStats(null);
      return;
    }
    let cancelled = false;
    const poll = () =>
      getProjectStats(slug)
        .then(({ stats: s }) => {
          if (!cancelled) setStats(s);
        })
        .catch(() => {});
    poll();
    const t = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [slug, project?.status, liveStats]);

  useEffect(() => {
    if (!project?.hostPorts || Object.keys(project.hostPorts).length === 0) {
      setChecks(null);
      return;
    }
    let cancelled = false;
    const poll = () =>
      checkProjectPorts(slug)
        .then(({ checks: c }) => {
          if (!cancelled) setChecks(c);
        })
        .catch(() => {});
    poll();
    const t = setInterval(poll, 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [slug, project?.hostPorts]);

  useEffect(() => {
    let cancelled = false;
    getChatContext(slug)
      .then((c) => {
        if (!cancelled) setCtx(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    setEnvText(Object.entries(project?.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'));
  }, [project?.env]);

  const saveDescription = async () => {
    try {
      await updateProject(slug, { description: descText });
      setEditDesc(false);
      onChanged();
    } catch (err: any) {
      onError(err.message);
    }
  };

  const doClone = async () => {
    if (!cloneUrl.trim()) return;
    setCloning(true);
    setCloneMsg(null);
    try {
      const r = await cloneProject(slug, cloneUrl.trim());
      setCloneMsg(`Cloned into ${r.target || 'workspace root'}.`);
      setCloneUrl('');
      onChanged();
    } catch (err: any) {
      setCloneMsg(`Clone failed: ${err.message}`);
    } finally {
      setCloning(false);
    }
  };

  const saveEnv = async () => {
    const env: Record<string, string> = {};
    for (const line of envText.split('\n')) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = v;
    }
    try {
      const r = await setProjectEnv(slug, env);
      setEnvMsg(r.needsRecreate ? 'Saved. Recreate the container to apply.' : 'Saved. Applies on next start.');
      onChanged();
    } catch (err: any) {
      setEnvMsg(`Failed: ${err.message}`);
    }
  };

  const doRecreate = async () => {
    if (!confirm('Recreate the container? It will be stopped and rebuilt from its image. Workspace files are kept.')) return;
    setRecreating(true);
    try {
      await recreateProject(slug);
      onChanged();
    } catch (err: any) {
      onError(err.message);
    } finally {
      setRecreating(false);
    }
  };

  const doDelete = async () => {
    if (confirmText !== slug) return;
    setDeleting(true);
    try {
      await deleteProject(slug);
      setLocation('/');
    } catch (err: any) {
      onError(err.message);
      setDeleting(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div class="overview-stack">
      <div class="overview-grid">
        <div class="panel">
          <div class="panel-title">Project info</div>
          <div class="kv-list">
            <div class="kv">
              <span>Description</span>
              <div style="display:flex; gap:8px; align-items:flex-start; justify-content:flex-end; flex:1">
                {editDesc ? (
                  <>
                    <textarea
                      class="modern-input"
                      style="flex:1; resize:vertical; min-height:48px"
                      rows={3}
                      value={descText}
                      onInput={(e: any) => setDescText(e.target.value)}
                    />
                    <button class="btn-primary sm" onClick={saveDescription}>Save</button>
                  </>
                ) : (
                  <>
                    <span style="text-align:right">{project?.description || '—'}</span>
                    <button class="btn-ghost sm" onClick={() => { setDescText(project?.description || ''); setEditDesc(true); }}>Edit</button>
                  </>
                )}
              </div>
            </div>
            <div class="kv">
              <span>Image</span>
              <b>{project?.image || 'wsd/workspace:latest'}</b>
            </div>
            <div class="kv">
              <span>Container ID</span>
              <div style="display:flex; gap:8px; align-items:center">
                <b class="mono">{project?.containerId ? project.containerId.slice(0, 12) : '—'}</b>
                {project?.containerId && (
                  <button class="btn-ghost sm" onClick={() => copy(project.containerId!)}>copy</button>
                )}
              </div>
            </div>
            <div class="kv">
              <span>Created</span>
              <b>{project?.createdAt ? fmtTime(project.createdAt) : '—'}</b>
            </div>
            <div class="kv">
              <span>Uptime</span>
              <b>{effectiveStats?.running ? fmtUptime(effectiveStats.startedAt) : project?.status === 'running' ? '…' : 'stopped'}</b>
            </div>
            <div class="kv">
              <span>Ports</span>
              <b>{project?.ports && project.ports.length > 0 ? project.ports.join(', ') : 'none'}</b>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-title">Runtime</div>
          {effectiveStats?.running ? (
            <div class="kv-list">
              <div class="kv"><span>CPU</span><b>{effectiveStats.cpuPct}%</b></div>
              <div class="stat-bar"><div class="stat-fill" style={`width: ${Math.min(100, effectiveStats.cpuPct)}%`} /></div>
              <div class="kv"><span>Memory</span><b>{fmtBytes(effectiveStats.memBytes)} / {fmtBytes(effectiveStats.memLimit)}</b></div>
              <div class="stat-bar"><div class="stat-fill" style={`width: ${Math.min(100, effectiveStats.memPct)}%`} /></div>
              <div class="kv"><span>Mem %</span><b>{effectiveStats.memPct}%</b></div>
            </div>
          ) : (
            <div class="empty-state" style="padding: 24px">Project is {project?.status || 'unknown'}. Start it to see runtime stats.</div>
          )}
        </div>
      </div>

      <div class="overview-grid">
        <div class="panel">
          <div class="panel-title">AI context</div>
          <div class="kv-list">
            <div class="kv">
              <span>Index</span>
              <b>
                {ctx?.indexStats
                  ? `${ctx.indexStats.files} files · ${ctx.indexStats.chunks} chunks`
                  : 'building…'}
              </b>
            </div>
            <div class="kv">
              <span>Budget</span>
              <b>~24 KB injected</b>
            </div>
          </div>
          <div class="kv" style="gap:10px; margin-top:10px">
            <button class="btn-primary sm" onClick={onAskAi}>Ask AI about this project</button>
            <button class="btn-ghost sm" onClick={() => setCtxOpen(!ctxOpen)}>{ctxOpen ? 'Hide preview ▴' : 'Preview ▾'}</button>
          </div>
          {ctxOpen && (
            <div class="ctx-preview mono scrollbar" style="margin-top:10px">{ctx?.text || 'Loading context…'}</div>
          )}
        </div>

        <div class="panel">
          <div class="panel-title">Port health</div>
          {checks && checks.length > 0 ? (
            <div class="kv-list">
              {checks.map((c) => (
                <div class="kv" key={c.port}>
                  <span>
                    <span class={`health-dot ${c.status}`} /> port {c.port} → {c.hostPort}
                  </span>
                  <b style={`color: ${c.status === 'open' ? 'var(--green)' : 'var(--red)'}`}>
                    {c.status === 'open' ? `HTTP ${c.httpCode}` : c.status} · {c.ms}ms
                  </b>
                </div>
              ))}
            </div>
          ) : (
            <div class="empty-state" style="padding: 24px">
              {project?.hostPorts ? 'Checking…' : 'No published ports.'}
            </div>
          )}
        </div>
      </div>

      <div class="overview-grid">
        <div class="panel">
          <div class="panel-title">Clone from git</div>
          <div style="display:flex; gap:8px">
            <input
              class="modern-input"
              style="flex:1"
              placeholder="https://github.com/org/repo.git"
              value={cloneUrl}
              onInput={(e: any) => setCloneUrl(e.target.value)}
              onKeyDown={(e: any) => e.key === 'Enter' && doClone()}
            />
            <button class="btn-primary sm" onClick={doClone} disabled={cloning || !cloneUrl.trim()}>
              {cloning ? 'Cloning…' : 'Clone'}
            </button>
          </div>
          {cloneMsg && <div class="terminal-line" style="margin-top:8px">{cloneMsg}</div>}
          <div class="panel-title" style="margin-top:22px">Environment variables</div>
          <textarea
            class="modern-input mono"
            style="width:100%; resize:vertical; min-height:96px"
            placeholder="KEY=VALUE (one per line)"
            value={envText}
            onInput={(e: any) => setEnvText(e.target.value)}
          />
          <div style="display:flex; gap:8px; margin-top:10px; align-items:center">
            <button class="btn-primary sm" onClick={saveEnv}>Save env</button>
            <button class="btn-ghost sm" onClick={doRecreate} disabled={recreating}>
              {recreating ? 'Recreating…' : 'Recreate container'}
            </button>
            {envMsg && <span class="dim" style="color: var(--text-3); font-size:0.74rem">{envMsg}</span>}
          </div>
        </div>

        <div class="panel">
          <div class="panel-title">Activity</div>
          {project?.activity && project.activity.length > 0 ? (
            <div class="activity-list">
              {project.activity.slice().reverse().slice(0, 15).map((a, i) => (
                <div class="activity-row" key={i}>
                  <span class="activity-dot-wrap">
                    <span class={`activity-dot ${a.action}`} />
                    <span class="activity-act">{fmtAction(a.action)}</span>
                  </span>
                  <span class="activity-at">{relTime(a.at)} ago</span>
                </div>
              ))}
            </div>
          ) : (
            <div class="empty-state" style="padding: 24px">No activity yet.</div>
          )}
        </div>
      </div>

      <div class="panel danger-zone">
        <div class="panel-title" style="color: var(--red)">Danger zone</div>
        <div class="kv" style="align-items:center">
          <span>Delete the project container. Workspace files on disk are kept.</span>
          <div style="display:flex; gap:8px; align-items:center">
            <input
              class="modern-input"
              style="width: 180px"
              placeholder={`type '${slug}' to confirm`}
              value={confirmText}
              onInput={(e: any) => setConfirmText(e.target.value)}
            />
            <button class="btn-danger sm" onClick={doDelete} disabled={confirmText !== slug || deleting}>
              {deleting ? 'Deleting…' : 'Delete project'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Files ─────────────────────────────────────────────────────
function FilesPanel({ slug }: { slug: string }) {
  const [cwd, setCwd] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [meta, setMeta] = useState<{ fileCount: number; totalBytes: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewName, setPreviewName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const loadSeqRef = useRef(0);

  const load = async (dir: string) => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const l = await listProjectFiles(slug, dir || undefined);
      if (seq !== loadSeqRef.current) return;
      setEntries(l.entries);
      setMeta({ fileCount: l.fileCount, totalBytes: l.totalBytes });
    } catch (err: any) {
      if (seq !== loadSeqRef.current) return;
      setError(err.message);
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    load(cwd);
  }, [cwd, slug]);

  const crumbs = cwd ? cwd.split('/') : [];

  const openFile = async (name: string) => {
    const p = cwd ? `${cwd}/${name}` : name;
    try {
      const fp = await getProjectFile(slug, p);
      setPreview(fp);
      setPreviewName(p);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const remove = async (name: string) => {
    const p = cwd ? `${cwd}/${name}` : name;
    if (!confirm(`Delete ${p}?`)) return;
    try {
      await deleteProjectFile(slug, p);
      if (previewName === p) {
        setPreview(null);
        setPreviewName('');
      }
      load(cwd);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const doUpload = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setUploadMsg(null);
    try {
      const { files: saved } = await uploadFiles(slug, files, cwd || undefined);
      setUploadMsg(`Uploaded ${saved.length} file(s)${cwd ? ` to ${cwd}` : ''}.`);
      load(cwd);
    } catch (err: any) {
      setUploadMsg(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div class="files-panel">
      <div class="files-toolbar">
        <div class="files-path">
          <button class="btn-ghost sm" onClick={() => setCwd('')} disabled={!cwd}>workspace root</button>
          {crumbs.map((c, i) => (
            <span key={i} class="files-crumb">
              <span class="dim">/</span>
              <button
                class="btn-ghost sm"
                onClick={() => setCwd(crumbs.slice(0, i + 1).join('/'))}
              >{c}</button>
            </span>
          ))}
        </div>
        <div style="display:flex; gap:8px; align-items:center">
          {meta && (
            <span class="dim" style="color: var(--text-3); font-size:0.72rem">
              {meta.fileCount} files · {fmtBytes(meta.totalBytes)}
            </span>
          )}
          <input
            ref={fileRef}
            type="file"
            multiple
            style="display:none"
            onChange={(e: any) => doUpload(Array.from(e.target.files || []))}
          />
          <button class="btn-primary sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? 'Uploading…' : `Upload${cwd ? ` to ${cwd}` : ''}`}
          </button>
        </div>
      </div>
      {uploadMsg && <div class="terminal-line" style="margin: 8px 0">{uploadMsg}</div>}
      {error && <div class="login-error" style="margin: 8px 0">{error}</div>}

      <div class="file-list">
        {entries.length === 0 && !loading && (
          <div class="empty-state" style="padding: 32px">{cwd ? 'Empty directory.' : 'Workspace is empty. Upload files or clone a repository.'}</div>
        )}
        {entries.map((e) => (
          <div class="file-row" key={e.path}>
            <button
              class="file-name"
              onClick={() => (e.type === 'dir' ? setCwd(cwd ? `${cwd}/${e.path}` : e.path) : openFile(e.path))}
            >
              <span class={`file-icon ${e.type}`}>{e.type === 'dir' ? '▸' : '·'}</span>
              <span class="mono">{e.path}</span>
            </button>
            <span class="file-size">{e.type === 'file' ? fmtBytes(e.size) : ''}</span>
            <div class="file-actions">
              {e.type === 'file' && (
                <button class="btn-ghost sm" onClick={() => openFile(e.path)}>view</button>
              )}
              <button class="btn-danger sm" onClick={() => remove(e.path)}>delete</button>
            </div>
          </div>
        ))}
      </div>

      {preview && (
        <div class="file-preview">
          <div class="file-preview-head">
            <span class="mono">{previewName}</span>
            <span class="dim" style="color: var(--text-3); font-size:0.72rem">
              {preview.binary ? `${fmtBytes(preview.size)} · binary` : `${fmtBytes(preview.size)}${preview.truncated ? ' · truncated' : ''}`}
            </span>
            <button class="btn-ghost sm" onClick={() => { setPreview(null); setPreviewName(''); }}>Close</button>
          </div>
          {preview.binary ? (
            <div class="empty-state" style="padding: 24px">Binary file — not previewable.</div>
          ) : (
            <pre class="file-preview-body mono scrollbar">{preview.content}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── Logs ──────────────────────────────────────────────────────
function LogsPanel({ slug }: { slug: string }) {
  const [logs, setLogs] = useState('');
  const [filter, setFilter] = useState('');
  const [follow, setFollow] = useState(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let closed = false;
    let timer: number | null = null;
    let socket: WebSocket | null = null;

    const connectWs = () => {
      if (closed) return;
      try {
        socket = new WebSocket(wsUrl(`/ws/projects/${slug}/logs`));
      } catch {
        socket = null;
      }
      if (!socket) {
        startPolling();
        return;
      }
      const fail = () => {
        socket?.close();
        if (!closed) startPolling();
      };
      socket.onerror = fail;
      socket.onclose = () => {
        if (!closed && !socketWasClosedByUs) startPolling();
      };
      socket.onmessage = (ev) => {
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'logs' && typeof msg.data === 'string') {
          if (!closed) setLogs((prev) => (prev + msg.data).slice(-200000));
        }
      };
    };

    let socketWasClosedByUs = false;
    const stopPolling = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const startPolling = () => {
      if (timer) return;
      const tick = () =>
        getLogs(slug, 500)
          .then((d) => {
            if (!closed) setLogs(d.logs);
          })
          .catch(() => {});
      tick();
      timer = window.setInterval(tick, 4000);
    };

    connectWs();

    return () => {
      closed = true;
      socketWasClosedByUs = true;
      stopPolling();
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [logs, follow]);

  const filtered = filter.trim()
    ? logs.split('\n').filter((l) => l.toLowerCase().includes(filter.toLowerCase())).join('\n')
    : logs;

  const download = () => {
    const blob = new Blob([logs], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slug}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(logs);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div class="logs-panel">
      <div class="logs-toolbar">
        <input
          class="modern-input"
          style="max-width: 260px"
          placeholder="Filter…"
          value={filter}
          onInput={(e: any) => setFilter(e.target.value)}
        />
        <button class="btn-ghost sm" onClick={() => setFollow(!follow)}>{follow ? 'Auto-scroll: on' : 'Auto-scroll: off'}</button>
        <button class="btn-ghost sm" onClick={copyAll}>Copy</button>
        <button class="btn-ghost sm" onClick={download}>Download</button>
        <button class="btn-ghost sm" onClick={() => setLogs('')}>Clear</button>
      </div>
      <div class="logs-box mono scrollbar" ref={bodyRef}>
        {filtered || (logs ? '' : 'No logs yet.')}
      </div>
    </div>
  );
}

// ── Scripts ───────────────────────────────────────────────────
function ScriptsPanel({ slug }: { slug: string }) {
  const [scripts, setScripts] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [output, setOutput] = useState<{ script: string; exitCode: number | null; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getProjectScripts(slug)
      .then(({ scripts: s }) => setScripts(s))
      .catch((err: any) => setError(err.message));
  }, [slug]);

  const run = async (name: string) => {
    setRunning(name);
    setError(null);
    setOutput(null);
    try {
      const r = await runProjectScript(slug, name);
      setOutput({ script: name, exitCode: r.exitCode, text: r.output });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRunning(null);
    }
  };

  const names = Object.keys(scripts);
  return (
    <div class="scripts-panel">
      <div class="panel-title">npm scripts</div>
      {error && <div class="login-error" style="margin: 8px 0">{error}</div>}
      {names.length === 0 ? (
        <div class="empty-state" style="padding: 32px">
          No package.json or no scripts. <span class="dim">(scripts run via `npm run` inside the project container)</span>
        </div>
      ) : (
        <div class="scripts-grid">
          {names.map((n) => (
            <button class="script-card" key={n} onClick={() => run(n)} disabled={running !== null}>
              <span class="script-name mono">{n}</span>
              <span class="script-cmd">{scripts[n]}</span>
              {running === n && <span class="dim">…running</span>}
            </button>
          ))}
        </div>
      )}
      {output && (
        <div class="file-preview" style="margin-top: 16px">
          <div class="file-preview-head">
            <span class="mono">npm run {output.script}</span>
            <span style={`color: ${output.exitCode === 0 ? 'var(--green)' : 'var(--red)'}`}>
              exit {output.exitCode === null ? '…' : output.exitCode}
            </span>
          </div>
          <pre class="file-preview-body mono scrollbar">{output.text || '(no output)'}</pre>
        </div>
      )}
    </div>
  );
}
