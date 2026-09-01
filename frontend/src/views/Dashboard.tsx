import { useState, useEffect, useRef } from 'preact/hooks';
import { useHashLocation } from 'wouter/use-hash-location';
import {
  Folder,
  Archive,
  Database,
  Box,
  FolderOpen,
  Loader2,
  Play,
  Square,
  TriangleAlert,
  MonitorCheck,
  MonitorOff,
  ChevronRight,
  RefreshCw,
  HardDrive,
  Globe,
  Plus,
  Upload,
  TerminalSquare,
  LayoutDashboard,
  Bot,
  Trash2,
} from 'lucide-preact';
import { CrashBadge } from '../components/CrashBadge';
import { ConfirmModal } from '../components/ConfirmModal';
import {
  listProjects,
  startProject,
  stopProject,
  getServerInfo,
  getIdeStatus,
  getStorageMetrics,
  importProjectSnapshot,
  cleanupStorage,
  Project,
  ServerInfo,
  IdeStatus,
  StorageMetrics,
  StorageCleanupResult,
} from '../api';
import { fmtCpu, fmtMem } from '../lib/limits';
import { fmtBytes } from '../lib/size';

// How many project cards to show on the dashboard before a "view all" link.
const PROJECT_PREVIEW_LIMIT = 8;

export function Dashboard() {
  const [, setLocation] = useHashLocation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [ide, setIde] = useState<IdeStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [storage, setStorage] = useState<StorageMetrics | null>(null);
  const [storageRefreshing, setStorageRefreshing] = useState(false);
  const [qaBusy, setQaBusy] = useState<string | null>(null);
  const [stopAllOpen, setStopAllOpen] = useState(false);
  const [stopAllBusy, setStopAllBusy] = useState(false);
  const restoreInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [p, i, s] = await Promise.all([
          listProjects(),
          getServerInfo(),
          getIdeStatus(),
        ]);
        if (cancelled) return;
        setProjects(p.projects);
        setInfo(i);
        setIde(s.ide);
        setLoadError(null);
      } catch (err: any) {
        if (!cancelled) setLoadError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
      try {
        const sm = await getStorageMetrics().catch(() => null);
        if (!cancelled && sm) setStorage(sm);
      } catch {
        /* storage is best-effort */
      }
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const refreshStorage = async () => {
    if (storageRefreshing) return;
    setStorageRefreshing(true);
    try {
      const sm = await getStorageMetrics(true);
      setStorage(sm);
    } catch (err: any) {
      setLoadError(err.message);
    } finally {
      setStorageRefreshing(false);
    }
  };

  // ── Quick Actions handlers ──────────────────────────────────────
  const handleNewProject = () => {
    try { sessionStorage.setItem('wsd.openCreate', '1'); } catch { /* ignored */ }
    setLocation('/projects');
  };

  const handleRestoreFile = async (e: any) => {
    const file = e.target?.files?.[0];
    if (!file) return;
    setImporting(true);
    setLoadError(null);
    try {
      const { project } = await importProjectSnapshot(file);
      setLocation(`/project/${project.slug}`);
    } catch (err: any) {
      setLoadError(err?.message || 'Restore failed');
    } finally {
      if (e.target) e.target.value = '';
      setImporting(false);
    }
  };

  const handleStartAll = async () => {
    if (qaBusy) return;
    setQaBusy('start-all');
    const errors: string[] = [];
    for (const p of projects) {
      if (p.status !== 'running') {
        try { await startProject(p.slug); }
        catch (err: any) { errors.push(`${p.name}: ${err.message || 'failed'}`); }
      }
    }
    if (errors.length > 0) {
      setLoadError(`Failed starting ${errors.length} project(s):\n${errors.join('\n')}`);
    }
    setQaBusy(null);
  };

  const handleStopAll = async () => {
    setStopAllOpen(true);
  };

  const confirmStopAll = async () => {
    if (stopAllBusy) return;
    setStopAllBusy(true);
    const errors: string[] = [];
    for (const p of projects) {
      if (p.status === 'running') {
        try { await stopProject(p.slug); }
        catch (err: any) { errors.push(`${p.name}: ${err.message || 'failed'}`); }
      }
    }
    if (errors.length > 0) {
      setLoadError(`Failed stopping ${errors.length} project(s):\n${errors.join('\n')}`);
    }
    setStopAllBusy(false);
    setStopAllOpen(false);
  };

  // ── Storage cleanup handler ─────────────────────────────────────
  const handleCleanup = async () => {
    if (cleanupBusy) return;
    setCleanupBusy(true);
    setCleanupResult(null);
    try {
      const res: StorageCleanupResult = await cleanupStorage(true);
      setCleanupBusy(false);
      setCleanupOpen(false);
      // Refresh storage metrics after cleanup
      try {
        const sm = await getStorageMetrics(true);
        setStorage(sm);
      } catch { /* best-effort refresh */ }
      // Build success summary
      const parts: string[] = [];
      const archiveCount = res.archived.length + res.purged.length;
      if (archiveCount > 0) parts.push(`${archiveCount} archive${archiveCount !== 1 ? 's' : ''} purged`);
      if (res.containersRemoved > 0) parts.push(`${res.containersRemoved} container${res.containersRemoved !== 1 ? 's' : ''} removed`);
      if (res.dockerPruned) parts.push('Docker cache pruned');
      setCleanupResult(parts.length > 0 ? `Cleaned: ${parts.join(' · ')}` : 'Nothing to clean up');
    } catch (err: any) {
      setLoadError(err.message);
      setCleanupBusy(false);
      setCleanupOpen(false);
    }
  };

  const storageTop = (storage?.projects || [])
    .slice()
    .sort((a, b) => b.workspaceBytes - a.workspaceBytes)
    .slice(0, 3);

  const running = projects.filter((p) => p.status === 'running').length;
  const stopped = projects.filter((p) => p.status === 'stopped' || p.status === 'created').length;
  const crashed = projects.filter((p) => p.crash).length;

  const handleAction = async (e: MouseEvent, slug: string, action: 'start' | 'stop') => {
    e.stopPropagation();
    if (acting) return;
    setActing(slug);
    try {
      if (action === 'start') await startProject(slug);
      else await stopProject(slug);
    } catch (err: any) {
      setLoadError(err.message);
    } finally {
      setActing(null);
    }
  };

  const openPreview = (e: MouseEvent, p: Project) => {
    e.stopPropagation();
    if (p.status === 'running' && p.serve?.enabled && p.serve.hostPort) {
      window.open(`http://${window.location.hostname}:${p.serve.hostPort}`, '_blank');
    } else if (p.status === 'running' && p.hostPorts && Object.keys(p.hostPorts).length > 0) {
      const hostPort = Object.values(p.hostPorts)[0];
      window.open(`http://${window.location.hostname}:${hostPort}`, '_blank');
    } else {
      setLocation(`/project/${p.slug}`);
    }
  };

  if (loading) {
    return (
      <div class="view">
        <div class="dash-loading">
          <Loader2 width={28} height={28} class="icon spin" />
          Loading…
        </div>
      </div>
    );
  }

  const previewProjects = projects.slice(0, PROJECT_PREVIEW_LIMIT);

  return (
    <div class="view">
      <div class="hero">
        <span class="hero-badge">BETA</span>
        <h1 class="hero-title">Dashboard</h1>
        <p class="hero-sub">Your development environment at a glance.</p>
        <button 
          class="btn-primary" 
          style="margin-top:20px" 
          onClick={() => { try { sessionStorage.setItem('wsd.openCreate', '1'); } catch { /* ignored */ } setLocation('/projects'); }}
        >
          <Play width={16} height={16} class="icon" /> + New Project
        </button>
      </div>

      {loadError && <div class="login-error" style="margin-bottom:16px">{loadError}</div>}

      {/* ── Quick Actions ─────────────────────────────────── */}
      <div class="dash-qa-section">
        <div class="dash-qa-grid">
          <button class="qa-tile" onClick={handleNewProject}>
            <Plus width={18} height={18} class="icon" />
            <span>New Project</span>
          </button>
          <button class="qa-tile" onClick={() => restoreInputRef.current?.click()} disabled={importing}>
            {importing
              ? <Loader2 width={18} height={18} class="icon spin" />
              : <Upload width={18} height={18} class="icon" />}
            <span>{importing ? 'Importing…' : 'Restore'}</span>
          </button>
          <input
            ref={restoreInputRef}
            type="file"
            accept=".tar.gz,application/gzip"
            class="dash-restore-input"
            onChange={handleRestoreFile}
          />
          <button class="qa-tile" onClick={handleStartAll} disabled={!!qaBusy}>
            <Play width={18} height={18} class="icon" />
            <span>Start All</span>
          </button>
          <button class="qa-tile" onClick={handleStopAll} disabled={!!qaBusy}>
            <Square width={18} height={18} class="icon" />
            <span>Stop All</span>
          </button>
          <button class="qa-tile" onClick={() => setLocation('/ide')}>
            <MonitorCheck width={18} height={18} class="icon" />
            <span>VS Code</span>
          </button>
          <button class="qa-tile" onClick={() => setLocation('/opencode')}>
            <Bot width={18} height={18} class="icon" />
            <span>Opencode</span>
          </button>
          <button class="qa-tile" onClick={() => setLocation('/terminals')}>
            <TerminalSquare width={18} height={18} class="icon" />
            <span>Terminals</span>
          </button>
          <button class="qa-tile" onClick={() => setLocation('/planner')}>
            <LayoutDashboard width={18} height={18} class="icon" />
            <span>Planner</span>
          </button>
        </div>
      </div>

      <div class="dash-stats">
        <div class="dash-stat-card" onClick={() => setLocation('/projects')}>
          <div class="dash-stat-icon"><FolderOpen width={18} height={18} class="icon" /></div>
          <div class="dash-stat-info">
            <span class="dash-stat-value">{projects.length}</span>
            <span class="dash-stat-label">Total Projects</span>
          </div>
        </div>
        <div class="dash-stat-card running" onClick={() => setLocation('/projects?filter=running')}>
          <div class="dash-stat-icon"><Play width={18} height={18} class="icon" /></div>
          <div class="dash-stat-info">
            <span class="dash-stat-value">{running}</span>
            <span class="dash-stat-label">Running</span>
          </div>
        </div>
        <div class="dash-stat-card stopped" onClick={() => setLocation('/projects?filter=stopped')}>
          <div class="dash-stat-icon"><Square width={18} height={18} class="icon" /></div>
          <div class="dash-stat-info">
            <span class="dash-stat-value">{stopped}</span>
            <span class="dash-stat-label">Stopped</span>
          </div>
        </div>
        {crashed > 0 && (
          <div class="dash-stat-card crashed" onClick={() => setLocation('/projects?filter=crashed')}>
            <div class="dash-stat-icon"><TriangleAlert width={18} height={18} class="icon" /></div>
            <div class="dash-stat-info">
              <span class="dash-stat-value">{crashed}</span>
              <span class="dash-stat-label">Crashed</span>
            </div>
          </div>
        )}
        <div class="dash-stat-card" onClick={() => setLocation('/ide')}>
          <div class="dash-stat-icon">{ide?.running ? <MonitorCheck width={18} height={18} class="icon" /> : <MonitorOff width={18} height={18} class="icon" />}</div>
          <div class="dash-stat-info">
            <span class="dash-stat-value">{ide?.running ? 'On' : 'Off'}</span>
            <span class="dash-stat-label">VS Code</span>
          </div>
        </div>
      </div>

      <div class="section-head">
        <h2>Projects</h2>
        {projects.length > 0 && (
          <a class="dash-view-all" href="#/projects">View all{projects.length > PROJECT_PREVIEW_LIMIT ? ` (${projects.length})` : ''}</a>
        )}
      </div>
      {previewProjects.length === 0 ? (
        <div class="empty-state" style="border:1px dashed var(--border);border-radius:10px;padding:28px">
          <div class="big-icon"><FolderOpen width={30} height={30} class="icon" /></div>
          No projects yet — create your first one.
          <button
            class="btn-primary"
            style="margin-top:12px"
            onClick={() => { try { sessionStorage.setItem('wsd.openCreate', '1'); } catch { /* ignored */ } setLocation('/projects'); }}
          >+ New Project</button>
        </div>
      ) : (
        <div class="projects-grid">
          {previewProjects.map((p) => (
            <div
              class="project-card"
              key={p.slug}
              onClick={() => setLocation(`/project/${p.slug}`)}
            >
<div class="project-card-header">
  <h3>{p.name}</h3>
  <span class={`status-badge ${p.status}`}>{p.status}</span>
  {p.crash && <CrashBadge crash={p.crash} />}
</div>
<div class="project-desc">{p.description || '—'}</div>
<div class="project-tags" style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:8px">
  {p.tags && p.tags.map(t => (
    <span class="tag-chip" key={t}>{t}</span>
  ))}
</div>
<div class="project-meta">
                {p.hostPorts && Object.entries(p.hostPorts).map(([priv, pub]) => (
                  <span class="meta-chip port" key={priv}>:{pub}</span>
                ))}
                {p.limits?.cpu && <span class="meta-chip" title="CPU limit">CPU {fmtCpu(p.limits.cpu)}</span>}
                {p.limits?.memory && <span class="meta-chip" title="Memory limit">RAM {fmtMem(p.limits.memory)}</span>}
                {p.serve?.enabled && p.serve.port && (
                  <span class="meta-chip serve" title="Static site"><Globe width={11} height={11} class="icon" /> site :{p.serve.port}</span>
                )}
                {(!p.hostPorts || Object.keys(p.hostPorts).length === 0) && !p.limits?.cpu && !p.limits?.memory && !p.serve?.enabled && <span class="meta-chip">{p.slug}</span>}
              </div>
              <div class="card-footer">
                <button class="btn-ghost sm" disabled={acting === p.slug} onClick={(e) => handleAction(e, p.slug, p.status === 'running' ? 'stop' : 'start')}>
                  {acting === p.slug ? '…' : p.status === 'running' ? 'Stop' : 'Start'}
                </button>
                <button class="btn-ghost sm" onClick={(e) => openPreview(e, p)}>
                  <FolderOpen width={13} height={13} class="icon" /> Preview
                </button>
                <button class="btn-ghost sm" onClick={(e) => { e.stopPropagation(); setLocation(`/project/${p.slug}`); }}>
                  Open <ChevronRight width={13} height={13} class="icon" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div class="panel dash-storage">
        <div class="panel-title" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <span>Storage</span>
          <div style="display:flex;gap:8px;align-items:center">
            {cleanupResult && <span class="chat-save-msg" style="margin:0">{cleanupResult}</span>}
            <button class="btn-ghost sm btn-cleanup" onClick={() => setCleanupOpen(true)} disabled={storageRefreshing}>
              <Trash2 width={13} height={13} class="icon" />
              Clean up
            </button>
            <button class="btn-ghost sm" onClick={refreshStorage} disabled={storageRefreshing}>
              {storageRefreshing ? <Loader2 width={13} height={13} class="icon spin" /> : <RefreshCw width={13} height={13} class="icon" />}
              Refresh
            </button>
          </div>
        </div>
        <p class="settings-hint">Workspaces · snapshot archives · Docker disk usage.</p>
        {storage == null ? (
          <div class="dim">Loading storage…</div>
        ) : (
          <>
            <div class="storage-metrics-grid">
              <div class="storage-metric-card">
                <div class="storage-metric-icon"><Folder width={16} height={16} class="icon" /></div>
                <div class="storage-metric-info">
                  <span class="storage-metric-label">Workspaces</span>
                  <span class="storage-metric-value">{fmtBytes(storage.totalWorkspaceBytes)}</span>
                </div>
              </div>
              <div class="storage-metric-card">
                <div class="storage-metric-icon"><Archive width={16} height={16} class="icon" /></div>
                <div class="storage-metric-info">
                  <span class="storage-metric-label">Snapshot archives</span>
                  <span class="storage-metric-value">{fmtBytes(storage.totalSnapshotBytes)}</span>
                </div>
              </div>
              <div class="storage-metric-card">
                <div class="storage-metric-icon"><Database width={16} height={16} class="icon" /></div>
                <div class="storage-metric-info">
                  <span class="storage-metric-label">Data directory</span>
                  <span class="storage-metric-value">{fmtBytes(storage.dataDirBytes)}</span>
                </div>
              </div>
              <div class="storage-metric-card">
                <div class="storage-metric-icon"><Box width={16} height={16} class="icon" /></div>
                <div class="storage-metric-info">
                  <span class="storage-metric-label">Containers (writable)</span>
                  <span class="storage-metric-value">{fmtBytes(storage.containerWritableBytes)}</span>
                </div>
              </div>
            </div>
            {storageTop.length > 0 && (
              <div class="storage-offenders">
                <div class="dim" style="font-size:0.75rem;margin:12px 0 6px">Largest workspaces</div>
                {storageTop.map((p) => {
                  const pct = storage.totalWorkspaceBytes > 0 ? (p.workspaceBytes / storage.totalWorkspaceBytes) * 100 : 0;
                  return (
                    <div class="storage-offender" key={p.slug} onClick={() => setLocation(`/project/${p.slug}`)}>
                      <div class="storage-offender-left">
                        <HardDrive width={12} height={12} class="icon" />
                        <span class="storage-offender-name">{p.name}</span>
                      </div>
                      <div class="storage-offender-right">
                        <span class="storage-offender-size">{fmtBytes(p.workspaceBytes)}</span>
                        <div class="storage-bar-bg">
                          <div class="storage-bar-fill" style={`width:${pct}%`}></div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <div class="dash-system-footer">
        <div class="dash-system-item">
          <span>Server</span>
          <span class="dash-system-val">v{info?.version || '…'}</span>
        </div>
        <div class="dash-system-item">
          <span>LAN IP</span>
          <span class="dash-system-val">{info?.lanIp || '—'}</span>
        </div>
        <div class="dash-system-item">
          <span>Tailscale</span>
          <span class="dash-system-val">{info?.tailscaleIp || '—'}</span>
        </div>
      </div>

      <ConfirmModal
        open={stopAllOpen}
        danger
        loading={stopAllBusy}
        title="Stop all projects?"
        message="Stops every running project container."
        confirmLabel="Stop All"
        onConfirm={confirmStopAll}
        onCancel={() => { if (!stopAllBusy) setStopAllOpen(false); }}
      />

      <ConfirmModal
        open={cleanupOpen}
        danger
        loading={cleanupBusy}
        title="Clean up storage?"
        message="Archives orphaned workspaces, permanently deletes snapshot archives in .archive, removes stale orphan containers, and refreshes metrics. Includes Docker build-cache pruning."
        confirmLabel="Clean Up"
        onConfirm={handleCleanup}
        onCancel={() => { if (!cleanupBusy) setCleanupOpen(false); }}
      />
    </div>
  );
}