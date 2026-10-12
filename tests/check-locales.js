// Checks the page translations (extension/locales/*.js) against the text the add-on actually uses:
// every t('…') / tk('…') key in the scripts and every data-i18n / data-i18n-attr text in app.html must be
// translated in every language, keeping the same {placeholders} (a lost {0} would drop an input from the page).
//
//   node tests/check-locales.js           check (part of npm test)
//   node tests/check-locales.js --keys    print every key, for writing translations

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.resolve(__dirname, '..', 'extension');
const SCRIPTS = ['app.js', 'scan.js', 'background.js'];
const LANGS = ['uk', 'es', 'zh-hans', 'zh-hant'];
const VOID = new Set(['input', 'br', 'img', 'meta', 'link', 'hr']);

function scriptKeys() {
  const keys = new Set();
  for (const file of SCRIPTS) {
    const src = fs.readFileSync(path.join(EXT, file), 'utf8');
    // Keys are plain string literals: t('…'), tk('…') or t("…") when they contain an apostrophe.
    for (const m of src.matchAll(/\bt[k]?\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)) {
      keys.add((m[1] ?? m[2]).replace(/\\(['"\\])/g, '$1'));
    }
  }
  return keys;
}

// A small HTML reader, enough for app.html: builds the element tree and derives keys the way translatePage does.
function htmlKeys() {
  const html = fs.readFileSync(path.join(EXT, 'app.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const root = { children: [] };
  const stack = [root];
  let last = 0;
  const text = (s) => { if (s) stack[stack.length - 1].children.push(s.replace(/&amp;/g, '&')); };
  for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g)) {
    text(html.slice(last, m.index));
    last = m.index + m[0].length;
    const [, closing, tag, attrs] = m;
    if (closing) { stack.pop(); continue; }
    const el = { tag: tag.toLowerCase(), attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!VOID.has(el.tag) && !attrs.endsWith('/')) stack.push(el);
  }
  const keys = new Set();
  const attr = (el, name) => el.attrs.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]?.replace(/&amp;/g, '&');
  const walk = (el) => {
    for (const c of el.children) {
      if (typeof c === 'string') continue;
      if (/\sdata-i18n(\s|=|$)/.test(c.attrs)) {
        let i = 0;
        keys.add(c.children.map((k) => (typeof k === 'string' ? k : `{${i++}}`)).join('').replace(/\s+/g, ' ').trim());
      }
      const attrList = attr(c, 'data-i18n-attr');
      if (attrList) for (const a of attrList.split(',')) { const v = attr(c, a.trim()); if (v) keys.add(v); }
      walk(c);
    }
  };
  walk(root);
  return keys;
}

function loadLocales() {
  const context = { LOCALES: {} };
  vm.createContext(context);
  for (const file of fs.readdirSync(path.join(EXT, 'locales'))) {
    vm.runInContext(fs.readFileSync(path.join(EXT, 'locales', file), 'utf8'), context, { filename: file });
  }
  return context.LOCALES;
}

const placeholders = (s) => [...new Set(String(s).match(/\{\w+\}/g) ?? [])].sort().join(' ');
const forms = (v) => (typeof v === 'object' ? Object.values(v) : [v]);

const keys = new Set([...scriptKeys(), ...htmlKeys()]);
if (process.argv.includes('--keys')) {
  for (const k of [...keys].sort()) console.log(k);
  process.exit(0);
}

const locales = loadLocales();
const problems = [];
for (const lang of LANGS) {
  const dict = locales[lang] ?? {};
  for (const key of keys) {
    const want = placeholders(key);
    const value = dict[key] ?? locales.en?.[key];
    if (!(key in dict)) { problems.push(`${lang}: missing "${key}"`); continue; }
    for (const form of forms(value)) {
      // A plural form may leave the number out ("один предмет"), every other placeholder must stay.
      const got = placeholders(form);
      const need = want.split(' ').filter((p) => p && (p !== '{n}' || typeof value !== 'object')).join(' ');
      if (!need.split(' ').every((p) => !p || got.includes(p))) problems.push(`${lang}: "${key}" → "${form}" lacks ${need}`);
    }
  }
  for (const key of Object.keys(dict)) if (!keys.has(key)) problems.push(`${lang}: unused "${key}"`);
}
for (const key of Object.keys(locales.en ?? {})) if (!keys.has(key)) problems.push(`en: unused "${key}"`);

if (problems.length) {
  console.error(`Translations: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n  ` + problems.join('\n  '));
  process.exit(1);
}
console.log(`Translations: ${keys.size} texts, complete in ${LANGS.join(', ')}.`);
