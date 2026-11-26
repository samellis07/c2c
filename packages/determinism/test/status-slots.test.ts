import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { buildMigrationReport, type MigrationReport } from '../../cli/src/migration-report.js';
import { ALLOWED_TAGS, DROPPED_TAGS } from '../../ui/src/pages.js';
import { publicConstruct, statusFromReport } from '../src/status.js';
import { BACKTICK_LITERALS, FIELD_PROPERTY_KEYS, KNOWN_TAGS } from '../src/slot-redaction.js';

// N1 v3d: the fallback is slot-general. Hostile values are UNDECLARED free text in a real generated app, run through the real
// emitters, buildMigrationReport and statusFromReport (claude review of v3c, L1-L4).
const HOSTILE = ['Zq_Hos10', '秘密_Value', '9lives', 'zq-hos-hyphen', 'zq.hos.dotted'];
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
const leaks = (text: string, name: string): boolean => text.includes(name);
function constructs(rep: MigrationReport): string[] {
  const status = statusFromReport(rep);
  return [...status.kinds.map((k) => k.construct), ...status.perAppConstructSets.flatMap((s) => s.constructs)];
}
function run(source: string): { raw: string[]; pub: string[] } {
  const rep = buildMigrationReport([{ name: 'a', ir: deriveIr(parse(source)) }], 'x');
  return { raw: rep.aggregate.todoKinds.map((k) => k.construct), pub: constructs(rep) };
}
function assertNoLeak(source: string, hostile: string[], needles: RegExp[]): void {
  const { raw, pub } = run(source);
  for (const re of needles) assert.ok(raw.some((c) => re.test(c)), `emitter sentence ${re} must be produced; got ${raw.join(' | ')}`);
  for (const h of hostile) for (const c of pub) assert.equal(leaks(c, h), false, `${h} survived: ${c}`);
}

const fieldApp = (h: string, i: string) => `application "App"
{
	forms
	{
		form Ord
		{
			Photo ( type = image target = ${h}1 aspect ratio = ${h}2 annotation = true )
			Scan1 ( type = image source = camera camera = ${h}3 )
			Vid ( type = video duration = ${h}4 )
			Aud ( type = audio duration = ${h}5 )
			Bar ( type = barcode value = "Pre" + ${h}6 )
			Tm ( type = time timedisplayoptions = HH:mm:ss ${h}7 )
			Pick ( type = picklist displayformat = ${h}8 values = {"A","B"} )
			Pk2 ( type = radiobuttons displayformat = ${h}8b values = {"A","B"} )
			Dt ( type = date alloweddays = ${h}9 )
			Lk ( type = picklist values = Ord.Bar bidirectional = ${i} )
		}
	}
}
`;
for (const [n, h] of HOSTILE.entries()) {
  test(`slot-general L1: undeclared Field property values never reach the status (${h})`, () => {
    // `Lk` carries the back-name; the 10 suffix keeps it distinct from the other values.
    assertNoLeak(fieldApp(h.slice(0, h.length), `${h}10`), [h], [
      /sets `target = /, /sets `aspect ratio = /, /sets `duration = /, /sets `displayformat = /, /allowed weekdays `/, /sets `timedisplayoptions = /,
      /sets `value = /, /bidirectional = /,
    ]);
    void n;
  });
}

const zmlApp = (h: string) => {
  const snip = [`<button text='Go' type='rounded' action='ExecuteFunction' functionName='${h}1.mark' parameters='1' />`, `<image action='${h}2' functionName='${h}3' elementName='Bell' src='https://example.com/bell.png'>`].join('\n');
  const z = `<zml><dsp id='html_snippet'><![CDATA[${snip}]]></dsp></zml>`;
  return `application "App"\n{\n\tforms { form Ord { Name ( type = text ) } }\n\tpages { page P { displayname = "P"\n\t\tContent="${esc(z)}" } }\n}\n`;
};
for (const h of HOSTILE) {
  test(`slot-general L2: ZML click action and calling function never reach the status (${h})`, () => {
    assertNoLeak(zmlApp(h), [h], [/click action ExecuteFunction calling function /, /click action \S+ calling function /]);
  });
}

const typeApp = (h: string) => {
  const z = `<zml><layout><row><column><${h}6 name="Zq_Nm" type="x"/></column></row></layout></zml>`;
  return `application "App"\n{\n\tforms { form Ord { Name ( type = text ) Weird ( type = ${h}5 ) } }\n\treports { ${h}7 Rpt { show all rows from Ord } }\n\tpages { page P { displayname = "P"\n\t\tContent="${esc(z)}" } }\n}\n`;
};
for (const h of HOSTILE) {
  test(`slot-general L3: unknown ZML tag, field type and report type never reach the status (${h})`, () => {
    assertNoLeak(typeApp(h), [h, h.toLowerCase()], [/^No schema mapping for type /]);
  });
}
test('slot-general L3: all three vocabulary sentences are produced and bucketed for a parseable hostile name', () => {
  assertNoLeak(typeApp('Zq_Hos'), ['Zq_Hos', 'zq_hos'], [/^No schema mapping for type /, /^Report type /, /^ZML <[^>]+> has no generated component/]);
});

test('slot-general L3: a hostile lowercase report type and a hostile lowercase ZML tag collapse to one bucket', () => {
  for (const word of ['target', 'value', 'if', 'status']) {
    const z = `<zml><layout><row><column><${word} name="n"/></column></row></layout></zml>`;
    const src = `application "App"\n{\n\tforms { form Ord { Name ( type = text ) } }\n\treports { ${word} Rpt { show all rows from Ord } }\n\tpages { page P { displayname = "P"\n\t\tContent="${esc(z)}" } }\n}\n`;
    const { pub } = run(src);
    for (const c of pub) {
      assert.equal(/^Report type /.test(c) ? c : 'Report type (app identifier) is not generated.', 'Report type (app identifier) is not generated.', c);
      assert.equal(new RegExp(`<${word}>`).test(c) && !KNOWN_TAGS.has(word), false, c);
    }
  }
});

test('slot-general L4: digit-only option-group labels are redacted in every list position', () => {
  const src = (a: string, b: string, c: string) =>
    `application "X"\n{\n\tforms\n\t{\n\t\tform F\n\t\t{\n\t\t\tPick\n\t\t\t(\n\t\t\t\ttype = radiobuttons\n\t\t\t\tvalues = {"${a}" : {"a1"}, "${b}" : {"b1"}, "${c}" : {"c1"}}\n\t\t\t)\n\t\t}\n\t}\n}\n`;
  for (const [a, b, c] of [['2023', '2024', '2025'], ['2023', 'Zq_L', '2024'], ['Zq_L', '2023', '9']] as const) {
    const { pub } = run(src(a, b, c));
    const got = pub.filter((x) => x.includes('groups its options'));
    assert.ok(got.length);
    for (const x of got) assert.match(x, /under \(app identifier\), \(app identifier\), \(app identifier\) in `values`/, x);
  }
});

test('slot-general: dropped style at-rule and inline declaration names never reach the status', () => {
  for (const h of ['Zq_Hos', 'zq-hos', 'zqhos']) {
    const z = `<zml><dsp id='html_snippet'><![CDATA[<style>.a { background: url(javascript:alert(1)) } @${h}_rule x;</style><p style="--${h}_Inline: expression(1); width: expression(1)">Hi</p>]]></dsp></zml>`;
    const src = `application "App"\n{\n\tforms { form Ord { Name ( type = text ) } }\n\tpages { page P { displayname = "P"\n\t\tContent="${esc(z)}" } }\n}\n`;
    const { raw, pub } = run(src);
    assert.ok(raw.some((c) => c.startsWith('Static <style> CSS not carried over')), raw.join(' | '));
    for (const c of pub) assert.equal(c.toLowerCase().includes(h.toLowerCase()), false, c);
  }
});

// Unit: each slot, plus the public vocabulary that must survive (the gallery status doc shows these exact values).
test('publicConstruct slots: public values stay, free text is bucketed', () => {
  const T = (s: string, ids: string[] = []) => publicConstruct(s, ids);
  assert.equal(T('Field Q sets `duration = 150`; v.'), 'Field (app identifier) sets `duration = 150`; v.');
  assert.equal(T('Field Q sets `duration = 30`; v.'), 'Field (app identifier) sets `duration = 30`; v.');
  assert.equal(T('Field Q sets `annotation = true`; v.'), 'Field (app identifier) sets `annotation = true`; v.');
  assert.equal(T('Field Q sets `show onload = true`; v.'), 'Field (app identifier) sets `show onload = true`; v.');
  assert.equal(T('Field Q sets `target = _blank`; v.'), 'Field (app identifier) sets `target = _blank`; v.');
  assert.equal(T('Field Q sets `target = Zq_X`; v.'), 'Field (app identifier) sets `target = (app identifier)`; v.');
  assert.equal(T('Field Q sets `unknown key = 5`; v.'), 'Field (app identifier) sets `(app identifier)`; v.');
  assert.equal(T('Field Q has malformed or duplicate allowed weekdays `Zq`; v.'), 'Field (app identifier) has malformed or duplicate allowed weekdays `(app identifier)`; v.');
  assert.equal(T('Field Q sets `file count = 3`; no `multiple` attribute.'), 'Field (app identifier) sets `file count = 3`; no `multiple` attribute.');
  assert.equal(T('ZML <pc> "Go" click parameters "p=1" are not generated; wire them to the click handler by hand'), 'ZML <pc> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand');
  assert.equal(T('ZML <Zq> has no generated component'), 'ZML <(app identifier)> has no generated component');
  assert.equal(T('ZML <if> has no generated component'), 'ZML <(app identifier)> has no generated component');
  assert.equal(T('ZML <button> click action ExecuteFunction calling function Zq.f is not generated; wire the click to the function by hand'), 'ZML <button> click action ExecuteFunction calling function (app identifier) is not generated; wire the click to the function by hand');
  assert.equal(T('ZML <image> click action Form Zq is not generated; wire the click to the function by hand'), 'ZML <image> click action (app identifier) is not generated; wire the click to the function by hand');
  assert.equal(T('No schema mapping for type (none).'), 'No schema mapping for type (none).');
  assert.equal(T('No schema mapping for type target.'), 'No schema mapping for type (app identifier).');
  assert.equal(T('Report type target is not generated.'), 'Report type (app identifier) is not generated.');
  assert.equal(T('Static <style> CSS not carried over: the page sanitizer drops 2 static style rules or declarations (background declaration, @Zq_at x2, --Zq_prop declaration)'), 'Static <style> CSS not carried over: the page sanitizer drops 2 static style rules or declarations (background declaration, (app identifier) x2, (app identifier))');
  assert.equal(T('Inline style declarations not carried over (unsafe or unsupported CSS): background-image, Zq_Prop'), 'Inline style declarations not carried over (unsafe or unsupported CSS): background-image, (app identifier)');
  assert.equal(T('Shown as a list: if has no exported pivot shelves; rebuild it.'), 'Shown as a list: (app identifier) has no exported pivot shelves; rebuild it.');
  assert.equal(T('Report "R" has a `value` settings block (a = b) that Catalyst generates no equivalent for.'), 'Report (app identifier) has a `(app identifier)` settings block (a = (app identifier)) that Catalyst generates no equivalent for.');
  assert.equal(T('Print template "n" uses a Zq element; the generated print layout does not draw it.'), 'Print template (app identifier) uses a (app identifier) element; the generated print layout does not draw it.');
  assert.equal(T('Embedded zc-component Zq has no generated view'), 'Embedded zc-component (app identifier) has no generated view');
  assert.match(T('Field A is flagged `bidirectional = Zq`; x, and neither A nor Zq.back is one.'), /bidirectional = \(app identifier\)`.*neither \(app identifier\) nor \(app identifier\) is one\./);
});

// The vocabulary is derived from the emitters, not guessed: a new interpolated slot or tag fails here.
test('slot vocabulary covers every emitter slot in packages/ui/src', () => {
  const model = readFileSync(join(repoRoot(), 'packages/ui/src/model.ts'), 'utf8');
  const keys = new Set([...model.matchAll(/sets \\`([a-z ]+?)(?: = |\\`)/g)].map((m) => m[1]!));
  assert.ok(keys.size >= 10, `derived ${[...keys].join(',')}`);
  for (const key of keys) assert.ok(FIELD_PROPERTY_KEYS.has(key), `field property key \`${key}\` is not in FIELD_PROPERTY_KEYS`);
  for (const m of model.matchAll(/ is flagged \\`([a-z ]+) = /g)) assert.ok(FIELD_PROPERTY_KEYS.has(m[1]!), m[1]);
  // Every bare backticked word in a reason is a template literal.
  for (const m of model.matchAll(/reason: `[^`]*?\\`([a-z?=]+)\\`[^`]*?`/g)) {
    assert.ok(BACKTICK_LITERALS.has(m[1]!) || FIELD_PROPERTY_KEYS.has(m[1]!) || m[1] === 'options', `backticked \`${m[1]}\``);
  }
  for (const tag of [...ALLOWED_TAGS, ...DROPPED_TAGS]) assert.ok(KNOWN_TAGS.has(tag), `tag ${tag}`);
  const pages = readFileSync(join(repoRoot(), 'packages/ui/src/pages.ts'), 'utf8');
  for (const m of pages.matchAll(/^const NAMED[^{]*\{([^}]*)\}/gm)) for (const key of m[1]!.matchAll(/^\s*([a-z]+):/gm)) assert.ok(KNOWN_TAGS.has(key[1]!), `NAMED ${key[1]}`);
});
