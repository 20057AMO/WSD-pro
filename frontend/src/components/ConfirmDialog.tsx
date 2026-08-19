import { useEffect, useRef } from 'preact/hooks';

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger, onConfirm, onCancel }: ConfirmDialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  return (
    <div class="confirm-overlay" ref={overlayRef} onClick={(e) => { if (e.target === overlayRef.current) onCancel(); }}
      role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div class="confirm-dialog">
        <div class="confirm-title" id="confirm-title">{title}</div>
        <div class="confirm-message">{message}</div>
        <div class="confirm-actions">
          <button class="btn-ghost sm" type="button" onClick={onCancel}>{cancelLabel}</button>
          <button ref={confirmRef} class={`${danger ? 'btn-danger' : 'btn-primary'} sm`} type="button" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
