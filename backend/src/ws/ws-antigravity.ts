/**
 * ws-antigravity.ts
 * WSD-Pro — Antigravity CLI (agy) over WebSocket.
 * Protocol (client → server, JSON):
 *   { type: "prompt", text, cwd?, project? } → run agy with the prompt
 *   { type: "abort" }                        → kill the running process
 * Protocol (server → client, JSON):
 *   { type: "connected" }
 *   { type: "context", project, framework, language }
 *   { type: "started" }
 *   { type: "delta", text }
 *   { type: "step", stepType, toolName?, state, detail? }
 *   { type: "done", response, exitCode }
 *   { type: "error", message }
 */
import { WebSocket } from 'ws';
import { spawn, type ChildProcess } from 'child_process';
import { buildAntiGravitySystemPrompt, analyzeProject } from '../services/antigravity-context';
import { getApiKey } from '../services/antigravity-settings';
import fs from 'fs';
import path from 'path';

const MAX_PROMPT_CHARS = 50000;
const AGY_BIN = 'agy';
const CWD_BASE = '/workspaces';

let activeProcess: ChildProcess | null = null;

function validateCwd(cwd: string): string {
  if (!cwd || !cwd.startsWith(CWD_BASE)) return CWD_BASE;
  const resolved = path.resolve(cwd);
  if (!resolved.startsWith(CWD_BASE)) return CWD_BASE;
  return resolved;
}

export function handleAntigravitySocket(ws: WebSocket, onRelease: () => void): void {
  sendJson(ws, { type: 'connected' });

  ws.on('message', (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      sendJson(ws, { type: 'error', message: 'Invalid JSON payload' });
      return;
    }

    if (msg.type === 'abort') {
      if (activeProcess) {
        activeProcess.kill('SIGTERM');
        activeProcess = null;
      }
      sendJson(ws, { type: 'aborted' });
      return;
    }

    if (msg.type === 'context') {
      const cwd = validateCwd(msg.cwd || CWD_BASE);
      const analysis = analyzeProject(cwd);
      if (analysis) {
        sendJson(ws, {
          type: 'context',
          project: analysis.name,
          framework: analysis.framework,
          language: analysis.language,
        });
      } else {
        sendJson(ws, { type: 'context', project: null, framework: null, language: null });
      }
      return;
    }

    if (msg.type !== 'prompt') {
      sendJson(ws, { type: 'error', message: 'Unknown message type' });
      return;
    }

    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (!text) {
      sendJson(ws, { type: 'error', message: 'Empty prompt' });
      return;
    }
    if (text.length > MAX_PROMPT_CHARS) {
      sendJson(ws, { type: 'error', message: 'Prompt too long' });
      return;
    }

    if (activeProcess) {
      sendJson(ws, { type: 'error', message: 'A reply is already running. Wait or abort.' });
      return;
    }

    if (!getApiKey()) {
      sendJson(ws, { type: 'error', message: 'Gemini API Key not configured. Open Antigravity Settings to add your key.' });
      return;
    }

    const cwd = validateCwd(msg.cwd || CWD_BASE);
    const reviewMode = msg.reviewMode === true;

    const systemPrompt = buildAntiGravitySystemPrompt(cwd);
    const fullPrompt = reviewMode
      ? `${systemPrompt}\n\nIMPORTANT: You are in REVIEW MODE. Do NOT write, create, or modify any files. Instead, describe exactly what changes you would make, which files you would create/modify, and show the code. The user will decide whether to apply the changes.\n\nUser request: ${text}`
      : `${systemPrompt}\n\nUser request: ${text}`;

    const args = [
      '-p', fullPrompt,
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--model', 'Gemini 3.5 Flash',
    ];

    const apiKey = getApiKey();
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PATH: `/root/.local/bin:${process.env.PATH || ''}`,
      AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
      HOME: '/root',
    };
    if (apiKey) {
      env.GEMINI_API_KEY = apiKey;
      env.GOOGLE_GENAI_USE_VERTEXAI = 'false';
      const settingsDir = path.join('/root/.gemini', 'antigravity-cli');
      if (!fs.existsSync(settingsDir)) fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({ modelProvider: 'gemini' }, null, 2));
    }

    const proc = spawn(AGY_BIN, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    activeProcess = proc;
    sendJson(ws, { type: 'started' });

    let buffer = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const event = JSON.parse(trimmed);
          forwardEvent(ws, event);
        } catch {
          sendJson(ws, { type: 'delta', text: trimmed + '\n' });
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const stderrText = chunk.toString('utf8').trim();
      if (stderrText) {
        sendJson(ws, { type: 'delta', text: stderrText + '\n' });
      }
    });

    proc.on('close', (code) => {
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim());
          forwardEvent(ws, event);
        } catch {
          sendJson(ws, { type: 'delta', text: buffer.trim() });
        }
      }
      activeProcess = null;
      sendJson(ws, { type: 'done', response: '', exitCode: code });
    });

    proc.on('error', (err) => {
      activeProcess = null;
      sendJson(ws, { type: 'error', message: err.message });
    });
  });

  ws.on('close', () => {
    if (activeProcess) {
      activeProcess.kill('SIGTERM');
      activeProcess = null;
    }
    onRelease();
  });

  ws.on('error', () => {
    if (activeProcess) {
      activeProcess.kill('SIGTERM');
      activeProcess = null;
    }
    onRelease();
  });
}

function forwardEvent(ws: WebSocket, event: any): void {
  const type = event.type || event.event;

  if (type === 'init' || type === 'session_init') {
    sendJson(ws, {
      type: 'init',
      model: event.model || event.session?.model || null,
      tools: event.tools || [],
    });
  } else if (type === 'step_update' || type === 'step') {
    const step = event.step || event;
    sendJson(ws, {
      type: 'step',
      stepType: step.type || step.stepType || 'unknown',
      toolName: step.tool_name || step.toolName || null,
      state: step.state || 'ACTIVE',
      detail: step.summary || step.detail || null,
    });
  } else if (type === 'result' || type === 'response') {
    const text = event.result || event.response || event.content || event.text || '';
    if (text) {
      sendJson(ws, { type: 'delta', text });
    }
  } else if (type === 'content' || type === 'chunk') {
    const text = event.content || event.text || event.delta || '';
    if (text) {
      sendJson(ws, { type: 'delta', text });
    }
  } else {
    const text = event.text || event.content || event.message || '';
    if (text) {
      sendJson(ws, { type: 'delta', text: text + '\n' });
    }
  }
}

function sendJson(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
