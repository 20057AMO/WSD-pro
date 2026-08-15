/**
 * opencode-runner.ts
 * WSD-Pro — Runs the opencode CLI inside a project workspace.
 * Spawns `opencode run` in /workspaces/<slug>; first run is a fresh session,
 * later runs pass `--continue` (gated by a per-project marker file) so the
 * agent keeps context of the previous conversation.
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { WORKSPACES_ROOT } from './docker-manager';

const MARKER = '.wsd-opencode';
const MAX_OUTPUT = 500_000;

export interface StreamHandlers {
  onChunk: (text: string) => void;
  onDone: (final: string) => void;
  onError: (error: string) => void;
}

export interface RunControl {
  cancelled: boolean;
  kill: (() => void) | null;
}

function projectDir(slug: string): string {
  return path.join(WORKSPACES_ROOT, slug);
}

export function runOpenCode(
  slug: string,
  prompt: string,
  handlers: StreamHandlers,
  control: RunControl
): { pid: number | undefined } {
  const dir = projectDir(slug);
  if (!fs.existsSync(dir)) {
    throw new Error(`Project workspace not found: ${slug} (expected ${dir})`);
  }

  const markerFile = path.join(dir, MARKER);
  const canContinue = fs.existsSync(markerFile);

  const args = ['run'];
  if (canContinue) args.push('--continue');
  args.push(prompt);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OLLAMA_HOST: process.env.OLLAMA_HOST || 'https://ollama.com',
  };

  const proc: ChildProcess = spawn('opencode', args, {
    cwd: dir,
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  control.kill = () => {
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  };

  let output = '';
  const emit = (text: string) => {
    output += text;
    if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
    handlers.onChunk(text);
  };

  proc.stdout?.on('data', (d: Buffer) => emit(d.toString()));
  proc.stderr?.on('data', (d: Buffer) => emit(d.toString()));
  proc.on('error', (err) => handlers.onError(err.message));
  proc.on('close', (code) => {
    control.kill = null;
    if (control.cancelled) {
      handlers.onError('Run stopped');
      return;
    }
    if (code === 0) {
      fs.writeFileSync(markerFile, String(Date.now()), 'utf8');
      handlers.onDone(output);
    } else {
      handlers.onError(`opencode exited with code ${code}`);
    }
  });

  return { pid: proc.pid };
}
