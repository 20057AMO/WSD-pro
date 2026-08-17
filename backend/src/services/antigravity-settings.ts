import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.WSD_DATA_DIR || '/app/data';
const SETTINGS_FILE = path.join(DATA_DIR, 'antigravity-settings.json');

interface AntiGravitySettings {
  apiKey: string;
  model?: string;
}

let cached: AntiGravitySettings | null = null;

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadSettings(): AntiGravitySettings {
  if (cached) return cached;
  ensureDataDir();
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
      cached = JSON.parse(raw) as AntiGravitySettings;
    } catch {
      cached = { apiKey: '' };
    }
  } else {
    cached = { apiKey: '' };
  }
  return cached;
}

export function saveSettings(settings: AntiGravitySettings): void {
  ensureDataDir();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  cached = settings;
}

export function getApiKey(): string {
  const envKey = process.env.GEMINI_API_KEY;
  if (envKey) return envKey;
  return loadSettings().apiKey || '';
}

export function isConfigured(): boolean {
  return getApiKey().length > 0;
}
