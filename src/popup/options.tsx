import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './options.css';
import { useAppearance } from '../theme/page-theme';
import { CHARACTERS, REACTOR, REACTOR_THEME, characterById, characterAsset, resolveAppearance } from '../characters';
import { DEFAULT_CLAUDE_MODEL, DEFAULT_GEMINI_MODEL } from '../background/auth';
import { sanitizeProfile, TONES, Tone } from '../background/personalization';

interface Skill { id: string; shortcut: string; name: string; prompt: string }

type Provider = 'claude' | 'gemini' | 'togetherai' | 'openrouter' | 'groq';

const OPENROUTER_MODELS = [
  { id: 'openrouter/free', label: 'Free model router' },
  { id: 'openrouter/auto', label: 'Auto router (selected model may cost money)' },
];

const GROQ_MODELS = [
  { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
  { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B' },
  { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
];

function Options() {
  const [provider, setProvider] = useState<Provider>('claude');
  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [togetherApiKey, setTogetherApiKey] = useState('');
  const [openrouterApiKey, setOpenrouterApiKey] = useState('');
  const [groqApiKey, setGroqApiKey] = useState('');
  const [togetherModel, setTogetherModel] = useState('');
  const [anthropicModel, setAnthropicModel] = useState(DEFAULT_CLAUDE_MODEL);
  const [geminiModel, setGeminiModel] = useState(DEFAULT_GEMINI_MODEL);
  const [openrouterModel, setOpenrouterModel] = useState('openrouter/free');
  const [groqModel, setGroqModel] = useState(GROQ_MODELS[0].id);
  const [handsfree, setHandsfree] = useState(false);
  const [avatar, setAvatar] = useState(() => resolveAppearance(undefined));
  const appearance = useAppearance();          // paints this page in the chosen character's colours
  const character = characterById(appearance);
  const [speechLanguage, setSpeechLanguage] = useState('en-US');
  const [status, setStatus] = useState('');
  // Local-first stack (tiers 0-2). Defaults on — this is what saves the quota.
  const [localFirst, setLocalFirst] = useState(true);
  const [useCache, setUseCache] = useState(true);
  const [useLocalLlm, setUseLocalLlm] = useState(true);
  const [autoIndex, setAutoIndex] = useState(false);
  const [allowedDomains, setAllowedDomains] = useState<string[]>([]);
  const [newDomain, setNewDomain] = useState('');
  const [privacy, setPrivacy] = useState<{ pages: number; memory: Record<string, string> } | null>(null);
  const [memoryQuery, setMemoryQuery] = useState('');
  const [showMemoryValues, setShowMemoryValues] = useState(false);
  const [doctor, setDoctor] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  const [passiveSuggest, setPassiveSuggest] = useState(true);
  const [report, setReport] = useState('');
  // Personalization & memories
  const [profileName, setProfileName] = useState('');
  const [profileAbout, setProfileAbout] = useState('');
  const [profileTone, setProfileTone] = useState<Tone>('default');
  const [profileInstructions, setProfileInstructions] = useState('');
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [memoryDraft, setMemoryDraft] = useState<{ key: string; value: string; previousKey?: string }>({ key: '', value: '' });
  // Web search, skills, private browsing
  const [webSearch, setWebSearch] = useState<'auto' | 'off'>('auto');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillDraft, setSkillDraft] = useState<Partial<Skill> | null>(null);
  const [isolation, setIsolation] = useState<{ allowed: boolean; open: boolean } | null>(null);

  useEffect(() => {
    chrome.storage.local.get([
      'provider', 'anthropicApiKey', 'geminiApiKey',
      'togetherApiKey', 'openrouterApiKey', 'groqApiKey',
      'togetherModel', 'openrouterModel', 'groqModel', 'anthropicModel', 'geminiModel', 'echo_handsfree', 'echo_speech_language', 'echo_avatar',
      'echo_profile', 'echo_memory_enabled'
    ], (result) => {
      const profile = sanitizeProfile(result.echo_profile || {});
      setProfileName(profile.name);
      setProfileAbout(profile.about);
      setProfileTone(profile.tone);
      setProfileInstructions(profile.instructions);
      setMemoryEnabled(result.echo_memory_enabled !== false);
      if (result.provider) setProvider(result.provider as Provider);
      if (result.echo_handsfree) setHandsfree(result.echo_handsfree as boolean);
      setAvatar(resolveAppearance(result.echo_avatar));
      if (result.echo_speech_language) setSpeechLanguage(String(result.echo_speech_language));
      if (result.anthropicApiKey) setAnthropicApiKey(result.anthropicApiKey as string);
      if (result.geminiApiKey) setGeminiApiKey(result.geminiApiKey as string);
      if (result.togetherApiKey) setTogetherApiKey(result.togetherApiKey as string);
      if (result.openrouterApiKey) setOpenrouterApiKey(result.openrouterApiKey as string);
      if (result.groqApiKey) setGroqApiKey(result.groqApiKey as string);
      if (result.togetherModel) setTogetherModel(result.togetherModel as string);
      if (result.openrouterModel) setOpenrouterModel(result.openrouterModel as string);
      if (result.groqModel) setGroqModel(result.groqModel as string);
      if (result.anthropicModel) setAnthropicModel(result.anthropicModel as string);
      if (result.geminiModel) setGeminiModel(result.geminiModel as string);
    });

    // Router settings live under their own key and default to enabled.
    chrome.storage.local.get(['echo_local_settings'], (r) => {
      const s = (r.echo_local_settings || {}) as any;
      setLocalFirst(s.localFirst !== false);
      setUseCache(s.useCache !== false);
      setUseLocalLlm(s.useLocalLlm !== false);
      setAutoIndex(s.autoIndex === true);
      setAllowedDomains(Array.isArray(s.allowedDomains) ? s.allowedDomains : []);
      setPassiveSuggest(s.passiveSuggest !== false);
      setWebSearch(s.webSearch === 'off' ? 'off' : 'auto');
    });
    refreshSkills();
    chrome.runtime.sendMessage({ type: 'ECHO_ISOLATION_STATUS' })
      .then((r: any) => { if (r?.success) setIsolation({ allowed: r.allowed, open: r.open }); })
      .catch(() => {});

    chrome.runtime.sendMessage({ type: 'ECHO_ROUTER_REPORT' })
      .then((r: any) => { if (r?.text) setReport(r.text); })
      .catch(() => {});
    refreshPrivacy();
  }, []);

  const refreshPrivacy = () => {
    chrome.runtime.sendMessage({ type: 'ECHO_PRIVACY_STATUS' })
      .then((r: any) => {
        if (!r?.success) return;
        setPrivacy({ pages: r.pages, memory: r.memory || {} });
        setAllowedDomains(Array.isArray(r.allowedDomains) ? r.allowedDomains : []);
        setAutoIndex(r.autoIndex === true);
      }).catch(() => {});
  };

  const refreshSkills = () => {
    chrome.runtime.sendMessage({ type: 'ECHO_SKILLS_LIST' })
      .then((r: any) => { if (r?.success) setSkills(r.skills); })
      .catch(() => {});
  };

  const saveMemoryDraft = async () => {
    const r: any = await chrome.runtime.sendMessage({ type: 'ECHO_MEMORY_SAVE', ...memoryDraft }).catch(() => null);
    if (!r?.success) { setStatus(r?.error || 'Could not save memory.'); return; }
    setStatus(`Saved "${r.key}".`);
    setMemoryDraft({ key: '', value: '' });
    refreshPrivacy();
  };

  const clearAllMemories = async () => {
    if (!window.confirm('Delete every saved memory? This cannot be undone.')) return;
    const r: any = await chrome.runtime.sendMessage({ type: 'ECHO_MEMORY_CLEAR' }).catch(() => null);
    setStatus(r?.success ? 'All memories deleted.' : r?.error || 'Could not delete memories.');
    refreshPrivacy();
  };

  const saveSkillDraft = async () => {
    const r: any = await chrome.runtime.sendMessage({ type: 'ECHO_SKILL_SAVE', skill: skillDraft }).catch(() => null);
    if (!r?.success) { setStatus(r?.error || 'Could not save skill.'); return; }
    setStatus(`Saved /${r.skill.shortcut}.`);
    setSkillDraft(null);
    refreshSkills();
  };

  const deleteSkill = async (skill: Skill) => {
    if (!window.confirm(`Delete the /${skill.shortcut} skill?`)) return;
    await chrome.runtime.sendMessage({ type: 'ECHO_SKILL_DELETE', id: skill.id }).catch(() => null);
    refreshSkills();
  };

  const resetSkills = async () => {
    if (!window.confirm('Replace your skills with the built-in set?')) return;
    const r: any = await chrome.runtime.sendMessage({ type: 'ECHO_SKILLS_RESET' }).catch(() => null);
    if (r?.success) setSkills(r.skills);
  };

  const privacyAction = async (type: string, host?: string) => {
    if (type === 'ECHO_FORGET_SITE' && !window.confirm(`Stop remembering ${host} and delete its saved pages and highlights?`)) return;
    if (type === 'ECHO_CLEAR_KB' && !window.confirm('Delete every remembered page? This cannot be undone.')) return;
    try {
      const r: any = await chrome.runtime.sendMessage(host ? { type, host } : { type });
      if (!r?.success) throw new Error(r?.error || 'Action failed');
      if (type === 'ECHO_ALLOW_SITE') {
        setNewDomain('');
        setStatus(`Remembering ${r.host}. Reload its tabs to begin saving pages.`);
      } else setStatus('Done.');
      refreshPrivacy();
    } catch (error: any) { setStatus(error?.message || 'Action failed'); }
  };

  const exportData = async () => {
    try {
      const r: any = await chrome.runtime.sendMessage({ type: 'ECHO_EXPORT_DATA' });
      if (!r?.success) throw new Error(r?.error || 'Export failed');
      const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `echo-data-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setStatus('Exported your local Echo data.');
    } catch (error: any) { setStatus(error?.message || 'Export failed'); }
  };

  const eraseAllData = async () => {
    if (!window.confirm('Delete all Echo data, including saved API keys, conversations, workflows, watchers, highlights, and remembered pages? This cannot be undone.')) return;
    try {
      const r: any = await chrome.runtime.sendMessage({ type: 'ECHO_CLEAR_ALL_DATA' });
      if (!r?.success) throw new Error(r?.error || 'Data deletion failed');
      window.location.reload();
    } catch (error: any) { setStatus(error?.message || 'Data deletion failed'); }
  };

  const checkHealth = async () => {
    setChecking(true);
    try {
      const r: any = await chrome.runtime.sendMessage({ type: 'ECHO_DOCTOR' });
      if (!r?.success) throw new Error(r?.error || 'Health check failed');
      setDoctor(r.report);
    } catch (error: any) { setStatus(error?.message || 'Health check failed'); }
    finally { setChecking(false); }
  };

  const saveOptions = async () => {
    try {
    await chrome.storage.local.set({
      provider,
      anthropicApiKey,
      geminiApiKey,
      togetherApiKey,
      openrouterApiKey,
      groqApiKey,
      togetherModel,
      openrouterModel,
      groqModel,
      anthropicModel,
      geminiModel,
      echo_handsfree: handsfree,
      echo_avatar: avatar,
      echo_speech_language: speechLanguage,
      echo_profile: sanitizeProfile({ name: profileName, about: profileAbout, tone: profileTone, instructions: profileInstructions }),
      echo_memory_enabled: memoryEnabled,
    });
    // Patch, not overwrite: the site list is edited live (here and in the side
    // panel), so saving must not write back a stale copy of it.
    const r: any = await chrome.runtime.sendMessage({ type: 'ECHO_SET_SETTINGS',
      patch: { localFirst, useCache, useLocalLlm, autoIndex, passiveSuggest, webSearch } });
    if (!r?.success) throw new Error(r?.error || 'settings not saved');
    setStatus('Saved');
    setTimeout(() => setStatus(''), 2000);
    } catch (error: any) { setStatus(`Save failed: ${error?.message || 'storage unavailable'}`); }
  };

  const pickAppearance = (id: string) => {
    setAvatar(id);
    chrome.storage.local.set({ echo_avatar: id }).catch(() => {});
  };

  const providerHelp = {
    claude: <>Get a key at <a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com</a>.</>,
    gemini: <>Get a key at <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com</a>.</>,
    togetherai: <>Get a key at <a href="https://api.together.xyz" target="_blank">api.together.xyz</a>.</>,
    openrouter: <>Get a key at <a href="https://openrouter.ai/keys" target="_blank">openrouter.ai</a>.</>,
    groq: <>Get a key at <a href="https://console.groq.com/keys" target="_blank">console.groq.com</a>.</>,
  }[provider];

  return (
    <div className="settings">
      <header className="settings-hero">
        <span className="hero-portrait">
          {character ? <img src={characterAsset(character.id, 'portrait')} alt="" /> : <span className="mini-reactor" />}
        </span>
        <div>
          <h2>Settings</h2>
          <p>{character ? `${character.name} · ${character.tagline}` : 'Reactor · The classic arc-reactor orb'}</p>
        </div>
      </header>

      <Group title="Appearance" footer="Characters follow your cursor, talk, blink, think and laugh. Every ECHO panel takes on their colours.">
        <div className="appearance-grid" role="radiogroup" aria-label="Appearance">
          {[...CHARACTERS.map(c => ({ id: c.id, name: c.name, tagline: c.tagline, theme: c.theme })),
            { id: REACTOR, name: 'Reactor', tagline: 'The classic arc-reactor orb', theme: REACTOR_THEME }].map(o => (
            <button key={o.id} type="button" role="radio" aria-checked={avatar === o.id}
              className={`appearance-card${avatar === o.id ? ' on' : ''}`}
              style={{ '--c1': o.theme.accent, '--c2': o.theme.accent2 } as React.CSSProperties}
              onClick={() => pickAppearance(o.id)}>
              <span className="appearance-art">
                {o.id === REACTOR ? <span className="mini-reactor" /> : <img src={characterAsset(o.id, 'portrait')} alt="" />}
              </span>
              <span className="appearance-name">{o.name}</span>
              <span className="appearance-tag">{o.tagline}</span>
            </button>
          ))}
        </div>
      </Group>

      <Group title="AI Provider" footer={providerHelp}>
        <Row label="Provider" htmlFor="provider">
          <select id="provider" value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
            <option value="claude">Anthropic Claude</option>
            <option value="gemini">Google Gemini</option>
            <option value="groq">Groq</option>
            <option value="togetherai">Together AI</option>
            <option value="openrouter">OpenRouter</option>
          </select>
        </Row>
        {provider === 'claude' && (<>
          <Row label="API Key" htmlFor="key-claude">
            <input id="key-claude" type="password" value={anthropicApiKey} onChange={(e) => setAnthropicApiKey(e.target.value)} placeholder="sk-ant-…" />
          </Row>
          <Row label="Model" htmlFor="model-claude">
            <input id="model-claude" value={anthropicModel} onChange={e => setAnthropicModel(e.target.value)} />
          </Row>
        </>)}
        {provider === 'gemini' && (<>
          <Row label="API Key" htmlFor="key-gemini">
            <input id="key-gemini" type="password" value={geminiApiKey} onChange={(e) => setGeminiApiKey(e.target.value)} placeholder="AIzaSy…" />
          </Row>
          <Row label="Model" htmlFor="model-gemini">
            <input id="model-gemini" value={geminiModel} onChange={e => setGeminiModel(e.target.value)} />
          </Row>
        </>)}
        {provider === 'togetherai' && (<>
          <Row label="API Key" htmlFor="key-together">
            <input id="key-together" type="password" value={togetherApiKey} onChange={(e) => setTogetherApiKey(e.target.value)} placeholder="together-…" />
          </Row>
          <Row label="Model" htmlFor="model-together">
            <input id="model-together" value={togetherModel} onChange={e => setTogetherModel(e.target.value)} placeholder="Current Together AI model ID" />
          </Row>
        </>)}
        {provider === 'openrouter' && (<>
          <Row label="API Key" htmlFor="key-openrouter">
            <input id="key-openrouter" type="password" value={openrouterApiKey} onChange={(e) => setOpenrouterApiKey(e.target.value)} placeholder="sk-or-…" />
          </Row>
          <Row label="Model" htmlFor="model-openrouter">
            <select id="model-openrouter" value={openrouterModel} onChange={(e) => setOpenrouterModel(e.target.value)}>
              {!OPENROUTER_MODELS.some(m => m.id === openrouterModel) && <option value={openrouterModel}>{openrouterModel} (saved)</option>}
              {OPENROUTER_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </Row>
        </>)}
        {provider === 'groq' && (<>
          <Row label="API Key" htmlFor="key-groq">
            <input id="key-groq" type="password" value={groqApiKey} onChange={(e) => setGroqApiKey(e.target.value)} placeholder="gsk_…" />
          </Row>
          <Row label="Model" htmlFor="model-groq">
            <select id="model-groq" value={groqModel} onChange={(e) => setGroqModel(e.target.value)}>
              {!GROQ_MODELS.some(m => m.id === groqModel) && <option value={groqModel}>{groqModel} (saved; check availability)</option>}
              {GROQ_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </Row>
        </>)}
      </Group>

      <Group title="Local Brain" footer={report ? report : 'Answers that ECHO can find on your device never use your API quota.'}>
        <Toggle id="localFirst" checked={localFirst} onChange={setLocalFirst} label="Answer locally first"
          hint="Try instant, cached and on-device answers before the cloud." />
        <Toggle id="useCache" checked={useCache} onChange={setUseCache} label="Reuse past answers"
          hint="Replay a stored answer when you ask the same thing again." />
        <Toggle id="useLocalLlm" checked={useLocalLlm} onChange={setUseLocalLlm} label="On-device summarising"
          hint="Uses Chrome's built-in AI when available." />
        <Toggle id="autoIndex" checked={autoIndex} onChange={setAutoIndex} label="Remember pages you read"
          hint="Only on sites you allow under Privacy." />
        <Toggle id="passiveSuggest" checked={passiveSuggest} onChange={setPassiveSuggest} label="Proactive suggestions"
          hint="Offer help with long articles and empty forms." />
      </Group>

      <Group title="Voice" footer="Web search uses Claude's search tool or Gemini's Google Search. Your provider may bill each search.">
        <Toggle id="handsfree" checked={handsfree} onChange={setHandsfree} label="Hands-free mode"
          hint="Listen again after ECHO finishes speaking." />
        <Row label="Language" htmlFor="speech-language">
          <select id="speech-language" value={speechLanguage} onChange={e => setSpeechLanguage(e.target.value)}>
            <option value="en-US">English (US)</option><option value="en-GB">English (UK)</option>
            <option value="hi-IN">Hindi</option><option value="te-IN">Telugu</option>
            <option value="ta-IN">Tamil</option><option value="bn-IN">Bengali</option>
            <option value="es-ES">Spanish</option><option value="fr-FR">French</option><option value="de-DE">German</option>
          </select>
        </Row>
        <Row label="Web search" htmlFor="web-search">
          <select id="web-search" value={webSearch} onChange={e => setWebSearch(e.target.value as 'auto' | 'off')}>
            <option value="auto">Automatic</option>
            <option value="off">Only when I ask</option>
          </select>
        </Row>
      </Group>

      <Group title="Personalization" footer="ECHO adds this to its instructions so answers fit you. Stored only on this device.">
        <Row label="Your name" htmlFor="profile-name">
          <input id="profile-name" value={profileName} maxLength={60} onChange={e => setProfileName(e.target.value)} placeholder="What should ECHO call you?" />
        </Row>
        <Row label="Answer style" htmlFor="profile-tone">
          <select id="profile-tone" value={profileTone} onChange={e => setProfileTone(e.target.value as Tone)}>
            {(Object.keys(TONES) as Tone[]).map(t => <option key={t} value={t}>{TONES[t].label}</option>)}
          </select>
        </Row>
        <Row label="About you" htmlFor="profile-about" stacked>
          <textarea id="profile-about" value={profileAbout} maxLength={400} rows={2} onChange={e => setProfileAbout(e.target.value)}
            placeholder="e.g. Student in Hyderabad learning web development" />
        </Row>
        <Row label="Always keep in mind" htmlFor="profile-instructions" stacked>
          <textarea id="profile-instructions" value={profileInstructions} maxLength={800} rows={2} onChange={e => setProfileInstructions(e.target.value)}
            placeholder="e.g. Prefer metric units. Explain code with short examples." />
        </Row>
        <Toggle id="memoryEnabled" checked={memoryEnabled} onChange={setMemoryEnabled} label="Use memories in answers"
          hint="Private-window tasks never see them." />
      </Group>

      <Group title={`Memories (${Object.keys(privacy?.memory || {}).length})`}
        footer={`Facts ECHO remembers across chats. You can also say "remember my city is Hyderabad".${!memoryEnabled ? ' Memories are currently not used in answers.' : ''}`}>
        <form className="row inline-form" onSubmit={e => { e.preventDefault(); saveMemoryDraft(); }}>
          <input value={memoryDraft.key} maxLength={40} onChange={e => setMemoryDraft({ ...memoryDraft, key: e.target.value })} placeholder="Name" aria-label="Memory name" />
          <input value={memoryDraft.value} maxLength={500} onChange={e => setMemoryDraft({ ...memoryDraft, value: e.target.value })} placeholder="Value" aria-label="Memory value" />
          {memoryDraft.previousKey && <button type="button" className="plain" onClick={() => setMemoryDraft({ key: '', value: '' })}>Cancel</button>}
          <button type="submit" className="plain" disabled={!memoryDraft.key.trim() || !memoryDraft.value.trim()}>{memoryDraft.previousKey ? 'Update' : 'Add'}</button>
        </form>
        {Object.keys(privacy?.memory || {}).length > 0 && (
          <div className="row inline-form">
            <input className="search" value={memoryQuery} onChange={e => setMemoryQuery(e.target.value)} placeholder="Search" aria-label="Search memories" />
            <label className="check"><input type="checkbox" className="switch small" checked={showMemoryValues} onChange={e => setShowMemoryValues(e.target.checked)} /> Show values</label>
          </div>
        )}
        {Object.entries(privacy?.memory || {})
          .filter(([key, value]) => (key + ' ' + value).toLowerCase().includes(memoryQuery.toLowerCase()))
          .map(([key, value]) => (
            <div className="row" key={key}>
              <span className="row-text"><span className="row-label">{key.replace(/_/g, ' ')}</span>{showMemoryValues && <small>{value}</small>}</span>
              <span className="row-control buttons">
                <button className="plain" onClick={() => setMemoryDraft({ key: key.replace(/_/g, ' '), value, previousKey: key })}>Edit</button>
                <button className="plain destructive" onClick={async () => {
                  const r: any = await chrome.runtime.sendMessage({ type: 'ECHO_DELETE_MEMORY', key }).catch(() => null);
                  setStatus(r?.success ? `Forgot ${key}.` : r?.error || 'Could not forget fact.');
                  refreshPrivacy();
                }}>Forget</button>
              </span>
            </div>
          ))}
        {Object.keys(privacy?.memory || {}).length > 0 && (
          <div className="row"><button className="plain destructive" onClick={clearAllMemories}>Delete All Memories…</button></div>
        )}
      </Group>

      <Group title={`Skills (${skills.length})`} footer={<>Saved prompts. Type <b>/</b> in the side panel, the page box, or the address bar after <b>echo</b> to run one.</>}>
        {skills.map(skill => (
          <div className="row" key={skill.id}>
            <span className="row-text"><span className="row-label"><span className="mono">/{skill.shortcut}</span> {skill.name}</span></span>
            <span className="row-control buttons">
              <button className="plain" onClick={() => setSkillDraft(skill)}>Edit</button>
              <button className="plain destructive" onClick={() => deleteSkill(skill)}>Delete</button>
            </span>
          </div>
        ))}
        {skillDraft ? (
          <form className="row stacked editor" onSubmit={e => { e.preventDefault(); saveSkillDraft(); }}>
            <input value={skillDraft.shortcut || ''} maxLength={32} placeholder="Shortcut (letters, numbers, -)" aria-label="Shortcut"
              onChange={e => setSkillDraft({ ...skillDraft, shortcut: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} />
            <input value={skillDraft.name || ''} maxLength={60} placeholder="Name" aria-label="Skill name"
              onChange={e => setSkillDraft({ ...skillDraft, name: e.target.value })} />
            <textarea value={skillDraft.prompt || ''} maxLength={2000} rows={3} placeholder="Prompt, e.g. Summarize this page for a 10-year-old." aria-label="Prompt"
              onChange={e => setSkillDraft({ ...skillDraft, prompt: e.target.value })} />
            <span className="buttons end">
              <button type="button" className="secondary" onClick={() => setSkillDraft(null)}>Cancel</button>
              <button type="submit" className="primary">Save Skill</button>
            </span>
          </form>
        ) : (
          <div className="row">
            <button className="plain" onClick={() => setSkillDraft({})}>New Skill…</button>
            <button className="plain" onClick={resetSkills}>Restore Built-in Skills</button>
          </div>
        )}
      </Group>

      <Group title="Privacy" footer="Remembered pages stay on this device. Private mail and document sites are excluded. Export never includes your API keys.">
        <Row label="Remembered pages"><span className="value">{privacy?.pages ?? 0}</span></Row>
        <form className="row inline-form" onSubmit={e => { e.preventDefault(); if (newDomain.trim()) privacyAction('ECHO_ALLOW_SITE', newDomain.trim()); }}>
          <input value={newDomain} onChange={e => setNewDomain(e.target.value)} placeholder="Allow a site, e.g. example.com" aria-label="Add a site" />
          <button type="submit" className="plain" disabled={!newDomain.trim()}>Add</button>
        </form>
        {allowedDomains.map(domain => (
          <div className="row" key={domain}>
            <span className="row-text"><span className="row-label">{domain}</span></span>
            <button className="plain destructive" onClick={() => privacyAction('ECHO_FORGET_SITE', domain)}>Forget</button>
          </div>
        ))}
        <div className="row"><button className="plain" onClick={exportData}>Export My ECHO Data…</button></div>
        <div className="row"><button className="plain destructive" onClick={() => privacyAction('ECHO_CLEAR_KB')}>Delete Remembered Pages</button></div>
        <div className="row"><button className="plain destructive" onClick={() => privacyAction('ECHO_CLEAR_CACHE')}>Delete Cached Answers</button></div>
        <div className="row"><button className="plain destructive" onClick={eraseAllData}>Delete All ECHO Data…</button></div>
      </Group>

      <OpenClawGroup />

      <Group title="Private Agent Browsing" footer="Tasks run in a separate private window: no cookies, logins or history from your normal browsing, HTTPS only, and ECHO still asks before paying or sending anything.">
        <Row label="Status">
          <span className="value">{isolation == null ? 'Checking…' : isolation.allowed ? 'Ready' : 'Needs "Allow in Incognito"'}</span>
        </Row>
        {isolation && !isolation.allowed && (
          <div className="row"><button className="plain" onClick={() => chrome.runtime.sendMessage({ type: 'ECHO_OPEN_EXTENSION_DETAILS' }).catch(() => {})}>Open Extension Settings…</button></div>
        )}
      </Group>

      <Group title="Diagnostics" footer="Checks your provider, key and model without sending a prompt or spending tokens.">
        <Row label="Health check">
          <button className="secondary" onClick={checkHealth} disabled={checking}>{checking ? 'Checking…' : 'Run'}</button>
        </Row>
        {doctor && (
          <div className="row stacked report" role="status">
            <span>Browser permissions: {doctor.permissions}</span>
            <span>Current tab: {doctor.tab}</span>
            <span>Provider: {doctor.provider}</span>
            <span>API key: {doctor.key}</span>
            <span>Model: {doctor.model} — {doctor.modelStatus}</span>
            {doctor.note && <span>{doctor.note}</span>}
          </div>
        )}
      </Group>

      <Group title="Shortcuts">
        <Row label="Wake ECHO" hint="Or press ⌘⇧E on any webpage.">
          <button className="secondary" onClick={() => {
            // Route through the background service worker so it flips the global
            // wake state and broadcasts to the active tab's content script.
            chrome.runtime.sendMessage({ type: 'WAKE_ECHO_REQUEST' }, () => {
              window.close();
            });
          }}>Wake Now</button>
        </Row>
        <Row label="Address bar" hint="Type echo, press Space, then ask or type a /skill." />
      </Group>

      <div className="save-bar">
        {status && <span className="status-msg" role="status">{status}</span>}
        <button className="primary" onClick={saveOptions}>Save</button>
      </div>
    </div>
  );
}

// ---- OpenClaw agents ----
// Self-contained: saves as you go, independent of the page's Save button.

interface GatewayState { kind: string; requestId?: string; code?: string; message?: string; willRetry?: boolean }
interface OpenClawStatus {
  enabled: boolean; url: string; hasToken: boolean; node: GatewayState; operator: GatewayState;
  serverVersion?: string; testedVersion: string; commands: { state: string; requestId?: string }; ready: boolean;
}

const OC = 'openclaw --profile echo';

// What a gateway error means for the user, in ECHO's words.
const GATEWAY_ERRORS: Record<string, string> = {
  AUTH_TOKEN_MISSING: 'needs the gateway token',
  AUTH_TOKEN_MISMATCH: 'the gateway token is wrong',
  AUTH_DEVICE_TOKEN_MISMATCH: 'pairing was reset: paste the gateway token again',
  AUTH_UNAUTHORIZED: 'not authorised: paste the gateway token',
  CONTROL_UI_ORIGIN_NOT_ALLOWED: 'the gateway does not know this ECHO yet: run the setup script',
  PROTOCOL_MISMATCH: 'this OpenClaw version is not supported',
  CLIENT_VERSION_MISMATCH: 'this OpenClaw version is not supported',
  INSECURE_URL: 'the gateway must be on this computer or use wss://',
  CLOSED: 'gateway not running', SOCKET: 'gateway not running',
};

function describeRole(s: GatewayState): string {
  switch (s.kind) {
    case 'connected': return 'connected';
    case 'connecting': return 'connecting…';
    case 'pairing-required': return 'waiting for approval on the gateway';
    case 'stopped': return 'off';
    default: return GATEWAY_ERRORS[s.code || ''] || `error (${s.code || 'unknown'})`;
  }
}

function CopyLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="row copy-line">
      <code>{command}</code>
      <button className="plain" onClick={() => navigator.clipboard.writeText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
        {copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

function OpenClawGroup() {
  const [status, setStatus] = useState<OpenClawStatus | null>(null);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [script, setScript] = useState('');
  const [note, setNote] = useState('');

  const refresh = () => chrome.runtime.sendMessage({ type: 'ECHO_OPENCLAW_STATUS' })
    .then((r: any) => { if (r?.success) { setStatus(r.status); setUrl(u => u || r.status.url); } })
    .catch(() => {});
  useEffect(() => {
    refresh();
    const onMessage = (m: any) => { if (m?.type === 'ECHO_OPENCLAW_STATUS_CHANGED') refresh(); };
    chrome.runtime.onMessage.addListener(onMessage);
    const timer = setInterval(refresh, 3000);
    return () => { chrome.runtime.onMessage.removeListener(onMessage); clearInterval(timer); };
  }, []);

  const save = (patch: Record<string, unknown>) => chrome.runtime.sendMessage({ type: 'ECHO_OPENCLAW_SAVE', ...patch })
    .then((r: any) => { if (r?.success) { setStatus(r.status); setNote(''); } else setNote(r?.error || 'Could not save.'); })
    .catch(error => setNote(error?.message || 'Could not save.'));

  const showScript = () => chrome.runtime.sendMessage({ type: 'ECHO_OPENCLAW_SETUP_SCRIPT' })
    .then((r: any) => { if (r?.success) setScript(r.script); }).catch(() => {});

  const pairing = [status?.operator, status?.node].find(s => s?.kind === 'pairing-required');
  const needsToken = !!status?.enabled && !status.hasToken && status.operator.kind !== 'connected';
  const versionNote = status?.serverVersion && status.serverVersion !== status.testedVersion
    ? `Gateway ${status.serverVersion}; ECHO was tested with ${status.testedVersion}.` : '';

  return (
    <Group title="OpenClaw Agents" footer={'Each avatar you assign to a tab becomes an OpenClaw agent that works in that tab. Your gateway runs on this computer; ECHO still asks before paying or sending anything.'
      + (versionNote ? `\n${versionNote}` : '')}>
      <Toggle id="openclaw-enabled" checked={!!status?.enabled} onChange={v => save({ enabled: v })}
        label="Use OpenClaw for avatars" hint={status?.ready ? 'Ready: avatars run as OpenClaw agents.' : 'Avatars use ECHO\'s built-in brain until the gateway is ready.'} />
      {status?.enabled && (<>
        <Row label="Gateway" htmlFor="openclaw-url">
          <input id="openclaw-url" value={url} onChange={e => setUrl(e.target.value)} onBlur={() => url !== status.url && save({ url })} />
        </Row>
        <Row label="Connection" hint={`Agents: ${describeRole(status.operator)} · Tools: ${describeRole(status.node)}`}>
          <span className="value">{status.ready ? 'Ready' : 'Not ready'}</span>
        </Row>
        {(needsToken || status.hasToken) && (
          <form className="row inline-form" onSubmit={e => { e.preventDefault(); if (token.trim()) { save({ sharedToken: token }); setToken(''); } }}>
            <input type="password" value={token} onChange={e => setToken(e.target.value)} aria-label="Gateway token"
              placeholder={status.hasToken ? 'Saved until pairing finishes, then deleted' : 'Paste the gateway token'} />
            <button type="submit" className="plain" disabled={!token.trim()}>Save</button>
          </form>
        )}
        {needsToken && <CopyLine command={`${OC} gateway auth-token --show`} />}
        {pairing?.requestId && (<>
          <Row label="Approve ECHO on the gateway" hint="Run this in Terminal on this computer." />
          <CopyLine command={`${OC} devices approve ${pairing.requestId}`} />
        </>)}
        {status.node.kind === 'connected' && status.commands.state === 'pending' && (<>
          <Row label="Approve ECHO's avatar tools" hint="A second approval, for the tools each avatar may use." />
          <CopyLine command={status.commands.requestId ? `${OC} nodes approve ${status.commands.requestId}` : `${OC} nodes pending`} />
        </>)}
        <Row label="Gateway setup" hint="Configures ECHO's gateway profile: its agents, their tools and this extension's id.">
          <button className="secondary" onClick={showScript}>Show Script</button>
        </Row>
        {script && (
          <div className="row stacked">
            <textarea className="setup-script" readOnly value={script} rows={8} aria-label="Gateway setup script" />
            <button className="plain" onClick={() => navigator.clipboard.writeText(script).then(() => setNote('Script copied. Save it as echo-setup.sh and run: bash echo-setup.sh'))}>Copy Script</button>
          </div>
        )}
        {note && <div className="row"><span className="value">{note}</span></div>}
      </>)}
    </Group>
  );
}

// ---- macOS System Settings building blocks ----
// Module-level so React keeps inputs mounted (and focused) between renders.

function Group({ title, footer, children }: { title?: string; footer?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="group-section">
      {title && <h3 className="group-title">{title}</h3>}
      <div className="group">{children}</div>
      {footer && <p className="group-footer">{footer}</p>}
    </section>
  );
}

function Row({ label, htmlFor, hint, stacked, children }: {
  label: string; htmlFor?: string; hint?: string; stacked?: boolean; children?: React.ReactNode;
}) {
  return (
    <div className={`row${stacked ? ' stacked' : ''}`}>
      <span className="row-text">
        <label className="row-label" htmlFor={htmlFor}>{label}</label>
        {hint && <small>{hint}</small>}
      </span>
      {children && <span className="row-control">{children}</span>}
    </div>
  );
}

function Toggle({ id, checked, onChange, label, hint }: {
  id: string; checked: boolean; onChange: (v: boolean) => void; label: string; hint: string;
}) {
  return (
    <Row label={label} htmlFor={id} hint={hint}>
      <input id={id} type="checkbox" role="switch" className="switch" checked={checked} onChange={e => onChange(e.target.checked)} />
    </Row>
  );
}


const root = createRoot(document.getElementById('popup-root')!);
root.render(<Options />);
