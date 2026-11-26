/**
 * Slot-general fallback for the status document. The name-aware layers in `status.ts` redact what the analysed app DECLARES;
 * this layer redacts by SLOT, so an undeclared free-text value (a dangling reference, a typo, a value the parser never
 * lists as an identifier) cannot survive either. A slot is a place where an emitter interpolates source text. The slots
 * below were enumerated from every reason template in `packages/ui/src/{model,pages,htmlpage,snippet-guidance}.ts` and
 * `decorations/*.ts` (the status test re-derives the vocabulary from those files and fails on a new one). Text in a slot is kept
 * only when it is in the public vocabulary; everything else is `(app identifier)`. Fails closed: an unknown value merges
 * a bucket, it never prints.
 */
export const APP_ID = '(app identifier)';

/** Numbers and booleans are counts and flags, not names (`duration = 30`, `show onload = true`). A ratio such as `16:9` is a number pair. */
export const PUBLIC_VALUE = /^(?:true|false|\d{1,4}(?:[.:]\d{1,4}){0,2})$/u;
/** Property values the Creator export defines (window targets, scanner lenses, the time pattern). */
export const PUBLIC_ENUM = new Set(['_blank', '_self', '_parent', '_top', 'primary', 'secondary', 'HH:mm', 'HH:mm:ss', 'hh:mm', 'hh:mm:ss']);
/** The `key` of every backticked `key = value` in a field reason (model.ts). */
export const FIELD_PROPERTY_KEYS = new Set([
  'target', 'duration', 'show onload', 'preview duration', 'camera', 'annotation', 'aspect ratio', 'displayformat', 'bidirectional',
  'timedisplayoptions', 'searchable', 'file count', 'value',
  // The retired data-privacy wording (`personal data = true`): kept so a stored report line still redacts the same way.
  'personal data',
]);
/** Backticked words that are the template's own text. */
export const BACKTICK_LITERALS = new Set(['values', 'options', 'multiple', '?q=', 'displayformat', 'value']);
/** Creator's named report settings blocks. */
export const BLOCK_NAMES = new Set(['customlayouts', 'filters', 'sorting', 'grouping', 'group by', 'properties', 'toolbar', 'permission', 'layout', 'style']);
/** The click actions a ZML `<button>` / `<image>` runs through the generated function wiring; any other action text is free. */
export const PUBLIC_ACTIONS = new Set(['executefunction', 'function']);
/** ZML / HTML element names the generator knows (pages.ts NAMED, ALLOWED_TAGS, DROPPED_TAGS and the layout tags). */
export const KNOWN_TAGS = new Set([
  'report', 'chart', 'pivotchart', 'form', 'button', 'text', 'label', 'title', 'search', 'gauge', 'html', 'snippet', 'dsp', 'dspzml', 'htmlsnippet',
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt', 'input', 'em', 'figcaption', 'figure',
  'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span',
  'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var', 'wbr',
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'frame', 'frameset', 'noscript', 'noembed', 'template', 'svg', 'math', 'head', 'body',
  'zml', 'page', 'pc', 'pr', 'panel', 'row', 'column', 'image', 'icon', 'tab', 'tabs', 'section', 'menu',
]);
/** At-rule names a dropped `<style>` can legitimately name. */
const PUBLIC_AT_RULES = new Set(['media', 'font-face', 'keyframes', 'import', 'charset', 'supports', 'page', 'namespace', 'layer', 'container', 'property', 'scope']);

const bucketValue = (value: string): string => {
  const text = value.trim();
  return text === APP_ID || PUBLIC_VALUE.test(text) || PUBLIC_ENUM.has(text) ? value : APP_ID;
};

/** `key = value` and bare backticked spans. */
function redactBackticks(text: string): string {
  return text.replace(/`([^`]*)`( settings block)?/gu, (_whole, span: string, block: string | undefined) => {
    const at = span.indexOf(' = ');
    if (at >= 0) {
      const key = span.slice(0, at);
      return FIELD_PROPERTY_KEYS.has(key) ? `\`${key} = ${bucketValue(span.slice(at + 3))}\`` : `\`${APP_ID}\``;
    }
    const tail = block ?? '';
    const kept = block ? BLOCK_NAMES.has(span) : BACKTICK_LITERALS.has(span) || span === APP_ID;
    return `\`${kept ? span : APP_ID}\`${tail}`;
  });
}

/** Items of a settings block that carry no `key = value` (`template X`, `<nested> block`, a bare item). */
export function redactSettingItem(item: string): string {
  const trimmed = item.trim();
  if (trimmed === APP_ID || trimmed === '(no properties)') return item;
  if (/^template(?: |$)/u.test(trimmed)) return `template ${APP_ID}`;
  const block = /^(.+) block$/u.exec(trimmed);
  return block && BLOCK_NAMES.has(block[1]!) ? item : block ? `${APP_ID} block` : APP_ID;
}

/** CSS items a dropped-style reason lists: `name declaration`, `CSS built by a Deluge tag`, a property name, an `@rule`, each with an optional ` xN`. */
function redactStyleItems(list: string): string {
  return list
    .split(', ')
    .map((item) => {
      const counted = /^(.*?)( x\d+)?$/u.exec(item)!;
      const core = counted[1]!;
      const rule = /^@([a-z-]+)(?: .*)?$/iu.exec(core);
      const ok =
        core === 'CSS built by a Deluge tag' ||
        /^[a-z]+(?:-[a-z]+)*(?: declaration)?$/u.test(core) ||
        (rule !== null && PUBLIC_AT_RULES.has(rule[1]!.toLowerCase()) && core.length <= rule[1]!.length + 1);
      return `${ok ? core : APP_ID}${counted[2] ?? ''}`;
    })
    .join(', ');
}

/** Every slot rule, in one pass over a reason sentence. */
export function redactSlots(text: string): string {
  let out = redactBackticks(text);
  // Element names: `ZML <tag>`, `The <tag> element`, `Static <style>`.
  out = out.replace(/<([^<>\s"'=/]+)>/gu, (whole, tag: string) => (KNOWN_TAGS.has(tag.toLowerCase()) ? whole : `<${APP_ID}>`));
  // `click action X calling function F is not generated`: the action text is free, the function name is a declared name or free text.
  out = out.replace(/ click action (.+?)(?: calling function (.+?))? is not generated; wire the click to the function by hand/u, (_whole, action: string, fn: string | undefined) => {
    const action2 = PUBLIC_ACTIONS.has(action.replace(/\s+/gu, '').toLowerCase()) ? action : APP_ID;
    return ` click action ${action2}${fn === undefined ? '' : ` calling function ${APP_ID}`} is not generated; wire the click to the function by hand`;
  });
  // The type slots: the type is unmapped by construction (a known one never reaches the sentence), so it is free text.
  out = out.replace(/^(No schema mapping for type )(.+)(\.)$/u, (_w, head: string, type: string, dot: string) => `${head}${type === '(none)' ? type : APP_ID}${dot}`);
  out = out.replace(/^(Report type )(.+)( is not generated\.)$/u, (_w, head: string, type: string, tail: string) => `${head}${type === '(none)' ? type : APP_ID}${tail}`);
  out = out.replace(/^(Embedded zc-component ).+( has no generated view)$/u, `$1${APP_ID}$2`);
  out = out.replace(/( uses a ).+( element; the generated print layout does not draw it\.)$/u, `$1${APP_ID}$2`);
  out = out.replace(/( neither ).+?( nor )(.+?)( is one\.)/u, (_w, a: string, b: string, y: string, c: string) => `${a}${APP_ID}${b}${y === 'its target' ? y : APP_ID}${c}`);
  // Option-group labels and every later list element, whatever they spell (digit-only included).
  out = out.replace(/( groups its options under )(.+?)( in `values`)/u, (_w, head: string, list: string, tail: string) => `${head}${list.split(', ').map(() => APP_ID).join(', ')}${tail}`);
  out = out.replace(/^(Shown as a list: ).+?( has no exported pivot shelves)/u, `$1${APP_ID}$2`);
  out = out.replace(/(drops \d+ static style rules? or declarations? \()(.*)(\))$/u, (_w, head: string, list: string, tail: string) => `${head}${redactStyleItems(list)}${tail}`);
  out = out.replace(/(\(unsafe or unsupported CSS\): )(.*)$/u, (_w, head: string, list: string) => `${head}${redactStyleItems(list)}`);
  return out;
}
