import { Component, type ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Router, Route } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { AuthProvider, useAuth } from './auth';
import { getTheme, toggleTheme } from './theme';
import { Login } from './views/Login';
import { Dashboard } from './views/Dashboard';
import { Projects } from './views/Projects';
import { Project } from './views/Project';
import { Opencode } from './views/Opencode';
import { Agents } from './views/Agents';
import { EmbeddedIDE } from './views/EmbeddedIDE';
import { Providers } from './views/Providers';
import { Settings } from './views/Settings';


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
  icon,
  onClick,
}: {
  href?: string;
  label: string;
  icon: string;
  onClick?: () => void;
}) => {
  const [location] = useHashLocation();
  const active = href ? location === href || (href !== '/' && (location.startsWith(href) || (href === '/projects' && location.startsWith('/project/')))) : false;
  return (
    <button
      class={`nav-btn ${active ? 'active' : ''}`}
      onClick={href ? () => navigate(href) : onClick}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
        <text x="0" y="13" font-size="11">{icon}</text>
      </svg>
      <span>{label}</span>
    </button>
  );
};

function navigate(href: string): void {
  window.location.hash = href;
}

function Sidebar() {
  const { user } = useAuth();
  const [, force] = useState(0);
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
        <NavButton href="/" label="Dashboard" icon="◈" />
        <NavButton href="/projects" label="Projects" icon="📁" />
        <NavButton href="/agents" label="Agents" icon="🤖" />
        <NavButton href="/opencode" label="opencode" icon="⌁" />
        <NavButton href="/providers" label="Providers" icon="🔑" />
        <NavButton href="/settings" label="Settings" icon="⚙" />
        <NavButton href="/ide" label="Web IDE" icon="▦" />
      </nav>
      <div class="sidebar-footer">
        <button
          class="theme-toggle"
          title={getTheme() === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
          onClick={() => { toggleTheme(); force((n: number) => n + 1); }}
        >
          {getTheme() === 'light' ? '🌙' : '☀️'}
        </button>
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
    return <Opencode />;
  }

  if (location.startsWith('/agents')) {
    return <Agents />;
  }

  if (location.startsWith('/ide')) {
    return <EmbeddedIDE />;
  }

  return (
    <div class="app-view">
      <Sidebar />
      <main class="main">
        <Route path="/" component={Dashboard} />
        <Route path="/projects" component={Projects} />
        <Route path="/project/:slug" component={Project} />
        <Route path="/providers" component={Providers} />
        <Route path="/settings" component={Settings} />
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
