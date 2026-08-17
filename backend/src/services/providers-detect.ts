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
      : type === 'anthropic' || type === 'gemini'
        ? `${base}/models`
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
      return { ok: true, status: res.status, modelCount: models.length, firstModel: models[0]?.name };
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
): Promise<boolean> {
  const candidates = [model, ...(extraModels || [])].filter((m): m is string => !!m);
  if (candidates.length === 0) return true;
  for (const candidate of candidates.slice(0, 8)) {
    try {
      if (await verifyOne(type, host, apiKey, candidate, auth)) return true;
    } catch {
      // try the next candidate
    }
  }
  return false;
}

async function verifyOne(
  type: ProviderType,
  host: string,
  apiKey: string,
  model: string,
  auth?: AuthMode
): Promise<boolean> {
  const base = normalizeHost(host);
  if (type === 'ollama') {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: false, options: { temperature: 0 } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  }
  if (type === 'gemini') {
    const modelName = String(model).replace(/^models\//, '');
    const res = await fetch(`${base}/models/${modelName}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  }
  if (type === 'anthropic') {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers[auth === 'api-key' ? 'api-key' : 'Authorization'] = auth === 'api-key' ? apiKey : `Bearer ${apiKey}`;
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: false, max_tokens: 1, temperature: 0 }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return res.ok;
}

export interface CheckResult {
  ok: boolean;
  status: number;
  modelCount: number;
  verified: boolean;
  error?: string;
}

/** Full health check for a saved provider: model-list probe + key verification. */
export async function checkProvider(
  type: ProviderType,
  host: string,
  apiKey: string,
  auth?: AuthMode
): Promise<CheckResult> {
  const probe = await probeProvider(type, host, apiKey, auth);
  if (!probe.ok) {
    return { ok: false, status: probe.status, modelCount: 0, verified: false, error: probe.status ? `HTTP ${probe.status}` : 'Could not reach the endpoint' };
  }
  const verified = await verifyChat(type, host, apiKey, probe.firstModel, auth, probe.models);
  if (!verified) {
    return { ok: false, status: probe.status, modelCount: probe.modelCount, verified: false, error: 'Key verification failed' };
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
  if (/^az/i.test(k)) return 'az';
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
 * - With only an API key: probe known openai/anthropic templates, ordered by
 *   key-prefix heuristic. Ollama templates are excluded here to avoid false
 *   positives (their /api/tags endpoint often answers 200 without auth).
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
    const scored = KNOWN_TEMPLATES.filter((t) => t.type !== 'ollama').map((t) => ({
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
    if (r.ok && (await verifyChat(c.type, c.host, apiKey, r.firstModel, 'bearer', r.models))) {
      return {
        provider: { name: c.name, host: normalizeHost(c.host), type: c.type, modelCount: r.modelCount },
        tried,
      };
    }
  }

  return { provider: null, tried };
}
