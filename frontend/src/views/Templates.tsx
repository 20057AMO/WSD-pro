import { useState, useEffect, useMemo } from 'preact/hooks';
import { Pencil, Trash2, Search, Boxes, Layers } from 'lucide-preact';
import { useAuth } from '../auth';
import { ConfirmModal } from '../components/ConfirmModal';
import {
  listProjectTemplates,
  createProjectTemplate,
  updateProjectTemplate,
  deleteProjectTemplate,
  type ProjectTemplate,
} from '../api';

const DEFAULT_IMAGE = 'wsd/workspace:latest';

interface EditorState {
  template: ProjectTemplate | null;
  name: string;
  description: string;
  defaultName: string;
  image: string;
  portsText: string;
  envText: string;
}

const emptyEditor = (template: ProjectTemplate | null): EditorState => ({
  template,
  name: template?.name || '',
  description: template?.description || '',
  defaultName: template?.defaultName || '',
  image: template?.image || '',
  portsText: (template?.ports || []).join(', '),
  envText: Object.entries(template?.env || {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n'),
});

function parsePorts(text: string): number[] {
  return text
    .split(/[\s,]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535);
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trim = line.trim();
    if (!trim) continue;
    const eq = trim.indexOf('=');
    const key = eq > 0 ? trim.slice(0, eq).trim() : trim;
    const value = eq > 0 ? trim.slice(eq + 1).trim() : '';
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

export function Templates() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [confirmDel, setConfirmDel] = useState<ProjectTemplate | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = async () => {
    try {
      const res = await listProjectTemplates();
      setTemplates(res.templates);
      setLoadError(null);
    } catch (err: any) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (t) => t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q),
    );
  }, [templates, search]);

  const openNew = () => {
    setSaveError(null);
    setEditor(emptyEditor(null));
  };

  const openEdit = (t: ProjectTemplate) => {
    setSaveError(null);
    setEditor(emptyEditor(t));
  };

  const handleSave = async (e: Event) => {
    e.preventDefault();
    if (!editor) return;
    if (!editor.name.trim()) {
      setSaveError('Template name is required.');
      return;
    }
    const body = {
      name: editor.name.trim(),
      description: editor.description.trim() || undefined,
      defaultName: editor.defaultName.trim() || undefined,
      image: editor.image.trim() || undefined,
      ports: parsePorts(editor.portsText),
      env: parseEnv(editor.envText),
    };
    setSaving(true);
    setSaveError(null);
    try {
      if (editor.template) {
        await updateProjectTemplate(editor.template.id, body);
      } else {
        await createProjectTemplate(body);
      }
      setEditor(null);
      await refresh();
    } catch (err: any) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDel) return;
    setDeleting(true);
    try {
      await deleteProjectTemplate(confirmDel.id);
      setConfirmDel(null);
      await refresh();
    } catch (err: any) {
      setLoadError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div class="view">
      <div class="proj-header">
        <div>
          <h1 class="hero-title" style="font-size:1.5rem">Templates</h1>
          <p class="hero-sub" style="margin:0">
            {templates.length} saved runtime recipes — {isAdmin ? 'manage or create new ones.' : 'read-only (managed by an admin).'}
          </p>
        </div>
        {isAdmin && (
          <button class="btn-primary" onClick={openNew}>
            + New Template
          </button>
        )}
      </div>

      {loadError && <div class="login-error" style="margin-bottom:12px">{loadError}</div>}

      <div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;max-width:420px">
        <Search width={16} height={16} class="icon" style="flex-shrink:0" />
        <input
          class="modern-input"
          placeholder="Search templates…"
          value={search}
          onInput={(e: any) => setSearch(e.target.value)}
        />
      </div>

      {loading ? (
        <div class="dim" style="padding:60px 0;text-align:center">Loading templates…</div>
      ) : filtered.length === 0 ? (
        <div class="panel" style="text-align:center;padding:44px 18px">
          {isAdmin ? (
            <>
              <Boxes width={30} height={30} class="icon" style="margin:0 auto 10px;opacity:0.7" />
              <div class="hero-title" style="font-size:1rem">No templates yet</div>
              <p class="settings-hint" style="max-width:420px;margin:8px auto 0">
                Save a stack once — its image, ports and env — then bootstrap any new project from it.
              </p>
            </>
          ) : (
            <>
              <Layers width={30} height={30} class="icon" style="margin:0 auto 10px;opacity:0.7" />
              <p class="settings-hint" style="max-width:420px;margin:8px auto 0">
                No templates available right now.
              </p>
            </>
          )}
        </div>
      ) : (
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px">
          {filtered.map((t) => (
            <article class="project-card" key={t.id} style="cursor:default">
              <div class="project-card-header">
                <h3 style="display:flex;align-items:center;gap:8px;min-width:0">
                  <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{t.name}</span>
                  {t.defaultName && (
                    <span class="status-badge" title={`Suggested project name: ${t.defaultName}`}>
                      {t.defaultName}
                    </span>
                  )}
                </h3>
                {isAdmin && (
                  <div style="display:flex;gap:6px;flex-shrink:0">
                    <button class="btn-ghost sm" title="Edit template" onClick={() => openEdit(t)}>
                      <Pencil width={14} height={14} />
                    </button>
                    <button
                      class="btn-ghost sm"
                      title="Delete template"
                      onClick={() => setConfirmDel(t)}
                    >
                      <Trash2 width={14} height={14} class="icon danger" />
                    </button>
                  </div>
                )}
              </div>
              {t.description && <p class="project-desc">{t.description}</p>}
              <div class="project-meta">
                <span class="meta-chip" title="Container image">{t.image || DEFAULT_IMAGE}</span>
                {t.ports.length > 0 ? (
                  t.ports.map((p) => (
                    <span class="meta-chip port" key={p}>:{p}</span>
                  ))
                ) : (
                  <span class="meta-chip">no ports</span>
                )}
                {Object.keys(t.env).length > 0 && (
                  <span class="meta-chip">{Object.keys(t.env).join(', ')}</span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {editor && (
        <div
          class="modal-overlay"
          onClick={(e: any) => { if (e.target === e.currentTarget && !saving) setEditor(null); }}
        >
          <form class="create-card modal-dialog" style="max-width:520px;width:100%" onSubmit={handleSave}>
            <div class="create-title">
              {editor.template ? `Edit "${editor.template.name}"` : 'New Template'}
            </div>
            <input
              class="modern-input"
              placeholder="Template name (required)"
              value={editor.name}
              onInput={(e: any) => setEditor({ ...editor, name: e.target.value })}
              autoFocus
            />
            <input
              class="modern-input"
              style="margin-top:10px"
              placeholder="Description (optional)"
              value={editor.description}
              onInput={(e: any) => setEditor({ ...editor, description: e.target.value })}
            />
            <input
              class="modern-input"
              style="margin-top:10px"
              placeholder="Suggested project name (optional)"
              value={editor.defaultName}
              onInput={(e: any) => setEditor({ ...editor, defaultName: e.target.value })}
            />
            <input
              class="modern-input"
              style="margin-top:10px"
              placeholder={`Image (optional, default ${DEFAULT_IMAGE})`}
              value={editor.image}
              onInput={(e: any) => setEditor({ ...editor, image: e.target.value })}
            />
            <input
              class="modern-input"
              style="margin-top:10px"
              placeholder="Ports (comma separated, optional)"
              value={editor.portsText}
              onInput={(e: any) => setEditor({ ...editor, portsText: e.target.value })}
            />
            <textarea
              class="modern-input"
              style="margin-top:10px;min-height:96px;resize:vertical;font-family:var(--mono);font-size:0.78rem"
              placeholder={'Environment variables\nKEY=VALUE per line (optional)'}
              value={editor.envText}
              onInput={(e: any) => setEditor({ ...editor, envText: e.target.value })}
            />
            {saveError && <div class="login-error" style="margin-top:10px">{saveError}</div>}
            <div style="display:flex;gap:10px;margin-top:14px;justify-content:flex-end">
              <button type="button" class="btn-ghost sm" onClick={() => setEditor(null)} disabled={saving}>
                Cancel
              </button>
              <button type="submit" class="btn-primary sm" disabled={saving || !editor.name.trim()}>
                {saving ? 'Saving…' : editor.template ? 'Save changes' : 'Create template'}
              </button>
            </div>
          </form>
        </div>
      )}

      <ConfirmModal
        open={!!confirmDel}
        title={`Delete template "${confirmDel?.name}"?`}
        message="Projects already created from it are unaffected."
        danger
        loading={deleting}
        confirmLabel="Delete template"
        onCancel={() => setConfirmDel(null)}
        onConfirm={handleDelete}
      />
    </div>
  );
}