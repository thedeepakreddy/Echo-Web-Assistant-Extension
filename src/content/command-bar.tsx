import React from 'react';
import { ICONS } from '../theme/icons';

// ECHO's in-page command bar: a HUD panel with the text input, voice, and the
// browsing actions people reach for most. Every action sends a plain command
// that ECHO already understands, so nothing here bypasses the normal flow.

type Status = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

export interface QuickAction {
  id: string;
  label: string;
  hint: string;
  icon: React.ReactNode;
  /** The command to send, or null when the action can't run right now. */
  command: () => string | null;
}

interface Props {
  visible: boolean;
  status: Status;
  /** Open upward above ECHO, or downward when she is near the top of the window. */
  placement: { below: boolean; alignLeft: boolean };
  inputText: string;
  setInputText: (text: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  submitBtnRef: React.RefObject<HTMLButtonElement | null>;
  onSubmit: (e: React.FormEvent) => void;
  markTrusted: (e: React.SyntheticEvent) => void;
  actions: QuickAction[];
  onAction: (e: React.MouseEvent, action: QuickAction) => void;
  onMic: (e: React.MouseEvent) => void;
  onStop: (e: React.MouseEvent) => void;
  onClose: () => void;
}

const STATUS_TEXT: Record<Status, string> = {
  idle: 'Ready',
  listening: 'Listening\u2026',
  thinking: 'Working on it\u2026',
  speaking: 'Speaking',
  error: 'Something went wrong',
};

export function CommandBar(p: Props) {
  const busy = p.status === 'thinking' || p.status === 'speaking';
  const listening = p.status === 'listening';
  const cls = ['echo-cmd', p.visible ? 'visible' : '', p.placement.below ? 'below' : '', p.placement.alignLeft ? 'align-left' : '']
    .filter(Boolean).join(' ');

  return (
    <div id="echo-chat-box" className={cls} role="dialog" aria-label="ECHO command bar"
      onKeyDown={e => { if (e.key === 'Escape') p.onClose(); }}>
      <span className="hud-corner tl" /><span className="hud-corner tr" />
      <span className="hud-corner bl" /><span className="hud-corner br" />

      <div className="cmd-head">
        <span className="cmd-dot" />
        <span className="cmd-title">ECHO</span>
        <span className="cmd-status">{STATUS_TEXT[p.status]}</span>
        <button className="cmd-icon-btn" onClick={p.onClose} title="Close (Esc)" aria-label="Close">{ICONS.close}</button>
      </div>

      <form className="cmd-input-row" onSubmit={p.onSubmit}>
        <button type="button" className={`cmd-icon-btn cmd-mic${listening ? ' live' : ''}`}
          onClick={p.onMic} title={listening ? 'Stop listening' : 'Speak a command'}
          aria-label={listening ? 'Stop listening' : 'Speak a command'}>{ICONS.mic}</button>
        <input
          id="input"
          ref={p.inputRef}
          type="text"
          placeholder={listening ? 'Listening\u2026' : 'Ask ECHO or give a command\u2026'}
          autoComplete="off"
          spellCheck="false"
          value={p.inputText}
          onChange={e => p.setInputText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') p.markTrusted(e); }}
        />
        {busy ? (
          <button type="button" id="echo-send-btn" className="stop" onClick={p.onStop} title="Stop" aria-label="Stop">{ICONS.stop}</button>
        ) : (
          <button ref={p.submitBtnRef} id="echo-send-btn" onClick={p.markTrusted} type="submit"
            title="Send (Enter)" aria-label="Send" disabled={!p.inputText.trim()}>{ICONS.send}</button>
        )}
      </form>

      <div className="cmd-actions">
        {p.actions.map(a => {
          const ready = a.command() !== null;
          return (
            <button key={a.id} className="cmd-chip" disabled={busy || !ready} title={a.hint}
              // Keep the page's text selection alive when the chip is pressed.
              onMouseDown={e => e.preventDefault()}
              onClick={e => p.onAction(e, a)}>
              <span className="cmd-chip-icon">{a.icon}</span><span>{a.label}</span>
            </button>
          );
        })}
      </div>
      <div className="cmd-foot"><kbd>{'\u21a9'}</kbd> send<span className="cmd-foot-sep" /><kbd>esc</kbd> close<span className="cmd-foot-sep" /><kbd>hold</kbd> toggle</div>
    </div>
  );
}
