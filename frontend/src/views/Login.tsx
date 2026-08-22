import { useState } from 'preact/hooks';
import { useAuth } from '../auth';
import { PwMeter } from '../components/PwMeter';

export function Login() {
  const { hasUser, login, setup } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const isSetup = !hasUser;

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (loading) return;

    if (!username.trim() || !password) {
      setError('Please fill in all fields.');
      return;
    }

    if (isSetup && password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    if (isSetup && password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    setError('');
    setLoading(true);

    try {
      if (isSetup) {
        await setup(username.trim(), password);
      } else {
        await login(username.trim(), password);
      }
    } catch (err: any) {
      setError(err.message || 'Failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="login-page">
      <div class="login-card">
        <div class="login-brand">
          <img src="/logo.png" alt="WSD-Pro" class="login-logo" />
          <h1 class="login-title">WSD-Pro</h1>
          <p class="login-sub">
            {isSetup
              ? 'Set up your account to get started'
              : 'Sign in to your account'}
          </p>
          <span class="beta-chip login-beta" title="Beta software — features and data format may change">v2.0.0-beta</span>
        </div>

        <form onSubmit={handleSubmit} class="login-form">
          <label class="field-label">Username</label>
          <input
            class="modern-input"
            type="text"
            placeholder="Enter username"
            autoFocus
            value={username}
            onInput={(e: any) => setUsername(e.target.value)}
          />

          <label class="field-label">Password</label>
          <input
            class="modern-input"
            type="password"
            placeholder={isSetup ? 'Min 6 characters' : 'Enter password'}
            value={password}
            onInput={(e: any) => setPassword(e.target.value)}
          />
          {isSetup && password && <PwMeter pw={password} />}

          {isSetup && (
            <>
              <label class="field-label">Confirm Password</label>
              <input
                class="modern-input"
                type="password"
                placeholder="Confirm password"
                value={confirm}
                onInput={(e: any) => setConfirm(e.target.value)}
              />
            </>
          )}

          {error && <div class="login-error">{error}</div>}

          <button class="btn-primary login-btn" type="submit" disabled={loading}>
            {loading
              ? isSetup
                ? 'Setting up…'
                : 'Signing in…'
              : isSetup
                ? 'Create Account'
                : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}

