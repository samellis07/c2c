/**
 * Button wording, help hints, placeholders, and instruction notes.
 *
 * Self-contained browser script: no imports. It enhances an already
 * rendered form element in place, reading the wording the model carries
 * (submit and reset labels, per-field help and placeholders, stored
 * instruction markup). Markup is cleaned with the runtime sanitizer when
 * one is passed in or concatenated alongside this file; otherwise the
 * markup is shown as plain text, never as raw HTML.
 */

function ownText(value) {
  return String(value ?? '');
}

function escapeBasic(value) {
  return ownText(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function cleanMarkup(html, sanitize, doc) {
  if (typeof sanitize === 'function') return sanitize(html, doc);
  if (typeof sanitizeSnippet === 'function') return sanitizeSnippet(html, doc);
  return escapeBasic(html);
}

/**
 * True when the route addresses an existing row (the edit screen).
 * The list route carries the row id; a plain form route is the add screen.
 */
export function isEditRoute(route) {
  return Boolean(route && route.row != null && route.row !== '');
}

/**
 * Apply the model wording to a rendered `<form>` element and return it.
 * `form` is the model form. Options: `mode` (`'add'` or `'edit'`),
 * `route` (a parsed route; used when `mode` is absent), `doc` (the
 * document that owns the element), and `sanitize` (markup cleaner).
 */
export function applyFormLabels(formEl, form, options) {
  const opts = options || {};
  const mode = opts.mode || (isEditRoute(opts.route) ? 'edit' : 'add');
  const doc = opts.doc || (formEl && formEl.ownerDocument) || (typeof document !== 'undefined' ? document : null);
  const clean = (html) => cleanMarkup(html, opts.sanitize, doc);
  if (!formEl || !form) return formEl;

  applyButtons(formEl, doc, form, mode);
  applyFields(formEl, form);
  applyNotes(formEl, form, clean);
  return formEl;
}

function applyButtons(formEl, doc, form, mode) {
  const submit = formEl.querySelector('button[type="submit"]');
  const submitLabel = mode === 'edit' ? form.updateLabel || form.submitLabel : form.submitLabel;
  if (submit && submitLabel) submit.textContent = submitLabel;
  if (mode === 'edit') {
    if (form.cancelLabel) {
      let cancel = formEl.querySelector('button[data-cancel]');
      if (!cancel && doc) {
        cancel = doc.createElement('button');
        cancel.setAttribute('type', 'button');
        cancel.setAttribute('data-cancel', 'true');
        if (submit && submit.parentNode) submit.parentNode.insertBefore(cancel, submit.nextSibling);
        else formEl.appendChild(cancel);
      }
      if (cancel) cancel.textContent = form.cancelLabel;
    }
    return;
  }
  if (form.resetLabel) {
    let reset = formEl.querySelector('button[type="reset"]');
    if (!reset && doc) {
      reset = doc.createElement('button');
      reset.setAttribute('type', 'reset');
      if (submit && submit.parentNode) submit.parentNode.insertBefore(reset, submit.nextSibling);
      else formEl.appendChild(reset);
    }
    if (reset) reset.textContent = form.resetLabel;
  }
}

function blockByName(formEl) {
  const map = new Map();
  const blocks = formEl.querySelectorAll('[data-field]');
  for (let i = 0; i < blocks.length; i++) {
    const name = blocks[i].getAttribute('data-field');
    if (name != null && !map.has(name)) map.set(name, blocks[i]);
  }
  return map;
}

function applyFields(formEl, form) {
  const blocks = blockByName(formEl);
  const walk = (fields) => {
    for (const field of fields || []) {
      const block = field && blocks.get(field.name);
      if (block) {
        if (field.help != null && String(field.help) !== '') {
          let hint = block.querySelector('[data-help]');
          if (!hint) {
            const doc = block.ownerDocument;
            hint = doc.createElement('small');
            hint.setAttribute('data-help', 'true');
            const anchor = block.querySelector('[data-error-for]');
            if (anchor) block.insertBefore(hint, anchor);
            else block.appendChild(hint);
          }
          hint.textContent = String(field.help);
        }
        if (field.placeholder !== undefined) {
          const inputs = block.querySelectorAll('input, textarea');
          for (let i = 0; i < inputs.length; i++) {
            inputs[i].setAttribute('placeholder', String(field.placeholder));
          }
        }
      }
      if (field && field.subfields) walk(field.subfields);
    }
  };
  walk(form.fields);
}

function applyNotes(formEl, form, clean) {
  const withNotes = (form.fields || []).filter((field) => field && field.widget === 'notes' && field.notesHtml !== undefined);
  if (!withNotes.length) return;
  const blocks = formEl.querySelectorAll('.notes');
  for (let i = 0; i < withNotes.length && i < blocks.length; i++) {
    blocks[i].innerHTML = clean(withNotes[i].notesHtml);
  }
}
