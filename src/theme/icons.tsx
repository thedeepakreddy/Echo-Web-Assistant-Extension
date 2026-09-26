import React from 'react';

// Line icons shared by the command bar, chat panel and settings, drawn like
// SF Symbols (regular weight, round caps, 24px grid), coloured by `currentColor`.

const svg = (d: React.ReactNode) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);

export const ICONS = {
  history: svg(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>),
  ghost: svg(<><path d="M5 20V11a7 7 0 0 1 14 0v9l-2.3-1.6L14.3 20 12 18.4 9.7 20l-2.4-1.6z" /><path d="M9.5 11h.01M14.5 11h.01" /></>),
  plus: svg(<path d="M12 5v14M5 12h14" />),
  globe: svg(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>),
  incognito: svg(<><path d="M3 10h18M6 10l1.5-5h9L18 10" /><circle cx="7.5" cy="16" r="2.8" /><circle cx="16.5" cy="16" r="2.8" /><path d="M10.3 16h3.4" /></>),
  trash: svg(<><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13M9 7V4h6v3" /></>),
  mic: svg(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>),
  send: svg(<path d="M12 19V5.5M6 11.5 12 5.5l6 6" />),
  lightbulb: svg(<><path d="M9.5 18h5M10.5 21h3" /><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.1v.1h5v-.1c0-.8.4-1.5 1.1-2.1A6 6 0 0 0 12 3z" /></>),
  stop: svg(<rect x="6" y="6" width="12" height="12" rx="2" />),
  close: svg(<path d="M6 6l12 12M18 6L6 18" />),
  summarize: svg(<path d="M4 6h16M4 10h16M4 14h10M4 18h7" />),
  explain: svg(<><path d="M5 5h9M5 9h6" /><path d="M14 13l2.5-6 2.5 6M14.8 11h3.4" /><path d="M5 15h5M5 19h7" /></>),
  translate: svg(<><path d="M3 5h9M7.5 3v2M5 5c1 4 4 7 7 8M10 5c-1 4-4 7-7 8" /><path d="M13 21l4-9 4 9M14.5 18h5" /></>),
  form: svg(<><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1M9 11l2 2 4-4M9 17h6" /></>),
  watch: svg(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>),
  tabs: svg(<><rect x="3" y="7" width="14" height="13" rx="2" /><path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2" /></>),
  avatars: svg(<><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19.5c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" /><circle cx="16.8" cy="9" r="2.6" /><path d="M16 14.6c2.4.1 4 1.7 4.5 4.4" /></>),
};
