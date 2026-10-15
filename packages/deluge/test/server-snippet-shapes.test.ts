/**
 * Server-side Deluge snippet shapes that translate exactly. Each test names
 * one shape found in the gallery's counted `htmlpage` snippets. The guard
 * cases next to them must stay refused.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { compileHtmlpage } from '../../ui/src/htmlpage.js';
import { translate } from '../src/translate.js';

const ADMIN = { name: 'Administrator', type: 'Users_Permissions', properties: [], modules: [], span: { start: 0, end: 0 } };

const SALES = `\tform Sales
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t\tAmount
\t\t(
\t\t\ttype = decimal
\t\t)
\t}
\tlist Monthly_Sales
\t{
\t\tshow all rows from Sales
\t\t(
\t\t\tName
\t\t\tAmount
\t\t)
\t}`;

const PRODUCTS_PAGE = `\tpages
\t{
\t\tpage Products
\t\t{
\t\t\tContent="<zml><layout><row><column width='100%'></column></row></layout></zml>"
\t\t}
\t}`;

function appOf(body: string): App {
  const app = deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
  app.profiles.push(ADMIN);
  return app;
}

function embedSnippet(src: string): string {
  return `htmlpage ZMLScript3()
displayname = "ZMLScript"
content
<%{
	%>
<div style = "padding:1%;font-size:18px;"><b>Monthly Sales</b></div>
<iframe class="back" name='chartFrame' allowTransparency='true' zc_mobileView='inline' zc_Header='false' style="border:none; width:100%; height:400px;" src='${src}'></iframe>
<%

}%>`;
}

test('shape report-embed iframe: <%=zoho.appuri%>report-embed/<own report> compiles to the generated report route', () => {
  const app = appOf(SALES);
  const compiled = compileHtmlpage(app, 'Admin_Dashboard', 'HTML Snippet 3', embedSnippet('<%=zoho.appuri%>report-embed/Monthly_Sales?zc_Header=false'));
  assert.equal(compiled.ok, true, `refused: ${compiled.reason}`);
  assert.match(compiled.html ?? '', /#\/report\/Monthly_Sales\b/);
  assert.doesNotMatch(compiled.html ?? '', /report-embed|zc_Header|<%/);
});

test('shape report-embed iframe guard: a report the app does not define stays refused', () => {
  const app = appOf(SALES);
  const compiled = compileHtmlpage(app, 'Admin_Dashboard', 'HTML Snippet 3', embedSnippet('<%=zoho.appuri%>report-embed/Not_A_Report?zc_Header=false'));
  assert.equal(compiled.ok, false);
});

test('shape report-embed iframe guard: a report name built at render time stays refused', () => {
  const app = appOf(SALES);
  const compiled = compileHtmlpage(app, 'Admin_Dashboard', 'HTML Snippet 3', embedSnippet('<%=zoho.appuri%>report-embed/<%=input.name%>?zc_Header=false'));
  assert.equal(compiled.ok, false);
});

test('shape report-embed iframe guard: query with non-zc presentation parameters stays refused', () => {
  const app = appOf(SALES);
  const compiled = compileHtmlpage(app, 'Admin_Dashboard', 'HTML Snippet 3', embedSnippet('<%=zoho.appuri%>report-embed/Monthly_Sales?filter=123'));
  assert.equal(compiled.ok, false);
});

test('shape report-embed iframe guard: render-time openUrl popup does not turn into a silent link', () => {
  const app = appOf(SALES);
  const snippet = `htmlpage ZMLScript1()
displayname = "ZMLScript"
content
<%{
	if(Sales[ID != 0].count() == 0)
	{
		openUrl("#Form:Sales","popup window");
	}
	%>
<iframe class="back" name='chartFrame' src='<%=zoho.appuri%>report-embed/Monthly_Sales?zc_Header=false'></iframe>
<%

}%>`;
  const compiled = compileHtmlpage(app, 'Admin_Dashboard', 'HTML Snippet', snippet);
  assert.equal(compiled.ok, true);
  assert.doesNotMatch(compiled.html ?? '', /#\/form\/Sales|#Form:Sales/);
});

test('shape page-embed iframe: <%=zoho.appuri%>page-embed/<own page>?<constant params> compiles to the generated page route', () => {
  const app = appOf(`${SALES}\n${PRODUCTS_PAGE}`);
  const compiled = compileHtmlpage(app, 'Product_Catalogue', 'HTML Snippet', embedSnippet('<%=zoho.appuri%>page-embed/Products?category_var=&start=1&end=12'));
  assert.equal(compiled.ok, true, `refused: ${compiled.reason}`);
  assert.match(compiled.html ?? '', /#\/page\/Products\b/);
  assert.doesNotMatch(compiled.html ?? '', /page-embed|<%/);
});

test('shape page-embed iframe guard: a page the app does not define stays refused', () => {
  const app = appOf(`${SALES}\n${PRODUCTS_PAGE}`);
  const compiled = compileHtmlpage(app, 'Product_Catalogue', 'HTML Snippet', embedSnippet('<%=zoho.appuri%>page-embed/Not_A_Page?category_var=&start=1&end=12'));
  assert.equal(compiled.ok, false);
});

test('shape page-embed iframe guard: a page name built at render time stays refused', () => {
  const app = appOf(`${SALES}\n${PRODUCTS_PAGE}`);
  const compiled = compileHtmlpage(app, 'Product_Catalogue', 'HTML Snippet', embedSnippet('<%=zoho.appuri%>page-embed/<%=input.page%>?category_var=&start=1&end=12'));
  assert.equal(compiled.ok, false);
});

test('shape page-embed iframe guard: dynamic query parameters stay refused', () => {
  const app = appOf(`${SALES}\n${PRODUCTS_PAGE}`);
  const compiled = compileHtmlpage(app, 'Product_Catalogue', 'HTML Snippet', embedSnippet('<%=zoho.appuri%>page-embed/Products?category_var=<%=input.cat%>'));
  assert.equal(compiled.ok, false);
});

test('shape relative-period read criteria: Form[Date in this year] binds the period instead of criteria-dynamic', () => {
  const tr = translate('holidays = Add_Holiday[Date_field in this year];\nn = holidays.count();');
  assert.deepEqual(
    tr.todos.map((t) => t.construct),
    [],
  );
  assert.match(tr.server, /\{ ?"?op"?: ?"in", ?"?field"?: ?"Date_field", ?"?value"?: ?\{ ?"__rel": ?"this year" ?\} ?\}/);
  assert.doesNotMatch(tr.server, /shim\.todo\(/);
});

test('shape relative-period read criteria guard: a period under == stays criteria-dynamic', () => {
  const tr = translate('holidays = Add_Holiday[Date_field == this year];');
  assert.ok(tr.todos.some((t) => t.construct === 'criteria-dynamic'));
});
