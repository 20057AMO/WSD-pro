import { Router, Route } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { Dashboard } from './views/Dashboard';
import { Project } from './views/Project';
import { Chat } from './views/Chat';
import { Opencode } from './views/Opencode';
import { Providers } from './views/Providers';
import { getIdeStatus } from './api';

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
  const openIde = () => {
    void getIdeStatus()
      .then(({ ide }) => {
        if (ide.running) {
          window.open(`http://${window.location.hostname}:${ide.port}`, '_blank');
        } else {
          alert('Web IDE is not running yet.');
        }
      })
      .catch(() => alert('Could not reach the Web IDE.'));
  };

  return (
    <aside class="sidebar">
      <div class="sidebar-brand">
        <div class="brand-mark">W</div>
        <div class="brand-text">
          <span class="brand-name">WSD-Pro</span>
          <span class="brand-tag">workspace dev</span>
        </div>
      </div>
      <nav class="sidebar-nav">
        <NavButton href="/" label="Dashboard" icon="◈" />
        <NavButton href="/chat" label="Chat & Design" icon="✎" />
        <NavButton href="/opencode" label="opencode" icon="⌁" />
        <NavButton href="/providers" label="Providers" icon="🔑" />
        <NavButton label="Web IDE" icon="▦" onClick={openIde} />
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
    <Router hook={useHashLocation}>
      <Shell />
    </Router>
  );
}
