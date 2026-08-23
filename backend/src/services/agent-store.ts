import fs from 'fs';
import path from 'path';
import { chatStore, type ChatEvent, type ChatAttachment } from './chat-store';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const AGENTS_FILE = path.join(DATA_DIR, 'agents.json');

export interface Agent {
  id: string;
  name: string;
  icon: string;
  description: string;
  systemPrompt: string;
  provider?: string;
  model?: string;
  enabled: boolean;
  toolsEnabled: boolean;
}

export interface AgentSession {
  chatId: string;
  agentId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

let agentsCache: Agent[] | null = null;

const DEFAULT_AGENTS: Agent[] = [
  {
    id: 'general',
    name: 'General Chat',
    icon: '💬',
    description: 'General-purpose chat assistant for ideas, questions, and discussion',
    systemPrompt:
      'You are a helpful, friendly assistant. Answer questions, discuss ideas, help with planning, and have natural conversations. Be concise and clear. Use markdown when helpful.',
    enabled: true,
    toolsEnabled: false,
  },
  {
    id: 'planner',
    name: 'Planner',
    icon: '📐',
    description: 'Plan project architecture, tech stack, and implementation steps',
    systemPrompt:
      'You are a senior software architect. Help users plan project structure, choose tech stacks, and break down features into implementation steps. Focus on architecture decisions, data flow, and component design. Do NOT write code — describe what should be built and how.',
    enabled: true,
    toolsEnabled: true,
  },
  {
    id: 'coder',
    name: 'Coder',
    icon: '⚡',
    description: 'Write code and implement features',
    systemPrompt:
      'You are an expert developer. Write clean, minimal code following the project\'s existing patterns and conventions. Always verify your changes with build commands. Keep changes focused — do not refactor unrelated code. Place files in the correct directories based on the project structure.',
    enabled: true,
    toolsEnabled: true,
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    icon: '🔍',
    description: 'Review code for bugs, performance, and security issues',
    systemPrompt:
      'You are a senior code reviewer. Analyze code for bugs, performance issues, security vulnerabilities, and maintainability. Reference specific files and line numbers. Suggest concrete improvements. Be thorough but practical — prioritize critical issues.',
    enabled: true,
    toolsEnabled: true,
  },
  {
    id: 'devops',
    name: 'DevOps',
    icon: '🐳',
    description: 'Docker, deployment, CI/CD, and infrastructure',
    systemPrompt:
      'You are a DevOps engineer. Handle Docker configuration, deployment pipelines, CI/CD setup, server configuration, and infrastructure tasks. Write Dockerfiles, docker-compose configs, shell scripts, and deployment configs. Always verify with the appropriate build/run commands.',
    enabled: true,
    toolsEnabled: true,
  },
  {
    id: 'debugger',
    name: 'Debugger',
    icon: '🐛',
    description: 'Analyze errors, logs, and fix bugs',
    systemPrompt:
      'You are a debugging specialist. Analyze error messages, stack traces, and logs to find root causes. Ask clarifying questions when needed. Provide targeted fixes that address the actual problem. Check related code for similar issues.',
    enabled: true,
    toolsEnabled: true,
  },
];

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAgents(): Agent[] {
  if (agentsCache) return agentsCache;
  ensureDataDir();
  if (fs.existsSync(AGENTS_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
      agentsCache = Array.isArray(raw) ? raw : DEFAULT_AGENTS;
    } catch {
      agentsCache = [...DEFAULT_AGENTS];
    }
  } else {
    agentsCache = [...DEFAULT_AGENTS];
    saveAgents(agentsCache);
  }
  return agentsCache;
}

function saveAgents(agents: Agent[]): void {
  ensureDataDir();
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2), 'utf8');
  agentsCache = agents;
}

function genId(): string {
  return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function listAgents(): Agent[] {
  return loadAgents().filter((a) => a.enabled);
}

export function listAllAgents(): Agent[] {
  return loadAgents();
}

export function getAgent(id: string): Agent | undefined {
  return loadAgents().find((a) => a.id === id);
}

export function createAgent(patch: Partial<Omit<Agent, 'id'>>): Agent {
  const agents = loadAgents();
  const agent: Agent = {
    id: genId(),
    name: patch.name || 'New Agent',
    icon: patch.icon || '🤖',
    description: patch.description || '',
    systemPrompt: patch.systemPrompt || 'You are a helpful assistant.',
    provider: patch.provider,
    model: patch.model,
    enabled: patch.enabled ?? true,
    toolsEnabled: patch.toolsEnabled ?? false,
  };
  agents.push(agent);
  saveAgents(agents);
  return agent;
}

export function updateAgent(id: string, patch: Partial<Omit<Agent, 'id'>>): Agent | null {
  const agents = loadAgents();
  const idx = agents.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  agents[idx] = { ...agents[idx], ...patch, id };
  saveAgents(agents);
  return agents[idx];
}

export function deleteAgent(id: string): boolean {
  const agents = loadAgents();
  const idx = agents.findIndex((a) => a.id === id);
  if (idx === -1) return false;
  agents.splice(idx, 1);
  saveAgents(agents);
  return true;
}

const sessionsFile = path.join(DATA_DIR, 'agent-sessions.json');
let sessionsCache: AgentSession[] | null = null;

function loadSessions(): AgentSession[] {
  if (sessionsCache) return sessionsCache;
  ensureDataDir();
  if (fs.existsSync(sessionsFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
      sessionsCache = Array.isArray(raw) ? raw : [];
    } catch {
      sessionsCache = [];
    }
  } else {
    sessionsCache = [];
  }
  return sessionsCache;
}

function saveSessions(sessions: AgentSession[]): void {
  ensureDataDir();
  fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2), 'utf8');
  sessionsCache = sessions;
}

export function listAgentSessions(agentId: string): AgentSession[] {
  return loadSessions()
    .filter((s) => s.agentId === agentId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function createAgentSession(agentId: string, name?: string): AgentSession {
  const sessions = loadSessions();
  const chatId = `agent-${Date.now()}`;
  const session: AgentSession = {
    chatId,
    agentId,
    name: name || `Session ${new Date().toLocaleTimeString()}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: 0,
  };
  sessions.push(session);
  saveSessions(sessions);
  return session;
}

export function deleteAgentSession(agentId: string, chatId: string): boolean {
  const sessions = loadSessions();
  const idx = sessions.findIndex((s) => s.agentId === agentId && s.chatId === chatId);
  if (idx === -1) return false;
  sessions.splice(idx, 1);
  saveSessions(sessions);
  return true;
}

export function touchAgentSession(agentId: string, chatId: string, increment = false): AgentSession | null {
  const sessions = loadSessions();
  const s = sessions.find((x) => x.agentId === agentId && x.chatId === chatId);
  if (s) {
    s.updatedAt = new Date().toISOString();
    if (increment) s.messageCount += 1;
    saveSessions(sessions);
  }
  return s || null;
}

export function renameAgentSession(agentId: string, chatId: string, name: string): AgentSession | null {
  const sessions = loadSessions();
  const s = sessions.find((x) => x.agentId === agentId && x.chatId === chatId);
  if (!s) return null;
  s.name = name;
  s.updatedAt = new Date().toISOString();
  saveSessions(sessions);
  return s;
}

export function readAgentEvents(agentId: string, chatId: string): ChatEvent[] {
  return chatStore.readEvents(`agent:${agentId}`, chatId);
}

export function appendAgentEvent(
  agentId: string,
  chatId: string,
  type: ChatEvent['type'],
  content: string,
  attachments?: ChatAttachment[]
): ChatEvent {
  return chatStore.append(`agent:${agentId}`, chatId, type, content, attachments);
}
