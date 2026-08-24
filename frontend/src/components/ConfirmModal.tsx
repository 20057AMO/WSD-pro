import { useEffect } from 'preact/hooks';
import { TriangleAlert, Loader2 } from 'lucide-preact';

interface ConfirmModalProps {
  open: boolean;
  /** Title SHOULD name the exact target, e.g. `Delete project 'my-app'?` */
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Danger = destructive action: warning avatar + red confirm button. */
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * In-app replacement for native window.confirm() — same dark modal language
 * as ReAuthModal so destructive actions never break the app's visual flow
 * with raw browser chrome.
 */
export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
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

  return (
    <div class="modal-overlay" onMouseDown={(e: any) => { if (e.target === e.currentTarget && !loading) onCancel(); }}>
      <form
        class="modal-card reauth-card"
        onSubmit={(e: Event) => {
          e.preventDefault();
          if (!loading) onConfirm();
        }}
      >
        <div class={`reauth-avatar${danger ? ' confirm-danger-avatar' : ''}`} aria-hidden="true">
          <TriangleAlert width={26} height={26} />
        </div>
        <div class="reauth-title" style="text-align:center">{title}</div>
        {message && <p class="settings-hint" style="text-align:center">{message}</p>}
        <div style="display:flex; gap:8px; margin-top:14px; justify-content:center;">
          <button class="btn-ghost sm" type="button" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </button>
          <button class={`${danger ? 'btn-danger' : 'btn-primary'} sm`} type="submit" disabled={loading}>
            {loading ? (
              <span style="display:inline-flex;align-items:center;gap:6px;">
                <Loader2 width={14} height={14} class="icon spin" /> Working…
              </span>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
