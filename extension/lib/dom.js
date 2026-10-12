'use strict';
// Builds page elements from data without HTML strings, so text from warframe.market or from a screenshot
// can never turn into markup: h('td', { class: 'r', title: 'Hi' }, 'text', otherElement, [more, children]).
// Attributes that are null, undefined or false are left out; true sets a boolean attribute (disabled, checked…).

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    el.setAttribute(name, value === true ? '' : String(value));
  }
  el.append(...nodes(children));
  return el;
}

// Flattens child lists and drops empty ones; numbers and strings become text.
function nodes(children) {
  const out = [];
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === '') continue;
    out.push(c instanceof Node ? c : String(c));
  }
  return out;
}

// Replaces everything inside el.
function fill(el, ...children) {
  el.replaceChildren(...nodes(children));
  return el;
}
