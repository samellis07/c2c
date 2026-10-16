/**
 * The phone record card shows the columns the scorer expects: the phone quick
 * view's fields when the export has one, else the first four report columns.
 * The generator and the scorer share that selection (core phone-columns.ts),
 * and the desktop list keeps the web quick view's columns.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi } from '../../ui/src/index.js';
import { bundleFromFiles, expectedFromIr, scoreUi } from '../src/score.js';

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function fields(names: string[]): string {
  return names.map((name) => `\t\t${name}\n\t\t(\n\t\t\ttype = text\n\t\t)`).join('\n');
}

function quickview(device: string, report: string, names: string[]): string {
  const list = names.map((name) => `\t\t\t\t\t\t\t\t${name}`).join('\n');
  return `\t${device}\n\t{\n\t\treports\n\t\t{\n\t\t\treport ${report}\n\t\t\t{\n\t\t\t\tquickview\n\t\t\t\t(\n\t\t\t\t\tlayout\n\t\t\t\t\t(\n\t\t\t\t\t\tdatablock1\n\t\t\t\t\t\t(\n\t\t\t\t\t\t\tfields\n\t\t\t\t\t\t\t(\n${list}\n\t\t\t\t\t\t\t)\n\t\t\t\t\t\t)\n\t\t\t\t\t)\n\t\t\t\t)\n\t\t\t}\n\t\t}\n\t}`;
}

// The appointment-management All_Appointments shape: only a web quick view,
// whose fields are not the report's first four columns.
const WEB_ONLY_FIELDS = ['Staff_Name', 'Schedule_Date', 'Schedule_Upto', 'Customer_Email', 'Customer_Name', 'Address', 'Service', 'Branch', 'Booking_Id'];
const WEB_ONLY = `
\tform Appointment
\t{
${fields(WEB_ONLY_FIELDS)}
\t}
\tlist All_Appointments
\t{
\t\tdisplayName = "All Appointments"
\t\tshow all rows from Appointment
\t\t(
${WEB_ONLY_FIELDS.map((name) => `\t\t\t${name}`).join('\n')}
\t\t)
\t}
${quickview('web', 'All_Appointments', ['Booking_Id', 'Address', 'Branch', 'Service', 'Customer_Name'])}
`;

// A phone quick view with six fields: the fifth and sixth must not be cut by
// a four-cell card cap. Its related path has no value in a report row.
const PHONE_FIELDS = ['Name', 'Code', 'City', 'Phone', 'Email', 'Branch', 'Notes'];
const PHONE_WIDE = `
\tform Staff
\t{
${fields(PHONE_FIELDS)}
\t}
\tlist Staff_Details
\t{
\t\tdisplayName = "Staff Details"
\t\tshow all rows from Staff
\t\t(
${PHONE_FIELDS.map((name) => `\t\t\t${name}`).join('\n')}
\t\t\tHours.Days
\t\t)
\t}
${quickview('phone', 'Staff_Details', ['Notes', 'Branch', 'Email', 'Phone', 'City', 'Code', 'Hours.Days'])}
${quickview('web', 'Staff_Details', ['Name', 'Code', 'City'])}
`;

async function phoneChecks(app: App) {
  const result = await scoreUi(app, bundleFromFiles(buildUi(app).files));
  const pick = (kind: string) => result.checks.filter((check) => check.id.startsWith(`${kind}:`));
  return { pcol: pick('pcol'), col: pick('col') };
}

test('a web-only quick view: the phone card shows the first four report columns, labelled', async () => {
  const app = appOf(WEB_ONLY);
  const report = buildUi(app).model.reports.find((item) => item.name === 'All_Appointments');
  assert.ok(report);
  // Desktop keeps the web quick view's columns, in its order.
  assert.deepEqual(
    report.columns.map((column) => column.field),
    ['Booking_Id', 'Address', 'Branch', 'Service', 'Customer_Name'],
  );
  assert.deepEqual(
    report.phoneColumns?.map((column) => column.field),
    ['Staff_Name', 'Schedule_Date', 'Schedule_Upto', 'Customer_Email'],
  );
  assert.deepEqual(report.phoneColumns, expectedFromIr(app).reports.find((item) => item.name === 'All_Appointments')?.phoneColumns);
  const { pcol, col } = await phoneChecks(app);
  assert.equal(pcol.length, 4);
  assert.deepEqual(pcol.filter((check) => !check.pass).map((check) => check.id), []);
  assert.ok(col.every((check) => check.pass || !['Booking_Id', 'Address', 'Branch', 'Service', 'Customer_Name'].some((name) => check.id.endsWith(`.${name}`))));
});

test('a six-field phone quick view shows every field on the card in its order; a related path is left out', async () => {
  const app = appOf(PHONE_WIDE);
  const report = buildUi(app).model.reports.find((item) => item.name === 'Staff_Details');
  assert.ok(report);
  assert.deepEqual(
    report.columns.map((column) => column.field),
    ['Name', 'Code', 'City'],
  );
  // The selection is the scorer's, minus the related path no row carries.
  assert.deepEqual(
    report.phoneColumns?.map((column) => column.field),
    ['Code', 'City', 'Phone', 'Email', 'Branch', 'Notes'],
  );
  const expected = expectedFromIr(app).reports.find((item) => item.name === 'Staff_Details')?.phoneColumns ?? [];
  assert.deepEqual(report.phoneColumns, expected.filter((column) => !column.field.includes('.')));
  const { pcol } = await phoneChecks(app);
  assert.deepEqual(
    pcol.filter((check) => !check.pass).map((check) => check.id),
    ['pcol:Staff_Details.Hours.Days'],
  );
});

test('the painted row keeps the desktop cells first and orders the card by the phone columns', async () => {
  const app = appOf(PHONE_WIDE);
  const runtime = readFileSync(join(process.cwd(), 'packages/ui/src/client-runtime.js'), 'utf8');
  const mod = (await import(`data:text/javascript;base64,${Buffer.from(runtime).toString('base64')}`)) as {
    renderReportRows(report: unknown, rows: unknown[]): string;
  };
  const report = buildUi(app).model.reports.find((item) => item.name === 'Staff_Details');
  const html = mod.renderReportRows(report, [{ ROWID: '1', Name: 'Ann', Code: 'C1', City: 'Springfield', Phone: '9', Email: 'a@x', Branch: 'B', Notes: 'N' }]);
  const cells = Array.from(html.matchAll(/<td([^>]*)>/g))
    .filter((m) => !/data-bulk-select-cell/.test(m[1]!))
    .map((m) => {
    const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(m[1]!)?.[1];
    return [attr('data-th'), attr('data-phone') ?? null, /data-phone-only/.test(m[1]!)];
  });
  assert.deepEqual(cells.slice(0, 3), [
    ['Name', null, false],
    ['Code', '0', false],
    ['City', '1', false],
  ]);
  assert.deepEqual(cells.slice(3, 7), [
    ['Phone', '2', true],
    ['Email', '3', true],
    ['Branch', '4', true],
    ['Notes', '5', true],
  ]);
});

// The real All_Appointments is a calendar: its board card names the phone
// fields on a phone and keeps them off the desktop board.
const CALENDAR = `
\tform Visit
\t{
\t\tStaff_Name
\t\t(
\t\t\ttype = text
\t\t)
\t\tStarts
\t\t(
\t\t\ttype = datetime
\t\t)
\t\tCustomer_Email
\t\t(
\t\t\ttype = email
\t\t)
\t\tBranch
\t\t(
\t\t\ttype = text
\t\t)
\t\tBooking_Id
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tcalendar Visits
\t{
\t\tdisplayName = "Visits"
\t\tshow all rows from Visit
\t\t(
\t\t\tStaff_Name
\t\t\tStarts
\t\t\tCustomer_Email
\t\t\tBranch
\t\t\tBooking_Id
\t\t)
\t\toptions
\t\t(
\t\t\tdisplay field = Booking_Id
\t\t\tstart date = Starts
\t\t)
\t}
${quickview('web', 'Visits', ['Booking_Id', 'Branch'])}
`;

test('a calendar card shows the phone fields on a phone only', async () => {
  const app = appOf(CALENDAR);
  const report = buildUi(app).model.reports.find((item) => item.name === 'Visits');
  assert.equal(report?.view, 'calendar', report?.todo);
  assert.deepEqual(report.columns.map((column) => column.field), ['Booking_Id', 'Branch']);
  assert.deepEqual(report.phoneColumns?.map((column) => column.field), ['Staff_Name', 'Starts', 'Customer_Email', 'Branch']);
  const { pcol, col } = await phoneChecks(app);
  assert.equal(pcol.length, 4);
  assert.deepEqual(pcol.filter((check) => !check.pass).map((check) => check.id), []);
  // The desktop board still shows only its title and start: the phone field
  // list (which names Staff Name and Customer Email) stays hidden there.
  assert.deepEqual(col.filter((check) => check.pass).map((check) => check.id).sort(), ['col:Visits.Booking_Id', 'col:Visits.Starts']);
});
