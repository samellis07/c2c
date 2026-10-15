import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { applyLabels } from '../src/decorations/labels.js';
import { buildModel } from '../src/model.js';
import { cleanStyle, sanitizeSnippet as buildSanitize } from '../src/pages.js';
import { cleanPrintStyle } from '../../shims/src/print-template.js';

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
    parse(`application "Demo"\n{\n\tpages\n\t{\n\t\tpage Home\n\t\t{\n\t\t\tdisplayname = "Home"\n\t\t\tContent="${zml.replace(/"/g, '\\"')}"\n\t\t}\n\t}\n}\n`),
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
