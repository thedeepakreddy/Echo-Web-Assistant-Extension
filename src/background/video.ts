// Which pages are "video pages" whose transcript matters more than their text.

export function isVideoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m)\./, '');
    if (host === 'youtube.com') return u.pathname === '/watch' || u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/live/');
    if (host === 'youtu.be') return u.pathname.length > 1;
    return false;
  } catch { return false; }
}
