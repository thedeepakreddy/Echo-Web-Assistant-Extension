// Did an answer come from the page? Everything a scope's tools return (and
// what the user asked) is kept as evidence for its conversation. A reply's
// checkable facts (prices, figures with units, years, dates, emails, links,
// quoted phrases) are looked up in that evidence; any not found are marked
// unverified in the chat, so a made-up number never passes for a quote.

const MAX_EVIDENCE_CHARS = 300_000;
const MAX_FLAGS = 6;

interface Evidence { text: string; numbers: Set<string>; dates: Set<string> }
const evidence = new Map<string, Evidence>();

// Units that make a figure a fact worth checking ("30 days", "2.5 kg").
// Counts the model makes itself ("3 items") and one-letter units are left out.
const UNITS = 'days?|business days|working days|nights?|hours?|hrs?|minutes?|mins?|seconds?|weeks?|months?|years?|'
  + 'kg|mg|lbs?|oz|km|cm|mm|ml|miles?|ft|inches|gb|mb|tb|kb|mbps|gbps|mah|kwh|°c|°f|stars?';
const CLAIM_PATTERNS: RegExp[] = [
  // Money: $39.00, € 1,299, 24.50 USD
  /(?:[$£€¥₹]\s?\d[\d,]*(?:\.\d+)?)|(?:\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|INR|JPY|dollars?|euros?|pounds?|rupees?)\b)/gi,
  // Figures with a unit or a percent sign: 30 days, 12,000 delegates, 4.5 stars, 15%
  new RegExp(`\\b\\d[\\d,]*(?:\\.\\d+)?\\s?(?:%|(?:${UNITS})\\b)`, 'gi'),
  // Years and other bare numbers with three or more digits, or with decimals: 2031, 1299, 3.7
  /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{3,}(?:\.\d+)?\b|\b\d+\.\d+\b/g,
  // Emails and links
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
  /\bhttps?:\/\/[^\s)<>"']+/gi,
];
// Dates: 2031-05-04, 4/5/2031, May 4, 2031, 4 May 2031. Compared as whole
// dates, since each of their numbers alone is usually somewhere on a page.
const DATES = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4}\b/gi;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A date as year-month-day; a numeric date gives both day/month readings. */
function canonicalDates(date: string): string[] {
  const iso = (y: number, m: number, d: number) => `${y < 100 ? 2000 + y : y}-${m}-${d}`;
  const lower = date.toLowerCase();
  let m = lower.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return [iso(+m[1], +m[2], +m[3])];
  m = lower.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/);
  if (m) return [iso(+m[3], +m[1], +m[2]), iso(+m[3], +m[2], +m[1])];
  const month = MONTHS.findIndex(name => lower.includes(name)) + 1;
  const numbers = (lower.match(/\d+/g) || []).map(Number);
  const year = numbers.find(n => n > 999);
  const day = numbers.find(n => n <= 31);
  return month && year && day ? [iso(year, month, day)] : [];
}

// Phrases the reply puts in quotation marks: said to be word for word.
const QUOTED = /[“"]([^”"\n]{12,200})[”"]/g;

const normalize = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();

/** Every number in a text, as a canonical value: "$1,299.00" and "1299" are the same. */
function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) || [])
    .map(n => String(Number(n.replace(/,/g, ''))))
    .filter(n => n !== 'NaN');
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && Array.isArray((value as any).content)) {
    return (value as any).content.map((c: any) => (c?.type === 'text' ? String(c.text || '') : '')).join('\n');
  }
  try { return JSON.stringify(value) ?? ''; } catch { return ''; }
}

/** Add what a tool returned (or the user said) to a scope's evidence. */
export function addEvidence(scope: string, value: unknown): void {
  const text = normalize(textOf(value));
  if (!text) return;
  const ev = evidence.get(scope) || { text: '', numbers: new Set<string>(), dates: new Set<string>() };
  ev.text = `${ev.text}\n${text}`.slice(-MAX_EVIDENCE_CHARS);
  for (const n of numbersIn(text)) ev.numbers.add(n);
  for (const d of text.match(DATES) || []) for (const c of canonicalDates(d)) ev.dates.add(c);
  evidence.set(scope, ev);
}

/** Did anything a scope's tools read, or its user said, contain this text? */
export function mentioned(scope: string, text: string): boolean {
  const needle = normalize(text);
  return !!needle && !!evidence.get(scope)?.text.includes(needle);
}

/** Forget a scope's evidence: its conversation or tab assignment ended. */
export function resetEvidence(scope: string): void {
  evidence.delete(scope);
}

/**
 * The facts in `reply` that its scope's evidence does not contain. Empty
 * when nothing was collected in this worker (after a restart there is
 * nothing to check against, and flagging everything would be wrong).
 */
export function unverifiedClaims(scope: string, reply: string): string[] {
  const ev = evidence.get(scope);
  if (!ev || !reply) return [];
  const flags: string[] = [];
  const seen = new Set<string>();
  const flag = (claim: string) => {
    const key = normalize(claim);
    if (seen.has(key)) return;
    seen.add(key);
    flags.push(claim.trim());
  };
  // A number is judged once, in its most specific form ("$39.00" before "39.00").
  const judged = new Set<string>();
  for (const date of reply.match(DATES) || []) {
    const forms = canonicalDates(date);
    numbersIn(date).forEach(v => judged.add(v));
    if (forms.length && !forms.some(f => ev.dates.has(f))) flag(date);
  }
  for (const pattern of CLAIM_PATTERNS) {
    for (const match of reply.match(pattern) || []) {
      const claim = match.trim().replace(/[.,;:!?]+$/, '');
      if (!claim) continue;
      const lower = normalize(claim);
      if (/@|^https?:/.test(lower)) {
        if (!ev.text.includes(lower)) flag(claim);
        continue;
      }
      const values = numbersIn(claim);
      if (!values.length || values.every(v => judged.has(v))) continue;
      values.forEach(v => judged.add(v));
      // Every number in the claim must appear in the evidence.
      if (!values.every(v => ev.numbers.has(v))) flag(claim);
    }
  }
  for (const [, quote] of reply.matchAll(QUOTED)) {
    if (quote.trim().split(/\s+/).length >= 3 && !ev.text.includes(normalize(quote))) flag(`"${quote.trim()}"`);
  }
  // In the order the reply says them.
  const at = (flag: string) => { const i = reply.indexOf(flag.replace(/^"|"$/g, '')); return i < 0 ? reply.length : i; };
  return flags.sort((a, b) => at(a) - at(b)).slice(0, MAX_FLAGS);
}
