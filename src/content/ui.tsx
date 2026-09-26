import React, { useState, useEffect, useRef } from 'react';
import '../theme/glass.css';
import './index.css';
import { replaceSelection } from './writer';
import { EchoAvatar, AvatarCues } from './avatar';
import { CommandBar, QuickAction } from './command-bar';
import { ICONS } from '../theme/icons';
import { pickVoice, VoiceGender } from './voice';
import { REACTOR, DEFAULT_APPEARANCE, characterById, resolveAppearance, themeFor, themeVars } from '../characters';

// The character is taller than the reactor orb, so it needs a bigger box.
// Characters are 230 px tall and as wide as their own picture's proportions
// (4:5 for most; wider for one whose shoulders fill a wider frame).
const boxFor = (appearance: string) => {
  if (appearance === REACTOR) return { w: 140, h: 140 };
  const aspect = characterById(appearance)?.layout.aspect || 0.8;
  return { w: Math.max(184, Math.round(230 * aspect)), h: 230 };
};

// Replies that should make the character laugh: laughter, jokes, puns, or
// laughing emoji. Keyword-based, so it errs toward not laughing.
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', hi: 'Hindi', te: 'Telugu', ta: 'Tamil', bn: 'Bengali', es: 'Spanish', fr: 'French', de: 'German',
};
const COMMAND_BAR_H = 250;           // approx. height, to decide whether it opens up or down
const COMMAND_BAR_W = 396;
const SELECTION_TTL_MS = 60_000;     // "Explain" uses text selected in the last minute

const FUNNY = /\b(ha(ha)+h?|he(he)+|lol|lmao|rofl|hilarious|joke|jokes|joking|kidding|pun|puns|funny)\b|[\u{1F602}\u{1F923}\u{1F606}\u{1F604}\u{1F639}\u{1F601}]/iu;

interface WriterCard {
  requestId: string;
  title: string;
  state: 'loading' | 'done' | 'error';
  text?: string;
  error?: string;
  canReplace?: boolean;
  note?: string;
}

declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

export function EchoUI() {
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState<'idle' | 'listening' | 'thinking' | 'speaking' | 'error'>('idle');
  const [inputText, setInputText] = useState('');
  const [chatVisible, setChatVisible] = useState(false);
  const chatVisibleRef = useRef(false);
  useEffect(() => { chatVisibleRef.current = chatVisible; }, [chatVisible]);
  // Releasing a long press also fires a click; this swallows that one click.
  const longPressedRef = useRef(false);

  // Esc closes the command bar wherever focus is on the page.
  useEffect(() => {
    if (!chatVisible) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setChatVisible(false); };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [chatVisible]);
  const [logText, setLogText] = useState('');
  const [suggestion, setSuggestion] = useState<{ text: string; action: string } | null>(null);
  // Only the id reaches the page DOM; the prompt text and buttons live in an
  // extension-origin iframe that page scripts cannot read or click.
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [writer, setWriter] = useState<WriterCard | null>(null);
  const [position, setPosition] = useState({ x: window.innerWidth - 208, y: window.innerHeight - 254 });
  // A character id, or 'reactor' for the orb.
  const [appearance, setAppearance] = useState(DEFAULT_APPEARANCE);
  const character = characterById(appearance);
  const avatarBoxRef = useRef(boxFor(DEFAULT_APPEARANCE));
  useEffect(() => { avatarBoxRef.current = boxFor(appearance); }, [appearance]);
  // The speech handler is registered once, so it reads the voice from a ref.
  const voiceGenderRef = useRef<VoiceGender | undefined>(characterById(DEFAULT_APPEARANCE)?.voice);
  useEffect(() => { voiceGenderRef.current = characterById(appearance)?.voice; }, [appearance]);
  // Chrome loads its voice list lazily; ask early so it is ready for the first reply.
  useEffect(() => { window.speechSynthesis.getVoices(); }, []);
  // True only while speech audio plays, so the mouth never moves in silence.
  const [talking, setTalking] = useState(false);
  const avatarCueRef = useRef<AvatarCues | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const positionRef = useRef(position);
  useEffect(() => { positionRef.current = position; }, [position]);
  const isDraggingRef = useRef(false);
  const dragStartPosRef = useRef({ x: 0, y: 0 });
  const dragStartMouseRef = useRef({ x: 0, y: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const submitBtnRef = useRef<HTMLButtonElement>(null);
  // This UI sits in the page's DOM, so page scripts can call .click() on it or
  // requestSubmit() the form. Commands are only sent right after a real
  // (isTrusted) key press or click from the user.
  const trustedGestureAtRef = useRef(0);
  const markTrusted = (e: React.SyntheticEvent) => {
    if (e.nativeEvent.isTrusted) trustedGestureAtRef.current = Date.now();
  };
  const submitRef = useRef<() => void>(() => {});
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const speechChannelRef = useRef(crypto.randomUUID());
  const speechLanguageRef = useRef('en-US');
  const speechReceivedRef = useRef(false);
  const speechErrorRef = useRef(false);
  const speechReadyRef = useRef(false);
  const pendingSpeechStartRef = useRef(false);
  const pressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const logTimerRef = useRef<NodeJS.Timeout | null>(null);
  const handsfreeRef = useRef(false);
  const visibleRef = useRef(false);
  useEffect(() => { visibleRef.current = visible; }, [visible]);

  // Hands-free mode: keep the setting in a ref so speech callbacks see it live.
  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'ECHO_CONTENT_PREFS' }).then((r: any) => {
      if (!r?.success) return;
      handsfreeRef.current = !!r.handsfree;
      setAppearance(resolveAppearance(r.avatar));
      speechLanguageRef.current = String(r.language || 'en-US');
    }).catch(() => {});
  }, []);

  const showLog = (text: string) => {
    setLogText(text);
    if (logTimerRef.current) clearTimeout(logTimerRef.current);
    logTimerRef.current = setTimeout(() => {
      setLogText('');
    }, 4000);
  };

  // Remember the last text the user selected on the page. Pressing ECHO can
  // clear the selection, so "Explain" works from this copy instead.
  const [selection, setSelection] = useState<{ text: string; at: number } | null>(null);
  useEffect(() => {
    const onSelection = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() || '';
      if (!text) return;
      const node = sel?.anchorNode;
      if (node && document.getElementById('echo-extension-root')?.contains(node)) return;
      setSelection(prev => (prev?.text === text ? prev : { text: text.slice(0, 1500), at: Date.now() }));
    };
    document.addEventListener('selectionchange', onSelection);
    return () => document.removeEventListener('selectionchange', onSelection);
  }, []);

  const sendSpeechControl = (command: 'start' | 'stop') => {
    if (command === 'start' && !speechReadyRef.current) {
      pendingSpeechStartRef.current = true;
      return;
    }
    if (command === 'stop') pendingSpeechStartRef.current = false;
    chrome.runtime.sendMessage({ type: 'ECHO_SPEECH_CONTROL', channel: speechChannelRef.current,
      command, language: speechLanguageRef.current }).then((r: any) => {
        if (r?.success === false) throw new Error('Speech frame is not ready. Try again.');
      }).catch(error => {
        showLog(`Speech unavailable: ${error?.message || 'extension error'}`);
        setStatus('error');
      });
  };

  useEffect(() => {
    if (!visible) {
      speechReadyRef.current = false;
      pendingSpeechStartRef.current = false;
    }
  }, [visible]);

  // The passive observer posts suggestions on the page's own window. Any script
  // on the page can forge such a message, so the action is never taken from the
  // message — only a fixed allowlist index is honoured. A hostile page can at
  // worst offer one of ECHO's own harmless local commands.
  useEffect(() => {
    const ALLOWED: Record<string, string> = {
      'fill form': 'fill this form',
      'summarize this page': 'summarize this page',
    };
    const onLocalSuggest = (event: MessageEvent) => {
      if (event.source !== window) return;
      const d = event.data;
      if (d?.source !== 'echo-observer' || d?.type !== 'ECHO_LOCAL_SUGGEST') return;
      const action = ALLOWED[String(d.action || '')];
      if (!action || !d.text) return;
      setSuggestion({ text: String(d.text).slice(0, 160), action });
      window.setTimeout(() => setSuggestion(null), 18000);
    };
    window.addEventListener('message', onLocalSuggest);
    return () => window.removeEventListener('message', onLocalSuggest);
  }, []);

  const acceptSuggestion = (e: React.MouseEvent) => {
    if (!suggestion || !e.nativeEvent.isTrusted) return;
    setVisible(true);
    chrome.runtime.sendMessage({ type: 'USER_INPUT', text: suggestion.action });
    showLog(`You: ${suggestion.action}`);
    setStatus('thinking');
    setSuggestion(null);
  };

  useEffect(() => {
    // Check initial state
    chrome.runtime.sendMessage({ type: 'CHECK_AWAKE_STATE' }, (response) => {
      if (response?.isAwake) setVisible(true);
    });

    // Load initial position
    chrome.runtime.sendMessage({ type: 'ECHO_CONTENT_PREFS' }).then((res: any) => {
      if (res?.position) setPosition(res.position as { x: number, y: number });
    }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'ECHO_PENDING_APPROVAL' })
      .then((res: any) => { if (res?.approval?.id) setApprovalId(String(res.approval.id)); })
      .catch(() => {});

    const handleMessage = (message: any) => {
      if (message.type === 'ECHO_GLOBAL_WAKE') {
        setVisible(message.state);
      } else if (message.type === 'ECHO_PREFS_UPDATED') {
        handsfreeRef.current = !!message.handsfree;
        speechLanguageRef.current = String(message.language || 'en-US');
        setAppearance(resolveAppearance(message.avatar));
      } else if (message.type === 'ECHO_STATE') {
        if (message.state !== 'Idle') showLog(message.state);
        // Map brain status to reactor status
        if (message.state === 'Idle') {
          if (!window.speechSynthesis.speaking) setStatus('idle');
        }
        else if (message.state === 'Error') {
          setStatus('error');
          setTimeout(() => setStatus('idle'), 3000);
        }
        else setStatus('thinking'); // Thinking, Acting, etc.

      } else if (message.type === 'ECHO_WRITER_SHOW') {
        setWriter(prev => (message.state !== 'loading' && prev && prev.requestId !== message.requestId) ? prev : {
          requestId: String(message.requestId), title: String(message.title || 'ECHO Writer'), state: message.state,
          text: message.text, error: message.error, canReplace: !!message.canReplace,
        });
      } else if (message.type === 'ECHO_SAY') {
        // Citation markers like [1] are for reading in the side panel, not for speech.
        const plain = String(message.text || '').replace(/\[\d+\]/g, '');
        showLog(plain);
        // Several avatars can work at once; only the tab in front speaks aloud.
        if (document.visibilityState !== 'visible') { setStatus('idle'); return; }
        setStatus('speaking');

        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(plain);
        utterance.lang = speechLanguageRef.current;
        
        // A voice that matches the character: a woman's voice for a female
        // character, a man's for a male one (see voice.ts).
        const { voice, pitch } = pickVoice(window.speechSynthesis.getVoices(), speechLanguageRef.current, voiceGenderRef.current);
        if (voice) utterance.voice = voice;
        utterance.pitch = pitch;

        utterance.rate = 1.05;

        // cancel() above ends the previous utterance, and its events can land
        // after this one starts; only the current utterance may change state.
        utteranceRef.current = utterance;
        const isCurrent = () => utteranceRef.current === utterance;
        const text = plain;                 // what is actually spoken, so word positions line up
        utterance.onstart = () => {
          if (!isCurrent()) return;
          setTalking(true);
          // The avatar lip-syncs from the text itself (and laughs at any "haha" in it).
          avatarCueRef.current?.speak(text);
          if (FUNNY.test(text)) avatarCueRef.current?.laugh();
        };
        utterance.onboundary = (e: SpeechSynthesisEvent) => {
          // Voices that report word positions keep the lip-sync exactly in step.
          if (isCurrent() && (!e.name || e.name === 'word')) avatarCueRef.current?.word(e.charIndex);
        };
        utterance.onerror = () => {
          if (isCurrent()) setTalking(false);
        };
        utterance.onend = () => {
          if (!isCurrent()) return;
          setTalking(false);
          setStatus('idle');
          // Hands-free: reopen the mic after ECHO finishes speaking so the
          // user can keep the conversation going without clicking.
          if (handsfreeRef.current && visibleRef.current) {
            setTimeout(() => {
              sendSpeechControl('start');
            }, 400);
          }
        };

        window.speechSynthesis.speak(utterance);
      } else if (message.type === 'ECHO_SYNC_POSITION') {
        setPosition(message.position as { x: number, y: number });
      } else if (message.type === 'ECHO_OPEN_PALETTE') {
        // Cmd/Ctrl+Shift+K — reveal the orb and focus the text input.
        setVisible(true);
        setChatVisible(true);
        setTimeout(() => inputRef.current?.focus(), 120);
      } else if (message.type === 'ECHO_APPROVAL_REQUEST') {
        setApprovalId(String(message.id));
        setVisible(true);
        setStatus('idle');
      } else if (message.type === 'ECHO_APPROVAL_CLEAR') {
        setApprovalId(prev => prev === message.id ? null : prev);
      } else if (message.type === 'ECHO_SPEECH_EVENT_DELIVER') {
        if (message.event === 'start') {
          speechReceivedRef.current = false;
          speechErrorRef.current = false;
          setStatus('listening');
        } else if (message.event === 'result') {
          speechReceivedRef.current = true;
          setInputText(prev => prev + String(message.text || '') + ' ');
        } else if (message.event === 'error') {
          speechErrorRef.current = true;
          showLog(`Speech error: ${String(message.error || 'unknown')}`);
          setStatus('error');
        } else if (message.event === 'end') {
          if (speechReceivedRef.current && !speechErrorRef.current) {
            // Speech results come only from ECHO's own frame, so no gesture check.
            setTimeout(() => submitRef.current(), 150);
          } else {
            setStatus('idle');
          }
        }
      }
    };
    
    chrome.runtime.onMessage.addListener(handleMessage);
    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage);
    };
  }, []);

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) {
      e.preventDefault();
      if (Date.now() - trustedGestureAtRef.current > 1000) return;
    }
    if (!inputText.trim() || status === 'thinking' || status === 'speaking') return;
    
    if (status === 'listening') {
      sendSpeechControl('stop');
    }

    try {
      showLog(`You: ${inputText.trim()}`);
      chrome.runtime.sendMessage({ type: 'USER_INPUT', text: inputText }).catch(err => {
        showLog(`Could not send: ${err?.message || 'extension unavailable'}`);
        setStatus('error');
      });
    } catch (err) {
      console.error(err);
      setStatus('error');
      setTimeout(() => setStatus('idle'), 2000);
      return;
    }
    
    setInputText('');
    setChatVisible(false); // Hide chat after sending
    setStatus('thinking');
  };

  submitRef.current = () => handleSubmit();

  const freshSelection = selection && Date.now() - selection.at < SELECTION_TTL_MS ? selection.text : null;
  const quickActions: QuickAction[] = [
    { id: 'summarize', label: 'Summarize', icon: ICONS.summarize,
      hint: 'Summarize this page (runs locally, no API)', command: () => 'summarize this page' },
    { id: 'explain', label: 'Explain', icon: ICONS.lightbulb,
      hint: freshSelection ? `Explain: "${freshSelection.slice(0, 80)}${freshSelection.length > 80 ? '…' : ''}"` : 'Select text on the page first',
      command: () => freshSelection ? `Explain this selected text in simple words: "${freshSelection}"` : null },
    { id: 'translate', label: 'Translate', icon: ICONS.translate,
      hint: `Translate this page into ${LANGUAGE_NAMES[speechLanguageRef.current.slice(0, 2)] || 'English'}`,
      command: () => `translate this page into ${LANGUAGE_NAMES[speechLanguageRef.current.slice(0, 2)] || 'English'}` },
    { id: 'fill', label: 'Fill form', icon: ICONS.form,
      hint: 'Fill the form on this page from your profile (runs locally)', command: () => 'fill this form' },
    { id: 'watch', label: 'Watch', icon: ICONS.watch,
      hint: 'Check this page every hour and tell me when it changes', command: () => 'watch this page' },
    { id: 'tabs', label: 'My tabs', icon: ICONS.tabs,
      hint: 'List the tabs you have open', command: () => 'list my open tabs' },
  ];

  const runQuickAction = (e: React.MouseEvent, action: QuickAction) => {
    if (!e.nativeEvent.isTrusted || status === 'thinking' || status === 'speaking') return;
    const command = action.command();
    if (!command) return;
    if (status === 'listening') sendSpeechControl('stop');
    showLog(`You: ${action.label}`);
    chrome.runtime.sendMessage({ type: 'USER_INPUT', text: command }).catch(err => {
      showLog(`Could not send: ${err?.message || 'extension unavailable'}`);
      setStatus('error');
    });
    if (action.id === 'explain') setSelection(null);
    setChatVisible(false);
    setStatus('thinking');
  };

  const toggleMic = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    if (status === 'listening') { sendSpeechControl('stop'); return; }
    if (status === 'thinking' || status === 'speaking') return;
    setInputText('');
    sendSpeechControl('start');
  };

  const stopEverything = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    window.speechSynthesis.cancel();
    setTalking(false);
    chrome.runtime.sendMessage({ type: 'ECHO_ABORT' });
    setStatus('idle');
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    isDraggingRef.current = false;
    dragStartPosRef.current = { ...positionRef.current };
    dragStartMouseRef.current = { x: e.clientX, y: e.clientY };
    longPressedRef.current = false;

    // Long press toggles the command bar: opens it, or closes it if open.
    pressTimerRef.current = setTimeout(() => {
      if (isDraggingRef.current) return;
      longPressedRef.current = true;
      const opening = !chatVisibleRef.current;
      setChatVisible(opening);
      if (opening) setTimeout(() => inputRef.current?.focus(), 100);
    }, 500);

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUpWindow);
  };

  const handlePointerMove = (e: PointerEvent) => {
    const dx = e.clientX - dragStartMouseRef.current.x;
    const dy = e.clientY - dragStartMouseRef.current.y;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      isDraggingRef.current = true;
      if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
    }

    if (isDraggingRef.current) {
      let newX = dragStartPosRef.current.x + dx;
      let newY = dragStartPosRef.current.y + dy;
      
      // keep within window bounds
      const box = avatarBoxRef.current;
      newX = Math.max(0, Math.min(newX, window.innerWidth - box.w));
      newY = Math.max(0, Math.min(newY, window.innerHeight - box.h));

      setPosition({ x: newX, y: newY });
    }
  };

  const handlePointerUpWindow = () => {
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUpWindow);
    
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);

    if (isDraggingRef.current) {
      // Save and broadcast
      const finalPos = positionRef.current;
      chrome.runtime.sendMessage({ type: 'ECHO_SET_POSITION', position: finalPos }).catch(() => {});
      chrome.runtime.sendMessage({ type: 'ECHO_SYNC_POSITION', position: finalPos });
      
      // Prevent click from firing right after drag by delaying a reset flag
      setTimeout(() => {
        isDraggingRef.current = false;
      }, 50);
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    if (isDraggingRef.current) {
      e.stopPropagation();
      return;
    }
    
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    // While the bar is open a click does nothing; long press or Esc closes it.
    if (chatVisible) return;

    if (status === 'listening') {
      sendSpeechControl('stop');
    } else if (window.speechSynthesis.speaking || status === 'thinking' || status === 'speaking' || status.startsWith('Executing')) {
      // Abort ongoing work and speech
      window.speechSynthesis.cancel();
      setTalking(false);
      chrome.runtime.sendMessage({ type: 'ECHO_ABORT' });
      setStatus('idle');
    } else {
      setInputText('');
      sendSpeechControl('start');
    }
  };

  // ECHO Writer result card. Like the toast, it shows even when the orb sleeps.
  const writerAction = (e: React.MouseEvent, kind: 'replace' | 'copy' | 'close') => {
    if (!e.nativeEvent.isTrusted || !writer) return;
    if (kind === 'close') { setWriter(null); return; }
    if (kind === 'copy') {
      navigator.clipboard.writeText(writer.text || '')
        .then(() => setWriter(w => w && { ...w, note: 'Copied.' }))
        .catch(() => setWriter(w => w && { ...w, note: 'Copy failed. Select the text and copy it.' }));
      return;
    }
    const r = replaceSelection(writer.requestId, writer.text || '');
    if (r.success) setWriter(null);
    else setWriter(w => w && { ...w, canReplace: false, note: r.error });
  };
  const writerCard = writer ? (
    <div id="echo-writer-card" role="dialog" aria-label="ECHO Writer">
      <div className="echo-writer-head">
        <strong>ECHO Writer · {writer.title}</strong>
        <button className="echo-writer-x" onClick={e => writerAction(e, 'close')} aria-label="Close">{ICONS.close}</button>
      </div>
      {writer.state === 'loading' && <div className="echo-writer-body echo-writer-muted">Writing…</div>}
      {writer.state === 'error' && <div className="echo-writer-body echo-writer-error">{writer.error}</div>}
      {writer.state === 'done' && <div className="echo-writer-body">{writer.text}</div>}
      {writer.note && <div className="echo-writer-note">{writer.note}</div>}
      {writer.state === 'done' && <div className="echo-writer-actions">
        <button onClick={e => writerAction(e, 'copy')}>Copy</button>
        {writer.canReplace && <button className="primary" onClick={e => writerAction(e, 'replace')}>Replace</button>}
      </div>}
    </div>
  ) : null;

  // The proactive toast is independent of the orb — it can appear while ECHO
  // is asleep, which is exactly when a passive suggestion is most useful.
  const suggestionToast = suggestion ? (
    <div id="echo-suggest-toast">
      <span className="echo-suggest-text">{suggestion.text}</span>
      <button className="echo-suggest-yes" onClick={acceptSuggestion}>Yes</button>
      <button className="echo-suggest-no" onClick={() => setSuggestion(null)} aria-label="Dismiss">{ICONS.close}</button>
    </div>
  ) : null;

  // Everything ECHO draws on the page shares the glass tokens, coloured by the
  // current character. `display: contents` keeps this wrapper out of layout.
  const theme = { display: 'contents', ...themeVars(themeFor(appearance)) } as React.CSSProperties;
  if (!visible) return <div className="echo-theme" style={theme}>{suggestionToast}{writerCard}</div>;

  // A position saved for the smaller orb could push the character off-screen.
  const box = boxFor(appearance);
  const wrapperLeft = Math.max(0, Math.min(position.x, window.innerWidth - box.w));
  const wrapperTop = Math.max(0, Math.min(position.y, window.innerHeight - box.h));

  return (
    <div className="echo-theme" style={theme}>
    {suggestionToast}
    {writerCard}
    <div
      id="echo-root-wrapper"
      className={character ? 'avatar-mode' : undefined}
      data-status={status}
      style={{
        position: 'absolute',
        left: wrapperLeft,
        top: wrapperTop,
        ...(character ? { width: box.w, height: box.h } : {}),
        pointerEvents: 'auto'
      }}
    >
      <iframe 
        ref={iframeRef}
        src={typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL(`speech.html?channel=${speechChannelRef.current}`) : ''}
        onLoad={() => {
          speechReadyRef.current = true;
          if (pendingSpeechStartRef.current) {
            pendingSpeechStartRef.current = false;
            sendSpeechControl('start');
          }
        }}
        style={{ display: 'none' }}
        allow="microphone"
        title="ECHO Speech Sandbox"
      />
      
      <div id="echo-log-box" className={logText ? 'visible' : ''}>
        {logText}
      </div>


      <CommandBar
        visible={chatVisible}
        status={status}
        placement={{
          below: wrapperTop < COMMAND_BAR_H + 16,
          alignLeft: wrapperLeft + box.w < COMMAND_BAR_W + 8,
        }}
        inputText={inputText}
        setInputText={setInputText}
        inputRef={inputRef}
        submitBtnRef={submitBtnRef}
        onSubmit={handleSubmit}
        markTrusted={markTrusted}
        actions={quickActions}
        onAction={runQuickAction}
        onMic={toggleMic}
        onStop={stopEverything}
        onClose={() => setChatVisible(false)}
      />

      {character ? (
        <EchoAvatar
          key={character.id}
          character={character}
          status={status}
          talking={talking}
          cueRef={avatarCueRef}
          onClick={handleClick}
          onPointerDown={handlePointerDown}
        />
      ) : (
      <div 
        id="orb" 
        className="reactor" 
      >
        <div className="reactor-inner circle abs-center"></div>
        <div className="tunnel circle abs-center"></div>
        <div className="core-wrapper circle abs-center"></div>

        <div className="coil-container">
          <div className="coil coil-1"></div>
          <div className="coil coil-2"></div>
          <div className="coil coil-3"></div>
          <div className="coil coil-4"></div>
          <div className="coil coil-5"></div>
          <div className="coil coil-6"></div>
          <div className="coil coil-7"></div>
          <div className="coil coil-8"></div>
        </div>

        <div className="core-outer circle abs-center"></div>
        <div className="core-inner circle abs-center"></div>

        <div 
          className="core-hitbox circle abs-center"
          title="Click to talk · long-press for commands · drag to move"
          onClick={handleClick}
          onPointerDown={handlePointerDown}
          style={{ width: '45%', height: '45%', zIndex: 10, cursor: 'pointer', touchAction: 'none' }}
        ></div>
      </div>
      )}
    </div>
    {/* Drawn last and pinned to the corner so nothing of ECHO's covers it; the
        frame only arms "Allow" while it is fully visible. */}
    {approvalId && <div id="echo-approval-box">
      <iframe
        key={approvalId}
        src={chrome.runtime.getURL(`approval.html?id=${encodeURIComponent(approvalId)}`)}
        title="ECHO action approval"
      />
    </div>}
    </div>
  );
}
