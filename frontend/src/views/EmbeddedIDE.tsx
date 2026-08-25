import { useState, useEffect } from 'preact/hooks';
import { ArrowLeft, FolderOpen } from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import { getIdeStatus, listProjects, type Project } from '../api';
import { VSCodeIcon } from '../components/brand-icons';

export function EmbeddedIDE() {
  const [, setLocation] = useHashLocation();
  const [running, setRunning] = useState<boolean | null>(null);
  const [port, setPort] = useState(8100);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [folder, setFolder] = useState('/workspaces');
  const [frameKey, setFrameKey] = useState(0);

  // Deep-link support: /ide?folder=/workspaces/<slug> still preselects.
  useEffect(() => {
    const hash = window.location.hash || '';
    const qIdx = hash.indexOf('?');
    const params = new URLSearchParams(qIdx >= 0 ? hash.slice(qIdx) : '');
    const f = params.get('folder');
    if (f && f.startsWith('/workspaces/')) setFolder(f);
  }, []);

  useEffect(() => {
    let cancelled = false;
    listProjects()
      .then((r) => {
        if (!cancelled) setProjects(r.projects || []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getIdeStatus()
        .then((s) => {
          if (cancelled) return;
          setRunning(s.ide.running);
          setPort(s.ide.port);
          setLoading(false);
        })
        .catch(() => {
          if (!cancelled) {
            setRunning(false);
            setLoading(false);
          }
        });
    load();
    const t = setInterval(load, 8000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const host = window.location.hostname;
  // Match the page protocol so the iframe is not blocked as mixed content
  // when the dashboard itself is served over HTTPS.
  const proto = window.location.protocol === 'https:' ? 'https' : 'http';
  const ideUrl = `${proto}://${host}:${port}/?folder=${encodeURIComponent(folder)}`;
  const pickedSlug = folder.replace('/workspaces/', '');

  const pickProject = (slug: string) => {
    setFolder(slug ? `/workspaces/${slug}` : '/workspaces');
    setFrameKey((k) => k + 1);
  };

  return (
    <div class="opencode-page">
      <div class="opencode-toolbar">
        <button class="btn-ghost sm" onClick={() => setLocation('/')}><ArrowLeft width={13} height={13} class="icon" /> Dashboard</button>
        <span style="display:inline-flex;align-items:center;gap:6px;margin-left:8px;font-weight:600;font-size:0.9rem">
          <VSCodeIcon width={15} height={15} /> VS Code
        </span>
        <a class="btn-ghost sm" href={ideUrl} target="_blank" rel="noreferrer">Open in new tab</a>
        <span style="display:inline-flex;align-items:center;gap:6px;margin-left:12px" title="Opens the project folder in the IDE">
          <FolderOpen width={13} height={13} class="icon" />
          <select
            class="modern-input chat-sel"
            style="width:200px;padding:4px 8px;font-size:0.72rem"
            value={pickedSlug}
            onInput={(e: any) => pickProject(e.target.value)}
          >
            <option value="">All Projects…</option>
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>{p.name}</option>
            ))}
          </select>
        </span>
        <span style="flex: 1" />
        <span style="font-size: 0.68rem; color: var(--text-3); margin-left: 12px">
          {running === false ? 'VS Code offline' : running ? 'VS Code running' : ''}
      </span>
      </div>
      {loading ? (
        <div class="empty-state" style="margin: 60px auto; max-width: 480px">
          <div class="big-icon"><VSCodeIcon width={30} height={30} /></div>
          Loading VS Code status...
        </div>
      ) : running === false ? (
        <div class="empty-state" style="margin: 60px auto; max-width: 480px">
          <div class="big-icon"><VSCodeIcon width={30} height={30} /></div>
          VS Code is not running. Start a project first.
          <code class="mono" style="display:block;margin-top:8px">docker compose logs app</code>
        </div>
      ) : (
        <iframe
          key={frameKey}
          class="opencode-frame"
          src={ideUrl}
          title="WSD-Pro VS Code"
          allow="clipboard-read; clipboard-write"
        />
      )}
    </div>
  );
}
