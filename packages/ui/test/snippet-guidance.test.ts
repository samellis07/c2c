import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildUi, generateUi } from '../src/index.js';
import { SNIPPET_REASONS, serverSnippetGuidance } from '../src/snippet-guidance.js';

const REASON = 'Server-side Deluge snippet requires manual translation';

const xml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function appWith(snippets: Record<string, string>) {
  const field = (name: string, type: string) => `\t\t${name}\n\t\t(\n\t\t\ttype = ${type}\n\t\t)\n`;
  const zml = Object.entries(snippets)
    .map(([name, value]) => `<dspZml name=\\"${name}\\" value=\\"${xml(value)}\\"/>`)
    .join('');
  return deriveIr(
    parse(
      `application "Demo"\n{\n\tform Orders\n\t{\n${field('Total', 'number')}${field('Status', 'text')}${field('Owner', 'text')}\t}\n` +
        `\tpage Home\n\t{\n\t\tContent="<zml><layout><panel>${zml}</panel></layout></zml>"\n\t}\n}\n`,
    ),
  );
}

const SNIPPETS: Record<string, string> = {
  write: '<% insert into Orders [ Status = "x" ]; %>',
  navigation: '<% openUrl("#Form:Orders", "same window"); while (x < 1) { z = 1; } %>',
  callerRead: '<% rows = Orders[Owner == zoho.loginuser]; while (x < 1) { z = 1; } %><b><%= rows.count() %></b>',
  dynamicUrl: '<% u = "https://x.example/" + input.id; %><iframe src="<%= u %>"></iframe>',
  sanitizer: '<% while (x < 1) { z = 1; } %><style>.a { color: red }</style><div style="background-image:url(a.png)">a</div>',
  untranslated: '<% while (x < 1) { z = 1; } %>',
  fieldWrite: '<% r = Orders[ID == 1]; r.Status = "Done"; %><b><%= r.Status %></b>',
};

function todosByName(snippets: Record<string, string>) {
  const { model } = buildUi(appWith(snippets));
  return { zml: model.todos.filter((t) => t.reason === REASON) };
}

test('each counted server snippet gets guidance derived from why it is counted', () => {
  const { model } = buildUi(appWith(SNIPPETS));
  const todos = model.todos.filter((t) => t.area === 'zml' && t.reason === REASON);
  // Anti-laundering: every snippet stays one counted TODO with the fixed reason.
  assert.equal(todos.length, Object.keys(SNIPPETS).length, JSON.stringify(todos.map((t) => t.manualStep?.slice(0, 30))));
  const steps = todos.map((t) => t.manualStep ?? '');
  const reasons = todos.map((t) => t.manualReasons ?? []);
  const byName = new Map(Object.keys(SNIPPETS).map((name) => [name, steps.findIndex((s) => s.startsWith(`snippet ${name} on page Home:`))]));
  for (const [name, i] of byName) assert.ok(i >= 0, `${name} has a located step: ${JSON.stringify(steps)}`);
  const of = (name: string) => reasons[byName.get(name) ?? -1] ?? [];
  const stepOf = (name: string) => steps[byName.get(name) ?? -1] ?? '';

  assert.ok(of('write').includes('write'));
  assert.match(stepOf('write'), /move each write into an explicit, authenticated user action/);
  assert.ok(of('fieldWrite').includes('write'), JSON.stringify(of('fieldWrite')));
  assert.deepEqual(of('navigation').includes('render-navigation') && !of('navigation').includes('write'), true, JSON.stringify(of('navigation')));
  assert.match(stepOf('navigation'), /calls openUrl while the page renders/);
  assert.ok(of('callerRead').includes('caller-read') && !of('callerRead').includes('write'), JSON.stringify(of('callerRead')));
  assert.match(stepOf('callerRead'), /checks the caller's read grant/);
  assert.ok(of('dynamicUrl').includes('dynamic-url') && !of('dynamicUrl').includes('write'), JSON.stringify(of('dynamicUrl')));
  assert.match(stepOf('dynamicUrl'), /fixed allowlisted destination/);
  assert.ok(of('sanitizer').includes('sanitizer-loss'), JSON.stringify(of('sanitizer')));
  assert.match(stepOf('sanitizer'), /sanitizer drops part of its static markup \(<style>, background-image\)/);
  assert.deepEqual(of('untranslated'), ['untranslated']);
  assert.match(stepOf('untranslated'), /no verified translation \(/);
  for (const step of steps) assert.match(step, /Keep this TODO open until the rebuilt section is verified\.$/);
  // Reasons come only from the one exported list, in its order.
  for (const list of reasons) {
    for (const reason of list) assert.ok(SNIPPET_REASONS.includes(reason), reason);
    assert.deepEqual(list, [...list].sort((a, b) => SNIPPET_REASONS.indexOf(a) - SNIPPET_REASONS.indexOf(b)));
  }
});

test('a write-bearing snippet stays counted even when its reads would compile', () => {
  const { zml } = todosByName({ fieldWrite: SNIPPETS.fieldWrite });
  assert.equal(zml.length, 1);
  assert.equal(zml[0]?.reason, REASON);
  assert.ok(zml[0]?.manualReasons?.includes('write'));
});

test('a read-only snippet compiles and gains no TODO or manual step', () => {
  const { model } = buildUi(appWith({ readOnly: '<% x = Orders[ID == 1]; %><b><%= x.Total %></b>' }));
  assert.equal(model.todos.filter((t) => t.reason === REASON).length, 0);
  assert.equal(model.todos.filter((t) => t.manualStep).length, 0);
});

test('guidance is stable and orders reasons the same way every time', () => {
  const source = '<% insert into Orders [ Status = "x" ]; openUrl("#Form:Orders", "same window"); %><script>a()</script>';
  const first = serverSnippetGuidance(source, 'island is not a read-only render', 'snippet S on page P');
  assert.deepEqual(first, serverSnippetGuidance(source, 'island is not a read-only render', 'snippet S on page P'));
  assert.deepEqual(first.reasons, ['write', 'render-navigation', 'sanitizer-loss']);
  assert.match(first.step, /^snippet S on page P: /);
  assert.match(first.step, /\(<script>\)\. Rebuild its script as reviewed client code\./);
  // An insert block is a write, not a caller-scoped read.
  assert.ok(!serverSnippetGuidance('<% insert into Orders [ Owner = zoho.loginuser ]; %>', undefined, 'x').reasons.includes('caller-read'));
  // A request-local input default is not a write.
  assert.ok(!serverSnippetGuidance('<% input.page = 1; while (x < 1) { y = 1; } %>', 'island outside the handled classes', 'x').reasons.includes('write'));
});

test('generated output exports the guided steps next to the counted TODOs', () => {
  const bundle = generateUi(appWith({ write: SNIPPETS.write }));
  const file = bundle.files.find((f) => f.path === 'ui-manual-steps.json');
  assert.ok(file, 'ui-manual-steps.json is generated');
  const { manualSteps } = JSON.parse(String(file.data)) as { manualSteps: { name: string; reason: string; reasons: string[]; step: string }[] };
  assert.equal(manualSteps.length, 1);
  assert.equal(manualSteps[0]?.reason, REASON);
  assert.equal(manualSteps[0]?.name, 'Home.dspZml');
  assert.ok(manualSteps[0]?.reasons.includes('write'));
  for (const reason of manualSteps[0]?.reasons ?? []) assert.ok((SNIPPET_REASONS as readonly string[]).includes(reason), reason);
  const plain = generateUi(appWith({ readOnly: '<% x = Orders[ID == 1]; %><b><%= x.Total %></b>' }));
  assert.equal(plain.files.some((f) => f.path === 'ui-manual-steps.json'), false);
});
