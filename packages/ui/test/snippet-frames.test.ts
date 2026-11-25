/**
 * Snippet shapes that end in, or carry, a frame Creator draws blank or never
 * finishes: an end tag cut off at the end of the page, a named frame with no
 * address. Each one is compiled to what the browser does with the markup.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { compileHtmlpage } from '../src/htmlpage.js';

function appOf(): App {
  return deriveIr(parse(`application "Demo"\n{\n\tsection Front\n\t{\n\t\tpage Outer\n\t\t{\n\t\t\tContent="<zml><layout><panel><text value='x'/></panel></layout></zml>"\n\t\t}\n\t}\n}\n`));
}

test('an end tag cut off before the closing island is dropped, as the browser drops it at the end of the markup', () => {
  const out = compileHtmlpage(appOf(), 'Outer', 'dsp', `htmlpage Outer1()
content
<%{
 label = "a";
 %>
<div><p><%=label%></p>
  </div
<%

}%>`);
  assert.equal(out.ok, true, out.reason ?? 'compile failed');
  assert.doesNotMatch(out.file?.source ?? '', /<\/div\s*\\n/);
  assert.match(out.file?.source ?? '', /<\/p>/);
});

test('a cut-off end tag anywhere else, or one with an attribute-like tail, stays counted', () => {
  const cases: [string, string][] = [
    ['an island inside the tag, with more markup after it', `<div></div <%=input.a%>\n<p>tail</p>\n<%\n}%>`],
    ['a value island after the tag', `<div><p></p></div\n<%=input.a%>\n<%\n}%>`],
    ['an island that is not a bare brace', `<div></div\n<% x = 1; %>\n<%\n}%>`],
  ];
  for (const [label, body] of cases) {
    const out = compileHtmlpage(appOf(), 'Outer', 'dsp', `htmlpage Outer1()\ncontent\n<%{\n%>\n${body}`);
    assert.equal(out.ok, false, label);
  }
});

const blank = (attrs: string, inner = '') => `htmlpage Outer1()
content
<%{
 n = 2;
 %>
<div class="resultDiv"><p><%=n%></p><iframe${attrs}>${inner}</iframe></div>
<%
}%>`;

test('a blank borderless frame is the same sized box, not a dropped iframe', () => {
  const out = compileHtmlpage(appOf(), 'Outer', 'dsp', blank(` name='resultFrame' scrolling='Auto' style="display:inline-block; border:none; margin:0px auto; width:700px; height:210px;" src=''`));
  assert.equal(out.ok, true, out.reason ?? 'compile failed');
  assert.equal(out.droppedTags, undefined);
  const source = out.file?.source ?? '';
  assert.doesNotMatch(source, /iframe/i);
  assert.match(source, /<div style=\\"display:inline-block; border:none; margin:0px auto; width:700px; height:210px;\\"><\/div>/);
  assert.doesNotMatch(source, /resultFrame/);
});

test('a frame that could show something stays counted', () => {
  const cases: [string, string, string?][] = [
    ['an address', ` style="border:none" src='https://example.org/'`],
    ['no src', ` style="border:none"`],
    ['a visible default border', ` style="width:10px" src=''`],
    ['an island in the tag', ` style="border:none" src='' name="<%=n%>"`],
    ['a width attribute', ` width="100" style="border:none" src=''`],
    ['frame content', ` style="border:none" src=''`, 'text'],
    ['a srcdoc', ` style="border:none" src='' srcdoc="<p>x</p>"`],
  ];
  for (const [label, attrs, inner] of cases) {
    const out = compileHtmlpage(appOf(), 'Outer', 'dsp', blank(attrs, inner));
    assert.ok(!out.ok || (out.droppedTags ?? []).includes('iframe'), label);
  }
});
