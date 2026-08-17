import { useState, useEffect } from 'preact/hooks';
import { useHashLocation } from 'wouter/use-hash-location';
import { getAntiGravitySettings, saveAntiGravitySettings } from '../api';
import { useLanguage } from '../hooks/useLanguage';

export function AntigravitySettings() {
  const [, setLocation] = useHashLocation();
  const { t } = useLanguage();
  const [apiKey, setApiKey] = useState('');
  const [configured, setConfigured] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAntiGravitySettings()
      .then((s) => {
        setConfigured(s.configured);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    const res = await saveAntiGravitySettings(apiKey.trim());
    if (res.ok) {
      setConfigured(res.configured);
      setSaved(true);
      setApiKey('');
      setTimeout(() => setSaved(false), 2000);
    }
  };

  return (
    <div class="anti-page">
      <div class="anti-toolbar">
        <button class="btn-ghost sm" onClick={() => setLocation('/antigravity')}>
          ← Antigravity
        </button>
        <span class="anti-title">{t.settingsTitle}</span>
      </div>

      <div class="anti-settings-card">
        <p class="anti-settings-desc">{t.settingsDesc}</p>

        <div class="anti-settings-status">
          {loading ? (
            <span class="anti-settings-badge pending">...</span>
          ) : configured ? (
            <span class="anti-settings-badge ok">{t.configured}</span>
          ) : (
            <span class="anti-settings-badge warn">{t.notConfigured}</span>
          )}
        </div>

        <div class="anti-settings-field">
          <label class="anti-settings-label">{t.apiKeyLabel}</label>
          <input
            class="anti-settings-input"
            type="password"
            placeholder={t.apiKeyPlaceholder}
            value={apiKey}
            onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
          />
          <span class="anti-settings-help">
            {t.apiKeyHelp}{' '}
            <a href="https://aistudio.google.com/app/api-keys" target="_blank" rel="noopener">
              aistudio.google.com
            </a>
          </span>
        </div>

        <div class="anti-settings-actions">
          <button class="anti-send-btn" onClick={handleSave} disabled={!apiKey.trim()}>
            {saved ? t.saved : t.save}
          </button>
        </div>
      </div>
    </div>
  );
}
