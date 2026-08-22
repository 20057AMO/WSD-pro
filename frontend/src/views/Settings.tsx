import { useState, useEffect } from 'preact/hooks';
import { useAuth } from '../auth';
import {
  getProvidersLockStatus,
  setProvidersPassword,
  removeProvidersPassword,
  exportSettings,
  importSettings,
  clearProvidersUnlock,
  getAuditLog,
  type AuditEntry,
  type BackupFile,
} from '../api';
import { PwMeter } from '../components/PwMeter';

const APP_VERSION = '2.0.0-beta';

const AUDIT_LABELS: Record<string, string> = {
  setup: 'Account created',
  login: 'Sign in',
  'login-failed': 'Sign in failed',
  'logout-all': 'Signed out everywhere',
  'logout-all-failed': 'Sign-out-everywhere attempt failed',
  'password-change': 'Password changed',
  'password-change-failed': 'Password change failed',
  'providers-lock-change': 'Providers lock updated',
  'providers-lock-change-failed': 'Providers lock update failed',
  'backup-export': 'Backup exported',
  'backup-import': 'Backup imported',
};

type Msg = { type: 'ok' | 'err'; text: string } | null;

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function Settings() {
  const { user, logout } = useAuth();

  // ── Change account password ──
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwLoading, setPwLoading] = useState(false);
  const [pwMsg, setPwMsg] = useState<Msg>(null);

  // ── Logout everywhere ──
  const [revokePw, setRevokePw] = useState('');
  const [revokeLoading, setRevokeLoading] = useState(false);
  const [revokeMsg, setRevokeMsg] = useState<Msg>(null);

  // ── Providers security lock ──
  const [lockEnabled, setLockEnabled] = useState<boolean | null>(null);
  const [lockAccountPw, setLockAccountPw] = useState('');
  const [lockNewPw, setLockNewPw] = useState('');
  const [lockConfirmPw, setLockConfirmPw] = useState('');
  const [lockLoading, setLockLoading] = useState(false);
  const [lockMsg, setLockMsg] = useState<Msg>(null);

  // ── Inactivity auto-logout ──
  type IdleChoice = 'off' | '30' | '60' | '120';
  const [idleChoice, setIdleChoice] = useState<IdleChoice>(() => {
    try {
      return (localStorage.getItem('wsd.idleTimeout') as IdleChoice) || 'off';
    } catch {
      return 'off';
    }
  });

  // ── Backup ──
  const [backupAccountPw, setBackupAccountPw] = useState('');
  const [backupLoading, setBackupLoading] = useState<'export' | 'import' | null>(null);
  const [backupMsg, setBackupMsg] = useState<Msg>(null);

  // ── Security activity ──
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);

  useEffect(() => {
    getProvidersLockStatus()
      .then((r) => setLockEnabled(r.enabled))
      .catch(() => setLockEnabled(false));
    getAuditLog()
      .then((r) => setAudit(r.entries || []))
      .catch(() => setAudit([]));
  }, []);

  const changePassword = async (e: Event) => {
    e.preventDefault();
    if (pwLoading) return;

    if (!currentPw || !newPw) {
      setPwMsg({ type: 'err', text: 'Please fill in all fields.' });
      return;
    }
    if (newPw !== confirmPw) {
      setPwMsg({ type: 'err', text: 'New passwords do not match.' });
      return;
    }
    if (newPw.length < 6) {
      setPwMsg({ type: 'err', text: 'New password must be at least 6 characters.' });
      return;
    }

    setPwLoading(true);
    setPwMsg(null);

    try {
      const token = localStorage.getItem('wsd.token');
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      // Password change revokes all other sessions; server issued a fresh
      // token so this one stays signed in.
      if (data.token) localStorage.setItem('wsd.token', data.token);
      setPwMsg({ type: 'ok', text: 'Password changed. Other devices were signed out.' });
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
    } catch (err: any) {
      setPwMsg({ type: 'err', text: err.message || 'Failed' });
    } finally {
      setPwLoading(false);
    }
  };

  const saveLock = async (e: Event) => {
    e.preventDefault();
    if (lockLoading) return;
    if (!lockAccountPw || !lockNewPw) {
      setLockMsg({ type: 'err', text: 'Fill in your account password and the new providers password.' });
      return;
    }
    if (lockNewPw !== lockConfirmPw) {
      setLockMsg({ type: 'err', text: 'New providers passwords do not match.' });
      return;
    }
    if (lockNewPw.length < 6) {
      setLockMsg({ type: 'err', text: 'Providers password must be at least 6 characters.' });
      return;
    }
    setLockLoading(true);
    setLockMsg(null);
    try {
      await setProvidersPassword(lockAccountPw, lockNewPw);
      setLockEnabled(true);
      setLockMsg({
        type: 'ok',
        text: lockEnabled ? 'Providers password changed.' : 'Providers lock enabled.',
      });
      setLockAccountPw('');
      setLockNewPw('');
      setLockConfirmPw('');
      clearProvidersUnlock();
    } catch (err: any) {
      setLockMsg({ type: 'err', text: err.message || 'Failed' });
    } finally {
      setLockLoading(false);
    }
  };

  const disableLock = async () => {
    if (lockLoading) return;
    if (!lockAccountPw) {
      setLockMsg({ type: 'err', text: 'Enter your account password to disable the lock.' });
      return;
    }
    setLockLoading(true);
    setLockMsg(null);
    try {
      await removeProvidersPassword(lockAccountPw);
      setLockEnabled(false);
      setLockMsg({ type: 'ok', text: 'Providers lock disabled.' });
      setLockAccountPw('');
      clearProvidersUnlock();
    } catch (err: any) {
      setLockMsg({ type: 'err', text: err.message || 'Failed' });
    } finally {
      setLockLoading(false);
    }
  };

  const applyIdleChoice = (value: IdleChoice) => {
    setIdleChoice(value);
    try {
      localStorage.setItem('wsd.idleTimeout', value);
    } catch { /* ignore */ }
  };

  const doExport = async () => {
    if (backupLoading || !backupAccountPw) {
      if (!backupAccountPw) setBackupMsg({ type: 'err', text: 'Enter your account password to export.' });
      return;
    }
    setBackupLoading('export');
    setBackupMsg(null);
    try {
      const backup = await exportSettings(backupAccountPw);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wsd-pro-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setBackupMsg({ type: 'ok', text: 'Backup downloaded (API keys excluded by design).' });
      setBackupAccountPw('');
    } catch (err: any) {
      setBackupMsg({ type: 'err', text: err.message || 'Export failed' });
    } finally {
      setBackupLoading(null);
    }
  };

  const doImport = async (e: Event) => {
    e.preventDefault();
    if (backupLoading || !backupAccountPw) {
      if (!backupAccountPw) setBackupMsg({ type: 'err', text: 'Enter your account password to import.' });
      return;
    }
    const input = (document.getElementById('import-file') as HTMLInputElement) || null;
    const file = input?.files?.[0];
    if (!file) {
      setBackupMsg({ type: 'err', text: 'Choose a backup .json file first.' });
      return;
    }
    setBackupLoading('import');
    setBackupMsg(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (parsed?.kind !== 'wsd-pro-backup') throw new Error('Not a WSD-Pro backup file.');
      const result = await importSettings(backupAccountPw, parsed as BackupFile);
      const total = Object.values(result.imported || {}).reduce((s, n) => s + n, 0);
      setBackupMsg({
        type: 'ok',
        text: `Imported ${total} item(s), skipped ${result.skipped} existing. Re-add provider API keys manually.`,
      });
      setBackupAccountPw('');
      if (input) input.value = '';
    } catch (err: any) {
      setBackupMsg({ type: 'err', text: err.message || 'Import failed' });
    } finally {
      setBackupLoading(null);
    }
  };

  const revokeAll = async () => {
    if (revokeLoading) return;
    if (!revokePw) {
      setRevokeMsg({ type: 'err', text: 'Enter your account password to sign out everywhere.' });
      return;
    }
    setRevokeLoading(true);
    setRevokeMsg(null);
    try {
      const token = localStorage.getItem('wsd.token');
      const res = await fetch('/api/auth/logout-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ accountPassword: revokePw }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      // Every session (including this one) is now invalid → hard logout.
      logout();
      window.location.hash = '/login';
    } catch (err: any) {
      setRevokeMsg({ type: 'err', text: err.message || 'Failed' });
      setRevokeLoading(false);
    }
  };

  const handleLogout = () => {
    logout();
    window.location.hash = '/login';
  };

  return (
    <div class="view">
      <div class="hero">
        <span class="hero-badge">Settings</span>
        <h1 class="hero-title" style="font-size: 1.5rem">Settings</h1>
        <p class="hero-sub">Manage your account and application settings.</p>
      </div>

      {/* Account Info */}
      <div class="panel settings-section">
        <div class="panel-title">Account</div>
        <div class="settings-row">
          <span class="field-label">Username</span>
          <span class="mono" style="color: var(--text)">{user?.username || '—'}</span>
        </div>
        <div class="settings-row">
          <span class="field-label">Created</span>
          <span style="color: var(--text-2)">{fmtDate(user?.createdAt)}</span>
        </div>
        <div class="settings-row">
          <span class="field-label">Last password change</span>
          <span style="color: var(--text-2)">{fmtDate(user?.passwordChangedAt)}</span>
        </div>
        <div class="settings-row">
          <span class="field-label">Token</span>
          <span class="mono" style="color: var(--text-3); font-size: 0.7rem">
            {localStorage.getItem('wsd.token')?.slice(0, 20) || '—'}…
          </span>
        </div>
        <div style="margin-top: 12px">
          <button class="btn-danger sm" onClick={handleLogout}>Logout</button>
        </div>
      </div>

      {/* Logout everywhere */}
      <div class="panel settings-section">
        <div class="panel-title">Logout Everywhere</div>
        <p class="settings-hint">
          Invalidate every signed-in session — all browser tabs and devices will
          be required to log in again. You will be logged out here too.
        </p>
        <label class="field-label">Account password (verification)</label>
        <input
          class="modern-input"
          type="password"
          placeholder="Confirm your account password"
          value={revokePw}
          onInput={(e: any) => setRevokePw(e.target.value)}
        />
        {revokeMsg && (
          <div class={revokeMsg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-top: 8px">
            {revokeMsg.text}
          </div>
        )}
        <div style="margin-top: 12px">
          <button class="btn-danger sm" onClick={revokeAll} disabled={revokeLoading}>
            {revokeLoading ? 'Signing out…' : '⏻ Sign out everywhere'}
          </button>
        </div>
      </div>

      {/* Providers Security Lock */}
      <div class="panel settings-section">
        <div class="panel-title">Providers Security</div>
        <p class="settings-hint">
          Optional second-layer password guarding the Providers page. Adding, changing
          or removing it always requires your account password.
        </p>
        <div class="settings-row">
          <span class="field-label">Status</span>
          {lockEnabled === null ? (
            <span style="color: var(--text-3)">Checking…</span>
          ) : lockEnabled ? (
            <span class="badge-ok">🔒 Enabled · unlocked for 30 min after entry</span>
          ) : (
            <span class="badge-off">🔓 Disabled — Providers open to logged-in user</span>
          )}
        </div>

        <form onSubmit={saveLock}>
          <label class="field-label">Account password (verification)</label>
          <input
            class="modern-input"
            type="password"
            placeholder={lockEnabled ? 'Confirm your account password to change/remove' : 'Your account password'}
            value={lockAccountPw}
            onInput={(e: any) => setLockAccountPw(e.target.value)}
          />

          <label class="field-label">{lockEnabled ? 'New Providers password' : 'Set Providers password'}</label>
          <input
            class="modern-input"
            type="password"
            placeholder="Min 6 characters"
            value={lockNewPw}
            onInput={(e: any) => setLockNewPw(e.target.value)}
          />
          {lockNewPw && <PwMeter pw={lockNewPw} />}

          <label class="field-label">Confirm Providers password</label>
          <input
            class="modern-input"
            type="password"
            placeholder="Repeat providers password"
            value={lockConfirmPw}
            onInput={(e: any) => setLockConfirmPw(e.target.value)}
          />

          {lockMsg && (
            <div class={lockMsg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-top: 8px">
              {lockMsg.text}
            </div>
          )}

          <div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap;">
            <button class="btn-primary sm" type="submit" disabled={lockLoading}>
              {lockLoading ? 'Saving…' : lockEnabled ? 'Change password' : 'Enable lock'}
            </button>
            {lockEnabled && (
              <button class="btn-danger sm" type="button" onClick={disableLock} disabled={lockLoading}>
                Disable lock
              </button>
            )}
          </div>
        </form>
      </div>

      {/* Auto-logout on inactivity */}
      <div class="panel settings-section">
        <div class="panel-title">Auto-logout</div>
        <p class="settings-hint">Sign out automatically after a period of inactivity in the browser.</p>
        <div class="settings-row">
          <span class="field-label">Idle timeout</span>
          <select
            class="modern-input"
            style="max-width: 160px"
            value={idleChoice}
            onChange={(e: any) => applyIdleChoice(e.target.value as IdleChoice)}
          >
            <option value="off">Disabled</option>
            <option value="30">30 minutes</option>
            <option value="60">1 hour</option>
            <option value="120">2 hours</option>
          </select>
        </div>
      </div>

      {/* Backup / Restore */}
      <div class="panel settings-section">
        <div class="panel-title">Backup &amp; Restore</div>
        <p class="settings-hint">
          Export agents, agent sessions, provider configs and chat preferences as JSON.
          <strong> API keys are never included.</strong> Import merges new items only —
          existing ones stay untouched.
        </p>

        <label class="field-label">Account password (verification)</label>
        <input
          class="modern-input"
          type="password"
          placeholder="Required for both export and import"
          value={backupAccountPw}
          onInput={(e: any) => setBackupAccountPw(e.target.value)}
        />

        {backupMsg && (
          <div class={backupMsg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-top: 8px">
            {backupMsg.text}
          </div>
        )}

        <div style="display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; align-items: center;">
          <button class="btn-primary sm" onClick={doExport} disabled={backupLoading !== null}>
            {backupLoading === 'export' ? 'Exporting…' : '⭳ Export backup'}
          </button>
          <form onSubmit={doImport} style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <input id="import-file" type="file" accept=".json,application/json" class="modern-input" style="max-width: 240px; padding: 4px 6px;" />
            <button class="btn-ghost sm" type="submit" disabled={backupLoading !== null}>
              {backupLoading === 'import' ? 'Importing…' : '⭱ Import'}
            </button>
          </form>
        </div>
      </div>

      {/* Change Password */}
      <div class="panel settings-section">
        <div class="panel-title">Change Password</div>
        <form onSubmit={changePassword}>
          <label class="field-label">Current Password</label>
          <input
            class="modern-input"
            type="password"
            placeholder="Current password"
            value={currentPw}
            onInput={(e: any) => setCurrentPw(e.target.value)}
          />

          <label class="field-label">New Password</label>
          <input
            class="modern-input"
            type="password"
            placeholder="Min 6 characters"
            value={newPw}
            onInput={(e: any) => setNewPw(e.target.value)}
          />
          {newPw && <PwMeter pw={newPw} />}

          <label class="field-label">Confirm New Password</label>
          <input
            class="modern-input"
            type="password"
            placeholder="Confirm new password"
            value={confirmPw}
            onInput={(e: any) => setConfirmPw(e.target.value)}
          />

          {pwMsg && (
            <div class={pwMsg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-top: 8px">
              {pwMsg.text}
            </div>
          )}

          <div style="margin-top: 12px">
            <button class="btn-primary sm" type="submit" disabled={pwLoading}>
              {pwLoading ? 'Changing…' : 'Change Password'}
            </button>
          </div>
        </form>
      </div>

      {/* Security Activity */}
      <div class="panel settings-section">
        <div class="panel-title">Security Activity</div>
        <p class="settings-hint">Recent security-related events (newest first, last 50).</p>
        {audit === null ? (
          <div class="settings-hint">Loading…</div>
        ) : audit.length === 0 ? (
          <div class="settings-hint">No activity recorded yet.</div>
        ) : (
          <div class="audit-list">
            {audit.map((e, i) => {
              const label = AUDIT_LABELS[e.event] || e.event;
              const failed = !e.ok || e.event.endsWith('-failed');
              return (
                <div class="audit-row" key={`${e.ts}-${i}`}>
                  <span class={failed ? 'audit-dot bad' : 'audit-dot good'} title={failed ? 'Failed' : 'Success'} />
                  <span class="audit-label">{label}</span>
                  <span class="audit-time">{fmtDate(e.ts)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* About */}
      <div class="panel settings-section">
        <div class="panel-title">About</div>
        <div class="settings-row">
          <span class="field-label">Version</span>
          <span class="mono beta-chip" title="Beta software — features and data format may change">{APP_VERSION}</span>
        </div>
        <div class="settings-row">
          <span class="field-label">License</span>
          <span style="color: var(--text-2)">MIT</span>
        </div>
      </div>
    </div>
  );
}
