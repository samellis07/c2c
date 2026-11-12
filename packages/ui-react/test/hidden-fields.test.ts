/**
 * A field whose schema step generates a column must keep a drawn control.
 * `hiddenParts` only lists a field when the generator left no column at all
 * (prediction, geolocation): an integration field gets a text column (see
 * schema/src/mapping.ts), so it must render like the other column-backed
 * gap kinds (keyword, sentiment, ocr, object-detection, legacy-crm, barcode)
 * instead of disappearing from the form.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseFile } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { hiddenParts, reactAppSpec } from '../src/index.js';

const DS = join(repoRoot(), 'fixtures/synthetic/kitchen-sink-gaps/kitchen_sink_gaps.ds');

test('an integration field keeps a drawn, read-only control instead of being hidden', () => {
  const app = parseFile(DS).ir;
  const spec = reactAppSpec(app);
  const form = spec.forms['Artifact_Intake'];
  assert.ok(form, 'Artifact_Intake form');
  const field = form!.fields.find((f) => f.name === 'External_Record');
  assert.ok(field, 'External_Record field');
  assert.equal(field!.widget, 'integration');
  assert.equal(field!.generated, true, 'the schema step gives this field a column, so the form must draw it');

  const hidden = hiddenParts(spec);
  assert.ok(
    !hidden.some((part) => part.location === 'form Artifact_Intake field External_Record'),
    'a drawn field must not also be reported as hidden from end users',
  );

  // The other column-backed gap kinds in the same fixture stay drawn too.
  for (const name of ['Extracted_Terms', 'Tone_Result', 'Text_From_Image', 'Detected_Objects', 'Shelf_Code', 'Old_Crm_Reference', 'Old_Crm_Record']) {
    const other = form!.fields.find((f) => f.name === name);
    assert.ok(other, `${name} field`);
    assert.equal(other!.generated, true, `${name} keeps its column-backed control`);
  }

  // A kind with no column at all (prediction, geolocation) stays hidden.
  for (const name of ['Forecast', 'Site_Location']) {
    const noColumn = form!.fields.find((f) => f.name === name);
    assert.ok(noColumn, `${name} field`);
    assert.equal(noColumn!.generated, false, `${name} has no generated column`);
    assert.ok(
      hidden.some((part) => part.location === `form Artifact_Intake field ${name}`),
      `${name} stays listed as hidden from end users`,
    );
  }
});
