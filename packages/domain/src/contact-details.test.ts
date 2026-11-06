import { describe, expect, it } from 'vitest';
import { containsContactDetails, findContactDetails } from './contact-details';

/**
 * Contact details in interest notes (review L9; company decision 3, strict).
 *
 * Two halves, and the second matters as much as the first: a filter that
 * refuses ordinary notes would teach members that the note box is broken.
 */

describe('findContactDetails — email', () => {
  it.each([
    'ali.khan92@gmail.com',
    'Mail me: AYESHA_R@Outlook.PK',
    'ali at gmail dot com',
    'ali (at) gmail (dot) com',
    'ali[at]yahoo[dot]com',
    'ali {at} hotmail.co.uk',
  ])('catches %s', (note) => {
    expect(findContactDetails(note)).toContain('email');
  });
});

describe('findContactDetails — phone', () => {
  it.each([
    ['a Pakistani mobile', '03001234567'],
    ['dashes', '0300-1234567'],
    ['international with spaces', '+92 300 123 4567'],
    ['a landline with brackets', '(042) 3571 2345'],
    ['dots', '0300.123.4567'],
    ['every digit spaced', '0 3 0 0 1 2 3 4 5 6 7'],
    ['Urdu digits', '۰۳۰۰۱۲۳۴۵۶۷'],
    ['Arabic-Indic digits', '٠٣٠٠١٢٣٤٥٦٧'],
    ['full-width digits', '０３００１２３４５６７'],
    ['zero-width characters between digits', '0300\u200b123\u200c4567'],
    ['digits spelled out', 'zero three zero zero one two three four five six seven'],
    ['a mix of words and digits', 'zero three 00 1234567'],
    ['a number before an amount', 'call 0300 1234567 25 lakh'],
  ])('catches %s', (_label, note) => {
    expect(findContactDetails(note)).toContain('phone');
  });
});

describe('findContactDetails — url', () => {
  it.each([
    'https://example.com/me',
    'http://bit.ly/abc',
    'www.mysite.pk',
    'find me at alikhan.com',
    'wa.me/923001234567',
    't.me/alikhan',
  ])('catches %s', (note) => {
    expect(findContactDetails(note)).toContain('url');
  });
});

describe('findContactDetails — handle', () => {
  it.each(['@ali_khan', 'my id is @ayesha.r92', 'add (@alikhan)'])('catches %s', (note) => {
    expect(findContactDetails(note)).toContain('handle');
  });

  it('does not report the @ inside an email address as a handle', () => {
    expect(findContactDetails('ali@gmail.com')).not.toContain('handle');
  });
});

describe('findContactDetails — messaging and social platforms', () => {
  it.each([
    'message me on WhatsApp',
    'whats app me',
    'my watsapp is active',
    'واٹس ایپ پر رابطہ کریں',
    'Telegram works for me',
    'follow my instagram',
    'insta: ali.k',
    'add me on snapchat',
    'snap me',
    'find me on Facebook',
    'my fb is under my name',
    'TikTok',
    'LinkedIn profile',
    'skype me',
    'wechat',
    'viber',
    'discord',
    'twitter',
    'I am on imo',
    'imo id below',
    'reach me on signal',
    'signal app',
  ])('catches %s', (note) => {
    expect(findContactDetails(note)).toContain('platform');
  });
});

describe('findContactDetails — false positives it must NOT flag', () => {
  it.each([
    ['a greeting', 'Assalamu alaikum, I read your profile and liked your values.'],
    ['degrees', 'I completed my M.Com after a B.Com, and my brother did a B.Sc.'],
    ['a sentence containing "at"', 'We met at a wedding. Then our families talked.'],
    ['"at" and "dot" in prose', 'I work at a bank, and I dot every i.'],
    ['years', 'Born in 1995, moved to Lahore in 2010.'],
    ['two years side by side, with a word between', 'Between 1995 and 2010 we lived in Karachi.'],
    ['age and height', 'Age 28, height 5\'9", weight 70 kg.'],
    ['an age range', 'Looking for someone between 25-30.'],
    ['a date', 'My date of birth is 15-06-1995.'],
    ['a dotted date', 'We visited on 15.06.95 for Eid.'],
    ['a salary in rupees', 'I earn Rs 150,000 a month.'],
    ['a large amount in PKR', 'Family business turnover is PKR 2500000 per annum.'],
    ['lakh', 'Salary is 25 lakh per year.'],
    ['dollars', 'I earn $90k as an engineer.'],
    ['digit words in prose', 'I am one of seven siblings, the second of three daughters.'],
    ['"imo" meaning "in my opinion"', 'imo honesty matters more than anything.'],
    ['"signal" as a word', 'I took your interest as a positive signal.'],
    ['"what app" as a phrase', 'Which language or what app do you prefer for Quran study?'],
    ['"instant"', 'There was an instant connection with your profile.'],
    ['Urdu prose', 'السلام علیکم، آپ کا پروفائل اچھا لگا۔'],
    ['an empty note', ''],
  ])('allows %s', (_label, note) => {
    expect(findContactDetails(note)).toEqual([]);
    expect(containsContactDetails(note)).toBe(false);
  });
});

describe('findContactDetails — reporting', () => {
  it('reports every kind present, in a fixed order', () => {
    expect(findContactDetails('WhatsApp 0300 1234567, ali@gmail.com, www.ali.pk, @ali_k')).toEqual([
      'email',
      'phone',
      'url',
      'handle',
      'platform',
    ]);
  });
});
