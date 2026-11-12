/**
 * Server-side Deluge snippet shapes that translate exactly. Each test names
 * one shape found in the gallery's counted `htmlpage` snippets. The guard
 * cases next to them must stay refused.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { compileHtmlpage } from '../../ui/src/htmlpage.js';
import { carriedStyleRules } from '../../ui/src/pages.js';
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

test('shape form-embed iframe: <%=zoho.appuri%>form-embed/<own form> compiles to the generated form route', () => {
  const app = appOf(SALES);
  const compiled = compileHtmlpage(app, 'Admin_Dashboard', 'HTML Snippet 3', embedSnippet('<%=zoho.appuri%>form-embed/Sales?zc_Header=false'));
  assert.equal(compiled.ok, true, `refused: ${compiled.reason}`);
  assert.match(compiled.html ?? '', /#\/form\/Sales\b/);
  assert.doesNotMatch(compiled.html ?? '', /form-embed|zc_Header|<%/);
});

test('shape form-embed iframe guard: a form the app does not define stays refused', () => {
  const app = appOf(SALES);
  const compiled = compileHtmlpage(app, 'Admin_Dashboard', 'HTML Snippet 3', embedSnippet('<%=zoho.appuri%>form-embed/Not_A_Form?zc_Header=false'));
  assert.equal(compiled.ok, false);
});

test('shape form-embed iframe guard: a form name built at render time stays refused', () => {
  const app = appOf(SALES);
  const compiled = compileHtmlpage(app, 'Admin_Dashboard', 'HTML Snippet 3', embedSnippet('<%=zoho.appuri%>form-embed/<%=input.name%>?zc_Header=false'));
  assert.equal(compiled.ok, false);
});

test('shape form-embed iframe guard: query with non-zc presentation parameters stays refused', () => {
  const app = appOf(SALES);
  const compiled = compileHtmlpage(app, 'Admin_Dashboard', 'HTML Snippet 3', embedSnippet('<%=zoho.appuri%>form-embed/Sales?filter=123'));
  assert.equal(compiled.ok, false);
});

test('shape page-embed iframe: <%=zoho.appuri%>page-embed/<own page> compiles to an inline include', () => {
  const app = appOf(`${SALES}\n${PRODUCTS_PAGE}`);
  const compiled = compileHtmlpage(app, 'Product_Catalogue', 'HTML Snippet', embedSnippet('<%=zoho.appuri%>page-embed/Products'));
  assert.equal(compiled.ok, true, `refused: ${compiled.reason}`);
  assert.deepEqual(compiled.includes, ['Products']);
  assert.match(compiled.html ?? '', /data-zml="page-include:Products"/);
  assert.doesNotMatch(compiled.html ?? '', /page-embed|<%/);
});

test('shape page-embed iframe guard: constant non-zc_ parameters stay refused', () => {
  const app = appOf(`${SALES}\n${PRODUCTS_PAGE}`);
  const compiled = compileHtmlpage(app, 'Product_Catalogue', 'HTML Snippet', embedSnippet('<%=zoho.appuri%>page-embed/Products?category_var=&start=1&end=12'));
  assert.equal(compiled.ok, false);
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

function mapPage(body: string): string {
  return `htmlpage ZMLScript()
displayname = "ZMLScript"
content
${body}`;
}

test('shape map-literal get: {"k":v}.get("k") compiles as a read-only htmlpage render', () => {
  // Zoho map get() help uses a map literal: `{"Product":"Creator"}.get("Product")`
  // (https://www.zoho.com/deluge/help/functions/map/get.html). Freight-forwarding
  // uses the same `.get()` chain on integration response maps.
  const compiled = compileHtmlpage(
    appOf(SALES),
    'Admin_Dashboard',
    'HTML Snippet',
    mapPage('<p><%= {"Product":"Creator"}.get("Product") %></p>'),
  );
  assert.equal(compiled.ok, true, `refused: ${compiled.reason}`);
  assert.match(compiled.file?.source ?? '', /shim\.list\.get/);
  assert.doesNotMatch(compiled.file?.source ?? '', /shim\.todo\(/);
});

test('shape map-literal containsKey: {"k":v}.containsKey("k") compiles as a read-only htmlpage render', () => {
  const compiled = compileHtmlpage(
    appOf(SALES),
    'Admin_Dashboard',
    'HTML Snippet',
    mapPage('<p><%= {"Product":"Creator"}.containsKey("Product") %></p>'),
  );
  assert.equal(compiled.ok, true, `refused: ${compiled.reason}`);
  assert.match(compiled.file?.source ?? '', /shim\.list\.containsKey/);
  assert.doesNotMatch(compiled.file?.source ?? '', /shim\.todo\(/);
});

test('shape lowercase map() put/get: map(); m.put(); m.get() compiles as a read-only htmlpage render', () => {
  // Zoho put() help writes `Products = map(); Products.put(...)`. Without
  // aliasing `map()` to `Map()`, the island is `call:map` and stays the
  // generic "Server-side Deluge snippet requires manual translation" TODO.
  const compiled = compileHtmlpage(
    appOf(SALES),
    'Admin_Dashboard',
    'HTML Snippet',
    mapPage(`<%
m = map();
m.put("Product", "Creator");
%>
<p><%= m.get("Product") %></p>`),
  );
  assert.equal(compiled.ok, true, `refused: ${compiled.reason}`);
  assert.match(compiled.file?.source ?? '', /shim\.set/);
  assert.match(compiled.file?.source ?? '', /shim\.list\.get/);
  assert.doesNotMatch(compiled.file?.source ?? '', /shim\.todo\(|call:map|method:put|method:get/);
});

test('shape map-literal get guard: an info dump of the lookup stays refused', () => {
  const compiled = compileHtmlpage(
    appOf(SALES),
    'Admin_Dashboard',
    'HTML Snippet',
    mapPage('<%\ninfo {"Product":"Creator"}.get("Product");\n%>\n<p>x</p>'),
  );
  assert.equal(compiled.ok, false);
});

const CLASS_APP = `\tform Item
\t{
\t\tStatus (type=text)
\t}
\tpages
\t{
\t\tpage Home
\t\t{
\t\t\tContent="<zml></zml>"
\t\t}
\t}`;

test('shape class-attr island: <%=expr%> in a class attribute compiles as a read-only htmlpage render', () => {
  // class attribute islands used for CSS modifier class selection (e.g.
  // "alertmsg alertmsg-warning") were previously refused because class was
  // not in ALLOWED_ATTRS. Class values cannot execute code, so they are safe.
  const compiled = compileHtmlpage(
    appOf(CLASS_APP),
    'Home',
    'HTML Snippet',
    `htmlpage HTML_Snippet()
content
<%{
  colorList = {"warning","info","danger","success"};
  recs = Item[Status != ""];
  countVal = 0;
  for each r in recs
  {
    %>
<li class="alert alert-<%=colorList.get(countVal)%>"><%=r.Status%></li>
<%
    countVal = countVal + 1;
  }
%>
<%}%>`,
  );
  assert.equal(compiled.ok, true, `refused: ${compiled.reason}`);
  assert.doesNotMatch(compiled.file?.source ?? '', /shim\.todo\(/);
});

test('shape class-attr island guard: a statement island in a class attribute stays refused', () => {
  // A non-expression (<% %>) island in a class attribute cannot be safely
  // translated — only expression (<%=  %>) islands in class are allowed.
  const compiled = compileHtmlpage(
    appOf(CLASS_APP),
    'Home',
    'HTML Snippet',
    `htmlpage HTML_Snippet()
content
<%{
  %>
<li class="<% x = Item[Status != ""].count(); %>">x</li>
<%}%>`,
  );
  assert.equal(compiled.ok, false);
});

test('shape remove(): list.remove and map.remove compile as a read-only htmlpage render', () => {
  // Zoho help: list remove(index) drops one element, map remove(key) drops
  // one key. Both only edit a value already in memory.
  const list = compileHtmlpage(appOf(SALES), 'Admin_Dashboard', 'HTML Snippet', mapPage('<%\nl = {"a","b"};\nl.remove(0);\n%>\n<p><%= l.size() %></p>'));
  assert.equal(list.ok, true, `refused: ${list.reason}`);
  assert.match(list.file?.source ?? '', /shim\.list\.remove/);
  const map = compileHtmlpage(appOf(SALES), 'Admin_Dashboard', 'HTML Snippet', mapPage('<%\nm = {"a":1,"b":2};\nm.remove("a");\n%>\n<p><%= m.size() %></p>'));
  assert.equal(map.ok, true, `refused: ${map.reason}`);
  assert.match(map.file?.source ?? '', /shim\.list\.deleteKey/);
  assert.doesNotMatch(map.file?.source ?? '', /shim\.list\.remove|shim\.todo\(/);
});

test('shape removeAll()/clear(): local list and map edits compile as a read-only htmlpage render', () => {
  // Zoho help: list removeAll(values) and list/map clear() only edit a value
  // already in memory, the same class of local edit as remove().
  const removeAll = compileHtmlpage(appOf(SALES), 'Admin_Dashboard', 'HTML Snippet', mapPage('<%\nl = {1,2,3};\nl.removeAll({1});\n%>\n<p><%= l.size() %></p>'));
  assert.equal(removeAll.ok, true, `refused: ${removeAll.reason}`);
  const clear = compileHtmlpage(appOf(SALES), 'Admin_Dashboard', 'HTML Snippet', mapPage('<%\nm = {"a":1};\nm.clear();\n%>\n<p><%= m.size() %></p>'));
  assert.equal(clear.ok, true, `refused: ${clear.reason}`);
  assert.doesNotMatch(clear.file?.source ?? '', /shim\.todo\(/);
});

test('shape remove() guard: text.remove is a different generated call than list.remove and stays a counted TODO', () => {
  // `.remove()` on a plain text value shares the shim.list.remove runtime
  // behavior (list.remove already dispatches to removeText for a non-array
  // value), but the static read-only analysis only allowlists `list.remove`.
  // If a textish removal reused that exact generated call name, a later date-
  // derived case (see htmlpage.test.ts "mixed date texts") could slip through
  // the same allowlist entry even though its rendering would not match
  // Creator, so text.remove always gets its own, non-allowlisted call name.
  const compiled = compileHtmlpage(appOf(SALES), 'Admin_Dashboard', 'HTML Snippet', mapPage('<p><%= "a-b-c".remove("-") %></p>'));
  assert.equal(compiled.ok, false, 'a plain text.remove is not yet treated as a read-only render');
});

test('shape remove() guard: removing from a fetched list stays refused', () => {
  const compiled = compileHtmlpage(
    appOf(SALES),
    'Admin_Dashboard',
    'HTML Snippet',
    mapPage('<%\nrows = Sales[ID != 0].Name.getAll();\nrows.remove(0);\n%>\n<p><%= rows.size() %></p>'),
  );
  assert.equal(compiled.ok, false);
});

test('shape style-element island: <%=expr%> in <style> text compiles and the loss is counted as dropped CSS', () => {
  const compiled = compileHtmlpage(
    appOf(SALES),
    'Home',
    'HTML Snippet',
    `htmlpage HTML_Snippet()
content
<%{
  %>
<style>
.card { color: red; }
<%=Sales[ID != 0].count()%>
</style>
<div class="card">Hi</div>
<%}%>`,
  );
  assert.equal(compiled.ok, true, `refused: ${compiled.reason}`);
  assert.doesNotMatch(compiled.html ?? '', /<style|<%/);
  const lost = carriedStyleRules(`<style>\n.card { color: red; }\n<%=Sales[ID != 0].count()%>\n</style>`, '[data-page="Home"]');
  assert.deepEqual(lost.dropped, ['CSS built by a Deluge tag']);
});

test('shape style-element island guard: a statement island in <style> text stays refused', () => {
  const compiled = compileHtmlpage(
    appOf(SALES),
    'Home',
    'HTML Snippet',
    `htmlpage HTML_Snippet()
content
<%{
  %>
<style>
<% x = Sales[ID != 0].count(); %>
</style>
<div>Hi</div>
<%}%>`,
  );
  assert.equal(compiled.ok, false);
});

test('shape script-element island: <%=expr%> in <script> text compiles and the script is counted as dropped', () => {
  const compiled = compileHtmlpage(
    appOf(SALES),
    'Home',
    'HTML Snippet',
    `htmlpage HTML_Snippet()
content
<%{
  %>
<script>
var total = <%=Sales[ID != 0].count()%>;
</script>
<div class="card">Hi</div>
<%}%>`,
  );
  assert.equal(compiled.ok, true, `refused: ${compiled.reason}`);
  assert.doesNotMatch(compiled.html ?? '', /<script|<%|var total/);
  assert.deepEqual(compiled.droppedTags, ['script']);
});

test('shape script-element island guard: a statement island in <script> text stays refused', () => {
  const compiled = compileHtmlpage(
    appOf(SALES),
    'Home',
    'HTML Snippet',
    `htmlpage HTML_Snippet()
content
<%{
  %>
<script>
<% x = Sales[ID != 0].count(); %>
</script>
<%}%>`,
  );
  assert.equal(compiled.ok, false);
});

test('shape number-list average()/median(): local number list statistics compile as a read-only htmlpage render', () => {
  // Zoho help: list average() and median() read a NUMBER or DECIMAL list
  // held in memory. The numberList check only validates that receiver.
  const avg = compileHtmlpage(appOf(SALES), 'Admin_Dashboard', 'HTML Snippet', mapPage('<%\nl = {1,2,6};\n%>\n<p><%= l.average() %></p>'));
  assert.equal(avg.ok, true, `refused: ${avg.reason}`);
  assert.match(avg.file?.source ?? '', /shim\.list\.numberList/);
  const med = compileHtmlpage(appOf(SALES), 'Admin_Dashboard', 'HTML Snippet', mapPage('<p><%= {1,2,6}.median() %></p>'));
  assert.equal(med.ok, true, `refused: ${med.reason}`);
  assert.doesNotMatch(med.file?.source ?? '', /shim\.todo\(/);
});

test('shape number-list average() guard: averaging a fetched column stays a counted TODO', () => {
  const compiled = compileHtmlpage(appOf(SALES), 'Admin_Dashboard', 'HTML Snippet', mapPage('<%\nl = Sales[Amount > 0].Amount.getAll();\nSales[ID != 0].delete();\n%>\n<p><%= l.average() %></p>'));
  assert.equal(compiled.ok, false);
});
