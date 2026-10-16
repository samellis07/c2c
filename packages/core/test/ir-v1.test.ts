/**
 * IR v1: constructs that IR v0 only preserved. Every snippet here is synthetic
 * (written for these tests); none is taken from a real export.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addCoverage, deriveIr, emptyCoverage, featureReport, formatFeatures, parse, parseZml, print, zmlReferences, type App, type Statement } from '../src/index.js';

/** IR plus the coverage of the snippet; asserts the round-trip on the way. */
function load(src: string): { app: App; preserved: Record<string, number> } {
  const doc = parse(src);
  assert.equal(print(doc), src, 'round-trip');
  const roles = new Map<Statement, string>();
  const app = deriveIr(doc, undefined, roles);
  const cov = addCoverage(emptyCoverage(), doc, roles);
  return { app, preserved: cov.unmodelled };
}

const app = (body: string) => `application "T"\n{\n${body}\n}\n`;

test('ir v1: report views, custom actions, conditional formats, filters, grouping and sorting', () => {
  const { app: a, preserved } = load(
    app(`\tsection S
\t{
\t\tlist Open_Items
\t\t{
\t\t\tdisplayName = "Open"
\t\t\tshow all rows from Item [Status == "Open"]
\t\t\t(
\t\t\t\tName as "Name"
\t\t\t\tcustom action "Close"
\t\t\t\t(
\t\t\t\t\tworkflow = Close_Item
\t\t\t\t)
\t\t\t)
\t\t\tfilters
\t\t\t(
\t\t\t\tStatus
\t\t\t\t"Mine" : Owner == zoho.loginuser
\t\t\t)
\t\t\tgroup by
\t\t\t(
\t\t\t\tStatus ascending
\t\t\t)
\t\t\tsort by
\t\t\t(
\t\t\t\tAdded_Time descending
\t\t\t)
\t\t\tconditional formatting
\t\t\t{
\t\t\t\t"Late"
\t\t\t\t{
\t\t\t\t\tcondition = (Due < zoho.currentdate)
\t\t\t\t\tfields = [Name]
\t\t\t\t\tformat = "color:red"
\t\t\t\t}
\t\t\t}
\t\t\tcustom actions
\t\t\t(
\t\t\t\t"Archive"
\t\t\t\t(
\t\t\t\t\tworkflow = Archive_Item
\t\t\t\t\texecute action for collection of records
\t\t\t\t)
\t\t\t)
\t\t\tquickview
\t\t\t(
\t\t\t\tlayout
\t\t\t\t(
\t\t\t\t\ttype = 2
\t\t\t\t\tdatablock1
\t\t\t\t\t(
\t\t\t\t\t\tlayout type = 1
\t\t\t\t\t\ttitle = "Overview"
\t\t\t\t\t\tfields
\t\t\t\t\t\t(
\t\t\t\t\t\t\tName as "Name"
\t\t\t\t\t\t)
\t\t\t\t\t)
\t\t\t\t)
\t\t\t\tmenu
\t\t\t\t(
\t\t\t\t\theader
\t\t\t\t\t(
\t\t\t\t\t\tEdit
\t\t\t\t\t\t"Archive"
\t\t\t\t\t)
\t\t\t\t)
\t\t\t\taction
\t\t\t\t(
\t\t\t\t\ton click
\t\t\t\t\t(
\t\t\t\t\t\tView Record
\t\t\t\t\t)
\t\t\t\t)
\t\t\t)
\t\t\tdetailview
\t\t\t(
\t\t\t\tlayout
\t\t\t\t(
\t\t\t\t\ttype = 1
\t\t\t\t)
\t\t\t)
\t\t}
\t}`),
  );
  assert.deepEqual(preserved, {});
  const r = a.reports[0];
  assert.deepEqual([r.name, r.type, r.form, r.criteria], ['Open_Items', 'list', 'Item', 'Status == "Open"']);
  assert.deepEqual(r.columns.map((c) => [c.field, c.label]), [['Name', 'Name']]);
  assert.deepEqual(
    r.customActions.map((c) => [c.name, c.workflow, c.column, c.flags]),
    [
      ['Close', 'Close_Item', true, []],
      ['Archive', 'Archive_Item', false, ['execute action for collection of records']],
    ],
  );
  assert.deepEqual(r.filters.map((f) => [f.field, f.label, f.criteria]), [
    ['Status', undefined, undefined],
    [undefined, 'Mine', 'Owner == zoho.loginuser'],
  ]);
  assert.deepEqual(r.groupBy, [{ field: 'Status', order: 'ascending' }]);
  assert.deepEqual(r.sortBy, [{ field: 'Added_Time', order: 'descending' }]);
  assert.deepEqual(r.conditionalFormats.map((c) => [c.name, c.condition, c.fields, c.format]), [
    ['Late', '(Due < zoho.currentdate)', '[Name]', 'color:red'],
  ]);
  const [qv, dv] = r.views;
  assert.deepEqual([qv.kind, qv.layoutType, dv.kind, dv.layoutType], ['quickview', '2', 'detailview', '1']);
  assert.deepEqual(qv.blocks.map((b) => [b.name, b.title, b.layoutType, b.fields.map((f) => f.field)]), [['datablock1', 'Overview', '1', ['Name']]]);
  assert.deepEqual(qv.menus, { header: ['Edit', 'Archive'] });
  assert.deepEqual(qv.actions, { 'on click': ['View Record'] });
});

test('ir v1: a filtered lookup keeps form, field, criteria and displayformat; a plain one has none', () => {
  const { app: a } = load(
    app(`\tform Author
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Book
\t{
\t\tAuthor
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Author[ID > 0].Name
\t\t\tdisplayformat = [Name]
\t\t)
\t\tEditor
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Author.ID
\t\t)
\t}`),
  );
  const book = a.forms.find((form) => form.name === 'Book')!;
  assert.deepEqual(book.fields[0]!.lookup, { form: 'Author', field: 'Name', criteria: 'ID > 0', displayFormat: '[Name]' });
  assert.deepEqual(book.fields[1]!.lookup, { form: 'Author', field: 'ID' });
});

test('ir v1: form workflow handlers inside `actions` carry their own event', () => {
  const { app: a, preserved } = load(
    app(`\tworkflow
\t{
\tform
\t{
\t\tOn_Add as "On add"
\t\t{
\t\t\ttype =  form
\t\t\tform = Item
\t\t\ton add
\t\t\t{
\t\t\t\tactions
\t\t\t\t{
\t\t\t\ton validate
\t\t\t\t(
\t\t\t\t\tif(input.Qty < 0) { cancel submit; }
\t\t\t\t)
\t\t\t\ton success
\t\t\t\t(
\t\t\t\t\tx = 1;
\t\t\t\t)
\t\t\t\t}
\t\t\t}
\t\t\ton edit
\t\t\t{
\t\t\t\tactions
\t\t\t\t{
\t\t\t\t\ty = 2;
\t\t\t\t}
\t\t\t}
\t\t\ton delete
\t\t\t{
\t\t\t\tactions
\t\t\t\t{
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\t}`),
  );
  assert.deepEqual(preserved, {});
  assert.deepEqual(
    a.workflows.map((w) => [w.name, w.recordEvent, w.event, w.deluge?.text.trim()]),
    [
      ['On_Add', 'on add', 'on validate', 'if(input.Qty < 0) { cancel submit; }'],
      ['On_Add', 'on add', 'on success', 'x = 1;'],
      ['On_Add', 'on edit', 'on edit', 'y = 2;'],
      ['On_Add', undefined, 'on delete', null],
    ].map(([n, r, e, d]) => [n, r, e, d ?? undefined]),
  );
  assert.deepEqual(a.workflows.map((w) => w.actionCondition), [undefined, undefined, undefined, undefined]);
});

test('ir v1: actions criteria is kept separate from the handler script', () => {
  const { app: a, preserved } = load(
    app(`\tworkflow
\t{
\tform
\t{
\t\tOverdue as "Overdue"
\t\t{
\t\t\ttype = form
\t\t\tform = Book_Transaction
\t\t\trecord event = on add
\t\t\ton success
\t\t\t{
\t\t\t\tactions (Status == "Overdue")
\t\t\t\t{
\t\t\t\t\tcustom deluge script
\t\t\t\t\t(
\t\t\t\t\t\tinput.Fine_Amount = 0;
\t\t\t\t\t)
\t\t\t\t}
\t\t\t\tactions
\t\t\t\t{
\t\t\t\t\tcustom deluge script
\t\t\t\t\t(
\t\t\t\t\t\tinput.Fine_Amount = 1;
\t\t\t\t\t)
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\t}`),
  );
  assert.deepEqual(preserved, {});
  assert.deepEqual(
    a.workflows.map((w) => [w.event, w.actionCondition, w.deluge?.text.trim()]),
    [
      ['on success', 'Status == "Overdue"', 'input.Fine_Amount = 0;'],
      ['on success', undefined, 'input.Fine_Amount = 1;'],
    ],
  );
});

test('ir v1: actions criteria whose body looks like Deluge keeps the criteria and the handlers', () => {
  const { app: a } = load(
    app(`\tworkflow
\t{
\tform
\t{
\t\tOpen_Notes as "Open notes"
\t\t{
\t\t\ttype = form
\t\t\tform = Item
\t\t\ton add
\t\t\t{
\t\t\t\tactions (Status == "Open")
\t\t\t\t{
\t\t\t\t\tshow Notes;
\t\t\t\t\ton success
\t\t\t\t\t(
\t\t\t\t\t\tinput.Fine = 1;
\t\t\t\t\t)
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\t}`),
  );
  assert.deepEqual(
    a.workflows.map((w) => [w.recordEvent, w.event, w.actionCondition, w.deluge?.text.trim()]),
    [
      // `show Notes;` is a field rule under the record event: it runs at the
      // form's load and carries the actions criteria as its condition.
      ['on add', 'on load', 'Status == "Open"', undefined],
      ['on add', 'on success', 'Status == "Open"', 'input.Fine = 1;'],
    ],
  );
  assert.deepEqual(a.workflows[0].fieldRules, [
    { condition: 'Status == "Open"', actions: [{ action: 'show', fields: ['Notes'] }], span: a.workflows[0].fieldRules?.[0].span },
  ]);
});

test('ir v1: approvals, schedules, field rules and blueprints', () => {
  const { app: a, preserved } = load(
    app(`\tworkflow
\t{
\tapproval
\t{
\t\tApprove_Item as "Approve"
\t\t{
\t\t\ttype = approval
\t\t\tform = Item
\t\t\ton level 1
\t\t\t{
\t\t\t\tapprovers
\t\t\t\t(
\t\t\t\t\tusers = "a@example.com"
\t\t\t\t)
\t\t\t\ton approve
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\tz = 3;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\ton reject
\t\t\t\t{
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\tschedule
\t{
\t\tNightly as "Nightly"
\t\t{
\t\t\ttype = schedule
\t\t\tstart = "01-Jan-2026 00:00:00"
\t\t\tfrequency = daily
\t\t\ttime zone = "Asia/Kolkata"
\t\t\ton start
\t\t\t{
\t\t\t\tactions
\t\t\t\t{
\t\t\t\ton load
\t\t\t\t(
\t\t\t\t\tw = 4;
\t\t\t\t)
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\tform
\t{
\t\tRules as "Rules"
\t\t{
\t\t\ttype = form
\t\t\tform = Item
\t\t\tfield rules
\t\t\t{
\t\t\t\tactions (Qty > 5)
\t\t\t\t{
\t\t\t\t\thide Notes, Extra;
\t\t\t\t\tdisable Qty;
\t\t\t\t}
\t\t\t}
\t\t}
\t\tFlow as "Flow"
\t\t{
\t\t\ttype = blueprint
\t\t\tform = Item
\t\t\tstart
\t\t\t{
\t\t\t\tstart stage = Draft
\t\t\t}
\t\t\tstages
\t\t\t{
\t\t\t\tDraft
\t\t\t\t{
\t\t\t\t\tdisplayname = "Draft"
\t\t\t\t}
\t\t\t}
\t\t\ttransitions
\t\t\t{
\t\t\t\tSubmit
\t\t\t\t{
\t\t\t\t\tfrom stage = Draft
\t\t\t\t\tto stage = Done
\t\t\t\t\tafter
\t\t\t\t\t{
\t\t\t\t\t\tactions
\t\t\t\t\t\t(
\t\t\t\t\t\t\tv = 5;
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\t}`),
  );
  assert.deepEqual(preserved, {});
  const byName = (n: string) => a.workflows.filter((w) => w.name === n);
  const [ap, rej] = byName('Approve_Item');
  assert.deepEqual([ap.container, ap.event, ap.approvers?.map((p) => p.key)], ['approval', 'on level 1 / on approve', ['users']]);
  assert.equal(ap.deluge?.text.trim(), 'z = 3;');
  assert.equal(rej.event, 'on level 1 / on reject');
  const [sch] = byName('Nightly');
  assert.deepEqual([sch.container, sch.event, sch.deluge?.text.trim()], ['schedule', 'on start / on load', 'w = 4;']);
  assert.deepEqual(sch.properties.map((p) => p.key), ['type', 'start', 'frequency', 'time zone']);
  const [rules] = byName('Rules');
  assert.deepEqual(rules.fieldRules?.map((r) => [r.condition, r.actions]), [
    ['Qty > 5', [{ action: 'hide', fields: ['Notes', 'Extra'] }, { action: 'disable', fields: ['Qty'] }]],
  ]);
  const [flow] = byName('Flow');
  assert.equal(flow.type, 'blueprint');
  assert.deepEqual(flow.blueprint?.start?.properties.map((p) => [p.key, p.value]), [['start stage', 'Draft']]);
  assert.deepEqual(flow.blueprint?.stages.map((s) => s.name), ['Draft']);
  const [t] = flow.blueprint!.transitions;
  assert.deepEqual([t.name, t.fromStage, t.toStage, t.phases.map((p) => p.phase)], ['Submit', 'Draft', 'Done', ['after']]);
  assert.equal(t.phases[0].deluge[0].text.trim(), 'v = 5;');
});

test('ir v1: a pre-success openUrl inside actions is kept as the event script', () => {
  const { app: a } = load(
    app(`\tworkflow
\t{
\t\tform
\t\t{
\t\t\tDirect as "Direct"
\t\t\t{
\t\t\t\ttype = presuccess
\t\t\t\tform = Item
\t\t\t\ton start
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\topenURL("#Report:Active","new window");
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`),
  );
  const [direct] = a.workflows;
  assert.equal(direct.name, 'Direct');
  assert.equal(direct.event, 'on start');
  assert.match(direct.deluge?.text ?? '', /openURL\("#Report:Active","new window"\)/);
});

test('ir v1: actions braces holding `on X (...)` / `custom deluge script (...)` handlers stay structured', () => {
  const { app: a } = load(
    app(`\tworkflow
\t{
\t\tform
\t\t{
\t\t\tDirect as "Direct"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Item
\t\t\t\ton success
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\topenURL("#Form:Item","new window");
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\topenUrl("#Script:page.refresh","same window");
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`),
  );
  assert.deepEqual(
    a.workflows.map((w) => [w.event, w.deluge?.text.trim()]),
    [
      ['on success', 'openURL("#Form:Item","new window");'],
      ['on success', 'openUrl("#Script:page.refresh","same window");'],
    ],
  );
});

test('ir v1: an `on click` handler inside a gesture event `actions` block is split out', () => {
  const { app: a } = load(
    app(`\tworkflow
\t{
\t\tform
\t\t{
\t\t\tDirect as "Direct"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Item
\t\t\t\tbutton = Add
\t\t\t\ton click
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\ton click
\t\t\t\t\t\t(
\t\t\t\t\t\t\trow = Item[ID == input.ID];
\t\t\t\t\t\t)
\t\t\t\t\t\topenURL("#Script:page.close","new window");
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`),
  );
  assert.deepEqual(
    a.workflows.map((w) => [w.event, w.deluge?.text.trim()]),
    [
      ['on click', 'row = Item[ID == input.ID];'],
      ['on click', 'openURL("#Script:page.close","new window");'],
    ],
  );
});

test('ir v1: form settings blocks with key : value pairs (payment)', () => {
  const { app: a, preserved } = load(
    app(`\tform Order
\t{
\t\tdisplayname = "Order"
\t\tAmount
\t\t(
\t\t\ttype = USD
\t\t)
\t\tenable payment
\t\t{
\t\t\ttype : paypal
\t\t\tcurrency : USD
\t\t\tamount : Amount
\t\t}
\t\tprint template
\t\t{
\t\t\tpage size = A4
\t\t}
\t}`),
  );
  assert.deepEqual(preserved, {});
  const f = a.forms[0];
  assert.deepEqual(
    f.blocks.map((b) => [b.name, b.properties.map((p) => `${p.key}=${p.value}`)]),
    [
      ['enable payment', ['type=paypal', 'currency=USD', 'amount=Amount']],
      ['print template', ['page size=A4']],
    ],
  );
  assert.equal(f.fields[0].type, 'USD');
});

test('ir v1: profiles, module and field permissions, roles, translations', () => {
  const { app: a, preserved } = load(
    app(`\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tdescription = "Staff users"
\t\t\tpermissions = {Chat:false, ApiAccess:true}
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tItem
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Items = {"View","Edit"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tQty
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t\troles
\t\t{
\t\t\tCEO
\t\t\t{
\t\t\t\tdescription = "Top"
\t\t\t}
\t\t}
\t\trole Hierarchy = {CEO:{}}
\t}
\ttranslation
\t{
\t\t{"en":{"Item":"Item"}}
\t}`),
  );
  assert.deepEqual(preserved, {});
  const [p] = a.profiles;
  assert.deepEqual([p.name, p.type, p.description, p.permissions], ['Staff', 'Users_Permissions', 'Staff users', '{Chat:false, ApiAccess:true}']);
  const [m] = p.modules;
  assert.deepEqual([m.component, m.properties.map((x) => x.key), m.reports.map((x) => x.key)], ['Item', ['enabled'], ['All_Items']]);
  assert.deepEqual(m.fields.map((f) => [f.field, f.flags]), [['Qty', { visibility: 'true', readonly: 'false' }]]);
  assert.deepEqual(a.roles.map((r) => [r.name, r.description]), [['CEO', 'Top']]);
  assert.deepEqual(a.shareSettings.map((s) => s.key), ['role Hierarchy']);
  assert.equal(a.translations.length, 1);
  assert.deepEqual(a.translations[0].data, { en: { Item: 'Item' } });
});

test('ir v1: devices carry menus, per-device form settings and report layouts', () => {
  const { app: a, preserved } = load(
    app(`\tform Item
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tlist All_Items
\t{
\t\tshow all rows from Item
\t\t(
\t\t\tName
\t\t)
\t}
\tphone
\t{
\t\tmenu
\t\t{
\t\t\tsection S
\t\t\t{
\t\t\t\tform Item
\t\t\t\t{
\t\t\t\t\ticon = "x"
\t\t\t\t}
\t\t\t}
\t\t}
\t\tforms
\t\t{
\t\t\tform Item
\t\t\t{
\t\t\t\tlabel placement = left
\t\t\t}
\t\t}
\t\treports
\t\t{
\t\t\tlist All_Items
\t\t\t{
\t\t\t\tquickview
\t\t\t\t(
\t\t\t\t\tlayout
\t\t\t\t\t(
\t\t\t\t\t\ttype = 9
\t\t\t\t\t)
\t\t\t\t\taction
\t\t\t\t\t(
\t\t\t\t\t\ton left swipe
\t\t\t\t\t\t(
\t\t\t\t\t\t\tDelete
\t\t\t\t\t\t)
\t\t\t\t\t)
\t\t\t\t)
\t\t\t}
\t\t}
\t}`),
  );
  const [d] = a.devices;
  assert.equal(d.device, 'phone');
  assert.deepEqual(d.sections.map((s) => [s.name, s.components.map((c) => [c.kind, c.name])]), [['S', [['form', 'Item']]]]);
  assert.deepEqual(d.forms.map((f) => [f.name, f.properties.map((p) => p.key)]), [['Item', ['label placement']]]);
  const views = a.reports[0].views;
  assert.deepEqual(views.map((v) => [v.kind, v.device, v.layoutType, v.actions]), [['quickview', 'phone', '9', { 'on left swipe': ['Delete'] }]]);
  assert.deepEqual(preserved, {});
});

test('ir v1: page ZML tree and component references', () => {
  const zml = '<zml><layout><row><column><panel elementName="P1"><pr><pc><text type="Text" value="x"/></pc></pr></panel>' +
    '<report linkName="All_Items" appLinkName="t"/><chart formLinkName="Item" xfield="Name"/>' +
    '<button action="Open Url" target="same window">Go</button></column></row></layout></zml>';
  const roots = parseZml(zml);
  assert.equal(roots[0].tag, 'zml');
  const tags: string[] = [];
  const walk = (e: (typeof roots)[number]) => (tags.push(e.tag), e.children.forEach(walk));
  roots.forEach(walk);
  assert.deepEqual(tags, ['zml', 'layout', 'row', 'column', 'panel', 'pr', 'pc', 'text', 'report', 'chart', 'button']);
  assert.deepEqual(zmlReferences(roots), [
    { kind: 'panel', name: 'P1', via: 'elementName' },
    { kind: 'report', name: 'All_Items', via: 'linkName', app: 't' },
    { kind: 'chart', name: 'Item', via: 'formLinkName' },
  ]);
  // tolerant: stray closers and unclosed elements never throw
  const odd = parseZml('</x><a><b></a><c attr=1>');
  assert.deepEqual(odd.map((e) => [e.tag, e.children.map((c) => c.tag)]), [['a', ['b']], ['c', []]]);

  const kept = parseZml(
    '<zml><layout><row><column><dsp id="html_snippet"><![CDATA[<p>Hello</p><script>alert(1)</script>]]></dsp><text type="Text" value="Cap">Inner</text></column></row></layout></zml>',
  );
  const column = kept[0].children[0].children[0].children[0] as { tag: string; text?: string; children: { tag: string; text?: string }[] };
  assert.equal(column.tag, 'column');
  assert.equal(column.text, undefined);
  const dsp = column.children[0];
  assert.equal(dsp.tag, 'dsp');
  assert.match(dsp.text ?? '', /<p>Hello<\/p><script>alert\(1\)<\/script>/);
  const inner = column.children[1];
  assert.equal(inner.tag, 'text');
  assert.equal(inner.text?.trim(), 'Inner');

  const { app: a, preserved } = load(
    app(`\tsection S
\t{
\t\tpage Home
\t\t{
\t\t\tdisplayname = "Home"
\t\t\tContent="<zml><report linkName=\\"All_Items\\"/></zml>"
\t\t}
\t}`),
  );
  assert.deepEqual(preserved, {});
  assert.deepEqual(a.pages[0].references, [{ kind: 'report', name: 'All_Items', via: 'linkName' }]);
});

test('features: matrix rows are counted from IR nodes and Deluge tokens', () => {
  const { app: a } = load(
    app(`\tform Item
\t{
\t\tmust have Name
\t\t(
\t\t\ttype = text
\t\t)
\t\tPrice
\t\t(
\t\t\ttype = INR
\t\t)
\t\tLines
\t\t(
\t\t\ttype = grid
\t\t\tQty
\t\t\t(
\t\t\t\ttype = number
\t\t\t)
\t\t)
\t\tPhoto
\t\t(
\t\t\ttype = image
\t\t\tAI_Properties
\t\t\t(
\t\t\t\tfieldtype = OCR
\t\t\t)
\t\t)
\t}
\tworkflow
\t{
\tform
\t{
\t\tW as "W"
\t\t{
\t\t\ttype = form
\t\t\tform = Item
\t\t\ton add
\t\t\t{
\t\t\t\tactions
\t\t\t\t{
\t\t\t\ton validate
\t\t\t\t(
\t\t\t\t\t// sendmail in a comment and "zoho.crm.x" in a string never count
\t\t\t\t\tr = Item[Name == "a"];
\t\t\t\t\tr.Price = 2;
\t\t\t\t\tfor each l in input.Lines { if (l.Qty > 1) { alert "big"; } }
\t\t\t\t\tresp = zoho.crm.getRecords("Leads");
\t\t\t\t\tn = Item[Name != ""].count(ID);
\t\t\t\t\tinsert into Item [ Name = "b" ];
\t\t\t\t\tcancel submit;
\t\t\t\t)
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\t}`),
  );
  const r = featureReport([{ name: 'x', ir: a }]);
  const count = (feature: string) => {
    const u = r.usage.find((x) => x.row.feature === feature);
    assert.ok(u, feature);
    return u.occurrences;
  };
  assert.equal(count('Single line'), 1);
  assert.equal(count('Mandatory'), 1);
  assert.equal(count('Currency'), 1);
  assert.equal(count('Subform'), 1);
  assert.equal(count('OCR (text analysis)'), 1);
  assert.equal(count('Validation on form submission'), 1);
  assert.equal(count('fetch by criteria'), 2);
  assert.equal(count('update record'), 1);
  assert.equal(count('Subform row loop (input.Subform)'), 1);
  assert.equal(count('Aggregate (sum, count, min, max, distinct)'), 1);
  assert.equal(count('insert record'), 1);
  assert.equal(count('cancel submit'), 1);
  assert.equal(count('alert'), 1);
  assert.equal(count('sendmail'), 0, 'comments are trivia');
  assert.equal(count('zoho.crm.*'), 1, 'only the call, not the string');
  assert.deepEqual([...r.namespaces], [['zoho.crm.*', [1, 1]]]);
  const unobservable = r.usage.find((u) => u.row.feature === 'Statement limit')!;
  assert.equal(unobservable.row.count, undefined, 'not observable rows have no detector');
  const md = formatFeatures('t', r);
  assert.match(md, /UNCOVERED/);
  assert.match(md, /\| Deluge \| Statement limit \| n\/o \| n\/o \|/);
  const s = r.apps[0].summary;
  assert.deepEqual([s.forms, s.fields, s.workflowsByKind, s.pages], [1, 4, { form: 1 }, 0]);
  assert.ok(s.delugeStatements >= 7);
});

test('features: gap-fixture encodings (users module, Formula_Properties, KeywordExtractor, qrcode type, pushnotification)', () => {
  const { app: a } = load(
    app(`\tform F
\t{
\t\tOwner
\t\t(
\t\t\ttype = picklist
\t\t\tmodule = users
\t\t)
\t\tTotal
\t\t(
\t\t\ttype = decimal
\t\t\tFormula_Properties
\t\t\t(
\t\t\t\tvalue = "Price * 2"
\t\t\t)
\t\t)
\t\tNotes
\t\t(
\t\t\ttype = textarea
\t\t\tAI_Properties
\t\t\t(
\t\t\t\tfieldtype = KeywordExtractor
\t\t\t\tbasefield = Owner
\t\t\t)
\t\t)
\t\tCode
\t\t(
\t\t\ttype = QRCode
\t\t)
\t}
\tworkflow
\t{
\tform
\t{
\t\tW as "W"
\t\t{
\t\t\ttype = form
\t\t\tform = F
\t\t\ton add
\t\t\t{
\t\t\t\tactions
\t\t\t\t{
\t\t\t\ton success
\t\t\t\t(
\t\t\t\t\tpushnotification(zoho.loginuser, "done");
\t\t\t\t)
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\t}`),
  );
  const r = featureReport([{ name: 'x', ir: a }]);
  const count = (feature: string) => {
    const u = r.usage.find((x) => x.row.feature === feature);
    assert.ok(u, feature);
    return u.occurrences;
  };
  assert.equal(count('Users'), 1);
  assert.equal(count('Formula'), 1);
  assert.equal(count('Keyword extraction'), 1);
  assert.equal(count('Barcode / QR code'), 1);
  assert.equal(count('Push / in-app notification'), 1);
});
