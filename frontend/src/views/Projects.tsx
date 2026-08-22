import { useState, useEffect, useMemo } from 'preact/hooks';
import { FolderSearch } from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import {
  listProjects,
  createProject,
  startProject,
  stopProject,
  deleteProject,
  wsUrl,
  type Project,
} from '../api';

type SortKey = 'name' | 'status' | 'created';
type SortDir = 'asc' | 'desc';
type FilterStatus = 'all' | 'running' | 'stopped';
type ViewMode = 'cards' | 'table';

export function Projects() {
  const [, setLocation] = useHashLocation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterStatus>('all');
  const [sortKey, setSortKey] = useState<SortKey>('created');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [view, setView] = useState<ViewMode>('cards');

  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [ports, setPorts] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const p = await listProjects();
      setProjects(p.projects);
      setLoadError(null);
    } catch (err: any) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let closed = false;
    let timer: number | null = null;
    let socket: WebSocket | null = null;

    // Initial data fetch
    refresh();

    const connectWs = () => {
      if (closed) return;
      try {
        socket = new WebSocket(wsUrl('/ws/projects/status'));
      } catch {
        socket = null;
      }
      if (!socket) { startPolling(); return; }

      socket.onmessage = (ev) => {
        if (closed) return;
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'error') { socket?.close(); if (!closed) startPolling(); return; }
        if (msg.type === 'ready') {
          // Full status list — patch existing project statuses
          setProjects((prev) => {
            const map = new Map<string, string>(msg.projects.map((p: any) => [p.slug, p.status]));
            return prev.map((p) => {
              const newStatus = map.get(p.slug) as Project['status'] | undefined;
              return newStatus && newStatus !== p.status ? { ...p, status: newStatus } : p;
            });
          });
          setLoading(false);
          setLoadError(null);
        }
        if (msg.type === 'update') {
          // Single project status changed
          setProjects((prev) =>
            prev.map((p) => p.slug === msg.slug ? { ...p, status: msg.status } : p)
          );
        }
      };

      const fail = () => { socket?.close(); if (!closed) startPolling(); };
      socket.onerror = fail;
      socket.onclose = () => { if (!closed) startPolling(); };
    };

    const startPolling = () => {
      if (timer) return;
      const tick = async () => {
        try {
          const p = await listProjects();
          if (!closed) { setProjects(p.projects); setLoadError(null); }
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
  }, []);

  const running = projects.filter((p) => p.status === 'running').length;
  const stopped = projects.filter((p) => p.status === 'stopped' || p.status === 'created').length;

  const filtered = useMemo(() => {
    let list = projects;
    if (filter !== 'all') {
      list = list.filter((p) => filter === 'running' ? p.status === 'running' : p.status !== 'running');
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((p) =>
        p.name.toLowerCase().includes(q) ||
        p.slug.toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q)
      );
    }
    list = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortKey === 'status') cmp = a.status.localeCompare(b.status);
      else if (sortKey === 'created') cmp = (a.createdAt || '').localeCompare(b.createdAt || '');
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [projects, filter, search, sortKey, sortDir]);

  const toggleSelect = (slug: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const selectAll = () => {
    if (filtered.every((p) => selected.has(p.slug))) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((p) => p.slug)));
    }
  };

  const bulkAction = async (action: 'start' | 'stop' | 'delete') => {
    const slugs = [...selected];
    if (action === 'delete' && !confirm(`Delete ${slugs.length} project(s)? Workspace files are kept.`)) return;
    for (const slug of slugs) {
      try {
        if (action === 'start') await startProject(slug);
        else if (action === 'stop') await stopProject(slug);
        else if (action === 'delete') await deleteProject(slug);
      } catch { /* continue */ }
    }
    setSelected(new Set());
    await refresh();
  };

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
      setCreateOpen(false);
      await refresh();
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
        if (!confirm(`Delete project '${slug}'? Workspace files are kept.`)) return;
        await deleteProject(slug);
      }
      await refresh();
    } catch (err: any) {
      setLoadError(err.message);
    }
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const sortIcon = (key: SortKey) => sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';

  if (loading) {
    return (
      <div class="view">
        <div class="dash-loading"><div class="big">⏳</div>Loading…</div>
      </div>
    );
  }

  return (
    <div class="view">
      <div class="proj-header">
        <div>
          <h1 class="hero-title" style="font-size:1.5rem">Projects</h1>
          <p class="hero-sub" style="margin:0">{projects.length} projects · {running} running · {stopped} stopped</p>
        </div>
        <button class="btn-primary" onClick={() => setCreateOpen(true)}>+ New Project</button>
      </div>

      {loadError && <div class="login-error" style="margin-bottom:12px">{loadError}</div>}

      <div class="proj-toolbar">
        <div class="proj-search-row">
          <input
            class="modern-input proj-search"
            placeholder="Search projects…"
            value={search}
            onInput={(e: any) => setSearch(e.target.value)}
          />
          <select class="modern-input chat-sel" value={filter} onChange={(e: any) => setFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="running">Running</option>
            <option value="stopped">Stopped</option>
          </select>
          <select class="modern-input chat-sel" value={sortKey} onChange={(e: any) => setSortKey(e.target.value)}>
            <option value="created">Sort: Date</option>
            <option value="name">Sort: Name</option>
            <option value="status">Sort: Status</option>
          </select>
          <button class="btn-ghost sm" onClick={() => setSortDir((d) => d === 'asc' ? 'desc' : 'asc')}>
            {sortDir === 'asc' ? '↑ Asc' : '↓ Desc'}
          </button>
        </div>
        <div class="proj-view-toggle">
          <button class={`btn-ghost sm ${view === 'cards' ? 'active' : ''}`} onClick={() => setView('cards')}>▣ Cards</button>
          <button class={`btn-ghost sm ${view === 'table' ? 'active' : ''}`} onClick={() => setView('table')}>☰ Table</button>
        </div>
      </div>

      {selected.size > 0 && (
        <div class="proj-bulk-bar">
          <span>{selected.size} selected</span>
          <button class="btn-ghost sm" onClick={() => bulkAction('start')}>▶ Start All</button>
          <button class="btn-ghost sm" onClick={() => bulkAction('stop')}>⏹ Stop All</button>
          <button class="btn-danger sm" onClick={() => bulkAction('delete')}>✕ Delete All</button>
          <button class="btn-ghost sm" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {filtered.length === 0 ? (
        <div class="empty-state">
          <div class="big-icon"><FolderSearch width={30} height={30} class="icon" /></div>
          {projects.length === 0 ? 'No projects yet. Create your first one!' : 'No projects match your search.'}
        </div>
      ) : view === 'cards' ? (
        <div class="projects-grid">
          {filtered.map((p) => (
            <div
              class={`project-card ${selected.has(p.slug) ? 'selected' : ''}`}
              key={p.slug}
              onClick={() => setLocation(`/project/${p.slug}`)}
            >
              <div class="project-card-header">
                <label class="proj-checkbox" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.has(p.slug)}
                    onChange={() => toggleSelect(p.slug)}
                  />
                </label>
                <h3>{p.name}</h3>
                <span class={`status-badge ${p.status}`}>{p.status}</span>
              </div>
              <div class="project-desc">{p.description || '—'}</div>
              <div class="project-meta">
                <span class="meta-chip">{p.slug}</span>
                {p.hostPorts && Object.entries(p.hostPorts).map(([priv, pub]) => (
                  <span class="meta-chip port" key={priv}>:{pub}</span>
                ))}
              </div>
              <div class="card-footer">
                <button class="btn-ghost sm" onClick={(e) => handleAction(e, p.slug, p.status === 'running' ? 'stop' : 'start')}>
                  {p.status === 'running' ? 'Stop' : 'Start'}
                </button>
                <button class="btn-ghost sm" onClick={(e) => handleAction(e, p.slug, 'delete')}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div class="proj-table-wrap">
          <table class="proj-table">
            <thead>
              <tr>
                <th class="proj-th-check">
                  <input type="checkbox" checked={filtered.length > 0 && filtered.every((p) => selected.has(p.slug))} onChange={selectAll} />
                </th>
                <th class="proj-th-sortable" onClick={() => toggleSort('name')}>Name{sortIcon('name')}</th>
                <th>Status</th>
                <th>Description</th>
                <th>Ports</th>
                <th className="proj-th-sortable" onClick={() => toggleSort('created')}>Created{sortIcon('created')}</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.slug} class={selected.has(p.slug) ? 'selected' : ''} onClick={() => setLocation(`/project/${p.slug}`)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(p.slug)} onChange={() => toggleSelect(p.slug)} />
                  </td>
                  <td class="proj-td-name">{p.name}</td>
                  <td><span class={`status-badge ${p.status}`}>{p.status}</span></td>
                  <td class="proj-td-desc">{p.description || '—'}</td>
                  <td>{p.hostPorts && Object.values(p.hostPorts).map((pub) => (
                    <span class="meta-chip port" key={pub}>:{pub}</span>
                  ))}</td>
                  <td class="proj-td-date">{p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '—'}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button class="btn-ghost sm" onClick={(e) => handleAction(e, p.slug, p.status === 'running' ? 'stop' : 'start')}>
                      {p.status === 'running' ? '⏹' : '▶'}
                    </button>
                    <button class="btn-ghost sm" onClick={(e) => handleAction(e, p.slug, 'delete')}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <div class="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setCreateOpen(false); }}>
          <div class="create-card modal-dialog" style="max-width:500px;width:100%">
            <div class="create-title">New Project</div>
            <form onSubmit={handleCreate}>
              <input
                class="modern-input"
                placeholder="Project name"
                value={name}
                onInput={(e: any) => setName(e.target.value)}
                autoFocus
              />
              <input
                class="modern-input"
                style="margin-top:10px"
                placeholder="Description (optional)"
                value={description}
                onInput={(e: any) => setDescription(e.target.value)}
              />
              <input
                class="modern-input"
                style="margin-top:10px"
                placeholder="Ports (optional, comma separated)"
                value={ports}
                onInput={(e: any) => setPorts(e.target.value)}
              />
              {createError && <div class="login-error" style="margin-top:10px">{createError}</div>}
              <div style="display:flex;gap:10px;margin-top:14px;justify-content:flex-end">
                <button type="button" class="btn-ghost sm" onClick={() => setCreateOpen(false)}>Cancel</button>
                <button type="submit" class="btn-primary" disabled={creating || !name.trim()}>
                  {creating ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
