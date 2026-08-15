import { useState, useEffect } from 'preact/hooks';
import { useHashLocation } from 'wouter/use-hash-location';
import {
  listProjects,
  createProject,
  startProject,
  stopProject,
  deleteProject,
  getServerInfo,
  getIdeStatus,
  Project,
  ServerInfo,
  IdeStatus,
} from '../api';

export function Dashboard() {
  const [, setLocation] = useHashLocation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [ide, setIde] = useState<IdeStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [ports, setPorts] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [p, i, s] = await Promise.all([listProjects(), getServerInfo(), getIdeStatus()]);
      setProjects(p.projects);
      setInfo(i);
      setIde(s.ide);
      setLoadError(null);
    } catch (err: any) {
      setLoadError(err.message);
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  const handleCreate = async (e: Event) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const parsedPorts = ports
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
      const { project } = await createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        ports: parsedPorts,
      });
      setName('');
      setDescription('');
      setPorts('');
      setLocation(`/project/${project.slug}`);
    } catch (err: any) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleAction = async (e: MouseEvent, slug: string, action: 'start' | 'stop' | 'delete') => {
    e.stopPropagation();
    try {
      if (action === 'start') await startProject(slug);
      else if (action === 'stop') await stopProject(slug);
      else if (action === 'delete') {
        if (!confirm(`Delete project '${slug}'? (workspace files are kept)`)) return;
        await deleteProject(slug);
      }
      await refresh();
    } catch (err: any) {
      setLoadError(err.message);
    }
  };

  const baseUrl = `http://${window.location.hostname}`;

  return (
    <div class="view">
      <div class="hero">
        <span class="hero-badge">WSD-Pro v2</span>
        <h1 class="hero-title">Projects</h1>
        <p class="hero-sub">
          Every project runs in its own container on its own port. Use the IDE or opencode to build,
          and the chat to plan your ideas.
        </p>
      </div>

      <form class="create-card" onSubmit={handleCreate}>
        <div class="create-title">New project</div>
        <div class="create-row">
          <input
            class="modern-input"
            placeholder="Project name"
            value={name}
            onInput={(e: any) => setName(e.target.value)}
          />
          <input
            class="modern-input port-input"
            placeholder="Ports (optional, comma separated)"
            value={ports}
            onInput={(e: any) => setPorts(e.target.value)}
          />
          <button class="btn-primary" type="submit" disabled={creating || !name.trim()}>
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
        <input
          class="modern-input"
          style="margin-top: 10px"
          placeholder="Description (optional)"
          value={description}
          onInput={(e: any) => setDescription(e.target.value)}
        />
        {createError && <div class="login-error">{createError}</div>}
      </form>

      {loadError && <div class="login-error" style="margin: 10px 0">{loadError}</div>}

      <div class="section-head">
        <h2>Your projects</h2>
        <span class="count-pill">{projects.length}</span>
      </div>

      {projects.length === 0 ? (
        <div class="empty-state">
          <div class="big">◈</div>
          No projects yet. Create your first one above.
        </div>
      ) : (
        <div class="projects-grid">
          {projects.map((p) => (
            <div class="project-card" onClick={() => setLocation(`/project/${p.slug}`)}>
              <div class="project-card-header">
                <h3>{p.name}</h3>
                <span class={`status-badge ${p.status}`}>{p.status}</span>
              </div>
              <div class="project-desc">{p.description || '—'}</div>
              <div class="project-meta">
                <span class="meta-chip">{p.slug}</span>
                {p.hostPorts &&
                  Object.entries(p.hostPorts).map(([priv, pub]) => (
                    <span class="meta-chip port" key={priv}>
                      :{pub}
                    </span>
                  ))}
              </div>
              <div class="card-footer">
                <button
                  class="btn-ghost sm"
                  onClick={(e) => handleAction(e, p.slug, p.status === 'running' ? 'stop' : 'start')}
                >
                  {p.status === 'running' ? 'Stop' : 'Start'}
                </button>
                <button class="btn-ghost sm" onClick={(e) => handleAction(e, p.slug, 'delete')}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div class="section-head">
        <h2>System</h2>
      </div>
      <div class="overview-grid">
        <div class="panel">
          <div class="panel-title">Server</div>
          <div class="kv-list">
            <div class="kv">
              <span>Version</span>
              <b>{info?.version || '…'}</b>
            </div>
            <div class="kv">
              <span>LAN IP</span>
              <b>{info?.lanIp || '—'}</b>
            </div>
            <div class="kv">
              <span>Tailscale IP</span>
              <b>{info?.tailscaleIp || '—'}</b>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-title">Web IDE</div>
          <div class="kv-list">
            <div class="kv">
              <span>Status</span>
              <b style={`color: ${ide?.running ? 'var(--green)' : 'var(--red)'}`}>
                {ide?.running ? 'running' : 'stopped'}
              </b>
            </div>
            <div class="kv">
              <span>Port</span>
              <b>{ide ? `${baseUrl}:${ide.port}` : '…'}</b>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
