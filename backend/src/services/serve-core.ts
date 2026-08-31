/**
 * serve-core.ts
 * Madar — Pure rules for the static-site serve feature.
 *
 * Import-free on purpose (node --test loads it directly, mirroring
 * janitor-core.ts / snapshots-schedule.ts / alerts-core.ts): no dockerode/fs
 * imports, just plain types + pure functions, so the serve-config and
 * serve-state rules are deterministically unit-testable without a container.
 *
 * The feature runs `python3 -m http.server <port> -d /workspace` inside a
 * project container so static files in a workspace are reachable over HTTP
 * (containers otherwise idle on `sleep infinity` and Preview gets
 * ERR_EMPTY_RESPONSE).
 */

/** HTTP error with a status code — mirrors the HttpError shape in
 * docker-manager.ts (kept local so serve-core stays import-free). The route
 * layer maps this to the response, matching the rest of the codebase. */
export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

/** Persisted per-project serve configuration (meta.serve). */
export interface ServeConfig {
  enabled: boolean;
  /** The container-internal port python's http.server binds. */
  port?: number;
  /** PID of the started http.server process inside the container (best-effort). */
  pid?: number;
}

/** Honest live state surfaced to clients — config plus probe result. */
export interface ServeState {
  enabled: boolean;
  port?: number;
  hostPort?: string;
  url?: string;
  active: boolean;
  error?: string | null;
}

/**
 * Sanitize a serve-config write against the project's published ports.
 *
 * - port must be an integer present in publishedPorts.
 * - If input.port is missing/invalid → fall back to prev.port if it is still
 *   published, else the first published port.
 * - publishedPorts empty → throw 400.
 * - input.port provided but not in publishedPorts → throw 400.
 */
export function sanitizeServeConfig(
  input: { enabled?: boolean; port?: unknown } | undefined,
  prev: ServeConfig | undefined,
  publishedPorts: number[]
): ServeConfig {
  if (!Array.isArray(publishedPorts) || publishedPorts.length === 0) {
    throw new HttpError(400, 'No ports published for this project');
  }

  const enabled = input?.enabled === undefined ? true : Boolean(input.enabled);
  const provided = input && 'port' in input ? input.port : undefined;

  // Explicit provided port but not integer or not published → 400.
  if (provided !== undefined && provided !== null && provided !== '') {
    const n = Number(provided);
    if (!Number.isInteger(n)) {
      throw new HttpError(400, `Port ${provided} is not a published port of this project`);
    }
    if (!publishedPorts.includes(n)) {
      throw new HttpError(400, `Port ${n} is not a published port of this project`);
    }
    return { enabled, port: n };
  }

  // No usable provided port → fall back to prev.port if still published.
  if (prev?.port !== undefined && publishedPorts.includes(prev.port)) {
    return { enabled, port: prev.port };
  }

  // Else first published port.
  return { enabled, port: publishedPorts[0] };
}

/** The exact argv run inside the container to serve the workspace. */
export function buildServeCmd(port: number): string[] {
  return ['python3', '-m', 'http.server', String(port), '-d', '/workspace'];
}

/** Public URL a client would use to reach the served workspace. */
export function serveUrl(host: string, hostPort: string | number): string {
  return `http://${host}:${hostPort}`;
}

/** The probe object mirrors checkProjectPorts vocabulary. */
export interface ServeProbe {
  active: boolean;
  httpCode?: number | null;
  status?: string;
}

/**
 * Derive the honest ServeState from meta config + a probe.
 *
 * - enabled=false → active always false (config says off).
 * - probe null → active=false (config-only; we didn't/couldn't probe).
 * - probe present → active = probe.active.
 * - hostPort/url are derived from the configured port when it maps 1:1 to a
 *   published host port (Ports publish 1:1, so hostPort === port).
 */
export function deriveServeState(
  metaServe: ServeConfig | undefined,
  ports: number[] | undefined,
  probe: ServeProbe | null
): ServeState {
  const enabled = Boolean(metaServe?.enabled);
  const state: ServeState = { enabled, active: false, error: null };

  if (!enabled) {
    return state;
  }

  state.port = metaServe?.port;

  // hostPort is the configured port only when that port is actually published
  // (Ports publish 1:1 host==container, so it is normally a straight copy).
  const hostPort =
    metaServe?.port !== undefined && Array.isArray(ports) && ports.includes(metaServe.port)
      ? String(metaServe.port)
      : undefined;
  state.hostPort = hostPort;

  if (hostPort !== undefined) {
    // host.docker.internal routes container→host; clients reach it via the
    // host address. We only expose the hostPort/url when there is a real
    // mapping to publish against.
    state.url = serveUrl('localhost', hostPort);
  }

  if (probe === null) {
    state.active = false;
    return state;
  }

  state.active = probe.active;
  if (!probe.active && probe.status && probe.status !== 'open') {
    state.error = probe.status;
  } else {
    state.error = null;
  }
  return state;
}
