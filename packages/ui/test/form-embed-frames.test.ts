/**
 * A frame of one of the app's own forms whose address carries parameters
 * (`<%=zoho.appuri%>form-embed/<Form>?zc_Header=false&Field=<%=input.p%>`)
 * draws the form inline, prefilled: it compiles to the same parameterised
 * embed a `zc-component` div does, so the embed grammar (declared fields, one
 * bare read per value, no lookup key) is the only gate.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi } from '../src/index.js';
import { compileHtmlpage } from '../src/htmlpage.js';

const FORM = `form Intake
{
  Name
  (
    type = text
  )
  Parent
  (
    type = picklist
    values = Intake.Name
  )
}`;

function appOf(): App {
  return deriveIr(parse(`application "Demo"
{
	section Front
	{
${FORM}
		page Outer(who, other)
		{
			Content="<zml><layout><panel><text value='x'/></panel></layout></zml>"
		}
	}
}
`));
}

const frame = (src: string, attrs = ` name='zohoview' height='400' width='100%' frameborder='0' scrolling='Auto'`) => `htmlpage Outer1()
content
<%{
 %>
<div><iframe${attrs} src='${src}'>
 </iframe></div>
<%
}%>`;

const compile = (snippet: string) => compileHtmlpage(appOf(), 'Outer', 'dsp', snippet);

test('a form frame with page inputs compiles to the parameterised form embed, sized as the frame was', () => {
  const out = compile(frame('<%=zoho.appuri%>form-embed/Intake/zc_Header=false&Name=<%=input.who%> '));
  assert.equal(out.ok, true, out.reason ?? 'compile failed');
  assert.deepEqual(out.components, [{ kind: 'form', name: 'Intake', params: ['Name'] }]);
  const source = out.file?.source ?? '';
  // The marker's value is computed per render from the page input, form-encoded, then escaped as one attribute value.
  assert.match(source, /data-zml=\\"component-form:Intake:untitled\?Name=";/);
  assert.match(source, /shim\.string\.encodeUrl\(shim\.input\.get\(ctx, "who"\)\)/);
  assert.match(source, /style=\\"width:100%;height:400px\\"/);
  assert.doesNotMatch(source, /<iframe|form-embed/i);
});

test('the query may follow a question mark as well as a slash', () => {
  const out = compile(frame('<%=zoho.appuri%>form-embed/Intake?Name=<%=input.other%>'));
  assert.equal(out.ok, true, out.reason ?? 'compile failed');
  assert.deepEqual(out.components, [{ kind: 'form', name: 'Intake', params: ['Name'] }]);
});

test('a frame the embed cannot reproduce stays counted', () => {
  const cases: [string, string, string?][] = [
    ['an undeclared page input', frame('<%=zoho.appuri%>form-embed/Intake?Name=<%=input.missing%>')],
    ['a lookup key set from a text read', frame('<%=zoho.appuri%>form-embed/Intake?Parent=<%=input.who.toString()%>')],
    ['a repeated key', frame('<%=zoho.appuri%>form-embed/Intake?Name=<%=input.who%>&name=<%=input.other%>')],
    ['a value that is not one bare read', frame('<%=zoho.appuri%>form-embed/Intake?Name=a<%=input.who%>')],
    ['a form the app does not have', frame('<%=zoho.appuri%>form-embed/Nope?Name=<%=input.who%>')],
    ['another host', frame('https://example.org/form-embed/Intake?Name=<%=input.who%>')],
    ['a visible default border', frame('<%=zoho.appuri%>form-embed/Intake?Name=<%=input.who%>', ` height='400'`)],
    ['scrolling off', frame('<%=zoho.appuri%>form-embed/Intake?Name=<%=input.who%>', ` frameborder='0' scrolling='no'`)],
    ['an island in another attribute', frame('<%=zoho.appuri%>form-embed/Intake?Name=<%=input.who%>', ` frameborder='0' class='<%=input.who%>'`)],
    ['a size that is not a length', frame('<%=zoho.appuri%>form-embed/Intake?Name=<%=input.who%>', ` frameborder='0' width='calc(1px)'`)],
    ['a quote in the query', frame('<%=zoho.appuri%>form-embed/Intake?Name="x"')],
  ];
  for (const [label, snippet] of cases) {
    const out = compile(snippet);
    assert.ok(out.ok === false || out.components === undefined, label);
    assert.notEqual(out.components?.length, 1, label);
  }
});

test('a lookup field takes the caller\'s page input, a row id Creator hands the lookup unchanged, and nothing else', () => {
  const ok = compile(frame('<%=zoho.appuri%>form-embed/Intake?Parent=<%=input.who%>'));
  assert.equal(ok.ok, true, ok.reason ?? 'compile failed');
  assert.deepEqual(ok.components, [{ kind: 'form', name: 'Intake', params: ['Parent'] }]);
  assert.match(ok.file?.source ?? '', /shim\.string\.encodeUrl\(shim\.input\.get\(ctx, "who"\)\)/);
  for (const value of ['Parent=open', 'Parent=<%=input.who.toString()%>', 'Parent=<%=row.Name%>', 'Parent=<%=input.missing%>']) {
    const out = compile(frame(`<%=zoho.appuri%>form-embed/Intake?${value}`));
    assert.ok(out.ok === false || out.components === undefined, value);
  }
});

test('the lookup marker selects the option whose value is that row id once the options have loaded', async () => {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value };
  const runtime = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as { boot(model: unknown, doc: unknown): Promise<void> };
  const zml = `<zml><layout><row><column width='100%'><dsp id='Outer1'><![CDATA[${frame('<%=zoho.appuri%>form-embed/Intake?Parent=<%=input.who%>')}]]></dsp></column></row></layout></zml>`;
  const app = deriveIr(parse(`application "Demo"
{
	section Front
	{
${FORM}
		page Outer(who)
		{
			Content=${JSON.stringify(zml)}
		}
	}
}
`));
  const { model } = buildUi(app);
  assert.deepEqual(model.todos.filter((todo) => todo.area === 'zml'), []);
  const dom = new JSDOM('<!doctype html><body><main id="main"></main></body>', { url: 'http://localhost/app/index.html#/page/Outer' });
  (dom.window as unknown as { fetch: unknown }).fetch = async (url: string) => {
    const body = url.includes('htmlpages')
      ? { html: '<div data-zml="component-form:Intake:untitled?Parent=7"></div>' }
      : url.includes('lookup')
        ? { rows: [{ ROWID: '6', Name: 'Ann' }, { ROWID: '7', Name: 'Bo' }], field: 'Name' }
        : { rows: [] };
    return { status: 200, ok: true, json: async () => body, text: async () => JSON.stringify(body) };
  };
  await runtime.boot(model, dom.window.document);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const select = (dom.window.document as unknown as { querySelector(selector: string): { value: string } | null }).querySelector('form[data-form="Intake"] select[name="Parent"]');
  assert.ok(select, 'the embedded form is drawn');
  assert.equal(select.value, '7');
});
