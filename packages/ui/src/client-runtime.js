/**
 * Browser runtime for a generated Slate PWA.
 * Vanilla ES module: hash router, form render, validation, report shells.
 * No framework. The generator prepends the app model import and calls boot.
 *
 * Offline writes are not cached. Report and lookup GETs are cached by sw.js
 * only after a successful response. Submitting a form needs a network.
 */

export const PAGE_SIZE = 300;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

export const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'button', 'caption', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt',
  'em', 'figcaption', 'figure', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd',
  'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var', 'wbr',
]);

export const DROPPED_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'frame', 'frameset', 'noscript',
  'noembed', 'template', 'svg', 'math', 'title', 'head', 'html', 'body',
]);

const ALLOWED_ATTRS = {
  a: new Set(['href', 'title']),
  // A generated ExecuteFunction button carries its call route, encoded
  // arguments, and success message; the delegated click wires the POST.
  button: new Set(['type', 'data-fn-call', 'data-fn-args', 'data-fn-argc', 'data-fn-msg', 'data-fn-refresh']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  font: new Set(['color', 'face', 'size']),
  td: new Set(['colspan', 'rowspan', 'title']),
  th: new Set(['colspan', 'rowspan', 'title']),
  ol: new Set(['start', 'title']),
  '*': new Set(['title', 'data-style-dropped', 'data-zml']),
};

function flatUrl(value) {
  return String(value ?? '').replace(/[\u0000-\u0020]+/g, '').toLowerCase();
}

function safeUrl(value) {
  const flat = flatUrl(value);
  if (!flat) return true;
  return !flat.startsWith('javascript:') && !flat.startsWith('data:') && !flat.startsWith('vbscript:');
}

/** CSS functions an inline style value may call: colour notations and numeric transforms and filters. None can fetch. */
const STYLE_FUNCTIONS = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'rotate', 'rotatex', 'rotatey', 'rotatez', 'hue-rotate', 'scale', 'scalex', 'scaley',
  'translate', 'translatex', 'translatey', 'skew', 'skewx', 'skewy',
]);

/** Arguments of an allowed function: numbers with an optional unit, separated by spaces, commas or `/`. */
const STYLE_ARGS = /^\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|[a-z]{1,4})?(?:(?:\s*[,/]\s*|\s+)[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|[a-z]{1,4})?)*\s*$/i;

/** Longest style attribute or declaration value the sanitizer scans; longer values are refused. */
const STYLE_TEXT_MAX = 8192;

/** Longest calc() argument list the sanitizer parses; longer values are refused. */
const CALC_ARGS_MAX = 200;

/** ASCII letter test for CSS units and function names (the regex [a-z] with the i flag). */
function asciiLetter(ch) {
  const c = ch.charCodeAt(0) | 32;
  return c >= 97 && c <= 122;
}

/**
 * One pass over a calc() argument list, the same decisions as the old
 * CALC_ARGS regex without the backtracking: a number is an optional sign,
 * digits with an optional fraction (or a bare fraction like .5), then an
 * optional unit (% or up to four letters); + - * / operators separate the
 * numbers and spaces may sit around them.
 */
export function calcArgsSafe(args) {
  const text = String(args ?? '');
  const n = text.length;
  if (n === 0 || n > CALC_ARGS_MAX) return false;
  let i = 0;
  const spaces = () => {
    while (i < n && /\s/.test(text[i])) i++;
  };
  const number = () => {
    if (text[i] === '+' || text[i] === '-') i++;
    let whole = 0;
    while (i < n && text[i] >= '0' && text[i] <= '9') {
      i++;
      whole++;
    }
    let frac = 0;
    if (text[i] === '.') {
      i++;
      while (i < n && text[i] >= '0' && text[i] <= '9') {
        i++;
        frac++;
      }
    }
    return whole > 0 || frac > 0;
  };
  const unit = () => {
    if (text[i] === '%') {
      i++;
      return true;
    }
    let letters = 0;
    while (i < n && asciiLetter(text[i])) {
      i++;
      letters++;
    }
    return letters <= 4;
  };
  spaces();
  if (!number() || !unit()) return false;
  for (;;) {
    spaces();
    if (i >= n) return true;
    const op = text[i];
    if (op !== '+' && op !== '-' && op !== '*' && op !== '/') return false;
    i++;
    spaces();
    if (!number() || !unit()) return false;
  }
}

/**
 * Remove css comments in one pass — the same spans the old
 * /\/\*[\s\S]*?\*\//g replace dropped, pairing each opener with the next
 * closer. An unterminated opener is literal text, like the regex left it.
 */
export function stripStyleComments(value) {
  const text = String(value ?? '');
  let out = '';
  let i = 0;
  for (;;) {
    const start = text.indexOf('/*', i);
    if (start < 0) return out + text.slice(i);
    const end = text.indexOf('*/', start + 2);
    if (end < 0) return out + text.slice(i);
    out += text.slice(i, start);
    i = end + 2;
  }
}

/**
 * Rewrite each name(args) call left to right — the same matches as the old
 * /([-a-z0-9]*)\(([^()]*)\)/gi replace, without the regex: a call's name is
 * the run of [-a-z0-9] characters ending at its '(' and its arguments are
 * everything up to the next ')' with no '(' inside. Text that is not a call,
 * or whose call never closes, is kept as is.
 */
export function replaceStyleCalls(text, decide) {
  const nameChar = (ch) => ch === '-' || (ch >= '0' && ch <= '9') || asciiLetter(ch);
  let out = '';
  let i = 0;
  const n = text.length;
  let from = 0;
  while (from < n) {
    const open = text.indexOf('(', from);
    if (open < 0) break;
    let nameStart = open;
    while (nameStart > i && nameChar(text[nameStart - 1])) nameStart--;
    let close = open + 1;
    while (close < n && text[close] !== '(' && text[close] !== ')') close++;
    if (close >= n || text[close] === '(') {
      from = open + 1;
      continue;
    }
    out += text.slice(i, nameStart) + decide(text.slice(nameStart, open), text.slice(open + 1, close));
    i = close + 1;
    from = i;
  }
  return out + text.slice(i);
}

/**
 * Split an inline style into the declarations kept and the ones refused.
 * Each declaration is checked on its own: the property must be a plain CSS
 * name (never behavior or -moz-binding) and the value a safe style value, so
 * a refused declaration never takes the safe ones beside it. A trailing token
 * with no colon and no assignment, quote, escape, or call is not a declaration
 * and is left out.
 */
function cleanStyle(value) {
  const kept = [];
  const dropped = [];
  const source = String(value ?? '');
  if (source.length > STYLE_TEXT_MAX) return { style: '', dropped: ['?'] };
  const hasComment = source.includes('/*');
  const stripped = hasComment ? stripStyleComments(source) : source;
  const rawPieces = stripped.split(';').map((piece) => piece.trim()).filter(Boolean);
  for (const text of rawPieces) {
    const colon = text.indexOf(':');
    if (colon < 0) {
      if (/[=@\\'"()]/.test(text)) dropped.push('?');
      continue;
    }
    const prop = flatUrl(text.slice(0, colon));
    const body = text.slice(colon + 1).replace(/!\s*important\s*$/i, '');
    const flat = flatUrl(body);
    const safe = /^-?[-a-z]+$/.test(prop) && prop !== 'behavior' && prop !== '-moz-binding' && !flat.includes('javascript:') && !flat.includes('vbscript:') && safeStyleValue(body, prop);
    if (safe) kept.push(text);
    else dropped.push(/^-?[-a-z]+$/.test(prop) ? prop : '?');
  }
  const hasDebris = rawPieces.length !== kept.length + dropped.length;
  return { style: dropped.length ? kept.join('; ') : hasComment || hasDebris ? kept.join('; ') : source, dropped };
}

/**
 * One inline-style value: keywords, numbers, lengths, `#hex`, the allowed
 * functions with numeric arguments, `calc()` with numbers, units and + - * /,
 * and in `font-family` quoted plain names. Backslashes (CSS escapes like
 * `u\72 l(`), comments, `@` rules, nested `calc()`, and every other function
 * (`url`, `image-set`, `attr`, `var`, …) are refused.
 */
function safeStyleValue(raw, prop) {
  let text = String(raw ?? '').trim();
  if (!text || text.length > STYLE_TEXT_MAX || /[;\\@]/.test(text) || text.includes('/*')) return false;
  if (prop === 'font-family') text = text.replace(/"[A-Za-z0-9 _-]*"|'[A-Za-z0-9 _-]*'/g, 'x');
  if (/['"]/.test(text)) return false;
  const flat = flatUrl(text);
  if (flat.includes('url(') || flat.includes('expression')) return false;
  const rest = replaceStyleCalls(text, (name, args) => {
    const fn = name.toLowerCase();
    if (STYLE_FUNCTIONS.has(fn) && STYLE_ARGS.test(args)) return ' ';
    if (fn === 'calc' && calcArgsSafe(args)) return ' ';
    return '(';
  });
  return !/[()]/.test(rest);
}

function allowedAttr(tag, name) {
  if (name.startsWith('on') || name === 'srcdoc') return false;
  if (name === 'style') return true;
  const specific = ALLOWED_ATTRS[tag];
  if (tag === 'button' && /^data-fn-arg-\d+$/.test(name)) return true;
  if (specific && specific.has(name)) return true;
  return ALLOWED_ATTRS['*'].has(name);
}

function cleanNode(node, doc, dropped) {
  if (node.nodeType === 3) return doc.createTextNode(node.textContent || '');
  if (node.nodeType !== 1) return null;
  const tag = String(node.tagName || '').toLowerCase();
  if (DROPPED_TAGS.has(tag)) return null;
  const fragment = doc.createDocumentFragment();
  for (let i = 0; i < node.childNodes.length; i++) {
    const next = cleanNode(node.childNodes[i], doc, dropped);
    if (next) fragment.appendChild(next);
  }
  if (!ALLOWED_TAGS.has(tag)) return fragment;
  const out = doc.createElement(tag);
  const attrs = node.attributes;
  for (let i = 0; attrs && i < attrs.length; i++) {
    const attr = attrs[i];
    const name = attr.name.toLowerCase();
    if (!allowedAttr(tag, name)) continue;
    if ((name === 'href' || name === 'src') && !safeUrl(attr.value)) continue;
    if (name === 'style') {
      const style = cleanStyle(attr.value);
      if (style.style || !style.dropped.length) out.setAttribute('style', style.style);
      if (style.dropped.length) {
        out.setAttribute('data-style-dropped', style.dropped.join(' '));
        if (dropped) dropped.push(...style.dropped);
      }
      continue;
    }
    out.setAttribute(name, attr.value);
  }
  if (tag === 'a' && out.getAttribute('href')) out.setAttribute('rel', 'noopener noreferrer');
  out.appendChild(fragment);
  return out;
}

/**
 * Allowlist sanitizer. `doc` is the document to parse with (jsdom in tests,
 * the page document in the browser). Without a DOM the snippet is text.
 * A refused style declaration is named in the element's `data-style-dropped`
 * and, when `dropped` is an array, pushed onto it.
 */
export function sanitizeSnippet(raw, doc, dropped) {
  const documentRef = doc || (typeof document !== 'undefined' ? document : null);
  const view = documentRef && documentRef.defaultView;
  const Parser = (view && view.DOMParser) || (typeof DOMParser !== 'undefined' ? DOMParser : null);
  if (!documentRef || !Parser) return escapeHtml(raw);
  const parsed = new Parser().parseFromString(String(raw ?? ''), 'text/html');
  const sink = parsed.createElement('template');
  const bodyNodes = parsed.body.childNodes;
  for (let i = 0; i < bodyNodes.length; i++) {
    const next = cleanNode(bodyNodes[i], parsed, dropped);
    if (next) sink.content.appendChild(next);
  }
  return sink.innerHTML;
}

function isEmpty(value, widget) {
  if (typeof File !== 'undefined' && value instanceof File) return value.size === 0;
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (widget === 'decision') return value !== true && value !== 'true' && value !== 'on';
  return false;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** A real calendar date in either the ISO or the `dd-MMM-yyyy` app format. */
function clientDateValid(value) {
  const parts = parseClientDate(value);
  if (!parts) return false;
  const date = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  return date.getUTCFullYear() === parts.y && date.getUTCMonth() === parts.m - 1 && date.getUTCDate() === parts.d;
}

/** The app `date format` setting (dd-MMM-yyyy), used as the date placeholder. */
function datePlaceholder() {
  const fromModel = typeof model !== 'undefined' && model && typeof model.dateFormat === 'string' ? model.dateFormat : '';
  const fromConfig = typeof globalThis.C2C_DATE_FORMAT === 'string' ? globalThis.C2C_DATE_FORMAT : '';
  return fromModel || fromConfig || 'dd-MMM-yyyy';
}

const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹', AUD: '$', CAD: '$', NZD: '$', SGD: '$', HKD: '$', TWD: '$', MXN: '$',
  CNY: '¥', KRW: '₩', CHF: 'CHF ', SEK: 'kr', NOK: 'kr', DKK: 'kr', PLN: 'zł', CZK: 'Kč', HUF: 'Ft', RUB: '₽', TRY: '₺',
  ILS: '₪', AED: 'د.إ', SAR: '﷼', QAR: 'ر.ق', KWD: 'د.ك', BHD: 'ب.د', OMR: 'ر.ع.', ZAR: 'R', NGN: '₦', KES: 'KSh',
  EGP: 'E£', BRL: 'R$', PKR: '₨', BDT: '৳', THB: '฿', PHP: '₱', IDR: 'Rp', MYR: 'RM', VND: '₫',
};

export function validateField(field, value) {
  if (!field || field.status === 'todo' || field.readonly || field.widget === 'section' || field.widget === 'notes') return null;
  if (field.widget === 'subform') {
    const rows = Array.isArray(value) ? value : [];
    if (field.required && rows.length === 0) return 'Add at least one row.';
    for (const row of rows) {
      for (const sub of field.subfields || []) {
        const err = validateField(sub, row && row[sub.name]);
        if (err) return `${sub.label}: ${err}`;
      }
    }
    return null;
  }
  if (field.widget === 'name' || field.widget === 'address') {
    const obj = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    let any = false;
    for (const sub of field.subfields || []) {
      if (!isEmpty(obj[sub.name], sub.widget)) any = true;
      const err = validateField({ ...sub, required: sub.required || false }, obj[sub.name]);
      if (err) return `${sub.label}: ${err}`;
    }
    if (field.required && !any) return 'Enter a value.';
    return null;
  }
  if (field.required && isEmpty(value, field.widget)) return 'This field is required.';
  if (isEmpty(value, field.widget)) return null;
  const text = Array.isArray(value) ? value.join(',') : String(value).trim();
  if (field.maxLength && text.length > field.maxLength) return `Use at most ${field.maxLength} characters.`;
  if (field.minLength && text.length < field.minLength) return `Use at least ${field.minLength} characters.`;
  if (field.widget === 'email' && !EMAIL.test(text)) return 'Enter an email address.';
  if (field.widget === 'phone' && !/^[+()\d][\d\s().-]{5,}$/.test(text)) return 'Enter a phone number.';
  if (field.widget === 'number' && !/^-?\d+$/.test(text)) return 'Enter a whole number.';
  if ((field.widget === 'decimal' || field.widget === 'percent' || field.widget === 'currency') && !/^-?\d+(\.\d+)?$/.test(text)) {
    return 'Enter a number.';
  }
  if (field.widget === 'date' && !clientDateValid(text)) return `Enter a date as ${datePlaceholder()}.`;
  if (field.widget === 'datetime' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(text)) return 'Enter a date and time.';
  if (field.widget === 'time' && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(text)) return 'Enter a time as HH:MM.';
  if (field.widget === 'url') {
    try {
      const url = new URL(text);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Enter an http(s) URL.';
    } catch {
      return 'Enter a URL.';
    }
  }
  if (field.pattern) {
    let re;
    try {
      re = new RegExp(field.pattern);
    } catch {
      return 'This field has a pattern the form could not compile.';
    }
    if (!re.test(text)) return 'This value does not match the required pattern.';
  }
  if (field.choices && field.choices.length && field.widget !== 'lookup' && field.widget !== 'lookup-multi') {
    const items = Array.isArray(value) ? value.map(String) : [text];
    for (const item of items) {
      if (!field.choices.includes(item)) return 'Choose a listed value.';
    }
  }
  return null;
}

export function validateForm(form, values) {
  const errors = {};
  for (const field of form.fields || []) {
    const err = validateField(field, values ? values[field.name] : undefined);
    if (err) errors[field.name] = err;
  }
  return errors;
}

/**
 * Stable control id for a field. Subfields render under their parent form with
 * a prefix, so every id on the page is unique and every label pairs with one.
 */
function fieldDomId(field, prefix) {
  const raw = `${prefix || 'f-'}${field.name || 'field'}`.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return raw || 'f-field';
}

/**
 * The choices of a stored multi-value cell, the browser twin of the shims
 * decodeMultiValue: a list, JSON list text (["No"]), a Deluge list literal
 * ({"No"}), the legacy unquoted list ([No]) or one bare choice. An edit form
 * prefills from it, so saving without touching the field keeps its choices.
 */
export function multiValueItems(value) {
  const clean = (items) => items.filter((item) => item !== null && item !== undefined).map((item) => String(item).trim()).filter((item) => item.length > 0);
  const bare = (text) => clean(text.slice(1, -1).split(',').map((item) => item.trim().replace(/^(["'])([\s\S]*)\1$/, '$2')));
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return clean(value);
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (typeof value !== 'string') return [];
  const text = value.trim();
  if (!text) return [];
  if (text.startsWith('[') && text.endsWith(']')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return bare(text);
    }
    if (Array.isArray(parsed) && parsed.every((item) => item === null || typeof item !== 'object')) return clean(parsed);
  }
  if (text.startsWith('{') && text.endsWith('}')) return bare(text);
  return [text];
}

function fieldControl(field, id, describedBy) {
  const name = escapeHtml(field.name);
  const required = field.required ? ' required aria-required="true"' : '';
  const readOnly = field.readonly ? ' readonly' : '';
  const max = field.maxLength ? ` maxlength="${field.maxLength}"` : '';
  const pattern = field.pattern ? ` pattern="${escapeHtml(field.pattern)}"` : '';
  const initial = field.initialValue != null ? ` value="${escapeHtml(field.initialValue)}"` : '';
  const described = describedBy ? ` aria-describedby="${describedBy}"` : '';
  const idAttr = ` id="${id}"`;
  if (field.widget === 'textarea' || field.widget === 'richtext') {
    return `<textarea${idAttr} name="${name}"${required}${readOnly}${max}${described}>${escapeHtml(field.initialValue ?? '')}</textarea>`;
  }
  if (field.widget === 'decision') {
    const checked = field.initialValue === 'true' ? ' checked' : '';
    return `<input${idAttr} name="${name}" type="checkbox"${checked}${required}${described}>`;
  }
  if (field.matrixId === 'checkbox-multi') {
    return (field.choices || [])
      .map(
        (choice, index) => {
          const cid = `${id}-choice-${index}`;
          return `<label class="choice" for="${cid}"><input id="${cid}" type="checkbox" name="${name}" value="${escapeHtml(choice)}" data-choice="true"${required}${described}> ${escapeHtml(choice)}</label>`;
        },
      )
      .join('');
  }
  if (field.widget === 'select' || field.widget === 'multiselect' || field.widget === 'lookup' || field.widget === 'lookup-multi' || field.widget === 'users') {
    const multiple = field.widget === 'multiselect' || field.widget === 'lookup-multi' ? ' multiple' : '';
    const lookup = field.lookup ? ` data-lookup="${escapeHtml(field.lookup.endpoint)}"` : '';
    const initialValue = field.initialValue != null ? String(field.initialValue) : '';
    // A multi select initial value is the stored JSON list text (["No"]); each item is selected.
    const initialItems = field.widget === 'multiselect' ? multiValueItems(initialValue) : initialValue !== '' ? [initialValue] : [];
    const mark = (choice) => (initialItems.includes(String(choice)) ? ' selected' : '');
    const listed = new Set((field.choices || []).map((choice) => String(choice)));
    const options = (field.choices || []).map((choice) => `<option value="${escapeHtml(choice)}"${mark(choice)}>${escapeHtml(choice)}</option>`).join('');
    // The export initial value is a real option even when it is not a listed choice.
    const extra = initialItems.filter((item) => !listed.has(item)).map((item) => `<option value="${escapeHtml(item)}" selected>${escapeHtml(item)}</option>`).join('');
    const blank = multiple ? '' : '<option value="">-Select-</option>';
    return `<select${idAttr} name="${name}"${multiple}${required}${lookup}${described}>${blank}${extra}${options}</select>`;
  }
  if (field.widget === 'radio') {
    const choices = field.choices || [];
    return choices
      .map(
        (choice, index) => {
          const cid = `${id}-choice-${index}`;
          return `<label class="choice" for="${cid}"><input id="${cid}" type="radio" name="${name}" value="${escapeHtml(choice)}"${required}${described}> ${escapeHtml(choice)}</label>`;
        },
      )
      .join('');
  }
  if (field.widget === 'file' || field.widget === 'image' || field.widget === 'audio' || field.widget === 'video') {
    const accept = field.accept ? ` accept="${escapeHtml(field.accept)}"` : '';
    const verb = field.widget === 'image' ? 'Select Image' : field.widget === 'audio' ? 'Select Audio' : field.widget === 'video' ? 'Select Video' : 'Select File';
    return `<span class="filepick"><label class="filepick-btn" for="${id}">${verb}</label><input${idAttr} name="${name}" type="file"${accept}${required}${described} data-upload="${escapeHtml(field.uploadEndpoint || '')}" class="visually-hidden"><span class="filepick-name"></span></span>`;
  }
  if (field.widget === 'signature') {
    return `<canvas data-signature="${name}" width="320" height="120"></canvas><button type="button" data-signature-save="${name}">Save signature</button><input${idAttr} name="${name}" type="hidden" data-upload="${escapeHtml(field.uploadEndpoint || '')}">`;
  }
  if (field.widget === 'subform') {
    const heads = (field.subfields || [])
      .map((sub) => `<th scope="col">${escapeHtml(sub.label)}${sub.required ? '<span class="req" aria-hidden="true"> *</span>' : ''}</th>`)
      .join('');
    // The trailing ops column holds each row's delete button — Creator's
    // grid rows carry a remove affordance.
    return `<div class="subform" data-field="${name}"><table><thead><tr>${heads}<th scope="col" data-row-ops><span class="sr-only">Remove row</span></th></tr></thead><tbody></tbody></table><button id="${id}-add" type="button" data-add-row="${name}">+ Add New</button></div>`;
  }
  if (field.widget === 'name' || field.widget === 'address') {
    return `<fieldset><legend>${escapeHtml(field.label)}${field.required ? '<span class="req" aria-hidden="true"> *</span>' : ''}</legend>${(field.subfields || []).map((sub) => fieldBlock(sub, `${id}-`)).join('')}<p class="error" data-error-for="${name}"></p></fieldset>`;
  }
  if (field.widget === 'section') return '';
  if (field.widget === 'notes') return '';
  if (field.widget === 'unsupported') return '';
  if (field.widget === 'currency') {
    const symbol = (field.currencyCode && CURRENCY_SYMBOLS[field.currencyCode]) || field.currencyCode || '';
    const input = `<input${idAttr} name="${name}" type="text" inputmode="decimal"${required}${readOnly}${pattern}${initial}${described}>`;
    return `<span class="money">${input}${symbol ? `<span class="money-sym" aria-hidden="true">${escapeHtml(symbol)}</span>` : ''}</span>`;
  }
  const type =
    field.widget === 'email'
      ? 'email'
      : field.widget === 'phone'
        ? 'tel'
        : field.widget === 'number' || field.widget === 'decimal' || field.widget === 'percent'
          ? 'text'
          : field.widget === 'date'
            ? 'text'
            : field.widget === 'datetime'
              ? 'datetime-local'
              : field.widget === 'time'
                ? 'time'
                : field.widget === 'url'
                  ? 'url'
                  : field.matrixId === 'encrypted'
                    ? 'password'
                    : 'text';
  const inputMode = field.widget === 'number' || field.widget === 'decimal' || field.widget === 'percent' ? ' inputmode="decimal"' : '';
  const placeholder = field.widget === 'date' ? ` placeholder="${escapeHtml(datePlaceholder())}"` : '';
  return `<input${idAttr} name="${name}" type="${type}"${inputMode}${placeholder}${required}${readOnly}${max}${pattern}${initial}${described}${field.scan ? ' data-scan="true"' : ''}>`;
}

/** First choice id of a group control, so the field label pairs with a control. */
function groupLabelFor(field, id) {
  if ((field.matrixId === 'checkbox-multi' || field.widget === 'radio') && field.choices && field.choices.length) return `${id}-choice-0`;
  if (field.widget === 'subform') return `${id}-add`;
  return id;
}

function fieldBlock(field, prefix) {
  const id = fieldDomId(field, prefix);
  // Why a field is not generated is a migration note for the developer: it
  // stays in the migration report and goes to the console, never the form.
  if (field.status === 'todo' && field.widget !== 'section' && field.widget !== 'notes') console.info(`[c2c] field "${field.name}" is not generated: ${field.todo || field.widget}`);
  const errors = `<p class="error" data-error-for="${escapeHtml(field.name)}"></p>`;
  // A Section pseudo-field with no display name draws no heading at all.
  if (field.widget === 'section') return field.titled === false ? '' : `<h2 data-span="all">${escapeHtml(field.label)}</h2>`;
  // A notes block shows its stored instruction markup, never the field's link name.
  if (field.widget === 'notes') {
    const clean = field.notesHtml ? sanitizeSnippet(field.notesHtml, typeof document !== 'undefined' ? document : undefined) : '';
    return `<div class="notes" data-field="${escapeHtml(field.name)}" data-span="all">${clean}</div>`;
  }
  if (field.widget === 'unsupported') {
    return `<div class="field" data-field="${escapeHtml(field.name)}" data-widget="${escapeHtml(field.widget)}"><span class="field-title">${escapeHtml(field.label)}</span><p class="unavailable-note">This field is not available yet.</p>${errors}</div>`;
  }
  const wide = field.widget === 'subform' || field.widget === 'textarea' || field.widget === 'richtext' ? ' data-span="all"' : '';
  // Name and address parts carry their own labels; the fieldset legend names the group.
  const label = field.widget === 'name' || field.widget === 'address'
    ? ''
    : `<label for="${groupLabelFor(field, id)}">${escapeHtml(field.label)}${field.required ? '<span class="req" aria-hidden="true"> *</span>' : ''}</label>`;
  return `<div class="field"${wide} data-field="${escapeHtml(field.name)}" data-widget="${escapeHtml(field.widget)}">${label}${fieldControl(field, id)}${errors}</div>`;
}

export function renderForm(form) {
  const layout = form && (form.layout === 'two' || form.layout === 'three') ? form.layout : 'one';
  const fields = (form.fields || []).map((field) => fieldBlock(field)).join('');
  return `<section class="card" data-form-card><h1>${escapeHtml(form.label || form.name)}</h1><form data-form="${escapeHtml(form.name)}" data-layout="${layout}" data-submit="${escapeHtml(form.submitEndpoint || '')}" novalidate><div class="form-grid">${fields}</div><p data-banner></p><button type="submit">Submit</button></form></section>`;
}

const BOARD_VIEWS = new Set(['kanban', 'calendar', 'timeline']);

function cellText(row, field) {
  return row && field && row[field] != null ? String(row[field]) : '';
}

/**
 * Group rows into lanes in first-seen order: kanban by the lane field, calendar
 * and timeline by the day part of the start date (rows arrive sorted by it).
 */
export function boardLanes(report, rows) {
  const lanes = [];
  const byKey = new Map();
  for (const row of rows || []) {
    let key;
    if (report.view === 'kanban') key = cellText(row, report.groupField);
    else key = cellText(row, report.startField).split(/[ T]/)[0];
    let lane = byKey.get(key);
    if (!lane) {
      lane = { key, rows: [] };
      byKey.set(key, lane);
      lanes.push(lane);
    }
    lane.rows.push(row);
  }
  return lanes;
}

/** A board card's phone fields: label and value of each phone column, shown only on a phone. */
function boardPhoneFields(doc, phone, row) {
  const fields = doc.createElement('dl');
  fields.setAttribute('data-phone-fields', '');
  for (const column of phone) {
    const term = doc.createElement('dt');
    term.textContent = column.label || column.field;
    const value = doc.createElement('dd');
    value.textContent = cellText(row, column.field);
    fields.appendChild(term);
    fields.appendChild(value);
  }
  return fields;
}

function fillBoard(report, board, rows) {
  const doc = board.ownerDocument;
  const phone = Array.isArray(report.phoneColumns) ? report.phoneColumns : [];
  board.textContent = '';
  for (const lane of boardLanes(report, rows)) {
    const box = doc.createElement('div');
    box.setAttribute('data-lane', lane.key);
    const head = doc.createElement('h3');
    head.textContent = `${lane.key || '(none)'} (${lane.rows.length})`;
    box.appendChild(head);
    const list = doc.createElement('ul');
    for (const row of lane.rows) {
      const item = doc.createElement('li');
      const title = cellText(row, report.titleField);
      if (report.view === 'kanban') item.textContent = title;
      else {
        const end = cellText(row, report.endField);
        const start = cellText(row, report.startField);
        item.textContent = end ? `${title} — ${start} to ${end}` : `${title} — ${start}`;
      }
      if (phone.length) item.appendChild(boardPhoneFields(doc, phone, row));
      list.appendChild(item);
    }
    box.appendChild(list);
    board.appendChild(box);
  }
}

/**
 * Request-state markup for a report. The copy is the same on every deploy:
 * nothing here names a deploy mode, so a live page never shows preview words.
 */
export function reportStateHtml(state, opts) {
  const options = opts || {};
  if (state === 'loading') {
    return `<div data-state="loading" role="status"><p>Loading…</p><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span></div>`;
  }
  if (state === 'empty') {
    const action = options.formHref
      ? `<a class="button-primary" href="${escapeHtml(options.formHref)}">Add a record</a>`
      : '';
    return `<div data-state="empty"><div class="state-empty"><p>No records yet</p>${action}</div></div>`;
  }
  if (state === 'error') {
    return `<div data-state="error" role="alert"><div class="state-error"><p>Could not load these records.</p><button type="button" data-retry>Retry</button></div></div>`;
  }
  return '';
}

/**
 * User-facing toast and banner copy for a submit, edit, or delete result.
 * The server answers every write with a dryRun flag; only a dry-run answer
 * may carry the preview sentence. A live answer never does.
 */
export function submitNotice(result) {
  const outcome = result || {};
  const message = typeof outcome.message === 'string' && outcome.message.trim() ? outcome.message : '';
  if (outcome.ok) {
    const base = message || DEFAULT_SUCCESS_BANNER;
    return outcome.dryRun ? `${base} Preview: nothing was saved yet.` : base;
  }
  const base = message || 'The record was not saved.';
  return outcome.dryRun ? `${base} Preview: nothing was saved yet.` : base;
}

/** Formats a mail outcome note into user-facing non-blocking notice copy. */
export function mailNoticeText(item) {
  if (!item || typeof item !== 'object') return '';
  const status = typeof item.status === 'string' && item.status ? item.status : 'outcome';
  const reason = typeof item.reason === 'string' && item.reason ? `: ${item.reason}` : '';
  const logFail = item.logged === false && item.status !== 'skipped' ? ' (delivery log failed)' : '';
  return `Mail ${status}${reason}${logFail}`;
}

/**
 * One idempotency key per opened form, sent with every submit of that form
 * until one commits. A repeat of the key (a retry after a lost or failed
 * reply) gets the server's first committed answer back, never a second row.
 */
export function newSubmitKey() {
  const cryptoRef = globalThis.crypto;
  // determinism-allow: a browser-runtime key minted per opened form; it never reaches generated bytes
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return `c2c-${cryptoRef.randomUUID()}`;
  const bytes = new Uint8Array(16);
  if (cryptoRef && typeof cryptoRef.getRandomValues === 'function') cryptoRef.getRandomValues(bytes);
  // determinism-allow: browser-runtime fallback key only; it never reaches generated bytes
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return `c2c-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Whether a submit answer means the row is stored: a 2xx, or any answer whose
 * body says wrote true (the row committed and a later step failed).
 */
export function submitCommitted(res, body) {
  return !!(res && (res.ok || (body && body.wrote === true)));
}

/** Append a success or failure toast to the live region (or the body without one). */
export function showToast(doc, kind, text) {
  const documentRef = doc || (typeof document !== 'undefined' ? document : null);
  if (!documentRef) return null;
  const host = (typeof documentRef.getElementById === 'function' && documentRef.getElementById('toasts')) || documentRef.body;
  if (!host) return null;
  const el = documentRef.createElement('div');
  el.className = 'toast';
  el.setAttribute('data-kind', kind);
  el.setAttribute('role', 'status');
  el.textContent = String(text ?? '');
  host.appendChild(el);
  return el;
}

/** In-app chart report chrome: title, Refresh/Sort controls, and the drawing area. */
function chartPanel(report, heading) {
  return `<section class="card" data-report="${escapeHtml(report.name)}" data-view="chart" data-endpoint="${escapeHtml(report.queryEndpoint || '')}" data-page-size="${report.pageSize || PAGE_SIZE}"><${heading}>${escapeHtml(report.label || report.name)}</${heading}><div class="report-tools" data-chart-tools><button type="button" data-chart-refresh>Refresh</button><button type="button" data-chart-sort>Sort</button></div><div data-state></div><div data-chart></div></section>`;
}

/**
 * A custom action button. An action whose endpoint is a dry-run stub
 * (`preview`) renders turned off: a click would report a run that saved nothing.
 */
function actionButtonHtml(report, endpoint, label, row) {
  const nav = actionNavOf(report, endpoint);
  if (nav) return navLinkHtml(nav, label, row);
  const preview = (report.customActions || []).some((action) => action && action.endpoint === endpoint && action.preview);
  const off = preview ? ' disabled title="Not available yet: this action is turned off."' : '';
  return `<button type="button" data-action="${escapeHtml(endpoint)}"${off}>${escapeHtml(label)}</button>`;
}

/** The client navigation of the action posting to `endpoint`, or undefined. */
function actionNavOf(report, endpoint) {
  const action = (report.customActions || []).find((item) => item && item.endpoint === endpoint);
  return action && action.navigate && typeof action.navigate.href === 'string' ? action.navigate : undefined;
}

/** A navigation that prefills from the clicked row needs a row to open. */
export function navNeedsRow(nav) {
  return (nav.params || []).some((param) => param && typeof param.field === 'string');
}

/**
 * The route a navigation custom action opens: the target's own route (so its
 * access gate runs as for any visit) plus a query that prefills the target
 * form. A row value is sent only when the row the caller read holds it as a
 * scalar; a field the caller cannot read is not on the row and prefills
 * nothing.
 */
export function actionNavHref(nav, row) {
  const query = [];
  for (const param of nav.params || []) {
    if (!param || typeof param.name !== 'string') continue;
    let value;
    if (typeof param.field === 'string') {
      const raw = row && typeof row === 'object' && Object.prototype.hasOwnProperty.call(row, param.field) ? row[param.field] : undefined;
      if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') value = String(raw);
    } else if (typeof param.value === 'string') value = param.value;
    if (value !== undefined && value !== '') query.push(`${encodeURIComponent(param.name)}=${encodeURIComponent(value)}`);
  }
  return query.length ? `${nav.href}?${query.join('&')}` : nav.href;
}

function navLinkHtml(nav, label, row) {
  return `<a href="${escapeHtml(actionNavHref(nav, row))}" data-action-nav="">${escapeHtml(label)}</a>`;
}

/** Navigation actions shown per record: every one that is not a column, unless it is a header action needing no row. */
function recordNavActions(report) {
  return (report.customActions || []).filter(
    (action) => action && action.navigate && !(report.columns || []).some((column) => column && column.action === action.endpoint) && (action.header !== true || navNeedsRow(action.navigate)),
  );
}

/** The note naming the custom actions that are turned off, or ''. */
export function previewActionsNote(report) {
  const names = (report.customActions || []).filter((action) => action && action.preview).map((action) => String(action.name).trim());
  return names.length ? `<p class="todo" data-action-preview>${escapeHtml(`Not available yet, so turned off: ${names.join(', ')}.`)}</p>` : '';
}

export function renderReport(report) {
  if (report.status === 'todo') {
    // The screen keeps its heading and a neutral line; the reason is a
    // migration note, kept in the migration report and the console only.
    console.info(`[c2c] report "${report.name}" is not generated: ${report.todo || ''}`);
    return `<section class="card" data-report="${escapeHtml(report.name)}" data-view="todo"><h1>${escapeHtml(report.label || report.name)}</h1><p class="unavailable-note">This part of the page is not available yet.</p></section>`;
  }
  if (report.view === 'chart') return chartPanel(report, 'h1');
  // A conditional format whose condition did not translate is a migration
  // note: listed in the migration report and the console, never the screen.
  if ((report.conditionalFormats || []).some((format) => criteriaTodo(format && format.criteria))) {
    console.info(`[c2c] report "${report.name}": a conditional formatting rule was not migrated; its highlighting is off`);
  }
  // A map/pivot that fell back to a list view says so, never silently.
  const viewNote = report.note ? `<p class="notes" data-report-note>${escapeHtml(report.note)}</p>` : '';
  const cols = (report.columns || [])
    .map(
      (column) =>
        `<th scope="col" data-field="${escapeHtml(column.field)}"${column.numeric ? ' data-numeric="true"' : ''}>${escapeHtml(column.label || column.field)}</th>`,
    )
    .join('');
  // Only `show action in view header = true` actions sit in the toolbar.
  // Record-menu and `column header` actions are per-record, not header chrome.
  const actions = (report.customActions || [])
    .filter((action) => action.header === true && !(action.navigate && navNeedsRow(action.navigate)))
    .map((action) => actionButtonHtml(report, action.endpoint, action.name))
    .join('');
  const filters = (report.filters || [])
    .map((filter) => {
      const label = filter.label || filter.field || '';
      return `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`;
    })
    .join('');
  // The blank option is the default. The posted value is the label; the server maps a predefined label to criteria baked into the report module.
  const filterSelect = filters ? `<select data-filter aria-label="Filter"><option value=""></option>${filters}</select>` : '';
  // Record affordances are a trailing column — Creator's per-row Edit/Delete.
  const opsHead = (report.rowActions && (report.rowActions.edit || report.rowActions.delete)) || recordNavActions(report).length ? '<th scope="col" data-row-ops></th>' : '';
  const bulkHead = report.rowActions && report.rowActions.edit ? '<th scope="col">Select</th>' : '';
  // Kanban, calendar and timeline fill grouped lanes; every other view is a table.
  const rowsHtml = BOARD_VIEWS.has(report.view)
    ? '<div data-board></div>'
    : `<div class="table-wrap"><table><thead><tr>${bulkHead}${cols}${opsHead}</tr></thead><tbody></tbody></table></div>`;
  const detailAttr = report.detail ? ' data-detail="true"' : '';
  const formAttr = report.form ? ` data-form="${escapeHtml(report.form)}"` : '';
  const bulk = report.form && report.rowActions && report.rowActions.edit
    ? '<div class="report-tools"><button type="button" data-bulk-edit disabled>Edit selected</button><span data-bulk-count aria-live="polite">No rows selected</span></div>'
    : '';
  // Toolbar, grid, and pagination start hidden: the export's default controls
  // appear only after a successful non-empty load (see setReportChrome).
  return `<section class="card" data-report="${escapeHtml(report.name)}" data-view="${escapeHtml(report.view)}" data-endpoint="${escapeHtml(report.queryEndpoint)}" data-page-size="${report.pageSize || PAGE_SIZE}"${detailAttr}${formAttr}><h1>${escapeHtml(report.label || report.name)}</h1>${viewNote}${previewActionsNote(report)}${bulk}<div class="report-tools" data-report-tools hidden><form data-report-search><input name="q" type="search" aria-label="Search"><button type="submit">Search</button></form>${filterSelect}${actions}</div><div data-state></div><div data-rows hidden>${rowsHtml}</div><nav data-pages aria-label="Report pages" hidden><button type="button" data-prev>Previous</button><span data-page-label>Page 1</span><button type="button" data-next>Next</button></nav></section>`;
}

/** The model this page renders with: the boot argument, else the module import. */
function elementModel(appModel) {
  return appModel || (typeof model !== 'undefined' ? model : null) || null;
}

/** The display name for an embed: the label of the report/form/page it names. */
function elementLabel(el, appModel) {
  const m = elementModel(appModel);
  const lists = m ? (m.reports || []).concat(m.forms || [], m.pages || []) : [];
  const hit = lists.find((item) => item && item.name === el.name);
  return (hit && (hit.label || hit.name)) || el.name || el.tag;
}

function elementReport(name, appModel) {
  const m = elementModel(appModel);
  const lists = m ? m.reports || [] : [];
  return lists.find((item) => item && item.name === name) || null;
}

/** Serialized inline CSS from the export's presentation attributes. */
function styleAttr(el) {
  const style = el && el.style;
  if (!style) return '';
  const parts = [];
  for (const key of Object.keys(style)) { // determinism-allow: object built in fixed STYLE_ATTRS order
    if (!/^[a-z-]+$/.test(key)) continue;
    if (!safeStyleValue(style[key])) continue;
    const value = String(style[key]).replace(/[;<>"]/g, '');
    if (value.trim()) parts.push(`${key}:${value}`);
  }
  return parts.length ? ` style="${escapeHtml(parts.join(';'))}"` : '';
}

/**
 * Authority text from an https URL exactly as written: the run between '//'
 * and the first '/', '?', or '#'. URL schemes are case-insensitive, so the
 * scheme match accepts 'HTTPS:' as written. The URL parser canonicalises percent
 * escapes, Unicode dot separators, and case in the host, so a link-out is
 * only allowed when this raw text is already a canonical lowercase ASCII
 * host: [a-z0-9.-] only, no '%', userinfo, port, or non-ASCII bytes.
 */
function embedRawAuthority(rawUrl) {
  const match = /^https:\/\/([^/?#]*)/i.exec(rawUrl);
  return match ? match[1] : '';
}

function embedAuthorityHasUserinfo(rawUrl) {
  const match = /^https:\/\/([^/?#]*)/i.exec(rawUrl);
  return !!match && match[1].includes('@');
}

/**
 * 'pdf' or 'map' only for a canonical https URL. The raw authority must be
 * plain lowercase ASCII and equal the parsed hostname, so percent-encoded,
 * Unicode-dot, uppercase, trailing-dot, ported, userinfo, and IDN hosts the
 * parser rewrites are not link-outs. Map hosts match the provider list
 * exactly (a suffix such as maps.google.com.evil.example does not).
 */
function embedLinkOutKind(rawUrl, parsed) {
  // The parser strips tabs/newlines and trims edge whitespace; any such byte
  // in the raw text means it is not the canonical form the parser produced.
  if (/\s/.test(rawUrl)) return '';
  const written = embedRawAuthority(rawUrl);
  if (!/^[a-z0-9.-]+$/.test(written) || written !== parsed.hostname || written.endsWith('.')) return '';
  if (written.split('.').some((label) => label.startsWith('xn--'))) return '';
  const pdf = /\.pdf$/i.test(parsed.pathname);
  const host = parsed.hostname;
  const map =
    host === 'maps.google.com' ||
    (host === 'www.google.com' && /^\/maps(?:\/|$)/i.test(parsed.pathname)) ||
    ((host === 'openstreetmap.org' || host === 'www.openstreetmap.org') &&
      /^\/export\/embed\.html$/i.test(parsed.pathname));
  if (pdf) return 'pdf';
  if (map) return 'map';
  return '';
}

function renderElement(el, doc, parentReport, appModel) {
  const childReport =
    el.kind === 'container' && typeof el.href === 'string' && el.href.startsWith('#/report/')
      ? decodeURIComponent(el.href.slice('#/report/'.length))
      : parentReport;
  const kids = (el.children || []).map((child) => renderElement(child, doc, childReport, appModel)).join('');
  if (el.icon) {
    // Decorative icon: a glyph, never the exported icon name as text.
    const mark = typeof c2cIconGlyph === 'function' ? c2cIconGlyph(el.icon) : '';
    return `<span class="zicon" data-icon="${escapeHtml(el.icon)}" aria-hidden="true"${styleAttr(el)}>${mark}</span>${kids}`;
  }
  if (el.kind === 'container') {
    const width = el.width ? ` data-width="${escapeHtml(el.width)}"` : '';
    let sizing = {};
    if (el.width === 'fill') sizing = { flex: '1', 'min-width': '0' };
    else if (el.width === 'auto') sizing = { flex: 'none', width: 'auto' };
    else if (el.width && /^[0-9.]+%$/.test(el.width)) sizing = { width: el.width, 'box-sizing': 'border-box' };
    const style = styleAttr({ style: { ...sizing, ...(el.style || {}) } });
    const inner = `<div data-zml="${escapeHtml(el.tag)}"${width}${style}>${kids}</div>`;
    // A card that opens a report is itself the link.
    if (el.href) return `<a class="zcard" href="${escapeHtml(el.href)}">${inner}</a>`;
    return inner;
  }
  if (el.kind === 'html') {
    const clean = sanitizeSnippet(el.html || '', doc);
    const markers = (el.popups || [])
      .map(
        (popup) =>
          `<span data-popup-trigger data-popup-target="${escapeHtml(popup.target)}" data-popup-name="${escapeHtml(popup.name)}" data-popup-when="${escapeHtml(popup.when)}"${popup.whenForm ? ` data-popup-when-form="${escapeHtml(popup.whenForm)}"` : ''} hidden></span>`,
      )
      .join('');
    const inner = el.src ? `<div data-snippet-src="${escapeHtml(el.src)}">${clean}</div>` : clean;
    const includes = (el.includes || []).filter((item) => /^[A-Za-z_]\w*$/.test(item));
    const declared = includes.length ? ` data-page-includes="${escapeHtml(includes.join(' '))}"` : '';
    const components = (el.components || []).filter((item) => item && (item.kind === 'form' || item.kind === 'report') && /^[A-Za-z_]\w*$/.test(item.name));
    const componentDecl = components.length ? ` data-page-components="${escapeHtml(components.map((item) => `${item.kind}:${item.name}`).join(' '))}"` : '';
    return `${inner.trim() || markers ? `<div class="snippet"${declared}${componentDecl}>${inner}${markers}</div>` : ''}${kids}`;
  }
  if (el.kind === 'embed') {
    const spec = el.embed || {};
    const url = typeof spec.url === 'string' ? spec.url : '';
    let parsed;
    try { parsed = new URL(url); } catch { return kids; }
    // Credential URLs and non-HTTPS schemes (javascript:, data:, http:) are
    // dropped. A frame or a link would send or display those credentials.
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || embedAuthorityHasUserinfo(url)) return kids;
    // Sandboxed browser PDF viewers and script-dependent map widgets often
    // render blank. Link canonical PDFs and exact map providers out instead
    // of granting them sandbox capabilities. Unknown and non-canonical HTTPS
    // embeds (lookalike, uppercase, trailing-dot, and IDN hosts) stay locked.
    const kind = embedLinkOutKind(url, parsed);
    if (kind) {
      const label = el.name || (kind === 'pdf' ? 'Open PDF' : 'Open map');
      return `<div class="embed"><a href="${escapeHtml(parsed.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a></div>${kids}`;
    }
    const embedWidth = /^[0-9]+$/.test(spec.width || '') ? ` width="${spec.width}"` : '';
    const embedHeight = /^[0-9]+$/.test(spec.height || '') ? ` height="${spec.height}"` : '';
    return `<iframe class="embed" src="${escapeHtml(url)}" sandbox=""${embedWidth}${embedHeight} loading="lazy" referrerpolicy="no-referrer" title="${escapeHtml(el.name || el.tag)}"></iframe>${kids}`;
  }
  if (el.kind === 'todo') {
    // A page TODO is a migration note for the developer, not app content: it
    // stays in the migration report and goes to the console, never the page.
    console.info(`[c2c] page element not generated: ${el.todo || el.tag}`);
    return kids;
  }
  if (el.kind === 'kpi') {
    const k = el.kpi || {};
    let reportName = parentReport || '';
    if (!reportName && k.form) {
      const m = elementModel(appModel);
      const match = elementReport(k.form, appModel) || (m ? (m.reports || []).find((item) => item && item.form === k.form) : null);
      if (match) reportName = match.name;
    }
    if (!reportName) reportName = k.form || '';
    const criteria = el.criteria ? ` data-kpi-criteria="${escapeHtml(el.criteria)}"` : '';
    return `<output class="kpi" data-kpi-report="${escapeHtml(reportName)}" data-kpi-field="${escapeHtml(k.field || '')}" data-kpi-fn="${escapeHtml(k.fn || '')}"${criteria}${styleAttr(el)}>0</output>${kids}`;
  }
  if (el.kind === 'report' || el.kind === 'form' || el.kind === 'chart') {
    const target = elementReport(el.name, appModel);
    const label = elementLabel(el, appModel);
    if (target && target.status === 'todo') {
      // The embed names its component so the page still reads; the reason is
      // a migration note, kept in the migration report and the console only.
      console.info(`[c2c] ${el.kind} "${label}" on this page is not generated: ${target.todo || 'Not generated.'}`);
      return `<div class="embed"><h3>${escapeHtml(label)}</h3></div>${kids}`;
    }
    if (target && target.view === 'chart') {
      // An embedded in-app chart draws inside the page, like Creator's report element.
      return `<div class="embed">${chartPanel(target, 'h3')}</div>${kids}`;
    }
    return `<div class="embed"><h3><a href="${escapeHtml(el.href || '#')}">${escapeHtml(label)}</a></h3></div>${kids}`;
  }
  if (el.kind === 'gauge') return `<figure class="gauge"${styleAttr(el)}><figcaption>${escapeHtml(el.name || el.tag)}</figcaption><output>${escapeHtml(el.text || '')}</output></figure>${kids}`;
  if (el.kind === 'button') {
    const href = el.href && el.href.startsWith('http') ? ` data-url="${escapeHtml(el.href)}"` : '';
    return `<button type="button"${href}${styleAttr(el)}>${escapeHtml(el.text || el.name || 'Button')}</button>${kids}`;
  }
  if (el.kind === 'search') return `<form data-report-search><input type="search" aria-label="Search" value="${escapeHtml(el.text || '')}"><button type="submit">Search</button></form>${kids}`;
  return `<p${styleAttr(el)}>${escapeHtml(el.text || el.name || '')}</p>${kids}`;
}

function pageBody(page, doc, appModel) {
  const body = (page.elements || []).map((el) => renderElement(el, doc, undefined, appModel)).join('');
  if (page.status === 'todo') console.info(`[c2c] page "${page.name}" is not generated: ${page.todo || ''}`);
  return body;
}

export function renderPage(page, doc, appModel) {
  const body = pageBody(page, doc, appModel);
  const style = typeof page.scopedCss === 'string' && page.scopedCss ? `<style>${page.scopedCss.replace(/</g, '')}</style>` : '';
  return `<article data-page="${escapeHtml(page.name)}">${style}<h2>${escapeHtml(page.label || page.name)}</h2>${body}</article>`;
}

const PAGE_INCLUDE_PREFIX = 'page-include:';

/**
 * Inline includes of other app pages (a translated `page-embed` iframe). A
 * marker is filled only when its snippet element declared that page, and the
 * included page passes the same gate as opening its route: a page only a
 * hidden menu section lists is refused, and its own snippets fetch their own
 * endpoints, which check the caller. A page already open above the marker is
 * not drawn again (an include cycle).
 */
export function hydratePageIncludes(root, appModel, viewRef) {
  if (!root || !root.querySelectorAll) return;
  for (const slot of root.querySelectorAll(`[data-zml^="${PAGE_INCLUDE_PREFIX}"]`)) {
    if (slot.getAttribute('data-include-done') === 'true') continue;
    const name = (slot.getAttribute('data-zml') || '').slice(PAGE_INCLUDE_PREFIX.length);
    const host = slot.closest('[data-page-includes]');
    const declared = host ? (host.getAttribute('data-page-includes') || '').split(' ') : [];
    if (!name || !declared.includes(name)) continue;
    slot.setAttribute('data-include-done', 'true');
    const page = (appModel.pages || []).find((item) => item.name === name);
    if (!page) {
      console.info(`[c2c] embedded page "${name}" is not in this app`);
      continue;
    }
    let cycle = false;
    for (let up = slot.parentElement; up; up = up.parentElement) {
      if (up.getAttribute('data-page') === name) cycle = true;
    }
    if (cycle) {
      console.info(`[c2c] embedded page "${name}" is already open above this point; not drawn again`);
      continue;
    }
    if (hiddenTarget(appModel, name)) {
      slot.innerHTML = '<p data-access-status="403">This page is not available.</p>';
      continue;
    }
    slot.innerHTML = `<div class="page-include" data-page="${escapeHtml(page.name)}">${pageBody(page, slot.ownerDocument, appModel)}</div>`;
    hydrateCharts(slot, appModel, viewRef);
    hydratePopups(slot, appModel, viewRef);
    hydrateSnippets(slot, appModel, viewRef);
    hydratePageIncludes(slot, appModel, viewRef);
    hydrateComponentEmbeds(slot, appModel, viewRef);
  }
}

/**
 * Fill generated form/report component markers inside a compiled snippet.
 * A marker is honored only when its containing snippet declared the same target.
 * Hidden-nav targets ask the same view endpoint as their standalone route.
 */
export function hydrateComponentEmbeds(root, appModel, viewRef) {
  if (!root || !root.querySelectorAll) return;
  const call = (viewRef && viewRef.fetch) || globalThis.fetch;
  for (const slot of root.querySelectorAll('[data-zml^="component-"]')) {
    if (slot.getAttribute('data-component-done') === 'true') continue;
    const match = /^component-(form|report):([A-Za-z_]\w*)(:untitled)?$/.exec(slot.getAttribute('data-zml') || '');
    if (!match) continue;
    const [, kind, name, untitled] = match;
    const host = slot.closest('[data-page-components]');
    const declared = host ? (host.getAttribute('data-page-components') || '').split(' ') : [];
    if (!declared.includes(`${kind}:${name}`)) continue;
    const target = kind === 'form'
      ? (appModel.forms || []).find((item) => item.name === name)
      : (appModel.reports || []).find((item) => item.name === name && item.status === 'generated');
    if (!target) continue;
    slot.setAttribute('data-component-done', 'true');
    const paint = () => {
      slot.innerHTML = renderRoute(appModel, { name: kind, id: name }, slot.ownerDocument);
      // The embed's zc_Header=false hides the view title, nothing else.
      if (untitled) for (const title of slot.querySelectorAll(':scope > section > h1:first-child')) title.remove();
      const mount = componentMounts.get(appModel);
      if (mount) mount(slot, kind, target, viewRef);
    };
    if (!hiddenTarget(appModel, name)) {
      paint();
      continue;
    }
    const endpoint = gateEndpoint(appModel, { name: kind, id: name });
    if (!endpoint || typeof call !== 'function') {
      slot.innerHTML = '<p data-access-status="403">This page is not available.</p>';
      continue;
    }
    apiCall(call, viewRef, endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'view' }),
    }).then((res) => {
      if (!res || res.status === 401 || res.status === 403 || res.ok === false) {
        slot.innerHTML = `<p data-access-status="${(res && res.status) || 403}">This page is not available.</p>`;
      } else paint();
    }).catch(() => {
      slot.innerHTML = '<p data-access-status="403">This page is not available.</p>';
    });
  }
}

const componentMounts = new WeakMap();

/** Last loaded rows and sort order per chart section. */
const chartState = new WeakMap();

/** Axes from the report columns: first text column labels, first numeric one measures. */
function chartAxes(report) {
  const columns = report.columns || [];
  const measure = columns.find((column) => column.numeric) || null;
  const label = columns.find((column) => column !== measure) || columns[0] || null;
  return { label: label ? label.field : '', measure: measure ? measure.field : '' };
}

/** Group rows by the label column and sum the measure (row count when there is none). */
function chartBuckets(report, rows, order) {
  const axes = chartAxes(report);
  const map = new Map();
  for (const row of rows || []) {
    const key = axes.label && row ? String(row[axes.label] ?? '') : '';
    const bucket = map.get(key) || { key, value: 0 };
    if (axes.measure) {
      const raw = row ? row[axes.measure] : null;
      const n = typeof raw === 'number' ? raw : Number(raw);
      bucket.value += Number.isFinite(n) ? n : 0;
    } else {
      bucket.value += 1;
    }
    map.set(key, bucket);
  }
  const values = Array.from(map.values());
  const dated = values.length > 0 && values.filter((bucket) => parseClientDate(bucket.key)).length > values.length / 2;
  const buckets = values.sort((a, b) => {
    if (dated) return dateKey(parseClientDate(a.key)) - dateKey(parseClientDate(b.key));
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  if (order === 'desc') buckets.reverse();
  return { buckets, dated };
}

function chartTick(value) {
  return String(Math.round(value * 100) / 100);
}

/** Draw a simple bar (or line, for date series) chart into the section's [data-chart]. */
function drawChart(host, report, rows, order, folded, meta) {
  if (!host) return;
  let buckets;
  let dated;
  if (folded) {
    // Server-aggregated buckets ({key, value}); the sort toggle reverses.
    dated = folded.dated;
    buckets = order === 'desc' ? [...folded.buckets].reverse() : folded.buckets;
  } else {
    if (!rows || !rows.length) {
      host.innerHTML = '<p class="chart-empty">No Data Available</p>';
      return;
    }
    ({ buckets, dated } = chartBuckets(report, rows, order));
  }
  if (!buckets.length) {
    host.innerHTML = '<p class="chart-empty">No Data Available</p>';
    return;
  }
  const max = buckets.reduce((top, bucket) => Math.max(top, bucket.value), 0);
  const w = 640;
  const h = 220;
  const padL = 44;
  const padB = 30;
  const padT = 12;
  const padR = 8;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const baseY = padT + innerH;
  const parts = [`<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeHtml(report.label || report.name)}">`];
  parts.push(`<line x1="${padL}" y1="${baseY}" x2="${w - padR}" y2="${baseY}" stroke="currentColor" opacity="0.3"/>`);
  parts.push(`<text x="${padL - 6}" y="${padT + 8}" text-anchor="end" class="chart-tick">${escapeHtml(chartTick(max))}</text>`);
  parts.push(`<text x="${padL - 6}" y="${baseY}" text-anchor="end" class="chart-tick">0</text>`);
  const n = buckets.length;
  if (dated) {
    const step = n > 1 ? innerW / (n - 1) : 0;
    const point = (bucket, i) => {
      const x = padL + (n > 1 ? i * step : innerW / 2);
      const y = baseY - (max > 0 ? (bucket.value / max) * innerH : 0);
      return { x, y };
    };
    const points = buckets.map((bucket, i) => {
      const p = point(bucket, i);
      return `${p.x},${p.y}`;
    });
    parts.push(`<polyline fill="none" stroke="var(--c2c-accent)" stroke-width="2" points="${points.join(' ')}"/>`);
    buckets.forEach((bucket, i) => {
      const p = point(bucket, i);
      parts.push(`<circle cx="${p.x}" cy="${p.y}" r="3" fill="var(--c2c-accent)"><title>${escapeHtml(bucket.key)}: ${escapeHtml(chartTick(bucket.value))}</title></circle>`);
      if (n <= 12) parts.push(`<text x="${p.x}" y="${baseY + 14}" text-anchor="middle" class="chart-tick">${escapeHtml(bucket.key.length > 10 ? `${bucket.key.slice(0, 9)}…` : bucket.key)}</text>`);
    });
  } else {
    const band = innerW / n;
    const barW = Math.max(4, Math.min(48, band * 0.6));
    buckets.forEach((bucket, i) => {
      const bh = max > 0 ? (bucket.value / max) * innerH : 0;
      const x = padL + i * band + (band - barW) / 2;
      parts.push(`<rect x="${x}" y="${baseY - bh}" width="${barW}" height="${bh}" fill="var(--c2c-accent)" rx="2"><title>${escapeHtml(bucket.key)}: ${escapeHtml(chartTick(bucket.value))}</title></rect>`);
      if (n <= 12) {
        const label = bucket.key.length > 10 ? `${bucket.key.slice(0, 9)}…` : bucket.key;
        parts.push(`<text x="${x + barW / 2}" y="${baseY + 14}" text-anchor="middle" class="chart-tick">${escapeHtml(label)}</text>`);
      }
    });
  }
  parts.push('</svg>');
  host.innerHTML = parts.join('');
  const cap = folded || meta;
  if (cap && cap.truncated) {
    host.insertAdjacentHTML('beforeend', `<p class="chart-note">${escapeHtml(`Drawn from the first ${Number(cap.scanned) || 0} records.`)}</p>`);
  }
}

/** Server-folded buckets → the {key, value} shape the drawing uses. */
function foldedBuckets(body) {
  const list = body && Array.isArray(body.buckets) ? body.buckets : null;
  if (!list) return null;
  return {
    dated: !!body.dated,
    truncated: !!(body && body.truncated),
    scanned: Number(body && body.scanned) || 0,
    buckets: list.map((bucket) => ({
      key: bucket && bucket.key != null ? String(bucket.key) : '',
      value: Number(bucket && Array.isArray(bucket.values) ? bucket.values[0] : 0) || 0,
    })),
  };
}

/** Query the report's endpoint and draw (or empty-state) its chart. */
function loadChart(report, section, viewRef) {
  const host = section && section.querySelector ? section.querySelector('[data-chart]') : null;
  if (!host) return Promise.resolve();
  const stateEl = section.querySelector('[data-state]');
  const call = (viewRef && viewRef.fetch) || globalThis.fetch;
  if (!report.queryEndpoint || typeof call !== 'function') {
    host.innerHTML = '<p class="chart-empty">No Data Available</p>';
    return Promise.resolve();
  }
  if (stateEl) stateEl.innerHTML = reportStateHtml('loading');
  const post = (payload) =>
    apiCall(call, viewRef, report.queryEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  const axes = chartAxes(report);
  const foldRows = () =>
    post({ op: 'query', page: 0, pageSize: report.pageSize || PAGE_SIZE }).then((res) => {
      // A static host has no data function: that is an empty report, not an error.
      if (!res || res.status === 404 || res.status === 405 || res.status === 501) return { rows: [] };
      if (!res.ok) throw new Error(`chart query ${res.status}`);
      return responseJson(res).then((body) => {
        const rows = Array.isArray(body && body.rows) ? body.rows : [];
        // The fold reads one page; a full page means more rows may follow.
        return { rows, truncated: rows.length >= (report.pageSize || PAGE_SIZE), scanned: rows.length };
      });
    });
  // The aggregate op folds on the server; an endpoint without it falls back
  // to the row query, which folds here. A refused or failed op is an error.
  const first = axes.label
    ? post({ op: 'aggregate', group: axes.label, measures: [{ fn: axes.measure ? 'sum' : 'count', field: axes.measure || '' }], order: 'key' }).then((res) => {
        if (res && res.ok) {
          return responseJson(res).then((body) => {
            const folded = foldedBuckets(body);
            return folded ? { folded } : foldRows();
          });
        }
        if (res && (res.status === 404 || res.status === 405 || res.status === 501)) return { rows: [] };
        // A refused group field or a server error is a load failure: the panel
        // shows its error state, never a fake "No Data Available".
        throw new Error(`chart aggregate ${res && res.status}`);
      })
    : foldRows();
  return first
    .then((result) => {
      const order = (chartState.get(section) || {}).order || 'asc';
      if (result.folded) {
        chartState.set(section, { folded: result.folded, order });
        if (stateEl) stateEl.innerHTML = '';
        drawChart(host, report, null, order, result.folded);
      } else {
        const rows = result.rows || [];
        chartState.set(section, { rows, order, truncated: !!result.truncated, scanned: result.scanned || rows.length });
        if (stateEl) stateEl.innerHTML = '';
        drawChart(host, report, rows, order, null, { truncated: !!result.truncated, scanned: result.scanned || rows.length });
      }
    })
    .catch(() => {
      if (stateEl) stateEl.innerHTML = reportStateHtml('error');
    });
}

function chartReportOf(appModel, section) {
  const name = section && section.getAttribute ? section.getAttribute('data-report') : '';
  return ((appModel && appModel.reports) || []).find((item) => item && item.name === name) || null;
}

/** Sort toggle for a chart section: flips the stored order and redraws the cached fold or rows. */
function toggleChartSort(report, section) {
  const state = chartState.get(section) || { rows: [], order: 'asc' };
  state.order = state.order === 'desc' ? 'asc' : 'desc';
  chartState.set(section, state);
  drawChart(section && section.querySelector ? section.querySelector('[data-chart]') : null, report, state.rows || [], state.order, state.folded, { truncated: !!state.truncated, scanned: state.scanned || 0 });
}

/** Load every chart panel inside a painted subtree (standalone or page-embedded). */
export function hydrateCharts(root, appModel, viewRef) {
  if (!root || !root.querySelectorAll) return;
  for (const section of root.querySelectorAll('section[data-report][data-view="chart"]')) {
    const report = chartReportOf(appModel, section);
    if (report) loadChart(report, section, viewRef);
  }
}

/** Set by boot: opens a form inside a modal card (wireForm lives in boot scope). */
let popupOpener = null;

export function setPopupOpener(fn) {
  popupOpener = fn;
}

/** A report over the guard form gives the `count() == 0` answer. */
function popupGuardReport(appModel, marker) {
  const formName = marker.getAttribute('data-popup-when-form') || marker.getAttribute('data-popup-name') || '';
  return elementReport(formName, appModel) || ((appModel.reports || []).find((item) => item && item.form === formName) || null);
}

/**
 * Snippet popup triggers: an `always` popup opens at once; an `empty` popup
 * queries a report over the guarded form and opens only when it has no rows.
 */
export function hydratePopups(root, appModel, viewRef) {
  if (!root || !root.querySelectorAll || typeof popupOpener !== 'function') return;
  const call = (viewRef && viewRef.fetch) || globalThis.fetch;
  const docRef = root.ownerDocument || null;
  const routeAt = docRef && docRef.location ? docRef.location.hash : null;
  const routeMoved = () => routeAt != null && !!docRef.location && docRef.location.hash !== routeAt;
  for (const marker of root.querySelectorAll('[data-popup-trigger]')) {
    if (marker.getAttribute('data-popup-done') === 'true') continue;
    marker.setAttribute('data-popup-done', 'true');
    const target = marker.getAttribute('data-popup-target') || 'form';
    const name = marker.getAttribute('data-popup-name') || '';
    const when = marker.getAttribute('data-popup-when') || 'always';
    const open = () => {
      // The popup belongs to the route that asked for it.
      if (routeMoved()) return;
      popupOpener({ target, name }, root, viewRef);
    };
    if (when !== 'empty') {
      open();
      continue;
    }
    const report = popupGuardReport(appModel, marker);
    if (!report || !report.queryEndpoint || typeof call !== 'function') continue;
    apiCall(call, viewRef, report.queryEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'query', page: 0, pageSize: 1 }),
    })
      .then((res) => {
        // A static host has no data function: the guarded form is still empty.
        if (!res || res.status === 404 || res.status === 405 || res.status === 501) return { rows: [] };
        if (!res.ok) throw new Error(`popup guard ${res.status}`);
        return responseJson(res);
      })
      .then((body) => {
        const rows = body && Array.isArray(body.rows) ? body.rows : [];
        if (!rows.length) open();
      })
      .catch(() => {});
  }
}

/** Page input for server-rendered snippets: the URL's query parameters. */
export function snippetPageInput(docRef) {
  // Caller-controlled parameter names are collected in a Map (never written as
  // object properties), the prototype-related names are dropped, and the result
  // is a null-prototype object, so a name can never alias a built-in property
  // or pollute a prototype chain.
  const params = new Map();
  const loc = docRef && docRef.location;
  const read = (query) => {
    try {
      for (const [key, value] of new URLSearchParams(query)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        if (!params.has(key)) params.set(key, value);
      }
    } catch (err) {
      /* malformed query */
    }
  };
  if (loc) {
    read(loc.search || '');
    const hash = loc.hash || '';
    const q = hash.indexOf('?');
    if (q >= 0) read(hash.slice(q + 1));
  }
  return Object.setPrototypeOf(Object.fromEntries(params), null);
}

/**
 * Server-rendered `htmlpage` snippets: the element left a sanitized static
 * shell plus `data-snippet-src`. Fetch the rendered HTML and sanitize it again
 * before inserting. 404/405/501 (a static host) keep the shell.
 */
export function hydrateSnippets(root, appModel, viewRef) {
  if (!root || !root.querySelectorAll) return;
  const call = (viewRef && viewRef.fetch) || globalThis.fetch;
  if (typeof call !== 'function') return;
  const docRef = root.ownerDocument || null;
  const input = snippetPageInput(docRef);
  for (const host of root.querySelectorAll('[data-snippet-src]')) {
    if (host.getAttribute('data-snippet-done') === 'true') continue;
    host.setAttribute('data-snippet-done', 'true');
    const src = host.getAttribute('data-snippet-src') || '';
    if (!src) continue;
    apiCall(call, viewRef, src, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input }),
    })
      .then((res) => {
        if (!res || res.status === 404 || res.status === 405 || res.status === 501) return null;
        if (!res.ok) return null;
        return responseJson(res);
      })
      .then((body) => {
        if (body && typeof body.html === 'string') {
          host.innerHTML = sanitizeSnippet(body.html, docRef || undefined);
          hydratePageIncludes(host, appModel, viewRef);
          hydrateComponentEmbeds(host, appModel, viewRef);
        }
      })
      .catch(() => {});
  }
}

export function renderNav(appModel) {
  const parts = [];
  for (const section of appModel.nav || []) {
    // Service areas (App Preferences, Approvals) keep their routes but not a menu slot.
    if (section.hidden || section.system) continue;
    const items = (section.items || []).filter((item) => !item.system && item.href);
    const links = items.map((item) => `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label || item.name)}</a>`).join('');
    if (!links) continue;
    // A section whose only child repeats its name is a single flat entry, not a group.
    if (items.length === 1 && (items[0].label || items[0].name || '') === section.name) {
      parts.push(links);
      continue;
    }
    parts.push(`<details data-section="${escapeHtml(section.name)}"><summary>${escapeHtml(section.name)}</summary>${links}</details>`);
  }
  return parts.join('');
}

/** The first menu target: where the app's home page lands. */
export function firstMenuHref(appModel) {
  for (const section of appModel.nav || []) {
    if (section.hidden || section.system) continue;
    for (const item of section.items || []) {
      if (!item.system && item.href) return item.href;
    }
  }
  return '';
}

export function renderHome(appModel) {
  return `<section><h2>${escapeHtml(appModel.name || 'App')}</h2></section>`;
}

/** Phone tab bar capacity: the first entries become tabs, the rest sit behind More. */
export const PHONE_TAB_COUNT = 4;

function tabIcon(kind) {
  if (kind === 'report') {
    return '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 4h10M3 8h10M3 12h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  }
  if (kind === 'page') {
    return '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 2h5l3 3v9H4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  }
  return '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 5.5v5M5.5 8h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
}

const MORE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>';

/**
 * Split the visible menu for a phone: the first entries become bottom-bar
 * tabs, the rest stay grouped by section for the More sheet.
 */
export function splitPhoneTabs(appModel) {
  const tabs = [];
  const moreSections = [];
  let moreCount = 0;
  let taken = 0;
  for (const section of appModel.nav || []) {
    if (section.hidden) continue;
    const items = (section.items || []).map((item) => ({
      kind: item.kind || '',
      name: item.name || '',
      label: item.label || item.name || '',
      href: item.href || '#',
    }));
    if (!items.length) continue;
    const rest = [];
    for (const item of items) {
      if (taken < PHONE_TAB_COUNT) {
        tabs.push(item);
        taken += 1;
      } else {
        rest.push(item);
        moreCount += 1;
      }
    }
    if (rest.length) moreSections.push({ name: section.name, items: rest });
  }
  return { tabs, moreSections, moreCount };
}

function tabLink(item) {
  return `<a href="${escapeHtml(item.href)}" data-tab="${escapeHtml(item.name)}" aria-label="${escapeHtml(item.label)}" title="${escapeHtml(item.label)}">${tabIcon(item.kind)}<span class="tab-label">${escapeHtml(item.label)}</span></a>`;
}

/** Bottom tab bar: the first menu entries, plus a More tab when entries remain. */
export function renderTabbar(appModel) {
  const split = splitPhoneTabs(appModel);
  if (!split.tabs.length) return '';
  const tabs = split.tabs.map(tabLink).join('');
  const more = split.moreCount
    ? `<button type="button" id="more-tab" data-more aria-haspopup="dialog" aria-expanded="false" aria-label="More" title="More">${MORE_ICON}<span class="tab-label">More</span></button>`
    : '';
  return tabs + more;
}

/** Full-screen More sheet: the remaining sections and items. */
export function renderMoreSheet(appModel) {
  const split = splitPhoneTabs(appModel);
  if (!split.moreCount) return '';
  const groups = split.moreSections
    .map(
      (section) =>
        `<section data-more-section="${escapeHtml(section.name)}"><h2>${escapeHtml(section.name)}</h2>${section.items
          .map(
            (item) =>
              `<a href="${escapeHtml(item.href)}" aria-label="${escapeHtml(item.label)}" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</a>`,
          )
          .join('')}</section>`,
    )
    .join('');
  return `<div data-more-head><strong>More</strong><button type="button" data-more-close>Close</button></div>${groups}`;
}

/** Mark the link matching the current hash; returns true when one matched. */
export function setCurrent(root, hash) {
  if (!root || !root.querySelectorAll) return false;
  let hit = false;
  for (const link of root.querySelectorAll('a[href^="#"]')) {
    if (link.getAttribute('href') === hash) {
      link.setAttribute('aria-current', 'page');
      hit = true;
      // Only the section holding the active entry opens, like Creator's menu.
      const sec = link.closest && link.closest('details');
      if (sec) sec.open = true;
    } else link.removeAttribute('aria-current');
  }
  return hit;
}

/** Highlight the phone tab for the current hash, or the More tab when the page sits behind More. */
export function markPhoneCurrent(doc, hash) {
  if (!doc || typeof doc.getElementById !== 'function') return;
  const tabbar = doc.getElementById('tabbar');
  const sheet = doc.getElementById('more-sheet');
  const inTabs = tabbar ? setCurrent(tabbar, hash) : false;
  const inMore = sheet ? setCurrent(sheet, hash) : false;
  const moreTab = doc.getElementById('more-tab');
  if (moreTab) {
    if (inMore && !inTabs) moreTab.setAttribute('aria-current', 'page');
    else moreTab.removeAttribute('aria-current');
  }
}

/** `ID` in a report criteria reads as the row's ROWID, like matchIdLeaf in the shims. */
function criteriaField(row, field) {
  if (field === 'ID' && !Object.prototype.hasOwnProperty.call(row, 'ID')) return row.ROWID ?? row.rowid;
  return row[field];
}

function sameValue(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return left === right;
}

function compareValues(left, right) {
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : left > right ? 1 : 0;
  const as = left == null ? '' : String(left);
  const bs = right == null ? '' : String(right);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/**
 * In-memory match for a compiled criteria JSON — the same leaf rules as
 * matchRow in creator-to-catalyst/shims, on report display values. A `todo`
 * node (a condition that did not translate) never matches.
 */
export function matchCriteria(row, c) {
  if (!c || typeof c !== 'object') return false;
  switch (c.op) {
    case 'true':
      return true;
    case 'and':
      return c.args.every((arg) => matchCriteria(row, arg));
    case 'or':
      return c.args.some((arg) => matchCriteria(row, arg));
    case 'not':
      return !matchCriteria(row, c.arg);
    case 'isNull':
      return criteriaField(row, c.field) == null;
    case 'notNull':
      return criteriaField(row, c.field) != null;
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      const text = criteriaField(row, c.field) == null ? '' : String(criteriaField(row, c.field));
      const needle = c.value == null ? '' : String(c.value);
      if (c.op === 'contains') return text.includes(needle);
      if (c.op === 'startsWith') return text.startsWith(needle);
      return text.endsWith(needle);
    }
    case 'in': {
      const items = Array.isArray(c.value) ? c.value : [c.value];
      return items.some((item) => sameValue(criteriaField(row, c.field), item));
    }
    case '==':
      return sameValue(criteriaField(row, c.field), c.value);
    case '!=':
      return !sameValue(criteriaField(row, c.field), c.value);
    case '<':
      return compareValues(criteriaField(row, c.field), c.value) < 0;
    case '>':
      return compareValues(criteriaField(row, c.field), c.value) > 0;
    case '<=':
      return compareValues(criteriaField(row, c.field), c.value) <= 0;
    case '>=':
      return compareValues(criteriaField(row, c.field), c.value) >= 0;
    default:
      return false;
  }
}

/** Any `{ op: 'todo' }` predicate at or under this criteria node. */
export function criteriaTodo(c) {
  if (!c || typeof c !== 'object') return false;
  if (c.op === 'todo') return true;
  const kids = Array.isArray(c.args) ? c.args : c.arg ? [c.arg] : [];
  return kids.some(criteriaTodo);
}

/** css-fragment string per column index for one row, from `conditional formatting` blocks. */
function rowFormatStyles(report, source, columns) {
  const styles = new Map();
  for (const format of report.conditionalFormats || []) {
    if (!format || !format.format) continue;
    let hit = false;
    try {
      hit = matchCriteria(source, format.criteria);
    } catch {
      hit = false;
    }
    if (!hit) continue;
    const targets = format.fields && format.fields.length ? format.fields : columns.map((column) => column.field);
    for (const name of targets) {
      const index = columns.findIndex((column) => column.field === name);
      if (index < 0) continue;
      styles.set(index, `${styles.get(index) || ''}${format.format}`);
    }
  }
  return styles;
}

/**
 * A report row's cells: the list columns, then each phone card field the list
 * does not show (`extra`, hidden on a wide screen). `phone` is the cell's place
 * on the phone card, -1 when the card leaves it out, `label` the name the card
 * gives it, and `order` its flex order when the card reorders the row. A model
 * without phone columns keeps the first four.
 */
export function reportCells(report) {
  const columns = report.columns || [];
  const phone = Array.isArray(report.phoneColumns) ? report.phoneColumns : null;
  if (!phone) return columns.map((column, index) => ({ column, phone: index < 4 ? index : -1, label: column.label || column.field, extra: false }));
  const place = new Map();
  phone.forEach((item, index) => {
    if (item && item.field && !place.has(item.field)) place.set(item.field, index);
  });
  const cells = columns.map((column) => {
    const at = place.has(column.field) ? place.get(column.field) : -1;
    const label = at >= 0 ? phone[at].label || column.label || column.field : column.label || column.field;
    return { column, phone: at, label, extra: false };
  });
  place.forEach((at, field) => {
    if (columns.some((column) => column.field === field)) return;
    cells.push({ column: { field, label: phone[at].label || field }, phone: at, label: phone[at].label || field, extra: true });
  });
  // When the row's cell order is not the card's, each card cell carries its
  // place as a flex order.
  const places = cells.filter((cell) => cell.phone >= 0).map((cell) => cell.phone);
  if (places.some((at, index) => index > 0 && at < places[index - 1])) {
    for (const cell of cells) if (cell.phone >= 0) cell.order = cell.phone;
  }
  return cells;
}

/** The phone card attributes of one cell: its place on the card, and whether only the card shows it. */
function phoneCellAttrs(cell) {
  return `${cell.phone >= 0 ? ` data-phone="${cell.phone}"` : ''}${cell.extra ? ' data-phone-only=""' : ''}`;
}

/**
 * Actions on a phone card footer. Column-header custom actions come first, in
 * column order, using the same button label as the wide list. View, Edit and
 * Delete follow when the report allows them, and only for a row that has a
 * record id. A header-only action stays in the toolbar.
 */
export function cardActions(report, id, row) {
  const actions = [];
  for (const column of report.columns || []) {
    if (!column || !column.action) continue;
    const nav = actionNavOf(report, column.action);
    if (nav) actions.push({ href: actionNavHref(nav, row), label: column.label || column.field });
    else actions.push({ action: column.action, label: column.label || column.field });
  }
  for (const action of recordNavActions(report)) actions.push({ href: actionNavHref(action.navigate, row), label: action.name });
  if (!id) return actions;
  if (report.detail) {
    actions.push({
      href: `#/report/${encodeURIComponent(report.name)}/row/${encodeURIComponent(id)}`,
      label: 'View',
    });
  }
  if (report.rowActions && report.rowActions.edit) actions.push({ op: 'data-row-edit', label: 'Edit' });
  if (report.rowActions && report.rowActions.delete) actions.push({ op: 'data-row-delete', label: 'Delete' });
  return actions;
}

/** The phone card footer: those actions as buttons and links. Hidden on a wide screen. */
function cardActionsHtml(report, id, row) {
  const actions = cardActions(report, id, row);
  if (!actions.length) return '';
  const items = actions
    .map((item) => {
      if (item.href) return `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`;
      if (item.action) return actionButtonHtml(report, item.action, item.label);
      return `<button type="button" ${item.op}>${escapeHtml(item.label)}</button>`;
    })
    .join('');
  return `<td data-card-actions=""><div role="group" aria-label="Record actions">${items}</div></td>`;
}

/**
 * Report body rows. Each cell carries its card label so a phone card can name
 * its fields; the card shows the phone columns, in their order, with the first
 * as its title.
 */
export function renderReportRows(report, rows) {
  const cellsOf = reportCells(report);
  const columns = cellsOf.map((cell) => cell.column);
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const source = row && typeof row === 'object' ? row : {};
      const id = source.ROWID != null && source.ROWID !== '' ? String(source.ROWID) : '';
      const styles = rowFormatStyles(report, source, columns);
      const cells = cellsOf
        .map((cell, index) => {
          const column = cell.column;
          const numeric = column.numeric ? ' data-numeric="true"' : '';
          const head = ` data-th="${escapeHtml(cell.label)}"${phoneCellAttrs(cell)}`;
          const primary = index === 0 ? ' data-primary="true"' : '';
          const order = cell.order != null ? `order:${cell.order};` : '';
          const css = `${order}${styles.get(index) || ''}`;
          const style = css ? ` style="${escapeHtml(css)}"` : '';
          if (column.action) {
            // `column header` custom action: a per-record button, not a value.
            return `<td${head}${primary}${numeric}${style}>${actionButtonHtml(report, column.action, column.label || column.field, source)}</td>`;
          }
          const text = column.multiValue ? multiValueItems(source[column.field]).join(', ') : source[column.field] != null ? String(source[column.field]) : '';
          if (report.detail && id && index === 0) {
            return `<td${head}${primary}${numeric}${style}><a href="#/report/${encodeURIComponent(report.name)}/row/${encodeURIComponent(id)}" data-row-link="">${escapeHtml(text)}</a></td>`;
          }
          return `<td${head}${primary}${numeric}${style}>${escapeHtml(text)}</td>`;
        })
        .join('');
      const select = report.rowActions && report.rowActions.edit && id ? `<td data-bulk-select-cell><input type="checkbox" data-bulk-select value="${escapeHtml(id)}" aria-label="Select record ${escapeHtml(id)}"></td>` : '';
      const navs = recordNavActions(report).map((action) => navLinkHtml(action.navigate, action.name, source)).join('');
      const ops = report.rowActions || navs
        ? `<td data-row-ops>${report.rowActions && report.rowActions.edit ? `<button type="button" data-row-edit>Edit</button>` : ''}${report.rowActions && report.rowActions.delete ? `<button type="button" data-row-delete>Delete</button>` : ''}${navs}</td>`
        : '';
      // Row ops need the ROWID on the row even without the detail link.
      const rowAttr = (report.detail || report.rowActions) && id ? ` data-row="${escapeHtml(id)}"` : '';
      return `<tr data-card=""${rowAttr}>${select}${cells}${ops}${cardActionsHtml(report, id, source)}</tr>`;
    })
    .join('');
}

export function parseRoute(hash) {
  const [pathPart, queryPart] = String(hash || '').split('?');
  const parts = pathPart
    .replace(/^#/, '')
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  if (!parts.length) return { name: 'home' };
  if (parts[0] === 'form' && parts[1]) {
    const edit = parts[2] === 'edit' ? parts[3] : undefined;
    const prefill = !edit && queryPart ? routePrefill(queryPart) : undefined;
    return prefill ? { name: 'form', id: parts[1], edit, prefill } : { name: 'form', id: parts[1], edit };
  }
  if (parts[0] === 'report' && parts[1]) return { name: 'report', id: parts[1], row: parts[2] === 'row' ? parts[3] : undefined };
  if (parts[0] === 'record' && parts[1] && parts[2]) return { name: 'record', id: parts[1], row: parts[2] };
  if (parts[0] === 'page' && parts[1]) return { name: 'page', id: parts[1] };
  // Hidden admin route — never in the nav. `c2c smoke --in-browser` points a browser here.
  if (parts[0] === 'admin' && parts[1] === 'smoke') return { name: 'smoke', id: 'smoke' };
  return { name: 'missing', id: parts.join('/') };
}

/**
 * `#/form/X?Field=value` (a navigation custom action's link): the add
 * screen's starting values, or undefined. Only plain names are kept.
 */
function routePrefill(query) {
  const out = {};
  let any = false;
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    let name;
    let value;
    try {
      name = decodeURIComponent(pair.slice(0, eq));
      value = decodeURIComponent(pair.slice(eq + 1));
    } catch {
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || Object.prototype.hasOwnProperty.call(out, name)) continue;
    out[name] = value;
    any = true;
  }
  return any ? out : undefined;
}

function hiddenTarget(appModel, name) {
  let inHidden = false;
  let inVisible = false;
  for (const section of appModel.nav || []) {
    for (const item of section.items || []) {
      if (item.name !== name) continue;
      if (section.hidden) inHidden = true;
      else inVisible = true;
    }
  }
  return inHidden && !inVisible;
}

function gateEndpoint(appModel, route) {
  if (route.name === 'form') {
    const form = (appModel.forms || []).find((item) => item.name === route.id);
    return form && form.submitEndpoint;
  }
  if (route.name === 'record') {
    const form = (appModel.forms || []).find((item) => item.name === route.id);
    return form && form.recordEndpoint;
  }
  if (route.name === 'report') {
    const report = (appModel.reports || []).find((item) => item.name === route.id);
    return report && report.queryEndpoint;
  }
  return '';
}

export function renderRoute(appModel, route, doc) {
  if (route.name === 'home') return renderHome(appModel);
  if (route.name === 'form') {
    const form = (appModel.forms || []).find((item) => item.name === route.id);
    return form ? renderForm(form) : `<p class="todo">Unknown form.</p>`;
  }
  if (route.name === 'report') {
    const report = (appModel.reports || []).find((item) => item.name === route.id);
    if (report && route.row && report.form && !((report.detailBlocks || []).length || report.printTemplate)) {
      const form = (appModel.forms || []).find((item) => item.name === report.form);
      return form ? `${renderReport(report)}<section class="record-summary" data-record-summary="${escapeHtml(form.name)}" data-record-report="${escapeHtml(report.name)}" data-record-id="${escapeHtml(route.row)}"><p>Loading record…</p></section>` : `<p class="todo">Unknown report form.</p>`;
    }
    return report ? renderReport(report) : `<p class="todo">Unknown report.</p>`;
  }
  if (route.name === 'record') {
    const form = (appModel.forms || []).find((item) => item.name === route.id);
    return form ? `<section class="record-summary" data-record-summary="${escapeHtml(form.name)}" data-record-id="${escapeHtml(route.row || '')}"><p>Loading record…</p></section>` : `<p class="todo">Unknown form.</p>`;
  }
  if (route.name === 'page') {
    const page = (appModel.pages || []).find((item) => item.name === route.id);
    return page ? renderPage(page, doc, appModel) : `<p class="todo">Unknown page.</p>`;
  }
  if (route.name === 'smoke') return renderSmokeShell();
  return `<p class="todo">That page is not in this app.</p>`;
}

/** Creator's banner after a successful submit when the success handler sets no `success message`. */
export const DEFAULT_SUCCESS_BANNER = 'Data Added Successfully!';
/** The banner after a saved edit: the form's `success message` names the add. */
export const DEFAULT_UPDATE_BANNER = 'Data Updated Successfully!';
/** Asked before a report row's Delete posts; Cancel sends nothing. */
export const DELETE_CONFIRM_TEXT = 'Are you sure you want to delete this record?';

/** The banner for a submit the server refused or failed: its own words, else the generic line. */
export function submitFailureText(body) {
  const server = body && (typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : '');
  // The row is stored; only a step after the write failed. A resubmit would add it twice.
  // The generic "request failed" adds nothing; a Deluge runtime error's text does.
  if (body && body.wrote === true) return `The record was saved, but a step after saving failed${server && server.trim() && server.trim() !== 'request failed' ? `: ${server.trim()}` : '.'}`;
  return server && server.trim() ? server : 'The record was not saved.';
}

/**
 * Blueprint stage field settings as hide/disable actions for the edit screen:
 * a field the record's stage does not show is hidden, and one it shows but
 * does not let the user change is disabled. The server enforces the same
 * rules; this keeps the screen from offering what the server refuses.
 */
export function stageFieldActions(form, stages) {
  const specs = form && Array.isArray(form.stageFields) ? form.stageFields : [];
  const hide = [];
  const disable = [];
  for (const spec of specs) {
    const stage = stages && typeof stages === 'object' ? stages[spec.statusColumn] : undefined;
    const rules = spec.stages && typeof stage === 'string' && Object.prototype.hasOwnProperty.call(spec.stages, stage) ? spec.stages[stage] : null;
    if (!rules) continue;
    for (const field of form.fields || []) {
      const name = field && field.name;
      if (!name) continue;
      const shown = !(Array.isArray(rules.hidden) && rules.hidden.includes(name)) && (!Array.isArray(rules.visible) || rules.visible.includes(name));
      if (!shown) {
        if (!hide.includes(name)) hide.push(name);
        continue;
      }
      const locked = (Array.isArray(rules.readonly) && rules.readonly.includes(name)) || (Array.isArray(rules.updatable) && !rules.updatable.includes(name));
      if (locked && !disable.includes(name)) disable.push(name);
    }
  }
  const out = [];
  if (hide.length) out.push({ op: 'hide', targets: hide });
  if (disable.length) out.push({ op: 'disable', targets: disable });
  return out;
}

export function applyActions(actions, root) {
  const notes = [];
  for (const action of actions || []) {
    const op = action && action.op;
    if (op === 'successMessage') {
      notes.push('success');
      const banner = root && root.querySelector('[data-banner]');
      if (banner) banner.textContent = String(action.message ?? '');
    } else if (op === 'alert' || op === 'info') {
      notes.push(String(action.message ?? ''));
      const banner = root && root.querySelector('[data-banner]');
      if (banner) banner.textContent = String(action.message ?? '');
    } else if (op === 'hide' || op === 'show' || op === 'enable' || op === 'disable') {
      for (const target of action.targets || []) {
        const name = typeof target === 'string' ? target : '';
        notes.push(`${op}:${name}`);
        // `hide Subform.Field` hides that grid column, not a field block.
        if (name.includes('.')) {
          toggleSubformColumn(root, name, op);
          continue;
        }
        const block = root && name ? root.querySelector(`[data-field="${CSS.escape(name)}"]`) : null;
        if (!block) continue;
        if (op === 'hide') block.hidden = true;
        if (op === 'show') block.hidden = false;
        const input = block.querySelector('input, select, textarea');
        if (input && op === 'disable') input.disabled = true;
        if (input && op === 'enable') input.disabled = false;
      }
    } else if (op === 'clear') {
      for (const target of action.targets || []) {
        const name = typeof target === 'string' ? target : Array.isArray(target) ? target.join('.') : '';
        notes.push(`clear:${name}`);
        clearField(root, name);
      }
    } else if (op === 'ui' || op === 'subform') {
      const path = Array.isArray(action.target) ? action.target : action.target == null ? [] : [String(action.target)];
      const name = path.join('.');
      const method = String(action.method || '');
      notes.push(`${op}:${method}:${name}`);
      if (op === 'ui') applyUiOp(root, name, method, action.args || []);
      else if (method === 'insert') subformInsertRows(root, name, action.args && action.args[0]);
    } else if (op === 'reload') {
      notes.push('reload');
      try {
        const view = viewOf(root);
        if (view.location && typeof view.location.reload === 'function') view.location.reload();
      } catch {
        /* a test document has no navigation */
      }
    } else if (op === 'setValue' || op === 'set value') {
      // `input.X = v` / a field "set value" rule writes the control, so the
      // next readValues() sees what the script set.
      const value = Array.isArray(action.args) ? action.args[0] : action.value;
      for (const target of action.targets || []) {
        const name = typeof target === 'string' ? target : '';
        notes.push(`set:${name}`);
        writeFieldValue(root, name, value);
      }
    } else if (op === 'openUrl') {
      const url = Array.isArray(action.args) ? action.args[0] : action.url;
      const target = Array.isArray(action.args) ? action.args[1] : undefined;
      const note = openUrlNav(root, url, target);
      if (note) notes.push(note);
    } else if (op === 'fidelity') {
      // An action the migrated app cannot run gets a visible note, never a
      // silent skip.
      notes.push(`fidelity:${String(action.note || 'unsupported action')}`);
      fidelityNote(root, action.note || 'This action is not implemented in the migrated app.');
    } else if (op === 'cancelSubmit') notes.push('cancel');
    else if (op) fidelityNote(root, `Action "${String(op)}" is not implemented in the migrated app.`);
  }
  return notes;
}

/** One `.fidelity-note` line per unsupported action, under the form banner. */
function fidelityNote(root, text) {
  const banner = root && root.querySelector ? root.querySelector('[data-banner]') : null;
  const host = banner && banner.parentElement ? banner.parentElement : root;
  if (!host || typeof host.appendChild !== 'function') return;
  const doc = host.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;
  const p = doc.createElement('p');
  p.className = 'fidelity-note';
  p.textContent = `Not implemented: ${String(text)}`;
  host.appendChild(p);
}

/** One `.fidelity-note` line for a non-blocking form outcome notice, under the form banner. */
function formNotice(root, text) {
  const banner = root && root.querySelector ? root.querySelector('[data-banner]') : null;
  const host = banner && banner.parentElement ? banner.parentElement : root;
  if (!host || typeof host.appendChild !== 'function') return;
  const doc = host.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;
  const p = doc.createElement('p');
  p.className = 'fidelity-note';
  p.setAttribute('data-mail-notice', '');
  p.setAttribute('data-notice', '');
  p.textContent = String(text);
  host.appendChild(p);
}

/** Write a value into the control(s) named by a field target. `Sub.Col` hits every row cell of that grid column, or one row's cell when `rowIndex` is set. */
function writeFieldValue(root, name, value, rowIndex) {
  if (!root || !name) return;
  if (name.includes('.')) {
    const dot = name.indexOf('.');
    const box = root.querySelector ? root.querySelector(`.subform[data-field="${CSS.escape(name.slice(0, dot))}"]`) : null;
    if (!box) return;
    const column = name.slice(dot + 1);
    const rows = box.querySelectorAll('tbody tr');
    if (rowIndex != null) {
      const tr = rows[rowIndex];
      const cell = tr && tr.querySelector ? tr.querySelector(`[data-subfield="${CSS.escape(column)}"]`) : null;
      if (cell) setControlValue(cell, value);
      return;
    }
    for (const cell of box.querySelectorAll(`tbody [data-subfield="${CSS.escape(column)}"]`)) setControlValue(cell, value);
    return;
  }
  const block = root.querySelector(`[data-field="${CSS.escape(name)}"]`);
  if (!block) return;
  for (const el of block.querySelectorAll('input[name], select[name], textarea[name]')) setControlValue(el, value);
}

function setControlValue(el, value) {
  if (!el) return;
  if (el.type === 'checkbox') {
    // A `data-choice` box is one option of a multi-value group; a plain
    // checkbox is the decision box.
    el.checked = el.hasAttribute && el.hasAttribute('data-choice')
      ? (Array.isArray(value) ? value.map(String).includes(String(el.value)) : String(el.value) === String(value))
      : value === true || value === 'true';
    return;
  }
  if (el.type === 'radio') {
    el.checked = String(el.value) === String(value);
    return;
  }
  if (el.multiple && el.options) {
    const list = Array.isArray(value) ? value.map(String) : [String(value)];
    for (const option of el.options) option.selected = list.includes(option.value);
    return;
  }
  el.value = value == null ? '' : String(value);
}

/**
 * Prefill every control from a stored record — the edit screen's row read.
 * Subform columns rebuild their rows through the layout layer's helper.
 */
function fillFormValues(formEl, form, record) {
  for (const field of (form && form.fields) || []) {
    if (!record || typeof record !== 'object' || !Object.prototype.hasOwnProperty.call(record, field.name)) continue;
    const value = record[field.name];
    if (field.widget === 'subform') {
      const box = formEl.querySelector ? formEl.querySelector(`.subform[data-field="${CSS.escape(field.name)}"]`) : null;
      if (box && typeof fillSubformRows === 'function') fillSubformRows(box, Array.isArray(value) ? value : []);
      continue;
    }
    // A multi-value cell is stored as list text (["No"]): select each choice it holds.
    writeFieldValue(formEl, field.name, field.widget === 'multiselect' ? multiValueItems(value) : value);
  }
}

/**
 * `openUrl` only navigates to a web address: `http:`, `https:`, a `#…`
 * anchor such as the `#Form:`/`#Report:` links a page emits, or a relative
 * path — never `javascript:`, `data:`, `vbscript:` or another non-web
 * scheme. `//host/path` inherits the page's scheme (https on a deployed
 * app), so it names the same destination an `https:` URL does and stays
 * allowed.
 */
function navigableUrl(view, url) {
  if (!safeUrl(url)) return false;
  const base = view && view.location && typeof view.location.href === 'string' ? view.location.href : 'https://localhost/';
  let parsed;
  try {
    parsed = new URL(url, base);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * `openUrl(url, windowType)` navigates: `same window` replaces the page, a
 * `popup window` is a named popup, `parent window` targets the parent frame,
 * and anything else (Creator's default) opens a new window. A non-web
 * address is refused with a banner note instead of navigating. Returns the
 * note the action contributes: the URL navigated, 'openUrl refused', or ''
 * when there was no URL.
 */
function openUrlNav(root, url, target) {
  if (typeof url !== 'string' || !url) return '';
  const view = viewOf(root);
  if (!navigableUrl(view, url)) {
    const banner = root && root.querySelector ? root.querySelector('[data-banner]') : null;
    if (banner) banner.textContent = 'The link was not opened: the address is not allowed.';
    return 'openUrl refused';
  }
  try {
    const kind = String(target == null ? 'new window' : target).toLowerCase();
    if (kind === 'same window') {
      if (view.location && typeof view.location.assign === 'function') view.location.assign(url);
    } else if (typeof view.open === 'function') {
      view.open(url, kind === 'parent window' ? '_parent' : '_blank', kind === 'popup window' ? 'popup' : undefined);
    }
  } catch {
    /* a test document has no navigation */
  }
  return url;
}

/**
 * `clear <field>` / `input.<subform>.clear()`. A subform target drops its
 * body rows; `Subform.Field` clears that field in every row; a select loses
 * its choices; a checkbox/radio group loses its options; any other control
 * clears its value.
 */
function clearField(root, name) {
  if (!root || !root.querySelector || !name) return;
  if (name.includes('.')) {
    const dot = name.indexOf('.');
    const box = root.querySelector(`.subform[data-field="${CSS.escape(name.slice(0, dot))}"]`);
    const column = name.slice(dot + 1);
    if (!box) return;
    for (const el of box.querySelectorAll(`[data-subfield="${CSS.escape(column)}"]`)) clearControl(el);
    return;
  }
  const sub = root.querySelector(`.subform[data-field="${CSS.escape(name)}"]`);
  if (sub) {
    const body = sub.querySelector('tbody');
    if (body) body.textContent = '';
    return;
  }
  const block = root.querySelector(`[data-field="${CSS.escape(name)}"]`);
  if (!block) return;
  const select = block.matches && block.matches('select') ? block : block.querySelector('select');
  if (select) {
    // The blank -Select- affordance is not a choice; it stays.
    for (const option of [...select.options]) if (option.value !== '') select.removeChild(option);
    return;
  }
  const choices = block.querySelectorAll('input[data-choice]');
  if (choices.length) {
    for (const input of choices) {
      const label = input.closest && input.closest('label.choice');
      if (label && label.parentNode) label.parentNode.removeChild(label);
      else if (input.parentNode) input.parentNode.removeChild(input);
    }
    return;
  }
  const input = block.matches && block.matches('input, textarea') ? block : block.querySelector('input, textarea');
  if (input) clearControl(input);
}

function clearControl(el) {
  if (!el) return;
  if (el.type === 'checkbox' || el.type === 'radio') el.checked = false;
  else if (el.multiple) for (const option of el.options || []) option.selected = false;
  else el.value = '';
}

/**
 * `Field:ui.add(v)` / `Field.select(v)` and friends. On a `Subform.Field`
 * target the choice list lives on the column spec, so the spec and every
 * rendered cell change together. REMOVE_ALL deselects every choice.
 */
function applyUiOp(root, name, method, args) {
  if (!root || !root.querySelector || !name) return;
  if (name.includes('.')) {
    applyUiColumnOp(root, name, method, args);
    return;
  }
  const block = root.querySelector(`[data-field="${CSS.escape(name)}"]`);
  if (!block) return;
  const texts = (args || []).map(optionText).filter((t) => t !== '');
  const removeAll = texts.some((t) => t === 'REMOVE_ALL');
  const select = block.matches && block.matches('select') ? block : block.querySelector('select');
  if (select) {
    if (method === 'add' || method === 'append') {
      const doc = select.ownerDocument;
      for (const text of texts) {
        const option = doc.createElement('option');
        option.value = text;
        option.textContent = text;
        select.appendChild(option);
      }
      return;
    }
    for (const option of select.options || []) {
      const hit = removeAll || texts.includes(option.value);
      if (method === 'select' && hit) option.selected = true;
      if (method === 'deselect' && hit) option.selected = false;
      if (method === 'selectAll') option.selected = true;
      if (method === 'deselectAll' || method === 'clear') option.selected = false;
    }
    if (method === 'clear') {
      for (const option of [...select.options]) if (option.value !== '') select.removeChild(option);
    }
    return;
  }
  const group = block.querySelectorAll('input[data-choice]');
  if (method === 'add' || method === 'append') {
    const doc = block.ownerDocument;
    for (const text of texts) {
      const type = group.length && group[0].type === 'radio' ? 'radio' : 'checkbox';
      const label = doc.createElement('label');
      label.className = 'choice';
      const input = doc.createElement('input');
      input.type = type;
      input.name = name;
      input.value = text;
      input.setAttribute('data-choice', 'true');
      label.appendChild(input);
      label.appendChild(doc.createTextNode(` ${text}`));
      block.appendChild(label);
    }
    return;
  }
  for (const input of group) {
    const hit = removeAll || texts.includes(input.value);
    if (method === 'select' && hit) input.checked = true;
    if (method === 'deselect' && hit) input.checked = false;
    if (method === 'selectAll') input.checked = true;
    if (method === 'deselectAll') input.checked = false;
    if (method === 'clear' && input.parentNode) {
      const label = input.closest && input.closest('label.choice');
      (label || input).parentNode.removeChild(label || input);
    }
  }
}

/** A ui choice argument is the choice text, or an AddChoice row with `option_value`. */
function optionText(arg) {
  if (arg == null) return '';
  if (typeof arg === 'object') {
    const v = arg.option_value ?? arg.option_display_value ?? arg.value;
    return v == null ? '' : String(v);
  }
  return String(arg);
}

/**
 * `input.Subform.Field:ui.<op>` on a grid column: the choice list lives on
 * `data-columns`, and each rendered cell's control follows it.
 */
function applyUiColumnOp(root, name, method, args) {
  const dot = name.indexOf('.');
  const box = root.querySelector(`.subform[data-field="${CSS.escape(name.slice(0, dot))}"]`);
  const column = name.slice(dot + 1);
  if (!box || !column) return;
  let columns = [];
  try {
    columns = JSON.parse(box.getAttribute('data-columns') || '[]');
  } catch {
    columns = [];
  }
  const index = columns.findIndex((item) => item && item.name === column);
  if (index < 0) return;
  const texts = (args || []).map(optionText).filter((t) => t !== '');
  const removeAll = texts.some((t) => t === 'REMOVE_ALL');
  const spec = columns[index];
  const choices = Array.isArray(spec.choices) ? spec.choices : [];
  let changed = false;
  if (method === 'add' || method === 'append') {
    for (const text of texts) {
      if (!choices.includes(text)) {
        choices.push(text);
        changed = true;
      }
      for (const el of box.querySelectorAll(`select[data-subfield="${CSS.escape(column)}"]`)) {
        if (![...el.options].some((o) => o.value === text)) {
          const option = el.ownerDocument.createElement('option');
          option.value = text;
          option.textContent = text;
          el.appendChild(option);
        }
      }
    }
  } else if (method === 'select' || method === 'deselect' || method === 'selectAll' || method === 'deselectAll') {
    const on = method === 'select' || method === 'selectAll';
    for (const el of box.querySelectorAll(`select[data-subfield="${CSS.escape(column)}"]`)) {
      for (const option of el.options || []) {
        if (method === 'selectAll' || method === 'deselectAll' || removeAll || texts.includes(option.value)) option.selected = on;
      }
    }
  } else if (method === 'clear') {
    choices.length = 0;
    changed = true;
    for (const el of box.querySelectorAll(`select[data-subfield="${CSS.escape(column)}"]`)) {
      for (const option of [...el.options]) if (option.value !== '') el.removeChild(option);
    }
  }
  if (changed) {
    spec.choices = choices;
    box.setAttribute('data-columns', JSON.stringify(columns));
  }
}

/**
 * `input.<subform>.insert(rows)` renders the rows into the grid. A `{ __row }`
 * constructed row contributes its `values`; a collection adds one row each.
 */
function subformInsertRows(root, name, rows) {
  const box = root && root.querySelector ? root.querySelector(`.subform[data-field="${CSS.escape(name)}"]`) : null;
  const body = box && box.querySelector ? box.querySelector('tbody') : null;
  const doc = box && box.ownerDocument;
  if (!box || !body || !doc) return;
  let columns = [];
  try {
    columns = JSON.parse(box.getAttribute('data-columns') || '[]');
  } catch {
    columns = [];
  }
  const list = Array.isArray(rows) ? rows : rows == null ? [] : [rows];
  for (const raw of list) {
    const row = raw && typeof raw === 'object' && raw.__row && raw.values && typeof raw.values === 'object' ? raw.values : raw;
    const tr = doc.createElement('tr');
    const rowKey = String(body.querySelectorAll('tr').length + 1);
    for (const column of columns) {
      if (!column || !column.name) continue;
      const td = doc.createElement('td');
      if (column.hidden) td.hidden = true;
      const el = typeof formLayoutControl === 'function' ? formLayoutControl(doc, column, rowKey) : doc.createElement('input');
      setGridCellValue(el, row && typeof row === 'object' ? row[column.name] : null);
      td.appendChild(el);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

/** Write one row value into a freshly built subform grid control. */
function setGridCellValue(el, value) {
  if (!el) return;
  const parts = el.querySelectorAll ? el.querySelectorAll('[data-part]') : [];
  if (parts && parts.length) {
    const obj = value && typeof value === 'object' ? value : {};
    for (const input of parts) {
      const key = input.getAttribute('data-part');
      const inner = key ? obj[key] : undefined;
      input.value = inner == null ? '' : String(inner);
    }
    return;
  }
  if (el.type === 'checkbox' || el.type === 'radio') {
    el.checked = value === true || value === 'true' || (value != null && String(value) === el.value && el.value !== '');
  } else if (el.multiple && el.options) {
    const set = new Set((Array.isArray(value) ? value : value == null ? [] : [value]).map(String));
    for (const option of el.options) option.selected = set.has(option.value);
  } else {
    el.value = value == null ? '' : String(value);
  }
}

/**
 * `Subform.Field` targets a grid column: hide/show toggles the header cell and
 * every row cell, and the flag is recorded on the column spec so rows added
 * later stay aligned. enable/disable toggles each row cell's control.
 */
function toggleSubformColumn(root, name, op) {
  const dot = name.indexOf('.');
  const box = root && root.querySelector ? root.querySelector(`.subform[data-field="${CSS.escape(name.slice(0, dot))}"]`) : null;
  if (!box) return;
  const column = name.slice(dot + 1);
  let columns = [];
  try {
    columns = JSON.parse(box.getAttribute('data-columns') || '[]');
  } catch {
    columns = [];
  }
  const index = columns.findIndex((item) => item && item.name === column);
  if (index < 0) return;
  if (op === 'hide' || op === 'show') {
    const hidden = op === 'hide';
    columns[index] = { ...columns[index], hidden };
    box.setAttribute('data-columns', JSON.stringify(columns));
    const th = box.querySelectorAll('thead th')[index];
    if (th) th.hidden = hidden;
    for (const tr of box.querySelectorAll('tbody tr')) {
      const td = tr.cells ? tr.cells[index] : tr.querySelectorAll('td')[index];
      if (td) td.hidden = hidden;
    }
  } else {
    for (const tr of box.querySelectorAll('tbody tr')) {
      const td = tr.cells ? tr.cells[index] : tr.querySelectorAll('td')[index];
      const input = td && td.querySelector ? td.querySelector('input, select, textarea') : null;
      if (input && op === 'disable') input.disabled = true;
      if (input && op === 'enable') input.disabled = false;
    }
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function blankDate(value) {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

function parseClientDate(value) {
  if (value == null) return null;
  if (typeof value === 'object' && value && typeof value.y === 'number' && typeof value.m === 'number' && typeof value.d === 'number') return value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  let m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (m) {
    const mon = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
    if (mon < 0) return undefined;
    return { y: Number(m[3]), m: mon + 1, d: Number(m[1]), hh: Number(m[4] ?? 0), mm: Number(m[5] ?? 0), ss: Number(m[6] ?? 0) };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), hh: Number(m[4] ?? 0), mm: Number(m[5] ?? 0), ss: Number(m[6] ?? 0) };
  return undefined;
}

function dateKey(parts) {
  return Date.UTC(parts.y, parts.m - 1, parts.d, parts.hh || 0, parts.mm || 0, parts.ss || 0);
}

/**
 * Same policy as the server shim. A blank date is not ordered with JS `null <= 0`.
 * https://www.zoho.com/deluge/help/error-messages.html
 */
function clientDateRel(a, b, op) {
  const js = op === '=' ? '==' : op;
  const leftBlank = blankDate(a);
  const rightBlank = blankDate(b);
  if (js === '==' || js === '!=') {
    if (leftBlank || rightBlank) {
      const eq = leftBlank && rightBlank;
      return js === '==' ? eq : !eq;
    }
  }
  if (js === '<' || js === '>' || js === '<=' || js === '>=') {
    if (leftBlank || rightBlank) {
      const err = new Error(`Null value occurred while performing ${js} operation`);
      err.code = 'BLANK_DATE_ORDER';
      throw err;
    }
  }
  const left = parseClientDate(a);
  const right = parseClientDate(b);
  if (!left || !right) {
    const err = new Error(`Null value occurred while performing ${js} operation`);
    err.code = 'BLANK_DATE_ORDER';
    throw err;
  }
  const c = dateKey(left) - dateKey(right);
  if (js === '==') return c === 0;
  if (js === '!=') return c !== 0;
  if (js === '<') return c < 0;
  if (js === '>') return c > 0;
  if (js === '<=') return c <= 0;
  if (js === '>=') return c >= 0;
  throw new Error(`date: unsupported comparison ${op}`);
}

function clientDateText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value && typeof value.y === 'number') {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${value.y}-${p(value.m)}-${p(value.d)}T${p(value.hh || 0)}:${p(value.mm || 0)}:${p(value.ss || 0)}`;
  }
  return String(value);
}

/** A client date: the { y, m, d, hh, mm, ss } shape the date helpers read, printed like the server DelugeDate. */
function clientDate(y, m, d, hh, mm, ss) {
  return {
    y,
    m,
    d,
    hh,
    mm,
    ss,
    toString() {
      return clientDateText(this);
    },
    toJSON() {
      return clientDateText(this);
    },
  };
}

/**
 * Wall time of now in the app time zone (ctx.appTimeZone, else the
 * C2C_APP_TIMEZONE that slate/c2c-config.js sets). No zone throws, as a live
 * server does: the browser's own zone is not the app's.
 */
function clientNow(ctx) {
  const zone = (ctx && typeof ctx.appTimeZone === 'string' && ctx.appTimeZone) || (typeof globalThis.C2C_APP_TIMEZONE === 'string' ? globalThis.C2C_APP_TIMEZONE : '');
  if (!zone) {
    const err = new Error('A Creator app time zone is required. slate/c2c-config.js sets C2C_APP_TIMEZONE from the app time zone setting.');
    err.code = 'TIMEZONE_REQUIRED';
    throw err;
  }
  const instant = ctx && ctx.now instanceof Date ? ctx.now : new Date(); // determinism-allow: runtime-only browser clock; not evaluated while generating files
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const bag = {};
  for (const part of fmt.formatToParts(instant)) if (part.type !== 'literal') bag[part.type] = part.value;
  return { y: Number(bag.year), m: Number(bag.month), d: Number(bag.day), hh: Number(bag.hour === '24' ? '0' : bag.hour), mm: Number(bag.minute), ss: Number(bag.second) };
}

/** Creator toString: unrecognized date-time is the given text, not the literal "null". */
function clientFormat(value, pattern) {
  if (value == null) return '';
  if (typeof value === 'string' && value.trim() === '') return value;
  const parts = parseClientDate(value);
  if (!parts || typeof pattern !== 'string') return typeof value === 'string' ? value : clientDateText(value);
  const pad = (n) => String(n).padStart(2, '0');
  const map = {
    yyyy: String(parts.y),
    yy: pad(parts.y % 100),
    MMMM: MONTHS[parts.m - 1],
    MMM: MONTHS[parts.m - 1],
    MM: pad(parts.m),
    dd: pad(parts.d),
    d: String(parts.d),
    HH: pad(parts.hh || 0),
    mm: pad(parts.mm || 0),
    ss: pad(parts.ss || 0),
  };
  return pattern.replace(/yyyy|yy|MMMM|MMM|MM|dd|d|HH|mm|ss/g, (token) => map[token] ?? token);
}

/** 'UnParsable date' — the same message packages/shims throws for a bad literal. */
function clientUnparsableDate() {
  const err = new Error('UnParsable date');
  err.code = 'UNPARSABLE_DATE';
  return err;
}

/** Blank values are null; a non-blank non-date throws, like dates.asDate. */
function clientAsDate(value) {
  if (value == null) return null;
  const parts = parseClientDate(value);
  if (parts) return parts;
  if (typeof value === 'string' && value.trim() === '') return null;
  throw clientUnparsableDate();
}

/** A parts object back into the clientDate wrapper (toString / toJSON). */
function clientDateOf(p) {
  return clientDate(p.y, p.m, p.d, p.hh || 0, p.mm || 0, p.ss || 0);
}

/** Same calendar math as dates.addDays. */
function clientAddDays(value, days) {
  const ms = Date.UTC(value.y, value.m - 1, value.d + days);
  const u = new Date(ms);
  return clientDate(u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate(), value.hh || 0, value.mm || 0, value.ss || 0);
}

/** Same month-end clamp as dates.addMonths. */
function clientAddMonths(value, months) {
  const total = value.y * 12 + (value.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return clientDate(y, m, Math.min(value.d, dim), value.hh || 0, value.mm || 0, value.ss || 0);
}

/** Hour shifts move hh only and carry mm/ss raw, like the server's addHour/subHour. */
function clientShiftHours(value, hours) {
  const total = value.hh + hours;
  const days = Math.floor(total / 24);
  const hh = ((total % 24) + 24) % 24;
  const base = clientAddDays(value, days);
  return clientDate(base.y, base.m, base.d, hh, value.mm || 0, value.ss || 0);
}

/** Minute shifts move hh:mm and carry ss raw, like the server's addMinutes/subMinutes. */
function clientShiftMinutes(value, minutes) {
  const total = value.hh * 60 + value.mm + minutes;
  const days = Math.floor(total / (24 * 60));
  const mins = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const base = clientAddDays(value, days);
  return clientDate(base.y, base.m, base.d, Math.floor(mins / 60), mins % 60, value.ss || 0);
}

/** Second shifts fold the whole clock into total seconds, like the server's addSeconds/subSeconds. */
function clientShiftTime(value, totalSeconds) {
  const total = value.hh * 3600 + value.mm * 60 + value.ss + totalSeconds;
  const days = Math.floor(total / 86400);
  const secs = ((total % 86400) + 86400) % 86400;
  const base = clientAddDays(value, days);
  return clientDate(base.y, base.m, base.d, Math.floor(secs / 3600), Math.floor((secs % 3600) / 60), secs % 60);
}

/** Days since 1970-01-01 (proleptic Gregorian), like DelugeDate.epochDay. */
function clientEpochDay(value) {
  return Date.UTC(value.y, value.m - 1, value.d) / 86400000;
}

/** Both ends of a between-dates count; a blank end throws, like the server's datePair. */
function clientDatePair(a, b) {
  const da = clientAsDate(a);
  const db = clientAsDate(b);
  if (!da || !db) throw clientUnparsableDate();
  return [da, db];
}

/** Milliseconds east of UTC for a GMT custom offset (`GMT-8`, `GMT+5:30`), like date.ts fixedGmtOffsetMs. */
function clientGmtOffsetMs(timeZone) {
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(timeZone);
  if (!match) return undefined;
  const hours = Number(match[2]);
  const minutes = match[3] === undefined ? 0 : Number(match[3]);
  if (hours > 23 || minutes > 59) return undefined;
  const sign = match[1] === '+' ? 1 : -1;
  return sign * (hours * 60 + minutes) * 60 * 1000;
}

/** The app zone ctx carries, else the C2C_APP_TIMEZONE slate sets. Missing or invalid throws. */
function clientAppZone(ctx) {
  const zone = (ctx && typeof ctx.appTimeZone === 'string' && ctx.appTimeZone) || (typeof globalThis.C2C_APP_TIMEZONE === 'string' ? globalThis.C2C_APP_TIMEZONE : '');
  if (!zone) {
    const err = new Error('A Creator app time zone is required. slate/c2c-config.js sets C2C_APP_TIMEZONE from the app time zone setting.');
    err.code = 'TIMEZONE_REQUIRED';
    throw err;
  }
  if (clientGmtOffsetMs(zone) !== undefined) return zone;
  new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date(0));
  return zone;
}

/** Wall-clock parts of an instant in a zone, like dates.partsInZone. */
function clientPartsInZone(instant, zone) {
  const fixed = clientGmtOffsetMs(zone);
  if (fixed !== undefined) {
    const shifted = new Date(instant.getTime() + fixed);
    return {
      y: shifted.getUTCFullYear(),
      m: shifted.getUTCMonth() + 1,
      d: shifted.getUTCDate(),
      hh: shifted.getUTCHours(),
      mm: shifted.getUTCMinutes(),
      ss: shifted.getUTCSeconds(),
    };
  }
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const bag = {};
  for (const part of fmt.formatToParts(instant)) if (part.type !== 'literal') bag[part.type] = part.value;
  return {
    y: Number(bag.year),
    m: Number(bag.month),
    d: Number(bag.day),
    hh: Number(bag.hour === '24' ? '0' : bag.hour),
    mm: Number(bag.minute),
    ss: Number(bag.second),
  };
}

/** The instant a wall time names in a zone, like dates.epochMillis: DST gaps throw, overlaps take the earlier instant. */
function clientEpochMillis(value, zone) {
  const wall = Date.UTC(value.y, value.m - 1, value.d, value.hh || 0, value.mm || 0, value.ss || 0);
  const offsetAt = (t) => {
    const w = clientPartsInZone(new Date(t), zone);
    return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss) - t;
  };
  const sameWall = (t) => {
    const w = clientPartsInZone(new Date(t), zone);
    return w.y === value.y && w.m === value.m && w.d === value.d && w.hh === (value.hh || 0) && w.mm === (value.mm || 0) && w.ss === (value.ss || 0);
  };
  let instant = wall;
  let prev = Number.NaN;
  for (let i = 0; i < 6; i++) {
    const next = wall - offsetAt(instant);
    if (next === instant || next === prev) break;
    prev = instant;
    instant = next;
  }
  const candidates = new Set([instant]);
  for (const delta of [-2 * 3600000, -3600000, 3600000, 2 * 3600000]) {
    candidates.add(wall - offsetAt(instant + delta));
  }
  const matches = [...candidates].filter(sameWall).sort((a, b) => a - b);
  if (!matches.length) {
    const err = new Error(`date: ${clientDateText(value)} does not exist in ${zone} (DST gap)`);
    err.code = 'NONEXISTENT_LOCAL_TIME';
    throw err;
  }
  return matches[0];
}

const CLIENT_LONG_NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const CLIENT_MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** A DelugeConversionError, like packages/shims/src/convert.ts. */
function clientConversionError(message) {
  const err = new Error(message);
  err.name = 'DelugeConversionError';
  err.code = 'DELUGE_CONVERSION';
  return err;
}

const CLIENT_MAP_BAD = 'Invalid JSON Format String';
const CLIENT_MAX_MAP_TEXT = 5 * 1024 * 1024;
const CLIENT_MAX_MAP_DEPTH = 64;

/** Integer square root by Newton's method, like number.ts bigintSqrt. */
function clientBigintSqrt(value) {
  if (value === 0n) return 0n;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/** JSON.parse that keeps unsafe integer literals exact, like ids.ts parseJsonLossless. */
function clientParseJsonLossless(text) {
  return JSON.parse(quoteUnsafeIntegers(text));
}

/** convert.ts isPlain: a client Decimal fails the proto check; a Deluge date is a plain object on the wire, so it is excluded by shape. */
function clientIsPlainMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.y === 'number' && typeof value.m === 'number' && typeof value.d === 'number') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The decimal as a double, only when the double's shortest text is the decimal's own. */
function clientDecimalArg(name, value) {
  const text = clientDecimal().from(value);
  const n = Number(text);
  if (!Number.isFinite(n) || !clientDecimal().cmp(text, n, '==')) {
    throw clientConversionError(`${name}: value ${text} is not exactly representable as a double; refusing to lose precision`);
  }
  return n;
}

/** Blank and non-numeric inputs are null, like number.ts realArg; an exactness loss refuses. */
function clientRealArg(name, value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') {
    if (value > CLIENT_MAX_SAFE || value < -CLIENT_MAX_SAFE) {
      throw clientConversionError(`${name}: magnitude exceeds 2^53; refusing to lose precision`);
    }
    return Number(value);
  }
  if (typeof value === 'object' && typeof value.digits === 'bigint' && typeof value.toString === 'function') {
    return clientDecimalArg(name, value);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return null;
    let d;
    try {
      d = clientDecimal().from(text);
    } catch {
      return null;
    }
    return clientDecimalArg(name, d);
  }
  return null;
}

/** Deluge's {key:value} text form, like convert.ts looseMap. */
function clientLooseMap(text, depth = 0) {
  if (depth >= CLIENT_MAX_MAP_DEPTH) throw clientConversionError('toMap: text exceeds the depth limit');
  const inner = text.slice(1, -1).trim();
  const out = {};
  if (!inner) return out;
  for (const pair of clientSplitTop(inner, ',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const colon = clientTopColon(trimmed);
    if (colon < 0) throw clientConversionError('toMap: text is not a key-value map');
    const key = clientUnquote(trimmed.slice(0, colon).trim());
    if (!key) throw clientConversionError('toMap: empty key');
    // defineProperty so '__proto__' is data, not a prototype write.
    Object.defineProperty(out, key, { value: clientLooseValue(trimmed.slice(colon + 1).trim(), depth), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function clientLooseValue(raw, depth) {
  if (!raw) throw clientConversionError('toMap: empty value');
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return clientUnquote(raw);
  if (raw.startsWith('{') && raw.endsWith('}')) return clientLooseMap(raw, depth + 1);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (CLIENT_NUMERIC.test(raw)) {
    if (/[.eE]/.test(raw)) return clientDecimal().from(raw);
    return Number.isSafeInteger(Number(raw)) ? Number(raw) : raw.replace(/^\+/, '');
  }
  if (/^[A-Za-z_][\w$]*$/.test(raw)) return raw;
  throw clientConversionError('toMap: text is not a key-value map');
}

function clientUnquote(token) {
  if (token.length >= 2 && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))) {
    return token.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return token;
}

/** Split on the top-level separator, like convert.ts splitTop. */
function clientSplitTop(input, sep) {
  const out = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      out.push(input.slice(start, i));
      start = i + 1;
    }
  }
  out.push(input.slice(start));
  return out;
}

/** The first top-level colon, like convert.ts topColon. */
function clientTopColon(input) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ':' && depth === 0) return i;
  }
  return -1;
}

function clientLongCastError(value, name) {
  const err =
    value == null
      ? new Error(`Value is empty and '${name}' function cannot be applied`)
      : new Error(`Unable to cast the '${typeof value === 'string' ? value : String(value)}' value into a 'Long' value because the input is in an invalid format`);
  err.code = 'DELUGE_CONVERSION';
  return err;
}

/** Whole part of a canonical decimal string as a fitted number/bigint, like convert.truncTowardZero. */
function clientTruncLong(text) {
  const neg = text.startsWith('-');
  const whole = text.replace(/^[+-]/, '').split('.')[0] || '0';
  if (!/^\d+$/.test(whole)) {
    const err = new Error('toLong: not a finite number');
    err.code = 'DELUGE_CONVERSION';
    throw err;
  }
  const big = neg ? -BigInt(whole) : BigInt(whole);
  return big > CLIENT_MAX_SAFE || big < -CLIENT_MAX_SAFE ? big : Number(big);
}

/** toLong and toNumber, on the same rules as convert.ts castLong. A client date is epoch milliseconds in the app zone. */
function clientToLong(value, ctx, name = 'toLong') {
  if (value == null) throw clientLongCastError(value, name);
  if (typeof value === 'object' && typeof value.y === 'number' && typeof value.m === 'number' && typeof value.d === 'number') {
    return clientEpochMillis(value, clientAppZone(ctx));
  }
  if (typeof value === 'object' && typeof value.digits === 'bigint' && typeof value.toString === 'function') {
    return clientTruncLong(value.toString());
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw clientLongCastError(value, name);
    const truncated = Math.trunc(value);
    if (!Number.isSafeInteger(truncated)) {
      const err = new Error('toLong: magnitude exceeds 2^53; refusing to lose precision');
      err.code = 'DELUGE_CONVERSION';
      throw err;
    }
    return truncated;
  }
  if (typeof value === 'bigint') {
    return value > CLIENT_MAX_SAFE || value < -CLIENT_MAX_SAFE ? value : Number(value);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '' || !CLIENT_LONG_NUMERIC.test(text)) throw clientLongCastError(value, name);
    if (/[.eE]/.test(text)) return clientTruncLong(clientDecimal().from(text));
    return clientTruncLong(text);
  }
  throw clientLongCastError(value, name);
}

/**
 * Exact decimal for the browser shim. Same bigint scale rules as
 * packages/shims/src/decimal.ts. Ops return canonical strings, not JS numbers.
 * A blank (null or "") is not zero: relational cmp is false, and equality is
 * true only when both sides are blank.
 */
export function clientDecimal() {
  const DIV_SCALE = 20;

  class Dec {
    constructor(digits, scale, neg) {
      this.digits = digits;
      this.scale = scale;
      this.neg = neg;
    }

    static from(value) {
      if (value instanceof Dec) return value;
      const raw = String(value).trim();
      const m = /^([+-])?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
      if (!m) throw new Error('decimal: not a number: ' + raw);
      const neg = m[1] === '-';
      const whole = m[2];
      const frac = m[3] || '';
      const exp = m[4] ? Number(m[4]) : 0;
      const digits = BigInt((whole + frac).replace(/^0+(?=\d)/, '') || '0');
      const scale = frac.length - exp;
      if (scale >= 0) return new Dec(digits, scale, neg && digits !== 0n);
      const shifted = digits * 10n ** BigInt(-scale);
      return new Dec(shifted, 0, neg && shifted !== 0n);
    }

    static align(a, b) {
      const scale = Math.max(a.scale, b.scale);
      const ad = a.signed() * 10n ** BigInt(scale - a.scale);
      const bd = b.signed() * 10n ** BigInt(scale - b.scale);
      return [ad, bd, scale];
    }

    signed() {
      return this.neg ? -this.digits : this.digits;
    }

    static fromSigned(signed, scale) {
      return new Dec(signed < 0n ? -signed : signed, scale, signed < 0n);
    }

    add(other) {
      const b = Dec.from(other);
      const [ad, bd, scale] = Dec.align(this, b);
      return Dec.fromSigned(ad + bd, scale);
    }

    sub(other) {
      const b = Dec.from(other);
      const [ad, bd, scale] = Dec.align(this, b);
      return Dec.fromSigned(ad - bd, scale);
    }

    mul(other) {
      const b = Dec.from(other);
      return Dec.fromSigned(this.signed() * b.signed(), this.scale + b.scale);
    }

    div(other) {
      const b = Dec.from(other);
      if (b.digits === 0n) throw new Error('decimal: division by zero');
      const scale = Math.max(this.scale, b.scale, DIV_SCALE);
      const num = this.signed() * 10n ** BigInt(scale + b.scale - this.scale);
      const den = b.signed();
      const q = num / den;
      const rem = num % den;
      const twice = rem < 0n ? -rem * 2n : rem * 2n;
      const denAbs = den < 0n ? -den : den;
      const round = twice >= denAbs ? (q < 0n ? -1n : 1n) : 0n;
      return Dec.trimmed(q + round, scale);
    }

    compare(other) {
      const [ad, bd] = Dec.align(this, Dec.from(other));
      return ad < bd ? -1 : ad > bd ? 1 : 0;
    }

    static trimmed(signed, scale) {
      let digits = signed < 0n ? -signed : signed;
      let s = scale;
      while (s > 0 && digits % 10n === 0n) {
        digits /= 10n;
        s -= 1;
      }
      return new Dec(digits, s, signed < 0n && digits !== 0n);
    }

    toString() {
      const body = this.digits.toString().padStart(this.scale + 1, '0');
      if (!this.scale) {
        const text = body.replace(/^0+(?=\d)/, '') || '0';
        return this.neg ? '-' + text : text;
      }
      const wholeRaw = body.slice(0, body.length - this.scale);
      const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0';
      const frac = body.slice(body.length - this.scale);
      const text = whole + '.' + frac;
      return this.neg ? '-' + text : text;
    }

    toJSON() {
      return this.toString();
    }
  }

  function blank(value) {
    if (value instanceof Dec) return false;
    if (value == null) return true;
    return typeof value === 'string' && value.trim() === '';
  }

  function cmp(a, b, op) {
    const blankA = blank(a);
    const blankB = blank(b);
    if (blankA || blankB) {
      if (!blankA) Dec.from(a);
      if (!blankB) Dec.from(b);
      if (op === '==' || op === '=') return blankA && blankB;
      if (op === '!=' || op === 'is not') return !(blankA && blankB);
      if (op === '<' || op === '>' || op === '<=' || op === '>=') return false;
      throw new Error('decimal: bad compare ' + op);
    }
    const rel = Dec.from(a).compare(b);
    if (op === '<') return rel < 0;
    if (op === '>') return rel > 0;
    if (op === '<=') return rel <= 0;
    if (op === '>=') return rel >= 0;
    if (op === '==' || op === '=') return rel === 0;
    if (op === '!=' || op === 'is not') return rel !== 0;
    throw new Error('decimal: bad compare ' + op);
  }

  return {
    from(value) {
      return Dec.from(value).toString();
    },
    add(a, b) {
      return Dec.from(a).add(b).toString();
    },
    sub(a, b) {
      return Dec.from(a).sub(b).toString();
    },
    mul(a, b) {
      return Dec.from(a).mul(b).toString();
    },
    div(a, b) {
      return Dec.from(a).div(b).toString();
    },
    cmp,
  };
}

/**
 * for each: null iterates zero times (golden `foreach.null`), a single
 * { __row } record is a collection of one, and any other non-collection is
 * rejected with an uncaptured error — no Creator message was ever captured for
 * it, so it is not a DelugeRuntimeError (same rules as shims/src/runtime.ts
 * eachOf).
 */
function clientEach(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [...value];
  if (typeof value === 'object' && Symbol.iterator in value) return [...value];
  if (typeof value === 'object' && value.__row) return [value];
  const err = new Error("Value is not a collection and 'for each' cannot be applied");
  err.name = 'UncapturedDelugeError';
  err.code = 'DELUGE_UNCAPTURED';
  throw err;
}

/*
 * Creator list and map operations for client code: a port of the pure
 * functions in packages/shims/src/list.ts (same dispatch by runtime shape,
 * same results and error messages). The translator emits only the methods
 * listed in packages/deluge/src/client-shim.ts into client code.
 */
const CLIENT_UNSAFE_MAP_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CLIENT_INTEGER = /^\s*[+-]?\d+\s*$/;
const CLIENT_NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function clientListError(message) {
  const err = new Error(message);
  err.name = 'DelugeRuntimeError';
  return err;
}

function clientIsPlain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if ('__query' in value) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function clientAsBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value) : null;
  if (typeof value === 'string' && CLIENT_INTEGER.test(value)) return BigInt(value.trim());
  return null;
}

/** Same rule as sameId in packages/shims/src/ids.ts: a bigint matches its integer text or number. */
function clientSameId(left, right) {
  if (typeof left === typeof right) return left === right;
  if (typeof left !== 'bigint' && typeof right !== 'bigint') return left === right;
  const a = clientAsBigInt(left);
  const b = clientAsBigInt(right);
  return a !== null && b !== null && a === b;
}

function clientShownIndex(index) {
  if (typeof index === 'number' || typeof index === 'string') return String(index);
  return String(Number(index));
}

function clientAsIndex(index) {
  return typeof index === 'number' ? index : Number(index);
}

function clientIndexError(index) {
  return clientListError(`Given index ${clientShownIndex(index)} is greater than the list size`);
}

function clientEmptyToNull(value) {
  return value === '' ? null : value;
}

function clientListCompare(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  const as = a == null ? '' : String(a);
  const bs = b == null ? '' : String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

function clientReadField(row, field) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const values = '__row' in row ? row.values : undefined;
  const rec = values && typeof values === 'object' && !Array.isArray(values) ? values : row;
  if (field === 'ID' && !Object.hasOwn(rec, 'ID')) return rec.ROWID ?? rec.rowid ?? null;
  return Object.hasOwn(rec, field) ? (rec[field] ?? null) : null;
}

export function clientListMethods() {
  const contains = (value, needle) => {
    if (Array.isArray(value)) return value.some((item) => clientSameId(item, needle));
    if (value == null) return false;
    return String(value).includes(needle == null ? '' : String(needle));
  };
  const containsKey = (value, key) => {
    if (!clientIsPlain(value) || key == null) return false;
    return Object.prototype.hasOwnProperty.call(value, String(key));
  };
  const distinct = (value) => {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const item of value) if (!out.some((seen) => seen === item)) out.push(item);
    return out;
  };
  return {
    get(value, index) {
      if (Array.isArray(value)) {
        const i = clientAsIndex(index);
        if (!Number.isInteger(i) || i < 0 || i >= value.length) throw clientIndexError(index);
        return value[i];
      }
      if (clientIsPlain(value)) {
        if (index == null) return null;
        const key = String(index);
        return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : null;
      }
      return null;
    },
    put(value, key, val) {
      if (clientIsPlain(value)) {
        if (key != null && !CLIENT_UNSAFE_MAP_KEYS.has(String(key))) value[String(key)] = val ?? null;
        return value;
      }
      if (Array.isArray(value)) {
        const i = clientAsIndex(key);
        if (Number.isInteger(i) && i >= 0) value[i] = val ?? null;
      }
      return value;
    },
    remove(value, a, b) {
      if (Array.isArray(value)) {
        if (value.length === 0) throw clientListError('emptyList');
        const i = clientAsIndex(a);
        if (!Number.isInteger(i) || i < 0 || i >= value.length) throw clientIndexError(a);
        return value.splice(i, 1)[0];
      }
      if (value == null) return null;
      const s = String(value);
      if (typeof a === 'number' && typeof b === 'number') return clientEmptyToNull(s.slice(0, a) + s.slice(b));
      const needle = a == null ? '' : String(a);
      if (needle === '') return clientEmptyToNull(s);
      return clientEmptyToNull(s.split(needle).join(''));
    },
    removeAll(value, drop) {
      if (!Array.isArray(value)) return value;
      const ban = Array.isArray(drop) ? drop : [drop];
      const next = value.filter((item) => !ban.some((x) => x === item));
      value.length = 0;
      value.push(...next);
      return value;
    },
    removeElement(value, item) {
      if (!Array.isArray(value)) return value;
      const at = value.findIndex((x) => x === item);
      if (at >= 0) value.splice(at, 1);
      return value;
    },
    distinct,
    sort(value, asc) {
      if (!Array.isArray(value)) return [];
      const dir = asc === false ? -1 : 1;
      value.sort((a, b) => clientListCompare(a, b) * dir);
      return value;
    },
    intersect(left, right) {
      if (!Array.isArray(left) || !Array.isArray(right)) return [];
      const out = [];
      for (const item of left) {
        if (right.some((x) => x === item) && !out.some((seen) => seen === item)) out.push(item);
      }
      return out;
    },
    indexOf(value, needle, from) {
      const start = from == null ? 0 : Number(from);
      if (Array.isArray(value)) {
        for (let i = Number.isFinite(start) ? start : 0; i < value.length; i++) {
          if (clientSameId(value[i], needle)) return i;
        }
        return -1;
      }
      const s = value == null ? '' : String(value);
      return s.indexOf(needle == null ? '' : String(needle), Number.isFinite(start) ? start : 0);
    },
    lastIndexOf(value, needle) {
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) if (clientSameId(value[i], needle)) return i;
        return -1;
      }
      const s = value == null ? '' : String(value);
      return s.lastIndexOf(needle == null ? '' : String(needle));
    },
    length(value) {
      return typeof value === 'string' ? value.length : null;
    },
    size(value) {
      if (Array.isArray(value)) return value.length;
      if (clientIsPlain(value)) return Object.keys(value).length;
      if (typeof value === 'string') return value.length;
      return null;
    },
    add(value, ...items) {
      if (!Array.isArray(value)) return value;
      value.push(...items);
      return value;
    },
    addAll(value, extra) {
      if (!Array.isArray(value)) return value;
      if (Array.isArray(extra)) value.push(...extra);
      return value;
    },
    contains,
    containsKey,
    containsValue(value, val) {
      // determinism-allow: browser runtime, never generated bytes; map order is insertion order, as in packages/shims/src/list.ts
      if (clientIsPlain(value)) return Object.values(value).some((item) => clientSameId(item, val));
      if (Array.isArray(value)) return value.some((item) => clientSameId(item, val));
      return false;
    },
    notContains(value, needle) {
      if (Array.isArray(value)) return !contains(value, needle);
      if (clientIsPlain(value)) return !containsKey(value, needle);
      return !contains(value, needle);
    },
    clear(value) {
      if (Array.isArray(value)) {
        value.length = 0;
        return value;
      }
      // determinism-allow: browser runtime, never generated bytes; map order is insertion order, as in packages/shims/src/list.ts
      if (clientIsPlain(value)) for (const key of Object.keys(value)) delete value[key];
      return value;
    },
    insert(value, a, b) {
      if (!Array.isArray(value)) return value;
      if (typeof a === 'number' && arguments.length >= 3) {
        value.splice(a < 0 ? 0 : a > value.length ? value.length : a, 0, b);
        return value;
      }
      value.push(a);
      return value;
    },
    insertAll(value, a, b) {
      if (!Array.isArray(value)) return value;
      let index;
      let extra = a;
      if (typeof a === 'number' && arguments.length >= 3) {
        index = a < 0 ? 0 : a > value.length ? value.length : a;
        extra = b;
      }
      const items = Array.isArray(extra) ? extra : [extra];
      if (index !== undefined) value.splice(index, 0, ...items);
      else value.push(...items);
      return value;
    },
    putAll(value, extra) {
      if (clientIsPlain(value) && clientIsPlain(extra)) {
        // determinism-allow: browser runtime, never generated bytes; map order is insertion order, as in packages/shims/src/list.ts
        for (const key of Object.keys(extra)) if (!CLIENT_UNSAFE_MAP_KEYS.has(key)) value[key] = extra[key];
      }
      return value;
    },
    keys(value) {
      // determinism-allow: browser runtime, never generated bytes; map order is insertion order, as in packages/shims/src/list.ts
      return clientIsPlain(value) ? Object.keys(value) : [];
    },
    values(value) {
      // determinism-allow: browser runtime, never generated bytes; map order is insertion order, as in packages/shims/src/list.ts
      if (clientIsPlain(value)) return Object.values(value);
      if (Array.isArray(value)) return value.slice();
      return [];
    },
    update(value, a, b) {
      if (clientIsPlain(value)) {
        if (a != null) value[String(a)] = b ?? null;
        return value;
      }
      if (Array.isArray(value)) {
        const i = clientAsIndex(a);
        if (!Number.isInteger(i) || i < 0 || i >= value.length) throw clientIndexError(a);
        value[i] = b ?? null;
      }
      return value;
    },
    subList(value, start, end) {
      if (!Array.isArray(value)) throw clientListError('subList: receiver is not a list');
      const a = clientAsIndex(start);
      const b = end === undefined || end === null ? value.length : clientAsIndex(end);
      if (!Number.isInteger(a) || a < 0) throw clientListError(`Given index ${clientShownIndex(start)} is invalid`);
      if (!Number.isInteger(b) || b > value.length) throw clientIndexError(end);
      if (a > b) throw clientListError('Start index cannot be greater than the end index');
      return value.slice(a, b);
    },
    column(rows, field) {
      const name = field == null ? '' : String(field);
      if (Array.isArray(rows)) return rows.map((row) => clientReadField(row, name));
      if (rows && typeof rows === 'object') return [clientReadField(rows, name)];
      return [];
    },
    deleteKey(value, key) {
      if (clientIsPlain(value)) {
        if (key != null) delete value[String(key)];
      } else if (Array.isArray(value)) {
        const i = clientAsIndex(key);
        if (!Number.isInteger(i) || i < 0 || i >= value.length) throw clientIndexError(key);
        value.splice(i, 1);
      }
      return value;
    },
    deleteKeys(value, keysList) {
      if (!Array.isArray(keysList)) return value;
      if (clientIsPlain(value)) {
        for (const k of keysList) if (k != null) delete value[String(k)];
      } else if (Array.isArray(value)) {
        const indices = [];
        for (const k of keysList) {
          const i = clientAsIndex(k);
          if (Number.isInteger(i) && i >= 0 && i < value.length) indices.push(i);
        }
        indices.sort((a, b) => b - a);
        for (const i of indices) value.splice(i, 1);
      }
      return value;
    },
    getKey(value, val) {
      if (clientIsPlain(value)) {
        // determinism-allow: browser runtime, never generated bytes; map order is insertion order, as in packages/shims/src/list.ts
        for (const [k, v] of Object.entries(value)) if (clientSameId(v, val)) return k;
      } else if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) if (clientSameId(value[i], val)) return i;
      }
      return Array.isArray(value) ? -1 : null;
    },
    getLastKey(value, val) {
      if (clientIsPlain(value)) {
        // determinism-allow: browser runtime, never generated bytes; map order is insertion order, as in packages/shims/src/list.ts
        const keys = Object.keys(value);
        for (let i = keys.length - 1; i >= 0; i--) if (clientSameId(value[keys[i]], val)) return keys[i];
      } else if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) if (clientSameId(value[i], val)) return i;
      }
      return Array.isArray(value) ? -1 : null;
    },
    deleteItem(value, item) {
      if (Array.isArray(value)) {
        const i = value.findIndex((x) => clientSameId(x, item));
        if (i >= 0) value.splice(i, 1);
      }
      return value;
    },
    deleteAll(value, item) {
      if (Array.isArray(value)) {
        let i = 0;
        while (i < value.length) {
          if (clientSameId(value[i], item)) value.splice(i, 1);
          else i++;
        }
      }
      return value;
    },
    duplicate(value) {
      if (Array.isArray(value)) return value.slice();
      if (clientIsPlain(value)) return { ...value };
      return value;
    },
    sortKey(value) {
      if (!clientIsPlain(value)) return value;
      const out = {};
      for (const k of Object.keys(value).sort()) out[k] = value[k];
      return out;
    },
  };
}

/** `shim.list(type)` is a new list; `shim.list.<method>` is a list or map operation. */
function clientListApi() {
  const methods = clientListMethods();
  return new Proxy(function list() {
    return [];
  }, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(methods, prop)) return methods[prop];
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Null and blank tests and `ifNull`: the same rules as the server runtime (runtime.ts, text.ts, number.ts). */
const clientValueTests = {
  isBlank(value) {
    if (value == null) return true;
    if (typeof value === 'string') return value.trim() === '';
    return false;
  },
  isNull(value) {
    return value == null || value === '';
  },
  isEmpty(value) {
    if (value == null) return true;
    if (typeof value === 'string') return value.length === 0;
    if (Array.isArray(value)) return value.length === 0;
    if (clientIsPlain(value)) return Object.keys(value).length === 0;
    return false;
  },
  isNumber(value) {
    if (value == null || typeof value === 'boolean') return null;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'bigint') return true;
    if (typeof value === 'string') return CLIENT_NUMERIC.test(value.trim());
    return false;
  },
  ifnull(value, replacement) {
    const chosen = value == null ? replacement : value;
    return chosen === '' ? null : chosen;
  },
};

/** `Field == literal` on the client: same id/label member compare as the server shim's compare.eq. */
function clientCompareScalars(value) {
  const flat = value && typeof value === 'object' && '__row' in value ? value.values : value;
  if (Array.isArray(flat)) return flat.flatMap(clientCompareScalars);
  if (flat && typeof flat === 'object') {
    const members = [flat.id, flat.ID, flat.ROWID, flat.rowid, flat.label, flat.name].filter((m) => m != null && typeof m !== 'object');
    if (members.length) return members;
  }
  return [flat];
}

function clientCompareEq(value, other) {
  return clientCompareScalars(value).some((a) => clientCompareScalars(other).some((b) => a == b));
}

/**
 * Server calls. Slate is served from its own *.onslate.* domain and the c2c_api
 * Advanced I/O function from the project domain, so a deployed client calls an
 * absolute https://<project-domain>/server/c2c_api base. slate/c2c-config.js
 * sets globalThis.C2C_API_BASE; with no base the endpoints stay root-relative.
 * When the Catalyst Web SDK is loaded, each call carries the signed-in user's
 * token (Catalyst Authentication), and cross-origin calls send cookies.
 */
export function apiBase(viewRef) {
  const scope = viewRef || globalThis;
  const raw = scope && typeof scope.C2C_API_BASE === 'string' ? scope.C2C_API_BASE : '';
  return raw.replace(/\/+$/, '');
}

/** Exact loopback names — a host that only starts with one (`127.0.0.1.evil.test`) is not loopback. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** The page's own address — the origin a relative endpoint belongs to. */
function pageUrl(viewRef) {
  const scope = viewRef || globalThis;
  const href = scope && scope.location && typeof scope.location.href === 'string' ? scope.location.href : '';
  try {
    return new URL(href || 'https://localhost/');
  } catch {
    return new URL('https://localhost/');
  }
}

/**
 * Where an authenticated request may go. The endpoint joins the configured
 * API base, or the page origin when no base is set, and the result must land
 * on the page origin or the configured API origin itself. That configured
 * origin is trusted only as https — or http to an exact loopback address on
 * a local dev stack, the same rule the signed-upload check uses. Anything
 * else — an absolute URL to another host, a protocol-relative `//host/path`,
 * or a non-web scheme such as `javascript:` or `data:` — is refused here, so
 * the session token is never attached to a request for a different origin.
 */
export function apiUrl(endpoint, viewRef) {
  if (typeof endpoint !== 'string' || !endpoint) throw new Error('api request refused: the endpoint is not an address');
  const page = pageUrl(viewRef);
  const base = apiBase(viewRef);
  let baseOrigin = '';
  if (base) {
    try {
      const parsedBase = new URL(base, page);
      if (parsedBase.protocol === 'https:' || (parsedBase.protocol === 'http:' && LOOPBACK_HOSTS.has(parsedBase.hostname))) {
        baseOrigin = parsedBase.origin;
      }
    } catch {
      baseOrigin = '';
    }
  }
  // A scheme (`https:`) or leading `//` names its own host — it never joins the base.
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(endpoint) || endpoint.startsWith('//');
  const request = !base || absolute ? endpoint : `${base}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
  let target = null;
  try {
    target = new URL(request, page);
  } catch {
    target = null;
  }
  const webTarget = target !== null && (target.protocol === 'http:' || target.protocol === 'https:');
  const allowed = webTarget && (target.origin === page.origin || (baseOrigin !== '' && target.origin === baseOrigin));
  if (!allowed) throw new Error(`api request refused: ${endpoint} is not on the page or configured API origin`);
  return request;
}

/**
 * Token bridge. The Slate origin serves no /baas routes, so the
 * Web SDK cannot mint a functions token on it. The configured C2C_AUTH_BRIDGE
 * page runs on the function origin — where the SDK is first-party — and
 * returns the token in `#c2c_auth=<token>&state=<state>`. The state binds the
 * fragment to this tab: a link carrying a foreign token is refused because
 * its state never equals the sessionStorage value written here.
 */
const BRIDGE_STATE_KEY = 'c2c.bridge.state';
const BRIDGE_TOKEN_KEY = 'c2c.bridge.token';
const BRIDGE_ROUTE_KEY = 'c2c.bridge.route';
const BRIDGE_MARK = 'c2c.bridge.at';
/** Two bridge round trips inside this window mean the trip itself fails. */
const BRIDGE_LOOP_MS = 60_000;

function bridgeScope(viewRef) {
  return viewRef || globalThis;
}

function bridgeConfigured(viewRef) {
  const scope = bridgeScope(viewRef);
  return typeof scope.C2C_AUTH_BRIDGE === 'string' && scope.C2C_AUTH_BRIDGE.length > 0;
}

function bridgeStore(viewRef) {
  try {
    return bridgeScope(viewRef).sessionStorage || null;
  } catch {
    return null;
  }
}

/** A fixed-time compare so a fragment's state is checked without an early exit. */
function sameBridgeState(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function storedBridgeToken(viewRef) {
  try {
    return (bridgeStore(viewRef) && bridgeStore(viewRef).getItem(BRIDGE_TOKEN_KEY)) || '';
  } catch {
    return '';
  }
}

function forgetBridgeToken(viewRef) {
  try {
    const store = bridgeStore(viewRef);
    if (store) store.removeItem(BRIDGE_TOKEN_KEY);
  } catch {
    // storage refused
  }
}

/**
 * Read `#c2c_auth=<token>&state=<state>` off the address bar. A matching
 * fragment is consumed exactly once: the token is kept in sessionStorage for
 * reloads, the route saved before the bridge trip is restored, and the
 * fragment is stripped with replaceState so it never reaches the router, a
 * log, or a referrer. A mismatched or unsigned state drops the token.
 */
export function intakeBridgeFragment(viewRef) {
  const scope = bridgeScope(viewRef);
  const location = scope.location;
  const hash = location && typeof location.hash === 'string' ? location.hash : '';
  if (!hash.startsWith('#c2c_auth=')) return;
  let token = '';
  let state = '';
  try {
    const params = new URLSearchParams(hash.slice(1));
    token = params.get('c2c_auth') || '';
    state = params.get('state') || '';
  } catch {
    return;
  }
  // Strip the fragment before anything else can see it, restoring the route
  // the tab was on when it left for the bridge.
  let route = '/';
  try {
    const store = bridgeStore(viewRef);
    const saved = store && store.getItem(BRIDGE_ROUTE_KEY);
    if (saved && saved.startsWith('/')) route = saved;
    if (store) store.removeItem(BRIDGE_ROUTE_KEY);
  } catch {
    // storage refused: fall back to the root route
  }
  let replaceError;
  try {
    if (!scope.history || typeof scope.history.replaceState !== 'function') throw new Error('history.replaceState is unavailable');
    scope.history.replaceState(null, '', new URL(route, pageUrl(viewRef).origin).href);
  } catch (error) {
    replaceError = error;
    forgetBridgeToken(viewRef);
    try { location.hash = ''; } catch { /* location is read-only in some hosts */ }
  }
  let expected = '';
  try {
    const store = bridgeStore(viewRef);
    expected = (store && store.getItem(BRIDGE_STATE_KEY)) || '';
    if (store) store.removeItem(BRIDGE_STATE_KEY);
  } catch {
    // storage refused
  }
  if (replaceError) throw replaceError;
  if (!token || !expected || !sameBridgeState(state, expected)) return;
  try {
    const store = bridgeStore(viewRef);
    if (store) {
      store.setItem(BRIDGE_TOKEN_KEY, token);
    }
  } catch {
    // storage refused: the token stays in this page only
  }
}

function recentBridge(viewRef) {
  try {
    const store = bridgeStore(viewRef);
    const at = Number(store && store.getItem(BRIDGE_MARK));
    return Number.isFinite(at) && at > 0 && Date.now() - at < BRIDGE_LOOP_MS; // determinism-allow: runtime browser clock read; Date.now is not evaluated while generating files
  } catch {
    return false;
  }
}

/**
 * Send the tab to the token bridge, remembering where it was. The bridge URL
 * is the deploy-generated C2C_AUTH_BRIDGE: trusted config, https only (or a
 * loopback host on a local stack). Returns false when the round trip would
 * loop — a bridge return without a token lands on the signed-out prompt
 * instead of redirecting forever.
 */
export function bridgeRedirect(viewRef, force) {
  const scope = bridgeScope(viewRef);
  const bridge = scope.C2C_AUTH_BRIDGE;
  if (typeof bridge !== 'string' || !bridge) return false;
  let parsed;
  try {
    parsed = new URL(bridge, pageUrl(viewRef));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) return false;
  if (!force && recentBridge(viewRef)) return false;
  const store = bridgeStore(viewRef);
  let state = '';
  try {
    const bytes = new Uint8Array(32);
    (scope.crypto || globalThis.crypto).getRandomValues(bytes);
    state = btoa(String.fromCharCode.apply(null, Array.from(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch {
    return false;
  }
  try {
    const here = `${scope.location.pathname}${scope.location.hash && !scope.location.hash.startsWith('#c2c_auth=') ? scope.location.hash : ''}`;
    if (!store) return false;
    store.setItem(BRIDGE_ROUTE_KEY, here || '/');
    store.setItem(BRIDGE_STATE_KEY, state);
    store.setItem(BRIDGE_MARK, String(Date.now())); // determinism-allow: runtime browser clock read; Date.now is not evaluated while generating files
  } catch {
    // storage refused: the fragment's state check will refuse the return — do not leave
    return false;
  }
  const target = `${parsed.origin}${parsed.pathname}?state=${state}`;
  const location = scope.location;
  try {
    if (location && typeof location.assign === 'function') location.assign(target);
    else if (location) location.href = target;
    else return false;
    return true;
  } catch {
    return false;
  }
}

/** True when the tab holds a bridge token (from intake or an earlier trip). */
export function hasBridgeToken(viewRef) {
  intakeBridgeFragment(viewRef);
  return storedBridgeToken(viewRef) !== '';
}

/**
 * Sign the tab out of the bridge session: every c2c.bridge.* key is dropped
 * and the tab leaves for the bridge's signout action, which ends the
 * function-origin session and returns to the Slate origin. The stored token
 * is cleared first, so a navigation that never completes still cannot replay
 * it. Returns false — navigating nowhere — when no web bridge is configured.
 */
export function bridgeSignOut(viewRef) {
  const scope = bridgeScope(viewRef);
  const bridge = scope.C2C_AUTH_BRIDGE;
  if (typeof bridge !== 'string' || !bridge) return false;
  let parsed;
  try {
    parsed = new URL(bridge, pageUrl(viewRef));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) return false;
  try {
    const store = bridgeStore(viewRef);
    if (store) for (const key of [BRIDGE_TOKEN_KEY, BRIDGE_STATE_KEY, BRIDGE_ROUTE_KEY, BRIDGE_MARK]) store.removeItem(key);
  } catch {
    // storage refused: the sign-out trip still happens
  }
  const location = scope.location;
  try {
    const target = `${parsed.origin}${parsed.pathname}?action=signout`;
    if (location && typeof location.assign === 'function') location.assign(target);
    else if (location) location.href = target;
    else return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Shown when a current-user or token call never answers. Step 3 is the
 * customer's "Sign in once" setup step (packages/deploy/src/customer-steps.ts).
 */
const AUTH_STALL_MESSAGE =
  'Sign-in did not complete. Reload the page; if it keeps happening, the app administrator must finish setup step 3, "Sign in once: sign in to the deployed app once".';
/** Default bound on auth/current-user/token calls. C2C_AUTH_TIMEOUT_MS overrides it, capped at 15s. */
const AUTH_TIMEOUT_DEFAULT_MS = 10000;
const AUTH_TIMEOUT_CAP_MS = 15000;
/** Slate serves no /baas: these exchanges stay pending forever unless aborted. */
const AUTH_EXCHANGE = /\/project-user\/(?:current|token)(?:[/?#]|$)|\/authentication\/(?:token|current)(?:[/?#]|$)/i;

const authInflight = new WeakMap();
const authStallFlag = new WeakMap();
const wrappedAuthFetches = new WeakSet();
/** In-flight current-user and token fetches. The deadline aborts these in the same turn it gives up. */
const authFetchControllers = new WeakMap();

function rememberAuthFetch(scope, controller) {
  if (!scope) return () => {};
  let set = authFetchControllers.get(scope);
  if (!set) {
    set = new Set();
    authFetchControllers.set(scope, set);
  }
  set.add(controller);
  return () => {
    set.delete(controller);
  };
}

function abortAuthFetches(scope) {
  const set = scope && authFetchControllers.get(scope);
  if (!set) return;
  for (const controller of set) {
    try {
      controller.abort();
    } catch {
      /* already aborted */
    }
  }
}

function authTimeoutMs(scope) {
  const configured = scope && typeof scope.C2C_AUTH_TIMEOUT_MS === 'number' && Number.isFinite(scope.C2C_AUTH_TIMEOUT_MS) && scope.C2C_AUTH_TIMEOUT_MS >= 0
    ? scope.C2C_AUTH_TIMEOUT_MS
    : AUTH_TIMEOUT_DEFAULT_MS;
  return Math.min(configured, AUTH_TIMEOUT_CAP_MS);
}

function authTimeoutError() {
  const error = new Error(AUTH_STALL_MESSAGE);
  error.name = 'AuthTimeoutError';
  return error;
}

function isAuthTimeout(error) {
  return !!(error && (error.name === 'AuthTimeoutError' || (error.message && error.message === AUTH_STALL_MESSAGE)));
}

function authInflightCount(scope) {
  return scope ? authInflight.get(scope) || 0 : 0;
}

function markAuthStall(scope) {
  if (scope) authStallFlag.set(scope, true);
}

function clearAuthStall(scope) {
  if (scope) authStallFlag.delete(scope);
}

function authStalled(scope) {
  return !!(scope && authStallFlag.get(scope) === true);
}

/** A minified SDK throw is a single letter (live console: "t"). Log a sentence instead. */
function logAuthFailure(scope, error, what) {
  const raw = error && typeof error === 'object' && typeof error.message === 'string' ? error.message : error == null ? '' : String(error);
  const detail = !raw || raw.length <= 1 ? `${what} did not answer` : raw;
  const line = detail === AUTH_STALL_MESSAGE ? AUTH_STALL_MESSAGE : `Sign-in did not complete: ${detail}`;
  const sink = (scope && scope.console) || (typeof console !== 'undefined' ? console : null);
  if (sink && typeof sink.error === 'function') sink.error(line);
}

function timerFns(scope) {
  return {
    set: (scope && scope.setTimeout) || setTimeout,
    clear: (scope && scope.clearTimeout) || clearTimeout,
  };
}

/** Race `work` against the auth budget and abort `controller` when the budget expires. */
function withAuthDeadline(scope, work, controller) {
  const ms = authTimeoutMs(scope);
  const timers = timerFns(scope);
  let timer = 0;
  let settled = false;
  const timeout = new Promise((_, reject) => {
    timer = timers.set(() => {
      if (settled) return;
      // Abort hung auth fetches before rejecting. Their own timer is registered
      // later with the same delay, and Node 20 can paint the stall first.
      abortAuthFetches(scope);
      try {
        if (controller) controller.abort();
      } catch {
        /* already aborted */
      }
      reject(authTimeoutError());
    }, ms);
  });
  const task = Promise.resolve().then(work);
  task.catch(() => {});
  timeout.catch(() => {});
  return Promise.race([task, timeout]).finally(() => {
    settled = true;
    timers.clear(timer);
  });
}

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input.url === 'string') return input.url;
  return '';
}

/**
 * Abort current-user and token fetches that never answer. Other requests,
 * including a 401 from a live auth host, are left alone.
 */
function bindAuthFetch(scope) {
  const view = scope || globalThis;
  const current = view && view.fetch;
  if (typeof current !== 'function' || wrappedAuthFetches.has(current)) return;
  const native = current;
  const wrapped = function authBoundFetch(input, init) {
    const url = requestUrl(input);
    if (!AUTH_EXCHANGE.test(url)) return native.call(view, input, init);
    const controller = new AbortController();
    const forgetFetch = rememberAuthFetch(view, controller);
    const outer = init && init.signal;
    if (outer && typeof outer.aborted === 'boolean') {
      if (outer.aborted) controller.abort();
      else if (typeof outer.addEventListener === 'function') outer.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const nextInit = { ...(init || {}), signal: controller.signal };
    authInflight.set(view, authInflightCount(view) + 1);
    const timers = timerFns(view);
    let timer = 0;
    let timedOut = false;
    const timeout = new Promise((_, reject) => {
      timer = timers.set(() => {
        timedOut = true;
        try {
          controller.abort();
        } catch {
          /* already aborted */
        }
        reject(authTimeoutError());
      }, authTimeoutMs(view));
    });
    const task = Promise.resolve().then(() => native.call(view, input, nextInit));
    task.catch(() => {});
    timeout.catch(() => {});
    return Promise.race([task, timeout])
      .catch((error) => {
        markAuthStall(view);
        logAuthFailure(view, timedOut ? authTimeoutError() : error, 'the current-user call');
        throw timedOut || isAuthTimeout(error) ? authTimeoutError() : error;
      })
      .finally(() => {
        forgetFetch();
        timers.clear(timer);
        authInflight.set(view, Math.max(0, authInflightCount(view) - 1));
      });
  };
  wrappedAuthFetches.add(wrapped);
  try {
    view.fetch = wrapped;
  } catch {
    /* fetch is sealed; the SDK-call deadline still applies */
  }
}

function watchAuthCall(scope, run) {
  bindAuthFetch(scope);
  const controller = new AbortController();
  return withAuthDeadline(scope, run, controller).catch((error) => {
    const fetchStall = authStalled(scope) || authInflightCount(scope) > 0;
    const minified = !!(error && typeof error.message === 'string' && error.message.length === 1);
    if (fetchStall || minified) {
      markAuthStall(scope);
      logAuthFailure(scope, error, 'the current-user call');
      throw authTimeoutError();
    }
    if (isAuthTimeout(error)) {
      logAuthFailure(scope, error, 'the current-user call');
      throw error;
    }
    throw error;
  });
}

async function authToken(viewRef) {
  const scope = viewRef || globalThis;
  intakeBridgeFragment(scope);
  if (bridgeConfigured(scope)) return storedBridgeToken(scope);
  const auth = scope && scope.catalyst && scope.catalyst.auth;
  if (!auth || typeof auth.generateAuthToken !== 'function') return '';
  // The SDK token chain is best-effort: on a host where the SDK's auth
  // endpoints are not served (a Slate domain, where /baas stays pending),
  // generateAuthToken can hang every API call. Bound the wait. A current-user
  // fetch that does not settle is remembered so sign-in and the smoke page
  // can stop; a hanging SDK method that never called the network still lets
  // the request go out without a token.
  try {
    const token = await watchAuthCall(scope, async () => {
      // generateAuthToken needs a session; isUserAuthenticated fails fast without one.
      if (typeof auth.isUserAuthenticated === 'function') await auth.isUserAuthenticated();
      const result = await auth.generateAuthToken();
      return result && result.access_token;
    });
    return typeof token === 'string' ? token : '';
  } catch {
    return '';
  }
}

/** A bigint (a toLong id) is written as its digit string. Same as packages/shims/src/ids.ts jsonReplacer. */
function jsonReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

export async function apiCall(call, viewRef, endpoint, init) {
  // Resolve and check the target before the token is even requested: a
  // refused endpoint throws here and no authorization header is attached.
  const url = apiUrl(endpoint, viewRef);
  const base = apiBase(viewRef);
  const token = await authToken(viewRef);
  if (!base && !token) return call(url, init);
  const headers = { ...((init && init.headers) || {}) };
  // Catalyst Web SDK v4.6.1+: the raw token, no prefix.
  if (token) headers.authorization = token;
  // Bridge mode sends no cookies at all: the Authorization header is the only
  // authority, so a cross-site form cannot ride an ambient session.
  const res = await call(url, { ...init, headers, credentials: bridgeConfigured(viewRef) ? 'omit' : 'include' });
  // A refused (or absent) bridge token is dropped and the tab takes one bridge
  // round trip (loop-guarded); a refused trip keeps the 401 for the caller.
  if (res && res.status === 401 && bridgeConfigured(viewRef)) {
    forgetBridgeToken(viewRef);
    bridgeRedirect(viewRef);
  }
  return res;
}

/** Apply one field patch to at most 25 selected rows through the ordinary edit endpoint. Each request independently runs server grants and validation workflows. */
export async function applyBulkEdit(viewRef, form, rowIds, patch) {
  const ids = Array.isArray(rowIds) ? rowIds.map(String) : [];
  if (!ids.length || ids.length > 25) throw new Error('Select between 1 and 25 rows.');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length !== 1) throw new Error('Choose one field to edit.');
  const endpoint = form && (form.editSubmitEndpoint || form.submitEndpoint);
  const call = (viewRef && viewRef.fetch) || globalThis.fetch;
  if (!endpoint || typeof call !== 'function') throw new Error('The edit endpoint is unavailable.');
  const results = [];
  for (const rowId of ids) {
    try {
      const res = await apiCall(call, viewRef, endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ROWID: rowId, record: patch }, jsonReplacer),
      });
      if (!res || res.ok === false) {
        const body = await readJson(res);
        results.push({ rowId, ok: false, error: body && typeof body.error === 'string' ? body.error : `HTTP ${res ? res.status : 'no response'}` });
      } else results.push({ rowId, ok: true });
    } catch (error) {
      results.push({ rowId, ok: false, error: error && typeof error.message === 'string' ? error.message : 'request failed' });
    }
  }
  return results;
}

/** Key spellings a generated index access may never touch: they reach the shared prototype. */
const UNSAFE_INDEX_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Shared objects a generated write may never land on (same rule as the server shim). */
function clientSharedTarget(value) {
  return value === Object.prototype || value === Function.prototype || typeof value === 'function';
}

/** Generated `obj[key]` read: own keys only — same as indexGet in packages/shims/src/runtime.ts. */
function clientIndexGet(obj, key) {
  if (obj == null || typeof obj === 'function') return undefined;
  const k = String(key);
  if (UNSAFE_INDEX_KEYS.has(k)) return undefined;
  const boxed = Object(obj);
  const got = Object.prototype.hasOwnProperty.call(boxed, k) ? boxed[k] : undefined;
  return clientSharedTarget(got) ? undefined : got;
}

/** Generated `obj[key] = v`: refuses unsafe names and shared-prototype targets — same as indexSet in packages/shims/src/runtime.ts. */
function clientIndexSet(obj, key, value) {
  if (obj == null || (typeof obj !== 'object' && typeof obj !== 'function')) return value;
  if (clientSharedTarget(obj)) return value;
  const k = String(key);
  if (UNSAFE_INDEX_KEYS.has(k)) return value;
  obj[k] = value;
  return value;
}

/** `path` walk for input/record set: own keys only, no unsafe names, no shared-prototype targets. Returns whether the write landed. */
function clientSetPath(root, parts, value) {
  if (!parts.length || parts.some((p) => UNSAFE_INDEX_KEYS.has(String(p)))) return false;
  if (clientSharedTarget(root)) return false;
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = String(parts[i]);
    const next = Object.prototype.hasOwnProperty.call(cur, k) ? cur[k] : undefined;
    if (next == null || typeof next !== 'object') {
      const created = {};
      cur[k] = created;
      cur = created;
    } else {
      if (clientSharedTarget(next)) return false;
      cur = next;
    }
  }
  if (clientSharedTarget(cur)) return false;
  cur[String(parts[parts.length - 1])] = value;
  return true;
}

/** Per-element round trips in one handler run (LIMITS.clientElementRoundTrips in packages/shims). */
const CLIENT_ELEMENT_ROUND_TRIPS = 100;
const CLIENT_BLOCKED = 'Prefetch is stale or failed; client action blocked.';

/**
 * `zoho.<env>` in generated client code reads the prefetch slot of the same
 * name (`slots["zoho.<env>"]` in the handler's prefetch body). A missing slot
 * means the handler ran without its generated prefetch, so the run is blocked
 * like any other stale prefetch, not answered with a guessed value.
 */
function identitySlot(ctx, name) {
  const key = `zoho.${name}`;
  const slots = ctx && ctx.slots;
  if (!slots || typeof slots !== 'object' || !Object.prototype.hasOwnProperty.call(slots, key)) throw clientBlocked(null);
  return slots[key];
}

/** Creator system column → keys a row may already use. Same table as SYSTEM_FIELD_KEYS in packages/shims/src/runtime.ts. */
const CLIENT_SYSTEM_FIELD_KEYS = [
  { name: 'Added_User', keys: ['Added_User', 'added_user'] },
  { name: 'Modified_User', keys: ['Modified_User', 'modified_user'] },
  { name: 'Added_Time', keys: ['Added_Time', 'CREATEDTIME', 'createdtime'] },
  { name: 'Modified_Time', keys: ['Modified_Time', 'MODIFIEDTIME', 'modifiedtime'] },
];

/** First present system-column key wins, like systemValue in packages/shims/src/runtime.ts. */
function clientSystemValue(row, name) {
  const values = row && typeof row === 'object' && '__row' in row ? row.values : row;
  if (!values || typeof values !== 'object') return undefined;
  const spec = CLIENT_SYSTEM_FIELD_KEYS.find((item) => item.name.toLowerCase() === String(name).toLowerCase());
  if (!spec) return undefined;
  for (const key of spec.keys) {
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
  }
  return undefined;
}

/** The error that makes a generated handler discard its queued actions. */
function clientBlocked(body) {
  const message = body && typeof body.message === 'string' ? body.message : body && typeof body.error === 'string' ? body.error : CLIENT_BLOCKED;
  return Object.assign(new Error(message), { c2cElementBlocked: true });
}

/** The generated call route for one read-only `thisapp` callee (clientCallPath in packages/shims/src/runtime.ts). */
function clientCallRoute(path) {
  const segment = String(path)
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `/functions/${segment || 'handler'}/call`;
}

export function browserShim(fetchImpl) {
  return browserShimProxy(browserShimSurface(fetchImpl));
}

/**
 * Every name the browser shim implements, in one table: the callables are
 * its function entries and the namespaces its object entries (`list` is
 * both; its methods are clientListMethods). packages/deluge/src/client-shim.ts
 * lists exactly these names, which browser-shim-list.test checks both ways.
 */
export function browserShimSurface(fetchImpl) {
  const call = fetchImpl || globalThis.fetch;
  let seq = 0;
  /** Row objects handed out by `subform.currentRow`, back to their ctx position. */
  const rowRefs = new WeakMap();
  const client = {
    touch(ctx) {
      seq += 1;
      ctx.formNonce = `${Date.now()}-${seq}`; // determinism-allow: runtime-only browser nonce; Date.now is not evaluated while generating files
    },
    async prefetch(ctx, path) {
      if (typeof call !== 'function') return { ok: false, message: 'prefetch unavailable' };
      try {
        const res = await apiCall(call, globalThis, path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ record: ctx.record || {}, nonce: ctx.formNonce, ...(ctx.subformRow ? { subformRow: ctx.subformRow } : {}), ...(Array.isArray(ctx.args) ? { args: ctx.args } : {}) }, jsonReplacer),
        });
        if (!res.ok) return { ok: false, message: `prefetch ${res.status}` };
        const body = await responseJson(res);
        return { ok: body.ok !== false, slots: body.slots || {}, nonce: body.nonce, message: body.message };
      } catch {
        return { ok: false, message: 'prefetch failed' };
      }
    },
    /**
     * One deferred slot's rows: the client sends the range bounds it
     * evaluated. A stale nonce is retried once, like the prefetch snapshot.
     */
    async rows(ctx, slot, from, to) {
      if (typeof call !== 'function') return { ok: false, message: 'prefetch unavailable' };
      const path = typeof ctx.prefetchPath === 'string' ? ctx.prefetchPath : '';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const res = await apiCall(call, globalThis, path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ record: ctx.record || {}, nonce: ctx.formNonce, slot, range: { from, to }, ...(ctx.subformRow ? { subformRow: ctx.subformRow } : {}), ...(Array.isArray(ctx.args) ? { args: ctx.args } : {}) }, jsonReplacer),
          });
          if (!res.ok) return { ok: false, rows: [], message: `prefetch ${res.status}` };
          const body = await responseJson(res);
          const rows = body && body.slots && Array.isArray(body.slots[slot]) ? body.slots[slot] : null;
          const stale = ctx.formNonce && body.nonce && body.nonce !== ctx.formNonce;
          if (body.ok === false || rows === null) return { ok: false, rows: [], message: body.message || 'prefetch failed' };
          if (!stale) return { ok: true, rows, nonce: body.nonce, retried: attempt > 0 };
        } catch {
          return { ok: false, rows: [], message: 'prefetch failed' };
        }
      }
      return { ok: false, rows: [], retried: true, message: 'prefetch is stale' };
    },
    /**
     * One read-only `thisapp` call on the function's generated call route
     * (clientCallPath in packages/shims/src/runtime.ts). A refused, stale, or
     * failed call throws `c2cElementBlocked`: the handler discards the actions
     * it queued instead of deciding on an unproven value.
     */
    async call(ctx, path, args) {
      if (!ctx.formNonce) client.touch(ctx);
      const nonce = ctx.formNonce;
      const body = await postJson(clientCallRoute(path), { nonce, args: Array.isArray(args) ? args : [] });
      if (!body || body.ok !== true || typeof body.error === 'string' || body.nonce !== nonce || ctx.formNonce !== nonce) throw clientBlocked(body);
      return body.value;
    },
    /**
     * One loop element's slot from the handler's prefetch endpoint, which
     * evaluates the slot for `{ name, value }` only. Same refusals as the
     * server runtime's client.element: over the round-trip cap, no prefetch
     * path, a refused reply, a missing slot, or a dry-run placeholder.
     */
    async element(ctx, name, value, slot) {
      const used = (ctx.elementCalls || 0) + 1;
      ctx.elementCalls = used;
      if (used > CLIENT_ELEMENT_ROUND_TRIPS || typeof ctx.prefetchPath !== 'string') throw clientBlocked(null);
      const nonce = ctx.formNonce;
      const body = await postJson(ctx.prefetchPath, {
        record: ctx.record || {},
        nonce,
        element: { name, value },
        ...(ctx.subformRow ? { subformRow: ctx.subformRow } : {}),
        ...(Array.isArray(ctx.args) ? { args: ctx.args } : {}),
      });
      const slots = body && body.slots;
      if (!body || body.ok === false || typeof body.error === 'string' || body.nonce !== nonce || ctx.formNonce !== nonce || !slots || typeof slots !== 'object' || Array.isArray(slots)) throw clientBlocked(body);
      if (!Object.prototype.hasOwnProperty.call(slots, slot)) throw clientBlocked(null);
      const got = slots[slot];
      if (got !== null && typeof got === 'object' && (got.ok === false || got.dryRun === true || got.performed === false)) throw clientBlocked(null);
      return got;
    },
    /**
     * One merged form-event server half: POSTs ctx.runPath
     * (`/forms/<form>/<kind>`) with the caller's record and ctx.runEvent
     * naming the single workflow script the route may run, resolved through
     * the module's scriptEvents map into ctx.onlyScript. A refused or failed
     * run throws `c2cElementBlocked` like client.call: the handler discards
     * the actions it already queued.
     */
    async run(ctx) {
      if (!ctx || typeof ctx.runPath !== 'string' || !ctx.runPath) throw clientBlocked(null);
      let body = null;
      try {
        const res = await apiCall(call, globalThis, ctx.runPath, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            {
              record: ctx.record || {},
              nonce: ctx.formNonce,
              ...(typeof ctx.runEvent === 'string' ? { runEvent: ctx.runEvent } : {}),
              ...(ctx.subformRow ? { subformRow: ctx.subformRow } : {}),
              ...(Array.isArray(ctx.args) ? { args: ctx.args } : {}),
            },
            jsonReplacer,
          ),
        });
        body = await responseJson(res);
        if (!res.ok) throw clientBlocked(body);
      } catch (err) {
        if (err && err.c2cElementBlocked === true) throw err;
        throw clientBlocked(body);
      }
      if (body && typeof body.error === 'string') throw clientBlocked(body);
      return body;
    },
  };
  /** POST JSON and read the reply, or null when the request failed. */
  async function postJson(path, payload) {
    if (typeof call !== 'function') return null;
    try {
      const res = await apiCall(call, globalThis, path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload, jsonReplacer),
      });
      if (!res.ok) return null;
      return await responseJson(res);
    } catch {
      return null;
    }
  }
  return {
    client,
    get: clientIndexGet,
    set: clientIndexSet,
    todo: async () => undefined,
    each: (_ctx, value) => clientEach(value),
    list: clientListApi(),
    map: () => ({}),
    ...clientValueTests,
    get decimal() {
      return clientDecimal();
    },
    compare: { eq: clientCompareEq, ne: (a, b) => !clientCompareEq(a, b) },
    date: withStubFallback({
      rel: (a, b, op) => clientDateRel(a, b, op),
      text: (value) => clientDateText(value),
      format: (value, pattern) => clientFormat(value, pattern),
      // A Deluge date literal in source emits shim.date.parse: the same
      // parseLiteral rules as the server — a bad literal throws 'UnParsable
      // date', and range fields are not checked.
      parse(value) {
        const parts = typeof value === 'string' ? parseClientDate(value) : undefined;
        if (!parts) throw clientUnparsableDate();
        return clientDateOf(parts);
      },
      // Calendar arithmetic, same rules as the server date api: blank in is
      // null out, a bad literal throws 'UnParsable date', and the day carry
      // keeps the clock fields.
      addDay(value, n) {
        const d = clientAsDate(value);
        return d ? clientAddDays(d, Number(n)) : null;
      },
      addWeek(value, n) {
        const d = clientAsDate(value);
        return d ? clientAddDays(d, Number(n) * 7) : null;
      },
      addMonth(value, n) {
        const d = clientAsDate(value);
        return d ? clientAddMonths(d, Number(n)) : null;
      },
      addYear(value, n) {
        const d = clientAsDate(value);
        return d ? clientAddMonths(d, Number(n) * 12) : null;
      },
      addHour(value, n) {
        const d = clientAsDate(value);
        return d ? clientShiftHours(d, Number(n)) : null;
      },
      addMinutes(value, n) {
        const d = clientAsDate(value);
        return d ? clientShiftMinutes(d, Number(n)) : null;
      },
      addSeconds(value, n) {
        const d = clientAsDate(value);
        return d ? clientShiftTime(d, Number(n)) : null;
      },
      subDay(value, n) {
        const d = clientAsDate(value);
        return d ? clientAddDays(d, -Number(n)) : null;
      },
      subWeek(value, n) {
        const d = clientAsDate(value);
        return d ? clientAddDays(d, -Number(n) * 7) : null;
      },
      subMonth(value, n) {
        const d = clientAsDate(value);
        return d ? clientAddMonths(d, -Number(n)) : null;
      },
      subYear(value, n) {
        const d = clientAsDate(value);
        return d ? clientAddMonths(d, -Number(n) * 12) : null;
      },
      subHour(value, n) {
        const d = clientAsDate(value);
        return d ? clientShiftHours(d, -Number(n)) : null;
      },
      subMinutes(value, n) {
        const d = clientAsDate(value);
        return d ? clientShiftMinutes(d, -Number(n)) : null;
      },
      subSeconds(value, n) {
        const d = clientAsDate(value);
        return d ? clientShiftTime(d, -Number(n)) : null;
      },
      toDate(value) {
        const d = clientAsDate(value);
        return d ? clientDate(d.y, d.m, d.d, 0, 0, 0) : null;
      },
      toTime(value) {
        const d = clientAsDate(value);
        return d ? clientDateOf(d) : null;
      },
      // Week starts on Sunday, like dates.startOfWeek; the result is midnight
      // of that day's wall fields (already the app zone — no zone arg needed).
      toStartOfWeek(value) {
        const d = clientAsDate(value);
        if (!d) return null;
        const back = clientAddDays(d, -new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay());
        return clientDate(back.y, back.m, back.d, 0, 0, 0);
      },
      // First of the month at midnight on the wall fields, like dates.startOfMonth.
      toStartOfMonth(value) {
        const d = clientAsDate(value);
        return d ? clientDate(d.y, d.m, 1, 0, 0, 0) : null;
      },
      getYear(value) {
        const d = clientAsDate(value);
        return d ? d.y : null;
      },
      getMonth(value) {
        const d = clientAsDate(value);
        return d ? d.m : null;
      },
      getDay(value) {
        const d = clientAsDate(value);
        return d ? d.d : null;
      },
      getHour(value) {
        const d = clientAsDate(value);
        return d ? (d.hh ?? 0) : null;
      },
      getMinutes(value) {
        const d = clientAsDate(value);
        return d ? (d.mm ?? 0) : null;
      },
      getSeconds(value) {
        const d = clientAsDate(value);
        return d ? (d.ss ?? 0) : null;
      },
      getDayOfWeek(value) {
        const d = clientAsDate(value);
        return d ? new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay() + 1 : null;
      },
      getDayOfYear(value) {
        const d = clientAsDate(value);
        return d ? clientEpochDay(d) - clientEpochDay({ y: d.y, m: 1, d: 1 }) + 1 : null;
      },
      diffDays(a, b) {
        const da = clientAsDate(a);
        const db = clientAsDate(b);
        if (!da || !db) return null;
        const days = clientEpochDay(da) - clientEpochDay(db);
        const ta = ((da.hh || 0) * 60 + (da.mm || 0)) * 60000 + (da.ss || 0) * 1000;
        const tb = ((db.hh || 0) * 60 + (db.mm || 0)) * 60000 + (db.ss || 0) * 1000;
        return days * 86400000 + (ta - tb);
      },
      // Between-counts: whole calendar days first, then the kind's divisor,
      // truncated toward zero — same rules as days360Count, daysBetweenCount,
      // monthsBetweenCount and yearsBetweenCount in packages/shims/src/date.ts.
      days360(a, b) {
        const [da, db] = clientDatePair(a, b);
        return clientEpochDay(db) - clientEpochDay(da);
      },
      daysBetween(a, b) {
        const [da, db] = clientDatePair(a, b);
        return clientEpochDay(db) - clientEpochDay(da);
      },
      monthsBetween(a, b) {
        const [da, db] = clientDatePair(a, b);
        return Math.trunc((clientEpochDay(db) - clientEpochDay(da)) / 30);
      },
      yearsBetween(a, b) {
        const [da, db] = clientDatePair(a, b);
        return Math.trunc((clientEpochDay(db) - clientEpochDay(da)) / 365);
      },
    }),
    convert: withStubFallback({
      toLong(value, ctx) {
        return clientToLong(value, ctx);
      },
      toNumber(value, ctx) {
        return clientToLong(value, ctx, 'toNumber');
      },
      // Same cases as convert.toList: arrays copy, text splits on the
      // separator, empty parts read as null, anything else is refused.
      toList(value, ctx, separator, ...extra) {
        if (extra.length) throw clientConversionError('toList() takes at most one argument');
        if (Array.isArray(value)) {
          if (separator !== undefined) throw clientConversionError('toList: separator is for text');
          return value.slice();
        }
        if (typeof value !== 'string') throw clientConversionError('toList: null or source is not text');
        const token = (part) => (part === '' ? null : part);
        if (separator === undefined || separator === null) return [token(value)];
        const sep = String(separator);
        if (sep === '' || !value.includes(sep)) return [token(value)];
        return value.split(sep).map(token);
      },
      // Same cases as convert.toMap: a plain object copies, strict JSON
      // parses losslessly, Deluge's {key:value} text parses loosely, anything
      // else refuses 'Invalid JSON Format String'.
      toMap(value, ctx, ...extra) {
        if (extra.length) throw clientConversionError('toMap() takes no arguments');
        if (clientIsPlainMap(value)) return { ...value };
        if (typeof value !== 'string') throw clientConversionError(CLIENT_MAP_BAD);
        if (value.length > CLIENT_MAX_MAP_TEXT) throw clientConversionError('toMap: text exceeds 5 MB');
        const text = value.trim();
        if (!text) throw clientConversionError(CLIENT_MAP_BAD);
        if (text.startsWith('{') && text.endsWith('}')) {
          try {
            const parsed = clientParseJsonLossless(text);
            if (clientIsPlainMap(parsed)) return parsed;
          } catch {
            /* Deluge's {key:value} form is not JSON. */
          }
          return clientLooseMap(text);
        }
        throw clientConversionError(CLIENT_MAP_BAD);
      },
    }),
    math: withStubFallback({
      // Same rules as number.ts round: a bigint is unchanged, a non-finite
      // input is returned as is, halves round away from zero.
      round(value, places = 0) {
        if (typeof value === 'bigint') return value;
        const n = typeof value === 'number' ? value : Number(value);
        const p = Number(places);
        if (!Number.isFinite(n)) return n;
        const f = 10 ** (Number.isFinite(p) ? p : 0);
        const x = n * f;
        if (x < 0) return -Math.round(-x) / f;
        return Math.round(x) / f;
      },
      // Same edges as number.ts sqrt: a negative or blank is null, a bigint
      // perfect square keeps its exact root, an exactness loss refuses.
      sqrt(value) {
        if (typeof value === 'bigint') {
          if (value < 0n) return null;
          const root = clientBigintSqrt(value);
          if (root * root === value) return root > CLIENT_MAX_SAFE ? root : Number(root);
          if (value > CLIENT_MAX_SAFE || value < -CLIENT_MAX_SAFE) {
            throw clientConversionError('toLong: magnitude exceeds 2^53; refusing to lose precision');
          }
          return Math.sqrt(Number(value));
        }
        const n = clientRealArg('sqrt', value);
        return n === null || n < 0 ? null : Math.sqrt(n);
      },
    }),
    string: withStubFallback({
      // ASCII letters, the same set both runtimes use (text.ts).
      getAlphaNumeric(value) {
        return value == null ? null : clientEmptyToNull(String(value).replace(/[^A-Za-z0-9]/g, ''));
      },
      removeAllAlpha(value) {
        return value == null ? null : clientEmptyToNull(String(value).replace(/[A-Za-z]/g, ''));
      },
      // trim/getPrefix/getSuffix, the same blank-in null-out rules as text.ts.
      trim(value) {
        return value == null ? null : clientEmptyToNull(String(value).trim());
      },
      getPrefix(value, sep) {
        const s = value == null ? '' : String(value);
        const needle = sep == null ? '' : String(sep);
        if (s === '' || needle === '') return null;
        const at = s.indexOf(needle);
        return at < 0 ? null : clientEmptyToNull(s.slice(0, at));
      },
      getSuffix(value, sep) {
        const s = value == null ? '' : String(value);
        const needle = sep == null ? '' : String(sep);
        if (s === '' || needle === '') return null;
        const at = s.indexOf(needle);
        return at < 0 ? null : clientEmptyToNull(s.slice(at + needle.length));
      },
      // Locale-independent default casing, like text.ts toUpperCase.
      toUpperCase(value) {
        return value == null ? null : clientEmptyToNull(String(value).toUpperCase());
      },
    }),
    old: {
      // The previous record the handler's ctx carries; the same path walk as input.get.
      get(ctx, ...path) {
        let cur = (ctx && ctx.old) || {};
        for (const part of path) {
          if (cur == null || typeof cur !== 'object') return undefined;
          cur = part === 'ID' && !Object.hasOwn(cur, 'ID') ? (cur.ROWID ?? cur.rowid) : clientIndexGet(cur, part);
        }
        return cur;
      },
    },
    record: (() => {
      // Rows are plain objects here, or a prefetched { __row, values } row.
      // A record collection (array) is its first record; an empty one is null (data-access__update-records).
      const valuesOf = (raw) => {
        const row = Array.isArray(raw) ? (raw.length ? raw[0] : null) : raw;
        return row && typeof row === 'object' && row.__row && row.values && typeof row.values === 'object' ? row.values : row;
      };
      return {
        // `Form.Subform()` row constructor: a row value, like a fetched
        // record, so record.set writes under `values`.
        bind(_ctx, values, form) {
          return { __row: true, form: form || '', values: { ...(values || {}) } };
        },
        get(row, ...path) {
          let cur = valuesOf(row);
          if (cur == null) return null;
          // `ID` is logical: a record's id reads as its ROWID (same rule as
          // getPath in packages/shims/src/runtime.ts).
          for (const part of path) {
            if (cur == null || typeof cur !== 'object') return undefined;
            cur = part === 'ID' && !Object.hasOwn(cur, 'ID') ? (cur.ROWID ?? cur.rowid) : clientIndexGet(cur, part);
          }
          return cur;
        },
        set(row, path, value) {
          const target = valuesOf(row);
          if (!target || typeof target !== 'object') return value;
          const parts = Array.isArray(path) ? path : [path];
          const wrote = clientSetPath(target, parts, value);
          // `row.Field = v` in a subform row event shows in that row's cell.
          const at = wrote ? rowRefs.get(target) : undefined;
          if (at && at.ctx.form && parts.length === 1) {
            writeFieldValue(at.ctx.form, `${at.field}.${parts[0]}`, value, at.index);
          }
          return value;
        },
        // A stored system column (Added_User and the same), like the server's record.system.
        system(row, name) {
          return clientSystemValue(row, name);
        },
      };
    })(),
    zoho: withStubFallback({
      // zoho.currentdate: the app-zone date with the time set to 00:00:00.
      currentDate(ctx) {
        const p = clientNow(ctx);
        return clientDate(p.y, p.m, p.d, 0, 0, 0);
      },
      currentTime(ctx) {
        const p = clientNow(ctx);
        return clientDate(p.y, p.m, p.d, p.hh, p.mm, p.ss);
      },
      // The identity constants are server-evaluated: the handler's prefetch
      // fills `slots["zoho.<name>"]` and the browser reads it. A handler whose
      // prefetch lacks the slot was not generated for the code it runs —
      // blocked, never guessed.
      adminUser(ctx) {
        return identitySlot(ctx, 'adminUser');
      },
      adminUserId(ctx) {
        return identitySlot(ctx, 'adminUserId');
      },
      appName(ctx) {
        return identitySlot(ctx, 'appName');
      },
      appUri(ctx) {
        return identitySlot(ctx, 'appUri');
      },
      loginUser(ctx) {
        return identitySlot(ctx, 'loginUser');
      },
      loginUserId(ctx) {
        return identitySlot(ctx, 'loginUserId');
      },
    }),
    subform: {
      // Deluge `row` in a subform event: ctx.subformRow { field, index } into ctx.record.
      currentRow(ctx, field) {
        const at = ctx && ctx.subformRow;
        if (!at || at.field !== field) return null;
        const rows = ctx.record && ctx.record[field];
        const row = Array.isArray(rows) ? rows[at.index] : undefined;
        const found = row && typeof row === 'object' && !Array.isArray(row) ? row : null;
        if (found && ctx) rowRefs.set(found, { ctx, field, index: at.index });
        return found;
      },
    },
    input: {
      root(ctx) {
        return ctx.record || {};
      },
      get(ctx, ...path) {
        let cur = ctx.record || {};
        for (const part of path) {
          if (cur == null || typeof cur !== 'object') return undefined;
          cur = part === 'ID' && !Object.hasOwn(cur, 'ID') ? (cur.ROWID ?? cur.rowid) : clientIndexGet(cur, part);
        }
        return cur;
      },
      set(ctx, path, value) {
        if (!ctx.record) ctx.record = {};
        const parts = Array.isArray(path) ? path : [path];
        const wrote = clientSetPath(ctx.record, parts, value);
        // `input.X = v` is Creator's set-value: the control on the open
        // form shows the script's value, not just ctx.record.
        const root = wrote ? ctx && ctx.form : undefined;
        if (root && parts.length) {
          if (parts.length === 1) writeFieldValue(root, parts[0], value);
          else if (parts.length >= 2) writeFieldValue(root, `${parts[0]}.${parts[parts.length - 1]}`, value);
        }
      },
    },
  };
}

/** A namespace whose other members answer with the catch-all stub. */
function withStubFallback(target) {
  return new Proxy(target, {
    get(obj, key) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
      return browserShimProxy(null);
    },
  });
}

/**
 * The `shim` client code sees: a surface name answers with its entry, and
 * anything else is a catch-all stub that answers every call with another
 * stub (the translator emits no such name into client code).
 */
function browserShimProxy(surface) {
  const target = function stubCall() {
    return browserShimProxy(surface);
  };
  return new Proxy(target, {
    get(_obj, prop) {
      if (prop === 'then') return (resolve) => resolve(undefined);
      if (surface && typeof prop === 'string' && Object.prototype.hasOwnProperty.call(surface, prop)) return surface[prop];
      return browserShimProxy(surface);
    },
    apply() {
      return browserShimProxy(surface);
    },
  });
}

export async function runHandler(handler, ctx) {
  if (!handler || !handler.module) return [];
  const mod = await import(handler.module);
  if (typeof mod.clientActions !== 'function') return [];
  const list = await mod.clientActions(ctx);
  return Array.isArray(list) ? list : [];
}

const FILE_WIDGETS = new Set(['file', 'image', 'audio', 'video', 'signature']);

function writableInput(field) {
  if (!field || field.readonly || field.status === 'todo') return false;
  if (field.widget === 'section' || field.widget === 'notes' || field.widget === 'unsupported') return false;
  return true;
}

/**
 * Wrap every integer literal outside a string that is not a safe integer in
 * quotes, so JSON.parse keeps a 19-digit Creator id or a 17-digit ROWID exact.
 * Same algorithm as packages/shims/src/ids.ts quoteUnsafeIntegers.
 * A fetch Response.json() would round them.
 */
function quoteUnsafeIntegers(text) {
  let out = '';
  let last = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const start = i;
      i += 1;
      while (i < text.length && /[0-9.eE+-]/.test(text[i])) i += 1;
      const token = text.slice(start, i);
      if (/^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token))) {
        out += `${text.slice(last, start)}"${token}"`;
        last = i;
      }
      continue;
    }
    i += 1;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** Response body as JSON, ids past 2^53 kept as digit strings. */
async function responseJson(res) {
  if (typeof res.text === 'function') return JSON.parse(quoteUnsafeIntegers(await res.text()));
  return res.json();
}

async function readJson(res) {
  if (!res || (typeof res.json !== 'function' && typeof res.text !== 'function')) return {};
  try {
    return await responseJson(res);
  } catch {
    return {};
  }
}

/** Lowercase hex SHA-256 of a Blob/File, or '' when the browser cannot hash it. */
async function sha256Hex(file) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle || !file || typeof file.arrayBuffer !== 'function') return '';
  const digest = new Uint8Array(await subtle.digest('SHA-256', await file.arrayBuffer()));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * File, image, audio, video, and signature fields submit `{ key }` from the
 * upload endpoint. The client does not JSON.stringify a File (that is `{}`).
 * Live: the endpoint also returns `upload`, a signed Stratus PUT; the bytes go
 * there with its Content-Type header before the record is submitted.
 */
export async function uploadReference(viewRef, field, file) {
  const endpoint = field && field.uploadEndpoint;
  const call = (viewRef && viewRef.fetch) || globalThis.fetch;
  if (!endpoint || typeof call !== 'function') throw new Error('upload endpoint missing');
  const contentType = (file && file.type) || 'application/octet-stream';
  const res = await apiCall(call, viewRef, endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: (file && file.name) || 'file', contentType, sha256: await sha256Hex(file) }),
  });
  const payload = await readJson(res);
  const reference = payload && payload.reference;
  const keys = reference && typeof reference === 'object' ? Object.keys(reference) : []; // determinism-allow: runtime-only upload check copied verbatim; a single key is compared and this is not evaluated while generating
  if (!res || res.ok === false || keys.length !== 1 || keys[0] !== 'key' || typeof reference.key !== 'string' || !reference.key) {
    throw new Error('upload did not return a file reference');
  }
  const upload = payload.upload;
  if (upload && typeof upload === 'object' && typeof upload.url === 'string' && upload.url) {
    let putTarget = null;
    try {
      putTarget = new URL(upload.url);
    } catch {
      putTarget = null;
    }
    const putLoopback = putTarget !== null && LOOPBACK_HOSTS.has(putTarget.hostname);
    if (!putTarget || (putTarget.protocol !== 'https:' && !(putTarget.protocol === 'http:' && putLoopback))) {
      throw new Error('the signed upload url is not an https target');
    }
    const put = await call(upload.url, { method: 'PUT', headers: { ...(upload.headers || {}) }, body: file });
    if (!put || put.ok === false) throw new Error('upload to storage failed');
  }
  return { key: reference.key };
}

/** A canvas data URL (`data:image/png;base64,…`) as PNG bytes, or null. */
function dataUrlBytes(value) {
  const match = /^data:([^;,]+);base64,(.*)$/.exec(value);
  if (!match || typeof atob !== 'function') return null;
  const text = atob(match[2]);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/**
 * Lookup options for a form select. The endpoint answers `{ rows, field }`
 * where each row carries the display value under `field`, keyed by ROWID.
 * The option value is the ROWID the submit sends back; the text is the
 * display value the report shows. Rows without a ROWID are not options.
 */
export async function loadLookupOptions(viewRef, endpoint, query) {
  const call = (viewRef && viewRef.fetch) || globalThis.fetch;
  if (!endpoint || typeof call !== 'function') throw new Error('lookup endpoint missing');
  const separator = endpoint.includes('?') ? '&' : '?';
  // A search runs on the server over the lookup's display field(s), scoped to
  // the records the caller may read; the endpoint takes at most 100 characters.
  const text = typeof query === 'string' ? query.trim().slice(0, 100) : '';
  const search = text ? `&q=${encodeURIComponent(text)}` : '';
  const res = await apiCall(call, viewRef, `${endpoint}${separator}page=0&pageSize=300${search}`, { method: 'GET', headers: { 'content-type': 'application/json' } });
  if (!res || res.ok === false) throw new Error(`lookup request failed (${res ? res.status : 'no response'})`);
  const body = await readJson(res);
  const rows = body && Array.isArray(body.rows) ? body.rows : [];
  const field = body && typeof body.field === 'string' ? body.field : '';
  const options = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || row.ROWID == null || row.ROWID === '') continue;
    const label = field && row[field] != null ? String(row[field]) : '';
    options.push({ value: String(row.ROWID), label });
  }
  return options;
}

/**
 * Fill a lookup `<select>` without losing a value the form already holds: a
 * chosen record the new options (a search) do not list keeps its option.
 */
export function fillLookupSelect(select, options) {
  const current = select.multiple
    ? [...select.options].filter((option) => option.selected).map((option) => option.value)
    : [select.value];
  const listed = new Set((options || []).map((option) => option.value));
  const kept = [...select.options].filter((option) => option.value !== '' && current.includes(option.value) && !listed.has(option.value));
  const blank = select.options && select.options[0] && select.options[0].value === '' ? select.options[0] : null;
  select.textContent = '';
  if (blank) select.appendChild(blank);
  for (const option of kept) select.appendChild(option);
  for (const option of options || []) {
    const el = select.ownerDocument ? select.ownerDocument.createElement('option') : document.createElement('option');
    el.value = option.value;
    el.textContent = option.label;
    if (current.includes(option.value)) el.selected = true;
    select.appendChild(el);
  }
}

/**
 * Fill every lookup select in the form. One endpoint failing (offline, denied)
 * leaves that select as rendered; it never blocks the rest of the form.
 */
export async function fillLookups(form, formEl, viewRef) {
  const selects = formEl && typeof formEl.querySelectorAll === 'function' ? formEl.querySelectorAll('select[data-lookup]') : [];
  for (const select of selects) {
    const endpoint = select.getAttribute && select.getAttribute('data-lookup');
    if (!endpoint) continue;
    try {
      fillLookupSelect(select, await loadLookupOptions(viewRef, endpoint));
    } catch {
      /* the select keeps its rendered options */
    }
    attachLookupSearch(select, endpoint, viewRef);
  }
}

/**
 * A search box before a lookup select: typing asks the endpoint for the
 * records whose display matches (after a short pause), so a record past the
 * first page is found by its name. An empty box reads the first page again.
 */
export function attachLookupSearch(select, endpoint, viewRef) {
  const doc = select && select.ownerDocument;
  if (!doc || !select.parentNode || select.getAttribute('data-lookup-searchable') === 'true') return null;
  select.setAttribute('data-lookup-searchable', 'true');
  const input = doc.createElement('input');
  input.type = 'search';
  input.className = 'c2c-lookup-search';
  input.setAttribute('data-lookup-search', select.getAttribute('name') || '');
  input.setAttribute('aria-label', `Search ${select.getAttribute('aria-label') || select.getAttribute('name') || 'records'}`);
  input.setAttribute('placeholder', 'Search');
  input.setAttribute('maxlength', '100');
  select.parentNode.insertBefore(input, select);
  const view = doc.defaultView || globalThis;
  let timer = null;
  let asked = 0;
  input.addEventListener('input', () => {
    if (timer) view.clearTimeout(timer);
    timer = view.setTimeout(() => {
      timer = null;
      const ask = ++asked;
      loadLookupOptions(viewRef, endpoint, input.value)
        .then((options) => {
          if (ask === asked) fillLookupSelect(select, options);
        })
        .catch(() => {});
    }, 250);
  });
  return input;
}

/** The document that owns the form. Its FormData and File are not this module's realm. */
function viewOf(node) {
  const doc = node && node.ownerDocument;
  return (doc && doc.defaultView) || globalThis;
}

/** Values the submit POST sends. Read-only fields are left out. File widgets are references, or omitted when empty. */
export async function submitRecord(formEl, form, upload) {
  const raw = readValues(formEl);
  const record = {};
  const FileCtor = viewOf(formEl).File || globalThis.File;
  for (const field of (form && form.fields) || []) {
    if (!writableInput(field)) continue;
    const value = raw[field.name];
    if (FILE_WIDGETS.has(field.widget)) {
      if (typeof FileCtor === 'function' && value instanceof FileCtor) {
        if (!value.size) continue;
        if (typeof upload !== 'function') throw new Error('upload endpoint missing');
        record[field.name] = await upload(field, value);
        continue;
      }
      if (field.widget === 'signature' && typeof value === 'string' && value.trim()) {
        if (typeof upload !== 'function') throw new Error('upload endpoint missing');
        const bytes = dataUrlBytes(value.trim());
        const file = typeof File !== 'undefined' ? new File([bytes || value], 'signature.png', { type: 'image/png' }) : { name: 'signature.png', type: 'image/png', size: value.length };
        record[field.name] = await upload(field, file);
      }
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(raw, field.name)) continue;
    // A blank typed cell is "no value", not "". The store rejects ""
    // for typed columns (400 INVALID_INPUT on date), so blank date, datetime,
    // time, number, decimal, percent and currency post null. Text-family
    // widgets keep "": Creator's empty text is the empty string, not null.
    const blankTyped =
      typeof value === 'string' &&
      value.trim() === '' &&
      (field.widget === 'number' ||
        field.widget === 'decimal' ||
        field.widget === 'percent' ||
        field.widget === 'currency' ||
        field.widget === 'date' ||
        field.widget === 'datetime' ||
        field.widget === 'time');
    let out = value;
    // The text control takes the app format (dd-MMM-yyyy); the store takes ISO.
    if (!blankTyped && field.widget === 'date' && typeof out === 'string' && !validDate(out.trim()) && clientDateValid(out.trim())) {
      const parts = parseClientDate(out.trim());
      out = `${parts.y}-${String(parts.m).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`;
    }
    // A whole number posts as a JS number: server scripts add and compare it
    // (input.Qty + rec.Stock), and "5" + 100 is "5100". Digits past 2^53 stay
    // text so none is lost; decimal, percent and currency stay exact text.
    if (!blankTyped && field.widget === 'number' && typeof out === 'string' && /^-?\d+$/.test(out.trim()) && Number.isSafeInteger(Number(out.trim()))) {
      out = Number(out.trim());
    }
    record[field.name] = blankTyped ? null : out;
  }
  return record;
}

function readValues(formEl) {
  const values = {};
  const FormDataCtor = viewOf(formEl).FormData || globalThis.FormData;
  const data = new FormDataCtor(formEl);

  // Identify which names are data-choice groups
  const dataChoiceNames = new Set();
  const dataChoiceBoxes = {};
  for (const box of formEl.querySelectorAll('input[type="checkbox"][data-choice]')) {
    if (!box.name) continue;
    dataChoiceNames.add(box.name);
    if (!dataChoiceBoxes[box.name]) {
      dataChoiceBoxes[box.name] = [];
    }
    dataChoiceBoxes[box.name].push(box);
  }

  // First pass: collect FormData values, but skip data-choice boxes
  for (const [key, value] of data.entries()) { // determinism-allow: runtime-only FormData walk in the browser; not executed while generating files
    if (dataChoiceNames.has(key)) continue;
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      const prev = values[key];
      values[key] = Array.isArray(prev) ? prev.concat(value) : [prev, value];
    } else values[key] = value;
  }

  // Second pass: build data-choice arrays from scratch
  for (const [name, boxes] of Object.entries(dataChoiceBoxes).sort()) {
    values[name] = [];
    for (const box of boxes) {
      if (box.checked) {
        values[name].push(box.value);
      }
    }
  }

  // Third pass: handle decision boxes (non-data-choice checkboxes)
  for (const box of formEl.querySelectorAll('input[type="checkbox"]')) {
    if (!box.name || box.hasAttribute('data-choice')) continue;
    values[box.name] = box.checked;
  }

  return values;
}

function showErrors(formEl, form, errors) {
  for (const field of form.fields || []) {
    const slot = formEl.querySelector(`[data-error-for="${CSS.escape(field.name)}"]`);
    if (slot) slot.textContent = errors[field.name] || '';
  }
}

// ---- hidden admin smoke page (#/admin/smoke) ----------------------------------
// Runs the plan deploy embeds as globalThis.C2C_SMOKE_PLAN through the same
// guarded endpoints the forms and reports use. The page speaks in statuses and
// counts — never tokens or record values — and cleanup deletes only rows that
// carry this run's marker (the server re-checks the tag before deleting).

function renderSmokeShell() {
  return `<section data-smoke><h2>Smoke run</h2><p data-smoke-state="pending">Checking access…</p><div data-smoke-code hidden><p>Paste this into your AI chat (Claude or any LLM):</p><p><code id="c2c-smoke-code" style="word-break:break-all"></code> <button type="button" data-smoke-copy-code>Copy</button></p></div><table hidden><thead><tr><th>Result</th></tr></thead><tbody data-smoke-steps></tbody></table><p data-smoke-copy hidden>Using the c2c CLI yourself? Save the block below as smoke-result.txt and run <code>c2c smoke &lt;source&gt; --result smoke-result.txt</code> (or paste it into <code>--result -</code>).</p><pre id="c2c-smoke-json" hidden></pre></section>`;
}

function smokeTag() {
  // determinism-allow: runtime-only run tag, like browserShim's formNonce — never evaluated while generating.
  return `s${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36)}`;
}

/** One row by ROWID through the lookup endpoint — <field> is read as the display column. */
async function smokeReadRow(api, step, field, rowId) {
  const endpoint = `/lookups/${encodeURIComponent(step.form)}/${encodeURIComponent(field || 'ROWID')}`;
  const res = await api(`${endpoint}?page=0&pageSize=300`, { method: 'GET', headers: { 'content-type': 'application/json' } });
  if (!res || res.ok === false) return null;
  const body = await readJson(res);
  const rows = body && Array.isArray(body.rows) ? body.rows : [];
  return rows.find((row) => row && String(row.ROWID) === String(rowId)) || null;
}

/**
 * Run one embedded smoke plan. Returns { ok, lines, json } where json is the
 * machine-readable block the page prints and `c2c smoke --in-browser` reads
 * back: version, counts, and per-step labels — never tokens or record values.
 */
export async function runSmokePlan(appModel, plan, view) {
  const call = (view && view.fetch) || globalThis.fetch;
  const api = (endpoint, init) => {
    // A plan endpoint is always app-relative — an absolute URL would carry
    // the session's auth token to another origin.
    if (typeof endpoint !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(endpoint)) return Promise.resolve(null);
    return apiCall(call, view, endpoint, init);
  };
  const tag = smokeTag();
  const lines = [];
  const rows = [];
  const created = new Map();
  const verified = new Set();
  const submitted = new Map();
  const updateSent = new Map();
  const uploaded = new Map();
  // Steps that made a real call — a run that exercised nothing is a failure,
  // never a pass.
  let exercised = 0;
  let uploadedUrl = '';
  let deleted = 0;
  let failed = false;
  const push = (label, detail, ok) => {
    const entry = { label: String(label || ''), ok: ok !== false, detail: String(detail || '') };
    rows.push(entry);
    lines.push(entry.detail ? `${entry.label}: ${entry.detail}` : entry.label);
  };
  // Same fill rules as recordFor() in the CLI runner: canned scalars, the run
  // tag for text, a created-or-listed parent row for lookups, the stored
  // upload key for file fields, one row for a required subform.
  const recordFor = async (plans, form, prefix, notes) => {
    const record = {};
    for (const field of plans || []) {
      const dotted = prefix ? `${prefix}.${field.name}` : field.name;
      if (field.skipped) {
        notes.push(`${dotted}: ${field.source || 'skipped'}`);
        continue;
      }
      if (field.fileRef) {
        const key = uploaded.get(`${form}.${field.name}`);
        if (!key) {
          notes.push(`${dotted}: skipped — no uploaded object`);
          continue;
        }
        record[field.name] = { key };
        continue;
      }
      if (field.lookupTable || field.lookupEndpoint) {
        let id = created.get(field.lookupForm || '');
        if (!id && field.lookupEndpoint) {
          const options = await loadLookupOptions(view, field.lookupEndpoint);
          const first = (options || []).find((option) => option && option.value);
          if (first) id = String(first.value);
        }
        if (!id) {
          notes.push(`${dotted}: skipped — no parent row`);
          continue;
        }
        record[field.name] = field.multi ? [id] : id;
        continue;
      }
      if (field.children) {
        const inner = await recordFor(field.children, form, dotted, notes);
        record[field.name] = field.source === 'one subform row' ? [inner] : inner;
        continue;
      }
      record[field.name] = field.value !== undefined ? field.value : `c2c smoke ${tag}`;
    }
    return record;
  };

  for (const step of plan || []) {
    const label = (step && step.label) || 'step';
    if (authStalled(view)) {
      failed = true;
      push(label, AUTH_STALL_MESSAGE, false);
      break;
    }
    try {
      switch (step && step.kind) {
        case 'session':
          push(label, 'signed-in app session');
          break;
        case 'skip':
          push(label, step.reason || 'skipped');
          break;
        case 'upload': {
          const text = `c2c smoke ${tag}\n`;
          const bytes = new TextEncoder().encode(text);
          exercised += 1;
          const res = await api(step.path, {
            method: step.method || 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ filename: `c2c-smoke-${tag}.txt`, contentType: 'text/plain', sha256: await sha256Hex({ arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }) }),
          });
          const body = await readJson(res);
          const key = body && body.reference && body.reference.key;
          if (!res || res.ok === false || typeof key !== 'string' || !key) {
            failed = true;
            push(label, `${(res && res.status) || '?'} ${(body && body.error) || 'no reference key'}`, false);
            break;
          }
          uploaded.set(`${step.form}.${(step.upload && step.upload.field) || ''}`, key);
          const put = body.upload && typeof body.upload.url === 'string' ? body.upload.url : '';
          // A presigned PUT is https to the object store (loopback allowed on
          // the dev stack) — never wherever an endpoint happens to point. The
          // host check is on the parsed hostname: a name that only starts with
          // a loopback spelling (127.0.0.1.<host>, localhost.<host>) is not
          // loopback.
          let putTarget = null;
          try {
            putTarget = put ? new URL(put) : null;
          } catch {
            putTarget = null;
          }
          const putLoopback = putTarget !== null && LOOPBACK_HOSTS.has(putTarget.hostname);
          if (put && (!putTarget || (putTarget.protocol !== 'https:' && !(putTarget.protocol === 'http:' && putLoopback)))) {
            failed = true;
            push(label, 'the signed upload url is not an https target', false);
            break;
          }
          if (put) {
            // The signed URL goes to Stratus — never the app session headers.
            const sent = await call(put, { method: 'PUT', headers: { 'Content-Type': 'text/plain', ...((body.upload && body.upload.headers) || {}) }, body: text });
            if (!sent || sent.ok === false) {
              failed = true;
              push(label, `${res.status} reference stored but the PUT answered ${(sent && sent.status) || '?'}`, false);
              break;
            }
            uploadedUrl = put;
            push(label, `${res.status} stored (PUT ${sent.status})`);
          } else {
            push(label, `${res.status} reference stored`);
          }
          break;
        }
        case 'submit': {
          const notes = [];
          const record = await recordFor(step.record, step.form, '', notes);
          exercised += 1;
          const res = await api(step.path, {
            method: step.method || 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ record }, jsonReplacer),
          });
          const body = await readJson(res);
          const suffix = notes.length ? ` (${notes.join('; ')})` : '';
          if (!res || res.ok === false) {
            failed = true;
            push(label, `${(res && res.status) || '?'} ${(body && body.error) || ''}`.trim() + suffix, false);
            break;
          }
          const rowid = body && body.values && body.values.ROWID != null ? String(body.values.ROWID) : '';
          if (body && body.wrote === true && /^\d+$/.test(rowid)) {
            created.set(step.form, rowid);
            submitted.set(step.form, record);
            push(label, `${res.status} wrote ${rowid}${suffix}`);
          } else if (body && body.wrote === true) {
            failed = true;
            push(label, `${res.status} wrote but returned no usable ROWID${suffix}`, false);
          } else {
            push(label, `${res.status} dry-run — nothing written${suffix}`);
          }
          break;
        }
        case 'read-back': {
          const rowId = created.get(step.form);
          if (!rowId) {
            push(label, 'skipped — no row created');
            break;
          }
          const field = (step.expect && step.expect.field) || (step.marker && step.marker.field) || 'ROWID';
          exercised += 1;
          const row = await smokeReadRow(api, step, field, rowId);
          if (!row) {
            failed = true;
            push(label, `missing — the store holds no row ${rowId}`, false);
            break;
          }
          verified.add(step.form);
          push(label, `row ${rowId} present`);
          if (step.expect) {
            const expected =
              step.expect.value !== undefined
                ? step.expect.value
                : step.expect.submitted === 'update'
                  ? (updateSent.get(step.form) || {}).value
                  : (submitted.get(step.form) || {})[step.expect.field];
            if (expected === undefined) push(label, `${step.expect.field} — nothing sent to compare`);
            else if (String(row[step.expect.field] ?? '') === String(expected)) push(label, `${step.expect.field} matches what the run sent`);
            else {
              failed = true;
              push(label, `${step.expect.field} does not match what the run sent`, false);
            }
          }
          for (const child of step.children || []) {
            const report = (appModel.reports || []).find((item) => item && item.form === step.form && item.queryEndpoint);
            if (!report) {
              push(label, `child ${child.field}: no report on ${step.form} to read it`);
              break;
            }
            const res = await api(report.queryEndpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ op: 'query', page: 0, pageSize: 300, filter: { field: 'ROWID', value: rowId } }, jsonReplacer),
            });
            const body = await readJson(res);
            const parent = res && res.ok && Array.isArray(body.rows) ? body.rows.find((item) => String(item && item.ROWID) === String(rowId)) : null;
            const list = parent && Array.isArray(parent[child.field]) ? parent[child.field] : [];
            if (list.length) push(label, `child ${child.field}: ${list.length} row`);
            else {
              failed = true;
              push(label, `child ${child.field}: no row`, false);
            }
          }
          for (const check of step.lookups || []) {
            const sent = (submitted.get(step.form) || {})[check.field];
            const ids = Array.isArray(sent) ? sent : sent != null ? [sent] : [];
            if (!ids.length) {
              push(label, `lookup ${check.field}: skipped — no value submitted`);
              continue;
            }
            const options = await loadLookupOptions(view, check.endpoint);
            const missing = ids.filter((id) => {
              const option = (options || []).find((entry) => entry && String(entry.value) === String(id));
              return !option || option.label === '';
            });
            if (missing.length) {
              failed = true;
              push(label, `lookup ${check.field}: no display for ${missing.length} id(s)`, false);
            } else push(label, `lookup ${check.field}: display resolved`);
          }
          for (const check of step.files || []) {
            const res = await api(check.filesPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rowId }) });
            const body = await readJson(res);
            if (res && res.ok && typeof body.url === 'string' && body.url) push(label, `file ${check.field}: key resolves`);
            else {
              failed = true;
              push(label, `${(res && res.status) || '?'} ${(body && body.error) || 'no file key'}`.trim(), false);
            }
          }
          break;
        }
        case 'update': {
          const rowId = created.get(step.form);
          const update = step.update || {};
          const markerField = step.marker && step.marker.field;
          if (!rowId || !update.field) {
            push(label, 'skipped — no row created');
            break;
          }
          if (!markerField) {
            push(label, 'skipped — no marker field to scope the update');
            break;
          }
          const sent = update.value !== undefined ? update.value : `${String((submitted.get(step.form) || {})[update.field] ?? `c2c smoke ${tag}`)} (updated)`;
          exercised += 1;
          const res = await api('/admin/smoke', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'update', form: step.form, rowId, marker: { field: markerField, tag: `c2c smoke ${tag}` }, fields: { [update.field]: sent } }, jsonReplacer),
          });
          const body = await readJson(res);
          if (!res || res.ok === false) {
            failed = true;
            push(label, `${(res && res.status) || '?'} ${(body && body.error) || ''}`.trim(), false);
          } else if (body && body.updated === true) {
            updateSent.set(step.form, { field: update.field, value: sent });
            push(label, `${res.status} updated`);
          } else {
            push(label, `${res.status} dry-run — nothing written`);
          }
          break;
        }
        case 'arithmetic': {
          const rowId = created.get(step.form);
          const markerField = step.marker && step.marker.field;
          if (!rowId || !step.arithmetic || !markerField) {
            push(label, 'skipped — no row created');
            break;
          }
          exercised += 1;
          const res = await api('/admin/smoke', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'arith', form: step.form, rowId, marker: { field: markerField, tag: `c2c smoke ${tag}` }, field: step.arithmetic.field }, jsonReplacer),
          });
          const body = await readJson(res);
          if (!res || res.ok === false) {
            failed = true;
            push(label, `${(res && res.status) || '?'} ${(body && body.error) || ''}`.trim(), false);
          } else if (body && body.arithmetic === true) push(label, `${res.status} the live read is a number`);
          else if (body && body.dryRun === true) push(label, `${res.status} dry-run — nothing checked`);
          else {
            failed = true;
            push(label, `${res.status} ${(body && body.error) || 'the number field does not read back as a number'}`, false);
          }
          break;
        }
        case 'report': {
          exercised += 1;
          const res = await api(step.path, {
            method: step.method || 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'query', page: 0, pageSize: 300 }),
          });
          const body = await readJson(res);
          if (!res || res.ok === false) {
            failed = true;
            push(label, `${(res && res.status) || '?'} ${(body && body.error) || ''}`.trim(), false);
          } else if (!body || !Array.isArray(body.rows)) {
            // A 200 that is not the report's JSON shape — a sign-in page
            // answers 200 HTML — proves nothing.
            failed = true;
            push(label, `${res.status} but the answer is not the report shape`, false);
          } else push(label, `${res.status} (${body.rows.length} rows)`);
          break;
        }
        case 'cleanup': {
          const rowId = created.get(step.form);
          if (!rowId) {
            push(label, 'skipped — nothing created');
            break;
          }
          if (!verified.has(step.form)) {
            failed = true;
            push(label, `skipped — read-back did not confirm row ${rowId}; left in place`, false);
            break;
          }
          const marker = step.marker && step.marker.field;
          exercised += 1;
          const res = await api('/admin/smoke', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // A form with no marker field is cleaned up by the exact ROWID this
            // run's submit returned and read back — never by query or criteria.
            body: JSON.stringify(marker ? { op: 'delete', form: step.form, rowId, marker: { field: marker, tag: `c2c smoke ${tag}` } } : { op: 'delete', form: step.form, rowId }),
          });
          const body = await readJson(res);
          if (!res || res.ok === false || !(body && body.deleted === true)) {
            failed = true;
            const reason = `${(res && res.status) || '?'} ${(body && body.error) || 'not deleted'}`.trim();
            push(label, marker ? reason : `row ${rowId} not deleted — ${reason}; left in place`, false);
            break;
          }
          const gone = await smokeReadRow(api, step, marker, rowId);
          if (gone) {
            failed = true;
            push(label, `row ${rowId} still present after delete`, false);
          } else {
            deleted += 1;
            // The object does not ride the row delete — ask the store to drop
            // it. Best effort: a PUT-scoped presign may not allow DELETE.
            if (uploadedUrl) {
              try {
                await call(uploadedUrl, { method: 'DELETE' });
              } catch { /* best effort */ }
              uploadedUrl = '';
            }
            push(label, `row ${rowId} deleted (verified gone)`);
          }
          break;
        }
        default:
          push(label, 'unknown step');
      }
    } catch (err) {
      if (authStalled(view) || isAuthTimeout(err)) {
        failed = true;
        push(label, AUTH_STALL_MESSAGE, false);
        break;
      }
      failed = true;
      push(label, `failed — ${(err && err.message) || 'error'}`, false);
    }
  }
  const summary = `created ${created.size}, deleted ${deleted}, left ${created.size - deleted}`;
  // A run that touched nothing — every step skipped — verified nothing; it is
  // a failure, not a pass. A plan whose submits all dry-ran wrote nothing
  // either; the page's ok agrees with the verdict the CLI reads back.
  const submits = (plan || []).filter((step) => step && step.kind === 'submit').length;
  const ok = !failed && created.size === deleted && exercised > 0 && !(submits > 0 && created.size === 0);
  lines.push(summary);
  const block = { version: 'c2c-smoke/1', ok, created: created.size, deleted, left: created.size - deleted, exercised, steps: rows };
  const project = view && typeof view.C2C_SMOKE_PROJECT === 'string' ? view.C2C_SMOKE_PROJECT : '';
  const json = await sealSmokeBlock(block, {
    origin: view && view.location ? view.location.origin : '',
    app: (appModel && appModel.name) || '',
    project,
    plan,
    // determinism-allow: runtime-only browser clock stamping the result block; not evaluated while generating files
    at: new Date().toISOString(),
  });
  return { ok, lines, json, code: await smokeResultCode(json, plan) };
}

/** Sorted-key JSON, so the page and `c2c smoke --result` hash the same bytes for the same block. */
export function smokeCanonical(value) {
  if (Array.isArray(value)) return `[${value.map((item) => smokeCanonical(item === undefined ? null : item)).join(',')}]`;
  if (value && typeof value === 'object') {
    // determinism-allow: keys are sorted before use; runtime-only result sealing
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${smokeCanonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

async function smokeSha256(text) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle || typeof TextEncoder !== 'function') return '';
  const bytes = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Bind a c2c-smoke/1 block to where and what it ran: the page origin, the app
 * name, the project id the deploy embedded, a SHA-256 of the embedded plan,
 * and the finish time. `digest` is a SHA-256 over the whole bound block, so
 * `c2c smoke --result` refuses a block that was edited or cut short after the
 * page printed it. No secret goes into the seal and none comes out of it.
 */
export async function sealSmokeBlock(block, bind) {
  const sealed = {
    ...block,
    origin: String((bind && bind.origin) || ''),
    app: String((bind && bind.app) || ''),
    ...(bind && bind.project ? { project: String(bind.project) } : {}),
    plan: await smokeSha256(smokeCanonical((bind && bind.plan) || [])),
    at: String((bind && bind.at) || ''),
  };
  const digest = await smokeSha256(smokeCanonical(sealed));
  return digest ? { ...sealed, digest } : sealed;
}

const SMOKE_CODE_PREFIX = 'c2cs1';

function smokeBase64url(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function smokeDeflate(bytes) {
  if (typeof CompressionStream !== 'function' || typeof Blob !== 'function' || typeof Response !== 'function') return null;
  try {
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * The result code the page shows beside its Copy button: the whole sealed
 * block, packed copy-safe (packages/deploy/src/smoke-code.ts has the format) —
 * `c2cs1`, a format letter (`k` deflate-raw, `c` plain where the browser
 * cannot compress), base64url of the canonical compact JSON `[rest, steps]`,
 * then 6 check characters (base64url of the first 4 bytes of SHA-256 over
 * everything before them). The compact form leaves out the digest (it is
 * recomputed) and names a step label or detail that is one of the plan's
 * strings by its index. `c2c smoke --result-code` unpacks it and runs the
 * same verifier as --result.
 */
export async function smokeResultCode(block, plan) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle || typeof TextEncoder !== 'function' || typeof btoa !== 'function' || !block || !block.digest || !Array.isArray(block.steps)) return '';
  const { steps, digest, ...rest } = block;
  // The plan's strings, in plan order: each step's label and skip reason.
  const strings = [];
  for (const step of Array.isArray(plan) ? plan : []) {
    if (!step || typeof step !== 'object') continue;
    if (typeof step.label === 'string') strings.push(step.label);
    if (typeof step.reason === 'string') strings.push(step.reason);
  }
  const ref = (text) => {
    const at = strings.indexOf(text);
    return at >= 0 ? at : text;
  };
  const compact = [rest, steps.map((step) => [ref(String(step.label)), step.ok ? 1 : 0, ref(String(step.detail))])];
  const raw = new TextEncoder().encode(smokeCanonical(compact));
  const packed = await smokeDeflate(raw);
  const body = packed && packed.length < raw.length ? `${SMOKE_CODE_PREFIX}k${smokeBase64url(packed)}` : `${SMOKE_CODE_PREFIX}c${smokeBase64url(raw)}`;
  const check = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(body))).slice(0, 4);
  return `${body}${smokeBase64url(check)}`;
}

/** Copy the code: the clipboard API, else select it and execCommand('copy'). */
function wireSmokeCopy(section, view) {
  const button = section.querySelector('[data-smoke-copy-code]');
  const codeEl = section.querySelector('#c2c-smoke-code');
  if (!button || !codeEl) return;
  button.addEventListener('click', () => {
    const text = codeEl.textContent || '';
    const done = (label) => {
      button.textContent = label;
    };
    const fallback = () => {
      const doc = section.ownerDocument;
      const win = doc && doc.defaultView;
      const selection = win && win.getSelection ? win.getSelection() : null;
      if (selection && doc.createRange) {
        const range = doc.createRange();
        range.selectNodeContents(codeEl);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      let copied = false;
      try {
        copied = !!(doc && typeof doc.execCommand === 'function' && doc.execCommand('copy'));
      } catch { /* selected for a manual copy */ }
      done(copied ? 'Copied' : 'Selected — press Ctrl+C / ⌘C');
    };
    const clipboard = view && view.navigator && view.navigator.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') clipboard.writeText(text).then(() => done('Copied'), fallback);
    else fallback();
  });
}

function mountSmoke(appModel, main, view) {
  const section = main && main.querySelector ? main.querySelector('[data-smoke]') : null;
  if (!section) return;
  const state = section.querySelector('[data-smoke-state]');
  const tbody = section.querySelector('[data-smoke-steps]');
  const pre = section.querySelector('#c2c-smoke-json');
  const table = tbody && tbody.closest ? tbody.closest('table') : null;
  const doc = section.ownerDocument;
  const setState = (value, text) => {
    if (!state) return;
    state.setAttribute('data-smoke-state', value);
    if (text) state.textContent = text;
  };
  const call = (view && view.fetch) || globalThis.fetch;
  const plan = view && view.C2C_SMOKE_PLAN;
  if (typeof call !== 'function' || !Array.isArray(plan) || !plan.length) {
    setState('unavailable', 'No smoke plan is embedded in this build.');
    return;
  }
  // The access check must always settle: a dropped connection or an auth
  // SDK call that never resolves must not leave the page on "Checking
  // access…" or "Running the smoke contract…" forever.
  const timer = (view && view.setTimeout) || setTimeout;
  const clearTimer = (view && view.clearTimeout) || clearTimeout;
  const statusWait = typeof (view && view.C2C_SMOKE_STATUS_TIMEOUT_MS) === 'number' ? view.C2C_SMOKE_STATUS_TIMEOUT_MS : 30000;
  let active = false;
  const showAuthFailure = () => {
    setState('failed', AUTH_STALL_MESSAGE);
    let button = section.querySelector('[data-smoke-retry]');
    if (!button && doc) {
      button = doc.createElement('button');
      button.type = 'button';
      button.setAttribute('data-smoke-retry', '');
      button.textContent = 'Retry';
      const anchor = section.querySelector('[data-smoke-state]');
      if (anchor && anchor.insertAdjacentElement) anchor.insertAdjacentElement('afterend', button);
      else section.appendChild(button);
    }
    if (!button) return;
    button.hidden = false;
    button.disabled = false;
    button.onclick = () => {
      clearAuthStall(view);
      button.disabled = true;
      run();
    };
  };
  const run = () => {
    if (active) return;
    active = true;
    const previous = section.querySelector('[data-smoke-retry]');
    if (previous) previous.hidden = true;
    setState('pending', 'Checking access…');
    let statusTimer = 0;
    const statusDeadline = new Promise((resolve, reject) => {
      statusTimer = timer(() => reject(new Error('smoke status timeout')), statusWait);
    });
    statusDeadline.catch(() => {});
    Promise.race([
      apiCall(call, view, '/admin/smoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'status' }),
      }),
      statusDeadline,
    ])
      .then(async (res) => {
        if (authStalled(view)) {
          showAuthFailure();
          return;
        }
        // Authorization is the documented status shape — { ok: true, dryRun,
        // mode, forms } — never a bare 2xx: a sign-in page or any HTML answer
        // is 200 and is not authorization.
        const status = res && res.status === 200 ? await readJson(res) : null;
        const granted =
          status !== null &&
          typeof status === 'object' &&
          status.ok === true &&
          typeof status.mode === 'string' &&
          Number.isInteger(status.forms);
        if (!granted) {
          if (res && res.status === 403) {
            setState('denied', 'The smoke service denied this sign-in — it needs an Administrator profile.');
          } else {
            setState('not-signed-in', `Not signed in or the smoke service did not answer its status shape (status ${(res && res.status) || '?'}). Sign in as an app administrator.`);
          }
          return;
        }
        setState('running', 'Running the smoke contract…');
        const result = await runSmokePlan(appModel, plan, view);
        if (authStalled(view)) {
          showAuthFailure();
          return;
        }
        if (tbody && doc) {
          for (const line of result.lines) {
            const tr = doc.createElement('tr');
            const td = doc.createElement('td');
            td.textContent = line;
            tr.appendChild(td);
            tbody.appendChild(tr);
          }
          if (table) table.hidden = false;
        }
        const codeBox = section.querySelector('[data-smoke-code]');
        const codeEl = section.querySelector('#c2c-smoke-code');
        if (result.code && codeBox && codeEl) {
          codeEl.textContent = result.code;
          codeBox.hidden = false;
          wireSmokeCopy(section, view);
        }
        if (pre) {
          pre.textContent = JSON.stringify(result.json, null, 2);
          pre.hidden = false;
          const copy = section.querySelector('[data-smoke-copy]');
          if (copy) copy.hidden = false;
        }
        setState(result.ok ? 'done' : 'failed', result.ok ? 'Done — every check passed.' : 'Failed — see the steps below.');
      })
      .catch((err) => {
        if (authStalled(view) || isAuthTimeout(err) || (err && err.message === 'smoke status timeout' && authInflightCount(view) > 0)) {
          if (authInflightCount(view) > 0) markAuthStall(view);
          showAuthFailure();
          return;
        }
        setState(
          'failed',
          err && err.message === 'smoke status timeout'
            ? 'Timed out checking access — the smoke service or sign-in did not answer. Reload to retry.'
            : 'The smoke run failed to finish.',
        );
      })
      .finally(() => {
        active = false;
        clearTimer(statusTimer);
      });
  };
  run();
}

export function boot(appModel, doc) {
  const documentRef = doc || (typeof document !== 'undefined' ? document : null);
  if (!documentRef || !appModel) return;
  const view = documentRef.defaultView || globalThis;
  const main = documentRef.getElementById('main');
  const bulkSelections = new Map();
  const nav = documentRef.getElementById('nav');
  const title = documentRef.getElementById('app-title');
  if (title) title.textContent = appModel.name || 'App';
  const auth = view && view.catalyst && view.catalyst.auth;
  const login = documentRef.getElementById('c2c-login');
  if (bridgeConfigured(view)) {
    // Bridge mode: no SDK sign-in on Slate. Hold a token or take the one
    // loop-guarded bridge trip; a refused trip leaves the sign-in note up.
    if (!hasBridgeToken(view) && !bridgeRedirect(view) && login) {
      login.hidden = false;
      const line = documentRef.createElement('p');
      line.textContent = 'Sign in to continue.';
      login.appendChild(line);
      const link = documentRef.createElement('a');
      link.setAttribute('href', '#');
      link.textContent = 'Sign in';
      link.addEventListener('click', (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        bridgeRedirect(view, true);
      });
      login.appendChild(link);
    }
  } else if (auth && login && typeof auth.isUserAuthenticated === 'function') {
    // Catalyst Authentication: show the embedded sign-in when there is no session.
    const note = (attr, text) => {
      if (login.querySelector(`[${attr}]`)) return;
      const line = documentRef.createElement('p');
      line.setAttribute(attr, '');
      line.textContent = text;
      login.appendChild(line);
    };
    // service_url is where the frame returns the user after sign-in; read it
    // before the first paint can move an empty route to the home tab. The SDK
    // resolves the value against the page, so a pathname of "//other-host/" or
    // "/\other-host/" must not reach it — a leading // would point the return
    // visit at another origin. The same goes for escapes: an encoded path like
    // "/%2Fother-host" decodes to a protocol-relative URL one step later, so
    // refuse them outright — the routes live in the hash, a real path never
    // needs them — and decode until the value is stable so a doubly encoded
    // %252F cannot hide a second decode. A value still changing at the decode
    // cap hides a later decode, so it refuses too. Strip to one slash and keep
    // only what resolves back on this origin.
    const serviceUrl = (() => {
      if (!view.location) return '/';
      const path = String(view.location.pathname);
      if (/%(?:2f|5c|0[0-9a-f]|1[0-9a-f])/i.test(path)) return '/';
      const candidate = `/${path.replace(/^[\\/]+/, '')}${view.location.hash || ''}`;
      let decoded = candidate;
      try {
        for (let i = 0; i <= 3; i++) {
          if (/^[\\/]{2}/.test(decoded) || /[\u0000-\u001f\u007f]/.test(decoded)) return '/';
          const next = decodeURIComponent(decoded);
          if (next === decoded) break;
          if (i === 3) return '/';
          decoded = next;
        }
      } catch {
        return '/';
      }
      try {
        return new URL(candidate, view.location.origin).origin === view.location.origin ? candidate : '/';
      } catch {
        return '/';
      }
    })();
    const showSignedOut = () => {
      if (typeof auth.signIn !== 'function') return;
      login.hidden = false;
      // A visible signed-out state — not the empty, silent page a bare frame gives.
      note('data-sign-in', 'Sign in to continue.');
      try {
        auth.signIn('c2c-login', { service_url: serviceUrl });
      } catch {
        // The frame check below reports the box that never appeared.
      }
      // The SDK mounts an <iframe> into the box; a frame the browser refuses
      // still mounts one (it renders blank), so the standing hint covers that
      // case and the hard failure is the frame that never appears.
      const waitMs = typeof view.C2C_LOGIN_WAIT_MS === 'number' ? view.C2C_LOGIN_WAIT_MS : 3000;
      const timer = view.setTimeout || setTimeout;
      timer(() => {
        if (login.querySelector('iframe')) {
          note(
            'data-sign-in-hint',
            'If the sign-in box stays blank, iFrame is off for this host — the app administrator can enable it under Authentication > Whitelisting > this host > Edit > iFrame on, then reload.',
          );
        } else {
          note(
            'data-sign-in-error',
            'The sign-in box could not load — check the network and that iFrame is on for this host (Authentication > Whitelisting > this host > Edit > iFrame on), then reload.',
          );
          // Hosted login still reaches the user without the embedded frame.
          const link = documentRef.createElement('a');
          link.setAttribute('href', `/__catalyst/auth/login?service_url=${encodeURIComponent(view.location ? view.location.href : '/')}`);
          link.textContent = 'Sign in';
          login.appendChild(link);
        }
      }, waitMs);
    };
    const showStall = () => {
      login.hidden = false;
      note('data-sign-in-error', AUTH_STALL_MESSAGE);
      const line = login.querySelector('[data-sign-in-error]');
      if (line) line.setAttribute('role', 'alert');
      let button = login.querySelector('[data-sign-in-retry]');
      if (!button) {
        button = documentRef.createElement('button');
        button.type = 'button';
        button.setAttribute('data-sign-in-retry', '');
        button.textContent = 'Retry';
        button.addEventListener('click', () => {
          clearAuthStall(view);
          run();
        });
        login.appendChild(button);
      }
      button.disabled = false;
    };
    const run = () => {
      const pending = login.querySelector('[data-sign-in-retry]');
      if (pending) pending.disabled = true;
      watchAuthCall(view, () => auth.isUserAuthenticated())
        .then(() => {
          login.hidden = true;
        })
        .catch((error) => {
          if (isAuthTimeout(error) || authStalled(view)) {
            showStall();
            return;
          }
          showSignedOut();
        });
    };
    run();
  }
  if (nav) nav.innerHTML = renderNav(appModel);
  const tabbar = documentRef.getElementById('tabbar');
  if (tabbar) tabbar.innerHTML = renderTabbar(appModel);
  const sheet = documentRef.getElementById('more-sheet');
  if (sheet) {
    sheet.innerHTML = renderMoreSheet(appModel);
    sheet.hidden = true;
  }
  const toggle = documentRef.getElementById('menu-toggle');
  if (toggle && nav) {
    toggle.setAttribute('aria-expanded', nav.getAttribute('data-collapsed') === 'true' ? 'false' : 'true');
    toggle.addEventListener('click', () => {
      const collapsed = nav.getAttribute('data-collapsed') === 'true';
      nav.setAttribute('data-collapsed', collapsed ? 'false' : 'true');
      toggle.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
    });
  }
  const moreTab = tabbar && tabbar.querySelector ? tabbar.querySelector('[data-more]') : null;
  const setMore = (open) => {
    if (!sheet) return;
    sheet.hidden = !open;
    if (moreTab) moreTab.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  if (moreTab && sheet) {
    moreTab.addEventListener('click', () => {
      setMore(sheet.hidden);
    });
    sheet.addEventListener('click', (event) => {
      const target = event.target;
      const nearby = target && target.closest ? target.closest('[data-more-close], a[href^="#"]') : null;
      if (nearby) setMore(false);
    });
    documentRef.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !sheet.hidden) {
        setMore(false);
        moreTab.focus();
      }
    });
  }
  componentMounts.set(appModel, (slot, kind, target, viewRef) => {
    if (kind === 'form') {
      const formEl = slot.querySelector('form');
      if (formEl) openForm(appModel, target, formEl, viewRef, { name: 'form', id: target.name });
      return;
    }
    if (target.view === 'chart') {
      const section = slot.querySelector('section[data-report]');
      if (section) loadChart(target, section, viewRef);
    } else {
      const tbody = slot.querySelector('[data-rows] tbody, [data-rows] [data-board]');
      if (tbody) loadRows(target, tbody, viewRef);
      const section = slot.querySelector('section[data-report]');
      const loadLive = (page) => {
        const live = section && section.querySelector('[data-rows] tbody, [data-rows] [data-board]');
        if (live) loadRows(target, live, viewRef, page);
      };
      const search = section && section.querySelector('[data-report-search]');
      if (search) search.addEventListener('submit', (event) => { event.preventDefault(); loadLive(0); });
      const filter = section && section.querySelector('select[data-filter]');
      if (filter) filter.addEventListener('change', () => loadLive(0));
    }
  });
  const markCurrent = () => {
    const hash = documentRef.location ? documentRef.location.hash : '';
    if (nav) setCurrent(nav, hash);
    markPhoneCurrent(documentRef, hash);
  };
  /**
   * Fields a blueprint stage hides or locks. A bulk edit posts without a
   * per-row stage context, so a field any stage removes from the editable set
   * is never offered.
   */
  const stageLimitedFields = (form) => {
    const limited = new Set();
    const specs = (form && Array.isArray(form.stageFields) && form.stageFields) || [];
    for (const spec of specs) {
      const stages = spec && typeof spec.stages === 'object' && spec.stages ? spec.stages : {};
      for (const rules of Object.values(stages)) {
        if (!rules || typeof rules !== 'object') continue;
        for (const name of Array.isArray(rules.hidden) ? rules.hidden : []) limited.add(name);
        for (const name of Array.isArray(rules.readonly) ? rules.readonly : []) limited.add(name);
        if (!Array.isArray(rules.visible) && !Array.isArray(rules.updatable)) continue;
        for (const field of (form && form.fields) || []) {
          const name = field && field.name;
          if (!name) continue;
          if (Array.isArray(rules.visible) && !rules.visible.includes(name)) limited.add(name);
          if (Array.isArray(rules.updatable) && !rules.updatable.includes(name)) limited.add(name);
        }
      }
    }
    return limited;
  };
  const bulkFieldsFor = (form) => {
    const limited = stageLimitedFields(form);
    return (form && form.fields || []).filter((field) =>
      field && field.status === 'generated' && field.visibility !== false && !field.readonly && !limited.has(field.name) && ['text', 'textarea', 'email', 'phone', 'number', 'decimal', 'percent', 'currency', 'date', 'datetime', 'time', 'decision', 'select', 'radio', 'url'].includes(field.widget),
    );
  };
  const openBulkEdit = (section) => {
    const report = reportOf(section);
    const form = report && (appModel.forms || []).find((item) => item.name === report.form);
    const ids = report && bulkSelections.get(report.name);
    const fields = bulkFieldsFor(form);
    if (!section || !form || !ids || !ids.size || !fields.length) return;
    const wrap = documentRef.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.setAttribute('data-bulk-modal', '');
    const dialog = documentRef.createElement('form');
    dialog.className = 'modal-card';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', `Edit ${ids.size} selected records`);
    const title = documentRef.createElement('h2');
    title.textContent = `Edit ${ids.size} selected records`;
    const label = documentRef.createElement('label');
    label.textContent = 'Field';
    const select = documentRef.createElement('select');
    select.name = 'field';
    for (const field of fields) {
      const option = documentRef.createElement('option');
      option.value = field.name;
      option.textContent = field.label || field.name;
      select.appendChild(option);
    }
    const valueLabel = documentRef.createElement('label');
    valueLabel.textContent = 'New value';
    const input = documentRef.createElement('input');
    input.name = 'value';
    input.type = 'text';
    const updateControl = () => {
      const field = fields.find((item) => item.name === select.value);
      const current = valueLabel.querySelector('[name="value"]');
      const next = field && ['select', 'radio', 'decision'].includes(field.widget) ? (() => {
        const choice = documentRef.createElement('select');
        choice.name = 'value';
        const blank = documentRef.createElement('option'); blank.value = ''; blank.textContent = 'Choose a value'; choice.appendChild(blank);
        const values = field.widget === 'decision' ? ['true', 'false'] : (field.choices || []);
        for (const value of values) { const option = documentRef.createElement('option'); option.value = value; option.textContent = value; choice.appendChild(option); }
        return choice;
      })() : documentRef.createElement('input');
      if (next.tagName === 'INPUT') next.type = field && field.widget === 'number' ? 'number' : 'text';
      next.name = 'value';
      if (current) current.replaceWith(next); else valueLabel.appendChild(next);
    };
    valueLabel.appendChild(input);
    label.appendChild(select);
    select.addEventListener('change', updateControl);
    updateControl();
    const buttons = documentRef.createElement('div');
    const submit = documentRef.createElement('button');
    submit.type = 'submit'; submit.textContent = 'Apply to selected';
    const cancel = documentRef.createElement('button');
    cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.addEventListener('click', () => wrap.remove());
    buttons.append(submit, cancel);
    dialog.append(title, label, valueLabel, buttons);
    dialog.addEventListener('submit', async (event) => {
      event.preventDefault();
      const value = dialog.elements.namedItem('value');
      const currentField = fields.find((field) => field.name === select.value);
      if (!currentField || !value) return;
      submit.disabled = true;
      const result = await applyBulkEdit(view, form, [...ids], { [currentField.name]: value.value });
      const failed = result.filter((item) => !item.ok);
      bulkSelections.set(report.name, new Set(failed.map((item) => item.rowId)));
      wrap.remove();
      const summary = failed.length
        ? `Updated ${result.length - failed.length} of ${result.length} records. Failed rows: ${failed.map((item) => `${item.rowId} (${item.error})`).join('; ')}`
        : `Updated ${result.length} records.`;
      showToast(documentRef, failed.length ? 'failure' : 'success', summary);
      const tbody = section.querySelector('[data-rows] tbody');
      if (tbody) loadRows(report, tbody, view, Number(section.dataset.page || 0));
    });
    wrap.appendChild(dialog);
    documentRef.body.appendChild(wrap);
    select.focus();
  };
  const reportOf = (section) => {
    if (!section || !section.getAttribute) return null;
    const name = section.getAttribute('data-report');
    return (appModel.reports || []).find((item) => item.name === name) || null;
  };
  // Snippet popup actions open the target in a modal card, never a new window.
  const openPopup = (popup, root, viewRef) => {
    const docRef = (root && root.ownerDocument) || documentRef;
    if (!docRef || !docRef.body) return;
    const name = popup.name || '';
    if (docRef.querySelector(`[data-modal-form="${name}"]`)) return;
    const wrap = docRef.createElement('div');
    wrap.className = 'modal';
    wrap.setAttribute('data-modal-form', name);
    const close = '<button type="button" class="modal-close" data-modal-close aria-label="Close">&times;</button>';
    if (popup.target === 'report') {
      const report = (appModel.reports || []).find((item) => item.name === name);
      if (!report) return;
      wrap.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true">${close}${renderReport(report)}</div>`;
      docRef.body.appendChild(wrap);
      if (report.view === 'chart') {
        const section = wrap.querySelector('section[data-report]');
        if (section) loadChart(report, section, viewRef);
      } else {
        const tbody = wrap.querySelector('[data-rows] tbody, [data-rows] [data-board]');
        if (tbody) loadRows(report, tbody, viewRef);
      }
    } else {
      const form = (appModel.forms || []).find((item) => item.name === name);
      if (!form) return;
      wrap.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(form.label || form.name)}">${close}${renderForm(form)}</div>`;
      docRef.body.appendChild(wrap);
      const formEl = wrap.querySelector('form');
      if (formEl) wireForm(appModel, form, formEl, viewRef);
    }
    const closeButton = wrap.querySelector('[data-modal-close]');
    if (closeButton) closeButton.addEventListener('click', () => wrap.remove());
  };
  setPopupOpener((popup, root, viewRef) => {
    // A popup target that lives only in a hidden nav section asks the server first, like its route does.
    if (!hiddenTarget(appModel, popup.name || '')) {
      openPopup(popup, root, viewRef);
      return;
    }
    const docRef = (root && root.ownerDocument) || documentRef;
    const endpoint = gateEndpoint(appModel, { name: popup.target, id: popup.name || '' });
    const call = (viewRef && viewRef.fetch) || globalThis.fetch;
    if (!docRef || !docRef.body || !endpoint || typeof call !== 'function') return;
    const routeAt = docRef.location ? docRef.location.hash : '';
    apiCall(call, viewRef, endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'view' }),
    })
      .then((res) => {
        if (!res || res.status === 401 || res.status === 403 || res.ok === false) return;
        // The answer only counts on the route that asked for it.
        if (docRef.location && docRef.location.hash !== routeAt) return;
        openPopup(popup, root, viewRef);
      })
      .catch(() => {});
  });
  const paintAllowed = (route) => {
    if (!main) return;
    // A same-hash repaint must not restart the run: the shell is already up.
    if (route.name === 'smoke' && main.querySelector('[data-smoke]')) return;
    // A snippet popup belongs to the page that opened it; leaving that route closes it.
    for (const modal of documentRef.querySelectorAll('[data-modal-form]')) modal.remove();
    main.innerHTML = renderRoute(appModel, route, documentRef);
    markCurrent();
    if (route.name === 'form') {
      const form = (appModel.forms || []).find((item) => item.name === route.id);
      const formEl = main.querySelector('form');
      if (form && formEl) openForm(appModel, form, formEl, view, route);
    }
    if (route.name === 'page') {
      hydrateCharts(main, appModel, view);
      hydratePopups(main, appModel, view);
      hydrateSnippets(main, appModel, view);
      hydratePageIncludes(main, appModel, view);
      hydrateComponentEmbeds(main, appModel, view);
    }
    if (route.name === 'smoke') mountSmoke(appModel, main, view);
    if (route.name === 'report') {
      const report = (appModel.reports || []).find((item) => item.name === route.id);
      const tbody = main.querySelector('[data-rows] tbody, [data-rows] [data-board]');
      if (report && report.view === 'chart') {
        const section = main.querySelector('section[data-report]');
        if (section) loadChart(report, section, view);
      } else if (report && tbody) {
        loadRows(report, tbody, view);
        const section = tbody.closest ? tbody.closest('section[data-report]') : null;
        const loadLive = (page) => {
          const live = section && section.querySelector('[data-rows] tbody, [data-rows] [data-board]');
          loadRows(report, live || tbody, view, page);
        };
        const search = section && section.querySelector('[data-report-search]');
        if (search) {
          search.addEventListener('submit', (event) => {
            event.preventDefault();
            loadLive(0);
          });
        }
        const filter = section && section.querySelector('select[data-filter]');
        if (filter) filter.addEventListener('change', () => loadLive(0));
      }
    }
  if (route.name === 'record') loadRecordSummary(appModel, route, main, view);
  else if (route.name === 'report' && route.row) {
    const report = (appModel.reports || []).find((item) => item.name === route.id);
    if (report && report.form) loadRecordSummary(appModel, { ...route, id: report.form, report: report.name }, main, view);
  }
  };
  const paint = () => {
    if (!main) return Promise.resolve();
    const route = parseRoute(documentRef.location ? documentRef.location.hash : '');
    // Opening the app lands on the first menu target, like Creator's home tab.
    if (route.name === 'home') {
      const target = firstMenuHref(appModel);
      if (target && documentRef.location) {
        documentRef.location.hash = target;
        return Promise.resolve();
      }
    }
    if (!route.id || !hiddenTarget(appModel, route.id)) {
      paintAllowed(route);
      return Promise.resolve();
    }
    const endpoint = gateEndpoint(appModel, route);
    const call = view.fetch || globalThis.fetch;
    const showDenied = (status) => {
      main.innerHTML = `<p data-access-status="${status}">This page is not available.</p>`;
    };
    if (!endpoint || typeof call !== 'function') {
      showDenied(403);
      return Promise.resolve();
    }
    return apiCall(call, view, endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'view' }),
    })
      .then((res) => {
        if (!res || res.status === 401 || res.status === 403 || res.ok === false) showDenied((res && res.status) || 403);
        else paintAllowed(route);
      })
      .catch(() => showDenied(403));
  };
  documentRef.addEventListener('change', (event) => {
    const target = event.target && event.target.closest ? event.target.closest('[data-bulk-select]') : null;
    if (!target) return;
    const section = target.closest('section[data-report]');
    const report = reportOf(section);
    if (!report) return;
    const selected = bulkSelections.get(report.name) || new Set();
    if (target.checked && !selected.has(target.value) && selected.size >= 25) {
      target.checked = false;
      showToast(documentRef, 'failure', 'Bulk edit is limited to 25 rows at a time.');
      return;
    }
    if (target.checked) selected.add(target.value); else selected.delete(target.value);
    bulkSelections.set(report.name, selected);
    const count = section.querySelector('[data-bulk-count]');
    const button = section.querySelector('[data-bulk-edit]');
    if (count) count.textContent = selected.size ? `${selected.size} selected (maximum 25)` : 'No rows selected';
    if (button) button.disabled = selected.size === 0;
  });
  documentRef.addEventListener('click', (event) => {
    const target = event.target && event.target.closest ? event.target : null;
    if (target) {
      // A generated ExecuteFunction button: POST the encoded constants and
      // page parameters to the callee's client-call endpoint, then toast the
      // successMsg or the endpoint's error.
      const fnBtn = target.closest('button[data-fn-call]');
      if (fnBtn) {
        event.preventDefault();
        const path = fnBtn.getAttribute('data-fn-call') || '';
        const call = view.fetch || globalThis.fetch;
        // Only a generated client-call route is a valid target; any other
        // value in sanitized markup is inert.
        if (typeof call === 'function' && /^\/functions\/[a-z0-9-]+\/call$/i.test(path)) {
          const input = snippetPageInput(documentRef);
          const args = [];
          let bad = false;
          const argc = fnBtn.getAttribute('data-fn-argc');
          if (argc !== null) {
            const count = /^\d+$/.test(argc) ? Number(argc) : -1;
            for (let i = 0; i < count; i++) {
              const raw = fnBtn.getAttribute(`data-fn-arg-${i}`);
              if (raw === null) {
                bad = true;
                break;
              }
              const kind = raw.slice(0, 2);
              const value = raw.slice(2);
              try {
                if (kind === 'j:') args.push(JSON.parse(value));
                else if (kind === 'p:') {
                  const param = Object.prototype.hasOwnProperty.call(input, value) ? input[value] : undefined;
                  args.push(param === undefined ? null : param);
                } else if (kind === 'n:') {
                  const n = Number(value);
                  if (!Number.isFinite(n)) throw new Error('not a number');
                  args.push(n);
                } else if (kind === 'b:') {
                  if (value !== 'true' && value !== 'false') throw new Error('not a boolean');
                  args.push(value === 'true');
                } else if (kind === 's:') args.push(value);
                else bad = true;
              } catch (err) {
                bad = true;
              }
            }
          } else {
            for (const part of (fnBtn.getAttribute('data-fn-args') || '').split('&')) {
              if (!part) continue;
              const eq = part.indexOf('=');
              try {
                if (part.slice(0, eq) === 'c') args.push(JSON.parse(decodeURIComponent(part.slice(eq + 1))));
                else if (part.slice(0, eq) === 'p') {
                  const name = decodeURIComponent(part.slice(eq + 1));
                  const value = Object.prototype.hasOwnProperty.call(input, name) ? input[name] : undefined;
                  args.push(value === undefined ? null : value);
                } else bad = true;
              } catch (err) {
                bad = true;
              }
            }
          }
          if (!bad) {
            apiCall(call, view, path, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ args }),
            })
              .then(async (res) => {
                if (res && res.ok) {
                  showToast(documentRef, 'success', fnBtn.getAttribute('data-fn-msg') || 'Done');
                  if (fnBtn.getAttribute('data-fn-refresh') === 'true' && documentRef.location && typeof documentRef.location.reload === 'function') documentRef.location.reload();
                  return;
                }
                const body = await readJson(res);
                const message = body && typeof body.error === 'string' && body.error.trim() ? body.error : 'The action did not complete.';
                showToast(documentRef, 'failure', message);
              })
              .catch(() => {
                showToast(documentRef, 'failure', 'The action did not complete.');
              });
          }
        }
        return;
      }
      const bulk = target.closest('[data-bulk-edit]');
      if (bulk) {
        event.preventDefault();
        openBulkEdit(bulk.closest('section[data-report]'));
        return;
      }
      const chartBtn = target.closest('button[data-chart-refresh],button[data-chart-sort]');
      if (chartBtn) {
        const section = chartBtn.closest('section[data-report]');
        const report = section && chartReportOf(appModel, section);
        if (report) {
          event.preventDefault();
          if (chartBtn.hasAttribute('data-chart-refresh')) loadChart(report, section, view);
          else toggleChartSort(report, section);
          return;
        }
      }
      const action = target.closest('[data-retry], [data-prev], [data-next]');
      if (action) {
        const section = action.closest ? action.closest('section[data-report]') : null;
        const report = reportOf(section);
        const tbody = section && section.querySelector('[data-rows] tbody, [data-rows] [data-board]');
        if (report && tbody) {
          event.preventDefault();
          const current = Number((section.dataset && section.dataset.page) || 0);
          if (action.hasAttribute('data-retry')) loadRows(report, tbody, view, current);
          else if (action.hasAttribute('data-prev')) loadRows(report, tbody, view, Math.max(0, current - 1));
          else loadRows(report, tbody, view, current + 1);
          return;
        }
      }
      // Record affordances: Edit routes to the edit screen; Delete posts the
      // ROWID to the form's delete endpoint and removes the row on success.
      const rowOp = target.closest('[data-row-edit], [data-row-delete]');
      if (rowOp) {
        // A grouped list stores the record id on data-row-id; the plain list uses data-row.
        const tr = rowOp.closest('tr[data-row], tr[data-row-id]');
        const rowId = tr && (tr.getAttribute('data-row') || tr.getAttribute('data-row-id'));
        const section = rowOp.closest ? rowOp.closest('section[data-report]') : null;
        const report = reportOf(section);
        if (report && report.form && rowId) {
          event.preventDefault();
          if (rowOp.hasAttribute('data-row-edit')) {
            if (documentRef.location) documentRef.location.hash = `#/form/${encodeURIComponent(report.form)}/edit/${encodeURIComponent(rowId)}`;
            return;
          }
          const form = (appModel.forms || []).find((item) => item.name === report.form);
          const call = view.fetch || globalThis.fetch;
          // Creator asks before deleting; Cancel (or no dialog at all) sends nothing.
          const confirmed = typeof view.confirm === 'function' && view.confirm(DELETE_CONFIRM_TEXT) === true;
          if (form && form.deleteEndpoint && typeof call === 'function' && confirmed) {
            apiCall(call, view, form.deleteEndpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ROWID: rowId }),
            })
              .then(async (res) => {
                const docRef = documentRef;
                if (res && res.ok) {
                  const body = await readJson(res);
                  if (tr && tr.remove) tr.remove();
                  if (docRef) showToast(docRef, 'success', body && body.dryRun === false ? 'Record deleted.' : 'Record deleted. Preview: nothing was removed yet.');
                  return;
                }
                const body = await readJson(res);
                const message = body && typeof body.error === 'string' && body.error.trim() ? body.error : 'The record was not deleted.';
                if (docRef) showToast(docRef, 'failure', message);
              })
              .catch(() => {
                showToast(documentRef, 'failure', 'The record was not deleted.');
              });
          }
          return;
        }
      }
      const row = target.closest('tr[data-row]');
      if (row && !(target.closest('a,button'))) {
        const rowLink = row.querySelector('[data-row-link]');
        if (rowLink && documentRef.location) {
          documentRef.location.hash = rowLink.getAttribute('href');
          return;
        }
      }
    }
    const link = event.target && event.target.closest ? event.target.closest('a[href^="#"]') : null;
    if (!link) return;
    event.preventDefault();
    if (sheet && !sheet.hidden) setMore(false);
    documentRef.location.hash = link.getAttribute('href');
  });
  /** Forms whose grid row events are already delegated to the document. */
  const formRowEventsBound = new WeakSet();
  view.addEventListener('hashchange', paint);
  const install = documentRef.getElementById('install');
  // The button is an installed-app affordance: it stays hidden in a plain tab.
  const installedApp =
    (view.matchMedia && view.matchMedia('(display-mode: standalone)').matches) ||
    (view.navigator && view.navigator.standalone === true);
  let deferred = null;
  view.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event;
    if (install && installedApp) install.hidden = false;
  });
  if (install) {
    install.addEventListener('click', async () => {
      if (!deferred) return;
      deferred.prompt();
      deferred = null;
      install.hidden = true;
    });
  }
  // Bridge mode sign-out: clears c2c.bridge.* and leaves for the bridge's
  // signout action, which ends the function-origin session. Hidden otherwise.
  const signOut = documentRef.getElementById('sign-out');
  if (signOut && bridgeConfigured(view)) {
    signOut.hidden = false;
    signOut.addEventListener('click', () => {
      bridgeSignOut(view);
    });
  }
  // The worker registers from pwa-register.js (a plain script any shell
  // includes); the runtime does not register a second copy.
  const navg = view.navigator || globalThis.navigator;
  const offline = documentRef.getElementById('offline');
  const flag = () => {
    if (offline) offline.hidden = navg ? navg.onLine : true;
  };
  view.addEventListener('online', flag);
  view.addEventListener('offline', flag);
  flag();
  return paint();

  /**
   * Report chrome follows the export: the toolbar, sort/group captions, the
   * grid itself, and pagination show only for a successful non-empty load.
   * An empty or failed load keeps them hidden.
   */
  function setReportChrome(section, populated) {
    if (!section || !section.querySelector) return;
    for (const selector of ['[data-report-tools]', '[data-rows]', '[data-pages]', '[data-sort]', '[data-group-by]']) {
      const el = section.querySelector(selector);
      if (el) el.hidden = !populated;
    }
  }

  /** Paint the pagination controls for the page just loaded. */
  function updatePages(section, page, rows, pageSize) {
    if (!section || !section.querySelector) return;
    const pages = section.querySelector('[data-pages]');
    if (!pages) return;
    const label = pages.querySelector('[data-page-label]');
    if (label) label.textContent = `Page ${page + 1}`;
    const prev = pages.querySelector('[data-prev]');
    const next = pages.querySelector('[data-next]');
    if (prev) {
      if (page <= 0) prev.setAttribute('disabled', '');
      else prev.removeAttribute('disabled');
    }
    if (next) {
      if (rows.length < pageSize) next.setAttribute('disabled', '');
      else next.removeAttribute('disabled');
    }
  }

  function loadRows(report, tbody, viewRef, page) {
    const call = (viewRef && viewRef.fetch) || globalThis.fetch;
    if (!report.queryEndpoint || typeof call !== 'function') return Promise.resolve();
    const section = tbody.closest ? tbody.closest('section[data-report]') : null;
    const current = typeof page === 'number' && page >= 0 ? page : 0;
    if (section && section.dataset) section.dataset.page = String(current);
    const stateEl = section && section.querySelector('[data-state]');
    const pageSize = report.pageSize || PAGE_SIZE;
    const emptyOpts = report.form ? { formHref: `#/form/${encodeURIComponent(report.form)}` } : undefined;
    // A static host has no data function: that is an empty report, not an error.
    const unavailable = (res) => !res || res.status === 404 || res.status === 405 || res.status === 501;
    const paintEmpty = () => {
      if (stateEl) stateEl.innerHTML = reportStateHtml('empty', emptyOpts);
    };
    if (stateEl) stateEl.innerHTML = reportStateHtml('loading');
    const qInput = section && section.querySelector('[data-report-search] input[name="q"], [data-report-search] input[type="search"]');
    const filterEl = section && section.querySelector('select[data-filter]');
    const q = qInput && typeof qInput.value === 'string' ? qInput.value : '';
    const filter = filterEl && typeof filterEl.value === 'string' ? filterEl.value : '';
    return apiCall(call, viewRef, report.queryEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        op: 'query',
        page: current,
        pageSize,
        sort: report.sort && report.sort.length ? report.sort : report.startField ? [{ field: report.startField, order: 'ascending' }] : [],
        q,
        filter,
      }),
    })
      .then((res) => {
        if (!res || !res.ok) {
          if (unavailable(res)) {
            paintEmpty();
            return null;
          }
          throw new Error(`report query ${res ? res.status : 'no response'}`);
        }
        return responseJson(res);
      })
      .then((body) => {
        if (body == null) return;
        const rows = Array.isArray(body && body.rows) ? body.rows : [];
        const doc = tbody.ownerDocument;
        if (tbody.hasAttribute('data-board')) fillBoard(report, tbody, rows);
        else {
          tbody.innerHTML = renderReportRows(report, rows);
          const selected = bulkSelections.get(report.name) || new Set();
          for (const checkbox of tbody.querySelectorAll('[data-bulk-select]')) checkbox.checked = selected.has(checkbox.value);
        }
        const bulkCount = section && section.querySelector('[data-bulk-count]');
        const bulkButton = section && section.querySelector('[data-bulk-edit]');
        const selectedCount = (bulkSelections.get(report.name) || new Set()).size;
        if (bulkCount) bulkCount.textContent = selectedCount ? `${selectedCount} selected (maximum 25)` : 'No rows selected';
        if (bulkButton) bulkButton.disabled = selectedCount === 0;
        setReportChrome(section, rows.length > 0);
        if (stateEl) {
          stateEl.innerHTML = rows.length ? '' : reportStateHtml('empty', emptyOpts);
        }
        updatePages(section, current, rows, pageSize);
        const text = body && typeof body.notice === 'string' ? body.notice : '';
        let notice = section && section.querySelector('p[data-notice]');
        if (text && section) {
          if (!notice) {
            notice = doc.createElement('p');
            notice.className = 'todo';
            notice.setAttribute('data-notice', '');
            section.appendChild(notice);
          }
          notice.textContent = text;
        } else if (notice) {
          notice.remove();
        }
      })
      .catch(() => {
        setReportChrome(section, false);
        if (stateEl) stateEl.innerHTML = reportStateHtml('error');
      });
  }

  /** Read the URL-named row through the existing authorizeRead endpoint. */
  function loadRecordSummary(appModel, route, root, viewRef) {
    const form = (appModel.forms || []).find((item) => item.name === route.id);
    const section = root && root.querySelector('[data-record-summary]');
    const rowId = typeof route.row === 'string' ? route.row : '';
    const call = (viewRef && viewRef.fetch) || globalThis.fetch;
    if (!form || !section || !rowId || !form.recordEndpoint || typeof call !== 'function') return;
    const requestedHash = viewRef && viewRef.location ? viewRef.location.hash : '';
    apiCall(call, viewRef, form.recordEndpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ROWID: rowId, ...(route.report ? { REPORT: route.report } : {}) }),
    }).then(async (res) => {
      if (viewRef && viewRef.location && viewRef.location.hash !== requestedHash) return;
      if (!res || res.status === 403) { section.innerHTML = '<p data-access-status="403">This record is not available.</p>'; return; }
      if (res.status === 404) { section.innerHTML = '<p data-record-empty="">No record is available.</p>'; return; }
      if (!res.ok) throw new Error('record read failed');
      const body = await readJson(res);
      const row = body && body.record && typeof body.record === 'object' && !Array.isArray(body.record) ? body.record : null;
      if (!row) { section.innerHTML = '<p data-record-empty="">No record is available.</p>'; return; }
      const report = route.report && (appModel.reports || []).find((item) => item.name === route.report);
      const allowed = report ? new Set((report.columns || []).filter((column) => !column.action).map((column) => column.field)) : null;
      const fields = (form.fields || []).filter((field) => field && typeof field.name === 'string' && (!allowed || allowed.has(field.name)) && Object.prototype.hasOwnProperty.call(row, field.name));
      const rows = fields.map((field) => `<tr><th scope="row">${escapeHtml(field.label || field.name)}</th><td>${escapeHtml(summaryValue(row[field.name], field))}</td></tr>`).join('');
      section.innerHTML = `<table><tbody>${rows}</tbody></table>`;
    }).catch(() => {
      if (!viewRef || !viewRef.location || viewRef.location.hash === requestedHash) section.innerHTML = '<p data-record-error="">This record could not be loaded.</p>';
    });
  }

  function summaryValue(value, field) {
    if (value == null) return '';
    if (typeof value === 'object') {
      if (Array.isArray(value)) return value.map((item) => summaryValue(item, field)).filter(Boolean).join(', ');
      if (typeof value.label === 'string') return value.label;
      if (field && field.widget === 'subform') {
        const names = new Set((field.subfields || []).map((sub) => sub.name));
        return Object.entries(value).filter(([name]) => names.has(name)).map(([, item]) => summaryValue(item)).filter(Boolean).sort().join(', ');
      }
      return Object.values(value).map((item) => summaryValue(item)).filter(Boolean).sort().join(', ');
    }
    return String(value);
  }

  /**
   * Open a form screen. `#/form/<name>/edit/<id>` reads the row through the
   * scoped record endpoint, prefills the controls, then wires the form in
   * edit mode — `on edit` and `on add or edit` handlers run, and the submit
   * carries the ROWID so the write updates instead of inserting.
   */
  async function openForm(model, form, formEl, viewRef, route) {
    if (!route || !route.edit) {
      // A navigation link's query fills the add screen's own fields; a name
      // that is not a field of this form is ignored.
      const prefill = route && route.prefill ? prefillRecord(form, route.prefill) : null;
      if (prefill) {
        await fillLookups(form, formEl, viewRef).catch(() => {});
        fillFormValues(formEl, form, prefill);
      }
      wireForm(model, form, formEl, viewRef);
      return;
    }
    const rowId = String(route.edit);
    let record = { ROWID: rowId };
    let stages = null;
    const call = (viewRef && viewRef.fetch) || globalThis.fetch;
    if (form.recordEndpoint && typeof call === 'function') {
      const res = await apiCall(call, viewRef, form.recordEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ROWID: rowId }),
      }).catch(() => null);
      if (res && res.ok) {
        const body = await readJson(res);
        if (body && body.record && typeof body.record === 'object' && !Array.isArray(body.record)) record = body.record;
        if (body && body.stages && typeof body.stages === 'object') stages = body.stages;
      }
    }
    await fillLookups(form, formEl, viewRef).catch(() => {});
    fillFormValues(formEl, form, record);
    applyActions(stageFieldActions(form, stages), formEl);
    wireForm(model, form, formEl, viewRef, { mode: 'edit', rowId, old: record });
  }

  function prefillRecord(form, values) {
    const record = {};
    let any = false;
    for (const field of form.fields || []) {
      if (!field || typeof field.name !== 'string' || field.widget === 'subform' || !Object.prototype.hasOwnProperty.call(values, field.name)) continue;
      record[field.name] = values[field.name];
      any = true;
    }
    return any ? record : null;
  }

  function wireForm(model, form, formEl, viewRef, open) {
    // Lookup selects render empty; their options arrive from /lookups/*.
    fillLookups(form, formEl, viewRef).catch(() => {});
    const mode = open && open.mode === 'edit' ? 'edit' : 'add';
    const rowId = mode === 'edit' && open && open.rowId ? String(open.rowId) : '';
    // Creator's edit screen submits with an Update button.
    if (mode === 'edit') {
      const submitButton = formEl.querySelector('button[type="submit"]');
      if (submitButton) submitButton.textContent = 'Update';
    }
    // The record event set that fires on this screen. `on add or edit` runs on
    // both; a handler without a record event runs in every context.
    const recordEvents = new Set(mode === 'edit' ? ['', 'on edit', 'on add or edit'] : ['', 'on add', 'on add or edit']);
    const ctx = (rowRef) => ({
      record: readValues(formEl),
      old: (open && open.old) || {},
      formNonce: '',
      form: formEl,
      ...(rowRef ? { subformRow: rowRef } : {}),
      appTimeZone: viewRef && typeof viewRef.C2C_APP_TIMEZONE === 'string' ? viewRef.C2C_APP_TIMEZONE : undefined,
      shim: browserShim(),
    });
    const run = async (when, fieldName, rowRef) => {
      const matches = (form.handlers || []).filter((handler) => {
        if (handler.when !== when) return false;
        if (fieldName && handler.field && handler.field !== fieldName) return false;
        return recordEvents.has((handler.recordEvent || '').toLowerCase());
      });
      const actions = [];
      const shared = ctx(rowRef);
      for (const handler of matches) {
        try {
          actions.push(...(await runHandler(handler, shared)));
        } catch {
          actions.push({ op: 'info', message: 'Client handler failed.' });
        }
      }
      return applyActions(actions, formEl);
    };
    run('load').catch(() => {});
    formEl.addEventListener('change', (event) => {
      const target = event.target;
      const cell = target && target.closest ? target.closest('[data-subfield]') : null;
      const box = cell && cell.closest ? cell.closest('.subform[data-field]') : null;
      // A grid cell change fires the subform field input handler: `on user
      // input of Subform.Field`, with `row` bound to that grid row.
      let name;
      let rowRef;
      if (box) {
        const tr = cell.closest('tr');
        const rows = tr && tr.parentElement ? [...tr.parentElement.children] : [];
        name = `${box.getAttribute('data-field')}.${cell.getAttribute('data-subfield')}`;
        rowRef = { field: box.getAttribute('data-field'), index: Math.max(0, rows.indexOf(tr)) };
      } else name = target && target.name;
      if (name) run('input', name, rowRef).catch(() => {});
    });
    const doc = formEl.ownerDocument;
    // Row events fire after the layout layer adds/removes the grid row, so the
    // document-level listener registered here sees the final row set.
    if (doc && !formRowEventsBound.has(formEl)) {
      formRowEventsBound.add(formEl);
      doc.addEventListener('click', (event) => {
        const add = event.target && event.target.closest ? event.target.closest('[data-add-row]') : null;
        if (add && formEl.contains(add)) {
          const box = add.closest('.subform[data-field]');
          const field = box && box.getAttribute('data-field');
          const rows = box ? box.querySelectorAll('tbody tr') : [];
          if (field && rows.length) run('addrow', undefined, { field, index: rows.length - 1 }).catch(() => {});
          return;
        }
        const remove = event.target && event.target.closest ? event.target.closest('[data-remove-row]') : null;
        if (remove && formEl.contains(remove)) {
          const box = remove.closest('.subform[data-field]');
          const field = box && box.getAttribute('data-field');
          const tr = remove.closest('tr');
          const rows = tr && tr.parentElement ? [...tr.parentElement.children] : [];
          const index = rows.indexOf(tr);
          if (field && tr) {
            run('deleterow', undefined, { field, index: Math.max(0, index) })
              .catch(() => {})
              .finally(() => tr.remove());
          }
        }
      });
    }
    // One key per opened form; a committed submit starts a fresh one.
    let submitKey = newSubmitKey();
    let inFlight = false;
    formEl.addEventListener('submit', async (event) => {
      event.preventDefault();
      // The submit control is disabled while a submit is in flight; a second
      // press or Enter in the meantime does nothing.
      if (inFlight) return;
      inFlight = true;
      const submitButton = formEl.querySelector('button[type="submit"]');
      if (submitButton) submitButton.disabled = true;
      try {
        await submitOnce();
      } finally {
        inFlight = false;
        if (submitButton) submitButton.disabled = false;
      }
    });
    async function submitOnce() {
      for (const old of formEl.querySelectorAll('p[data-mail-notice]')) old.remove();
      const values = readValues(formEl);
      const errors = validateForm(form, values);
      showErrors(formEl, form, errors);
      if (Object.keys(errors).length) return;
      const notes = await run('validate');
      if (notes.includes('cancel')) return;
      const online = viewRef && viewRef.navigator ? viewRef.navigator.onLine : typeof navigator === 'undefined' || navigator.onLine;
      if (!online) {
        const banner = formEl.querySelector('[data-banner]');
        if (banner) banner.textContent = 'Offline: data unavailable. Submitting a form needs a network.';
        return;
      }
      const endpoint = mode === 'edit' && form.editSubmitEndpoint ? form.editSubmitEndpoint : form.submitEndpoint;
      const call = (viewRef && viewRef.fetch) || globalThis.fetch;
      if (!endpoint || typeof call !== 'function') return;
      let record;
      try {
        record = await submitRecord(formEl, form, (field, file) => uploadReference(viewRef, field, file));
      } catch {
        const banner = formEl.querySelector('[data-banner]');
        if (banner) banner.textContent = 'Upload failed. The form was not submitted.';
        return;
      }
      const res = await apiCall(call, viewRef, endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ record, ...(rowId ? { ROWID: rowId } : {}), idempotencyKey: submitKey }, jsonReplacer),
      }).catch(() => null);
      const banner = formEl.querySelector('[data-banner]');
      const formDoc = formEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
      // One read of the answer serves both branches and the toast mode.
      const answer = res ? await readJson(res) : {};
      // Every write answers with a dryRun flag; the toast preview sentence follows it.
      // An answer that says wrote true is a stored row even when a step after
      // the save failed: it is committed for idempotency, but the banner names
      // the failed step, never a clean save.
      if (answer && answer.wrote === true) submitKey = newSubmitKey();
      if (!res || !res.ok) {
        let failure = 'The record was not saved.';
        let live = false;
        if (res) {
          const body = answer;
          if (body && body.dryRun === false) live = true;
          failure = submitFailureText(body);
        }
        if (banner) banner.textContent = failure;
        if (formDoc) showToast(formDoc, 'failure', submitNotice({ ok: false, dryRun: !live, message: failure }));
        return;
      }
      const answerLive = !!answer && answer.dryRun === false;
      const successNotes = await run('success');
      if (!successNotes.includes('success')) {
        if (banner) banner.textContent = mode === 'edit' ? DEFAULT_UPDATE_BANNER : form.successMessage || DEFAULT_SUCCESS_BANNER;
      }
      // A saved add clears the form for the next record; the banner stays.
      if (mode !== 'edit' && answerLive && typeof formEl.reset === 'function') formEl.reset();
      if (answer && Array.isArray(answer.mail)) {
        for (const item of answer.mail) {
          const text = mailNoticeText(item);
          if (text) formNotice(formEl, text);
        }
      }
      if (formDoc) {
        const shown = banner && banner.textContent ? banner.textContent : '';
        showToast(formDoc, 'success', submitNotice({ ok: true, dryRun: !answerLive, message: shown || undefined }));
      }
    }
  }
}
