import { Component, type ComponentChildren } from 'preact';
import { Router, Route } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { Dashboard } from './views/Dashboard';
import { Project } from './views/Project';
import { Chat } from './views/Chat';
import { Opencode } from './views/Opencode';
import { Antigravity } from './views/Antigravity';
import { AntigravitySettings } from './views/AntigravitySettings';
import { EmbeddedIDE } from './views/EmbeddedIDE';
import { Providers } from './views/Providers';

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
  const active = href ? location === href || (href !== '/' && location.startsWith(href)) : false;
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
        <NavButton href="/chat" label="Chat & Design" icon="✎" />
        <NavButton href="/opencode" label="opencode" icon="⌁" />
        <NavButton href="/antigravity" label="Antigravity" icon="✦" />
        <NavButton href="/providers" label="Providers" icon="🔑" />
        <NavButton href="/ide" label="Web IDE" icon="▦" />
      </nav>
      <div class="sidebar-footer">
        <div class="sys-row">
          <span class="sys-dot ok" />
          open · no login
        </div>
      </div>
    </aside>
  );
}

function Shell() {
  const [location] = useHashLocation();

  if (location.startsWith('/opencode')) {
    return <Opencode />;
  }

  if (location.startsWith('/antigravity/settings')) {
    return <AntigravitySettings />;
  }

  if (location.startsWith('/antigravity')) {
    return <Antigravity />;
  }

  if (location.startsWith('/ide')) {
    return <EmbeddedIDE />;
  }

  return (
    <div class="app-view">
      <Sidebar />
      <main class="main">
        <Route path="/" component={Dashboard} />
        <Route path="/project/:slug" component={Project} />
        <Route path="/chat" component={Chat} />
        <Route path="/providers" component={Providers} />
      </main>
    </div>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <Router hook={useHashLocation}>
        <Shell />
        <div class="watermark" aria-hidden="true">
          <img src="/logo.png" alt="" />
        </div>
      </Router>
    </ErrorBoundary>
  );
}
