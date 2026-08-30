import { useState, useEffect, useRef } from 'preact/hooks';
import { ExternalLink, Download, TriangleAlert } from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import {
  getProject,
  startProject,
  stopProject,
  deleteProject,
  updateProject,
  recreateProject,
  setProjectEnv,
  setProjectPorts,
  setProjectLimits,
  cloneProject,
  getProjectStats,
  checkProjectPorts,
  getChatContext,
  getIdeStatus,
  listProjectFiles,
  getProjectFile,
  saveProjectFile,
  renameProjectPath,
  deleteProjectFile,
  uploadFiles,
  getProjectScripts,
  runProjectScript,
  getProjectSubdir,
  getLogs,
  wsUrl,
  exportProjectSnapshot,
  crashTitle,
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
import { NotesPanel } from '../components/NotesPanel';
import { fmtCpu, fmtMem, limitsPending } from '../lib/limits';
import { ProjectChat } from '../components/ProjectChat';
import { ConfirmModal } from '../components/ConfirmModal';
import { TeamPanel } from '../components/TeamPanel';
import { SnapshotsPanel } from '../components/SnapshotsPanel';
import { ProjectCanvas } from '../components/ProjectCanvas';
import { CrashBadge } from '../components/CrashBadge';
import { useAuth } from '../auth';
import { usePresence } from '../usePresence';

type Tab = 'overview' | 'chat' | 'files' | 'logs' | 'notes' | 'scripts' | 'team' | 'snapshots' | 'canvas';

const VALID_TABS: readonly Tab[] = ['overview', 'chat', 'files', 'logs', 'notes', 'scripts', 'team', 'snapshots', 'canvas'];

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
    case 'ports_updated': return 'Ports updated';
    case 'limits_updated': return 'Limits updated';
    case 'deleted': return 'Deleted';
    default: return action.charAt(0).toUpperCase() + action.slice(1);
  }
}

export function Project({ params }: { params: { slug: string } }) {
  // wouter's :slug captures query strings too (hash routing), so strip `?tab=…`.
  const slug = (params.slug || '').split('?')[0];
  const [location, setLocation] = useHashLocation();
  const { user } = useAuth();
  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [error, setError] = useState<string | null>(null);
  const [ideRunning, setIdeRunning] = useState<boolean | null>(null);
  const [subdirInfo, setSubdirInfo] = useState<SubdirInfo | null>(null);
  const [liveStats, setLiveStats] = useState<ProjectStats | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [ideNotice, setIdeNotice] = useState<string | null>(null);
  const onlineUsers = usePresence(slug);

  // Deep-linkable tabs via `?tab=<name>`. wouter's hash router relocates the
  // query into the real window.location.search, so match that first.
  useEffect(() => {
    const m = (window.location.search || location).match(/[?&]tab=([a-z]+)/);
    if (m && (VALID_TABS as readonly string[]).includes(m[1])) setTab(m[1] as Tab);
  }, [location]);

  // Viewer members (and non-members) get a read-only board; owners/admins edit.
  const readOnly = !!project && !!user && user.role !== 'admin' && project.ownerId !== user.id &&
    (project.members?.find((m) => m.userId === user.id)?.role ?? 'viewer') === 'viewer';

  // Transient notices fade out on their own.
  useEffect(() => {
    if (!ideNotice) return;
    const t = setTimeout(() => setIdeNotice(null), 4000);
    return () => clearTimeout(t);
  }, [ideNotice]);

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
    setConfirmRestart(true);
  };

  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const { blob, filename } = await exportProjectSnapshot(slug);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  };

  const runRestart = async () => {
    setConfirmRestart(false);
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
      setIdeNotice('VS Code is not running yet.');
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
      {ideNotice && <div class="chat-save-msg unlock-info-note" style="margin-bottom: 12px">{ideNotice}</div>}

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
              {project?.crash && <CrashBadge crash={project.crash} />}
              {wsConnected && <span class="ws-live-dot" title="Live updates active" />}
              {onlineUsers.length > 0 && (
                <span class="presence-indicator" title={onlineUsers.map(u => u.username).join(', ')}>
                  {onlineUsers.map(u => (
                    <span class="presence-dot" key={u.id}>
                      <span class="presence-avatar">{u.username.charAt(0).toUpperCase()}</span>
                      <span class="presence-online-dot" />
                    </span>
                  ))}
                  <span class="presence-count">{onlineUsers.length} online</span>
                </span>
              )}
            </div>
          </div>
        </div>
        <div class="detail-actions">
          <button class="btn-ghost sm" onClick={() => setTab('chat')}>Ask AI</button>
          <button class="btn-ghost sm" onClick={handleExport} disabled={exporting}>
            <Download width={13} height={13} class="icon" /> {exporting ? 'Exporting…' : 'Export'}
          </button>
          <button class="btn-ghost sm" onClick={() => setLocation(`/terminals/${slug}`)}>Terminals</button>
          <button class="btn-ghost sm" onClick={openIde}><ExternalLink width={13} height={13} class="icon" /> Open IDE</button>
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

      {project?.crash && (
        <div class="panel" style="margin-bottom: 16px; border-left: 3px solid var(--red); background: rgba(248,81,73,0.06);">
          <div style="display:flex; align-items:center; gap:8px; color: var(--red); font-weight: 600;">
            <TriangleAlert width={15} height={15} class="icon" />
            <span>This container crashed</span>
            <span class="dim" style="color:var(--text-2); font-weight:400">{crashTitle(project.crash)}</span>
          </div>
          <p class="settings-hint" style="margin: 6px 0 0">
            {project.crash.reason === 'oom'
              ? 'The container ran out of memory — check the Logs tab, then raise the memory limit or reduce the workload.'
              : project.crash.restarted
                ? 'Docker auto-restarted it (restart policy). If crashes keep repeating, inspect the Logs tab and the resource limits.'
                : 'It exited unexpectedly — check the Logs tab, then press Start to bring it back up.'}
          </p>
        </div>
      )}

      {portLinks.length > 0 && (
        <div class="panel" style="margin-bottom: 16px">
          <div class="panel-title">Previews</div>
          <div class="port-grid">{portLinks}</div>
        </div>
      )}

      <div class="detail-tabs">
        {((['overview', 'chat', 'files', 'logs', 'notes', 'scripts', 'team', 'snapshots', 'canvas'] as Tab[])).map((t) => (
          <button class={`tab-btn ${tab === t ? 'active' : ''}`} key={t} onClick={() => setTab(t)}>
            {t === 'chat' ? 'AI Chat' : t === 'notes' ? 'Notes' : t === 'team' ? 'Team' : t === 'snapshots' ? 'Snapshots' : t === 'canvas' ? 'Canvas' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewPanel slug={slug} project={project} liveStats={liveStats} onChanged={load} onError={setError} onAskAi={() => setTab('chat')} />}
      {tab === 'chat' && <ProjectChat slug={slug} />}
      {tab === 'files' && <FilesPanel slug={slug} />}
      {tab === 'logs' && <LogsPanel slug={slug} />}
      {tab === 'notes' && <NotesPanel slug={slug} />}
      {tab === 'scripts' && <ScriptsPanel slug={slug} />}
      {tab === 'team' && <TeamPanel slug={slug} project={project} onlineUsers={onlineUsers} />}
      {tab === 'snapshots' && <SnapshotsPanel slug={slug} />}
      {tab === 'canvas' && <ProjectCanvas slug={slug} readOnly={readOnly} />}

      <ConfirmModal
        open={confirmRestart}
        danger={false}
        title={`Restart project '${slug}'?`}
        message="The container stops and starts again. Workspace files are kept."
        confirmLabel="Restart"
        onConfirm={runRestart}
        onCancel={() => setConfirmRestart(false)}
      />
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

  const [portsText, setPortsText] = useState('');
  const [portsMsg, setPortsMsg] = useState<string | null>(null);
  const [savingPorts, setSavingPorts] = useState(false);
  const portsInputRef = useRef<HTMLInputElement | null>(null);

  const [cpuText, setCpuText] = useState('');
  const [memText, setMemText] = useState('');
  const [limitsMsg, setLimitsMsg] = useState<string | null>(null);
  const [savingLimits, setSavingLimits] = useState(false);
  const cpuInputRef = useRef<HTMLInputElement | null>(null);
  const memInputRef = useRef<HTMLInputElement | null>(null);

  const [recreating, setRecreating] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [confirmRecreate, setConfirmRecreate] = useState(false);

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

  useEffect(() => {
    if (document.activeElement === portsInputRef.current) return;
    setPortsText((project?.ports || []).join(', '));
  }, [project?.ports]);

  useEffect(() => {
    if (document.activeElement === cpuInputRef.current) return;
    setCpuText(project?.limits?.cpu || '');
  }, [project?.limits?.cpu]);

  useEffect(() => {
    if (document.activeElement === memInputRef.current) return;
    setMemText(project?.limits?.memory || '');
  }, [project?.limits?.memory]);

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

  const savePorts = async () => {
    if (savingPorts) return;
    const parsed = portsText
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .map(Number);
    if (parsed.length > 0 && parsed.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
      setPortsMsg('Invalid ports — use comma-separated integers 1–65535.');
      return;
    }
    setSavingPorts(true);
    try {
      const r = await setProjectPorts(slug, parsed);
      setPortsMsg(r.needsRecreate ? 'Saved. Recreate the container to apply.' : 'Saved.');
      onChanged();
    } catch (err: any) {
      setPortsMsg(`Failed: ${err.message}`);
    } finally {
      setSavingPorts(false);
    }
  };

  const saveLimits = async () => {
    if (savingLimits) return;
    const limits = {
      cpu: cpuText.trim() || null,
      memory: memText.trim() || null,
    };
    setSavingLimits(true);
    setLimitsMsg(null);
    try {
      const r = await setProjectLimits(slug, limits);
      setLimitsMsg(
        r.needsRecreate
          ? 'Saved. Recreate the container to apply.'
          : limits.cpu || limits.memory
            ? 'Saved. Already applied to the container.'
            : 'Saved. Limits removed.',
      );
      onChanged();
    } catch (err: any) {
      setLimitsMsg(`Failed: ${err.message}`);
    } finally {
      setSavingLimits(false);
    }
  };

  const doRecreate = async () => {
    setRecreating(true);
    try {
      await recreateProject(slug);
      onChanged();
    } catch (err: any) {
      onError(err.message);
    } finally {
      setRecreating(false);
      setConfirmRecreate(false);
    }
  };

  const requestRecreate = () => {
    if (recreating) return;
    setConfirmRecreate(true);
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
            <button class="btn-ghost sm" onClick={() => setLocation(`/terminals/${slug}`)}>Open terminal</button>
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
          <div class="panel-title" style="margin-top:22px">Published ports</div>
          <input
            class="modern-input mono"
            style="width:100%"
            placeholder="e.g. 8000, 8080 — blank unpublishes all"
            value={portsText}
            ref={portsInputRef}
            onInput={(e: any) => setPortsText(e.target.value)}
            onKeyDown={(e: any) => e.key === 'Enter' && savePorts()}
          />
          <div style="display:flex; gap:8px; margin-top:10px; align-items:center">
            <button class="btn-ghost sm" onClick={savePorts} disabled={savingPorts}>
              {savingPorts ? 'Saving…' : 'Save ports'}
            </button>
            {portsMsg && <span class="dim" style="color: var(--text-3); font-size:0.74rem">{portsMsg}</span>}
          </div>
          <div class="panel-title" style="margin-top:22px">Resource limits</div>
          <div style="display:flex; gap:8px; flex-wrap:wrap">
            <input
              class="modern-input mono"
              style="flex:1; min-width:120px"
              placeholder="CPU e.g. 2 or 500m — blank = no limit"
              value={cpuText}
              ref={cpuInputRef}
              onInput={(e: any) => setCpuText(e.target.value)}
              onKeyDown={(e: any) => e.key === 'Enter' && saveLimits()}
            />
            <input
              class="modern-input mono"
              style="flex:1; min-width:120px"
              placeholder="Memory e.g. 512Mi or 1Gi — blank = no limit"
              value={memText}
              ref={memInputRef}
              onInput={(e: any) => setMemText(e.target.value)}
              onKeyDown={(e: any) => e.key === 'Enter' && saveLimits()}
            />
          </div>
          <div style="display:flex; gap:8px; margin-top:10px; align-items:center; flex-wrap:wrap">
            <button class="btn-ghost sm" onClick={saveLimits} disabled={savingLimits}>
              {savingLimits ? 'Saving…' : 'Save limits'}
            </button>
            {limitsPending(project) && (
              <span class="dim" style="color: var(--amber, #eab308); font-size:0.74rem">
                Pending — container still runs on {fmtCpu(project?.liveLimits?.cpu) || 'no CPU limit'}
                {project?.liveLimits?.memory ? ` / ${fmtMem(project.liveLimits.memory)}` : ' / no memory limit'}.
                Recreate to apply.
              </span>
            )}
            {!limitsPending(project) && limitsMsg && (
              <span class="dim" style="color: var(--text-3); font-size:0.74rem">{limitsMsg}</span>
            )}
          </div>
          <div style="display:flex; gap:8px; margin-top:10px; align-items:center">
            <button class="btn-primary sm" onClick={saveEnv}>Save env</button>
            <button class="btn-ghost sm" onClick={requestRecreate} disabled={recreating}>
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
          <span>Deletes the container and permanently removes its workspace files from disk.</span>
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

      <ConfirmModal
        open={confirmRecreate}
        danger
        loading={recreating}
        title={`Recreate container for '${slug}'?`}
        message="The container stops and is rebuilt from its image. Workspace files are kept."
        confirmLabel="Recreate"
        onConfirm={doRecreate}
        onCancel={() => { if (!recreating) setConfirmRecreate(false); }}
      />
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
  const [editContent, setEditContent] = useState<string | null>(null);
  const [savingFile, setSavingFile] = useState(false);
  const [fileMsg, setFileMsg] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [confirmDeleteFile, setConfirmDeleteFile] = useState<string | null>(null);
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
      setEditContent(fp.binary ? null : fp.content);
      setFileMsg(null);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const closePreview = () => {
    setPreview(null);
    setPreviewName('');
    setEditContent(null);
    setFileMsg(null);
  };

  const saveFile = async () => {
    if (!preview || editContent === null) return;
    setSavingFile(true);
    setFileMsg(null);
    try {
      await saveProjectFile(slug, previewName, editContent);
      setFileMsg('Saved ✓');
      setTimeout(() => setFileMsg(null), 4000);
    } catch (err: any) {
      setFileMsg(`Save failed: ${err.message}`);
    } finally {
      setSavingFile(false);
    }
  };

  const newFile = () => {
    const raw = prompt('New file path (folders allowed, e.g. src/app.ts):');
    if (!raw) return;
    const clean = raw.trim().replace(/^\/+/, '');
    if (!clean) return;
    setPreview({ content: '', truncated: false, size: 0, binary: false });
    setPreviewName(cwd ? `${cwd}/${clean}` : clean);
    setEditContent('');
    setFileMsg(null);
  };

  const rename = async (name: string) => {
    const p = cwd ? `${cwd}/${name}` : name;
    const nn = prompt(`Rename "${p}" to:`, name);
    if (!nn || nn === name) return;
    const to = cwd ? `${cwd}/${nn.replace(/^\/+/, '')}` : nn.replace(/^\/+/, '');
    try {
      await renameProjectPath(slug, p, to);
      if (previewName === p) setPreviewName(to);
      load(cwd);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const remove = async (name: string) => {
    setConfirmDeleteFile(name);
  };

  const runRemoveFile = async () => {
    const name = confirmDeleteFile;
    if (!name) return;
    const p = cwd ? `${cwd}/${name}` : name;
    setConfirmDeleteFile(null);
    try {
      await deleteProjectFile(slug, p);
      if (previewName === p) {
        setPreview(null);
        setPreviewName('');
        setEditContent(null);
        setFileMsg(null);
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
          <button class="btn-ghost sm" onClick={newFile}>+ New file</button>
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
              <button class="btn-ghost sm" onClick={() => rename(e.path)}>rename</button>
              <button class="btn-danger sm" onClick={() => remove(e.path)}>delete</button>
            </div>
          </div>
        ))}
      </div>

      {preview && (
        <div class="file-preview">
          <div class="file-preview-head">
            <span class="mono">{previewName}</span>
            {editContent !== null && editContent !== preview.content && (
              <span class="dim" style="color: var(--warn, #eab308); font-size:0.72rem">• unsaved</span>
            )}
            <span class="dim" style="color: var(--text-3); font-size:0.72rem">
              {preview.binary ? `${fmtBytes(preview.size)} · binary` : `${fmtBytes(preview.size)}${preview.truncated ? ' · read-only (too large)' : ''}`}
            </span>
            {editContent !== null && (
              <button class="btn-primary sm" onClick={saveFile} disabled={savingFile}>
                {savingFile ? 'Saving…' : 'Save'}
              </button>
            )}
            <button class="btn-ghost sm" onClick={closePreview}>Close</button>
          </div>
          {fileMsg && <div class="terminal-line" style="margin: 6px 0">{fileMsg}</div>}
          {preview.binary ? (
            <div class="empty-state" style="padding: 24px">Binary file — not previewable.</div>
          ) : editContent !== null && !preview.truncated ? (
            <textarea
              class="file-editor mono scrollbar"
              value={editContent}
              onInput={(e: any) => setEditContent(e.target.value)}
              onKeyDown={(e: any) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                  e.preventDefault();
                  saveFile();
                }
              }}
              spellcheck={false}
            />
          ) : (
            <pre class="file-preview-body mono scrollbar">{preview.content}</pre>
          )}
        </div>
      )}

      <ConfirmModal
        open={!!confirmDeleteFile}
        danger
        title={`Delete ${cwd ? `${cwd}/${confirmDeleteFile}` : confirmDeleteFile}?`}
        message="This file is removed from the workspace permanently."
        confirmLabel="Delete file"
        onConfirm={runRemoveFile}
        onCancel={() => setConfirmDeleteFile(null)}
      />
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
