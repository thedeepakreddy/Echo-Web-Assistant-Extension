import { useEffect, useState } from 'react';
import '../theme/glass.css';
import { resolveAppearance, themeFor, themeVars } from '../characters';

/** Colour an extension page (chat panel, settings) with the given appearance's theme. */
export function paintPage(appearance: string) {
  const body = document.body;
  body.classList.add('echo-theme', 'echo-page');
  for (const [name, value] of Object.entries(themeVars(themeFor(appearance)))) body.style.setProperty(name, value);
}

/**
 * The stored appearance (a character id or 'reactor'), kept live: when it
 * changes in settings, every open extension page recolours itself.
 */
export function useAppearance(): string {
  const [appearance, setAppearance] = useState(() => resolveAppearance(undefined));
  useEffect(() => {
    paintPage(appearance);
  }, [appearance]);
  useEffect(() => {
    chrome.storage.local.get('echo_avatar')
      .then(r => setAppearance(resolveAppearance(r.echo_avatar)))
      .catch(() => {});
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && 'echo_avatar' in changes) setAppearance(resolveAppearance(changes.echo_avatar.newValue));
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);
  return appearance;
}
