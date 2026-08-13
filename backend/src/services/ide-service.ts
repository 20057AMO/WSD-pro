/**
 * ide-service.ts
 * WSD-Pro — Single shared Web IDE (code-server in its own container).
 * Container: wsd-ide — mounts ALL workspaces under /workspaces.
 * Published on the host at WSD_IDE_PORT (default 8100).
 */
import Docker from 'dockerode';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { WORKSPACES_ROOT } from './docker-manager';

const docker = new Docker();

const IDE_CONTAINER = 'wsd-ide';
const IDE_IMAGE = process.env.WSD_BASE_IMAGE || 'wsd/workspace:latest';
const IDE_PORT = Number(process.env.WSD_IDE_PORT) || 8100;
const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const IDE_PASSWORD_FILE = path.join(DATA_DIR, 'ide-password');

export interface IdeStatus {
  running: boolean;
  exists: boolean;
  port: number;
  password?: string;
}

export function getIdePassword(): string {
  if (process.env.WSD_IDE_PASSWORD) return process.env.WSD_IDE_PASSWORD;
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

async function inspectIde(): Promise<{ id: string; running: boolean } | null> {
  try {
    const container = docker.getContainer(IDE_CONTAINER);
    const info = await container.inspect();
    return { id: info.Id, running: info.State?.Running === true };
  } catch {
    return null;
  }
}

/** Create the IDE container if missing (code-server + all workspaces). */
export async function ensureIde(): Promise<IdeStatus> {
  const existing = await inspectIde();
  if (!existing) {
    const password = getIdePassword();
    await docker.createContainer({
      name: IDE_CONTAINER,
      Image: IDE_IMAGE,
      Cmd: [
        '/bin/bash',
        '-c',
        `code-server --bind-addr 0.0.0.0:8080 --auth password --password '${password}' /workspaces`,
      ],
      Tty: true,
      OpenStdin: true,
      Env: ['PASSWORD=' + password, 'LANG=C.UTF-8'],
      ExposedPorts: { '8080/tcp': {} },
      HostConfig: {
        Binds: [`${WORKSPACES_ROOT}:/workspaces`],
        PortBindings: { '8080/tcp': [{ HostPort: String(IDE_PORT) }] },
        RestartPolicy: { Name: 'unless-stopped' },
      },
      Labels: { 'wsd.ide': 'true', 'wsd.managed': 'true' },
      WorkingDir: '/workspaces',
    });
    console.log(`[WSD-Pro] IDE container created (${IDE_CONTAINER}) on :${IDE_PORT}`);
  }

  const info = (await inspectIde())!;
  const status: IdeStatus = {
    running: info.running,
    exists: true,
    port: IDE_PORT,
  };
  if (process.env.WSD_IDE_PASSWORD) status.password = process.env.WSD_IDE_PASSWORD;
  return status;
}

export async function getIdeStatus(): Promise<IdeStatus> {
  const info = await inspectIde();
  if (!info) {
    return { running: false, exists: false, port: IDE_PORT };
  }
  const status: IdeStatus = { running: info.running, exists: true, port: IDE_PORT };
  if (process.env.WSD_IDE_PASSWORD) status.password = process.env.WSD_IDE_PASSWORD;
  return status;
}

export async function startIde(): Promise<IdeStatus> {
  await ensureIde();
  const container = docker.getContainer(IDE_CONTAINER);
  try {
    await container.start();
  } catch { /* already running */ }
  return getIdeStatus();
}

export async function stopIde(): Promise<IdeStatus> {
  await ensureIde();
  const container = docker.getContainer(IDE_CONTAINER);
  try {
    await container.stop();
  } catch { /* already stopped */ }
  return getIdeStatus();
}