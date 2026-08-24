import { useState, useEffect } from 'preact/hooks';
import { ArrowLeft, Bot, Sparkles, SlidersHorizontal, RefreshCw, CheckCircle2, ArrowUpCircle, Lock, Trash2, Plus, Save, Terminal } from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import { ConfirmModal } from '../components/ConfirmModal';
import {
  listStudioAgents,
  getStudioAgent,
  saveStudioAgent,
  deleteStudioAgent,
  listStudioSkills,
  getStudioSkill,
  saveStudioSkill,
  deleteStudioSkill,
  listStudioCommands,
  getStudioCommand,
  saveStudioCommand,
  deleteStudioCommand,
  getStudioConfig,
  updateStudioConfig,
  getStudioVersion,
  runStudioUpdate,
  type StudioItem,
  type StudioVersionInfo,
} from '../api';

type Tab = 'agents' | 'skills' | 'commands' | 'config';

const AGENT_TEMPLATE = `---
description: What this subagent does (shown to the model for selection)
mode: subagent
permission:
  edit: deny
---

You are a focused specialist.

1. ...
2. ...

Rules:
- ...
`;

const SKILL_TEMPLATE = `---
name: my-skill
description: One clear sentence — the model loads the skill when this matches the task
---

# My Skill

Use when ...

## Steps
1. ...
2. ...
`;

const COMMAND_TEMPLATE = `---
description: What this slash command does (shown in the command menu)
agent: code-reviewer
---

Run the task described by the user:

$ARGUMENTS

State the expected output format and any constraints here.
`;

export function OpencodeStudio() {
  const [, setLocation] = useHashLocation();
  const [tab, setTab] = useState<Tab>('agents');

  // Shared editor state (agents & skills)
  const [items, setItems] = useState<StudioItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Config tab
  const [configText, setConfigText] = useState('');

  // Version / update
  const [ver, setVer] = useState<StudioVersionInfo | null>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    getStudioVersion()
      .then(setVer)
      .catch(() => {});
  }, []);

  const loadList = (which: Tab) => {
    setLoading(true);
    const p =
      which === 'skills'
        ? listStudioSkills().then((r) => r.skills || [])
        : which === 'commands'
          ? listStudioCommands().then((r) => r.commands || [])
          : listStudioAgents().then((r) => r.agents || []);
    p.then((list) => {
      setItems(list);
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  useEffect(() => {
    setSelected(null);
    setNotice(null);
    if (tab === 'config') {
      getStudioConfig()
        .then((c) => setConfigText(JSON.stringify(c, null, 2)))
        .catch(() => {});
      return;
    }
    loadList(tab);
  }, [tab]);

  const flash = (kind: 'ok' | 'err', text: string) => {
    setNotice({ kind, text });
    setTimeout(() => setNotice(null), 4000);
  };

  const openItem = async (name: string) => {
    try {
      const getter =
        tab === 'skills' ? getStudioSkill : tab === 'commands' ? getStudioCommand : getStudioAgent;
      const r = await getter(name);
      setSelected(name);
      setDraftName(name);
      setContent(r.content);
      setDirty(false);
    } catch (err: any) {
      flash('err', err.message);
    }
  };

  const newItem = () => {
    setSelected('__new__');
    setDraftName('');
    setContent(
      tab === 'skills' ? SKILL_TEMPLATE : tab === 'commands' ? COMMAND_TEMPLATE : AGENT_TEMPLATE,
    );
    setDirty(true);
  };

  const save = async () => {
    const name = draftName.trim();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      flash('err', 'Name must be kebab-case: lowercase letters, digits, dashes');
      return;
    }
    setBusy(true);
    try {
      if (tab === 'skills') await saveStudioSkill(name, content);
      else if (tab === 'commands') await saveStudioCommand(name, content);
      else await saveStudioAgent(name, content);
      flash('ok', `Saved '${name}' — new opencode sessions pick it up immediately`);
      setSelected(name);
      setDirty(false);
      loadList(tab);
    } catch (err: any) {
      flash('err', err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setBusy(true);
    try {
      if (tab === 'skills') await deleteStudioSkill(name);
      else if (tab === 'commands') await deleteStudioCommand(name);
      else await deleteStudioAgent(name);
      flash('ok', `Deleted '${name}'`);
      if (selected === name) {
        setSelected(null);
        setContent('');
      }
      loadList(tab);
    } catch (err: any) {
      flash('err', err.message);
    } finally {
      setBusy(false);
      setConfirmDelete(null);
    }
  };

  const saveConfig = async () => {
    let patch: Record<string, unknown>;
    try {
      patch = JSON.parse(configText);
    } catch (err: any) {
      flash('err', `Invalid JSON: ${err.message}`);
      return;
    }
    setBusy(true);
    try {
      const merged = await updateStudioConfig(patch);
      setConfigText(JSON.stringify(merged, null, 2));
      flash('ok', 'Configuration saved');
    } catch (err: any) {
      flash('err', err.message);
    } finally {
      setBusy(false);
    }
  };

  const update = async () => {
    setUpdating(true);
    try {
      const r = await runStudioUpdate();
      if (r.ok) flash('ok', `Updated to ${r.updatedTo}`);
      else flash('err', r.error || 'Update failed');
    } catch (err: any) {
      flash('err', err.message);
    } finally {
      setUpdating(false);
      getStudioVersion().then(setVer).catch(() => {});
    }
  };

  return (
    <div class="opencode-page">
      <div class="opencode-toolbar">
        <button class="btn-ghost sm" onClick={() => setLocation('/')}><ArrowLeft width={13} height={13} class="icon" /> Dashboard</button>
        <span style="display:inline-flex;align-items:center;gap:4px;margin-left:8px">
          <button class={`btn-ghost sm${tab === 'agents' ? ' active' : ''}`} onClick={() => setTab('agents')}><Bot width={13} height={13} class="icon" /> Subagents</button>
          <button class={`btn-ghost sm${tab === 'skills' ? ' active' : ''}`} onClick={() => setTab('skills')}><Sparkles width={13} height={13} class="icon" /> Skills</button>
          <button class={`btn-ghost sm${tab === 'commands' ? ' active' : ''}`} onClick={() => setTab('commands')}><Terminal width={13} height={13} class="icon" /> Commands</button>
          <button class={`btn-ghost sm${tab === 'config' ? ' active' : ''}`} onClick={() => setTab('config')}><SlidersHorizontal width={13} height={13} class="icon" /> Config</button>
        </span>
        <span style="flex:1" />
        {tab !== 'config' && (
          <button class="btn-primary sm" onClick={newItem}><Plus width={13} height={13} class="icon" /> New</button>
        )}
        {ver && (
          <span class="mono" style="font-size:0.68rem;color:var(--text-3);margin-left:12px;display:inline-flex;align-items:center;gap:6px">
            opencode v{ver.current}
            {updating || ver.updateRunning ? (
              <RefreshCw width={12} height={12} class="icon spin" />
            ) : ver.upToDate === true ? (
              <CheckCircle2 width={12} height={12} style="color:var(--ok,#4ade80)" />
            ) : ver.upToDate === false && ver.channelUnlocked ? (
              <button class="btn-primary sm" onClick={update} disabled={updating}>
                <ArrowUpCircle width={12} height={12} class="icon" /> Update to {ver.latest}
              </button>
            ) : ver.upToDate === false ? (
              <span title={`v${ver.latest} is a newer major than this WSD-Pro build supports (${ver.supportedMajors.join(', ')}). Update WSD-Pro first.`}>
                <Lock width={12} height={12} /> {ver.latest} needs a WSD-Pro update
              </span>
            ) : null}
          </span>
        )}
      </div>

      {notice && (
        <div
          class="chat-save-msg"
          style={
            notice.kind === 'err'
              ? 'background:#7f1d1d;color:#fecaca;margin:10px 16px;padding:8px 12px;border-radius:8px;font-size:0.75rem'
              : 'margin:10px 16px;padding:8px 12px;border-radius:8px;font-size:0.75rem'
          }
        >
          {notice.text}
        </div>
      )}

      {tab === 'config' ? (
        <div class="studio-editor" style="padding:16px;display:flex;flex-direction:column;gap:10px;overflow:auto">
          <p style="font-size:0.75rem;color:var(--text-3);margin:0">
            Global opencode.json — applies to every project and interface.
            The $schema key is managed by WSD-Pro.
          </p>
          <textarea
            class="modern-input mono"
            style="flex:1;min-height:320px;resize:vertical;font-size:0.78rem;line-height:1.5;white-space:pre"
            value={configText}
            onInput={(e: any) => setConfigText(e.target.value)}
            spellcheck={false}
          />
          <div>
            <button class="btn-primary sm" onClick={saveConfig} disabled={busy}>
              <Save width={13} height={13} class="icon" /> Save config
            </button>
          </div>
        </div>
      ) : (
        <div class="studio-body" style="display:flex;gap:14px;padding:14px 16px;overflow:hidden;flex:1">
          {/* List column */}
          <div style="width:260px;overflow:auto;border-right:1px solid var(--border,#333);padding-right:10px">
            {loading ? (
              <p style="color:var(--text-3);font-size:0.75rem">Loading…</p>
            ) : items.length === 0 ? (
              <p style="color:var(--text-3);font-size:0.75rem">Nothing yet — create one with New.</p>
            ) : (
              items.map((it) => (
                <div
                  key={it.name}
                  class="studio-item"
                  style={`padding:8px 10px;border-radius:8px;cursor:pointer;margin-bottom:6px;background:${
                    selected === it.name ? 'var(--accent-bg,rgba(99,102,241,.15))' : 'transparent'
                  }`}
                  onClick={() => openItem(it.name)}
                >
                  <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
                    <strong style="font-size:0.78rem">{it.name}</strong>
                    {tab === 'agents' && it.mode && (
                      <span style="font-size:0.62rem;padding:1px 6px;border-radius:999px;background:rgba(255,255,255,.08)">
                        {it.mode}
                      </span>
                    )}
                    {tab === 'commands' && it.agent && (
                      <span title="Bound agent" style="font-size:0.62rem;padding:1px 6px;border-radius:999px;background:rgba(255,255,255,.08)">
                        @{it.agent}
                      </span>
                    )}
                    <Trash2
                      width={13}
                      height={13}
                      class="icon"
                      style="opacity:.5;cursor:pointer"
                      onClick={(e: Event) => {
                        e.stopPropagation();
                        setConfirmDelete(it.name);
                      }}
                    />
                  </div>
                  {it.description && (
                    <div style="font-size:0.68rem;color:var(--text-3);margin-top:2px">
                      {it.description.slice(0, 90)}
                      {it.description.length > 90 ? '…' : ''}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Editor column */}
          <div style="flex:1;display:flex;flex-direction:column;gap:8px;min-width:0">
            {selected == null ? (
                <div class="empty-state" style="margin:auto;text-align:center">
                  <div class="big-icon">
                    {tab === 'skills' ? (
                      <Sparkles width={30} height={30} class="icon" />
                    ) : tab === 'commands' ? (
                      <Terminal width={30} height={30} class="icon" />
                    ) : (
                      <Bot width={30} height={30} class="icon" />
                    )}
                  </div>
                Select an item or press New to create one.
                </div>
            ) : (
              <>
                <div style="display:flex;gap:8px;align-items:center">
                  <input
                    class="modern-input mono"
                    style="width:240px;font-size:0.78rem;padding:6px 10px"
                    placeholder={tab === 'skills' ? 'skill-name' : tab === 'commands' ? 'command-name' : 'agent-name'}
                    value={selected === '__new__' ? draftName : selected!}
                    readOnly={selected !== '__new__'}
                    onInput={(e: any) => setDraftName(e.target.value)}
                    spellcheck={false}
                  />
                  <span style="flex:1" />
                  <button class="btn-primary sm" onClick={save} disabled={busy || !dirty && selected !== '__new__'}>
                    <Save width={13} height={13} class="icon" /> Save
                  </button>
                </div>
                <textarea
                  class="modern-input mono"
                  style="flex:1;resize:none;font-size:0.78rem;line-height:1.55;white-space:pre;min-height:300px"
                  value={content}
                  onInput={(e: any) => {
                    setContent(e.target.value);
                    setDirty(true);
                  }}
                  spellcheck={false}
                />
              </>
            )}
          </div>
        </div>
      )}

      <ConfirmModal
        open={confirmDelete != null}
        danger
        loading={busy}
        title={
          tab === 'skills'
            ? `Delete skill '${confirmDelete}'?`
            : tab === 'commands'
              ? `Delete command '/${confirmDelete}'?`
              : `Delete subagent '${confirmDelete}'?`
        }
        message="Removed from the global opencode config. Existing sessions keep working; new ones will not see it."
        confirmLabel="Delete"
        onConfirm={() => remove(confirmDelete!)}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
