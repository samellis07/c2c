/**
 * Manual-step guidance for a server-side Deluge snippet the compiler leaves
 * as a TODO. The TODO keeps its fixed reason and stays counted; this only
 * names why it could not be translated safely and what to rebuild by hand.
 *
 * The reasons come from the snippet source and the compiler's refusal, in a
 * fixed order, so the same snippet always yields the same step text.
 */
import { DROPPED_TAGS, droppedStyles } from './pages.js';

/**
 * Every reason a server snippet stays counted, in report order. analyze,
 * the UI model and ui-manual-steps.json use only these values.
 */
export const SNIPPET_REASONS = ['write', 'render-navigation', 'caller-read', 'dynamic-url', 'sanitizer-loss', 'untranslated'] as const;

export type SnippetReason = (typeof SNIPPET_REASONS)[number];

export interface SnippetGuidance {
  reasons: SnippetReason[];
  step: string;
}

/** Compiler refusals that mean a Deluge construct had no verified translation. */
const TRANSLATION_REFUSALS = new Set([
  'malformed Deluge island',
  'no Deluge islands',
  'marker collision',
  'Deluge islands do not parse',
  'island outside the handled classes',
  'island translation failed',
  'island needs manual translation',
  'island needs a client step',
  'untranslated construct',
]);

const URL_REFUSALS = new Set(['url attribute boundary not found', 'island in an unsafe position']);

const WRITE_PATTERNS = [
  /\binsert\s+into\b/i,
  /\bdelete\s+from\b/i,
  /\.\s*(?:delete|update)\s*\(/i,
  /\bsendmail\b/i,
  /\binvokeurl\b/i,
  /\bzoho\.[a-z]+\.\w*(?:create|update|delete|upload|send|add)\w*\s*\(/i,
  /\bthisapp\.\w+(?:\.\w+)?\s*\(/i,
  // A `record.Field = value` statement on anything but the request-local input map.
  /(?:^|[;{}\n])\s*(?!input\.)[A-Za-z_]\w*\.[A-Za-z_]\w*\s*=(?!=)/,
];

const EMBED_TAGS = new Set(['iframe', 'object', 'embed', 'frame', 'frameset']);
/** Document wrappers the sanitizer unwraps without losing content. */
const WRAPPER_TAGS = new Set(['html', 'head', 'body', 'title', 'meta']);

const STEPS: Record<SnippetReason, string> = {
  write:
    'It writes during page rendering (insert, update, delete, mail, an external call, or an app function). Keep the rendered page read-only and move each write into an explicit, authenticated user action such as a form submit or a button route.',
  'render-navigation':
    'It calls openUrl while the page renders. Replace the call with a link or button the user clicks, and check the destination against the app\'s own form, report, and page routes.',
  'caller-read':
    'It reads records filtered by the signed-in user or by page parameters. Serve those reads from a server route that checks the caller\'s read grant for each form and field and passes the parameters as bound criteria values.',
  'dynamic-url':
    'It builds an iframe, embed, or link URL at render time. Rebuild it with a fixed allowlisted destination or a generated form or report route, and encode each dynamic part.',
  'sanitizer-loss': 'The sanitizer drops part of its static markup',
  untranslated: 'The compiler stopped at a Deluge construct with no verified translation',
};

/** Deluge code inside the snippet's `<% %>` islands. */
function islandCode(source: string): string {
  return splitIslands(source).islands.join('\n');
}

/**
 * Split `<% %>` islands from the markup with a linear scan (a lazy regex is
 * quadratic on many unclosed `<%`). An unclosed `<%` stays in the markup.
 */
function splitIslands(source: string): { islands: string[]; markup: string } {
  const islands: string[] = [];
  let markup = '';
  let pos = 0;
  for (;;) {
    const open = source.indexOf('<%', pos);
    if (open < 0) break;
    const start = source[open + 2] === '=' ? open + 3 : open + 2;
    const close = source.indexOf('%>', start);
    if (close < 0) break;
    markup += source.slice(pos, open);
    islands.push(source.slice(start, close));
    pos = close + 2;
  }
  return { islands, markup: markup + source.slice(pos) };
}

/** Header parameters of `htmlpage name(a, b)`. */
function headerParams(source: string): string[] {
  const head = /^\s*htmlpage\s+[\w.]+\s*\(([^)]*)\)/i.exec(source);
  return (head?.[1] ?? '')
    .split(',')
    .map((p) => p.trim().split(/\s+/).pop() ?? '')
    .filter((p) => /^[A-Za-z_]\w*$/.test(p));
}

function readsForCaller(code: string, params: string[]): boolean {
  if (/\bzoho\.creator\.getRecords?(?:ById)?\s*\(/i.test(code)) return true;
  const caller = [/\bzoho\.loginuser(?:id)?\b/i, /\binput\.\w+/];
  for (const p of params) caller.push(new RegExp(`\\b${p}\\b`));
  // A form read `Form[criteria]`; an `insert into Form [ ... ]` block is a write, not a read.
  for (const match of code.matchAll(/(?<!\binsert\s+into\s+)\b[A-Za-z_]\w*\s*\[([^\]]*)\]/gi)) {
    const criteria = match[1] ?? '';
    if (!/==|!=|<|>|\b(?:in|contains|startsWith|endsWith)\b/i.test(criteria)) continue;
    if (caller.some((re) => re.test(criteria))) return true;
  }
  return false;
}

function droppedTags(markup: string): string[] {
  const found = new Set<string>();
  for (const match of markup.matchAll(/<\s*([A-Za-z][\w-]*)/g)) {
    const tag = (match[1] ?? '').toLowerCase();
    if (DROPPED_TAGS.has(tag) && !EMBED_TAGS.has(tag) && !WRAPPER_TAGS.has(tag)) found.add(tag);
  }
  return [...found].sort();
}

/**
 * Guidance for one counted snippet. `source` is the decoded snippet text,
 * `refusal` the compiler's reason (absent when it was not compiled), and
 * `location` names the snippet and its page.
 */
export function serverSnippetGuidance(source: string, refusal: string | undefined, location: string): SnippetGuidance {
  const code = islandCode(source);
  const markup = splitIslands(source).markup.replace(/^\s*htmlpage\b[^\n]*\n?/i, '');
  const reasons: SnippetReason[] = [];
  if (WRITE_PATTERNS.some((re) => re.test(code)) || refusal === 'island is not a read-only render') reasons.push('write');
  if (/\bopenUrl\s*\(/i.test(code) || refusal === 'openUrl could not be rewritten') reasons.push('render-navigation');
  if (readsForCaller(code, headerParams(source))) reasons.push('caller-read');
  const embeds = [...markup.matchAll(/<\s*([A-Za-z][\w-]*)/g)].some((m) => EMBED_TAGS.has((m[1] ?? '').toLowerCase()));
  const islandUrl = /\b(?:src|href|action|formaction|data|poster)\s*=\s*["']?[^"'>\s]*<%/i.test(source);
  if (embeds || islandUrl || (refusal !== undefined && URL_REFUSALS.has(refusal))) reasons.push('dynamic-url');
  const lost = [...droppedTags(markup).map((t) => `<${t}>`), ...[...new Set(droppedStyles(markup))].sort()];
  if (lost.length || refusal === 'static markup contains a dropped style declaration') reasons.push('sanitizer-loss');
  if (!reasons.length || (refusal !== undefined && TRANSLATION_REFUSALS.has(refusal))) reasons.push('untranslated');

  reasons.sort((a, b) => SNIPPET_REASONS.indexOf(a) - SNIPPET_REASONS.indexOf(b));
  const steps = reasons.map((reason) => {
    if (reason === 'sanitizer-loss') {
      const what = lost.length ? ` (${lost.join(', ')})` : '';
      const script = lost.includes('<script>') ? ' Rebuild its script as reviewed client code.' : '';
      const css = lost.length === 0 || lost.some((item) => item !== '<script>') ? ' Move its CSS and other dropped markup into the app stylesheet or supported components.' : '';
      return `${STEPS[reason]}${what}.${css}${script}`;
    }
    if (reason === 'untranslated') {
      const at = refusal && TRANSLATION_REFUSALS.has(refusal) ? ` (${refusal})` : '';
      return `${STEPS[reason]}${at}. Rebuild the section with supported components, or translate the construct by hand with a test.`;
    }
    return STEPS[reason];
  });
  return { reasons, step: `${location}: ${steps.join(' ')} Keep this TODO open until the rebuilt section is verified.` };
}
