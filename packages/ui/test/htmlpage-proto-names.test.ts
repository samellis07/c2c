/**
 * The maps `compileHtmlpage` builds by form and field name (composites, lookup
 * forms, lookup reads, multi lookups) are keyed by names an app author picks.
 * A form or field named `__proto__` or `constructor` must be an ordinary entry
 * of each map: writing through `out[name] ??= {}` would find the inherited
 * `Object.prototype` / `Object` and write the field onto it instead.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { compileHtmlpage } from '../src/htmlpage.js';

const ADMIN = { name: 'Administrator', type: 'Users_Permissions', properties: [], modules: [], span: { start: 0, end: 0 } };

function compile(form: string, composite: string, lookup: string, multi: string): string {
  const app = deriveIr(parse(`application "Evil"
{
\tform Other
\t{
\t\tTitle
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform ${form}
\t{
\t\t${composite}
\t\t(
\t\t\ttype = address
\t\t\tcity
\t\t\t(
\t\t\t\ttype = district_city
\t\t\t)
\t\t)
\t\t${lookup}
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Other.Title
\t\t)
\t\t${multi}
\t\t(
\t\t\ttype = checkbox
\t\t\tvalues = Other.Title
\t\t)
\t}
\tpages
\t{
\t\tpage P(x)
\t\t{
\t\t\tContent="<zml></zml>"
\t\t}
\t}
}
`));
  app.profiles.push(ADMIN);
  const snippet = `<%{
rows = ${form}[${multi}.Title == "a"];
rr = ${form}[${lookup}.Title == "b"];
r = ${form}[ID == input.x];
v = ifnull(r.${composite}.city, "");
w = ifnull(r.${lookup}.Title, "");
%>
<p><%=v%><%=w%></p>
<%
}%>`;
  const out = compileHtmlpage(app, 'P', 'P1', snippet);
  if (!out.ok) assert.fail(String(out.reason));
  // The generated source rides in the result as JSON text; unescape its quotes to match on it.
  return JSON.stringify(out).replace(/\\"/g, '"');
}

/** Names on the shared prototypes, so a polluting write shows as a new key. */
const shared = () => [Object.getOwnPropertyNames(Object.prototype).sort(), Object.getOwnPropertyNames(Object).sort(), Object.getOwnPropertyNames(Function.prototype).sort()];

for (const name of ['__proto__', 'constructor']) {
  test(`a form named ${name} is an ordinary entry of every compile map and writes nothing to a prototype`, () => {
    const before = shared();
    const src = compile(name, 'Home', 'Link', 'Tags');
    assert.deepEqual(shared(), before, 'no field was written onto Object.prototype, Object or Function.prototype');
    assert.equal(({} as Record<string, unknown>).Home, undefined);
    assert.equal(({} as Record<string, unknown>).Link, undefined);
    assert.equal(({} as Record<string, unknown>).Tags, undefined);
    assert.match(src, new RegExp(`composites: \\{"${name}":\\{"Home":\\["city"\\]\\}\\}`));
    assert.match(src, new RegExp(`lookupForms: \\{"${name}":\\{"Link":"Other"`));
    assert.match(src, new RegExp(`lookupReads: \\{"${name}":\\{"Link":\\["Title"\\]`));
    assert.match(src, new RegExp(`multiLookups: \\{"${name}":\\{"Tags":`));
  });

  test(`a composite, lookup or multi field named ${name} is an ordinary entry of its map`, () => {
    const before = shared();
    const composite = compile('Orders', name, 'Link', 'Tags');
    assert.match(composite, new RegExp(`composites: \\{"Orders":\\{"${name}":\\["city"\\]\\}\\}`));
    const lookup = compile('Orders', 'Home', name, 'Tags');
    assert.match(lookup, new RegExp(`lookupForms: \\{"Orders":\\{"${name}":"Other"`));
    assert.match(lookup, new RegExp(`lookupReads: \\{"Orders":\\{"${name}":\\["Title"\\]`));
    const multi = compile('Orders', 'Home', 'Link', name);
    assert.match(multi, new RegExp(`multiLookups: \\{"Orders":\\{"${name}":`));
    assert.deepEqual(shared(), before);
  });
}
