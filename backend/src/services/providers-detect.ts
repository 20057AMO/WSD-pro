/**
 * providers-detect.ts
 * WSD-Pro — Auto-detect which provider an API key (and/or host) belongs to.
 * Strategy: order candidates by a fast key-prefix heuristic, then actually probe
 * each candidate endpoint until one responds with HTTP 200.
 */

import {
  KNOWN_TEMPLATES,
  normalizeHost,
  type AuthMode,
  type ProviderType,
} from './provider-store';

export interface DetectInput {
  apiKey?: string;
  host?: string;
}

export interface ProbeResult {
  ok: boolean;
  status: number;
  modelCount: number;
  firstModel?: string;
  /** Chat-capable model names to try during key verification (Gemini). */
  models?: string[];
}

const TIMEOUT_MS = 3000;
const DETECT_TOTAL_MS = 12000;
const CHECK_CACHE_TTL_MS = 60_000;

// Short-lived cache for full health checks — repeated "Test" clicks within a
// minute don't re-fire real billable chat completions against the provider.
const checkCache = new Map<string, { at: number; result: CheckResult }>();

function headersFor(apiKey: string, type: ProviderType, auth?: AuthMode): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!apiKey) return headers;
  if (type === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (type === 'gemini') {
    headers['x-goog-api-key'] = apiKey;
  } else if (type === 'openai') {
    if (auth === 'api-key') headers['api-key'] = apiKey;
    else headers['Authorization'] = `Bearer ${apiKey}`;
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

/** Probe a single candidate endpoint for its model list (any successful response = match). */
export async function probeProvider(
  type: ProviderType,
  host: string,
  apiKey: string,
  auth?: AuthMode
): Promise<ProbeResult> {
  const base = normalizeHost(host);
  const url =
    type === 'ollama'
      ? `${base}/api/tags`
      : type === 'anthropic'
        ? `${base}/v1/models`
        : `${base}/models`;
  try {
    const res = await fetch(url, {
      headers: headersFor(apiKey, type, auth),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status, modelCount: 0 };
    const body = (await res.json().catch(() => ({}))) as any;
    if (type === 'ollama') {
      const models = Array.isArray(body.models) ? (body.models as { name?: string }[]) : [];
      const modelNames = models.map((m) => m.name).filter((n): n is string => !!n);
      return { ok: true, status: res.status, modelCount: models.length, firstModel: modelNames[0], models: modelNames };
    }
    if (type === 'gemini') {
      const models = Array.isArray(body.models) ? (body.models as { name?: string; supportedGenerationMethods?: string[] }[]) : [];
      const chatCapable = models
        .filter((m) => m.name && Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
        .map((m) => String(m.name).replace(/^models\//, ''));
      return {
        ok: true,
        status: res.status,
        modelCount: models.length,
        firstModel: chatCapable[0],
        models: chatCapable,
      };
    }
    const data = Array.isArray(body.data) ? (body.data as { id?: string }[]) : [];
    return { ok: true, status: res.status, modelCount: data.length, firstModel: data[0]?.id };
  } catch {
    return { ok: false, status: 0, modelCount: 0 };
  }
}

/**
 * Some providers (e.g. OpenRouter) list models publicly without auth, so a model
 * list 200 does not prove the key is valid. Verify with a minimal chat call.
 */
export async function verifyChat(
  type: ProviderType,
  host: string,
  apiKey: string,
  model: string | undefined,
  auth?: AuthMode,
  extraModels?: string[]
): Promise<{ ok: boolean; reason?: string }> {
  const candidates = [model, ...(extraModels || [])].filter((m): m is string => !!m);
  if (candidates.length === 0) return { ok: false, reason: 'no_models' };
  let lastReason: string | undefined;
  for (const candidate of candidates.slice(0, 8)) {
    try {
      const r = await verifyOne(type, host, apiKey, candidate, auth);
      if (r.ok) return { ok: true };
      lastReason = r.reason;
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, reason: lastReason || 'verification_failed' };
}

async function verifyOne(
  type: ProviderType,
  host: string,
  apiKey: string,
  model: string,
  auth?: AuthMode
): Promise<{ ok: boolean; reason?: string }> {
  const base = normalizeHost(host);
  let res: Response;
  if (type === 'ollama') {
    res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: false, options: { temperature: 0 } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } else if (type === 'gemini') {
    const modelName = String(model).replace(/^models\//, '');
    res = await fetch(`${base}/models/${modelName}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } else if (type === 'anthropic') {
    res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } else {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers[auth === 'api-key' ? 'api-key' : 'Authorization'] = auth === 'api-key' ? apiKey : `Bearer ${apiKey}`;
    }
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: false, max_tokens: 1, temperature: 0 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
  if (res.ok) return { ok: true };
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth' };
  if (res.status === 402) return { ok: false, reason: 'quota' };
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };
  return { ok: false, reason: 'verification_failed' };
}

export interface CheckResult {
  ok: boolean;
  status: number;
  modelCount: number;
  verified: boolean;
  error?: string;
}

const VERIFY_REASON_MSG: Record<string, string> = {
  auth: 'Invalid or unauthorized API key',
  quota: 'API key has no remaining quota',
  rate_limited: 'Rate limited — try again shortly',
  no_models: 'No chat-capable models found',
  verification_failed: 'Key verification failed',
};

/** Full health check for a saved provider: model-list probe + key verification. */
export async function checkProvider(
  type: ProviderType,
  host: string,
  apiKey: string,
  auth?: AuthMode
): Promise<CheckResult> {
  const cacheKey = `${type}|${normalizeHost(host)}|${auth || 'bearer'}|${apiKey}`;
  const hit = checkCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CHECK_CACHE_TTL_MS) return hit.result;
  const result = await runCheck(type, host, apiKey, auth);
  checkCache.set(cacheKey, { at: Date.now(), result });
  if (checkCache.size > 50) {
    const oldest = checkCache.keys().next().value;
    if (oldest) checkCache.delete(oldest);
  }
  return result;
}

async function runCheck(
  type: ProviderType,
  host: string,
  apiKey: string,
  auth?: AuthMode
): Promise<CheckResult> {
  const probe = await probeProvider(type, host, apiKey, auth);
  if (!probe.ok) {
    return { ok: false, status: probe.status, modelCount: 0, verified: false, error: probe.status ? `HTTP ${probe.status}` : 'Could not reach the endpoint' };
  }
  const vr = await verifyChat(type, host, apiKey, probe.firstModel, auth, probe.models);
  if (!vr.ok) {
    return { ok: false, status: probe.status, modelCount: probe.modelCount, verified: false, error: VERIFY_REASON_MSG[vr.reason || ''] || 'Key verification failed' };
  }
  return { ok: true, status: probe.status, modelCount: probe.modelCount, verified: true };
}

function keyHint(key: string): string | null {
  const k = (key || '').trim();
  if (!k) return null;
  if (k.startsWith('sk-or-v1-')) return 'sk-or-v1-';
  if (k.startsWith('AIza') || k.startsWith('AQ')) return 'AIza';
  if (k.startsWith('sk-ant-')) return 'sk-ant-';
  if (k.startsWith('gsk_')) return 'gsk_';
  if (k.startsWith('hf_')) return 'hf_';
  if (k.startsWith('xai-') || k.startsWith('xai_')) return 'xai-';
  if (k.startsWith('sk-')) return 'sk-';
  if (k.startsWith('ollama_')) return 'ollama_';
  return null;
}

export interface DetectResult {
  name: string;
  host: string;
  type: ProviderType;
  modelCount: number;
}

/**
 * Auto-detect a provider. Returns null when nothing matched.
 * - With an explicit host: probe that host as openai → anthropic → ollama.
 * - With only an API key: probe known openai/anthropic/ollama templates, ordered
 *   by key-prefix heuristic. Ollama templates are included — false positives are
 *   prevented by the verifyChat() call which sends an actual chat request.
 */
export async function detectProvider(input: DetectInput): Promise<{
  provider: DetectResult | null;
  tried: string[];
}> {
  const apiKey = String(input.apiKey ?? '').trim();
  const host = String(input.host ?? '').trim();
  const tried: string[] = [];
  const startedAt = Date.now();

  let candidates: { name: string; host: string; type: ProviderType }[] = [];

  if (host) {
    candidates = [
      { name: host, host, type: 'openai' },
      { name: host, host, type: 'anthropic' },
      { name: host, host, type: 'ollama' },
    ];
  } else {
    const hint = keyHint(apiKey);
    const scored = KNOWN_TEMPLATES.map((t) => ({
      name: t.name,
      host: t.host,
      type: t.type,
      score:
        hint && (Array.isArray(t.keyPrefix) ? t.keyPrefix.includes(hint) : t.keyPrefix === hint) ? 0 : 1,
    }));
    scored.sort((a, b) => a.score - b.score);
    candidates = scored;
  }

  for (const c of candidates) {
    if (Date.now() - startedAt >= DETECT_TOTAL_MS) break;
    tried.push(c.name);
    const r = await probeProvider(c.type, c.host, apiKey, 'bearer');
    if (r.ok && (await verifyChat(c.type, c.host, apiKey, r.firstModel, 'bearer', r.models)).ok) {
      return {
        provider: { name: c.name, host: normalizeHost(c.host), type: c.type, modelCount: r.modelCount },
        tried,
      };
    }
  }

  return { provider: null, tried };
}
