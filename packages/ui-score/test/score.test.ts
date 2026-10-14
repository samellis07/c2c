/**
 * The UI scorer is non-vacuous: a faithful bundle passes on desktop and phone,
 * and each kind of damage (no phone tab bar, no labels, a desktop-only
 * stylesheet, a dropped field, no error state, a bundle that does not load)
 * costs the criterion it belongs to and the viewport score.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi } from '../../ui/src/index.js';
import {
  RUBRIC_PATH,
  bundleFromDir,
  bundleFromFiles,
  declared,
  expectedFromIr,
  loadRubric,
  mediaMatches,
  parseCss,
  scoreFileOf,
  scoreUi,
  uiScoreAsText,
  type UiBundle,
  type UiScore,
  type Viewport,
} from '../src/score.js';
import { DOC_BEGIN, DOC_END, galleryDoc, galleryMarkdown, galleryTargets, scoreGallery, tableDigest, type GalleryRow } from '../src/gallery.js';

function field(name: string, type: string, extra = '', modifiers = ''): string {
  const head = modifiers ? `${modifiers} ${name}` : name;
  return `\t\t\t${head}\n\t\t\t(\n\t\t\t\ttype = ${type}\n\t\t\t\tdisplayname = "${name.replace(/_/g, ' ')}"\n${extra}\t\t\t)`;
}

function form(name: string, label: string, body: string): string {
  return `\t\tform ${name}\n\t\t{\n\t\t\tdisplayname = "${label}"\n${body}\n\t\t}`;
}

function list(name: string, label: string, from: string, columns: string[]): string {
  return `\t\tlist ${name}\n\t\t{\n\t\t\tdisplayname = "${label}"\n\t\t\tshow all rows from ${from}\n\t\t\t(\n${columns.map((c) => `\t\t\t\t${c}`).join('\n')}\n\t\t\t)\n\t\t}`;
}

const ORDER = form(
  'Order',
  'New Order',
  [
    field('Title', 'text', '', 'must have'),
    field('Status', 'picklist', '\t\t\t\tvalues = {"Open","Done"}\n', 'must have'),
    field('Due_Date', 'date'),
    field('Notes', 'textarea'),
    field('Photo', 'image'),
  ].join('\n'),
);
const QUOTE = form('Quote', 'New Quote', [field('Customer', 'text', '', 'must have'), field('Amount', 'decimal')].join('\n'));
const PART = form('Part', 'New Part', [field('Part_Name', 'text', '', 'must have'), field('Stock', 'number')].join('\n'));

// Six menu entries across two sections: four tabs on a phone, two behind More.
const SOURCE = `application "Order Desk"\n{\n\tsection Sales\n\t{\n${ORDER}\n${QUOTE}\n${list('All_Orders', 'All Orders', 'Order', ['Title', 'Status', 'Due_Date'])}\n${list('All_Quotes', 'All Quotes', 'Quote', ['Customer', 'Amount'])}\n\t}\n\tsection Stock\n\t{\n${PART}\n${list('All_Parts', 'All Parts', 'Part', ['Part_Name', 'Stock'])}\n\t}\n}\n`;

function app(): App {
  return deriveIr(parse(SOURCE));
}

let goodCache: { bundle: UiBundle; result: UiScore } | undefined;

async function good(): Promise<{ bundle: UiBundle; result: UiScore }> {
  if (!goodCache) {
    const bundle = bundleFromFiles(buildUi(app()).files);
    goodCache = { bundle, result: await scoreUi(app(), bundle) };
  }
  return goodCache;
}

function points(result: UiScore, vp: Viewport, id: string): number {
  return result[vp].criteria.find((c) => c.id === id)!.points;
}

function weight(result: UiScore, vp: Viewport, id: string): number {
  return result[vp].criteria.find((c) => c.id === id)!.weight;
}

function mutate(bundle: UiBundle, part: 'html' | 'css' | 'runtime' | 'model', from: RegExp, to: string): UiBundle {
  const next = bundle[part].replace(from, to);
  assert.notEqual(next, bundle[part], `the ${part} mutation ${from} applies`);
  return { ...bundle, [part]: next };
}

test('rubric: weights sum to 10 on each viewport and the bar is 8', () => {
  const rubric = loadRubric();
  assert.equal(rubric.scale, 10);
  assert.equal(rubric.passBar, 8);
  assert.deepEqual(
    rubric.criteria.map((c) => c.id),
    ['layout', 'navigation', 'forms', 'reports', 'actions', 'states', 'accessibility', 'responsive'],
  );
  const dir = mkdtempSync(join(tmpdir(), 'c2c-rubric-'));
  try {
    const bad = JSON.parse(readFileSync(RUBRIC_PATH, 'utf8')) as { criteria: { weights: Record<string, number> }[] };
    bad.criteria[0]!.weights.phone -= 1;
    writeFileSync(join(dir, 'rubric.json'), JSON.stringify(bad));
    assert.throws(() => loadRubric(join(dir, 'rubric.json')), /phone weights sum to 9/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the scorer reads the Creator source, never the UI generator', () => {
  const src = readFileSync(join(process.cwd(), 'packages/ui-score/src/score.ts'), 'utf8');
  const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.ok(imports.includes('../../core/src/index.js'));
  assert.deepEqual(imports.filter((p) => /\/ui\/|generate|model\.js/.test(p!)), []);
});

test('reference: sections, labels, kinds, mandatory fields and phone columns come from the source', () => {
  const exp = expectedFromIr(app());
  assert.equal(exp.title, 'Order Desk');
  assert.deepEqual(
    exp.sections.map((s) => [s.label, s.items.map((i) => `${i.kind}/${i.name}`)]),
    [
      ['Sales', ['form/Order', 'form/Quote', 'report/All_Orders', 'report/All_Quotes']],
      ['Stock', ['form/Part', 'report/All_Parts']],
    ],
  );
  const order = exp.forms.find((f) => f.name === 'Order')!;
  assert.deepEqual(
    order.fields.map((f) => [f.name, f.kind, f.required]),
    [
      ['Title', 'text', true],
      ['Status', 'choice', true],
      ['Due_Date', 'text', false],
      ['Notes', 'longtext', false],
      ['Photo', 'file', false],
    ],
  );
  assert.deepEqual(exp.reports.find((r) => r.name === 'All_Orders')!.columns.map((c) => c.label), ['Title', 'Status', 'Due Date']);
});

test('stylesheet: media rules apply by width; the last matching declaration wins', () => {
  assert.equal(mediaMatches('(max-width:768px)', 390), true);
  assert.equal(mediaMatches('(max-width:768px)', 1440), false);
  assert.equal(mediaMatches('screen and (min-width: 48rem)', 1440), true);
  assert.equal(mediaMatches('(prefers-reduced-motion:reduce)', 390), false);
  assert.equal(mediaMatches('not all', 390), false);
  assert.equal(mediaMatches('not all', 1440), false);
  // A leading `not` negates the whole query, so `not all and (…)` is a real
  // query that applies whenever the part after it does not: a colour display
  // answers no to (monochrome), and a wide viewport answers no to a max-width.
  assert.equal(mediaMatches('not all and (monochrome)', 390), true);
  assert.equal(mediaMatches('not all and (monochrome)', 1440), true);
  assert.equal(mediaMatches('not all and (max-width:768px)', 390), false);
  assert.equal(mediaMatches('not all and (max-width:768px)', 1440), true);
  assert.equal(mediaMatches('not print', 390), true);
  assert.equal(mediaMatches('not screen', 390), false);
  assert.equal(mediaMatches('(monochrome)', 390), false);
  assert.equal(mediaMatches('(monochrome:0)', 390), true);
  const rules = parseCss('#tabbar{display:none}/* c */@media (max-width:768px){#tabbar{display:flex}#nav{display:none}}');
  assert.equal(declared(rules, 390, '#tabbar', 'display'), 'flex');
  assert.equal(declared(rules, 1440, '#tabbar', 'display'), 'none');
  assert.equal(declared(rules, 1440, '#nav', 'display'), undefined);
});

test('good fixture: a faithful bundle passes on desktop and phone, every criterion checked', async () => {
  const { result } = await good();
  assert.ok(result.desktop.score >= 8, uiScoreAsText(result));
  assert.ok(result.phone.score >= 8, uiScoreAsText(result));
  assert.equal(result.pass, true);
  assert.equal(result.score, Math.min(result.desktop.score, result.phone.score));
  for (const vp of ['desktop', 'phone'] as const) {
    for (const c of result[vp].criteria) assert.ok(c.total > 0, `${vp} ${c.id} ran no check`);
  }
  const file = scoreFileOf(result);
  assert.deepEqual(Object.keys(file), ['score', 'desktop', 'phone', 'pass', 'rubricVersion', 'note']);
});

test('deterministic: the same bundle scores identically twice', async () => {
  const { bundle, result } = await good();
  const again = await scoreUi(app(), bundle);
  assert.deepEqual(again, result);
  assert.equal((globalThis as { CSS?: unknown }).CSS, undefined, 'the page global is removed after scoring');
});

test('bad fixture: no phone tab bar fails phone navigation and the phone bar; desktop still passes', async () => {
  const { bundle, result } = await good();
  const bad = mutate(bundle, 'html', /<nav id="tabbar"[^>]*><\/nav>/, '');
  const scored = await scoreUi(app(), bad);
  assert.equal(points(scored, 'phone', 'navigation'), 0);
  assert.ok(scored.phone.score < 8, uiScoreAsText(scored));
  assert.equal(scored.desktop.score, result.desktop.score);
  assert.equal(scored.pass, false);
});

test('bad fixture: unlabeled controls cost forms and accessibility on both viewports', async () => {
  const { bundle, result } = await good();
  const bad = mutate(bundle, 'runtime', /<label for=/g, '<span data-for=');
  const scored = await scoreUi(app(), bad);
  for (const vp of ['desktop', 'phone'] as const) {
    assert.ok(points(scored, vp, 'forms') < points(result, vp, 'forms'), `${vp} forms`);
    assert.ok(points(scored, vp, 'accessibility') < points(result, vp, 'accessibility'), `${vp} accessibility`);
    assert.ok(scored[vp].score < result[vp].score);
  }
});

test('bad fixture: fields hidden by the stylesheet lose the field checks', async () => {
  const { bundle, result } = await good();
  const scored = await scoreUi(app(), { ...bundle, css: `${bundle.css}\n[data-field]{display:none}` });
  for (const vp of ['desktop', 'phone'] as const) {
    const failures = scored[vp].criteria.find((c) => c.id === 'forms')!.failures;
    assert.ok(failures.some((f) => /Title: hidden/.test(f)), `${vp} reports the hidden field: ${failures.join(' | ')}`);
    assert.ok(points(scored, vp, 'forms') < points(result, vp, 'forms'), `${vp} forms`);
    assert.ok(scored[vp].score < result[vp].score);
  }
});

test('bad fixture: fields hidden only at phone width cost the phone, never the desktop', async () => {
  const { bundle, result } = await good();
  const scored = await scoreUi(app(), { ...bundle, css: `${bundle.css}\n@media (max-width:768px){[data-field]{display:none}}` });
  assert.ok(scored.phone.score < result.phone.score, uiScoreAsText(scored));
  assert.equal(scored.desktop.score, result.desktop.score);
});

test('a stylesheet guarded by @media not all never applies at any width', async () => {
  const { bundle, result } = await good();
  const scored = await scoreUi(app(), { ...bundle, css: `${bundle.css}\n@media not all{[data-field]{display:none}}` });
  for (const vp of ['desktop', 'phone'] as const) {
    assert.equal(scored[vp].score, result[vp].score, `${vp} score unchanged`);
  }
});

test('bad fixture: display:none under a negated media query that applies still costs the checks', async () => {
  const { bundle, result } = await good();
  // `not all and (monochrome)` and `not print` apply on every colour screen;
  // `not all and (max-width:768px)` applies only above 768px.
  const cases: [string, string, Viewport[]][] = [
    ['not all and (monochrome)', '@media not all and (monochrome){[data-field]{display:none}}', ['desktop', 'phone']],
    ['not print', '@media not print{[data-field]{display:none}}', ['desktop', 'phone']],
    ['not all and (max-width:768px)', '@media not all and (max-width:768px){[data-field]{display:none}}', ['desktop']],
  ];
  for (const [name, css, applies] of cases) {
    const scored = await scoreUi(app(), { ...bundle, css: `${bundle.css}\n${css}` });
    for (const vp of ['desktop', 'phone'] as const) {
      if (applies.includes(vp)) {
        const failures = scored[vp].criteria.find((c) => c.id === 'forms')!.failures;
        assert.ok(failures.some((f) => /Title: hidden/.test(f)), `${name} at ${vp}: ${failures.join(' | ')}`);
        assert.ok(scored[vp].score < result[vp].score, `${name} at ${vp} still scores ${scored[vp].score}`);
      } else {
        assert.equal(scored[vp].score, result[vp].score, `${name} must not apply at ${vp}`);
      }
    }
  }
});

test('bad fixture: a report column hidden by the stylesheet loses its column checks', async () => {
  const { bundle, result } = await good();
  const hide = '[data-report] th:nth-child(2),[data-report] td:nth-child(2){display:none}';
  const scored = await scoreUi(app(), { ...bundle, css: `${bundle.css}\n${hide}` });
  const dfail = scored.desktop.criteria.find((c) => c.id === 'reports')!.failures;
  assert.ok(dfail.some((f) => /report All Orders: column "Status"/.test(f)), dfail.join('\n'));
  assert.ok(scored.desktop.score < result.desktop.score);
  // The phone-side column check runs on card cells; make it discriminating by
  // first un-hiding the header row at phone width so the labels render, then
  // hiding the column at that width alone.
  const unhide = '@media (max-width:768px){[data-report] thead{display:table-header-group}}';
  const control = await scoreUi(app(), { ...bundle, css: `${bundle.css}\n${unhide}` });
  const hiddenCol = await scoreUi(app(), { ...bundle, css: `${bundle.css}\n${unhide}\n@media (max-width:768px){${hide}}` });
  const pfail = hiddenCol.phone.criteria.find((c) => c.id === 'reports')!.failures;
  assert.ok(pfail.some((f) => /report All Orders: phone card shows "Status"/.test(f)), pfail.join('\n'));
  assert.ok(hiddenCol.phone.score < control.phone.score, uiScoreAsText(hiddenCol));
  assert.equal(hiddenCol.desktop.score, control.desktop.score);
});

test('bad fixture: a menu link hidden by the stylesheet fails its navigation check', async () => {
  const { bundle, result } = await good();
  const scored = await scoreUi(app(), { ...bundle, css: `${bundle.css}\n#nav a[href="#/form/Quote"]{display:none}` });
  const failures = scored.desktop.criteria.find((c) => c.id === 'navigation')!.failures;
  assert.ok(failures.some((f) => /menu link for form "New Quote" hidden/.test(f)), failures.join('\n'));
  assert.ok(points(scored, 'desktop', 'navigation') < points(result, 'desktop', 'navigation'));
  assert.equal(scored.phone.score, result.phone.score);
});

test('bad fixture: an aria-label alone is not a rendered field label', async () => {
  const { bundle, result } = await good();
  let runtime = bundle.runtime.replace('${label}${fieldControl(field, id)}', '${fieldControl(field, id)}');
  assert.notEqual(runtime, bundle.runtime, 'the field label is dropped from the markup');
  const aria = 'const idAttr = ` id="${id}" aria-label="${escapeHtml(field.label)}"`;';
  runtime = runtime.replace('const idAttr = ` id="${id}"`;', aria);
  assert.ok(runtime.includes(aria), 'the control carries the Creator label as aria-label');
  const scored = await scoreUi(app(), { ...bundle, runtime });
  for (const vp of ['desktop', 'phone'] as const) {
    const failures = scored[vp].criteria.find((c) => c.id === 'forms')!.failures;
    assert.ok(failures.some((f) => /Title: no rendered label/.test(f)), `${vp} reports the missing label: ${failures.join(' | ')}`);
    assert.ok(points(scored, vp, 'forms') < points(result, vp, 'forms'), `${vp} forms`);
    assert.ok(scored[vp].score < result[vp].score);
    // The aria-label still counts as the control's accessible name.
    const names = scored.checks.filter((c) => c.criterion === 'accessibility' && c.id.startsWith('names:') && c.viewport === vp);
    assert.ok(names.length > 0 && names.every((c) => c.pass), `${vp} accessible names unaffected`);
  }
});

test('bad fixture: a desktop-only stylesheet fails phone responsiveness and navigation', async () => {
  const { bundle, result } = await good();
  const bad = mutate(bundle, 'css', /@media \(max-width:768px\)\{[\s\S]*?\n\}\n/, '');
  const scored = await scoreUi(app(), bad);
  assert.equal(points(result, 'phone', 'responsive'), weight(result, 'phone', 'responsive'));
  assert.ok(points(scored, 'phone', 'responsive') < weight(result, 'phone', 'responsive'), uiScoreAsText(scored));
  // The tab bar the stylesheet keeps hidden offers no navigation on a phone.
  assert.equal(points(scored, 'phone', 'navigation'), 0);
  assert.ok(scored.phone.score < 8);
  assert.equal(scored.desktop.score, result.desktop.score);
});

test('bad fixture: a Creator field the bundle drops is missing from the form', async () => {
  const { bundle, result } = await good();
  const bad = mutate(bundle, 'model', /"name":"Due_Date"/, '"name":"Due_Date_Gone"');
  const scored = await scoreUi(app(), bad);
  const failures = scored.desktop.criteria.find((c) => c.id === 'forms')!.failures;
  assert.ok(failures.includes('form New Order / Due Date: missing'), failures.join('\n'));
  assert.ok(points(scored, 'desktop', 'forms') < points(result, 'desktop', 'forms'));
});

test('bad fixture: a report with no error state loses the states criterion', async () => {
  const { bundle, result } = await good();
  const bad = mutate(bundle, 'runtime', /<div data-state="error" role="alert">/, '<div data-state="failed">');
  const scored = await scoreUi(app(), bad);
  const failures = scored.desktop.criteria.find((c) => c.id === 'states')!.failures;
  assert.ok(failures.some((f) => /error missing/.test(f)), failures.join('\n'));
  assert.ok(points(scored, 'desktop', 'states') < points(result, 'desktop', 'states'));
});

test('bad fixture: a bundle whose runtime does not load fails both viewports', async () => {
  const { bundle } = await good();
  const scored = await scoreUi(app(), { ...bundle, runtime: '' });
  assert.ok(scored.desktop.score < 8 && scored.phone.score < 8, uiScoreAsText(scored));
  assert.equal(scored.pass, false);
});

/**
 * A build whose emitted code splits shared code out of the entry module, the
 * way a bundled app emits sibling chunks: the entry statically imports a
 * shared chunk and dynamically imports a lazy one, and the chunks import the
 * entry's helpers back. The whole bundle still scores end to end.
 */
function chunked(bundle: UiBundle): UiBundle {
  const shared = 'export const sentinel = "shared chunk loaded";\nexport const marker = "lazy-ok";\n';
  const lazy = 'export const marker = "lazy-ok";\n';
  const runtime = bundle.runtime
    .replace(
      /^(import \{ model \} from "[^"]+";)/m,
      '$1\nimport { sentinel } from "./shared.00000000.js";\nimport("./lazy.00000000.js");',
    )
    .concat('\nif (sentinel !== "shared chunk loaded") throw new Error("the shared chunk did not load");\n');
  assert.notEqual(runtime, bundle.runtime, 'the chunked entry rewrites apply');
  const modules = {
    ...bundle.modules,
    'assets/shared.00000000.js': shared,
    'assets/lazy.00000000.js': lazy,
  };
  return { ...bundle, runtime, modules };
}

test('a bundle split into shared and lazy chunks scores like the single-module one', async () => {
  const { bundle, result } = await good();
  const scored = await scoreUi(app(), chunked(bundle));
  assert.deepEqual(scored, result, uiScoreAsText(scored));
});

test('bad fixture: a shared chunk that breaks at load costs the layout check, so the chunk really ran', async () => {
  const { bundle } = await good();
  const broken = chunked(bundle);
  broken.modules = { ...broken.modules, 'assets/shared.00000000.js': 'export const sentinel = "wrong";\n' };
  const scored = await scoreUi(app(), broken);
  const layout = scored.desktop.criteria.find((c) => c.id === 'layout')!;
  assert.ok(layout.failures.some((f) => /the shared chunk did not load/.test(f)), layout.failures.join('\n'));
});

test('bad fixture: an import that escapes the bundle is still rejected', async () => {
  const { bundle } = await good();
  const cases: [string, RegExp][] = [
    ['./missing.00000000.js', /not part of the bundle/],
    ['../../outside.js', /outside the bundle|not part of the bundle/],
    ['https://elsewhere.test/mod.js', /outside the bundle|not part of the bundle/],
  ];
  for (const [spec, want] of cases) {
    const runtime = bundle.runtime.replace(/^(import \{ model \} from "[^"]+";)/m, `$1\nimport { missing } from "${spec}";`);
    const scored = await scoreUi(app(), { ...bundle, runtime });
    const layout = scored.desktop.criteria.find((c) => c.id === 'layout')!;
    assert.ok(layout.failures.some((f) => want.test(f)), `${spec}: ${layout.failures.join('\n')}`);
    assert.equal(scored.pass, false);
  }
});

// The bundle runs in the page's own realm, as in a browser: code that runs
// when a module loads already sees window, document and getComputedStyle.
function atImport(bundle: UiBundle, code: string): UiBundle {
  return mutate(bundle, 'runtime', /^(import [^\n]*\n)/, `$1${code}\n`);
}

test('realm: a bundle that reads document and getComputedStyle when it loads boots and scores as usual', async () => {
  const { bundle, result } = await good();
  const reads = atImport(
    bundle,
    [
      'const rootDisplay = getComputedStyle(document.documentElement).display;',
      'const watcher = new MutationObserver(() => {});',
      'watcher.observe(document.documentElement, { childList: true });',
      "if (typeof rootDisplay !== 'string' || window.document !== document) throw new Error('no page at load');",
    ].join('\n'),
  );
  const scored = await scoreUi(app(), reads);
  assert.deepEqual(scored, result, uiScoreAsText(scored));
});

test('realm: a dialog behind a layout-effect shim chosen when the module loads opens on phone', async () => {
  // A component library picks its layout effect when it is imported: the real
  // one when a document exists, a no-op otherwise. Loaded without a page, the
  // dialog never opens; loaded in the page, it opens as in a browser.
  const { bundle, result } = await good();
  const shim = atImport(bundle, 'const useLayoutEffect = globalThis?.document ? (effect) => effect() : () => {};');
  const lib = mutate(shim, 'runtime', /\n(\s*)sheet\.hidden = !open;/, '\n$1useLayoutEffect(() => { sheet.hidden = !open; });');
  const scored = await scoreUi(app(), lib);
  const nav = scored.phone.criteria.find((c) => c.id === 'navigation')!;
  assert.deepEqual(nav.failures, [], uiScoreAsText(scored));
  assert.equal(points(scored, 'phone', 'navigation'), points(result, 'phone', 'navigation'));
  assert.deepEqual(scored, result);
});

test('realm: each session loads the bundle afresh and leaves no globals behind', async () => {
  // Module state that a second boot would trip over, and a global the module
  // sets: neither may carry from one session to the next or onto the host.
  const { bundle, result } = await good();
  const counted = atImport(bundle, 'let bootCount = 0;\nglobalThis.c2cPageLoaded = (globalThis.c2cPageLoaded ?? 0) + 1;\nif (globalThis.c2cPageLoaded > 1) throw new Error("a previous session leaked");');
  const once = mutate(counted, 'runtime', /if \(!documentRef \|\| !appModel\) return;/, 'if (!documentRef || !appModel || ++bootCount > 1) return;');
  const host = globalThis as { c2cPageLoaded?: unknown };
  try {
    const scored = await scoreUi(app(), once);
    assert.deepEqual(scored, result, uiScoreAsText(scored));
    assert.equal(host.c2cPageLoaded, undefined, 'the page global stays on the page');
  } finally {
    delete host.c2cPageLoaded;
  }
});

test('realm: the runtime sees import.meta.url as its address on the page', async () => {
  const { bundle, result } = await good();
  const meta = atImport(bundle, "if (!/^https:\\/\\/app\\.example\\.test\\/.+\\.js$/.test(import.meta.url)) throw new Error('import.meta.url ' + import.meta.url);");
  assert.deepEqual(await scoreUi(app(), meta), result);
});

test('bad fixture: a runtime that throws while it loads fails both viewports with the error', async () => {
  const { bundle } = await good();
  const scored = await scoreUi(app(), atImport(bundle, "throw new Error('boom at load');"));
  assert.equal(scored.pass, false);
  const layout = scored.desktop.criteria.find((c) => c.id === 'layout')!;
  assert.ok(layout.failures.some((f) => /boom at load/.test(f)), layout.failures.join('\n'));
});

test('bundleFromDir reads what c2c ui writes: the page, its stylesheet, runtime and model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-ui-score-'));
  try {
    const files = buildUi(app()).files;
    for (const f of files) {
      if (!f.path.startsWith('slate/')) continue;
      const dest = join(dir, f.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.data);
    }
    assert.deepEqual(bundleFromDir(dir), bundleFromFiles(files));
    assert.deepEqual(bundleFromDir(join(dir, 'slate')), bundleFromFiles(files));
    assert.throws(() => bundleFromDir(join(dir, 'nothing-here')), /index\.html not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gallery table: numbered rows and counts only, no app, form, field or report names', async () => {
  const { result } = await good();
  const rubric = loadRubric();
  const body = galleryMarkdown([{ index: 1, result }, { index: 2, error: 'TypeError' }], rubric);
  for (const name of ['Order Desk', 'New Order', 'All Orders', 'Due Date', 'Part_Name', 'Sales']) assert.ok(!body.includes(name), `${name} leaked`);
  assert.match(body, /\| 1 \| \d+(\.\d)? \| \d+(\.\d)? \| pass \|/);
  assert.match(body, /\| 2 \| - \| - \| not scored \(TypeError\) \|/);
  const doc = galleryDoc(body, rubric);
  assert.ok(doc.includes(`${DOC_BEGIN} table=${tableDigest(body)} -->\n${body}${DOC_END}`));
});

test('gallery targets: sorted sub-folders holding a .ds and loose .ds files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-ui-gallery-'));
  try {
    for (const d of ['b-app', 'a-app', 'empty']) mkdirSync(join(dir, d));
    writeFileSync(join(dir, 'b-app', 'B.ds'), SOURCE);
    writeFileSync(join(dir, 'a-app', 'A.ds'), SOURCE);
    writeFileSync(join(dir, 'c.ds'), SOURCE);
    assert.deepEqual(galleryTargets(dir), ['a-app', 'b-app', 'c.ds'].map((n) => join(dir, n)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('docs/ui-scores.md: the committed gallery table matches its digest (no hand edits)', () => {
  const doc = readFileSync(join(process.cwd(), 'docs/ui-scores.md'), 'utf8');
  const begin = doc.indexOf(DOC_BEGIN);
  const end = doc.indexOf(DOC_END);
  assert.ok(begin >= 0 && end > begin, 'generated block present');
  const marker = doc.slice(begin, doc.indexOf('-->', begin) + 3);
  const body = doc.slice(begin + marker.length + 1, end);
  assert.equal(marker, `${DOC_BEGIN} table=${tableDigest(body)} -->`);
  assert.ok(doc.startsWith(galleryDoc(body, loadRubric()).slice(0, doc.indexOf(DOC_BEGIN))), 'prose and rubric table current');
});

test('a record opens from any rendered activatable element, including a focusable row', async () => {
  // The enhanced view draws each row focusable: a tap on the row opens the
  // record. A custom-action button in a cell hidden at phone width is not the
  // only way in, so the record check must not take the first inner match.
  const source = `application "Order Desk"\n{\n\tsection Sales\n\t{\n${ORDER}\n${list('All_Orders', 'All Orders', 'Order', ['Title', 'Status', 'Due_Date', 'Notes', 'custom action "Approve"\n\t\t\t\t(\n\t\t\t\t\tcolumn header = "Approve"\n\t\t\t\t)'])}\n\t}\n}\n`;
  const fixture = deriveIr(parse(source));
  const bundle = bundleFromFiles(buildUi(fixture).files);
  const scored = await scoreUi(fixture, bundle);
  const record = (vp: Viewport) => scored.checks.find((c) => c.id === 'record:All_Orders' && c.viewport === vp);
  assert.ok(record('desktop')?.pass, `desktop record: ${record('desktop')?.evidence}`);
  assert.ok(record('phone')?.pass, `phone record: ${record('phone')?.evidence}`);
  // The column cell is still hidden on a phone. The card footer is where the
  // action check finds the Approve button.
  const action = scored.checks.find((c) => c.id === 'action:All_Orders.Approve' && c.viewport === 'phone');
  assert.equal(action?.pass, true, `the phone card footer shows the action: ${action?.evidence}`);
  // A row with no activatable element rendered at that width still fails.
  // Hide the footer as well as the focusable row, so only the hidden cell button is left.
  const runtime = bundle.runtime.replace('tr.tabIndex = 0;', '');
  const css = `${bundle.css}\n[data-report] tr[data-card] td[data-card-actions]{display:none}`;
  assert.notEqual(runtime, bundle.runtime, 'the row is no longer focusable');
  const noOpener = await scoreUi(fixture, { ...bundle, runtime, css });
  const phoneFail = noOpener.checks.find((c) => c.id === 'record:All_Orders' && c.viewport === 'phone');
  const desktopPass = noOpener.checks.find((c) => c.id === 'record:All_Orders' && c.viewport === 'desktop');
  assert.equal(phoneFail?.pass, false, `a row whose only opener is hidden fails: ${phoneFail?.evidence}`);
  assert.ok(desktopPass?.pass, 'the same row still opens on desktop');
});

test('a file control hidden from sight still counts when a rendered label activates it', async () => {
  const { result } = await good();
  for (const vp of ['desktop', 'phone'] as const) {
    const control = result.checks.find((c) => c.id === 'control:Order.Photo' && c.viewport === vp);
    assert.ok(control?.pass, `${vp}: ${control?.evidence}`);
  }
});

test('bad fixture: a label whose text is not rendered is not a rendered label', async () => {
  const { bundle, result } = await good();
  const runtime = bundle.runtime.replace('for="${groupLabelFor(field, id)}">${escapeHtml(field.label)}', 'for="${groupLabelFor(field, id)}"><span hidden>${escapeHtml(field.label)}</span>');
  assert.notEqual(runtime, bundle.runtime, 'the label text moves inside a hidden span');
  const scored = await scoreUi(app(), { ...bundle, runtime });
  for (const vp of ['desktop', 'phone'] as const) {
    const labels = scored.checks.filter((c) => c.id.startsWith('label:') && c.viewport === vp);
    assert.ok(labels.length > 0 && labels.every((c) => !c.pass), `${vp}: every field label must fail`);
    assert.ok(points(scored, vp, 'forms') < points(result, vp, 'forms'), `${vp} forms`);
    // The label elements still exist, so accessible names are unaffected.
    const names = scored.checks.filter((c) => c.criterion === 'accessibility' && c.id.startsWith('names:') && c.viewport === vp);
    assert.ok(names.length > 0 && names.every((c) => c.pass), `${vp} accessible names unaffected`);
  }
});

test('bad fixture: a heading whose text is not rendered fails the form and report checks', async () => {
  const { bundle } = await good();
  const runtime = bundle.runtime
    .replace('<h1>${escapeHtml(form.label || form.name)}</h1>', '<h1><span hidden>${escapeHtml(form.label || form.name)}</span></h1>')
    .replaceAll('<h1>${escapeHtml(report.label || report.name)}</h1>', '<h1><span hidden>${escapeHtml(report.label || report.name)}</span></h1>');
  assert.notEqual(runtime, bundle.runtime, 'the heading text moves inside a hidden span');
  const scored = await scoreUi(app(), { ...bundle, runtime });
  for (const vp of ['desktop', 'phone'] as const) {
    assert.equal(scored.checks.find((c) => c.id === 'form:Order' && c.viewport === vp)?.pass, false, `${vp} form heading`);
    assert.equal(scored.checks.find((c) => c.id === 'report:All_Orders' && c.viewport === vp)?.pass, false, `${vp} report heading`);
  }
});

test('a declared tiny size that still paints is not hidden', async () => {
  const { bundle, result } = await good();
  const cases: [string, string][] = [
    // The ratio-box idiom: overflow clips at the padding box, so a zero
    // content height with real padding still paints its area.
    ['height 0 carried by padding-bottom', '[data-field]{height:0;padding-bottom:56.25%;overflow:hidden}'],
    // min-height wins over both height and max-height.
    ['height 0 with a real min-height', '[data-field]{height:0;min-height:40px;overflow:hidden}'],
    // A growing flex item's main-axis size comes from the flex algorithm,
    // not from width — the tab bar's links all carry flex:1 1 0.
    ['a flex child sized by flex-grow', '#tabbar a{width:0;overflow:hidden}'],
    ['a column-direction flex child grown by flex', '[data-field] label{flex:1;height:0;overflow:hidden}'],
  ];
  for (const [name, css] of cases) {
    const scored = await scoreUi(app(), { ...bundle, css: `${bundle.css}\n${css}` });
    for (const vp of ['desktop', 'phone'] as const) {
      assert.equal(scored[vp].score, result[vp].score, `${name} at ${vp}`);
    }
  }
});

test('bad fixture: elements hidden by paint-level tricks fail the checks they hide', async () => {
  const { bundle, result } = await good();
  const cases: [string, string, RegExp][] = [
    ['opacity:0', '[data-field]{opacity:0}', /Title: hidden/],
    ['the visually-hidden clip', '[data-field] label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0)}', /Title: label hidden/],
    ['a zero-size clipped box', '[data-field]{width:0;height:0;overflow:hidden}', /Title: hidden/],
    ['offscreen positioning', '[data-field]{position:absolute;left:-9999px}', /Title: hidden/],
    ['clip-path', '[data-field] label{clip-path:inset(50%)}', /Title: label hidden/],
    ['transparent text', '[data-field] label{color:transparent;font-size:0}', /Title: label ""/],
    ['transform scale 0', '[data-field]{transform:scale(0)}', /Title: hidden/],
    ['transform scale(0,0)', '[data-field]{transform:scale(0,0)}', /Title: hidden/],
    ['transform scaleX(0)', '[data-field]{transform:scaleX(0)}', /Title: hidden/],
    ['transform scaleY(0)', '[data-field]{transform:scaleY(0)}', /Title: hidden/],
    ['a near-zero scale', '[data-field]{transform:scale(.001)}', /Title: hidden/],
    ['a zero matrix', '[data-field]{transform:matrix(0,0,0,0,0,0)}', /Title: hidden/],
    ['a single-axis zero matrix', '[data-field]{transform:matrix(0,0,0,1,0,0)}', /Title: hidden/],
    ['max-height 0 overflow hidden', '[data-field]{max-height:0;overflow:hidden}', /Title: hidden/],
    ['text-indent offscreen', '[data-field] label{text-indent:-9999px}', /Title: label hidden/],
    ['text-indent in viewport units', '[data-field] label{text-indent:-100vw}', /Title: label hidden/],
    ['fractional opacity', '[data-field]{opacity:0.0001}', /Title: hidden/],
  ];
  for (const [name, css, want] of cases) {
    const scored = await scoreUi(app(), { ...bundle, css: `${bundle.css}\n${css}` });
    for (const vp of ['desktop', 'phone'] as const) {
      const failures = scored[vp].criteria.find((c) => c.id === 'forms')!.failures;
      assert.ok(failures.some((f) => want.test(f)), `${name} at ${vp}: ${failures.join(' | ')}`);
      assert.ok(scored[vp].score < result[vp].score, `${name} at ${vp} still scores ${scored[vp].score}`);
    }
    if (name === 'the visually-hidden clip') {
      // A visually-hidden label still names its control for assistive tech.
      const names = scored.checks.filter((c) => c.criterion === 'accessibility' && c.id.startsWith('names:'));
      assert.ok(names.length > 0 && names.every((c) => c.pass), 'a clipped label still gives an accessible name');
    }
  }
});

test('good fixture: a form with name + address + phone + email fields', async () => {
  const source = `application "Fixture One" {
    section Main {
        form Contact {
            displayname = "Contact"
            Name (
                type = name
                displayname = "Name"
            )
            Address (
                type = address
                displayname = "Address"
            )
            Phone (
                type = phonenumber
                displayname = "Phone"
            )
            Email (
                type = email
                displayname = "Email"
            )
        }
    }
  }`;
  const appIr = deriveIr(parse(source));
  const bundle = bundleFromFiles(buildUi(appIr).files);
  const result = await scoreUi(appIr, bundle);
  assert.equal(result.desktop.score, 10, uiScoreAsText(result));
  assert.equal(result.phone.score, 10, uiScoreAsText(result));
});

test('good fixture: a form with a subform (3 columns)', async () => {
  const source = `application "Fixture Two" {
    section Main {
        form Parent {
            displayname = "Parent"
            Title (
                type = text
                displayname = "Title"
            )
            Children (
                type = grid
                displayname = "Children"
                Col1 (
                    type = text
                    displayname = "Col 1"
                )
                Col2 (
                    type = number
                    displayname = "Col 2"
                )
                Col3 (
                    type = date
                    displayname = "Col 3"
                )
            )
        }
    }
  }`;
  const appIr = deriveIr(parse(source));
  const bundle = bundleFromFiles(buildUi(appIr).files);
  const result = await scoreUi(appIr, bundle);
  assert.equal(result.desktop.score, 10, uiScoreAsText(result));
  assert.equal(result.phone.score, 10, uiScoreAsText(result));
});

test('good fixture: a report with 6 columns incl. a lookup and a currency column', async () => {
  const source = `application "Fixture Three" {
    section Main {
        form Dummy {
            displayname = "Dummy"
            Col1 (
                type = text
                displayname = "Col1"
            )
            Col2 (
                type = lookup
                displayname = "Col2"
                values = Dummy.Col1
            )
            Col3 (
                type = USD
                displayname = "Col3"
            )
            Col4 (
                type = number
                displayname = "Col4"
            )
            Col5 (
                type = date
                displayname = "Col5"
            )
            Col6 (
                type = text
                displayname = "Col6"
            )
        }
        list Report {
            displayname = "Report"
            show all rows from Dummy
            (
                Col1
                Col2
                Col3
                Col4
                Col5
                Col6
            )
        }
    }
  }`;
  const appIr = deriveIr(parse(source));
  const bundle = bundleFromFiles(buildUi(appIr).files);
  const result = await scoreUi(appIr, bundle);
  assert.equal(result.desktop.score, 10, uiScoreAsText(result));
  assert.equal(result.phone.score, 10, uiScoreAsText(result));
});

test('good fixture: a phone layout with a tab bar + More holding 7 sections', async () => {
  const source = `application "Fixture Four" {
    section Sec1 { form F1 { displayname="F1" F (type=text) } }
    section Sec2 { form F2 { displayname="F2" F (type=text) } }
    section Sec3 { form F3 { displayname="F3" F (type=text) } }
    section Sec4 { form F4 { displayname="F4" F (type=text) } }
    section Sec5 { form F5 { displayname="F5" F (type=text) } }
    section Sec6 { form F6 { displayname="F6" F (type=text) } }
    section Sec7 { form F7 { displayname="F7" F (type=text) } }
  }`;
  const appIr = deriveIr(parse(source));
  const bundle = bundleFromFiles(buildUi(appIr).files);
  const result = await scoreUi(appIr, bundle);
  assert.equal(result.desktop.score, 10, uiScoreAsText(result));
  assert.equal(result.phone.score, 10, uiScoreAsText(result));
});

test('good fixture: a single-column report (empty and error states exercised)', async () => {
  const source = `application "Fixture Five" {
    section Main {
        form Dummy {
            displayname = "Dummy"
            Col (
                type = text
                displayname = "Col"
            )
        }
        list Report {
            displayname = "Report"
            show all rows from Dummy
            (
                Col
            )
        }
    }
  }`;
  const appIr = deriveIr(parse(source));
  const bundle = bundleFromFiles(buildUi(appIr).files);
  const result = await scoreUi(appIr, bundle);
  assert.equal(result.desktop.score, 10, uiScoreAsText(result));
  assert.equal(result.phone.score, 10, uiScoreAsText(result));
});

test('gallery react mode on a fixture app produces scores', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-react-gallery-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'fixture.ds'), SOURCE);
  const rows = await scoreGallery(dir, { ui: 'react' });
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.result, 'result produced');
  assert.ok(rows[0]!.react, 'react score produced');
  assert.ok(typeof rows[0]!.react!.desktop.score === 'number');
  assert.ok(typeof rows[0]!.react!.phone.score === 'number');
  assert.ok(rows[0]!.react!.desktop.score > 0);
  assert.ok(rows[0]!.react!.phone.score > 0);
});

test('doc renderer emits both columns deterministically', async () => {
  const { result } = await good();
  const rubric = loadRubric();
  const reactResult: UiScore = {
    ...result,
    desktop: { ...result.desktop, score: 9.5 },
    phone: { ...result.phone, score: 9.0 },
    pass: true,
  };
  const rows: GalleryRow[] = [
    { index: 1, vanilla: result, react: reactResult, result: reactResult },
    { index: 2, error: 'TypeError', reactError: 'Error' },
  ];
  const first = galleryMarkdown(rows, rubric);
  const second = galleryMarkdown(rows, rubric);
  assert.equal(first, second, 'emits deterministically');
  assert.ok(first.includes('| # | desktop | phone | react | result | short on desktop | short on phone |'), 'table header has react column alongside desktop and phone');
  assert.match(first, /\| 1 \| \d+(\.\d)? \| \d+(\.\d)? \| 9\.5 \/ 9 \| pass \|/);
  assert.match(first, /apps >= 8 desktop and phone/);
});
