import { useState } from 'preact/hooks';
import { Router, Route } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { Dashboard } from './views/Dashboard';
import { Project } from './views/Project';
import { Chat } from './views/Chat';
import { getIdeStatus, IdeStatus } from './api';

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
  const [ide, setIde] = useState<IdeStatus | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [copied, setCopied] = useState(false);

  const openIdeDialog = () => {
    void getIdeStatus()
      .then(({ ide }) => setIde(ide))
      .catch(() => setIde(null));
    setShowDialog(true);
  };

  const copyPassword = () => {
    if (!ide) return;
    navigator.clipboard.writeText(ide.password).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const ideUrl = ide ? `http://${window.location.hostname}:${ide.port}` : '#';

  return (
    <>
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
          <NavButton label="Web IDE" icon="▦" onClick={openIdeDialog} />
        </nav>
        <div class="sidebar-footer">
          <div class="sys-row">
            <span class="sys-dot ok" />
            open · no login
          </div>
        </div>
      </aside>

      {showDialog && (
        <div class="modal-overlay" onClick={() => setShowDialog(false)}>
          <div class="modal-card" onClick={(e) => e.stopPropagation()}>
            <div class="modal-title">Web IDE</div>
            <div class="kv-list">
              <div class="kv">
                <span>Status</span>
                <b style={`color: ${ide?.running ? 'var(--green)' : 'var(--red)'}`}>
                  {ide?.running ? 'running' : 'stopped'}
                </b>
              </div>
              <div class="kv">
                <span>Address</span>
                <b class="mono">{ideUrl}</b>
              </div>
              <div class="kv">
                <span>Password</span>
                <b class="mono">{ide?.password || '…'}</b>
              </div>
            </div>
            <div style="display: flex; gap: 8px; margin-top: 18px; justify-content: flex-end">
              <button class="btn-ghost sm" onClick={copyPassword}>
                {copied ? 'Copied ✓' : 'Copy password'}
              </button>
              <a class="btn-primary sm" href={ideUrl} target="_blank" rel="noreferrer">
                Open IDE
              </a>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function App() {
  return (
    <Router hook={useHashLocation}>
      <div class="app-view">
        <Sidebar />
        <main class="main">
          <Route path="/" component={Dashboard} />
          <Route path="/project/:slug" component={Project} />
          <Route path="/chat" component={Chat} />
        </main>
      </div>
    </Router>
  );
}
