import { useState, useEffect } from 'preact/hooks';
import { useHashLocation } from 'wouter/use-hash-location';
import {
  authProviders,
  logoutProviders,
  getProviders,
  updateProvider,
  testProvider,
  getProvidersToken,
  setProvidersToken,
  type ProviderInfo,
} from '../api';

export function Providers() {
  const [, setLocation] = useHashLocation();
  const [authed, setAuthed] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);

  // password popup state
  const [password, setPassword] = useState('');
  const [checking, setChecking] = useState(false);
  const [passError, setPassError] = useState<string | null>(null);

  useEffect(() => {
    if (!getProvidersToken()) return;
    getProviders()
      .then(({ providers: list }) => {
        setProviders(list);
        setAuthed(true);
      })
      .catch(() => {
        setProvidersToken(null);
      });
  }, []);

  const login = async (e: Event) => {
    e.preventDefault();
    if (!password || checking) return;
    setChecking(true);
    setPassError(null);
    try {
      const { token } = await authProviders(password);
      setProvidersToken(token);
      const { providers: list } = await getProviders();
      setProviders(list);
      setAuthed(true);
      setPassword('');
    } catch (err: any) {
      setPassError(err.message || 'Invalid password');
    } finally {
      setChecking(false);
    }
  };

  const doLogout = async () => {
    try {
      await logoutProviders();
    } catch {
      /* token may already be invalid */
    }
    setProvidersToken(null);
    setAuthed(false);
    setProviders([]);
  };

  if (!authed) {
    return (
      <div class="modal-overlay">
        <form class="modal-card" onSubmit={login}>
          <div class="modal-title">Providers 🔑</div>
          <div class="modal-sub">This page manages provider API keys. Enter the password to continue.</div>
          <input
            class="modern-input"
            type="password"
            placeholder="Password"
            autoFocus
            value={password}
            onInput={(e: any) => setPassword(e.target.value)}
          />
          <div class="login-error">{passError}</div>
          <div style="display: flex; gap: 8px; margin-top: 14px; justify-content: flex-end">
            <button class="btn-ghost sm" type="button" onClick={() => setLocation('/')}>
              Cancel
            </button>
            <button class="btn-primary sm" type="submit" disabled={checking || !password}>
              {checking ? 'Checking…' : 'Unlock'}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div class="view">
      <div class="hero">
        <span class="hero-badge">Providers · 🔑</span>
        <h1 class="hero-title" style="font-size: 1.5rem">Providers</h1>
        <p class="hero-sub">
          Manage the hosts and API keys used by the chat. Saved values are stored on the server
          and take effect immediately — no restart needed.
        </p>
      </div>

      <div style="display: flex; justify-content: flex-end; margin-bottom: 14px">
        <button class="btn-ghost sm" onClick={doLogout}>Logout</button>
      </div>

      <div class="providers-grid">
        {providers.map((p) => (
          <ProviderCard key={p.id} provider={p} />
        ))}
      </div>
    </div>
  );
}

function ProviderCard({ provider }: { provider: ProviderInfo }) {
  const [host, setHost] = useState(provider.host);
  const [key, setKey] = useState('');
  const [enabled, setEnabled] = useState(provider.enabled);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateProvider(provider.id, {
        host,
        ...(key.trim() ? { apiKey: key.trim() } : {}),
        enabled,
      });
      setSaved(true);
      setKey('');
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
          ? `✓ Connected (${r.modelCount ?? 0} models)`
          : `✗ Failed${r.status ? ` (HTTP ${r.status})` : ''}${r.error ? `: ${r.error}` : ''}`
      );
    } catch (err: any) {
      setTestResult(`✗ ${err.message}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div class="panel provider-card">
      <div class="provider-head">
        <div class="provider-title">
          <div class="provider-name">{provider.name}</div>
          <div class="provider-id mono">{provider.id}</div>
        </div>
        <label class="provider-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e: any) => setEnabled(e.target.checked)}
          />
          <span>{enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      </div>

      <label class="field-label">Host / Base URL</label>
      <input class="modern-input" dir="auto" value={host} onInput={(e: any) => setHost(e.target.value)} />

      {provider.requiresKey && (
        <>
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
              placeholder="API key"
              value={key}
              onInput={(e: any) => setKey(e.target.value)}
            />
          )}
        </>
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
      </div>

      {testResult && (
        <div class="terminal-line t-ok" style="margin-top: 8px">{testResult}</div>
      )}
    </div>
  );
}
