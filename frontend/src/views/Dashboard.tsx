import { useState, useEffect } from 'preact/hooks';
import { useHashLocation } from 'wouter/use-hash-location';
import {
  listProjects,
  getServerInfo,
  getIdeStatus,
  listAgents,
  Project,
  ServerInfo,
  IdeStatus,
  AgentDef,
} from '../api';

export function Dashboard() {
  const [, setLocation] = useHashLocation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [ide, setIde] = useState<IdeStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [p, i, s, a] = await Promise.all([
          listProjects(),
          getServerInfo(),
          getIdeStatus(),
          listAgents(),
        ]);
        if (cancelled) return;
        setProjects(p.projects);
        setInfo(i);
        setIde(s.ide);
        setAgents(a.agents);
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

  const quickLinks = [
    { label: 'Projects', icon: '📁', desc: `${projects.length} total`, route: '/projects' },
    { label: 'Agents', icon: '🤖', desc: `${agents.length} agents`, route: '/agents' },
    { label: 'Web IDE', icon: '💻', desc: ide?.running ? 'Running' : 'Stopped', route: '/ide' },
    { label: 'Providers', icon: '⚙', desc: 'LLM config', route: '/providers' },
  ];

  if (loading) {
    return (
      <div class="view">
        <div class="dash-loading">
          <div class="big">⏳</div>
          Loading…
        </div>
      </div>
    );
  }

  return (
    <div class="view">
      <div class="hero">
        <span class="hero-badge">WSD-Pro v2</span>
        <h1 class="hero-title">Dashboard</h1>
        <p class="hero-sub">Your development environment at a glance.</p>
      </div>

      {loadError && <div class="login-error" style="margin-bottom:16px">{loadError}</div>}

      <div class="dash-stats">
        <div class="dash-stat-card" onClick={() => setLocation('/projects')}>
          <div class="dash-stat-icon">📁</div>
          <div class="dash-stat-info">
            <span class="dash-stat-value">{projects.length}</span>
            <span class="dash-stat-label">Total Projects</span>
          </div>
        </div>
        <div class="dash-stat-card running" onClick={() => setLocation('/projects')}>
          <div class="dash-stat-icon">▶</div>
          <div class="dash-stat-info">
            <span class="dash-stat-value">{running}</span>
            <span class="dash-stat-label">Running</span>
          </div>
        </div>
        <div class="dash-stat-card stopped" onClick={() => setLocation('/projects')}>
          <div class="dash-stat-icon">⏹</div>
          <div class="dash-stat-info">
            <span class="dash-stat-value">{stopped}</span>
            <span class="dash-stat-label">Stopped</span>
          </div>
        </div>
        <div class="dash-stat-card">
          <div class="dash-stat-icon">{ide?.running ? '🟢' : '🔴'}</div>
          <div class="dash-stat-info">
            <span class="dash-stat-value">{ide?.running ? 'On' : 'Off'}</span>
            <span class="dash-stat-label">Web IDE</span>
          </div>
        </div>
      </div>

      <div class="section-head">
        <h2>Quick Actions</h2>
      </div>
      <div class="dash-actions">
        {quickLinks.map((l) => (
          <button class="dash-action-card" key={l.label} onClick={() => setLocation(l.route)}>
            <span class="dash-action-icon">{l.icon}</span>
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
