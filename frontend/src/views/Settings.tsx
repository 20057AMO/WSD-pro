import { useState, useEffect, useRef } from 'preact/hooks';
import QRCode from 'qrcode';
import {
  Loader2,
  LogOut,
  Lock,
  LockOpen,
  KeyRound,
  Download,
  Upload,
  ShieldCheck,
  Smartphone,
  Settings as SettingsIcon,
} from 'lucide-preact';
import { useAuth } from '../auth';
import {
  getProvidersLockStatus,
  setProvidersPassword,
  removeProvidersPassword,
  exportSettings,
  importSettings,
  clearProvidersUnlock,
  setProvidersUnlock,
  relockProviders,
  apiLogoutAll,
  getAuditLog,
  getTotpStatus,
  totpSetup,
  totpEnable,
  totpDisable,
  type AuditEntry,
  type BackupFile,
} from '../api';
import { PwMeter } from '../components/PwMeter';
import { ReAuthModal } from '../components/ReAuthModal';

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
  'providers-unlock': 'Providers page unlocked',
  'providers-unlock-failed': 'Providers unlock attempt failed',
  'providers-relock': 'Providers locked on all devices',
  '2fa-enabled': 'Two-factor authentication enabled',
  '2fa-enabled-failed': 'Two-factor enable attempt failed',
  '2fa-disabled': 'Two-factor authentication disabled',
  '2fa-disabled-failed': 'Two-factor disable attempt failed',
  'login-2fa-failed': 'Sign in blocked — wrong authenticator code',
  'backup-export': 'Backup exported',
  'backup-import': 'Backup imported',
};

type Msg = { type: 'ok' | 'err'; text: string } | null;

type SensitiveAction = 'save-lock' | 'disable-lock' | 'export' | 'import' | 'revoke-all' | '2fa-disable';

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

  // ── Providers security lock ──
  const [lockEnabled, setLockEnabled] = useState<boolean | null>(null);
  const [lockFetchError, setLockFetchError] = useState(false);
  const [lockNewPw, setLockNewPw] = useState('');
  const [lockConfirmPw, setLockConfirmPw] = useState('');
  const [lockMsg, setLockMsg] = useState<Msg>(null);
  const pendingLockPw = useRef('');

  // ── Inactivity auto-logout ──
  type IdleChoice = 'off' | '30' | '60' | '120';
  const [idleChoice, setIdleChoice] = useState<IdleChoice>(() => {
    try {
      return (localStorage.getItem('wsd.idleTimeout') as IdleChoice) || 'off';
    } catch {
      return 'off';
    }
  });
  const [idleSaved, setIdleSaved] = useState(false);

  // ── Providers auto-relock on inactivity ──
  type RelockChoice = 'off' | '5' | '15' | '30';
  const [relockChoice, setRelockChoice] = useState<RelockChoice>(() => {
    try {
      return (localStorage.getItem('wsd.providersAutoRelock') as RelockChoice) || 'off';
    } catch {
      return 'off';
    }
  });
  const [relockSaved, setRelockSaved] = useState(false);

  // ── Backup ──
  const [backupMsg, setBackupMsg] = useState<Msg>(null);
  const pendingImportRef = useRef<BackupFile | null>(null);

  // ── Two-factor authentication (TOTP) ──
  const [totpEnabled, setTotpEnabled] = useState<boolean | null>(null);
  const [totpMsg, setTotpMsg] = useState<Msg>(null);
  const [totpEnrolling, setTotpEnrolling] = useState<{ secret: string; uri: string } | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [totpCode, setTotpCode] = useState('');
  const [totpBusy, setTotpBusy] = useState(false);

  useEffect(() => {
    getTotpStatus()
      .then((r) => setTotpEnabled(r.enabled))
      .catch(() => setTotpEnabled(null));
  }, []);

  // Render the provisioning URI as a QR image whenever enrollment starts.
  useEffect(() => {
    if (!totpEnrolling) { setQrDataUrl(''); return; }
    QRCode.toDataURL(totpEnrolling.uri, { width: 180, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [totpEnrolling]);

  const beginEnable2fa = async () => {
    setTotpMsg(null);
    setTotpBusy(true);
    try {
      const r = await totpSetup();
      setTotpEnrolling({ secret: r.secret, uri: r.uri });
      setTotpCode('');
    } catch (err: any) {
      setTotpMsg({ type: 'err', text: err.message || 'Could not start setup.' });
    } finally {
      setTotpBusy(false);
    }
  };

  const confirmEnable2fa = async (e: Event) => {
    e.preventDefault();
    if (!totpEnrolling || totpBusy) return;
    setTotpBusy(true);
    try {
      await totpEnable(totpCode.trim());
      setTotpEnabled(true);
      setTotpEnrolling(null);
      setTotpCode('');
      setTotpMsg({ type: 'ok', text: 'Two-factor authentication is now active.' });
      setTimeout(() => setTotpMsg(null), 4000);
      getAuditLog(AUDIT_PAGE, 0).then((r) => { setAudit(r.entries || []); setAuditTotal(r.total || 0); }).catch(() => {});
    } catch (err: any) {
      setTotpMsg({ type: 'err', text: err.message || 'Invalid code.' });
    } finally {
      setTotpBusy(false);
    }
  };

  const cancelEnable2fa = () => {
    setTotpEnrolling(null);
    setTotpCode('');
    setTotpMsg(null);
  };

  const beginDisable2fa = () => {
    setTotpMsg(null);
    setPendingAction('2fa-disable');
  };

  // ── Unified identity confirmation (sudo-style) ──
  const [pendingAction, setPendingAction] = useState<SensitiveAction | null>(null);
  const [reauthLoading, setReauthLoading] = useState(false);
  const [reauthError, setReauthError] = useState<string | null>(null);

  // ── Security activity ──
  const AUDIT_PAGE = 20;
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);

  useEffect(() => {
    getProvidersLockStatus()
      .then((r) => { setLockEnabled(r.enabled); setLockFetchError(false); })
      .catch(() => { setLockEnabled(null); setLockFetchError(true); });
    getAuditLog(AUDIT_PAGE, 0)
      .then((r) => { setAudit(r.entries || []); setAuditTotal(r.total || 0); })
      .catch(() => { setAudit([]); setAuditTotal(0); });
  }, []);

  const loadMoreAudit = async () => {
    if (!audit) return;
    setAuditLoadingMore(true);
    try {
      const r = await getAuditLog(AUDIT_PAGE, audit.length);
      setAudit((prev) => [...(prev || []), ...(r.entries || [])]);
      setAuditTotal(r.total || 0);
    } catch { /* ignore */ }
    setAuditLoadingMore(false);
  };

  // ════ Step 1 handlers: validate locally, then open the ReAuth dialog ════

  const beginSaveLock = (e: Event) => {
    e.preventDefault();
    if (!lockNewPw || !lockConfirmPw) {
      setLockMsg({ type: 'err', text: 'Fill in the new providers password and its confirmation.' });
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
    setLockMsg(null);
    pendingLockPw.current = lockNewPw;
    setPendingAction('save-lock');
  };

  const beginDisableLock = () => setPendingAction('disable-lock');

  const beginExport = () => {
    setBackupMsg(null);
    setPendingAction('export');
  };

  const beginImport = async (e: Event) => {
    e.preventDefault();
    const input = document.getElementById('import-file') as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) {
      setBackupMsg({ type: 'err', text: 'Choose a backup .json file first.' });
      return;
    }
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed?.kind !== 'madar-backup' && parsed?.kind !== 'wsd-pro-backup') throw new Error('Not a Madar backup file.');
      pendingImportRef.current = parsed as BackupFile;
      setBackupMsg(null);
      setPendingAction('import');
    } catch (err: any) {
      setBackupMsg({ type: 'err', text: err.message || 'Invalid backup file.' });
    }
  };

  const beginRevokeAll = () => setPendingAction('revoke-all');

  // ════ Step 2: the ReAuth dialog confirmed — execute the real operation ════

  const executeReauth = async (accountPassword: string) => {
    if (!pendingAction) return;
    setReauthLoading(true);
    setReauthError(null);

    const fail = (msg: string, keepOpen: boolean) => {
      if (keepOpen) {
        setReauthError(msg);
        return;
      }
      // Route the failure message to exactly ONE panel — never duplicate it.
      setPendingAction(null);
      if (pendingAction === 'save-lock' || pendingAction === 'disable-lock') {
        setLockMsg({ type: 'err', text: msg });
      } else if (pendingAction === 'revoke-all') {
        setPwMsg({ type: 'err', text: msg });
      } else if (pendingAction === '2fa-disable') {
        setTotpMsg({ type: 'err', text: msg });
      } else {
        setBackupMsg({ type: 'err', text: msg });
      }
    };

    try {
      switch (pendingAction) {
        case 'save-lock': {
          const result = await setProvidersPassword(accountPassword, pendingLockPw.current);
          const wasEnabled = lockEnabled === true;
          setLockEnabled(true);
          setLockMsg({ type: 'ok', text: wasEnabled ? 'Providers password changed.' : 'Providers lock enabled.' });
          setTimeout(() => setLockMsg(null), 4000);
          // The server hands back a fresh unlock token for the new password —
          // store it so visiting Providers right away is open, not a lockout.
          if (result.unlockToken) {
            setProvidersUnlock(result.unlockToken, result.expiresInSec || 1800);
          } else {
            clearProvidersUnlock();
          }
          pendingLockPw.current = '';
          setLockNewPw('');
          setLockConfirmPw('');
          break;
        }
        case 'disable-lock': {
          await removeProvidersPassword(accountPassword);
          setLockEnabled(false);
          setLockMsg({ type: 'ok', text: 'Providers lock disabled.' });
          setTimeout(() => setLockMsg(null), 4000);
          clearProvidersUnlock();
          break;
        }
        case 'export': {
          const backup = await exportSettings(accountPassword);
          const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `madar-backup-${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
          URL.revokeObjectURL(url);
          setBackupMsg({ type: 'ok', text: 'Backup downloaded (API keys excluded by design).' });
          break;
        }
        case 'import': {
          const backup = pendingImportRef.current;
          if (!backup) throw new Error('Import data is missing — pick the file again.');
          const result = await importSettings(accountPassword, backup);
          const total = Object.values(result.imported || {}).reduce((s, n) => s + n, 0);
          setBackupMsg({
            type: 'ok',
            text: `Imported ${total} item(s), skipped ${result.skipped} existing. Re-add provider API keys manually.`,
          });
          const input = document.getElementById('import-file') as HTMLInputElement | null;
          if (input) input.value = '';
          pendingImportRef.current = null;
          break;
        }
        case 'revoke-all': {
          await apiLogoutAll(accountPassword);
          logout();
          window.location.hash = '/login';
          break;
        }
        case '2fa-disable': {
          await totpDisable(accountPassword);
          setTotpEnabled(false);
          setTotpMsg({ type: 'ok', text: 'Two-factor authentication disabled.' });
          setTimeout(() => setTotpMsg(null), 4000);
          break;
        }
      }
      setPendingAction(null);
      // Security Activity reflects the operation that just succeeded.
      getAuditLog(AUDIT_PAGE, 0)
        .then((r) => { setAudit(r.entries || []); setAuditTotal(r.total || 0); })
        .catch(() => {});
    } catch (err: any) {
      const msg = err.message || 'Operation failed.';
      const isRetryable = err.status === 401 || err.status === 429 || (err.status === 400 && /password/i.test(msg));
      fail(msg, isRetryable);
    } finally {
      setReauthLoading(false);
    }
  };

  // ── Change account password (unchanged flow) ──
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

  const applyIdleChoice = (value: IdleChoice) => {
    setIdleChoice(value);
    try {
      localStorage.setItem('wsd.idleTimeout', value);
    } catch { /* ignore */ }
    setIdleSaved(true);
    setTimeout(() => setIdleSaved(false), 2000);
  };

  const applyRelockChoice = (value: RelockChoice) => {
    setRelockChoice(value);
    try {
      localStorage.setItem('wsd.providersAutoRelock', value);
    } catch { /* ignore */ }
    setRelockSaved(true);
    setTimeout(() => setRelockSaved(false), 2000);
  };

  const handleLogout = () => {
    logout();
    window.location.hash = '/login';
  };

  return (
    <div class="view">
      <div class="hero">
        <span class="hero-badge"><SettingsIcon width={12} height={12} /> Settings</span>
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
        <div style="margin-top: 12px">
          <button class="btn-danger sm" onClick={handleLogout}>
            <span class="icon-wrap"><LogOut width={13} height={13} /></span> Logout
          </button>
        </div>
      </div>

      {/* Providers Security Lock — two-step flow */}
      <div class="panel settings-section">
        <div class="panel-title">
          <span class="icon-wrap"><KeyRound width={14} height={14} /></span> Providers Security
        </div>
        <p class="settings-hint">
          Optional second-layer password guarding the Providers page.
        </p>
        <div class="settings-row">
          <span class="field-label">Status</span>
          {lockFetchError ? (
            <span class="badge-off"><Loader2 width={11} height={11} class="icon spin" /> Could not check — try refreshing</span>
          ) : lockEnabled === null ? (
            <span class="inline-loading"><Loader2 width={12} height={12} class="icon spin" /> Checking…</span>
          ) : lockEnabled ? (
            <span class="badge-ok"><Lock width={11} height={11} /> Enabled · stays open 30 min after entry</span>
          ) : (
            <span class="badge-off"><LockOpen width={11} height={11} /> Disabled — Providers open while signed in</span>
          )}
        </div>

        <form onSubmit={beginSaveLock}>
          <label class="field-label">
            {lockEnabled ? 'New Providers password' : 'Set Providers password'}
          </label>
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
            <button class="btn-primary sm" type="submit">
              <span class="icon-wrap"><ShieldCheck width={13} height={13} /></span>
              {lockEnabled ? 'Change Providers password' : 'Enable lock'}
            </button>
            {lockEnabled && (
              <>
                <button class="btn-ghost sm" type="button" onClick={async () => {
                  try {
                    await relockProviders();
                    clearProvidersUnlock();
                    setLockMsg({ type: 'ok', text: 'Locked on all tabs and devices.' });
                  } catch {
                    setLockMsg({ type: 'err', text: 'Could not lock other devices.' });
                  }
                }}>
                  Lock now
                </button>
                <button class="btn-danger sm" type="button" onClick={beginDisableLock}>
                  Disable lock
                </button>
              </>
            )}
          </div>
          <p class="settings-hint" style="margin-top:10px;">
            You will confirm your identity with your account password in the next step.
          </p>
        </form>
      </div>

      {/* Logout everywhere */}
      <div class="panel settings-section">
        <div class="panel-title">Logout Everywhere</div>
        <p class="settings-hint">
          Invalidate every signed-in session — all browser tabs and devices will
          need to log in again. You will be logged out here too.
        </p>
        {pwMsg && pendingAction === null && (
          <div class={pwMsg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-bottom: 8px">
            {pwMsg.text}
          </div>
        )}
        <button class="btn-danger sm" onClick={beginRevokeAll}>
          <span class="icon-wrap"><LogOut width={13} height={13} /></span> Sign out everywhere
        </button>
      </div>

      {/* Two-factor authentication (TOTP) */}
      <div class="panel settings-section">
        <div class="panel-title">
          Two-Factor Authentication
          {totpEnabled === true && (
            <span class="badge-ok" style="margin-inline-start: 8px;">
              <ShieldCheck width={11} height={11} /> On
            </span>
          )}
          {totpEnabled === false && (
            <span class="badge-off" style="margin-inline-start: 8px;">Off</span>
          )}
        </div>
        <p class="settings-hint">
          Require a 6-digit code from an authenticator app (Google Authenticator,
          Authy, Aegis…) after your password at every sign-in.
        </p>

        {totpMsg && (
          <div class={totpMsg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-bottom: 8px">
            {totpMsg.text}
          </div>
        )}

        {totpEnrolling ? (
          <form onSubmit={confirmEnable2fa}>
            <div class="totp-enroll">
              {qrDataUrl && <img class="totp-qr" src={qrDataUrl} alt="Authenticator QR code" />}
              <div class="totp-manual">
                <span class="field-label">Can't scan? Enter this key instead</span>
                <code class="totp-secret">{totpEnrolling.secret}</code>
                <span class="settings-hint">Time-based · SHA-1 · 6 digits · 30s — defaults for any app.</span>
              </div>
            </div>
            <div class="settings-row" style="margin-top: 10px;">
              <input
                class="modern-input login-otp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                maxLength={7}
                autoFocus
                value={totpCode}
                onInput={(e: any) => setTotpCode(e.target.value)}
              />
              <button class="btn-primary sm" type="submit" disabled={totpBusy || !totpCode.trim()}>
                {totpBusy ? <Loader2 width={13} height={13} class="icon spin" /> : <ShieldCheck width={13} height={13} />} Activate
              </button>
              <button class="btn-ghost sm" type="button" onClick={cancelEnable2fa}>Cancel</button>
            </div>
            <p class="settings-hint" style="margin-top:8px;">
              Scan the code with your app, then enter the current code to activate.
            </p>
          </form>
        ) : totpEnabled === true ? (
          <button class="btn-danger sm" onClick={beginDisable2fa}>
            <Smartphone width={13} height={13} /> Disable two-factor
          </button>
        ) : (
          <button class="btn-primary sm" onClick={beginEnable2fa} disabled={totpBusy}>
            {totpBusy ? <Loader2 width={13} height={13} class="icon spin" /> : <Smartphone width={13} height={13} />}
            Enable two-factor
          </button>
        )}
      </div>

      {/* Auto-logout on inactivity */}
      <div class="panel settings-section">
        <div class="panel-title">Idle security</div>
        <p class="settings-hint">
          Sign out automatically after a period of inactivity — and optionally re-lock
          the Providers page (revokes its unlock token everywhere).
        </p>
        <div class="settings-row">
          <span class="field-label">Auto-logout</span>
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
          {idleSaved && <span class="chat-save-msg">Saved ✓</span>}
        </div>
        <div class="settings-row">
          <span class="field-label">Auto-relock Providers</span>
          <select
            class="modern-input"
            style="max-width: 160px"
            value={relockChoice}
            onChange={(e: any) => applyRelockChoice(e.target.value as RelockChoice)}
          >
            <option value="off">Disabled</option>
            <option value="5">5 minutes</option>
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
          </select>
          {relockSaved && <span class="chat-save-msg">Saved ✓</span>}
        </div>
      </div>

      {/* Backup / Restore */}
      <div class="panel settings-section">
        <div class="panel-title">Backup &amp; Restore</div>
        <p class="settings-hint">
          Export agents, sessions, provider configs and chat preferences as JSON.
          <strong> API keys are never included.</strong> Import merges new items only.
        </p>

        {backupMsg && (
          <div class={backupMsg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-bottom: 8px">
            {backupMsg.text}
          </div>
        )}

        <div style="display: flex; gap: 10px; margin-top: 4px; flex-wrap: wrap; align-items: center;">
          <button class="btn-primary sm" onClick={beginExport}>
            <span class="icon-wrap"><Download width={13} height={13} /></span> Export backup
          </button>
          <form onSubmit={beginImport} style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <input id="import-file" type="file" accept=".json,application/json" class="modern-file" />
            <button class="btn-ghost sm" type="submit">
              <span class="icon-wrap"><Upload width={13} height={13} /></span> Import
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
              {pwLoading ? (
                <span style="display:inline-flex;align-items:center;gap:6px;">
                  <Loader2 width={13} height={13} class="icon spin" /> Changing…
                </span>
              ) : 'Change Password'}
            </button>
          </div>
        </form>
      </div>

      {/* Security Activity */}
      <div class="panel settings-section">
        <div class="panel-title">Security Activity</div>
        <p class="settings-hint">Recent security-related events (newest first, last 50).</p>
        {audit === null ? (
          <div class="inline-loading"><Loader2 width={12} height={12} class="icon spin" /> Loading…</div>
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
                  {e.ip && <span class="audit-ip" title="Source IP">{e.ip}</span>}
                  <span class="audit-time">{fmtDate(e.ts)}</span>
                </div>
              );
            })}
            {audit.length < auditTotal && (
              <button
                class="btn-ghost sm"
                style="width: 100%; margin-top: 8px; justify-content: center;"
                onClick={loadMoreAudit}
                disabled={auditLoadingMore}
              >
                {auditLoadingMore ? 'Loading…' : `Show more (${auditTotal - audit.length} remaining)`}
              </button>
            )}
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

      {/* Unified identity confirmation */}
      <ReAuthModal
        open={pendingAction !== null}
        username={user?.username}
        loading={reauthLoading}
        error={reauthError}
        title={
          pendingAction === 'revoke-all'
            ? 'Sign out everywhere?'
            : pendingAction === 'disable-lock'
              ? 'Disable Providers lock'
              : pendingAction === '2fa-disable'
                ? 'Disable two-factor authentication'
                : pendingAction === 'save-lock'
                  ? (lockEnabled ? 'Change Providers password' : 'Enable Providers lock')
                  : pendingAction === 'import'
                    ? 'Import backup'
                    : 'Export backup'
        }
        description={
          pendingAction === 'revoke-all'
            ? 'This signs you out of every device and browser tab.'
            : pendingAction === 'disable-lock'
              ? 'This removes the second password — anyone using this session will be able to open Providers.'
              : pendingAction === '2fa-disable'
                ? 'Your account will be protected by the password only. You will confirm this with your account password.'
                : 'Enter your account password to authorize this action.'
        }
        confirmLabel="Confirm"
        onConfirm={executeReauth}
        onCancel={() => { setPendingAction(null); setReauthError(null); pendingLockPw.current = ''; }}
      />
    </div>
  );
}
