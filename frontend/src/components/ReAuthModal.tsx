import { useState, useEffect } from 'preact/hooks';
import { User, ShieldCheck, Loader2 } from 'lucide-preact';

interface ReAuthModalProps {
  open: boolean;
  username?: string;
  title?: string;
  description?: string;
  confirmLabel?: string;
  loading?: boolean;
  error?: string | null;
  onConfirm: (accountPassword: string) => void;
  onCancel: () => void;
}

/**
 * Login-style identity confirmation dialog ("sudo prompt").
 * Asks for the signed-in user's ACCOUNT password before performing a
 * sensitive operation. Used by Settings for lock changes, backups and
 * logout-everywhere.
 */
export function ReAuthModal({
  open,
  username,
  title = 'Confirm your identity',
  description = 'Enter your account password to continue.',
  confirmLabel = 'Confirm',
  loading = false,
  error = null,
  onConfirm,
  onCancel,
}: ReAuthModalProps) {
  const [pw, setPw] = useState('');

  // Fresh field on open AND after every failed attempt (error prop change),
  // so a stale wrong password is never left sitting in the box.
  useEffect(() => {
    if (open) setPw('');
  }, [open]);

  useEffect(() => {
    if (error) setPw('');
  }, [error]);

  // Esc closes (unless a request is in flight).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, loading]);

  if (!open) return null;

  const submit = (e: Event) => {
    e.preventDefault();
    if (!pw || loading) return;
    onConfirm(pw);
  };

  return (
    <div class="modal-overlay" onMouseDown={(e: any) => { if (e.target === e.currentTarget) onCancel(); }}>
      <form class="modal-card reauth-card" onSubmit={submit}>
        <div class="reauth-avatar" aria-hidden="true">
          <User width={26} height={26} />
        </div>
        <div class="reauth-username">{username || 'account'}</div>
        <div class="reauth-title">{title}</div>
        <p class="settings-hint" style="text-align:center">{description}</p>

        <input
          class="modern-input"
          type="password"
          placeholder="Account password"
          autoFocus
          value={pw}
          onInput={(e: any) => setPw(e.target.value)}
        />

        {error && <div class="login-error" style="text-align:center">{error}</div>}

        <div style="display:flex; gap:8px; margin-top:14px; justify-content:flex-end;">
          <button class="btn-ghost sm" type="button" onClick={onCancel} disabled={loading}>
            Cancel
          </button>
          <button class="btn-primary sm" type="submit" disabled={loading || !pw}>
            {loading ? (
              <span style="display:inline-flex;align-items:center;gap:6px;">
                <Loader2 width={14} height={14} class="icon spin" /> Verifying…
              </span>
            ) : (
              <span style="display:inline-flex;align-items:center;gap:6px;">
                <ShieldCheck width={14} height={14} /> {confirmLabel}
              </span>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
