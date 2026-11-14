import { EN } from './i18n/en';

// Svenska är källspråket: texterna skrivs på svenska i koden och den svenska texten är nyckeln.
// t('Arkivera') ger "Arkivera" på svenska och "Archive" på engelska. Variabler skrivs {namn}:
// t('{n} mejl arkiverade', { n: 3 }). Saknas en översättning visas den svenska texten.
//
// Anropa aldrig t() på modulnivå (i konstanter som skapas vid import), utan inuti funktioner,
// eftersom språket sätts först när appen startat.

export type Lang = 'sv' | 'en';
export type LangSetting = 'auto' | Lang;

let lang: Lang = 'sv';

export function setLang(l: Lang) {
  lang = l === 'en' ? 'en' : 'sv';
}

export function getLang(): Lang {
  return lang;
}

// Språkkod för datum, tal och sortering.
export function locale(): string {
  return lang === 'sv' ? 'sv-SE' : 'en-US';
}

export function resolveLang(setting: LangSetting | undefined, systemLocale: string): Lang {
  if (setting === 'sv' || setting === 'en') return setting;
  return /^sv\b/i.test(systemLocale || '') ? 'sv' : 'en';
}

export function t(sv: string, vars?: Record<string, string | number>): string {
  let s = lang === 'en' ? (EN[sv] ?? sv) : sv;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  return s;
}

// Ental och flertal: tn(n, '{n} mejl', '{n} mejl') på svenska, där engelskan har egna former i ordlistan.
export function tn(n: number, one: string, many: string, vars?: Record<string, string | number>): string {
  return t(n === 1 ? one : many, { n, ...vars });
}
