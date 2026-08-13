/**
 * git-service.ts
 * WSD-Pro — Git operations inside a project workspace (via docker exec).
 */
import { execInProject } from './docker-manager';

export async function gitStatus(slug: string): Promise<string> {
  const { output, exitCode } = await execInProject(slug, ['git', '-C', '/workspace', 'status', '--porcelain=v1', '-b']);
  if (exitCode !== 0) throw new Error(output || 'git status failed');
  return output;
}

export async function gitLog(slug: string, count = 20): Promise<string> {
  const { output, exitCode } = await execInProject(slug, ['git', '-C', '/workspace', 'log', `--max-count=${count}`, '--oneline']);
  if (exitCode !== 0) throw new Error(output || 'no commits yet');
  return output;
}

export async function gitDiff(slug: string, staged = false): Promise<string> {
  const args = ['git', '-C', '/workspace', 'diff'];
  if (staged) args.push('--staged');
  const { output, exitCode } = await execInProject(slug, args);
  if (exitCode !== 0) throw new Error(output || 'git diff failed');
  return output.slice(0, 30_000);
}

export async function gitCommit(slug: string, message: string): Promise<string> {
  const cleanMsg = message.trim().slice(0, 200);
  if (!cleanMsg) throw new Error('commit message required');
  const add = await execInProject(slug, ['git', '-C', '/workspace', 'add', '-A']);
  if (add.exitCode !== 0) throw new Error(add.output || 'git add failed');
  const { output, exitCode } = await execInProject(slug, [
    'git',
    '-C',
    '/workspace',
    '-c', 'user.name=WSD-Pro',
    '-c', 'user.email=wsd-pro@local',
    'commit',
    '-m', cleanMsg,
  ]);
  if (exitCode !== 0) throw new Error(output || 'git commit failed');
  return output;
}