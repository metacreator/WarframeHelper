'use strict';
// Page translations. Keys are the English text, with {name} for values filled in when shown. A translation
// can be an object of plural forms ({ one, few, many, other }), picked by the number passed as n.
// Translations live in locales/<code>.js; anything missing there falls back to English.

const LOCALES = {};
const PAGE_LANGS = { en: 'English', uk: 'Українська', es: 'Español', 'zh-hans': '简体中文', 'zh-hant': '繁體中文' };
const INTL_LOCALE = { en: 'en', uk: 'uk', es: 'es', 'zh-hans': 'zh-Hans', 'zh-hant': 'zh-Hant' };
let pageLang = 'en';

// Marks a string as a translation key where it's defined, for text translated later with t(key).
const tk = (key) => key;

function t(key, vars = {}) {
  let s = LOCALES[pageLang]?.[key] ?? LOCALES.en?.[key] ?? key;
  if (typeof s === 'object') s = s[new Intl.PluralRules(INTL_LOCALE[pageLang]).select(vars.n ?? 0)] ?? s.other;
  return s.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

function setPageLang(lang) {
  pageLang = PAGE_LANGS[lang] ? lang : 'en';
  if (typeof document !== 'undefined') document.documentElement.lang = INTL_LOCALE[pageLang];
  return pageLang;
}

// The browser's language is the best first guess, for the page and for the game.
function guessLanguage() {
  const l = (navigator.language || 'en').toLowerCase();
  if (l.startsWith('uk')) return 'uk';
  if (l.startsWith('es')) return 'es';
  if (/^zh-(tw|hk|mo|hant)/.test(l)) return 'zh-hant';
  if (l.startsWith('zh')) return 'zh-hans';
  return 'en';
}

// Static page text: elements marked data-i18n are translated in place. Their English text is the key; child
// elements (inputs, links, <kbd>…) are kept, appearing in the key as {0}, {1}… so a translation can move them.
// data-i18n-attr="title,placeholder" translates those attributes, their English value being the key.
function translatePage(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    if (!el.i18n) {
      const kids = [];
      let key = '';
      for (const n of el.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) key += n.textContent;
        else if (n.nodeType === Node.ELEMENT_NODE) { key += `{${kids.length}}`; kids.push(n); }
      }
      el.i18n = { key: key.replace(/\s+/g, ' ').trim(), kids };
    }
    const parts = t(el.i18n.key).split(/\{(\d+)\}/);
    el.replaceChildren(...parts.map((p, i) => (i % 2 ? el.i18n.kids[Number(p)] : p)).filter((p) => p !== '' && p !== undefined));
  }
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    el.i18nAttrs ??= Object.fromEntries(el.dataset.i18nAttr.split(',').map((a) => [a.trim(), el.getAttribute(a.trim())]));
    for (const [attr, key] of Object.entries(el.i18nAttrs)) if (key) el.setAttribute(attr, t(key));
  }
}
