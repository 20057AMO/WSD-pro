import { useState, useEffect, useRef } from 'preact/hooks';
import {
  getProviders,
  getProviderTemplates,
  detectProvider,
  createProvider,
  updateProvider,
  testProvider,
  deleteProvider,
  getProvidersLockStatus,
  unlockProviders,
  getProvidersUnlock,
  setProvidersUnlock,
  clearProvidersUnlock,
  type ProviderInfo,
  type ProviderType,
  type KnownTemplate,
} from '../api';

const TYPE_LABEL: Record<ProviderType, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI-compatible',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
};

export function Providers() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Lock state: null = still checking
  const [locked, setLocked] = useState<boolean | null>(null);
  const [lockConfigured, setLockConfigured] = useState(false);
  const [unlockPw, setUnlockPw] = useState('');
  const [unlockLoading, setUnlockLoading] = useState(false);
  const [unlockErr, setUnlockErr] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  const refresh = async () => {
    try {
      const { providers: list } = await getProviders();
      setProviders(list);
      setError(null);
    } catch (err: any) {
      if (err?.code === 'providers_locked') setLocked(true);
      else setError(err.message || 'Failed to load providers');
    }
  };

  useEffect(() => {
    getProvidersLockStatus()
      .then((r) => setLockConfigured(r.enabled))
      .catch(() => setLockConfigured(false));
    if (getProvidersUnlock()) {
      setLocked(false);
      refresh();
    } else {
      getProvidersLockStatus()
        .then((r) => {
          if (!r.enabled) refresh();
          else setLocked(true);
        })
        .catch(() => refresh());
    }
  }, []);

  // Countdown ticker while unlocked — re-render every 30s so the badge stays honest.
  useEffect(() => {
    if (locked !== false) return;
    const t = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [locked]);

  // Auto-lock the view when the stored unlock expires.
  useEffect(() => {
    if (locked !== false) return;
    const t = setInterval(() => {
      if (!getProvidersUnlock()) {
        setLocked(true);
        setProviders([]);
      }
    }, 15_000);
    return () => clearInterval(t);
  }, [locked]);

  const doUnlock = async (e: Event) => {
    e.preventDefault();
    if (unlockLoading || !unlockPw) return;
    setUnlockLoading(true);
    setUnlockErr(null);
    try {
      const res = await unlockProviders(unlockPw);
      if (!res.unlockToken) throw new Error('Incorrect providers password.');
      setProvidersUnlock(res.unlockToken, res.expiresInSec || 1800);
      setUnlockPw('');
      setLocked(false);
      await refresh();
    } catch (err: any) {
      setUnlockErr(err.message || 'Unlock failed');
    } finally {
      setUnlockLoading(false);
    }
  };

  const lockNow = () => {
    clearProvidersUnlock();
    setProviders([]);
    setLocked(true);
  };

  // ── Locked gate ──
  if (locked === true) {
    return (
      <div class="view">
        <div class="hero">
          <span class="hero-badge">Providers · 🔒</span>
          <h1 class="hero-title" style="font-size: 1.5rem">Providers</h1>
          <p class="hero-sub">This page is protected by an additional password.</p>
        </div>
        <form class="panel settings-section providers-unlock-card" onSubmit={doUnlock}>
          <div class="panel-title">🔒 Unlock Providers</div>
          <p class="settings-hint">
            Enter the Providers password you configured in Settings → Providers Security.
            The page stays open for 30 minutes.
          </p>
          <input
            class="modern-input"
            type="password"
            placeholder="Providers password"
            autoFocus
            value={unlockPw}
            onInput={(e: any) => setUnlockPw(e.target.value)}
          />
          {unlockErr && <div class="login-error">{unlockErr}</div>}
          <button class="btn-primary sm" type="submit" disabled={unlockLoading || !unlockPw}>
            {unlockLoading ? 'Checking…' : 'Unlock'}
          </button>
          <p class="settings-hint" style="margin-top: 10px;">
            Forgot it? Reset it from <a href="#/settings" style="color: var(--accent)">Settings → Providers Security</a> using your account password.
          </p>
        </form>
      </div>
    );
  }

  if (locked === null) {
    return (
      <div class="view">
        <div class="dim" style="padding: 24px; font-size: 0.85rem;">Loading…</div>
      </div>
    );
  }

  const unlockLeft = getProvidersUnlock();
  const minutesLeft = unlockLeft ? Math.max(0, Math.ceil((unlockLeft.expiresAt - Date.now()) / 60_000)) : 0;

  return (
    <div class="view">
      <div class="hero">
        <span class="hero-badge">Providers · 🔑</span>
        <h1 class="hero-title" style="font-size: 1.5rem">Providers</h1>
        <p class="hero-sub">
          Manage any chat provider (Ollama, OpenRouter, OpenAI, Google AI Studio, Anthropic,
          Groq, DeepSeek…). Paste an API key — the provider, host and name are detected
          automatically in the background. Changes take effect immediately — no restart needed.
        </p>
      </div>

      <div style="display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 14px; align-items: center;">
        {minutesLeft > 0 && (
          <span class="badge-ok unlock-countdown" title="Time remaining before this page locks again">
            🔓 unlocked · {minutesLeft} min left
          </span>
        )}
        {lockConfigured && (
          <button class="btn-ghost sm" onClick={lockNow}>Lock now</button>
        )}
        <button class="btn-primary sm" onClick={() => setAdding(true)}>+ Add provider</button>
      </div>

      {error && <div class="chat-save-msg" style="margin-bottom: 12px">{error}</div>}

      <div class="providers-grid">
        {providers.map((p) => (
          <ProviderCard key={p.id} provider={p} onChanged={refresh} onDeleted={refresh} />
        ))}
      </div>

      {adding && <AddProviderModal onClose={() => setAdding(false)} onAdded={async () => { await refresh(); setAdding(false); }} />}
    </div>
  );
}

function ProviderCard({
  provider,
  onChanged,
  onDeleted,
}: {
  provider: ProviderInfo;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(provider.name);
  const [host, setHost] = useState(provider.host);
  const [key, setKey] = useState('');
  const [enabled, setEnabled] = useState(provider.enabled);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateProvider(provider.id, {
        name,
        host,
        ...(key.trim() ? { apiKey: key.trim() } : {}),
        enabled,
      });
      setSaved(true);
      setKey('');
      onChanged();
      setTimeout(() => setSaved(false), 2500);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await testProvider(provider.id);
      setTestResult(
        r.ok
          ? `✓ Connected (${r.modelCount ?? 0} models) • key verified`
          : `✗ Failed${r.status ? ` (HTTP ${r.status})` : ''}${r.error ? ` — ${r.error}` : ''}`
      );
    } catch (err: any) {
      setTestResult(`✗ ${err.message}`);
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete provider "${provider.name}"?`)) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteProvider(provider.id);
      onDeleted();
    } catch (err: any) {
      setError(err.message);
      setDeleting(false);
    }
  };

  return (
    <div class="panel provider-card">
      <div class="provider-head">
        <div class="provider-title">
          <div class="provider-name">{provider.name}</div>
          <div class="provider-id mono">{provider.id}</div>
        </div>
        <div style="display: flex; align-items: center; gap: 10px">
          <span class="provider-type">{TYPE_LABEL[provider.type]}</span>
          <label class="provider-toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e: any) => setEnabled(e.target.checked)}
            />
            <span>{enabled ? 'Enabled' : 'Disabled'}</span>
          </label>
        </div>
      </div>

      <label class="field-label">Name</label>
      <input class="modern-input" dir="auto" value={name} onInput={(e: any) => setName(e.target.value)} />

      <label class="field-label">Host / Base URL</label>
      <input class="modern-input" dir="auto" value={host} onInput={(e: any) => setHost(e.target.value)} />

      <label class="field-label">API key</label>
      {provider.apiKeyMasked ? (
        <div class="key-row">
          <span class="key-masked mono">{provider.apiKeyMasked}</span>
          <input
            class="modern-input key-replace"
            type="password"
            placeholder="Replace key…"
            value={key}
            onInput={(e: any) => setKey(e.target.value)}
          />
        </div>
      ) : (
        <input
          class="modern-input"
          type="password"
          placeholder="API key (optional)"
          value={key}
          onInput={(e: any) => setKey(e.target.value)}
        />
      )}

      {error && <div class="login-error">{error}</div>}
      {saved && <div class="chat-save-msg">Saved ✓</div>}

      <div class="provider-actions">
        <button class="btn-ghost sm" onClick={test} disabled={testing}>
          {testing ? 'Testing…' : 'Test'}
        </button>
        <button class="btn-primary sm" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button class="btn-danger sm" onClick={remove} disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>

      {testResult && (
        <div class="terminal-line t-ok" style="margin-top: 8px">{testResult}</div>
      )}
    </div>
  );
}

type DetectState = 'idle' | 'probing' | 'ok' | 'fail';

function AddProviderModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [host, setHost] = useState('');
  const [type, setType] = useState<ProviderType>('openai');
  const [enabled, setEnabled] = useState(true);
  const [templates, setTemplates] = useState<KnownTemplate[]>([]);
  const [detectState, setDetectState] = useState<DetectState>('idle');
  const [detectPhase, setDetectPhase] = useState<'probe' | 'verify'>('probe');
  const [detectMsg, setDetectMsg] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const seqRef = useRef(0);
  const nameAutoRef = useRef(false);
  const keyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    getProviderTemplates()
      .then(({ templates: list }) => setTemplates(list))
      .catch(() => {});
    return () => {
      if (keyTimerRef.current) window.clearTimeout(keyTimerRef.current);
      seqRef.current += 1;
    };
  }, []);

  // Background auto-detect: fires ~600ms after the key settles (debounce).
  useEffect(() => {
    const key = apiKey.trim();
    if (keyTimerRef.current) window.clearTimeout(keyTimerRef.current);
    if (key.length < 6) {
      setDetectState('idle');
      setDetectMsg(null);
      setDetectPhase('probe');
      return;
    }
    const seq = ++seqRef.current;
    keyTimerRef.current = window.setTimeout(() => {
      setDetectState('probing');
      setDetectPhase('probe');
      setDetectMsg(null);
      setShowAdvanced(false);
      window.setTimeout(() => {
        if (seqRef.current === seq) setDetectPhase('verify');
      }, 1000);
      detectProvider({ apiKey: key })
        .then((r) => {
          if (seqRef.current !== seq) return;
          if (r.provider) {
            setHost(r.provider.host);
            setType(r.provider.type);
            if (!name.trim() || nameAutoRef.current) {
              setName(r.provider.name);
              nameAutoRef.current = true;
            }
            setDetectState('ok');
            setDetectMsg(`✓ Detected: ${r.provider.name} (${r.provider.modelCount} models)`);
          } else {
            setDetectState('fail');
            setDetectMsg('✗ Not detected from this key.');
            setShowAdvanced(true);
          }
        })
        .catch((err: any) => {
          if (seqRef.current !== seq) return;
          setDetectState('fail');
          setDetectMsg(`✗ ${err.message}`);
          setShowAdvanced(true);
        });
    }, 600);
    return () => {
      if (keyTimerRef.current) window.clearTimeout(keyTimerRef.current);
    };
  }, [apiKey, retryNonce]);

  const retryDetect = () => {
    setDetectState('probing');
    setDetectPhase('probe');
    setDetectMsg(null);
    setShowAdvanced(false);
    setRetryNonce((n) => n + 1);
  };

  const applyTemplate = (tname: string) => {
    const t = templates.find((x) => x.name === tname);
    if (!t) return;
    setHost(t.host);
    setType(t.type);
    if (!name.trim() || nameAutoRef.current) {
      setName(t.name);
      nameAutoRef.current = true;
    }
    setDetectState('ok');
    setDetectMsg(`✓ ${t.name}`);
    setShowAdvanced(true);
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    const key = apiKey.trim();
    const h = host.trim();
    if (!name.trim() || saving) return;
    if (!h && !key) {
      setError('Paste an API key to auto-detect, or open Advanced to set the host.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createProvider({
        name: name.trim(),
        ...(h ? { host: h, type } : {}),
        ...(key ? { apiKey: key } : {}),
        enabled,
      });
      onAdded();
    } catch (err: any) {
      if (err.code === 'detection_required') {
        setShowAdvanced(true);
        setDetectState('fail');
        setDetectMsg('✗ Could not auto-detect — pick a template above or enter the host manually.');
      }
      setError(err.message || 'Failed to add provider');
      setSaving(false);
    }
  };

  const statusLabel = () => {
    if (detectState === 'probing') {
      return detectPhase === 'verify'
        ? '⏳ Probing OK — Verifying key…'
        : '⏳ Probing known providers…';
    }
    return null;
  };

  return (
    <div class="modal-overlay">
      <form class="modal-card" onSubmit={submit}>
        <div class="modal-title">Add provider</div>
        <div class="modal-sub">
          Paste your API key — everything else is detected automatically.
        </div>

        <label class="field-label">API key</label>
        <input
          class="modern-input"
          type="password"
          placeholder="sk-… / AIza… / gsk_… / ollama_…"
          autoFocus
          value={apiKey}
          onInput={(e: any) => setApiKey(e.target.value)}
        />

        <div class="detect-row">
          {statusLabel() && <div class="detect-status">{statusLabel()}</div>}
          {detectMsg && <div class={`detect-status ${detectState === 'ok' ? 'detect-ok' : detectState === 'fail' ? 'detect-fail' : ''}`}>{detectMsg}</div>}
          {detectState === 'fail' && (
            <div class="detect-quick-picks">
              <span class="detect-quick-label">Quick pick:</span>
              {templates.filter((t) => !t.host.includes('host.docker.internal')).map((t) => (
                <button key={t.name} class="btn-ghost sm" type="button" onClick={() => applyTemplate(t.name)}>
                  {t.name}
                </button>
              ))}
            </div>
          )}
          {detectState === 'fail' && (
            <button class="btn-ghost sm" type="button" onClick={retryDetect}>
              ↻ Retry
            </button>
          )}
        </div>

        <label class="field-label">Name</label>
        <input
          class="modern-input"
          dir="auto"
          placeholder="My Provider"
          value={name}
          onInput={(e: any) => { setName(e.target.value); nameAutoRef.current = false; }}
        />

        <details
          class="advanced-box"
          open={showAdvanced}
          onToggle={(e: any) => setShowAdvanced(e.target.open)}
        >
          <summary>Advanced (host / type)</summary>
          <label class="field-label">Template</label>
          <select class="modern-input" value="" onChange={(e: any) => applyTemplate(e.target.value)}>
            <option value="" disabled>Choose a known provider…</option>
            {templates.map((t) => (
              <option key={t.name} value={t.name}>{t.name}</option>
            ))}
          </select>

          <label class="field-label">Host / Base URL</label>
          <input
            class="modern-input"
            dir="auto"
            placeholder="https://api.example.com/v1"
            value={host}
            onInput={(e: any) => setHost(e.target.value)}
          />

          <div class="add-provider-row">
            <label class="chat-settings-label">
              <span>Type</span>
              <select class="modern-input chat-sel" value={type} onChange={(e: any) => setType(e.target.value as ProviderType)}>
                <option value="openai">OpenAI-compatible</option>
                <option value="ollama">Ollama</option>
                <option value="anthropic">Anthropic</option>
                <option value="gemini">Gemini (native)</option>
              </select>
            </label>
            <label class="provider-toggle" style="align-self: flex-end">
              <input type="checkbox" checked={enabled} onChange={(e: any) => setEnabled(e.target.checked)} />
              <span>Enabled</span>
            </label>
          </div>
        </details>

        {error && <div class="login-error">{error}</div>}

        <div style="display: flex; gap: 8px; margin-top: 14px; justify-content: flex-end">
          <button class="btn-ghost sm" type="button" onClick={onClose}>Cancel</button>
          <button class="btn-primary sm" type="submit" disabled={saving || !name.trim()}>
            {saving ? 'Adding…' : 'Add provider'}
          </button>
        </div>
      </form>
    </div>
  );
}
