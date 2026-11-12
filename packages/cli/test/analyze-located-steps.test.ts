/**
 * Counted Deluge constructs whose translator item has no step get a manual
 * step that names their located workflow and the by-hand change.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { analyze } from '../src/analyze.js';

const APP = `application "Demo"
{
\tsection Main
\t{
\t\tform Invoice
\t\t{
\t\t\tEmail
\t\t\t(
\t\t\t\ttype = email
\t\t\t)
\t\t}
\t\tlist Pending_Invoices
\t\t{
\t\t\tshow all rows from Invoice
\t\t}
\t}
\tworkflow
\t{
\tform
\t{
\t\tPayment_Reminder as "Payment Reminder"
\t\t{
\t\t\ttype =  form
\t\t\tform = Invoice
\t\t\trecord event = on add
\t\t\ton success
\t\t\t{
\t\t\t\tactions
\t\t\t\t{
\t\t\t\t\tcustom deluge script
\t\t\t\t\t(
\t\t\t\t\t\tsendmail
\t\t\t\t\t\t[
\t\t\t\t\t\t\tfrom :zoho.adminuserid
\t\t\t\t\t\t\tto :input.Email
\t\t\t\t\t\t\tsubject :"Reminder"
\t\t\t\t\t\t\tmessage :"Pending invoices attached"
\t\t\t\t\t\t\tAttachments :view:Pending_Invoices[Email == input.Email] as PDF
\t\t\t\t\t\t]
\t\t\t\t\t)
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\t}
}
`;

test('a sendmail report-view attachment names its workflow in the manual step', () => {
  const report = analyze(deriveIr(parse(APP)));
  const item = report.deluge.todoLocations.find((todo) => todo.construct === 'sendmail-attachment:view');
  assert.ok(item, JSON.stringify(report.deluge.todoLocations));
  assert.match(item.location, /Payment_Reminder/);
  assert.equal(
    item.manualStep,
    `In ${item.location}, the sendmail task attaches a report view rendered as a file, which is not generated. Render that report's matching rows to the requested format in a Catalyst function, attach the file to the mail by hand, and send a test mail.`,
  );
});

test('the step a translator item carries wins, and an unlisted construct gets none', async () => {
  const { locatedManualStep } = await import('../src/analyze.js');
  assert.equal(locatedManualStep('sendmail-attachment:view', 'workflow Reminder:4', 'own step'), 'own step');
  assert.equal(locatedManualStep('unknown-construct', 'workflow Reminder:4'), undefined);
});

test('a client loop over server data names its location in the manual step', async () => {
  const { locatedManualStep } = await import('../src/analyze.js');
  const step = locatedManualStep('client-loop-uses-server', 'workflow Run_Scripts:18');
  assert.match(step ?? '', /^In workflow Run_Scripts:18, a for each loop in the form's client script iterates values only the server can read/);
});
