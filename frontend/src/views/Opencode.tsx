import { useState, useEffect, useRef } from 'preact/hooks';
import { ArrowLeft, SquareTerminal, FolderOpen, RefreshCw } from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import { getOpencodeStatus, openOpencodeProject, listProjects, requestIdeSession, type Project } from '../api';
import { useDocumentVisible } from '../lib/visibility';

const PROJECT_KEY = 'wsd.opencode.project';
const BASE_INTERVAL = 5000;
const HIDDEN_INTERVAL = 30000;
const MAX_BACKOFF = 30000;

export function Opencode() {
  const [loc, setLocation] = useHashLocation();
  const [running, setRunning] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [picked, setPicked] = useState('');
  const pickedRef = useRef('');
  const [opening, setOpening] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [frameReady, setFrameReady] = useState(false);
  const [openErr, setOpenErr] = useState<string | null>(null);
  // The iframe only starts once we KNOW the wsd.ide cookie is set — otherwise
  // it races the async mint and lands on the proxy's 401 page with no retry.
  const [sessionReady, setSessionReady] = useState(false);

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
      getOpencodeStatus()
        .then((s) => {
          if (cancelled) return;
          setRunning(s.running);
          retryCountRef.current = 0; // reset backoff on success
          scheduleNext();
        })
        .catch(() => {
          if (!cancelled) setRunning(false);
          retryCountRef.current = Math.min(retryCountRef.current + 1, 4);
          scheduleNext();
        });

    const scheduleNext = () => {
      if (timer) clearInterval(timer);
      if (cancelled) return;
      if (!visible) {
        // When hidden, poll at 30s regardless of backoff
        timer = setInterval(load, HIDDEN_INTERVAL);
      } else {
        // Exponential backoff: 5s, 10s, 20s, 30s cap
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

  const url = '/oc/';

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
      ) : !sessionReady ? (
        <div class="ide-loading">
          <RefreshCw width={16} height={16} class="icon spin" />
          Loading opencode…
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
