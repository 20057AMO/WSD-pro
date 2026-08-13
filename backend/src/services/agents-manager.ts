/**
 * agents-manager.ts
 * WSD-Pro — Agent Bridge (free-only)
 * Orchestrates AI coding agents (local Ollama ReAct) inside project
 * workspaces. Every run is streamed chunk-by-chunk to the caller.
 */

import { spawn, execFileSync, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { WORKSPACES_ROOT, execInProject } from './docker-manager';

const OLLAMA_URL = process.env.OLLAMA_HOST || 'http://localhost:11434';

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

export interface StreamHandlers {
  onChunk: (text: string) => void;
  onDone: (final: string) => void;
  onError: (error: string) => void;
}

interface RunControl {
  cancelled: boolean;
  kill: (() => void) | null;
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
    execFileSync('curl', ['-s', '--max-time', '3', `${OLLAMA_URL}/api/tags`], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Streaming chat completion against Ollama.
 * Resolves with the FULL assistant reply; each delta is emitted via onDelta.
 */
function ollamaStreamChat(
  model: string,
  messages: { role: string; content: string }[],
  onDelta: (delta: string) => void,
  control: RunControl
): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages, stream: true, options: { temperature: 0.2 } });
    const proc = spawn('curl', ['-s', '-N', '-X', 'POST', `${OLLAMA_URL}/api/chat`, '-H', 'Content-Type: application/json', '-d', body], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    control.kill = () => proc.kill('SIGTERM');
    let full = '';
    let buf = '';
    proc.stdout?.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          const delta: string = parsed?.message?.content || '';
          if (delta) {
            full += delta;
            onDelta(delta);
          }
        } catch { /* skip malformed line */ }
      }
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      control.kill = null;
      if (control.cancelled) return reject(new Error('Agent task stopped'));
      if (code !== 0) return reject(new Error(`Ollama request failed (curl exited ${code})`));
      resolve(full);
    });
  });
}

/**
 * Local Agent — streaming ReAct loop against the local Ollama model.
 * The model outputs shell commands in ```bash blocks; we execute them
 * in the workspace and feed output back, until the model says DONE.
 */
async function runProjectCommandInContainer(projectSlug: string, cmd: string): Promise<string> {
  try {
    const { output, exitCode } = await execInProject(projectSlug, ['bash', '-lc', cmd], { stream: false });
    if (exitCode === 0) return output;
    return `EXIT ${exitCode}: ${output}`.slice(0, 2000);
  } catch (err: any) {
    return `EXIT ?: ${err?.message || String(err)}`.slice(0, 2000);
  }
}

export async function runLocalAgentStream(
  projectSlug: string,
  projectDir: string,
  prompt: string,
  model: string,
  handlers: StreamHandlers,
  control: RunControl
): Promise<string> {
  const messages = [
    {
      role: 'system',
      content:
        'You are a coding agent inside a Linux workspace. ' +
        'To do anything, output a ```bash block containing a shell command. ' +
        'After each command you will see its output. ' +
        'When the task is complete, reply with exactly DONE. ' +
        'All commands are executed inside the project container, not on the host server.',
    },
    { role: 'user', content: prompt },
  ];
  const maxRounds = 10;
  for (let round = 0; round < maxRounds; round++) {
    if (control.cancelled) throw new Error('Agent task stopped');
    let reply = '';
    try {
      reply = await ollamaStreamChat(model, messages, handlers.onChunk, control);
    } catch (err: any) {
      throw new Error(`Local agent error: ${err.message || err}`);
    }
    if (/^DONE\b/i.test(reply.trim())) return reply;

    const bashMatch = reply.match(/```(?:bash)?\s*\n([\s\S]*?)```/);
    if (bashMatch) {
      const cmd = bashMatch[1].trim();
      let output = '';
      try {
        output = await runProjectCommandInContainer(projectSlug, cmd);
      } catch (err: any) {
        output = `EXIT ?: ${err?.message || String(err)}`.slice(0, 2000);
      }
      handlers.onChunk(`\n$ ${cmd}\n${output}\n`);
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
const controls = new Map<string, RunControl>();

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
  const control = controls.get(id);
  const task = tasks.get(id);
  if (control) {
    control.cancelled = true;
    if (control.kill) control.kill();
    controls.delete(id);
  }
  if (task && (task.status === 'queued' || task.status === 'running')) {
    task.status = 'stopped';
    task.finishedAt = Date.now();
  }
  return !!control || !!task;
}

function launchTask(task: AgentTask, agent: AgentDef, projectDir: string, handlers: StreamHandlers): void {
  const control: RunControl = { cancelled: false, kill: null };
  controls.set(task.id, control);

  const emit = {
    onChunk: (text: string) => {
      task.output += text;
      if (task.output.length > 200_000) task.output = task.output.slice(-200_000);
      handlers.onChunk(text);
    },
    onDone: (final: string) => {
      task.status = 'done';
      task.finishedAt = Date.now();
      controls.delete(task.id);
      handlers.onDone(final);
    },
    onError: (error: string) => {
      task.status = 'failed';
      task.error = error;
      task.finishedAt = Date.now();
      controls.delete(task.id);
      handlers.onError(error);
    },
  };

  task.status = 'running';

  if (agent.name === 'local' || agent.name === 'codex' || agent.name === 'gemma') {
    const model = 'qwen2.5-coder:3b'; // fast on this machine (7b is too slow on CPU)
    runLocalAgentStream(task.project, projectDir, task.prompt, model, emit, control)
      .then((output) => {
        emit.onDone(output);
      })
      .catch((err) => {
        emit.onError(err?.message || String(err));
      });
    return;
  }

  // Generic CLI agent path (future agents)
  const args = agent.baseArgs(projectDir, task.prompt);
  const env = { ...process.env };
  const ollamaKey = readOllamaKey();
  if (ollamaKey) {
    env.OLLAMA_API_KEY = ollamaKey;
    env.OPENAI_API_KEY = ollamaKey;
  }
  const proc: ChildProcess = spawn(agent.cli, args, {
    cwd: projectDir,
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  control.kill = () => proc.kill('SIGTERM');

  proc.stdout?.on('data', (d: Buffer) => emit.onChunk(d.toString()));
  proc.stderr?.on('data', (d: Buffer) => emit.onChunk(d.toString()));
  proc.on('error', (err) => emit.onError(err.message));
  proc.on('close', (code) => {
    control.kill = null;
    if (control.cancelled) return emit.onError('Agent task stopped');
    if (code === 0) emit.onDone(task.output);
    else emit.onError(`Agent exited with code ${code}`);
  });
}

/**
 * Run an agent with full streaming. Creates + registers a task, returns it
 * immediately; results flow through `handlers`.
 */
export function runAgentStreaming(
  agentName: string,
  projectSlug: string,
  prompt: string,
  handlers: StreamHandlers,
  taskIdOverride?: string
): AgentTask {
  const agent = AGENTS.find((a) => a.name === agentName);
  if (!agent) throw new Error(`Unknown agent: ${agentName}`);

  const projectDir = path.join(WORKSPACES_ROOT, projectSlug);
  if (!fs.existsSync(projectDir)) {
    throw new Error(`Project workspace not found: ${projectSlug} (expected ${projectDir})`);
  }

  const task: AgentTask = {
    id: taskIdOverride || `${agentName}-${Date.now()}`,
    agent: agentName,
    project: projectSlug,
    prompt,
    status: 'queued',
    output: '',
    startedAt: Date.now(),
  };
  tasks.set(task.id, task);

  setTimeout(() => launchTask(task, agent, projectDir, handlers), 0);
  return task;
}

/** Fire-and-forget variant used by the REST API (output lands in the task). */
export async function runAgent(agentName: string, projectSlug: string, prompt: string): Promise<AgentTask> {
  return runAgentStreaming(agentName, projectSlug, prompt, { onChunk: () => { }, onDone: () => { }, onError: () => { } });
}