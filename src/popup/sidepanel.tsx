import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import './sidepanel.css';
import { useAppearance } from '../theme/page-theme';
import { ICONS } from '../theme/icons';
import { characterById, characterAsset } from '../characters';

interface Source { title: string; url: string }
interface Msg { role: 'user' | 'echo'; text: string; ts?: number; tier?: number; sources?: Source[]; searchHtml?: string }
interface Approval { id: string; action: string; detail: string; site: string }
interface ActionLog { action: string; detail: string; status: string; ts: number }
interface ChatInfo { activeId: string | null; temporary: boolean; title: string }
interface ChatMeta { id: string; title: string; updated: number; count: number }
interface Skill { id: string; shortcut: string; name: string; prompt: string }
interface TabItem { id: number; title: string; url: string; favIconUrl?: string }
interface Menu { kind: 'skill' | 'tab'; start: number; query: string; index: number }

// Which brain answered. Tier 3 is the only one that spends API quota.
const TIERS: Record<number, { label: string; title: string; cls: string }> = {
  0: { label: 'instant', title: 'Answered locally — no AI, no API', cls: 't0' },
  1: { label: 'cached', title: 'Replayed from a stored answer — no API', cls: 't1' },
  2: { label: 'on-device', title: 'Answered by the on-device model — no API', cls: 't2' },
  3: { label: 'cloud', title: 'Answered by the cloud API — used quota', cls: 't3' },
};

const safeUrl = (url: string) => /^https?:\/\//i.test(url);
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
const when = (ts: number) => {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().split(/\s+/).slice(0, 3).join('-').slice(0, 32);

/** Message text with [n] citation markers turned into links to their sources. */
function Cited({ text, sources }: { text: string; sources?: Source[] }) {
  if (!sources?.length) return <>{text}</>;
  return <>{text.split(/(\[\d+\])/g).map((part, i) => {
    const n = part.match(/^\[(\d+)\]$/)?.[1];
    const src = n ? sources[Number(n) - 1] : undefined;
    return src && safeUrl(src.url)
      ? <a key={i} className="echo-cite" href={src.url} target="_blank" rel="noopener noreferrer" title={src.title}>{n}</a>
      : <React.Fragment key={i}>{part}</React.Fragment>;
  })}</>;
}

function Panel() {
  const appearance = useAppearance();
  const character = characterById(appearance);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [chat, setChat] = useState<ChatInfo>({ activeId: null, temporary: false, title: 'New chat' });
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('');
  const [usage, setUsage] = useState<{ steps: number; taskTokens: number; sessionTokens: number } | null>(null);
  const [report, setReport] = useState('');
  const [approval, setApproval] = useState<Approval | null>(null);
  const [actions, setActions] = useState<ActionLog[]>([]);
  const [site, setSite] = useState<{ url: string; host: string; allowed: boolean; eligible: boolean } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<ChatMeta[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [tabs, setTabs] = useState<TabItem[]>([]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [mentions, setMentions] = useState<TabItem[]>([]);
  const [webSearch, setWebSearch] = useState(false);
  const [isolated, setIsolated] = useState(false);
  const [isolation, setIsolation] = useState<{ allowed: boolean; open: boolean } | null>(null);
  const [skillDraft, setSkillDraft] = useState<{ name: string; shortcut: string; prompt: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const fmt = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
  const flash = (text: string) => {
    setStatus(text);
    setTimeout(() => setStatus(s => (s === text ? '' : s)), 4000);
  };

  const refreshReport = () => {
    chrome.runtime.sendMessage({ type: 'ECHO_ROUTER_REPORT' })
      .then((r: any) => { if (r?.text) setReport(r.text); })
      .catch(() => {});
  };
  const refreshSkills = () => {
    chrome.runtime.sendMessage({ type: 'ECHO_SKILLS_LIST' })
      .then((r: any) => { if (r?.success) setSkills(r.skills); })
      .catch(() => {});
  };
  const refreshIsolation = () => {
    chrome.runtime.sendMessage({ type: 'ECHO_ISOLATION_STATUS' })
      .then((r: any) => { if (r?.success) setIsolation({ allowed: r.allowed, open: r.open }); })
      .catch(() => {});
  };
  const applyChatState = (state: any) => {
    if (!state) return;
    setChat({ activeId: state.activeId, temporary: !!state.temporary, title: state.title || 'New chat' });
    setMessages(Array.isArray(state.messages) ? state.messages : []);
  };

  // Page memory is per-site opt-in; this panel is where you can see the site.
  const refreshSite = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tab?.url || '';
      const r: any = await chrome.runtime.sendMessage({ type: 'ECHO_PRIVACY_STATUS', url });
      setSite(r?.success && r.host ? { url, host: r.host, allowed: r.siteAllowed, eligible: r.siteEligible } : null);
    } catch { setSite(null); }
  };

  const toggleSite = async () => {
    if (!site) return;
    if (site.allowed && !window.confirm(`Stop remembering ${site.host} and delete its saved pages and highlights?`)) return;
    try {
      const r: any = await chrome.runtime.sendMessage({ type: site.allowed ? 'ECHO_FORGET_SITE' : 'ECHO_ALLOW_SITE', url: site.url });
      if (!r?.success) throw new Error(r?.error || 'Could not update this site.');
      flash(site.allowed ? `Forgot ${r.host}.` : `Remembering ${r.host}. Reload the tab to save this page.`);
    } catch (error: any) { setStatus(error?.message || 'Could not update this site.'); }
    refreshSite();
  };

  useEffect(() => {
    refreshSite();
    const onActivated = () => { refreshSite(); };
    const onUpdated = (_id: number, change: { url?: string }, tab: chrome.tabs.Tab) => {
      if (change.url && tab.active) refreshSite();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  // Load the active chat on open, then listen for live updates.
  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'ECHO_CHAT_STATE_REQUEST' })
      .then((r: any) => { if (r?.success) applyChatState(r.state); })
      .catch(() => {});
    chrome.storage.local.get(['echo_action_log'], r => {
      if (Array.isArray(r.echo_action_log)) setActions(r.echo_action_log.slice(-8));
    });
    refreshReport();
    refreshSkills();
    refreshIsolation();
    chrome.runtime.sendMessage({ type: 'ECHO_TASK_STATUS_REQUEST' })
      .then((r: any) => { if (r?.active) setStatus('Working…'); })
      .catch(() => {});
    chrome.runtime.sendMessage({ type: 'ECHO_PENDING_APPROVAL' })
      .then((r: any) => { if (r?.approval) setApproval(r.approval); })
      .catch(() => {});

    const onMessage = (m: any) => {
      if (m.type === 'ECHO_SAY') {
        setMessages(prev => [...prev, { role: 'echo', text: m.text, tier: m.tier, sources: m.sources, searchHtml: m.searchHtml }]);
        refreshReport();
        refreshIsolation();
      } else if (m.type === 'ECHO_USER_ECHO') {
        setMessages(prev => [...prev, { role: 'user', text: m.text }]);
      } else if (m.type === 'ECHO_STATE') {
        setStatus(m.state === 'Idle' ? '' : m.state);
      } else if (m.type === 'ECHO_USAGE') {
        setUsage({ steps: m.steps, taskTokens: m.taskTokens, sessionTokens: m.sessionTokens });
      } else if (m.type === 'ECHO_APPROVAL_REQUEST') {
        setApproval({ id: m.id, action: m.action, detail: m.detail, site: m.site });
      } else if (m.type === 'ECHO_APPROVAL_CLEAR') {
        setApproval(prev => prev?.id === m.id ? null : prev);
      } else if (m.type === 'ECHO_ACTION_LOG') {
        setActions(prev => [...prev, m.entry].slice(-8));
      } else if (m.type === 'ECHO_CHAT_STATE') {
        applyChatState(m.state);
      } else if (m.type === 'ECHO_CONVERSATION_CLEARED') {
        setMessages([]);
        setStatus('');
      } else if (m.type === 'ECHO_TASK_STATUS' && !m.active) {
        setStatus('');
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, status]);

  // --- chats --------------------------------------------------------------------

  const openHistory = () => {
    if (historyOpen) { setHistoryOpen(false); return; }
    chrome.runtime.sendMessage({ type: 'ECHO_CHAT_LIST' })
      .then((r: any) => { if (r?.success) { setHistory(r.chats); setHistoryOpen(true); } })
      .catch(error => setStatus(`Could not load history: ${error?.message || 'extension unavailable'}`));
  };
  const startChat = (temporary: boolean) => {
    chrome.runtime.sendMessage({ type: 'ECHO_CHAT_NEW', temporary })
      .then((r: any) => { if (r?.success) { applyChatState(r.state); setHistoryOpen(false); setStatus(''); } })
      .catch(error => setStatus(`Could not start a chat: ${error?.message || 'extension unavailable'}`));
  };
  const openChat = (id: string) => {
    chrome.runtime.sendMessage({ type: 'ECHO_CHAT_OPEN', id })
      .then((r: any) => {
        if (!r?.success) throw new Error(r?.error || 'Could not open chat');
        applyChatState(r.state);
        setHistoryOpen(false);
      })
      .catch(error => setStatus(error?.message || 'Could not open chat'));
  };
  const deleteChat = (id: string) => {
    chrome.runtime.sendMessage({ type: 'ECHO_CHAT_DELETE', id })
      .then((r: any) => { if (r?.success) setHistory(r.chats); })
      .catch(() => {});
  };
  const deleteAllChats = () => {
    if (!window.confirm('Delete every saved chat? This cannot be undone.')) return;
    chrome.runtime.sendMessage({ type: 'ECHO_CHAT_DELETE_ALL' })
      .then(() => { setHistory([]); setHistoryOpen(false); })
      .catch(() => {});
  };

  // --- "/" skills and "@" tab menus -----------------------------------------------

  const menuItems = (): (Skill | TabItem)[] => {
    if (!menu) return [];
    const q = menu.query.toLowerCase();
    if (menu.kind === 'skill') {
      return skills.filter(s => s.shortcut.startsWith(q) || s.name.toLowerCase().includes(q)).slice(0, 8);
    }
    return tabs.filter(t => !mentions.some(m => m.id === t.id)
      && (t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q))).slice(0, 8);
  };

  const updateMenu = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const skill = before.match(/^\/([a-z0-9-]*)$/i);
    if (skill) { setMenu({ kind: 'skill', start: 0, query: skill[1], index: 0 }); refreshSkills(); return; }
    const at = before.match(/(^|\s)@([^\s@]*)$/);
    if (at) {
      const start = caret - at[2].length - 1;
      setMenu(prev => ({ kind: 'tab', start, query: at[2], index: prev?.kind === 'tab' ? prev.index : 0 }));
      if (!menu || menu.kind !== 'tab') {
        chrome.tabs.query({ currentWindow: true }).then(list => setTabs(list
          .filter(t => t.id != null && /^https?:/i.test(t.url || ''))
          .map(t => ({ id: t.id!, title: t.title || hostOf(t.url || ''), url: t.url || '', favIconUrl: t.favIconUrl }))));
      }
      return;
    }
    setMenu(null);
  };

  const choose = (item: Skill | TabItem) => {
    if (!menu) return;
    if (menu.kind === 'skill') {
      setInput(`/${(item as Skill).shortcut} `);
    } else {
      const caret = inputRef.current?.selectionStart ?? input.length;
      setInput(input.slice(0, menu.start) + input.slice(caret).replace(/^\s*/, ''));
      setMentions(prev => [...prev, item as TabItem].slice(0, 5));
    }
    setMenu(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const items = menuItems();
    if (!menu || !items.length) {
      if (e.key === 'Backspace' && !input && mentions.length) setMentions(prev => prev.slice(0, -1));
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setMenu({ ...menu, index: (menu.index + delta + items.length) % items.length });
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      choose(items[Math.min(menu.index, items.length - 1)]);
    } else if (e.key === 'Escape') {
      setMenu(null);
    }
  };

  // --- sending ---------------------------------------------------------------------

  const send = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const text = input.trim();
    if (!text || (menu && menuItems().length)) return;
    chrome.runtime.sendMessage({
      type: 'USER_INPUT', text,
      tabs: mentions.map(m => m.id), webSearch, isolated,
    }).catch(error => {
      setStatus(`Could not send: ${error?.message || 'extension unavailable'}`);
      setInput(text);
    });
    setInput('');
    setMentions([]);
    setWebSearch(false);
    setIsolated(false);
    setMenu(null);
    setStatus(isolated ? 'Opening the private window…' : webSearch ? 'Searching the web…' : 'Thinking...');
    setUsage(u => (u ? { ...u, steps: 0, taskTokens: 0 } : u)); // reset task portion; keep session
  };

  const answerApproval = (approved: boolean) => {
    if (!approval) return;
    chrome.runtime.sendMessage({ type: 'ECHO_APPROVAL_RESPONSE', id: approval.id, approved })
      .catch(() => {});
    setApproval(null);
  };

  const draftSkillFrom = (text: string) => {
    const prompt = text.replace(/\nAttached: .*$/s, '').replace(/^Private window · /, '').trim();
    setSkillDraft({ prompt, name: prompt.split('\n')[0].slice(0, 40), shortcut: slug(prompt) || 'my-skill' });
  };
  const saveSkillDraft = () => {
    if (!skillDraft) return;
    chrome.runtime.sendMessage({ type: 'ECHO_SKILL_SAVE', skill: skillDraft })
      .then((r: any) => {
        if (!r?.success) throw new Error(r?.error || 'Could not save skill');
        setSkillDraft(null);
        refreshSkills();
        flash(`Saved skill /${r.skill.shortcut}. Type / to use it.`);
      })
      .catch(error => setStatus(error?.message || 'Could not save skill'));
  };

  const toggleIsolated = () => {
    if (!isolated) refreshIsolation();
    setIsolated(v => !v);
  };

  const reportLines = report ? report.split('\n') : [];
  const items = menuItems();

  return (
    <div className="echo-panel">
      <header className="echo-panel-header">
        <span className={`echo-portrait${status ? ' busy' : ''}${chat.temporary ? ' temp' : ''}`} aria-hidden="true">
          {character ? <img src={characterAsset(character.id, 'portrait')} alt="" /> : <span className="echo-orb-mini" />}
        </span>
        <span className="echo-heading">
          <span className="echo-title" title={chat.title}>{chat.temporary ? 'Temporary chat' : chat.title === 'New chat' ? (character?.name || 'ECHO') : chat.title}</span>
          <span className="echo-subtitle">{status || (chat.temporary ? 'Not saved to history' : 'Online')}</span>
        </span>
        <span className="echo-toolbar-group">
        <button className={`echo-icon ${historyOpen ? 'on' : ''}`} onClick={openHistory} title="Chat history" aria-label="Chat history">{ICONS.history}</button>
        <button className={`echo-icon ${chat.temporary ? 'on' : ''}`} onClick={() => startChat(!chat.temporary)}
          title={chat.temporary ? 'Leave temporary chat' : 'Temporary chat: not saved to history'} aria-label="Temporary chat">{ICONS.ghost}</button>
        <button className="echo-icon" onClick={() => startChat(chat.temporary)} title="New chat" aria-label="New chat">{ICONS.plus}</button>
        </span>
      </header>

      {chat.temporary && (
        <div className="echo-temp-banner">Temporary chat: not saved to history, and answers aren't cached.</div>
      )}

      {reportLines.length > 0 && (
        <div className="echo-router" title="How many requests were answered without spending API quota">
          <div className="echo-router-main">{reportLines[0]}</div>
          {reportLines[1] && <div className="echo-router-sub">{reportLines[1]}</div>}
        </div>
      )}

      {usage && (
        <div className="echo-usage" title="Cloud API usage — steps are API round-trips this task">
          {usage.steps} {usage.steps === 1 ? 'step' : 'steps'} · {fmt(usage.taskTokens)} tokens this task
          <span className="echo-usage-session"> · {fmt(usage.sessionTokens)} session</span>
        </div>
      )}

      {approval && (
        <div className="echo-approval" role="alertdialog" aria-label="Approve browser action">
          <strong>Allow this browser action?</strong>
          <span>{approval.detail} on {approval.site}</span>
          <div className="echo-approval-buttons">
            <button onClick={() => answerApproval(false)}>Deny</button>
            <button onClick={() => answerApproval(true)}>Allow once</button>
          </div>
        </div>
      )}

      {site && (
        <div className="echo-site" title="Pages are only remembered on sites you allow. Nothing leaves this device.">
          <span>{site.allowed ? 'Remembering' : 'Page memory off for'} {site.host}</span>
          <button onClick={toggleSite} disabled={!site.allowed && !site.eligible}
            title={!site.allowed && !site.eligible ? 'This site is excluded to protect private data' : undefined}>
            {site.allowed ? 'Forget site' : site.eligible ? 'Remember site' : 'Private site'}
          </button>
        </div>
      )}

      {isolation?.open && (
        <div className="echo-site">
          <span>Private agent window is open</span>
          <button onClick={() => chrome.runtime.sendMessage({ type: 'ECHO_ISOLATION_CLOSE' }).then(refreshIsolation).catch(() => {})}>Close it</button>
        </div>
      )}

      {actions.length > 0 && (
        <details className="echo-actions"><summary>Recent actions</summary>
          {actions.map((a, i) => <div key={`${a.ts}-${i}`}>{a.status}: {a.detail}</div>)}
        </details>
      )}

      <div className="echo-body">
        {historyOpen && (
          <div className="echo-history" role="dialog" aria-label="Chat history">
            <div className="echo-history-head">
              <strong>History</strong>
              <button className="echo-icon" onClick={() => setHistoryOpen(false)} aria-label="Close history">{ICONS.close}</button>
            </div>
            {history.length === 0 && <div className="echo-empty">No saved chats yet.</div>}
            {history.map(h => (
              <div key={h.id} className={`echo-history-row ${h.id === chat.activeId ? 'active' : ''}`}>
                <button className="echo-history-open" onClick={() => openChat(h.id)}>
                  <span>{h.title}</span>
                  <small>{when(h.updated)} · {h.count} messages</small>
                </button>
                <button className="echo-icon" onClick={() => deleteChat(h.id)} title="Delete chat" aria-label={`Delete ${h.title}`}>{ICONS.trash}</button>
              </div>
            ))}
            {history.length > 0 && <button className="echo-history-clear" onClick={deleteAllChats}>Delete all history</button>}
          </div>
        )}

        <div className="echo-messages" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="echo-empty">
              {character && <img className="echo-empty-portrait" src={characterAsset(character.id, 'portrait')} alt="" />}
              <div className="echo-empty-title">Hi, I'm {character?.name || 'ECHO'}.</div>
              <div>Ask me anything, or give me a task on this page.</div>
              <div className="echo-empty-hints">
                <span><b>/</b>Skills</span><span><b>@</b>Attach a tab</span>
                <span>{ICONS.globe}Web search</span><span>{ICONS.incognito}Private window</span>
              </div>
            </div>
          )}
          {messages.map((m, i) => {
            const tier = m.role === 'echo' && m.tier !== undefined ? TIERS[m.tier] : null;
            return (
              <div key={i} className={`echo-msg ${m.role}`}>
                <div className="echo-bubble">
                  <Cited text={m.text} sources={m.sources} />
                  {tier && <span className={`echo-tier ${tier.cls}`} title={tier.title}>{tier.label}</span>}
                  {m.sources && m.sources.length > 0 && (
                    <ol className="echo-sources">
                      {m.sources.map((s, j) => <li key={j}>{safeUrl(s.url)
                        ? <a href={s.url} target="_blank" rel="noopener noreferrer" title={s.url}>{s.title || hostOf(s.url)}</a>
                        : s.title}</li>)}
                    </ol>
                  )}
                  {m.searchHtml && (
                    <iframe className="echo-search-chips" title="Google Search suggestions"
                      sandbox="allow-popups allow-popups-to-escape-sandbox"
                      srcDoc={`<base target="_blank">${m.searchHtml}`} />
                  )}
                </div>
                {m.role === 'user' && !m.text.startsWith('/') && (
                  <button className="echo-save-skill" onClick={() => draftSkillFrom(m.text)} title="Save this prompt as a skill">Save as skill</button>
                )}
              </div>
            );
          })}
          {status && <div className="echo-status">{status}</div>}
        </div>
      </div>

      {skillDraft && (
        <div className="echo-skill-draft">
          <strong>Save as skill</strong>
          <label>Shortcut <span>/</span><input value={skillDraft.shortcut}
            onChange={e => setSkillDraft({ ...skillDraft, shortcut: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} /></label>
          <label>Name <input value={skillDraft.name} onChange={e => setSkillDraft({ ...skillDraft, name: e.target.value })} /></label>
          <textarea value={skillDraft.prompt} onChange={e => setSkillDraft({ ...skillDraft, prompt: e.target.value })} rows={3} />
          <div className="echo-skill-draft-buttons">
            <button onClick={() => setSkillDraft(null)}>Cancel</button>
            <button className="primary" onClick={saveSkillDraft}>Save</button>
          </div>
        </div>
      )}

      <div className="echo-composer">
        {menu && items.length > 0 && (
          <div className="echo-menu" role="listbox">
            {items.map((item, i) => menu.kind === 'skill' ? (
              <button key={(item as Skill).id} role="option" aria-selected={i === menu.index}
                className={i === menu.index ? 'on' : ''} onMouseDown={e => { e.preventDefault(); choose(item); }}>
                <b>/{(item as Skill).shortcut}</b> <span>{(item as Skill).name}</span>
              </button>
            ) : (
              <button key={(item as TabItem).id} role="option" aria-selected={i === menu.index}
                className={i === menu.index ? 'on' : ''} onMouseDown={e => { e.preventDefault(); choose(item); }}>
                {(item as TabItem).favIconUrl && safeUrl((item as TabItem).favIconUrl!) && <img src={(item as TabItem).favIconUrl} alt="" />}
                <span>{(item as TabItem).title}</span> <small>{hostOf((item as TabItem).url)}</small>
              </button>
            ))}
          </div>
        )}

        {(mentions.length > 0 || webSearch || isolated) && (
          <div className="echo-chips">
            {mentions.map(m => (
              <span key={m.id} className="echo-chip" title={m.url}>@{m.title.slice(0, 28)}
                <button onClick={() => setMentions(prev => prev.filter(x => x.id !== m.id))} aria-label={`Remove ${m.title}`}>{ICONS.close}</button></span>
            ))}
            {webSearch && <span className="echo-chip web">{ICONS.globe}Search the web</span>}
            {isolated && <span className="echo-chip private">{ICONS.incognito}Private window, no logins</span>}
            {isolated && isolation && !isolation.allowed && (
              <button className="echo-chip-action" onClick={() => chrome.runtime.sendMessage({ type: 'ECHO_OPEN_EXTENSION_DETAILS' }).catch(() => {})}>
                Needs "Allow in Incognito" · Set up
              </button>
            )}
          </div>
        )}

        <form className="echo-input-row" onSubmit={send}>
          {status && <button type="button" className="echo-stop" onClick={() => {
            chrome.runtime.sendMessage({ type: 'ECHO_ABORT' }).catch(() => {});
            setStatus('');
          }}>{ICONS.stop}<span>Stop</span></button>}
          <button type="button" className={`echo-toggle ${webSearch ? 'on' : ''}`} onClick={() => setWebSearch(v => !v)}
            title="Search the web for this message (Claude or Gemini)" aria-pressed={webSearch}>{ICONS.globe}</button>
          <button type="button" className={`echo-toggle ${isolated ? 'on' : ''}`} onClick={toggleIsolated}
            title="Do this task in a private window without your logins" aria-pressed={isolated}>{ICONS.incognito}</button>
          <input
            ref={inputRef}
            value={input}
            onChange={e => { setInput(e.target.value); updateMenu(e.target.value, e.target.selectionStart ?? e.target.value.length); }}
            onKeyDown={onKeyDown}
            onBlur={() => setTimeout(() => setMenu(null), 150)}
            placeholder={chat.temporary ? 'Temporary message…' : 'Message ECHO…  (/ skills, @ tabs)'}
            autoFocus
          />
          <button type="submit" className="echo-send" disabled={!input.trim()} aria-label="Send">{ICONS.send}</button>
        </form>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('echo-panel-root')!);
root.render(<Panel />);
