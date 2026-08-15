/**
 * ide-service.ts
 * WSD-Pro — Web IDE (code-server) managed per project container.
 * Starts code-server inside the project's container on port 8080.
 */
import Docker from 'dockerode';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getProject } from './docker-manager';

const docker = new Docker();
const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const IDE_PASSWORD_FILE = path.join(DATA_DIR, 'ide-password');

export interface IdeStatus {
  running: boolean;
  exists: boolean;
  port: number;
  password?: string;
}

export function getIdePassword(): string {
  const configured = process.env.WSD_IDE_PASSWORD;
  if (configured && configured.trim()) return configured.trim();
  try {
    if (fs.existsSync(IDE_PASSWORD_FILE)) {
      return fs.readFileSync(IDE_PASSWORD_FILE, 'utf8').trim();
    }
    const pwd = crypto.randomBytes(9).toString('base64url');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(IDE_PASSWORD_FILE, pwd, { mode: 0o600 });
    return pwd;
  } catch {
    return 'change-me';
  }
}

async function isCodeServerRunning(slug: string): Promise<boolean> {
  try {
    const container = docker.getContainer(`wsd-${slug}`);
    const exec = await container.exec({
      Cmd: ['sh', '-c', 'pgrep -f code-server'],
      AttachStdout: true,
      AttachStderr: true,
    });
    
    return new Promise((resolve) => {
      exec.start({}, (err: any, stream: any) => {
        if (err || !stream) return resolve(false);
        let output = '';
        stream.on('data', (chunk: Buffer) => {
          let offset = 0;
          while (offset + 8 <= chunk.length) {
            const frameLen = chunk.readUInt32BE(offset + 4);
            if (offset + 8 + frameLen > chunk.length) break;
            output += chunk.subarray(offset + 8, offset + 8 + frameLen).toString('utf8');
            offset += 8 + frameLen;
          }
          if (offset < chunk.length) {
            output += chunk.subarray(offset).toString('utf8');
          }
        });
        stream.on('end', () => {
          resolve(output.trim().length > 0);
        });
      });
    });
  } catch {
    return false;
  }
}

export async function getIdeStatus(slug: string): Promise<IdeStatus> {
  const project = await getProject(slug);
  if (!project || project.status !== 'running' || !project.idePort) {
    return { running: false, exists: false, port: 0 };
  }
  
  const running = await isCodeServerRunning(slug);
  const status: IdeStatus = {
    running,
    exists: true,
    port: project.idePort
  };
  if (process.env.WSD_IDE_PASSWORD) status.password = process.env.WSD_IDE_PASSWORD;
  return status;
}

export async function startIde(slug: string): Promise<IdeStatus> {
  const project = await getProject(slug);
  if (!project || project.status !== 'running' || !project.idePort) {
    throw new Error('Project not running or IDE port not allocated');
  }

  const running = await isCodeServerRunning(slug);
  if (!running) {
    const password = getIdePassword();
    const container = docker.getContainer(`wsd-${slug}`);
    const exec = await container.exec({
      Cmd: [
        'sh', '-c', 
        `PASSWORD=${password} LANG=C.UTF-8 nohup code-server --bind-addr 0.0.0.0:8080 --auth password --password ${password} /workspace > /tmp/code-server.log 2>&1 &`
      ],
      AttachStdout: false,
      AttachStderr: false,
    });
    await new Promise((resolve, reject) => {
      exec.start({ Detach: true }, (err: any) => {
        if (err) return reject(err);
        resolve(null);
      });
    });
  }
  return getIdeStatus(slug);
}

export async function stopIde(slug: string): Promise<IdeStatus> {
  try {
    const container = docker.getContainer(`wsd-${slug}`);
    const exec = await container.exec({
      Cmd: ['sh', '-c', 'pkill -f code-server'],
      AttachStdout: false,
      AttachStderr: false,
    });
    await new Promise((resolve, reject) => {
      exec.start({ Detach: true }, (err: any) => {
        if (err) return reject(err);
        resolve(null);
      });
    });
  } catch {
    // Ignore errors
  }
  return getIdeStatus(slug);
}