import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { Router, Route, useLocation } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';

// Temporarily import basic components
const Sidebar = () => (
  <aside class="sidebar">
    <div class="sidebar-brand">
      <div class="brand-mark">W</div>
      <div>
        <span class="brand-name">WSD-Pro</span>
      </div>
    </div>
  </aside>
);

const AuthView = () => (
  <div class="auth-view">
    <div class="auth-card">
      <div class="auth-title">Login</div>
    </div>
  </div>
);

const ProjectsView = () => (
  <div class="view">
    <div class="hero">
      <h1 class="hero-title">Projects</h1>
    </div>
  </div>
);

export function App() {
  const [location] = useHashLocation();
  
  return (
    <Router hook={useHashLocation}>
      <div class="app-view">
        {location !== '/login' && <Sidebar />}
        <main class="main">
          <Route path="/login" component={AuthView} />
          <Route path="/" component={ProjectsView} />
          <Route path="/projects" component={ProjectsView} />
        </main>
      </div>
    </Router>
  );
}
