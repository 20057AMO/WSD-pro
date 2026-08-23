import { createContext, type ComponentChildren } from 'preact';
import { useState, useEffect, useContext, useCallback } from 'preact/hooks';
import { relockProviders, clearProvidersUnlock } from './api';

interface AuthUser {
  id: string;
  username: string;
  createdAt: string;
  passwordChangedAt?: string;
}

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  hasUser: boolean;
  login: (username: string, password: string) => Promise<void>;
  setup: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState>({
  user: null,
  token: null,
  loading: true,
  hasUser: false,
  login: async () => {},
  setup: async () => {},
  logout: () => {},
});

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ComponentChildren }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasUser, setHasUser] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem('wsd.token');
    if (stored) {
      setToken(stored);
      fetch('/api/auth/status', { headers: { Authorization: `Bearer ${stored}` } })
        .then((r) => r.json())
        .then((data) => {
          if (data.user) {
            setUser(data.user);
            setHasUser(true);
          } else {
            localStorage.removeItem('wsd.token');
            setToken(null);
            setHasUser(data.hasUser || false);
          }
        })
        .catch(() => {
          localStorage.removeItem('wsd.token');
          setToken(null);
        })
        .finally(() => setLoading(false));
    } else {
      fetch('/api/auth/status')
        .then((r) => r.json())
        .then((data) => setHasUser(data.hasUser || false))
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, []);

  const doLogin = useCallback(async (username: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    localStorage.setItem('wsd.token', data.token);
    setToken(data.token);
    setUser({ id: data.id, username: data.username, createdAt: '' });
    setHasUser(true);
  }, []);

  const doSetup = useCallback(async (username: string, password: string) => {
    const res = await fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Setup failed');
    localStorage.setItem('wsd.token', data.token);
    setToken(data.token);
    setUser({ id: data.id, username: data.username, createdAt: '' });
    setHasUser(true);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('wsd.token');
    setToken(null);
    setUser(null);
  }, []);

  // ── Auto-logout on inactivity ─────────────────────────────────
  // Reads the idle timeout (minutes) from localStorage ('wsd.idleTimeout':
  // 'off' | '30' | '60' | '120'). Activity events throttle-refresh the clock.
  useEffect(() => {
    if (!token) return;

    let limitMs = 0;
    const readLimit = () => {
      try {
        const raw = localStorage.getItem('wsd.idleTimeout');
        if (!raw || raw === 'off') { limitMs = 0; return; }
        limitMs = Math.max(1, parseInt(raw, 10) || 0) * 60_000;
      } catch { limitMs = 0; }
    };
    readLimit();

    let lastActivity = Date.now();
    let throttled = false;
    const markActive = () => {
      if (throttled) return;
      throttled = true;
      lastActivity = Date.now();
      setTimeout(() => { throttled = false; }, 5_000);
    };

    const events = ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'];
    events.forEach((ev) => window.addEventListener(ev, markActive, { passive: true }));

    // Re-read limit when another tab changes the setting
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'wsd.idleTimeout') readLimit();
    };
    window.addEventListener('storage', onStorage);

    const checker = setInterval(() => {
      if (limitMs <= 0) return;
      if (Date.now() - lastActivity > limitMs) {
        clearInterval(checker);
        events.forEach((ev) => window.removeEventListener(ev, markActive));
        window.removeEventListener('storage', onStorage);
        localStorage.removeItem('wsd.token');
        setToken(null);
        setUser(null);
        window.location.hash = '/login';
      }
    }, 15_000);

    return () => {
      clearInterval(checker);
      events.forEach((ev) => window.removeEventListener(ev, markActive));
      window.removeEventListener('storage', onStorage);
    };
  }, [token]);

  // ── Auto-relock Providers on inactivity ───────────────────────
  // Mirrors auto-logout: reads 'wsd.providersAutoRelock' ('off' | '5' |
  // '15' | '30' minutes), activity events throttle-refresh the clock, and
  // the storage event keeps tabs in sync. On expiry it revokes every
  // unlock token server-side and clears the local copy. No-ops server-side
  // when the providers lock is not enabled.
  useEffect(() => {
    if (!token) return;

    let limitMs = 0;
    const readLimit = () => {
      try {
        const raw = localStorage.getItem('wsd.providersAutoRelock');
        if (!raw || raw === 'off') { limitMs = 0; return; }
        limitMs = Math.max(1, parseInt(raw, 10) || 0) * 60_000;
      } catch { limitMs = 0; }
    };
    readLimit();

    let lastActivity = Date.now();
    let throttled = false;
    const markActive = () => {
      if (throttled) return;
      throttled = true;
      lastActivity = Date.now();
      setTimeout(() => { throttled = false; }, 5_000);
    };

    const events = ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'];
    events.forEach((ev) => window.addEventListener(ev, markActive, { passive: true }));

    const onStorage = (e: StorageEvent) => {
      if (e.key === 'wsd.providersAutoRelock') readLimit();
    };
    window.addEventListener('storage', onStorage);

    const checker = setInterval(() => {
      if (limitMs <= 0) return;
      if (Date.now() - lastActivity > limitMs) {
        clearInterval(checker);
        events.forEach((ev) => window.removeEventListener(ev, markActive));
        window.removeEventListener('storage', onStorage);
        relockProviders().catch(() => {});
        clearProvidersUnlock();
      }
    }, 15_000);

    return () => {
      clearInterval(checker);
      events.forEach((ev) => window.removeEventListener(ev, markActive));
      window.removeEventListener('storage', onStorage);
    };
  }, [token]);

  return (
    <AuthContext.Provider value={{ user, token, loading, hasUser, login: doLogin, setup: doSetup, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
