/**
 * A `zc-component` embed written inside an HTML comment is inert: it renders
 * nothing, so it is no embed to migrate and raises no TODO. Only what the HTML
 * tokenizer reads as a comment counts; a `<!--` in an attribute, a raw-text
 * element, a script string or an island is text and the embed after it is live.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi } from '../src/index.js';
import type { UiElement, UiModel } from '../src/index.js';
import { htmlCommentRanges, inRanges } from '../src/html-comments.js';

const FORM = `form Intake
{
  Name
  (
    type = text
  )
}`;
const REPORT = `report All_Rows
{
  show all rows from Intake
  (
    Name
  )
}`;

function appWith(snippet: string): App {
  const zml = `<zml><layout><row><column width='100%'><dsp id='Outer1'><![CDATA[${snippet}]]></dsp></column></row></layout></zml>`;
  return deriveIr(parse(`application "Demo"
{
	section Front
	{
${FORM}
${REPORT}
		page Outer
		{
			Content=${JSON.stringify(zml)}
		}
	}
}
`));
}

function snippetOf(model: UiModel): UiElement | undefined {
  const walk = (els: UiElement[]): UiElement | undefined => {
    for (const el of els) {
      if (el.kind === 'html') return el;
      const hit = walk(el.children);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(model.pages.find((item) => item.name === 'Outer')?.elements ?? []);
}

const LIVE = `<div elName='zc-component' viewLinkName='All_Rows'>Loading...</div>`;
const MISSING = `<div elName='zc-component' viewLinkName='Gone_Rows'>Loading...</div>`;
const page = (markup: string) => `htmlpage Outer1()\ncontent\n<%{ %>${markup}<% }%>`;
const embedTodos = (model: UiModel) => model.todos.map((todo) => todo.reason).filter((reason) => reason.startsWith('Embedded zc-component'));

/** What the page reports for one snippet: the generated components and the embed TODOs. */
function outcome(markup: string) {
  const { model } = buildUi(appWith(page(markup)));
  return { components: snippetOf(model)?.components ?? [], todos: embedTodos(model), html: snippetOf(model)?.html ?? '' };
}

const COMMENTED: [string, string][] = [
  ['an ordinary comment', `<!-- ${LIVE} -->`],
  ['a comment closed by --!>', `<!-- ${LIVE} --!>`],
  ['a bogus comment', `<!x ${LIVE}`],
  ['a comment that never closes', `<!-- ${LIVE}`],
];

for (const [label, markup] of COMMENTED) {
  test(`an embed inside ${label} is inert: no view, no TODO`, () => {
    const got = outcome(markup);
    assert.deepEqual(got.components, []);
    assert.deepEqual(got.todos, []);
    assert.doesNotMatch(got.html, /data-zml="component-/);
  });
  test(`an unknown embed inside ${label} raises no TODO`, () => {
    assert.deepEqual(outcome(markup.replace(LIVE, MISSING)).todos, []);
  });
}

const LIVE_AFTER: [string, string][] = [
  ['an empty comment', `<!-->${LIVE}<p>-->`],
  ['an empty comment closed by a third dash', `<!--->${LIVE}<p>-->`],
  ['an attribute value', `<div title="<!--">x</div>${LIVE}<p>-->`],
  ['an unquoted attribute value', `<div title=<!--x>x</div>${LIVE}<p>-->`],
  ['a style element', `<style>.a::before{content:"<!--"}</style>${LIVE}<p>-->`],
  ['a textarea', `<textarea><!--</textarea>${LIVE}<p>-->`],
  ['a title element', `<title><!--</title>${LIVE}<p>-->`],
  ['a script string', `<script>var s = "<!--";</script>${LIVE}<p>-->`],
  ['an escaped script', `<script><!-- var s = 1; --></script>${LIVE}<p>-->`],
  ['a double-escaped script', `<script><!--<script>x</script>--></script>${LIVE}<p>-->`],
  ['a --!> comment that ended before it', `<!-- gone --!>${LIVE}<p>-->`],
  ['an island string', `<% s = "<!--"; %>${LIVE}<p>-->`],
  ['an island in an attribute', `<div title='<%= "<!--" %>'>x</div>${LIVE}<p>-->`],
];

for (const [label, markup] of LIVE_AFTER) {
  test(`an embed after "<!--" in ${label} is still generated`, () => {
    const got = outcome(markup);
    assert.deepEqual(got.components, [{ kind: 'report', name: 'All_Rows' }]);
    assert.deepEqual(got.todos, []);
    assert.match(got.html, /data-zml="component-report:All_Rows/);
  });
  test(`an unknown embed after "<!--" in ${label} is still counted`, () => {
    assert.deepEqual(outcome(markup.replace(LIVE, MISSING)).todos, ['Embedded zc-component report "Gone_Rows" has no generated view']);
  });
}

test('a live embed beside a commented one is generated once', () => {
  const got = outcome(`<!-- ${MISSING} -->${LIVE}`);
  assert.deepEqual(got.components, [{ kind: 'report', name: 'All_Rows' }]);
  assert.deepEqual(got.todos, []);
});

test('the commented embed of the Bug Tracker home page shape raises no TODO', () => {
  const got = outcome(`<div class="row">${LIVE}</div>\n<!--  <div class="row">\n  <div class="bugRepEmbed" elName='zc-component' reportLinkName='New_Bug_Report' params='zc_Header=false'></div>\n  </div>-->`);
  assert.deepEqual(got.components, [{ kind: 'report', name: 'All_Rows' }]);
  assert.deepEqual(got.todos, []);
});

test('comment ranges follow the tokenizer states', () => {
  const at = (text: string) => htmlCommentRanges(text).map(([start, end]) => text.slice(start, end));
  assert.deepEqual(at('a<!-- x -->b<!-- y --!>c'), ['<!-- x -->', '<!-- y --!>']);
  assert.deepEqual(at('<!-->a<!--->b'), ['<!-->', '<!--->']);
  assert.deepEqual(at('<p title="<!-- x -->">'), []);
  assert.deepEqual(at('<script>"<!--"</script><!-- c -->'), ['<!-- c -->']);
  assert.deepEqual(at('<script><!--<script></script>--></script><!-- c -->'), ['<!-- c -->']);
  assert.deepEqual(at('<!DOCTYPE html><?x y><![CDATA[z]]></ q>'), ['<?x y>', '<![CDATA[z]]>', '</ q>']);
  assert.deepEqual(at('<plaintext><!-- c -->'), []);
  assert.deepEqual(at('<% "<!--" %><!-- c -->'), ['<!-- c -->']);
  assert.deepEqual(at('<!-- open'), ['<!-- open']);
  assert.equal(inRanges(htmlCommentRanges('a<!--b-->c'), 3), true);
  assert.equal(inRanges(htmlCommentRanges('a<!--b-->c'), 9), false);
});
