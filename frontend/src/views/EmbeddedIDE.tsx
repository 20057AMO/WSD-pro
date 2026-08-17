import { useState, useEffect } from 'preact/hooks';
import { useHashLocation } from 'wouter/use-hash-location';
import { getIdeStatus } from '../api';

export function EmbeddedIDE() {
  const [, setLocation] = useHashLocation();
  const [running, setRunning] = useState<boolean | null>(null);
  const [port, setPort] = useState(8100);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getIdeStatus()
        .then((s) => {
          if (cancelled) return;
          setRunning(s.ide.running);
          setPort(s.ide.port);
          setPassword(s.ide.password);
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

  const hash = window.location.hash || '';
  const qIdx = hash.indexOf('?');
  const params = new URLSearchParams(qIdx >= 0 ? hash.slice(qIdx) : '');
  const folder = params.get('folder') || '/workspaces';

  const host = window.location.hostname;
  const ideUrl = `http://${host}:${port}/?folder=${encodeURIComponent(folder)}`;

  return (
    <div class="opencode-page">
      <div class="opencode-toolbar">
        <button class="btn-ghost sm" onClick={() => setLocation('/')}>← Dashboard</button>
        <a class="btn-ghost sm" href={ideUrl} target="_blank" rel="noreferrer">Open in new tab</a>
        <span style="flex: 1" />
        <span class="mono" style="font-size: 0.7rem; color: var(--text-3)">
          {folder !== '/workspaces' ? folder.replace('/workspaces/', '') : 'All Projects'}
        </span>
        <span style="font-size: 0.68rem; color: var(--text-3); margin-left: 12px">
          Password: <span class="mono" style="color: var(--text-2)">{password || '...'}</span>
        </span>
      </div>
      {loading ? (
        <div class="empty-state" style="margin: 60px auto; max-width: 480px">
          <div class="big">▦</div>
          Loading IDE status...
        </div>
      ) : running === false ? (
        <div class="empty-state" style="margin: 60px auto; max-width: 480px">
          <div class="big">▦</div>
          Web IDE is not running. Start a project first.
          <code class="mono" style="display:block;margin-top:8px">docker compose logs app</code>
        </div>
      ) : (
        <iframe
          class="opencode-frame"
          src={ideUrl}
          title="WSD-Pro Web IDE"
          allow="clipboard-read; clipboard-write"
        />
      )}
    </div>
  );
}
