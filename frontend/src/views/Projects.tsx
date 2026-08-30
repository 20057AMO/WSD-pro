import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { FolderSearch, FolderOpen, Copy, Upload } from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import { ConfirmModal } from '../components/ConfirmModal';
import { CrashBadge } from '../components/CrashBadge';
import {
  listProjects,
  createProject,
  duplicateProject,
  importProjectSnapshot,
  startProject,
  stopProject,
  deleteProject,
  listProjectTemplates,
  wsUrl,
  type Project,
  type ProjectTemplate,
} from '../api';
import { fmtCpu, fmtMem } from '../lib/limits';

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
  const [importing, setImporting] = useState(false);
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [ports, setPorts] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [createCpu, setCreateCpu] = useState('');
  const [createMem, setCreateMem] = useState('');
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Load the saved runtime recipes once, so the create modal can offer them.
  useEffect(() => {
    listProjectTemplates()
      .then((res) => setTemplates(res.templates || []))
      .catch(() => setTemplates([]));
  }, []);

  // Deep-link from the dashboard: its empty-state "New Project" button sets
  // ws.openCreate in sessionStorage, then navigates here — we open the modal
  // once and consume the intent. (A ?create=1 query in the hash would defeat
  // wouter's route matching, so the intent is passed out-of-band instead.)
  useEffect(() => {
    let open = false;
    try { open = sessionStorage.getItem('wsd.openCreate') === '1'; } catch { /* ignored */ }
    if (open) {
      setCreateOpen(true);
      try { sessionStorage.removeItem('wsd.openCreate'); } catch { /* ignored */ }
    }
  }, []);

  // Duplicate-project modal state.
  const [dupSrc, setDupSrc] = useState<Project | null>(null);
  const [dupName, setDupName] = useState('');
  const [dupDesc, setDupDesc] = useState('');
  const [dupPorts, setDupPorts] = useState('');
  const [duplicating, setDuplicating] = useState(false);
  const [dupError, setDupError] = useState<string | null>(null);

  // Styled destructive-confirm (replaces native window.confirm).
  // Per-card delete lives in the project page's Danger zone now — the cards
  // expose an "Open" action instead.
  type ConfirmState = { kind: 'bulk-delete'; slugs: string[] };
  const [confirmState, setConfirm] = useState<ConfirmState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

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
  const crashed = projects.filter((p) => p.crash).length;

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
    if (action === 'delete') {
      if (slugs.length === 0) return;
      setConfirm({ kind: 'bulk-delete', slugs });
      return;
    }
    for (const slug of slugs) {
      try {
        if (action === 'start') await startProject(slug);
        else if (action === 'stop') await stopProject(slug);
      } catch { /* continue */ }
    }
    setSelected(new Set());
    await refresh();
  };

  const runConfirmed = async () => {
    if (!confirmState || confirmBusy) return;
    setConfirmBusy(true);
    try {
      for (const slug of confirmState.slugs) {
        try { await deleteProject(slug); } catch { /* continue */ }
      }
      setSelected(new Set());
      setConfirm(null);
      await refresh();
    } catch (err: any) {
      setLoadError(err.message);
      setConfirm(null);
    } finally {
      setConfirmBusy(false);
    }
  };

  const handleCreate = async (e: Event) => {
    e.preventDefault();
    if (!name.trim()) return;
    const parsedPorts = ports
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535);
    const hasTemplate = templateId !== '';
    if (!ports.trim() && !hasTemplate) {
      setCreateError('Ports are required (1–65535, comma separated) — or start from a template.');
      return;
    }
    if (ports.trim() && parsedPorts.length === 0) {
      setCreateError('Invalid ports — use comma-separated integers between 1 and 65535.');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      // Optional creation-time limits — blank fields mean "unconstrained",
      // the server re-validates them against the current host (400 on junk).
      const cpuText = createCpu.trim();
      const memText = createMem.trim();
      const limits =
        cpuText || memText
          ? { cpu: cpuText || undefined, memory: memText || undefined }
          : undefined;
      const { project } = await createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        ports: parsedPorts,
        templateId: hasTemplate ? templateId : undefined,
        limits,
      });
      setName('');
      setDescription('');
      setPorts('');
      setTemplateId('');
      setCreateCpu('');
      setCreateMem('');
      setCreateOpen(false);
      await refresh();
      setLocation(`/project/${project.slug}`);
    } catch (err: any) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  };

  // Choosing a template pre-fills the recipe (name/desc/ports) and lets the
  // server inherit its image + env when the project is created.
  const handleTemplatePick = (id: string) => {
    setTemplateId(id);
    if (!id) return;
    const tpl = templates.find((t) => t.id === id);
    if (!tpl) return;
    if (!name) setName(tpl.defaultName || tpl.name);
    if (!description) setDescription(tpl.description || '');
    if (!ports) setPorts((tpl.ports || []).join(', '));
  };

  const openDuplicate = (e: Event, p: Project) => {
    e.stopPropagation();
    setDupSrc(p);
    setDupName(`${p.name} Copy`);
    setDupDesc(p.description || '');
    setDupPorts((p.ports && p.ports.length > 0 ? p.ports : []).join(', '));
    setDupError(null);
  };

  const handleDuplicate = async (e: Event) => {
    e.preventDefault();
    if (!dupSrc || !dupName.trim()) return;
    const parsedPorts = dupPorts
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535);
    if (parsedPorts.length === 0) {
      setDupError('At least one port is required (1–65535), comma separated.');
      return;
    }
    setDuplicating(true);
    setDupError(null);
    try {
      const { project } = await duplicateProject(dupSrc.slug, {
        name: dupName.trim(),
        description: dupDesc.trim() || undefined,
        ports: parsedPorts,
      });
      setDupSrc(null);
      await refresh();
      setLocation(`/project/${project.slug}`);
    } catch (err: any) {
      setDupError(err.message);
    } finally {
      setDuplicating(false);
    }
  };

  const handleAction = async (e: MouseEvent, slug: string, action: 'start' | 'stop') => {
    e.stopPropagation();
    try {
      if (action === 'start') await startProject(slug);
      else await stopProject(slug);
      await refresh();
    } catch (err: any) {
      setLoadError(err.message);
    }
  };

  const openProjectCard = (e: MouseEvent, p: Project) => {
    e.stopPropagation();
    if (p.status === 'running' && p.hostPorts && Object.keys(p.hostPorts).length > 0) {
      const hostPort = Object.values(p.hostPorts)[0];
      window.open(`http://${window.location.hostname}:${hostPort}`, '_blank');
    } else {
      setLocation(`/project/${p.slug}`);
    }
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const sortIcon = (key: SortKey) => sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';

  // Restore a snapshot upload as a brand-new project, then jump to it.
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
          <p class="hero-sub" style="margin:0">{projects.length} projects · {running} running · {stopped} stopped{crashed > 0 ? ` · ${crashed} crashed` : ''}</p>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <input ref={restoreInputRef} type="file" accept=".tar.gz,application/gzip" style="display:none" onChange={handleRestoreFile} />
          <button class="btn-ghost" onClick={() => restoreInputRef.current?.click()} disabled={importing}>
            <Upload class="icon" /> {importing ? 'Restoring…' : 'Restore'}
          </button>
          <button class="btn-primary" onClick={() => setCreateOpen(true)}>+ New Project</button>
        </div>
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
                {p.crash && <CrashBadge crash={p.crash} />}
              </div>
              <div class="project-desc">{p.description || '—'}</div>
              <div class="project-meta">
                <span class="meta-chip">{p.slug}</span>
                {p.hostPorts && Object.entries(p.hostPorts).map(([priv, pub]) => (
                  <span class="meta-chip port" key={priv}>:{pub}</span>
                ))}
                {p.limits?.cpu && <span class="meta-chip" title="CPU limit">CPU {fmtCpu(p.limits.cpu)}</span>}
                {p.limits?.memory && <span class="meta-chip" title="Memory limit">RAM {fmtMem(p.limits.memory)}</span>}
              </div>
              <div class="card-footer">
                <button class="btn-ghost sm" onClick={(e) => handleAction(e, p.slug, p.status === 'running' ? 'stop' : 'start')}>
                  {p.status === 'running' ? 'Stop' : 'Start'}
                </button>
                <button class="btn-ghost sm" onClick={(e) => openProjectCard(e, p)}>
                  <FolderOpen width={13} height={13} class="icon" /> Preview
                </button>
                <button class="btn-ghost sm" title="Duplicate this project (copy files + notes)" onClick={(e) => openDuplicate(e, p)}>
                  <Copy width={13} height={13} class="icon" /> Duplicate
                </button>
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
                  <td><span class={`status-badge ${p.status}`}>{p.status}</span>{p.crash && <CrashBadge crash={p.crash} />}</td>
                  <td class="proj-td-desc">{p.description || '—'}</td>
                  <td>{p.hostPorts && Object.values(p.hostPorts).map((pub) => (
                    <span class="meta-chip port" key={pub}>:{pub}</span>
                  ))}
                  {p.limits?.cpu && <span class="meta-chip" title="CPU limit">CPU {fmtCpu(p.limits.cpu)}</span>}
                  {p.limits?.memory && <span class="meta-chip" title="Memory limit">RAM {fmtMem(p.limits.memory)}</span>}
                </td>
                  <td class="proj-td-date">{p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '—'}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button class="btn-ghost sm" onClick={(e) => handleAction(e, p.slug, p.status === 'running' ? 'stop' : 'start')}>
                      {p.status === 'running' ? '⏹' : '▶'}
                    </button>
                    <button class="btn-ghost sm" title="Preview project" onClick={(e) => openProjectCard(e, p)}>
                      <FolderOpen width={12} height={12} class="icon" />
                    </button>
                    <button class="btn-ghost sm" title="Duplicate project (copy files + notes)" onClick={(e) => openDuplicate(e, p)}>
                      <Copy width={12} height={12} class="icon" />
                    </button>
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
              <label class="settings-hint" style="display:block;margin-bottom:6px;font-size:0.72rem">Start from a saved template (optional)</label>
              <select
                class="modern-input"
                style="width:100%"
                value={templateId}
                onChange={(e: any) => handleTemplatePick(e.target.value)}
              >
                <option value="">— Blank project —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <input
                class="modern-input"
                style="margin-top:10px"
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
                placeholder="Ports (required unless starting from a template)"
                value={ports}
                onInput={(e: any) => setPorts(e.target.value)}
              />
              <div style="display:flex;gap:10px;margin-top:10px">
                <input
                  class="modern-input"
                  style="flex:1"
                  placeholder="CPU limit (optional, e.g. 2 or 500m)"
                  value={createCpu}
                  onInput={(e: any) => setCreateCpu(e.target.value)}
                />
                <input
                  class="modern-input"
                  style="flex:1"
                  placeholder="Memory limit (optional, e.g. 128Mi)"
                  value={createMem}
                  onInput={(e: any) => setCreateMem(e.target.value)}
                />
              </div>
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

      {dupSrc && (
        <div class="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !duplicating) setDupSrc(null); }}>
          <div class="create-card modal-dialog" style="max-width:500px;width:100%">
            <div class="create-title">Duplicate “{dupSrc.name}”</div>
            <p class="hero-sub" style="margin:0 0 12px">
              Creates a new project with a copy of the workspace files and developer notes.
            </p>
            <form onSubmit={handleDuplicate}>
              <input
                class="modern-input"
                placeholder="New project name"
                value={dupName}
                onInput={(e: any) => setDupName(e.target.value)}
                autoFocus
              />
              <input
                class="modern-input"
                style="margin-top:10px"
                placeholder="Description (optional)"
                value={dupDesc}
                onInput={(e: any) => setDupDesc(e.target.value)}
              />
              <input
                class="modern-input"
                style="margin-top:10px"
                placeholder="Ports (required, from the source project)"
                value={dupPorts}
                onInput={(e: any) => setDupPorts(e.target.value)}
              />
              {dupError && <div class="login-error" style="margin-top:10px">{dupError}</div>}
              <div style="display:flex;gap:10px;margin-top:14px;justify-content:flex-end">
                <button type="button" class="btn-ghost sm" onClick={() => setDupSrc(null)} disabled={duplicating}>Cancel</button>
                <button type="submit" class="btn-primary" disabled={duplicating || !dupName.trim() || !dupPorts.split(',').some((s) => { const n = Number(s.trim()); return Number.isInteger(n) && n > 0 && n <= 65535; })}>
                  {duplicating ? 'Duplicating…' : 'Duplicate'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmModal
        open={!!confirmState}
        danger
        loading={confirmBusy}
        title={`Delete ${confirmState?.slugs.length ?? 0} project(s)?`}        message="The container and its workspace files are permanently removed."
        confirmLabel="Delete"
        onConfirm={runConfirmed}
        onCancel={() => { if (!confirmBusy) setConfirm(null); }}
      />
    </div>
  );
}
