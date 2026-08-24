import { Component, type ComponentChildren } from 'preact';
import { lazy, Suspense } from 'preact/compat';
import { useState, useEffect } from 'preact/hooks';
import { Router, Route } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import {
  LayoutDashboard,
  FolderOpen,
  Bot,
  SquareTerminal,
  KeyRound,
  Settings as SettingsIcon,
  Code2,
  Unlock,
} from 'lucide-preact';
import { AuthProvider, useAuth } from './auth';
import { Login } from './views/Login';
import { ConfirmModal } from './components/ConfirmModal';
import {
  getProvidersLockStatus,
  getProvidersUnlock,
  relockProviders,
  clearProvidersUnlock,
  UNLOCK_KEY,
} from './api';

const Dashboard = lazy(() => import('./views/Dashboard').then(m => ({ default: m.Dashboard })));
const Projects = lazy(() => import('./views/Projects').then(m => ({ default: m.Projects })));
const Project = lazy(() => import('./views/Project').then(m => ({ default: m.Project })));
const Opencode = lazy(() => import('./views/Opencode').then(m => ({ default: m.Opencode })));
const Agents = lazy(() => import('./views/Agents').then(m => ({ default: m.Agents })));
const EmbeddedIDE = lazy(() => import('./views/EmbeddedIDE').then(m => ({ default: m.EmbeddedIDE })));
const Providers = lazy(() => import('./views/Providers').then(m => ({ default: m.Providers })));
const Settings = lazy(() => import('./views/Settings').then(m => ({ default: m.Settings })));


interface ErrorBoundaryProps { children: ComponentChildren; }
interface ErrorBoundaryState { error: Error | null; }

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div class="error-boundary">
          <div class="error-boundary-box">
            <div class="error-boundary-icon">⚠</div>
            <h2>Something went wrong</h2>
            <p class="error-boundary-msg">{this.state.error.message}</p>
            <button class="error-boundary-btn" onClick={() => { this.setState({ error: null }); window.location.hash = '/'; }}>
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const NavButton = ({
  href,
  label,
  icon: Icon,
  onClick,
}: {
  href?: string;
  label: string;
  icon: any;
  onClick?: () => void;
}) => {
  const [location] = useHashLocation();
  const active = href ? location === href || (href !== '/' && (location.startsWith(href) || (href === '/projects' && location.startsWith('/project/')))) : false;
  return (
    <button
      class={`nav-btn ${active ? 'active' : ''}`}
      onClick={href ? () => navigate(href) : onClick}
    >
      <Icon width={16} height={16} class="icon" />
      <span>{label}</span>
    </button>
  );
};

function navigate(href: string): void {
  window.location.hash = href;
}

/**
 * Visible only while the Providers page is unlocked: shows the remaining
 * unlock time and offers an instant re-lock. Syncs across tabs via the
 * storage event on the unlock key.
 */
function ProvidersUnlockBadge() {
  const [mins, setMins] = useState<number | null>(null);
  const [askRelock, setAskRelock] = useState(false);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const { enabled } = await getProvidersLockStatus();
        if (!alive) return;
        if (!enabled) { setMins(null); return; }
        const unlock = getProvidersUnlock();
        if (!unlock) { setMins(null); return; }
        setMins(Math.max(0, Math.ceil((unlock.expiresAt - Date.now()) / 60_000)));
      } catch {
        if (alive) setMins(null);
      }
    };
    refresh();
    const timer = setInterval(refresh, 30_000);
    const onStorage = (e: StorageEvent) => {
      if (e.key === UNLOCK_KEY) refresh();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  if (mins === null) return null;

  const relock = () => setAskRelock(true);

  const runRelock = async () => {
    try { await relockProviders(); } catch { /* ignore — local clear still applies */ }
    clearProvidersUnlock();
    setMins(null);
  };

  return (
    <>
      <button class="unlock-badge" title="Providers page is unlocked — click to re-lock" onClick={relock}>
        <Unlock width={11} height={11} />
        <span>Providers · {mins}m</span>
      </button>
      <ConfirmModal
        open={askRelock}
        title="Re-lock Providers now?"
        message="Every open tab loses access to the Providers page immediately."
        confirmLabel="Lock now"
        onConfirm={runRelock}
        onCancel={() => setAskRelock(false)}
      />
    </>
  );
}

function Sidebar() {
  const { user } = useAuth();
  return (
    <aside class="sidebar">
      <div class="sidebar-brand">
        <div class="brand-mark"><img class="brand-logo" src="/logo.png" alt="WSD-Pro" /></div>
        <div class="brand-text">
          <span class="brand-name">WSD-Pro</span>
          <span class="brand-tag">workspace dev</span>
        </div>
      </div>
      <nav class="sidebar-nav">
        <NavButton href="/" label="Dashboard" icon={LayoutDashboard} />
        <NavButton href="/projects" label="Projects" icon={FolderOpen} />
        <NavButton href="/agents" label="Agents" icon={Bot} />
        <NavButton href="/opencode" label="opencode" icon={SquareTerminal} />
        <NavButton href="/providers" label="Providers" icon={KeyRound} />
        <NavButton href="/settings" label="Settings" icon={SettingsIcon} />
        <NavButton href="/ide" label="Web IDE" icon={Code2} />
      </nav>
      <div class="sidebar-footer">
        <ProvidersUnlockBadge />
        <div class="sys-row">
          <span class="sys-dot ok" />
          {user?.username || 'authenticated'}
          <span class="beta-chip" title="Beta software — features and data format may change">BETA</span>
        </div>
      </div>
    </aside>
  );
}

function Shell() {
  const [location] = useHashLocation();
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div class="app-view" style="display:flex;align-items:center;justify-content:center;height:100vh;">
        <div class="dim" style="font-size:0.85rem">Loading…</div>
      </div>
    );
  }

  // Not logged in → redirect to login
  if (!user) {
    if (location === '/login') return <Login />;
    window.location.hash = '/login';
    return null;
  }

  // Logged in, but on /login → redirect to home
  if (location === '/login') {
    window.location.hash = '/';
    return null;
  }

  if (location.startsWith('/opencode')) {
    return <Suspense fallback={<div class="app-view" style="display:flex;align-items:center;justify-content:center;height:100vh;"><div class="dim" style="font-size:0.85rem">Loading…</div></div>}><Opencode /></Suspense>;
  }

  if (location.startsWith('/agents')) {
    return <Suspense fallback={<div class="app-view" style="display:flex;align-items:center;justify-content:center;height:100vh;"><div class="dim" style="font-size:0.85rem">Loading…</div></div>}><Agents /></Suspense>;
  }

  if (location.startsWith('/ide')) {
    return <Suspense fallback={<div class="app-view" style="display:flex;align-items:center;justify-content:center;height:100vh;"><div class="dim" style="font-size:0.85rem">Loading…</div></div>}><EmbeddedIDE /></Suspense>;
  }

  return (
    <div class="app-view">
      <Sidebar />
      <main class="main">
        <Suspense fallback={<div style="display:flex;align-items:center;justify-content:center;height:100%;"><div class="dim" style="font-size:0.85rem">Loading…</div></div>}>
          <Route path="/" component={Dashboard} />
          <Route path="/projects" component={Projects} />
          <Route path="/project/:slug" component={Project} />
          <Route path="/providers" component={Providers} />
          <Route path="/settings" component={Settings} />
        </Suspense>
      </main>
    </div>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <Router hook={useHashLocation}>
          <Shell />
          <div class="watermark" aria-hidden="true">
            <img src="/logo.png" alt="" />
          </div>
        </Router>
      </AuthProvider>
    </ErrorBoundary>
  );
}
