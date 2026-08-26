import { useState, useEffect, useRef } from 'preact/hooks';
import { ArrowLeft, SquareTerminal, FolderOpen, RefreshCw } from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import { getOpencodeStatus, openOpencodeProject, listProjects, type Project } from '../api';

const PROJECT_KEY = 'wsd.opencode.project';

export function Opencode() {
  const [loc, setLocation] = useHashLocation();
  const [running, setRunning] = useState<boolean | null>(null);
  const [port, setPort] = useState(4096);
  const [projects, setProjects] = useState<Project[]>([]);
  const [picked, setPicked] = useState('');
  const pickedRef = useRef('');
  const [opening, setOpening] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [frameReady, setFrameReady] = useState(false);
  const [openErr, setOpenErr] = useState<string | null>(null);

  // Warm the connection to the opencode web server before the iframe mounts
  // (saves DNS + TCP round-trips on first paint).
  useEffect(() => {
    try {
      const l = document.createElement('link');
      l.rel = 'preconnect';
      l.href = `${window.location.protocol}//${window.location.hostname}:4096`;
      document.head.appendChild(l);
      return () => {
        l.remove();
      };
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getOpencodeStatus()
        .then((s) => {
          if (cancelled) return;
          setRunning(s.running);
          setPort(s.port);
        })
        .catch(() => {
          if (!cancelled) setRunning(false);
        });
    load();
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const host = window.location.hostname;
  const proto = window.location.protocol === 'https:' ? 'https' : 'http';
  const url = `${proto}://${host}:${port}`;

  useEffect(() => {
    let cancelled = false;
    listProjects()
      .then((r) => {
        if (cancelled) return;
        setProjects(r.projects || []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const openProject = async (slug: string) => {
    pickedRef.current = slug;
    setPicked(slug);
    setOpenErr(null);
    try {
      localStorage.setItem(PROJECT_KEY, slug);
    } catch {
      /* private mode */
    }
    if (!slug) {
      setFrameKey((k) => k + 1);
      return;
    }
    setOpening(true);
    try {
      await openOpencodeProject(slug);
      setFrameKey((k) => k + 1);
    } catch (err: any) {
      setOpenErr(err.message);
    } finally {
      setOpening(false);
    }
  };

  // Reactive deep-links (?project=slug) + last-project memory — both work
  // while this component stays mounted via the keep-alive layer.
  // NOTE: wouter's useHashLocation() strips the query string from `loc`,
  // so we read the full hash directly to get ?project=.
  useEffect(() => {
    if (!projects.length) return;
    let wanted = '';
    const hash = window.location.hash || '';
    const qIdx = hash.indexOf('?');
    if (qIdx >= 0) {
      wanted = new URLSearchParams(hash.slice(qIdx)).get('project') || '';
    } else {
      try {
        wanted = localStorage.getItem(PROJECT_KEY) || '';
      } catch {
        /* ignore */
      }
    }
    if (!wanted || wanted === pickedRef.current) return;
    if (projects.some((p) => p.slug === wanted)) openProject(wanted);
  }, [loc, projects]);

  // Reset the loading overlay whenever a new frame mounts.
  useEffect(() => {
    setFrameReady(false);
  }, [frameKey]);

  return (
    <div class="opencode-page">
      <div class="opencode-toolbar">
        <button class="btn-ghost sm" onClick={() => setLocation('/')}><ArrowLeft width={13} height={13} class="icon" /> Dashboard</button>
        <a class="btn-ghost sm" href={url} target="_blank" rel="noreferrer">
          Open in new tab
        </a>
        <span style="display:inline-flex;align-items:center;gap:6px;margin-left:12px" title="Opens (or reuses) an opencode session for the project">
          <FolderOpen width={13} height={13} class="icon" />
          <select
            class="modern-input chat-sel"
            style="width:200px;padding:4px 8px;font-size:0.72rem"
            value={picked}
            disabled={opening}
            onInput={(e: any) => openProject(e.target.value)}
          >
            <option value="">opencode home…</option>
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>{p.name}</option>
            ))}
          </select>
        </span>
        <span class="term-title" style="flex: 1; text-align: right; font-size: 0.7rem">
          {openErr ? openErr : running === false ? 'opencode: offline' : opening ? 'opening…' : running ? 'opencode: running' : 'opencode: …'}
        </span>
      </div>
      {running === false ? (
        <div class="empty-state" style="margin: 60px auto; max-width: 480px">
          <div class="big-icon"><SquareTerminal width={30} height={30} class="icon" /></div>
          opencode is not available right now. Check the container log:
          <code class="mono" style="display:block;margin-top:8px">docker compose logs app</code>
        </div>
      ) : (
        <>
          <iframe
            key={frameKey}
            class="opencode-frame"
            src={url}
            title="Madar opencode"
            allow="clipboard-read; clipboard-write"
            onLoad={() => setFrameReady(true)}
          />
          {!frameReady && (
            <div class="ide-loading">
              <RefreshCw width={16} height={16} class="icon spin" />
              Loading opencode…
            </div>
          )}
        </>
      )}
    </div>
  );
}
