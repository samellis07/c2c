/**
 * Loading, empty and not-found on the vanilla bundle: an unknown route paints a
 * heading with focus and a way home, a search with no match offers a clear
 * control that restores the rows, and a long cell wraps instead of widening the page.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildUi } from '../../ui/src/index.js';
import { bundleFromFiles } from '../src/score.js';
import { checkUiStates } from '../src/states.js';

const SOURCE = `application "Order Desk"
{
\tsection Sales
\t{
\t\tform Order
\t\t{
\t\t\tdisplayname = "New Order"
\t\t\tTitle
\t\t\t(
\t\t\t\ttype = text
\t\t\t\tdisplayname = "Title"
\t\t\t)
\t\t}
\t\tlist All_Orders
\t\t{
\t\t\tdisplayname = "All Orders"
\t\t\tshow all rows from Order
\t\t\t(
\t\t\t\tTitle
\t\t\t)
\t\t}
\t}
}
`;

test('vanilla: not-found, filtered-empty, pagination and long-text rows pass', async () => {
  const app = deriveIr(parse(SOURCE));
  const bundle = bundleFromFiles(buildUi(app).files);
  const verdicts = await checkUiStates(app, bundle, { ui: 'vanilla' });
  for (const state of ['loading', 'empty', 'not-found', 'empty-filtered', 'pagination', 'long-text']) {
    const v = verdicts.find((row) => row.state === state);
    assert.ok(v, `no verdict for ${state}`);
    assert.equal(v.status, 'pass', `${state}: ${v.evidence}`);
  }
});
