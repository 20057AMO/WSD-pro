import { useState, useEffect } from 'preact/hooks';
import { X, Loader2 } from 'lucide-preact';
import { updateAgent, deleteAgent, getChatModels, getChatInfo, type AgentDef } from '../api';
import { ConfirmModal } from './ConfirmModal';

interface ProviderBrief {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
}

interface Props {
  agent: AgentDef;
  onSave: (agent: AgentDef) => void;
  onDelete: (agentId: string) => void;
  onClose: () => void;
}

export function AgentSettingsModal({ agent, onSave, onDelete, onClose }: Props) {
  const [name, setName] = useState(agent.name);
  const [icon, setIcon] = useState(agent.icon);
  const [description, setDescription] = useState(agent.description);
  const [systemPrompt, setSystemPrompt] = useState(agent.systemPrompt);
  const [provider, setProvider] = useState(agent.provider || '');
  const [model, setModel] = useState(agent.model || '');
  const [toolsEnabled, setToolsEnabled] = useState(agent.toolsEnabled);
  const [permission, setPermission] = useState<import('../api').AgentPermission>(agent.permission || (agent.toolsEnabled ? 'full' : 'none'));

  const [providers, setProviders] = useState<ProviderBrief[]>([]);
  const [globalProvider, setGlobalProvider] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getChatInfo()
      .then((info) => {
        setProviders(info.providers || []);
        setGlobalProvider(info.provider);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoadingModels(true);
    getChatModels(provider)
      .then(({ models: list }) => {
        setModels(list || []);
        if (model && list && !list.includes(model)) {
          setModel('');
        }
      })
      .catch(() => setModels([]))
      .finally(() => setLoadingModels(false));
  }, [provider]);

  const activeProviderName = provider
    ? providers.find((p) => p.id === provider)?.name || provider
    : providers.find((p) => p.id === globalProvider)?.name || globalProvider;

  const isProviderOverride = !!provider;
  const isModelOverride = !!model;

  const handleSave = async () => {
    if (!name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError('');
    try {
      const { agent: updated } = await updateAgent(agent.id, {
        name: name.trim(),
        icon: icon.trim() || '🤖',
        description: description.trim(),
        systemPrompt: systemPrompt.trim(),
        provider: provider || undefined,
        model: model || undefined,
        toolsEnabled,
        permission: toolsEnabled ? permission : 'none',
      });
      onSave(updated);
    } catch (err: any) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => setConfirmDelete(true);

  const runDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteAgent(agent.id);
      onDelete(agent.id);
    } catch (err: any) {
      setError(err.message || 'Failed to delete');
      setDeleting(false);
    }
  };

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class="agent-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div class="agent-settings-header">
          <div class="agent-settings-identity">
            <span class="agent-settings-icon-preview">{icon || '🤖'}</span>
            <div class="agent-settings-identity-fields">
              <input
                class="agent-settings-name-input"
                value={name}
                onInput={(e: any) => setName(e.target.value)}
                placeholder="Agent name"
              />
              <input
                class="agent-settings-desc-input"
                value={description}
                onInput={(e: any) => setDescription(e.target.value)}
                placeholder="Short description"
              />
            </div>
          </div>
          <button class="btn-ghost sm" onClick={onClose} title="Close"><X width={14} height={14} class="icon" /></button>
        </div>

        <div class="agent-settings-body scrollbar">
          <div class="agent-settings-section">
            <div class="agent-settings-section-title">Icon</div>
            <div class="agent-settings-icon-row">
              <input
                class="modern-input agent-settings-icon-input"
                value={icon}
                onInput={(e: any) => setIcon(e.target.value)}
                placeholder="🤖"
              />
              <span class="agent-settings-icon-hint">Use an emoji as the agent icon</span>
            </div>
          </div>

          <div class="agent-settings-section">
            <div class="agent-settings-section-title">System Prompt</div>
            <textarea
              class="modern-input agent-settings-textarea"
              rows={6}
              value={systemPrompt}
              onInput={(e: any) => setSystemPrompt(e.target.value)}
              placeholder="Instructions for this agent..."
            />
          </div>

          <div class="agent-settings-section">
            <div class="agent-settings-section-title">Model</div>
            <div class="agent-settings-model-row">
              <label class="agent-settings-field" style="flex:1">
                <span class="agent-settings-field-label">
                  Provider
                  {isProviderOverride && <span class="agent-settings-badge override">override</span>}
                </span>
                <select
                  class="modern-input chat-sel"
                  value={provider}
                  onInput={(e: any) => { setProvider(e.target.value); setModel(''); }}
                >
                  <option value="">{activeProviderName} (global)</option>
                  {providers.filter((p) => p.enabled).map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
              <label class="agent-settings-field" style="flex:1">
                <span class="agent-settings-field-label">
                  Model
                  {isModelOverride && <span class="agent-settings-badge override">override</span>}
                </span>
                <select
                  class="modern-input chat-sel"
                  value={model}
                  onInput={(e: any) => setModel(e.target.value)}
                >
                  <option value="">Use global</option>
                  {loadingModels ? <option disabled>Loading…</option> : null}
                  {!loadingModels && models.length === 0 ? (
                    <option value="" disabled>No models found</option>
                  ) : null}
                  {models.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          <div class="agent-settings-section">
            <div class="agent-settings-section-title">Tools</div>
            <label class="agent-settings-toggle">
              <input
                type="checkbox"
                checked={toolsEnabled}
                onChange={(e: any) => {
                  const on = e.target.checked;
                  setToolsEnabled(on);
                  if (!on) setPermission('none');
                  else if (permission === 'none') setPermission('full');
                }}
              />
              <div class="agent-settings-toggle-text">
                <span class="agent-settings-toggle-label">Enable tool use</span>
                <span class="agent-settings-toggle-desc">Allow this agent to read/write files and run commands</span>
              </div>
            </label>
            {toolsEnabled && (
              <div style="margin-top:8px">
                <label class="agent-settings-field-label">Permission level</label>
                <select
                  class="modern-input"
                  value={permission}
                  onChange={(e: any) => setPermission(e.target.value)}
                >
                  <option value="read">Read only — read files, list dirs, view tree</option>
                  <option value="bash">Bash — read files + run shell commands</option>
                  <option value="full">Full — read, write, and execute</option>
                </select>
              </div>
            )}
          </div>

          {error && <div class="login-error">{error}</div>}
        </div>

        <div class="agent-settings-footer">
          <button class="btn-danger sm" onClick={handleDelete} disabled={deleting}>{deleting ? 'Deleting…' : 'Delete Agent'}</button>
          <div style="flex:1" />
          <button class="btn-ghost sm" onClick={onClose}>Cancel</button>
          <button class="btn-primary" onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? <span style="display:inline-flex;align-items:center;gap:6px;"><Loader2 width={13} height={13} class="icon spin" /> Saving…</span> : 'Save'}
          </button>
        </div>
      </div>

      <div onClick={(e: any) => e.stopPropagation()}>
        <ConfirmModal
          open={confirmDelete}
          danger
          loading={deleting}
          title={`Delete agent '${name.trim() || agent.name}'?`}
          message="The agent and its settings are removed permanently."
          confirmLabel="Delete"
          onConfirm={runDelete}
          onCancel={() => { if (!deleting) setConfirmDelete(false); }}
        />
      </div>
    </div>
  );
}
