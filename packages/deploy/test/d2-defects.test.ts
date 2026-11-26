/**
 * Differential-case defects: a bad value must be a 4xx on every write route,
 * and a Creator `must have` grid must be present on an insert.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { startOfflineBackend } from '../src/verify-behavior.js';

const DS = `application "d2-defects"
{
\ttime zone = "Asia/Kolkata"
\tshare_settings
\t{
\t\t"Administrator"
\t\t{
\t\t\tname = "Administrator"
\t\t\ttype = Users_Permissions
\t\t\tdescription = "This profile will have all the permissions."
\t\t}
\t}
\tsection S
\t{
\t\tform Bug
\t\t{
\t\t\tmust have Title
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t\tmust have Priority
\t\t\t(
\t\t\t\ttype = radiobuttons
\t\t\t\tvalues = {"High","Medium","Low"}
\t\t\t)
\t\t\tNote
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t\tform Bom
\t\t{
\t\t\tmust have Name
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t\tmust have Items
\t\t\t(
\t\t\t\ttype = grid
\t\t\t\tmust have Item
\t\t\t\t(
\t\t\t\t\ttype = text
\t\t\t\t)
\t\t\t\tQty
\t\t\t\t(
\t\t\t\t\ttype = number
\t\t\t\t)
\t\t\t)
\t\t}
\t\tlist All_Bugs
\t\t{
\t\t\tshow all rows from Bug
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tBug_Success as "Bug Success"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Bug
\t\t\t\trecord event = on add
\t\t\t\ton success
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tinput.Note = "done";
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t\tBom_Success as "Bom Success"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Bom
\t\t\t\trecord event = on add
\t\t\t\ton success
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tinput.Name = input.Name;
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;

async function post(form: string, route: 'success' | 'submit', record: Record<string, unknown>) {
  const backend = await startOfflineBackend(deriveIr(parse(DS)));
  try {
    await backend.reset?.();
    const reply = await backend.call('POST', `/forms/${form}/${route}`, { record });
    return { reply, rows: await backend.tableRows(form) };
  } finally {
    await backend.close();
  }
}

for (const route of ['success', 'submit'] as const) {
  test(`${route}: a radio value outside the list is a 400 and nothing is stored`, async () => {
    const { reply, rows } = await post('Bug', route, { Title: 'Crash', Priority: 'Urgent' });
    assert.equal(reply.status, 400, JSON.stringify(reply.body));
    assert.equal((reply.body as { code?: string }).code, 'INVALID_INPUT');
    assert.equal(rows.length, 0);
  });

  test(`${route}: a listed radio value still saves`, async () => {
    const { reply, rows } = await post('Bug', route, { Title: 'Crash', Priority: 'High' });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(rows.length, 1);
  });
}

for (const route of ['success', 'submit'] as const) {
  test(`${route}: an absent or empty must-have grid is a 422 and nothing is stored`, async () => {
    for (const record of [{ Name: 'Frame' }, { Name: 'Frame', Items: [] }, { Name: 'Frame', Items: null }]) {
      const { reply, rows } = await post('Bom', route, record);
      assert.equal(reply.status, 422, JSON.stringify(reply.body));
      assert.equal((reply.body as { code?: string; field?: string }).code, 'MANDATORY_MISSING');
      assert.equal((reply.body as { field?: string }).field, 'Items');
      assert.equal(rows.length, 0);
    }
  });

  test(`${route}: a grid with a row still saves`, async () => {
    const { reply, rows } = await post('Bom', route, { Name: 'Frame', Items: [{ Item: 'Bolt', Qty: 2 }] });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(rows.length, 1);
  });
}
