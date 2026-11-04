/**
 * The field `layout` property and the device `customize { layout }` value are
 * carried into the React app spec: option columns/cards on fields, the phone
 * form arrangement on the form, and the device navigation layout on the app.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { reactAppSpec } from '../src/index.js';

function appOf(body: string, device?: string): App {
  return deriveIr(parse(`application "Layout Demo"\n{\n${body}${device ? `\n${device}` : ''}\n}\n`));
}

const BODY = `\tform Cases
\t{
\t\tdisplayname = "Cases"
\t\tSource
\t\t(
\t\t\ttype = radiobuttons
\t\t\tvalues = {"Call","Email","Social Media","Website"}
\t\t\tlayout = 2
\t\t)
\t\tPriority
\t\t(
\t\t\ttype = radiobuttons
\t\t\tvalues = {"High","Normal","Low"}
\t\t\tlayout = 3
\t\t)
\t\tOwner
\t\t(
\t\t\ttype = radiobuttons
\t\t\tvalues = {"Me","Team"}
\t\t\tlayout = onecolumncard
\t\t)
\t}`;

test('field layout values reach the React field spec', () => {
  const spec = reactAppSpec(appOf(BODY));
  const fields = spec.forms.Cases.fields;
  assert.equal(fields.find((f) => f.name === 'Source')?.optionColumns, 2);
  assert.equal(fields.find((f) => f.name === 'Priority')?.optionColumns, 3);
  const owner = fields.find((f) => f.name === 'Owner');
  assert.equal(owner?.optionColumns, 1);
  assert.equal(owner?.optionCard, true);
});

test('a device customize layout reaches the app and form specs', () => {
  for (const [raw, carried] of [
    ['twocolumn', 'two-column'],
    ['onecolumncard', 'one-column-card'],
    ['slidingpane', 'sliding-pane'],
    ['tabbar', 'tab-bar'],
  ] as const) {
    const device = `\tphone\n\t{\n\t\tcustomize\n\t\t{\n\t\t\tlayout = ${raw}\n\t\t}\n\t}`;
    const spec = reactAppSpec(appOf(BODY, device));
    assert.equal(spec.phoneLayout, carried, raw);
    assert.equal(spec.forms.Cases.phoneLayout, carried, raw);
  }
  const tablet = `\ttablet\n\t{\n\t\tcustomize\n\t\t{\n\t\t\tlayout = slidingpane\n\t\t}\n\t}`;
  assert.equal(reactAppSpec(appOf(BODY, tablet)).tabletLayout, 'sliding-pane');
});

test('an unknown device layout value is not carried into the spec', () => {
  const device = `\tphone\n\t{\n\t\tcustomize\n\t\t{\n\t\t\tlayout = triplestack\n\t\t}\n\t}`;
  const spec = reactAppSpec(appOf(BODY, device));
  assert.equal(spec.phoneLayout, undefined);
});
