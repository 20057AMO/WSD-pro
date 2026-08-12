/* ═══════════════════════════════════════════════════════
   WSD-Pro frontend — professional UI (Remote-inspired)
   Vanilla JS · hash routing · no dependencies
   ═══════════════════════════════════════════════════════ */

const API = '';
let TOKEN = localStorage.getItem('wsd_token') || '';
let currentProject = null;
let currentFileDir = '.';
let currentFileStack = ['.'];
let activeAgent = null;
let agentPollTimer = null;
let projectsCache = [];

/* ── Helpers ── */
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  const res = await fetch(API + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function el(id) { return document.getElementById(id); }

/* ── Preloader ── */
window.addEventListener('load', () => {
  setTimeout(() => {
    el('preloader').classList.add('fade-out');
    setTimeout(() => { el('preloader').style.display = 'none'; }, 500);
  }, 400);
});

/* ── Auth ── */
el('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = el('loginError');
  errEl.textContent = '';
  try {
    const user = el('loginUser').value.trim();
    const pass = el('loginPass').value;
    if (!user || !pass) { errEl.textContent = 'Enter username and password'; return; }
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: user, password: pass }),
    });
    TOKEN = res.token;
    localStorage.setItem('wsd_token', TOKEN);
    enterApp();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

function logout() {
  TOKEN = '';
  localStorage.removeItem('wsd_token');
  el('appView').style.display = 'none';
  el('authView').style.display = 'flex';
  el('loginPass').value = '';
  el('loginError').textContent = '';
  if (agentPollTimer) clearInterval(agentPollTimer);
  currentProject = null;
  location.hash = '#/login';
}

async function enterApp() {
  el('authView').style.display = 'none';
  el('appView').style.display = 'flex';
  await refreshSystemStatus();
  if (!location.hash || location.hash === '#/login') location.hash = '#/projects';
  route();
  await loadProjects();
}

/* ── System status (sidebar) ── */
async function refreshSystemStatus() {
  try {
    const h = await api('/api/health');
    el('sysDot').className = 'sys-dot ok';
    el('sysLabel').textContent = `online · v${h.version}`;
  } catch {
    el('sysDot').className = 'sys-dot bad';
    el('sysLabel').textContent = 'offline';
  }
}

/* ── Routing ── */
function route() {
  const hash = location.hash || '#/projects';
  // hide all views
  ['viewProjects', 'viewProject', 'viewAgents'].forEach(id => { el(id).style.display = 'none'; });
  // nav active state
  ['navProjects', 'navAgents'].forEach(id => el(id).classList.remove('active'));

  if (hash.startsWith('#/project/')) {
    const slug = decodeURIComponent(hash.split('/')[2]);
    el('viewProject').style.display = 'block';
    openDetail(slug);
  } else if (hash.startsWith('#/agents')) {
    el('viewAgents').style.display = 'block';
    el('navAgents').classList.add('active');
    loadAgents();
    populateAgentProjects();
  } else {
    el('viewProjects').style.display = 'block';
    el('navProjects').classList.add('active');
    renderProjects(projectsCache);
  }
}

function nav(name) {
  if (name === 'projects') location.hash = '#/projects';
  else if (name === 'agents') location.hash = '#/agents';
  else if (name.startsWith('project/')) location.hash = '#/' + name;
  else return;
  route();
}

window.addEventListener('hashchange', route);

/* ── Projects ── */
async function loadProjects() {
  try {
    const { projects } = await api('/api/projects');
    projectsCache = projects || [];
    renderProjects(projectsCache);
  } catch (err) {
    if (/token|401|unauthorized/i.test(err.message)) logout();
  }
}

function renderProjects(projects) {
  const grid = el('projectsGrid');
  el('projectCount').textContent = projects.length;
  if (!projects.length) {
    grid.innerHTML = `<div class="empty-state"><div class="big">⬡</div>No workspaces yet.<br/><span style="font-size:0.78rem;color:var(--text-3)">Create your first project above — it gets its own container instantly.</span></div>`;
    return;
  }
  grid.innerHTML = projects.map(p => {
    const ports = Object.entries(p.hostPorts || {}).map(([k, v]) => `<span class="meta-chip port">:${esc(k)}</span>`).join('') || '<span class="meta-chip">no ports</span>';
    return `
    <div class="project-card" onclick="nav('project/${esc(p.slug)}')">
      <div class="project-card-header">
        <h3>${esc(p.name)}</h3>
        <span class="status-badge ${esc(p.status)}">${esc(p.status)}</span>
      </div>
      <p class="project-desc">${p.description ? esc(p.description) : 'Docker-isolated workspace for AI agents.'}</p>
      <div class="project-meta">
        <span class="meta-chip">${esc(p.slug)}</span>
        ${ports}
      </div>
      <div class="card-footer">
        <button class="btn-ghost sm" onclick="event.stopPropagation();nav('project/${esc(p.slug)}')">Open ▸</button>
        ${Object.keys(p.hostPorts || {}).length ? `<button class="btn-ghost sm" onclick="event.stopPropagation();openAppLink('${esc(p.slug)}')">🌐 App</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function openAppLink(slug) {
  const p = projectsCache.find(x => x.slug === slug);
  if (!p) return;
  const firstPort = Object.keys(p.hostPorts || {})[0];
  if (!firstPort) return;
  window.open(`http://192.168.0.110:${firstPort}`, '_blank');
}

async function createProject() {
  const nameEl = el('newProjectName');
  const portsEl = el('newProjectPorts');
  const name = nameEl.value.trim();
  if (!name) { nameEl.focus(); return; }
  const ports = portsEl.value.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0 && n < 65536);
  try {
    await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, description: 'Docker-isolated workspace for AI agents.', ports }),
    });
    nameEl.value = '';
    portsEl.value = '';
    await loadProjects();
  } catch (err) {
    alert('Create failed: ' + err.message);
  }
}

/* ── Project detail ── */
async function openDetail(slug) {
  try {
    const data = await api(`/api/projects/${slug}`);
    const p = data.project || data;
    currentProject = p;
    renderDetail(p);
  } catch (err) {
    alert('Could not load project: ' + err.message);
    nav('projects');
  }
}

function renderDetail(p) {
  el('detailAvatar').textContent = (p.name || 'P')[0].toUpperCase();
  el('detailName').textContent = p.name;
  el('detailStatus').className = 'status-badge ' + esc(p.status);
  el('detailStatus').textContent = p.status;
  el('detailSlug').textContent = 'wsd-' + p.slug;
  el('detailContainerId').textContent = (p.containerId || '').slice(0, 12);
  el('ovStatus').textContent = p.status;
  el('ovCid').textContent = (p.containerId || '—').slice(0, 19);

  // Ports
  const ports = Object.entries(p.hostPorts || {});
  const portLinks = el('detailPortLinks');
  portLinks.innerHTML = ports.map(([containerPort, hostPort]) =>
    `<a class="btn-ghost sm" href="http://192.168.0.110:${esc(hostPort)}" target="_blank" title="Open app on port ${esc(hostPort)}">🌐 :${esc(hostPort)}</a>`
  ).join('');

  const ovPorts = el('ovPorts');
  ovPorts.innerHTML = ports.length ? ports.map(([c, h]) => `
    <a class="port-link" href="http://192.168.0.110:${esc(h)}" target="_blank">
      <span><span class="p-label">host</span> :${esc(h)}</span>
      <span><span class="p-label">→ container</span> <span class="p-val">:${esc(c)}</span></span>
    </a>`).join('') : '<div style="color:var(--text-3);font-size:0.78rem;">No ports published for this project.</div>';

  el('detailToggleBtn').textContent = p.status === 'running' ? '■ Stop' : '▶ Start';
  el('detailToggleBtn').classList.toggle('btn-danger', p.status === 'running');

  // Reset tabs & terminal
  showTab('overview');
  el('terminalOutput').innerHTML = '<div class="terminal-line dim">WSD-Pro terminal — workspace /workspace</div>';
  currentFileDir = '.';
  currentFileStack = ['.'];
  el('fileNav').innerHTML = '<span class="file-path">/workspace</span>';
}

async function toggleProject() {
  if (!currentProject) return;
  try {
    const data = await api(`/api/projects/${currentProject.slug}/${currentProject.status === 'running' ? 'stop' : 'start'}`, { method: 'POST' });
    const p = data.project || data;
    currentProject = p;
    renderDetail(p);
    await loadProjects();
  } catch (err) {
    alert('Action failed: ' + err.message);
  }
}

async function deleteProject() {
  if (!currentProject) return;
  if (!confirm(`Delete project "${currentProject.name}" and its container? This cannot be undone.`)) return;
  try {
    await api(`/api/projects/${currentProject.slug}`, { method: 'DELETE' });
    await loadProjects();
    nav('projects');
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

/* ── Tabs ── */
function showTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  const btn = document.querySelector(`.tab-btn[data-tab="${name}"]`);
  if (btn) btn.classList.add('active');
  const pane = el('tab' + name.charAt(0).toUpperCase() + name.slice(1));
  if (pane) pane.classList.add('active');
  if (name === 'terminal') el('terminalInput').focus();
  if (name === 'files') loadFiles();
  if (name === 'logs') loadLogs();
}

/* ── Terminal ── */
el('terminalInput').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const input = el('terminalInput');
  const cmd = input.value.trim();
  if (!cmd || !currentProject) return;
  input.value = '';
  appendTermLine('$ ' + cmd, 't-cmd');
  try {
    const { output, exitCode } = await api(`/api/projects/${currentProject.slug}/exec`, {
      method: 'POST',
      body: JSON.stringify({ cmd: ['bash', '-c', cmd] }),
    });
    if (output && output.trim()) appendTermLine(output, exitCode === 0 ? 't-out' : 't-err');
    appendTermLine(`[exit ${exitCode}]`, exitCode === 0 ? 't-ok' : 't-err');
  } catch (err) {
    appendTermLine('error: ' + err.message, 't-err');
  }
  el('terminalOutput').scrollTop = el('terminalOutput').scrollHeight;
});

function appendTermLine(text, cls = '') {
  const box = el('terminalOutput');
  const div = document.createElement('div');
  div.className = 'terminal-line ' + cls;
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

/* ── Files ── */
async function loadFiles() {
  if (!currentProject) return;
  try {
    const data = await api(`/api/projects/${currentProject.slug}/files?path=${encodeURIComponent(currentFileDir)}`);
    const rel = currentFileDir === '.' ? '' : '/' + currentFileDir;
    el('fileNav').innerHTML = `<button class="file-nav-btn" onclick="upDir()">⬆ up</button><span class="file-path">/workspace${rel}</span>`;
    const list = el('fileList');
    if (data.entries) {
      list.innerHTML = data.entries.map(f => `
        <div class="file-item ${f.type}" onclick="openFile('${f.type}', '${esc(f.name).replace(/'/g, "\\'")}')">
          <span class="f-icon">${f.type === 'dir' ? '📁' : '📄'}</span>
          <span class="f-name">${esc(f.name)}</span>
          <span class="f-size">${f.type === 'file' ? humanSize(f.size) : ''}</span>
          <span style="color:var(--text-3);font-size:0.68rem;">open →</span>
        </div>`).join('') || '<div style="color:var(--text-3);padding:20px;text-align:center;">Empty directory</div>';
    } else if (data.content !== undefined) {
      list.innerHTML = `<div class="file-content">${esc(data.content)}</div>`;
    }
  } catch (err) {
    el('fileList').innerHTML = `<div style="color:var(--red);padding:20px;">${esc(err.message)}</div>`;
  }
}

function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function openFile(type, name) {
  if (!currentProject) return;
  currentFileStack.push(currentFileDir);
  currentFileDir = currentFileDir === '.' ? name : currentFileDir + '/' + name;
  loadFiles();
}

function upDir() {
  if (currentFileStack.length > 1) {
    currentFileDir = currentFileStack.pop();
  } else {
    currentFileDir = '.';
    currentFileStack = ['.'];
  }
  loadFiles();
}

/* ── Logs ── */
async function loadLogs() {
  if (!currentProject) return;
  try {
    const { logs } = await api(`/api/projects/${currentProject.slug}/logs?tail=100`);
    el('logsBox').textContent = logs || '(no logs yet)';
  } catch (err) {
    el('logsBox').textContent = 'error: ' + err.message;
  }
}

/* ── Agents ── */
async function loadAgents() {
  try {
    const { agents } = await api('/api/agents');
    const grid = el('agentsGrid');
    grid.innerHTML = agents.map(a => `
      <div class="agent-card ${activeAgent === a.name ? 'active' : ''}" id="agentCard-${a.name}" onclick="openAgentChat('${a.name}')">
        <div class="agent-head">
          <div class="agent-avatar" style="background:${a.color}1f;color:${a.color};border:1px solid ${a.color}44">${a.displayName[0]}</div>
          <div>
            <h3>${esc(a.displayName)}</h3>
            <span class="agent-status ${a.auth.ok ? 'ok' : 'bad'}">${a.auth.ok ? '● connected' : '○ ' + esc(a.auth.detail || 'not connected')}</span>
          </div>
        </div>
        <p class="agent-desc">${esc(a.description)}</p>
        <div class="agent-actions">
          <button class="btn-ghost sm" onclick="event.stopPropagation();openAgentChat('${a.name}')">💬 Chat</button>
          <button class="btn-ghost sm" onclick="event.stopPropagation();agentAuth('${a.name}')">Auth</button>
        </div>
      </div>`).join('');
    // auto-open chat for first agent
    if (!activeAgent && agents.length) openAgentChat(agents[0].name);
  } catch (err) {
    el('agentsGrid').innerHTML = `<div style="color:var(--red);padding:20px;">${esc(err.message)}</div>`;
  }
}

async function agentAuth(name) {
  try {
    const { agents } = await api('/api/agents');
    const a = agents.find(x => x.name === name);
    alert(`${a.displayName}: ${a.auth.ok ? '✅ Connected' : '❌ ' + a.auth.detail}`);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

function openAgentChat(name) {
  activeAgent = name;
  document.querySelectorAll('.agent-card').forEach(c => c.classList.remove('active'));
  const card = el('agentCard-' + name);
  if (card) card.classList.add('active');
  el('agentChatTitle').textContent = name.charAt(0).toUpperCase() + name.slice(1) + ' — chat';
  el('agentChatBody').innerHTML = `<div class="chat-msg system">Agent <b>${esc(name)}</b> ready. Pick a project, describe the task, and the agent will work inside the container.</div>`;
  loadAgentTasks();
  if (agentPollTimer) clearInterval(agentPollTimer);
  agentPollTimer = setInterval(loadAgentTasks, 4000);
}

async function loadAgentTasks() {
  const list = el('agentTaskList');
  if (!list) return;
  try {
    const { tasks } = await api('/api/agents/tasks');
    const recent = tasks.slice(0, 8);
    if (!recent.length) {
      list.innerHTML = '<div class="chat-msg system">No tasks yet — send your first prompt.</div>';
      return;
    }
    list.innerHTML = recent.map(t => `
      <div class="task-item ${esc(t.status)}">
        <div class="task-head">
          <span class="task-agent" style="color:var(--text)">${esc(t.agent)}</span>
          <span class="task-status">${esc(t.status)}</span>
          <span class="task-project">${esc(t.project)}</span>
          ${t.status === 'running' || t.status === 'queued' ? `<button class="btn-ghost sm" onclick="stopAgentTask('${t.id}')">■ Stop</button>` : ''}
        </div>
        <div class="task-prompt">${esc(t.prompt)}</div>
        <details class="task-output"><summary>output · ${(t.output || '').length} chars</summary><pre>${esc((t.output || t.error || '').slice(-4000))}</pre></details>
      </div>`).join('');
  } catch { /* transient */ }
}

async function stopAgentTask(id) {
  try {
    await api(`/api/agents/tasks/${id}/stop`, { method: 'POST' });
    loadAgentTasks();
  } catch { /* ignore */ }
}

async function sendAgentPrompt() {
  const input = el('agentPrompt');
  const projectSel = el('agentProjectSel');
  const prompt = input.value.trim();
  const project = projectSel.value;
  if (!prompt) return;
  if (!activeAgent) { alert('Select an agent first'); return; }
  if (!project) { alert('Select a project first'); return; }
  input.value = '';
  const body = el('agentChatBody');
  body.insertAdjacentHTML('beforeend', `<div class="chat-msg user"><span><b>You → ${esc(activeAgent)}</b> · ${esc(project)}</span><div>${esc(prompt)}</div></div>`);
  body.scrollTop = body.scrollHeight;
  try {
    const { task } = await api(`/api/agents/${activeAgent}/run`, {
      method: 'POST',
      body: JSON.stringify({ project, prompt }),
    });
    body.insertAdjacentHTML('beforeend', `<div class="chat-msg system">⚙️ Task <b>${esc(task.id)}</b> queued — <span class="task-status">${esc(task.status)}</span></div>`);
    body.scrollTop = body.scrollHeight;
    loadAgentTasks();
  } catch (err) {
    body.insertAdjacentHTML('beforeend', `<div class="chat-msg system err">❌ ${esc(err.message)}</div>`);
  }
}

el('agentPrompt').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAgentPrompt(); });

async function populateAgentProjects() {
  try {
    const { projects } = await api('/api/projects');
    el('agentProjectSel').innerHTML = `<option value="">— project —</option>` +
      projects.map(p => `<option value="${p.slug}">${esc(p.name)} · ${esc(p.status)}</option>`).join('');
  } catch { /* ignore */ }
}

function runAgentHere() {
  if (!currentProject) return;
  nav('agents');
  setTimeout(() => {
    const sel = el('agentProjectSel');
    if (sel) sel.value = currentProject.slug;
  }, 300);
}

/* ── Boot ── */
(async function boot() {
  if (TOKEN) {
    try {
      await api('/api/auth/status');
      await enterApp();
      return;
    } catch {
      logout();
    }
  }
  el('authView').style.display = 'flex';
})();
