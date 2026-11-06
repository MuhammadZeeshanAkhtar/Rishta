/**
 * Contact details in free text — review L9.
 *
 * An interest note reaches the recipient BEFORE any match. Company decision
 * (2026-11-01): it must not carry phone numbers, email addresses or any other
 * way to reach someone off-platform before mutual acceptance. Strict by
 * design — a member whose note is refused can rephrase it, while a number that
 * gets through cannot be taken back.
 *
 * Pure and shared: the API enforces it, and any client may run it first to
 * explain a refusal before the round trip.
 *
 * What it catches:
 *   email     addresses, including "name at gmail dot com" and "(at)"/"[dot]"
 *   phone     7+ digits, however separated — spaces, dashes, dots, brackets,
 *             a leading +, Urdu/Arabic-Indic digits, full-width digits,
 *             zero-width characters, and digits spelled out in English
 *   url       http(s)://, www., and bare domains on common TLDs (wa.me, t.me/…)
 *   handle    @name
 *   platform  messaging and social platforms named outright — WhatsApp (also
 *             in Urdu script), Telegram, Instagram, Snapchat, Facebook, TikTok,
 *             LinkedIn, Skype, WeChat, Viber, Discord, Twitter — plus IMO and
 *             Signal where context makes them the app rather than the word
 *
 * What it deliberately lets through (each one has a test): degree names such
 * as M.Com and B.Com, dates, currency amounts, ages and heights, age ranges,
 * "imo" meaning "in my opinion", and sentences that merely contain "at".
 *
 * Not caught, and recorded rather than pretended: numbers spelled in Urdu
 * words, letters substituted for digits ("o3oo…"), and descriptions with no
 * identifier at all ("find me where we met"). Those need human moderation (L1).
 */

export const CONTACT_DETAIL_KINDS = ['email', 'phone', 'url', 'handle', 'platform'] as const;
export type ContactDetailKind = (typeof CONTACT_DETAIL_KINDS)[number];

const DIGIT_WORDS: Readonly<Record<string, string>> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
};

/** Lower-case, canonical digits, no invisible characters. */
function normalise(text: string): string {
  return (
    text
      // Full-width and other compatibility forms of digits and letters.
      .normalize('NFKC')
      .toLowerCase()
      // Zero-width characters, used to split a number past a naive filter.
      .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
      // Arabic-Indic (U+0660) and Extended Arabic-Indic / Urdu (U+06F0) digits.
      .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
  );
}

// An "@" written out: (at), [at], {at}, <at>, or " at " between words.
const AT = String.raw`(?:@|\s*[([{<]\s*at\s*[)\]}>]\s*|\s+at\s+)`;
// A "." written out the same ways. A plain "." must touch both sides, so the
// full stop ending "We met at uni. Then…" is never read as a domain dot.
const DOT = String.raw`(?:\.|\s*[([{<]\s*dot\s*[)\]}>]\s*|\s+dot\s+)`;
const EMAIL = new RegExp(
  String.raw`[a-z0-9][a-z0-9._%+-]*${AT}[a-z0-9-]+(?:${DOT}[a-z0-9-]+)*${DOT}[a-z]{2,}\b`,
);

const URL_SCHEME = /\bhttps?:\/\/\S+/;
const WWW = /\bwww\.\S+/;
// Bare domains. The label before the TLD needs two or more characters unless
// a path follows, so "M.Com" and "B.Com" are degrees while "t.me/name" is a
// Telegram link. Ambiguous TLDs that are also common words (co, in, us) are
// left out on purpose.
const TLDS = 'com|net|org|pk|io|me|info|biz|uk|ae|sa|link|ly|app|xyz|gl|site|online|page';
const DOMAIN = new RegExp(
  String.raw`\b(?:[a-z0-9][a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:${TLDS})\b|[a-z0-9]\.(?:${TLDS})\/\S*)`,
);

// "@name", not the "@" inside an email address.
const HANDLE = /(?:^|[^a-z0-9._@])@[a-z0-9._]{3,}/;

const PLATFORM = new RegExp(
  [
    // whatsapp, whats app, whatsap, watsapp, wats app, whtsapp, wtsapp — the
    // "s" is required, so the phrase "what app" is not a platform.
    String.raw`\b(?:wh?ats\s?app?|whtsapp|wtsapp)\b`,
    // WhatsApp written in Urdu script.
    String.raw`(?:واٹس|وٹس|واٹز)\s*(?:ایپ|اپ)`,
    String.raw`\btelegram\b`,
    String.raw`\binstagram\b`,
    String.raw`\binsta\b`,
    String.raw`\bsnap\s*chat\b`,
    String.raw`\bsnap\s*(?:id|me)\b`,
    String.raw`\bfacebook\b`,
    String.raw`\bfb\b`,
    String.raw`\btik\s*tok\b`,
    String.raw`\blinkedin\b`,
    String.raw`\bskype\b`,
    String.raw`\bwechat\b`,
    String.raw`\bviber\b`,
    String.raw`\bdiscord\b`,
    String.raw`\btwitter\b`,
    // "imo" is also "in my opinion", and "signal" an everyday word. Only the
    // app: "on imo", "imo id", "signal app", "on signal".
    String.raw`\bon\s+imo\b`,
    String.raw`\bimo\s+(?:app|id|number|no)\b`,
    String.raw`\bon\s+signal\b`,
    String.raw`\bsignal\s+(?:app|id|number|no)\b`,
  ].join('|'),
);

/** Dates are not phone numbers: 15-06-1995, 15.06.95, 15/06/1995. */
const DATE = /\b\d{1,2}[-./]\d{1,2}[-./]\d{2,4}\b/g;
/**
 * Nor are amounts: Rs 150,000 · PKR 2500000 · 25 lakh · $90k. The digit run
 * never spans a space, so an amount cannot swallow a phone number written just
 * before it ("0300 1234567 25 lakh").
 */
const AMOUNT =
  /(?:\brs\.?|\bpkr|\busd|\baed|\bsar|\bgbp|[$£€])\s*\d[\d,.]*|\d[\d,.]*\s*(?:rupees|pkr|lakh|lac|crore|k\b|usd|dollars)/g;
/** Seven or more digits, with any separators a person might put between. */
const PHONE = /\+?\d(?:[\s().-]*\d){6,}/;

function hasPhoneNumber(text: string): boolean {
  const spelled = text.replace(
    /\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/g,
    (word) => DIGIT_WORDS[word] ?? word,
  );
  return PHONE.test(spelled.replace(DATE, ' ').replace(AMOUNT, ' '));
}

/**
 * Which kinds of contact detail `text` contains, in a fixed order. Empty when
 * it contains none.
 */
export function findContactDetails(text: string): ContactDetailKind[] {
  const s = normalise(text);
  const found: ContactDetailKind[] = [];
  if (EMAIL.test(s)) found.push('email');
  if (hasPhoneNumber(s)) found.push('phone');
  if (URL_SCHEME.test(s) || WWW.test(s) || DOMAIN.test(s)) found.push('url');
  if (HANDLE.test(s)) found.push('handle');
  if (PLATFORM.test(s)) found.push('platform');
  return found;
}

/** True when `text` carries any contact detail at all. */
export function containsContactDetails(text: string): boolean {
  return findContactDetails(text).length > 0;
}
