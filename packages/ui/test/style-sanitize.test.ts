import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { applyLabels } from '../src/decorations/labels.js';
import { buildModel } from '../src/model.js';
import {
  calcArgsSafe,
  carryStaticStyle,
  cleanStyle,
  droppedStyleRules,
  replaceStyleCalls,
  sanitizeSnippet as buildSanitize,
  stripStyleComments,
} from '../src/pages.js';
import {
  calcArgsSafe as printCalcArgsSafe,
  cleanPrintStyle,
  replaceStyleCalls as printReplaceStyleCalls,
  stripStyleComments as printStripStyleComments,
} from '../../shims/src/print-template.js';

// Inline style attributes are checked declaration by declaration, by two
// copies of the same rule: the generator's sanitizer and the browser
// runtime's. One vector table runs through both, and both must agree.

type Runtime = { sanitizeSnippet(raw: string, doc: unknown, dropped?: string[]): string };

async function runtime(): Promise<Runtime> {
  return (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as Runtime;
}

/** [label, style attribute value, style kept (null: no style attribute), property names reported as dropped]. */
const VECTORS: Array<[string, string, string | null, string[]]> = [
  // Shapes the exported apps use: kept whole.
  ['rgb() inside a border shorthand', 'width: 80%; border-bottom: 1px solid rgb(221, 221, 221)', 'width: 80%; border-bottom: 1px solid rgb(221, 221, 221)', []],
  ['rgba() inside a background shorthand', 'background: rgba(0, 0, 0, .5) no-repeat', 'background: rgba(0, 0, 0, .5) no-repeat', []],
  ['hsl() and hsla() tokens', 'border-color: hsl(120, 50%, 50%) hsla(0, 0%, 0%, 0.2)', 'border-color: hsl(120, 50%, 50%) hsla(0, 0%, 0%, 0.2)', []],
  ['space-separated rgb() with alpha', 'color: rgb(1 2 3 / 50%)', 'color: rgb(1 2 3 / 50%)', []],
  ['hue-rotate filter', '-webkit-filter:hue-rotate(50deg)', '-webkit-filter:hue-rotate(50deg)', []],
  ['scaleX transform', 'transform: scaleX(1.7)', 'transform: scaleX(1.7)', []],
  ['chained transforms', 'transform: rotate(45deg) translate(10px, -5px) skew(10deg) scale(1.2, .8)', 'transform: rotate(45deg) translate(10px, -5px) skew(10deg) scale(1.2, .8)', []],
  ['quoted font name', 'font-family:"karla"', 'font-family:"karla"', []],
  ['quoted font list', "font-family: 'Open Sans', Arial, sans-serif", "font-family: 'Open Sans', Arial, sans-serif", []],
  ['important flag', 'color:red !important', 'color:red !important', []],
  ['empty declarations', 'color:red;;', 'color:red;;', []],
  ['font shorthand with a slash', 'font: 12px/1.5 Arial', 'font: 12px/1.5 Arial', []],
  ['commented-out declaration beside a valid one', 'height:35px;/* border:1px solid #ededed; */', 'height:35px', []],
  // Safe calc() is carried over. A trailing token with no colon is not a declaration.
  ['calc() addition', 'width:calc(1px + 2px)', 'width:calc(1px + 2px)', []],
  ['calc() with subtraction and decimals', 'width:calc(70% - 1.5px)', 'width:calc(70% - 1.5px)', []],
  ['calc() multiplication', 'width:calc(1em*2)', 'width:calc(1em*2)', []],
  ['calc() division', 'width:calc(100% / 2)', 'width:calc(100% / 2)', []],
  ['calc() double minus', 'width:calc(1px - -2px)', 'width:calc(1px - -2px)', []],
  ['calc() case and units', 'width:CALC(1PX + 2PX)', 'width:CALC(1PX + 2PX)', []],
  ['calc() across newlines', 'width:calc(1px\n+\n2px)', 'width:calc(1px\n+\n2px)', []],
  ['calc() important flag', 'width:calc(1px + 2px) !important', 'width:calc(1px + 2px) !important', []],
  ['calc() with a comment stripped', 'width:calc(1px /**/ + 2px)', 'width:calc(1px  + 2px)', []],
  ['trailing non-declaration identifier ignored', 'font-size:15px;text', 'font-size:15px', []],
  ['trailing brace stripped', 'width:1px;}', 'width:1px', []],
  // One bad declaration no longer takes the safe ones with it.
  ['malformed declaration beside a valid one', 'margin=10px; color: red', 'color: red', ['?']],
  ['url() beside a width', 'width: 80%; background: url(//example.test/x)', 'width: 80%', ['background']],
  ['quoted semicolon', 'content:"a;b";color:red', 'color:red', ['content', '?']],
  ['escape in a second declaration', 'background:red;content:attr(data-x);background:u\\72 l(//example.test/?)', 'background:red', ['content', 'background']],
  // Fetches and script, plain or encoded: always dropped.
  ['url()', 'background:url(//example.test/x)', null, ['background']],
  ['upper-case URL(', 'background:URL(//example.test/x)', null, ['background']],
  ['url with a space before the paren', 'background:url (//example.test/x)', null, ['background']],
  ['url with a tab before the paren', 'background:UrL\t(//example.test/x)', null, ['background']],
  ['expression()', 'width:expression(alert(1))', null, ['width']],
  ['CSS escape in a url()', 'background:u\\72 l(//example.test/x)', null, ['background']],
  ['long CSS escapes', 'background:\\75\\72\\6c(//example.test/x)', null, ['background']],
  ['mixed-case CSS escape', 'background:uR\\4c(//example.test/x)', null, ['background']],
  ['comment inside url', 'background:u/**/rl(//example.test/x)', null, ['background']],
  ['image-set string URL', 'background:image-set("https://example.test/x" 1x)', null, ['background']],
  ['-webkit-image-set string URL', 'background:-webkit-image-set("https://example.test/x" 1x)', null, ['background']],
  ['image()', 'background:image("https://example.test/x")', null, ['background']],
  ['src()', 'background:src("https://example.test/x")', null, ['background']],
  ['cross-fade()', 'background:-webkit-cross-fade(url(a), url(b), 50%)', null, ['background']],
  ['element()', 'background:element(#x)', null, ['background']],
  ['attr()', 'content:attr(data-x)', null, ['content']],
  ['var()', 'width:var(--x)', null, ['width']],
  ['calc() containing url()', 'width:calc(url(x))', null, ['width']],
  ['calc() plus url()', 'width:calc(1px + url(x))', null, ['width']],
  ['calc() glued to url()', 'width:calc(1px)url(x)', null, ['width']],
  ['calc() containing expression()', 'width:calc(expression(alert(1)))', null, ['width']],
  ['calc() plus var()', 'width:calc(1px + var(--x))', null, ['width']],
  ['nested calc()', 'width:calc(calc(1px) + 1px)', null, ['width']],
  ['quoted calc()', 'width:calc("1px")', null, ['width']],
  ['backslash inside calc()', 'width:calc(1\\70 x)', null, ['width']],
  ['backslash before calc close', 'width:calc(1px\\29 )', null, ['width']],
  ['escaped calc name', 'width:c\\61 lc(1px)', null, ['width']],
  ['escaped leading calc', 'width:\\63 alc(1px)', null, ['width']],
  ['calc split onto a url()', 'width:calc(1px ; background:url(x))', null, ['width', 'background']],
  ['unbalanced calc()', 'width:calc(1px', null, ['width']],
  ['empty calc()', 'width:calc()', null, ['width']],
  ['prefixed calc()', 'width:-webkit-calc(1px)', null, ['width']],
  ['comma in calc()', 'width:calc(1px, 2px)', null, ['width']],
  ['attr() in calc()', 'width:calc(attr(x))', null, ['width']],
  ['env() in calc()', 'width:calc(env(safe-area-inset-bottom))', null, ['width']],
  ['NUL inside calc()', 'width:calc(1\u0000px)', null, ['width']],
  ['fullwidth digit in calc()', 'width:calc(\uFF11px)', null, ['width']],
  ['scientific notation in calc()', 'width:calc(1e3px)', null, ['width']],
  ['calc breakout after a semicolon', 'width:calc(1px + 2px);}body{background:red', 'width:calc(1px + 2px)', ['?']],
  ['newline-joined image-set', 'color:red\nbackground:image-set("https://example.test/x" 1x)', null, ['color']],
  ['escaped property name', 'w\\69dth:1px', null, ['?']],
  ['escaped behavior', 'b\\65havior:url(x.htc)', null, ['?']],
  ['escaped background name', '\\62 ackground:red', null, ['?']],
  ['behavior', 'behavior:url(x.htc)', null, ['behavior']],
  ['-moz-binding', '-moz-binding:url(x.xml#y)', null, ['-moz-binding']],
  ['empty property name', ':red', null, ['?']],
  ['@import', 'x:1px;@import "//example.test/x"', 'x:1px', ['?']],
  ['javascript: in a value', 'background:javascript:alert(1)', null, ['background']],
  ['entity-encoded url(', 'color:&#117;rl(//example.test/x)', null, ['color']],
  ['quoted value outside font-family', 'content:"red"', null, ['content']],
  ['escape inside a quoted font name', 'font-family:"a\\62 c"', null, ['font-family']],
  ['url() inside a transform', 'transform: rotate(url(x))', null, ['transform']],
  ['var() inside a colour', 'color: rgb(var(--x), 0, 0)', null, ['color']],
  ['unknown function', 'color: paint(x)', null, ['color']],
  ['url() after a colour token', 'border: 1px solid rgb(1, 2, 3) url(//example.test/x)', null, ['border']],
];

function styleOf(html: string): { style: string | null; dropped: string | null } {
  const div = new JSDOM(`<body>${html}</body>`).window.document.querySelector('div');
  assert.ok(div, html);
  return { style: div.getAttribute('style'), dropped: div.getAttribute('data-style-dropped') };
}

test('a style attribute keeps its safe declarations and names the dropped ones, in both sanitizers', async () => {
  const run = await runtime();
  const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document;
  for (const [label, value, kept, dropped] of VECTORS) {
    const html = `<div style="${value.replace(/"/g, '&quot;')}">x</div>`;
    const fromRuntime: string[] = [];
    const fromBuild: string[] = [];
    const runtimeHtml = run.sanitizeSnippet(html, doc, fromRuntime);
    const buildHtml = buildSanitize(html, fromBuild);
    assert.equal(runtimeHtml, buildHtml, `${label}: both sanitizers agree`);
    const out = styleOf(buildHtml);
    assert.equal(out.style, kept, `${label}: kept style`);
    assert.equal(out.dropped, dropped.length ? dropped.join(' ') : null, `${label}: data-style-dropped`);
    assert.deepEqual(fromRuntime, dropped, `${label}: runtime report`);
    assert.deepEqual(fromBuild, dropped, `${label}: build report`);
    assert.deepEqual(cleanPrintStyle(value), cleanStyle(value), `${label}: print template sanitizer agrees`);
    if (out.style) assert.doesNotMatch(out.style, /url|image|expression|attr|var\(|\\|\/\*|@|behavior|binding/i, `${label}: no fetch survives`);
  }
});

test('a notes block that loses a style declaration is listed as a TODO', () => {
  const app: App = deriveIr(
    parse(`application "Demo"\n{\n\tform Add_Product\n\t{\n\t\tdisplayname = "Add Product"\n\t\tplain\n\t\t(\n\t\t\ttype = plaintext\n\t\t\tvalue = "<div style='width: 80%; border-bottom: 1px solid rgb(221, 221, 221); background: url(//example.test/x)'>Title</div>"\n\t\t)\n\t\tName\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t}\n}\n`),
  );
  const model = buildModel(app);
  applyLabels(app, model);
  const todo = model.todos.find((item) => item.name === 'Add_Product.plain');
  assert.ok(todo, JSON.stringify(model.todos));
  assert.equal(todo.area, 'field');
  assert.match(todo.reason, /Inline style declarations not carried over.*background/);
  assert.doesNotMatch(todo.reason, /border-bottom|width/);
});

test('a page snippet that loses a style declaration is listed as a TODO', () => {
  const zml = `<zml><layout><row><column width='100%'><dsp id='html_snippet'><![CDATA[<div style="color: red; transform: rotate(url(x))">Hi</div><p style="border: 1px solid rgb(1, 2, 3)">Ok</p>]]></dsp></column></row></layout></zml>`;
  const app: App = deriveIr(
    parse(`application "Demo"\n{\n\tpages\n\t{\n\t\tpage Home\n\t\t{\n\t\t\tdisplayname = "Home"\n\t\t\tContent="${delugeString(zml)}"\n\t\t}\n\t}\n}\n`),
  );
  const model = buildModel(app);
  const todo = model.todos.find((item) => item.area === 'zml' && /Inline style/.test(item.reason));
  assert.ok(todo, JSON.stringify(model.todos));
  assert.match(todo.reason, /transform/);
  const snippet = model.pages[0]?.elements.flatMap(function all(el): typeof model.pages[0]['elements'] {
    return [el, ...el.children.flatMap(all)];
  }).find((el) => el.kind === 'html');
  assert.match(snippet?.html ?? '', /style="color: red" data-style-dropped="transform"/);
  assert.match(snippet?.html ?? '', /style="border: 1px solid rgb\(1, 2, 3\)"/);
});

/** Escape text for a double-quoted Deluge string literal (backslashes first, then quotes, in one pass). */
function delugeString(text: string): string {
  return text.replace(/[\\"]/g, (ch) => `\\${ch}`);
}

function pageModel(snippets: string[]) {
  const cells = snippets.map((html, i) => `<column width='50%'><dsp id='snippet_${i}'><![CDATA[${html}]]></dsp></column>`).join('');
  const zml = `<zml><layout><row>${cells}</row></layout></zml>`;
  const app: App = deriveIr(
    parse(`application "Demo"\n{\n\tpages\n\t{\n\t\tpage Home\n\t\t{\n\t\t\tdisplayname = "Home"\n\t\t\tContent="${delugeString(zml)}"\n\t\t}\n\t}\n}\n`),
  );
  const model = buildModel(app);
  const elements = model.pages[0]?.elements.flatMap(function all(el): typeof model.pages[0]['elements'] {
    return [el, ...el.children.flatMap(all)];
  }) ?? [];
  return { model, html: elements.filter((el) => el.kind === 'html'), styleTodos: model.todos.filter((item) => item.name === 'Home.style'), scopedCss: model.pages[0]?.scopedCss ?? '' };
}

test('static <style> CSS is carried under the page scope and only rejected rules count', () => {
  const { html, styleTodos, scopedCss } = pageModel([
    '<style>.card { color: red; } /* a { } */ .title { font-weight: 700 }</style><div class="card">Hi</div>',
    '<div><style>@media (max-width: 600px) { .card { color: blue } }</style><p>Ok</p></div>',
  ]);
  assert.equal(styleTodos.length, 0, JSON.stringify(styleTodos));
  assert.match(scopedCss, /^\[data-page="Home"\] \.card\{color: red\}/);
  assert.match(scopedCss, /\.title\{font-weight: 700\}/);
  assert.match(scopedCss, /@media \(max-width: 600px\)\{\[data-page="Home"\] \.card\{color: blue\}\}/);
  assert.equal(html.length, 2);
  for (const el of html) {
    assert.doesNotMatch(el.html ?? '', /<style/i);
    assert.equal('droppedStyleRules' in el, false, 'the count stays off the generated element');
  }
});

test('CSS tokenizer scopes selectors and refuses fetches, unsafe selectors, malformed declarations and at-rules once each', () => {
  const result = carryStaticStyle('.x, .y:hover { color: red; width: 80% } @import "x"; .z{background:url(https://x)} </style><script>{', '[data-page="Home"]');
  assert.equal(result.css, '[data-page="Home"] .x,[data-page="Home"] .y:hover{color: red;width: 80%}');
  assert.equal(result.droppedRules, 3);
  assert.deepEqual(result.dropped, ['@import', 'background declaration', 'unparsed CSS']);
  assert.deepEqual(carryStaticStyle('.x{color:red}', '[data-page="a"]'), { css: '[data-page="a"] .x{color:red}', droppedRules: 0, dropped: [] });
  const responsive = carryStaticStyle('@media (min-width: 768px) { .x > .y { width: 20% } }', '[data-page="a"]');
  assert.deepEqual(responsive, { css: '@media (min-width: 768px){[data-page="a"] .x > .y{width: 20%}}', droppedRules: 0, dropped: [] });
  assert.equal(carryStaticStyle('@media (url(x)) {.x{color:red}}', '[data-page="a"]').droppedRules, 1);
});

test('@media inside @media is dropped, so deep nesting cannot recurse', () => {
  const nested = carryStaticStyle('@media screen { @media print { .x { color: red } } .y { color: blue } }', '[data-page="a"]');
  assert.equal(nested.droppedRules, 1);
  assert.equal(nested.css, '@media screen{[data-page="a"] .y{color: blue}}');
  // A depth a recursive parser cannot survive: naive recursion overflows the
  // call stack well before 100000 frames, so an iterative scanner proves the
  // guard without any wall-clock assertion.
  const naiveRecurse = (depth: number): number => (depth ? 1 + naiveRecurse(depth - 1) : 0);
  assert.throws(() => naiveRecurse(100000), RangeError);
  const deep = '@media all{'.repeat(100000) + '}'.repeat(100000);
  const start = performance.now();
  const result = carryStaticStyle(deep, '[data-page="a"]');
  const ms = performance.now() - start;
  assert.ok(ms < 2000, `100000 nested @media: ${ms.toFixed(1)}ms`);
  assert.equal(result.css, '');
  assert.equal(result.droppedRules, 1);
});

test('a stray top-level } drops one rule, not the rest of the sheet', () => {
  const result = carryStaticStyle('}.a{color:red}.b{color:blue}', '[data-page="a"]');
  assert.equal(result.droppedRules, 1);
  assert.equal(result.css, '[data-page="a"] .a{color:red}\n[data-page="a"] .b{color:blue}');
});

test('the rendered <style> keeps child combinators', async () => {
  const run = (await runtime()) as Runtime & { renderPage(page: unknown, doc: unknown): string };
  const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document;
  const html = run.renderPage(
    { name: 'Home', label: 'Home', elements: [], scopedCss: '[data-page="Home"] .b>.c{color:red}' },
    doc,
  );
  assert.match(html, /<style>\[data-page="Home"\] \.b>\.c\{color:red\}<\/style>/);
});

test('dangerous <style> CSS is dropped and counted by name', () => {
  const { html, styleTodos } = pageModel([
    '<style>@import url(//example.test/x.css); .a { background: url(javascript:alert(1)) } .b { behavior: url(x.htc); width: expression(alert(1)) }</style><p>Hi</p>',
  ]);
  assert.equal(styleTodos.length, 1, JSON.stringify(styleTodos));
  assert.match(styleTodos[0].reason, /drops 4 static style rules or declarations \(@import, background declaration, behavior declaration, width declaration\)$/);
  assert.doesNotMatch(html[0]?.html ?? '', /import|url|expression|behavior|style/i);
  assert.equal(html[0]?.html, '<p>Hi</p>');
});

test('a page without <style> CSS gets no style TODO', () => {
  const { styleTodos } = pageModel(['<p style="color: red">Hi</p>', '<style>  /* only a comment */  </style><p>Ok</p>']);
  assert.deepEqual(styleTodos, []);
});

test('style rule counting: top-level blocks and @ statements, comments and islands masked', () => {
  assert.equal(droppedStyleRules('<p>no stylesheet</p>'), 0);
  assert.equal(droppedStyleRules('<style></style>'), 0);
  assert.equal(droppedStyleRules('<style>.a{color:red}</style>'), 1);
  assert.equal(droppedStyleRules('<style>@import "x.css"; @charset "utf-8";</style>'), 2);
  assert.equal(droppedStyleRules('<style>@media print { .a { x: 1 } .b { y: 2 } }</style>'), 1);
  assert.equal(droppedStyleRules('<style>.a { color: <%=input.c%> } /* .b { } */</style>'), 1);
  assert.equal(droppedStyleRules('<style>.a { color: red }</style><div><style>.b{}.c{}</style></div>'), 3);
  assert.equal(droppedStyleRules('<style>color: red</style>'), 1, 'stray CSS text is still lost CSS');
});

test('a page snippet lists each removed script, style, SVG, and template tag once in sorted order', () => {
  const zml = `<zml><dsp id='html_snippet'><![CDATA[<script>bad()</script><svg><script>nested()</script></svg><style></style><template><b>hidden</b></template>]]></dsp></zml>`;
  const app: App = deriveIr(parse(`application "Demo"\n{\n\tpages\n\t{\n\t\tpage Home\n\t\t{\n\t\t\tdisplayname = "Home"\n\t\t\tContent="${delugeString(zml)}"\n\t\t}\n\t}\n}\n`));
  const model = buildModel(app);
  const todos = model.todos.filter((todo) => todo.area === 'zml' && /removed from this page snippet/.test(todo.reason));
  assert.deepEqual(todos.map((todo) => todo.reason), [
    'The <script> element is removed from this page snippet by the sanitizer',
    'The <style> element is removed from this page snippet by the sanitizer',
    'The <svg> element is removed from this page snippet by the sanitizer',
    'The <template> element is removed from this page snippet by the sanitizer',
  ]);
});

test('a page snippet with carried static <style> CSS suppresses the generic style TODO', () => {
  const zml = `<zml><dsp id='html_snippet'><![CDATA[<script>bad()</script><style>.x{}</style>]]></dsp></zml>`;
  const app: App = deriveIr(parse(`application "Demo"\n{\n\tpages\n\t{\n\t\tpage Home\n\t\t{\n\t\t\tdisplayname = "Home"\n\t\t\tContent="${delugeString(zml)}"\n\t\t}\n\t}\n}\n`));
  const model = buildModel(app);
  const styleTodos = model.todos.filter((t) => t.name === 'Home.style');
  assert.equal(styleTodos.length, 0);
  assert.match(model.pages[0]?.scopedCss ?? '', /\[data-page="Home"\] \.x\{\}/);
  assert.equal(model.todos.filter((t) => t.reason === 'The <style> element is removed from this page snippet by the sanitizer').length, 0, 'no double count of <style>');
  assert.equal(model.todos.filter((t) => t.reason.includes('<script>')).length, 1);
});

test('a snippet that fails server-side compilation keeps one compile TODO without sanitizer TODOs', () => {
  const snippet = `htmlpage hp1()\ncontent\n<script>bad()</script>\n<%\nrow = insert into Orders [ Status : "open" ];\n%>`;
  const zml = `<zml><dsp id='hp1'><![CDATA[${snippet}]]></dsp></zml>`;
  const app: App = deriveIr(parse(`application "Demo"\n{\n\tpages\n\t{\n\t\tpage Home\n\t\t{\n\t\t\tdisplayname = "Home"\n\t\t\tContent=${JSON.stringify(zml)}\n\t\t}\n\t}\n}\n`));
  const model = buildModel(app);
  const pageTodos = model.todos.filter((todo) => todo.area === 'zml' && todo.name === 'Home.dsp');
  assert.equal(pageTodos.length, 1, JSON.stringify(pageTodos));
  assert.match(pageTodos[0]!.reason, /Server-side Deluge snippet requires manual translation/);
});

// ReDoS regression: the style scanners run in one pass where the old regexes
// backtracked. The three sanitizer copies (browser runtime, page generator,
// print templates) are tested against the regexes they replaced — same
// decisions on every input the regex accepted, refusals only where the new
// length caps cut in — plus adversarial inputs that finished in seconds.

type RuntimeScanners = {
  calcArgsSafe(args: string): boolean;
  stripStyleComments(value: string): string;
  replaceStyleCalls(text: string, decide: (name: string, args: string) => string): string;
};

async function runtimeScanners(): Promise<RuntimeScanners> {
  return (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as RuntimeScanners;
}

const REGEX_CALC_ARGS = /^\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|[a-z]{1,4})?(?:\s*[-+*/]\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|[a-z]{1,4})?)*\s*$/i;
const REGEX_COMMENT = /\/\*[\s\S]*?\*\//g;
const REGEX_CALL = /([-a-z0-9]*)\(([^()]*)\)/gi;

/** Deterministic generator (a seeded LCG): same corpus every run, no Math.random. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return s / 0x100000000;
  };
}

test('the calc() scanner decides what the regex did, in all three sanitizers', async () => {
  const run = await runtimeScanners();
  const pick = lcg(20261016);
  const numbers = ['0', '1', '12', '1.5', '.5', '1.', '007', '+2', '-3', '+.5', '-0.', '1.2.3', '.', '+', 'e3', '1e3'];
  const units = ['', '%', 'px', 'em', 'deg', 'ms', 'abcd', 'abcde', 'e', 'PX', 'pxx'];
  const ops = ['+', '-', '*', '/'];
  const spaces = ['', ' ', '  ', '\t', '\n'];
  const corpus: string[] = [
    '1px + 2px',
    '70% - 1.5px',
    '1em*2',
    '100% / 2',
    '1px - -2px',
    '1PX + 2PX',
    '1px\n+\n2px',
    ' 1px + 2px ',
    '1e',
    '1e3px',
    '1px, 2px',
    '1px; 2px',
    'calc(1px)',
    'url(x)',
    '',
    ' ',
    '.5px + .25em',
    '1. + .5',
    '1px +',
    '+ 1px',
    '1 px',
    '1px 2px',
    '- -2px',
  ];
  for (let k = 0; k < 4000; k++) {
    let piece = '';
    const terms = 1 + Math.floor(pick() * 4);
    for (let t = 0; t < terms; t++) {
      if (t > 0) piece += spaces[Math.floor(pick() * spaces.length)] + ops[Math.floor(pick() * ops.length)] + spaces[Math.floor(pick() * spaces.length)];
      piece += numbers[Math.floor(pick() * numbers.length)] + units[Math.floor(pick() * units.length)];
    }
    if (pick() < 0.3) piece += 'xyz'.slice(0, Math.floor(pick() * 3) + 1);
    corpus.push(piece);
  }
  for (const args of corpus) {
    const expected = REGEX_CALC_ARGS.test(args);
    assert.equal(calcArgsSafe(args), expected, `pages copy: ${JSON.stringify(args)}`);
    assert.equal(printCalcArgsSafe(args), expected, `print copy: ${JSON.stringify(args)}`);
    assert.equal(run.calcArgsSafe(args), expected, `runtime copy: ${JSON.stringify(args)}`);
  }
  for (const args of ['1px+'.repeat(60) + '1px', '1'.repeat(500), '1px '.repeat(60)]) {
    assert.equal(calcArgsSafe(args), false, `pages copy over cap: ${args.slice(0, 20)}`);
    assert.equal(printCalcArgsSafe(args), false, `print copy over cap`);
    assert.equal(run.calcArgsSafe(args), false, `runtime copy over cap`);
  }
});

test('the comment stripper removes what the regex removed, in all three sanitizers', async () => {
  const run = await runtimeScanners();
  const pick = lcg(70707);
  const pieces = ['a', ';', '/', '*', '/*', '*/', ' ', 'x:y', '/*/', '/**/'];
  const corpus: string[] = [
    'a:1;/* b:2; */c:3',
    '/* only */',
    'unterminated /* comment',
    'closer with no opener */',
    '/* a /* b */ c */ d',
    '/**/',
    '/*/',
    'nested /* /* */ text',
  ];
  for (let k = 0; k < 4000; k++) {
    const count = Math.floor(pick() * 12);
    let piece = '';
    for (let t = 0; t < count; t++) piece += pieces[Math.floor(pick() * pieces.length)];
    corpus.push(piece);
  }
  for (const value of corpus) {
    const expected = value.replace(REGEX_COMMENT, '');
    assert.equal(stripStyleComments(value), expected, `pages copy: ${JSON.stringify(value)}`);
    assert.equal(printStripStyleComments(value), expected, `print copy: ${JSON.stringify(value)}`);
    assert.equal(run.stripStyleComments(value), expected, `runtime copy: ${JSON.stringify(value)}`);
  }
});

test('the call matcher rewrites what the regex rewrote, in all three sanitizers', async () => {
  const run = await runtimeScanners();
  const pick = lcg(424242);
  const mark = (name: string, args: string) => `[${name}|${args}]`;
  const pieces = ['a', 'b', '-', '0', '9', '(', ')', 'x', ' ', '.', ',', 'rgb(', 'calc('];
  const corpus: string[] = [
    'rgb(1, 2, 3)',
    'calc(1px + 2px)',
    'foo(bar)',
    'x foo(bar) y',
    'a(b c(d)',
    '(ab(cd)',
    'ab(cd',
    'foo((x))',
    'f(a)b(c)',
    'a(b)d)e(f)',
    'a (x)',
    'a-b(x)',
    '1px solid rgb(1,2,3) url(x)',
  ];
  for (let k = 0; k < 4000; k++) {
    const count = Math.floor(pick() * 14);
    let piece = '';
    for (let t = 0; t < count; t++) piece += pieces[Math.floor(pick() * pieces.length)];
    corpus.push(piece);
  }
  for (const value of corpus) {
    const expected = value.replace(REGEX_CALL, (_call, name: string, args: string) => mark(name, args));
    assert.equal(replaceStyleCalls(value, mark), expected, `pages copy: ${JSON.stringify(value)}`);
    assert.equal(printReplaceStyleCalls(value, mark), expected, `print copy: ${JSON.stringify(value)}`);
    assert.equal(
      run.replaceStyleCalls(value, (name: string, args: string) => mark(name, args)),
      expected,
      `runtime copy: ${JSON.stringify(value)}`,
    );
  }
});

test('pathological style values finish fast instead of backtracking', async () => {
  const runSnippet = await runtime();
  const runtimeSnippet = (html: string, doc: unknown) => runSnippet.sanitizeSnippet(html, doc);
  const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document;
  const cases: Array<[string, () => unknown]> = [
    ['calc digits over the cap', () => cleanStyle(`width:calc(${'1'.repeat(50000)}x)`)],
    ['calc digits over the cap (print)', () => cleanPrintStyle(`width:calc(${'1'.repeat(50000)}x)`)],
    ['calc almost-expression', () => calcArgsSafe(`${'1px + '.repeat(30)}x`)],
    ['calc almost-expression (print)', () => printCalcArgsSafe(`${'1px + '.repeat(30)}x`)],
    ['comment openers', () => cleanStyle('/*'.repeat(20000))],
    ['comment openers (print)', () => cleanPrintStyle('/*'.repeat(20000))],
    ['comment openers under the cap', () => stripStyleComments(`${'/*'.repeat(3000)}a`)],
    ['unclosed call', () => cleanStyle(`width:${'a'.repeat(3000)}(${'b'.repeat(3000)}`)],
    ['unclosed call (print)', () => cleanPrintStyle(`width:${'a'.repeat(3000)}(${'b'.repeat(3000)}`)],
    ['rgb digits under the cap', () => cleanStyle(`color:rgb(${'1'.repeat(8170)}!)`)],
    ['rgb digits under the cap (print)', () => cleanPrintStyle(`color:rgb(${'1'.repeat(8170)}!)`)],
    ['rgb digits under the cap in a snippet', () => runtimeSnippet(`<div style="color:rgb(${'1'.repeat(8170)}!)">x</div>`, doc)],
    ['unclosed call in a snippet', () => runtimeSnippet(`<div style="width:${'a'.repeat(3000)}(${'b'.repeat(3000)}">x</div>`, doc)],
  ];
  for (const [label, runCase] of cases) {
    const start = performance.now();
    runCase();
    const ms = performance.now() - start;
    assert.ok(ms < 50, `${label}: ${ms.toFixed(1)}ms`);
  }
});

test('a rule keeps its safe declarations and names each refused one', () => {
  const result = carryStaticStyle('.a { color: red; background: url(https://cdn.example.test/x.png); width: 10px }', '[data-page="a"]');
  assert.equal(result.css, '[data-page="a"] .a{color: red;width: 10px}');
  assert.deepEqual(result.dropped, ['background declaration']);
  const all = carryStaticStyle('.a { background-image: url(/x.png) } .b { color: blue }', '[data-page="a"]');
  assert.equal(all.css, '[data-page="a"] .b{color: blue}', 'a rule whose every declaration is refused is left out');
  assert.deepEqual(all.dropped, ['background-image declaration']);
});

test('page sheets carry gradients, 3D transforms, filters, easing curves and content strings', () => {
  const sheet = [
    '.g { background-image: linear-gradient(to top, rgba(0, 0, 0, 0.1) 2%, #fff 100%) }',
    '.w { background-image: -webkit-gradient(linear,left top,left bottom,from(#f8f8f8),to(#f1f1f1)) }',
    '.t { transition: transform 0.35s cubic-bezier(0.56, -0.45, 0.71, 0.85), opacity 0.3s ease-in-out; transform: translate3d(10px,10px,0) scale(1) }',
    '.f { filter: brightness(70%); clip: rect(0px, 75px, 150px, 0px); font: 13px/1.3 \'Lucida Grande\',sans-serif }',
    '.c:before { content: "" } .d:after { content: \'\\f0d7\' } .e:after { content: attr(title) }',
  ].join('\n');
  const result = carryStaticStyle(sheet, '[data-page="a"]');
  assert.deepEqual(result.dropped, []);
  assert.equal(result.css.split('\n').length, 7);
  assert.match(result.css, /\[data-page="a"\] \.g\{background-image: linear-gradient\(to top, rgba\(0, 0, 0, 0\.1\) 2%, #fff 100%\)\}/);
  assert.match(result.css, /\[data-page="a"\] \.d:after\{content: '\\f0d7'\}/);
});

test('sheet-only values still refuse fetches, script, escapes and unknown functions', () => {
  const refused = [
    '.a { background-image: linear-gradient(red, blue), url(https://x.test/a.png) }',
    '.a { background-image: image-set(url(a.png) 1x) }',
    '.a { background-image: linear-gradient(expression(alert(1)), red) }',
    '.a { content: url(https://x.test/a.png) }',
    '.a { content: "<script>" }',
    '.a { content: "\\" }',
    '.a { content: attr(title) url(x) }',
    '.a { transform: rotate(var(--x)) }',
    '.a { filter: progid:DXImageTransform.Microsoft.gradient(enabled=false) }',
    '.a { font: 13px \'Bad\\Name\' }',
    '.a { behavior: linear-gradient(red, blue) }',
  ];
  for (const css of refused) {
    const result = carryStaticStyle(css, '[data-page="a"]');
    assert.equal(result.css, '', css);
    assert.equal(result.droppedRules, 1, css);
  }
});

test('@keyframes are carried with a page-prefixed name and the page animations follow it', () => {
  const result = carryStaticStyle(
    '.spin { animation: turn 2s linear infinite; -webkit-animation-name: turn } @keyframes turn { from { transform: rotate(0deg) } 50%, 75% { opacity: 0.5 } to { transform: rotate(360deg) } } @-webkit-keyframes turn { to { opacity: 1 } }',
    '[data-page="Home"]',
  );
  assert.deepEqual(result.dropped, []);
  assert.equal(
    result.css,
    [
      '[data-page="Home"] .spin{animation: c2c-data-page-Home-turn 2s linear infinite;-webkit-animation-name: c2c-data-page-Home-turn}',
      '@keyframes c2c-data-page-Home-turn{from{transform: rotate(0deg)}50%, 75%{opacity: 0.5}to{transform: rotate(360deg)}}',
      '@-webkit-keyframes c2c-data-page-Home-turn{to{opacity: 1}}',
    ].join('\n'),
  );
  const bad = carryStaticStyle('@keyframes x { .a { color: red } } @keyframes y { to { background: url(https://x.test/a) } } @media print { @keyframes z { to { opacity: 1 } } }', '[data-page="a"]');
  assert.equal(bad.css, '@keyframes c2c-data-page-a-y{}');
  assert.deepEqual(bad.dropped, ['@keyframes', 'background declaration', '@keyframes']);
});

test('@media written without a space before its condition is carried', () => {
  const result = carryStaticStyle('@media(min-width: 992px){ .a { width: 50% } }', '[data-page="a"]');
  assert.equal(result.css, '@media (min-width: 992px){[data-page="a"] .a{width: 50%}}');
  assert.deepEqual(result.dropped, []);
});

test('a page with a scoped rule and an @import carries the rule and counts the @import by name', () => {
  const { styleTodos, scopedCss } = pageModel([
    '<style>@import "https://cdn.example.test/theme.css"; .banner { background-image: linear-gradient(to right, #fff, #eee) }</style><p class="banner">Hi</p>',
  ]);
  assert.equal(scopedCss, '[data-page="Home"] .banner{background-image: linear-gradient(to right, #fff, #eee)}');
  assert.equal(styleTodos.length, 1, JSON.stringify(styleTodos));
  assert.equal(styleTodos[0]!.reason, 'Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (@import)');
});

test('a selector opening with a combinator is refused and counted, so a page cannot style its siblings', () => {
  const escapes = ['~ *', '+ div', '> *', ' ~ nav', '/**/~ *', '/* x */+ div', '\n~ *', '\t> p', '\f+ a'];
  for (const sel of escapes) {
    const result = carryStaticStyle(`${sel} { display: none } .ok { color: red }`, '[data-page="a"]');
    assert.equal(result.css, '[data-page="a"] .ok{color: red}', JSON.stringify(sel));
    assert.deepEqual(result.dropped, ['leading combinator selector'], JSON.stringify(sel));
  }
  for (const list of ['a, ~ *', '.x,+ div', 'p , > *', 'a,/**/~ *', 'a,\n~ *']) {
    const result = carryStaticStyle(`${list} { display: none }`, '[data-page="a"]');
    assert.equal(result.css, '', JSON.stringify(list));
    assert.deepEqual(result.dropped, ['leading combinator selector'], JSON.stringify(list));
  }
  for (const css of ['@media print { ~ * { display: none } }', '@media screen { a, + div { color: red } }']) {
    const result = carryStaticStyle(css, '[data-page="a"]');
    assert.ok(!/\[data-page="a"\]\s*[~+>]/.test(result.css), result.css);
    assert.deepEqual(result.dropped, ['leading combinator selector'], css);
  }
  // Combinators between compound selectors stay inside the scope.
  const inner = carryStaticStyle('.a > .b, .c ~ .d, .e + .f { color: red }', '[data-page="a"]');
  assert.equal(inner.css, '[data-page="a"] .a > .b,[data-page="a"] .c ~ .d,[data-page="a"] .e + .f{color: red}');
  assert.deepEqual(inner.dropped, []);
});

test('an unterminated comment is counted, not dropped silently', () => {
  const result = carryStaticStyle('.a { color: red } /* .b { color: blue }', '[data-page="a"]');
  assert.equal(result.css, '[data-page="a"] .a{color: red}');
  assert.deepEqual(result.dropped, ['unterminated comment']);
  assert.deepEqual(carryStaticStyle('.a { color: red } /* closed */', '[data-page="a"]').dropped, []);
});

test('a form feed inside a content string is refused', () => {
  const result = carryStaticStyle('.a::after { content: "a\fb" } .b::after { content: "ab" }', '[data-page="a"]');
  assert.equal(result.css, '[data-page="a"] .b::after{content: "ab"}');
  assert.deepEqual(result.dropped, ['content declaration']);
});

test('a page name with a long dash run builds its keyframe prefix in linear time', () => {
  const scope = `[data-page="a${'-'.repeat(100_000)}a"]`;
  const started = performance.now();
  const result = carryStaticStyle('@keyframes k { to { opacity: 1 } }', scope);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 50, `${elapsed.toFixed(1)} ms`);
  assert.ok(result.css.startsWith(`@keyframes c2c-data-page-a${'-'.repeat(100_000)}a-k{`), result.css.slice(0, 40));
  assert.ok(carryStaticStyle('@keyframes k { to { opacity: 1 } }', '[data-page="P"]').css.startsWith('@keyframes c2c-data-page-P-k{'));
});
