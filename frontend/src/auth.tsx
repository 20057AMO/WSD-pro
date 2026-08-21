import { createContext, type ComponentChildren } from 'preact';
import { useState, useEffect, useContext, useCallback } from 'preact/hooks';

interface AuthUser {
  id: string;
  username: string;
  createdAt: string;
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

  return (
    <AuthContext.Provider value={{ user, token, loading, hasUser, login: doLogin, setup: doSetup, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
