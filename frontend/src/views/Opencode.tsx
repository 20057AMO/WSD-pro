import { useState, useEffect } from 'preact/hooks';
import { ArrowLeft, SquareTerminal } from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import { getOpencodeStatus } from '../api';

export function Opencode() {
  const [, setLocation] = useHashLocation();
  const [running, setRunning] = useState<boolean | null>(null);
  const [port, setPort] = useState(4096);

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

  return (
    <div class="opencode-page">
      <div class="opencode-toolbar">
        <button class="btn-ghost sm" onClick={() => setLocation('/')}><ArrowLeft width={13} height={13} class="icon" /> Dashboard</button>
        <span class="term-title" style="flex: 1; text-align: right; font-size: 0.7rem">
          {running === false ? 'opencode: offline' : running ? 'opencode: running' : 'opencode: …'}
        </span>
      </div>
      {running === false ? (
        <div class="empty-state" style="margin: 60px auto; max-width: 480px">
          <div class="big-icon"><SquareTerminal width={30} height={30} class="icon" /></div>
          opencode is not available right now. Check the container log:
          <code class="mono" style="display:block;margin-top:8px">docker compose logs app</code>
        </div>
      ) : (
        <iframe
          class="opencode-frame"
          src={url}
          title="Madar opencode"
          allow="clipboard-read; clipboard-write"
        />
      )}
    </div>
  );
}
