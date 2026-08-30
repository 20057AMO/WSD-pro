import { useState, useEffect } from 'preact/hooks';
import { useHashLocation } from 'wouter/use-hash-location';
import {
  FolderOpen,
  Bot,
  Loader2,
  Play,
  Square,
  MonitorCheck,
  MonitorOff,
  SquareTerminal,
  LayoutTemplate,
  ChevronRight,
} from 'lucide-preact';
import { VSCodeIcon, OpencodeIcon } from '../components/brand-icons';
import {
  listProjects,
  listProjectTemplates,
  startProject,
  stopProject,
  getServerInfo,
  getIdeStatus,
  listAgents,
  getOpencodeStatus,
  Project,
  ServerInfo,
  IdeStatus,
  AgentDef,
  OpencodeStatus,
} from '../api';
import { fmtCpu, fmtMem } from '../lib/limits';

// How many project cards to show on the dashboard before a "view all" link.
const PROJECT_PREVIEW_LIMIT = 8;

export function Dashboard() {
  const [, setLocation] = useHashLocation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [templatesCount, setTemplatesCount] = useState(0);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [ide, setIde] = useState<IdeStatus | null>(null);
  const [oc, setOc] = useState<OpencodeStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [p, i, s, a, o, t] = await Promise.all([
          listProjects(),
          getServerInfo(),
          getIdeStatus(),
          listAgents(),
          getOpencodeStatus().catch(() => null),
          listProjectTemplates().catch(() => ({ templates: [] })),
        ]);
        if (cancelled) return;
        setProjects(p.projects);
        setInfo(i);
        setIde(s.ide);
        setAgents(a.agents);
        setOc(o);
        setTemplatesCount(t.templates?.length || 0);
        setLoadError(null);
      } catch (err: any) {
        if (!cancelled) setLoadError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const running = projects.filter((p) => p.status === 'running').length;
  const stopped = projects.filter((p) => p.status === 'stopped' || p.status === 'created').length;

  const toolBase = `${window.location.protocol === 'https:' ? 'https' : 'http'}://${window.location.hostname}`;
  const opencodeUrl = `${toolBase}:${oc?.port || 4096}/`;

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
    if (p.status === 'running' && p.hostPorts && Object.keys(p.hostPorts).length > 0) {
      const hostPort = Object.values(p.hostPorts)[0];
      window.open(`http://${window.location.hostname}:${hostPort}`, '_blank');
    } else {
      setLocation(`/project/${p.slug}`);
    }
  };

  type QuickLink = { label: string; Icon: any; desc: string; route?: string; externalUrl?: string };
  const quickLinks: QuickLink[] = [
    { label: 'Projects', Icon: FolderOpen, desc: `${projects.length} total`, route: '/projects' },
    { label: 'Templates', Icon: LayoutTemplate, desc: `${templatesCount} recipes`, route: '/templates' },
    { label: 'Terminals', Icon: SquareTerminal, desc: 'All projects', route: '/terminals' },
    { label: 'Agents', Icon: Bot, desc: `${agents.length} agents`, route: '/agents' },
    { label: 'VS Code', Icon: VSCodeIcon, desc: ide?.running ? 'Running' : 'Stopped', route: '/ide' },
    { label: 'OpenCode', Icon: OpencodeIcon, desc: oc?.running ? 'Running' : 'Stopped', externalUrl: opencodeUrl },
  ];

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
      </div>

      {loadError && <div class="login-error" style="margin-bottom:16px">{loadError}</div>}

      <div class="dash-stats">
        <div class="dash-stat-card" onClick={() => setLocation('/projects')}>
          <div class="dash-stat-icon"><FolderOpen width={18} height={18} class="icon" /></div>
          <div class="dash-stat-info">
            <span class="dash-stat-value">{projects.length}</span>
            <span class="dash-stat-label">Total Projects</span>
          </div>
        </div>
        <div class="dash-stat-card running" onClick={() => setLocation('/projects')}>
          <div class="dash-stat-icon"><Play width={18} height={18} class="icon" /></div>
          <div class="dash-stat-info">
            <span class="dash-stat-value">{running}</span>
            <span class="dash-stat-label">Running</span>
          </div>
        </div>
        <div class="dash-stat-card stopped" onClick={() => setLocation('/projects')}>
          <div class="dash-stat-icon"><Square width={18} height={18} class="icon" /></div>
          <div class="dash-stat-info">
            <span class="dash-stat-value">{stopped}</span>
            <span class="dash-stat-label">Stopped</span>
          </div>
        </div>
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
              </div>
              <div class="project-desc">{p.description || '—'}</div>
              <div class="project-meta">
                {p.hostPorts && Object.entries(p.hostPorts).map(([priv, pub]) => (
                  <span class="meta-chip port" key={priv}>:{pub}</span>
                ))}
                {p.limits?.cpu && <span class="meta-chip" title="CPU limit">CPU {fmtCpu(p.limits.cpu)}</span>}
                {p.limits?.memory && <span class="meta-chip" title="Memory limit">RAM {fmtMem(p.limits.memory)}</span>}
                {(!p.hostPorts || Object.keys(p.hostPorts).length === 0) && !p.limits?.cpu && !p.limits?.memory && <span class="meta-chip">{p.slug}</span>}
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

      <div class="section-head">
        <h2>Quick Actions</h2>
      </div>
      <div class="dash-actions">
        {quickLinks.map((l) => (
          <button class="dash-action-card" key={l.label} onClick={() => (l.externalUrl ? window.open(l.externalUrl, '_blank', 'noopener') : setLocation(l.route || '/'))}>
            <span class="dash-action-icon"><l.Icon width={20} height={20} class="icon" /></span>
            <span class="dash-action-label">{l.label}</span>
            <span class="dash-action-desc">{l.desc}</span>
          </button>
        ))}
      </div>

      <div class="section-head">
        <h2>System</h2>
      </div>
      <div class="dash-system">
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
    </div>
  );
}