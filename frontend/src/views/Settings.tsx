import { useState } from 'preact/hooks';
import { useAuth } from '../auth';

export function Settings() {
  const { user, logout } = useAuth();

  // Change password state
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwLoading, setPwLoading] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

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
    if (newPw.length < 4) {
      setPwMsg({ type: 'err', text: 'New password must be at least 4 characters.' });
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
      setPwMsg({ type: 'ok', text: 'Password changed successfully.' });
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
    } catch (err: any) {
      setPwMsg({ type: 'err', text: err.message || 'Failed' });
    } finally {
      setPwLoading(false);
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
        <p class="hero-sub">
          Manage your account and application settings.
        </p>
      </div>

      {/* Account Info */}
      <div class="panel settings-section">
        <div class="panel-title">Account</div>
        <div class="settings-row">
          <span class="field-label">Username</span>
          <span class="mono" style="color: var(--text)">{user?.username || '—'}</span>
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
            placeholder="New password"
            value={newPw}
            onInput={(e: any) => setNewPw(e.target.value)}
          />

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

      {/* About */}
      <div class="panel settings-section">
        <div class="panel-title">About</div>
        <div class="settings-row">
          <span class="field-label">Version</span>
          <span class="mono" style="color: var(--text)">2.0.0</span>
        </div>
        <div class="settings-row">
          <span class="field-label">License</span>
          <span style="color: var(--text-2)">MIT</span>
        </div>
      </div>
    </div>
  );
}
