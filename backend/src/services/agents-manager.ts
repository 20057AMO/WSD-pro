/**
 * agents-manager.ts
 * WSD-Pro — Agent Bridge
 * Orchestrates AI coding agents (Codex, Claude Code, Kimi) inside
 * project workspaces. Each task runs the agent CLI as a child process
 * with cwd = the project's workspace dir (bind-mounted into the container).
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { WORKSPACES_ROOT } from './docker-manager';

export interface AgentDef {
  name: string;
  cli: string;
  displayName: string;
  description: string;
  color: string;
  /** args to force non-interactive headless mode */
  baseArgs: (projectDir: string, prompt: string) => string[];
  /** check if agent is authenticated */
  authCheck: () => Promise<{ ok: boolean; detail?: string }>;
}

export interface AgentTask {
  id: string;
  agent: string;
  project: string;
  prompt: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'stopped';
  output: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
}

/** Read the Ollama Cloud API key from env or ~/.hermes/.env (free agents) */
function readOllamaKey(): string | null {
  if (process.env.OLLAMA_API_KEY) return process.env.OLLAMA_API_KEY;
  try {
    const hermesEnv = fs.readFileSync(path.join(process.env.HOME || '/home/ahmedali', '.hermes', '.env'), 'utf8');
    const m = hermesEnv.match(/^OLLAMA_API_KEY=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* no hermes env */ }
  return null;
}

/** Check if local Ollama server is up */
function localOllamaUp(): boolean {
  try {
    const { execSync } = require('child_process');
    execSync('curl -s http://localhost:11434/api/tags', { timeout: 3000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Local Agent — simple ReAct loop against the local Ollama model.
 * The model outputs shell commands in ```bash blocks; we execute them
 * in the workspace and feed output back, until the model says DONE.
 */
export async function runLocalAgent(projectDir: string, prompt: string, model = 'qwen2.5-coder:3b'): Promise<string> {
  const { execFileSync } = await import('child_process');
  const messages = [
    {
      role: 'system',
      content:
        'You are a coding agent inside a Linux workspace. ' +
        'To do anything, output a ```bash block containing a shell command. ' +
        'After each command you will see its output. ' +
        'When the task is complete, reply with exactly DONE.',
    },
    { role: 'user', content: prompt },
  ];
  const maxRounds = 10;
  for (let round = 0; round < maxRounds; round++) {
    const body = JSON.stringify({ model, messages, stream: false, options: { temperature: 0.2 } });
    const resp = execFileSync('curl', ['-s', '-X', 'POST', 'http://localhost:11434/api/chat', '-H', 'Content-Type: application/json', '-d', body], {
      timeout: 300000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let reply = '';
    try {
      reply = JSON.parse(resp)?.message?.content || '';
    } catch {
      return `Local agent error: bad Ollama response — ${resp.slice(0, 200)}`;
    }
    if (/^DONE\b/i.test(reply.trim()) || reply.trim() === 'DONE') return reply;
    const bashMatch = reply.match(/```(?:bash)?\s*\n([\s\S]*?)```/);
    if (bashMatch) {
      const cmd = bashMatch[1].trim();
      let output = '';
      try {
        output = execFileSync('/bin/bash', ['-c', cmd], { cwd: projectDir, timeout: 120000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e: any) {
        output = `EXIT ${e.status ?? '?'}: ${e.stderr || e.message || ''}`.slice(0, 2000);
      }
      messages.push({ role: 'assistant', content: reply });
      messages.push({ role: 'user', content: `Command output:\n${output.slice(0, 4000)}` });
      // If model indicates completion after running the command, accept it
      if (/DONE|complete|created|written|finished/i.test(reply)) return `DONE\n${reply}`;
    } else {
      messages.push({ role: 'assistant', content: reply });
      messages.push({ role: 'user', content: 'No bash block found. Output a ```bash block with a shell command, or DONE if finished.' });
    }
  }
  return 'Local agent: reached max rounds without completion.';
}

const AGENTS: AgentDef[] = [
  {
    name: 'codex',
    cli: 'ollama',
    displayName: 'Codex (Local)',
    description: 'ReAct agent on local qwen2.5-coder:7b — free, offline, no limits',
    color: '#10a37f',
    baseArgs: () => [],
    authCheck: async () => {
      if (localOllamaUp()) return { ok: true, detail: 'Free via local Ollama (qwen2.5-coder:3b)' };
      const key = readOllamaKey();
      if (!key) return { ok: false, detail: 'Local Ollama down & no cloud key' };
      return { ok: true, detail: 'Free via Ollama Cloud (gpt-oss:120b)' };
    },
  },
  {
    name: 'gemma',
    cli: 'ollama',
    displayName: 'Gemma (Local)',
    description: 'ReAct agent on local qwen2.5-coder:3b — fast, free, offline',
    color: '#d97757',
    baseArgs: () => [],
    authCheck: async () => {
      if (localOllamaUp()) return { ok: true, detail: 'Free via local Ollama (qwen2.5-coder:3b)' };
      const key = readOllamaKey();
      if (!key) return { ok: false, detail: 'Local Ollama down & no cloud key' };
      return { ok: true, detail: 'Free via Ollama Cloud (gemma4:31b)' };
    },
  },
  {
    name: 'local',
    cli: 'ollama',
    displayName: 'Local Agent',
    description: 'Built-in agent on local Ollama (qwen2.5-coder) — free, no limits, offline',
    color: '#f59e0b',
    baseArgs: () => [],
    authCheck: async () => {
      if (localOllamaUp()) return { ok: true, detail: 'Free via local Ollama (qwen2.5-coder:3b)' };
      return { ok: false, detail: 'Local Ollama server is down (start it: ollama serve)' };
    },
  },
];

/** in-memory task store (single-instance; survives via systemd) */
const tasks = new Map<string, AgentTask>();
const running = new Map<string, ChildProcess>();

export function getAgents(): { name: string; displayName: string; description: string; color: string }[] {
  return AGENTS.map(({ name, displayName, description, color }) => ({ name, displayName, description, color }));
}

export async function checkAgentAuth(name: string) {
  const agent = AGENTS.find((a) => a.name === name);
  if (!agent) throw new Error(`Unknown agent: ${name}`);
  return agent.authCheck();
}

export function listTasks(agent?: string): AgentTask[] {
  const all = [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  return agent ? all.filter((t) => t.agent === agent) : all;
}

export function getTask(id: string): AgentTask | undefined {
  return tasks.get(id);
}

export function stopTask(id: string): boolean {
  const proc = running.get(id);
  const task = tasks.get(id);
  if (proc) {
    proc.kill('SIGTERM');
    running.delete(id);
  }
  if (task && (task.status === 'queued' || task.status === 'running')) {
    task.status = 'stopped';
    task.finishedAt = Date.now();
  }
  return !!proc || !!task;
}

export async function runAgent(
  agentName: string,
  projectSlug: string,
  prompt: string
): Promise<AgentTask> {
  const agent = AGENTS.find((a) => a.name === agentName);
  if (!agent) throw new Error(`Unknown agent: ${agentName}`);

  // Resolve project workspace dir
  const projectDir = path.join(WORKSPACES_ROOT, projectSlug);
  if (!fs.existsSync(projectDir)) {
    throw new Error(`Project workspace not found: ${projectSlug} (expected ${projectDir})`);
  }

  const task: AgentTask = {
    id: `${agentName}-${Date.now()}`,
    agent: agentName,
    project: projectSlug,
    prompt,
    status: 'queued',
    output: '',
    startedAt: Date.now(),
  };
  tasks.set(task.id, task);

  // Run async — do not block the request
  setTimeout(() => launch(task, agent, projectDir), 0);
  return task;
}

function launch(task: AgentTask, agent: AgentDef, projectDir: string) {
  task.status = 'running';

  // Local agent path: ReAct loop against local Ollama (no CLI)
  if (agent.name === 'local' || agent.name === 'codex' || agent.name === 'gemma') {
    const model = 'qwen2.5-coder:3b'; // fast on this machine (7b is too slow on CPU)
    runLocalAgent(projectDir, task.prompt, model)
      .then((output) => {
        task.status = 'done';
        task.output = output;
        task.finishedAt = Date.now();
      })
      .catch((err) => {
        task.status = 'failed';
        task.error = err?.message || String(err);
        task.finishedAt = Date.now();
      });
    return;
  }

  const args = agent.baseArgs(projectDir, task.prompt);
  // Inject Ollama Cloud key (free agents)
  const env = { ...process.env };
  const ollamaKey = readOllamaKey();
  if (ollamaKey) {
    env.OLLAMA_API_KEY = ollamaKey;
    env.OPENAI_API_KEY = ollamaKey; // codex uses OPENAI_API_KEY for custom providers
  }
  const proc = spawn(agent.cli, args, {
    cwd: projectDir,
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'], // stdin closed → agents never wait for input
  });
  running.set(task.id, proc);

  const MAX_OUTPUT = 200_000; // cap to avoid memory blowup
  let chunk = '';
  proc.stdout?.on('data', (d: Buffer) => {
    chunk = d.toString();
    task.output += chunk;
    if (task.output.length > MAX_OUTPUT) task.output = task.output.slice(-MAX_OUTPUT);
  });
  proc.stderr?.on('data', (d: Buffer) => {
    chunk = d.toString();
    task.output += chunk;
    if (task.output.length > MAX_OUTPUT) task.output = task.output.slice(-MAX_OUTPUT);
  });
  proc.on('error', (err) => {
    task.status = 'failed';
    task.error = err.message;
    task.finishedAt = Date.now();
    running.delete(task.id);
  });
  proc.on('close', (code) => {
    task.exitCode = code ?? undefined;
    task.status = code === 0 ? 'done' : 'failed';
    if (code !== 0 && !task.error) {
      task.error = `Agent exited with code ${code}`;
    }
    task.finishedAt = Date.now();
    running.delete(task.id);
  });
}
