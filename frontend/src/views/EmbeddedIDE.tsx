import { useState, useEffect, useRef } from 'preact/hooks';
import { ArrowLeft, FolderOpen, RefreshCw } from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import { getIdeStatus, listProjects, requestIdeSession, type Project } from '../api';
import { VSCodeIcon } from '../components/brand-icons';
import { useDocumentVisible } from '../lib/visibility';

const FOLDER_KEY = 'wsd.ide.folder';
const BASE_INTERVAL = 8000;
const HIDDEN_INTERVAL = 30000;
const MAX_BACKOFF = 32000;

function readSavedFolder(): string {
  try {
    const f = localStorage.getItem(FOLDER_KEY);
    return f && f.startsWith('/workspaces') ? f : '/workspaces';
  } catch {
    return '/workspaces';
  }
}

export function EmbeddedIDE() {
  const [loc, setLocation] = useHashLocation();
  const [running, setRunning] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [folder, setFolder] = useState(readSavedFolder);
  const folderRef = useRef(folder);
  const [frameKey, setFrameKey] = useState(0);
  const [frameReady, setFrameReady] = useState(false);
  // The iframe only starts once we KNOW the wsd.ide cookie is set — otherwise
  // it races the async mint and lands on the proxy's 401 page with no retry.
  const [sessionReady, setSessionReady] = useState(false);

  // Apply a folder change: persist it and (optionally) reload the iframe.
  const applyFolder = (f: string, reload: boolean) => {
    folderRef.current = f;
    setFolder(f);
    try {
      localStorage.setItem(FOLDER_KEY, f);
    } catch {
      /* private mode */
    }
    if (reload) setFrameKey((k) => k + 1);
  };

  // Reactive deep-links: /ide?folder=/workspaces/<slug> preselects — including
  // while this component stays mounted via the keep-alive layer.
  // NOTE: wouter's useHashLocation() strips the query string from `loc`,
  // so we read the full hash directly to get ?folder=.
  useEffect(() => {
    const hash = window.location.hash || '';
    const qIdx = hash.indexOf('?');
    const f = qIdx >= 0 ? new URLSearchParams(hash.slice(qIdx)).get('folder') : null;
    if (f && f.startsWith('/workspaces/') && f !== folderRef.current) applyFolder(f, true);
  }, [loc]);

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

  const visible = useDocumentVisible();

  // Mint the proxy cookie on mount and keep it alive every 25 min (below the
  // 1-hour HttpOnly expiry). Also refresh when the tab becomes visible again.
  // The iframe is gated on the FIRST successful mint (sessionReady).
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const refresh = () => {
      requestIdeSession().then(() => setSessionReady(true)).catch(() => {});
    };
    refresh();
    timer = setInterval(refresh, 25 * 60 * 1000);
    return () => { if (timer) clearInterval(timer); };
  }, []);

  // Re-mint when the tab becomes visible after being hidden.
  useEffect(() => {
    if (visible) requestIdeSession().catch(() => {});
  }, [visible]);
  const retryCountRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = () =>
      getIdeStatus()
        .then((s) => {
          if (cancelled) return;
          setRunning(s.ide.running);
          setLoading(false);
          retryCountRef.current = 0;
          scheduleNext();
        })
        .catch(() => {
          if (!cancelled) {
            setRunning(false);
            setLoading(false);
          }
          retryCountRef.current = Math.min(retryCountRef.current + 1, 4);
          scheduleNext();
        });

    const scheduleNext = () => {
      if (timer) clearInterval(timer);
      if (cancelled) return;
      if (!visible) {
        timer = setInterval(load, HIDDEN_INTERVAL);
      } else {
        const delay = Math.min(BASE_INTERVAL * Math.pow(2, retryCountRef.current), MAX_BACKOFF);
        timer = setInterval(load, delay);
      }
    };

    load();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [visible]);

  // Reset the loading overlay whenever a new frame mounts.
  useEffect(() => {
    setFrameReady(false);
  }, [frameKey]);

  const ideUrl = `/ide/?folder=${encodeURIComponent(folder)}`;
  const pickedSlug = folder.replace('/workspaces/', '');

  const pickProject = (slug: string) => {
    applyFolder(slug ? `/workspaces/${slug}` : '/workspaces', true);
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
      ) : !sessionReady ? (
        <div class="ide-loading">
          <RefreshCw width={16} height={16} class="icon spin" />
          Loading VS Code…
        </div>
      ) : (
        <>
          <iframe
            key={frameKey}
            class="opencode-frame"
            src={ideUrl}
            title="Madar VS Code"
            allow="clipboard-read; clipboard-write"
            onLoad={() => setFrameReady(true)}
          />
          {!frameReady && (
            <div class="ide-loading">
              <RefreshCw width={16} height={16} class="icon spin" />
              Loading VS Code…
            </div>
          )}
        </>
      )}
    </div>
  );
}
