import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { generateSchema } from '../../schema/src/generator.js';
import { generateUi } from '../../ui/src/generate.js';
import { generateReactApp } from '../../ui-react/src/generate.js';
import { DEFAULT_EQUIVALENCE } from '../src/default-equivalence.js';
import { collectOutputs, coverageLedger } from '../src/no-silent-drop.js';

const TYPE: Record<string, string> = { image: 'image', file: 'upload file' };

function dsApp(type: string, lines: string[]): App {
  const props = lines.map((line) => `\t\t\t${line}\n`).join('');
  return deriveIr(parse(`application "Demo"\n{\n\tform Profile\n\t{\n\t\tName\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t\tAttachment\n\t\t(\n\t\t\ttype = ${type}\n${props}\t\t)\n\t}\n}\n`));
}

const bytes = (data: string | Buffer): string => (typeof data === 'string' ? data : data.toString('base64'));

/** Every generated artifact for the app: schema plan, static UI bundle, React app. */
function generated(source: App): string {
  const ui = generateUi(source);
  return JSON.stringify({
    schema: generateSchema(source),
    ui: ui.files.map((file) => [file.path, bytes(file.data)]),
    react: generateReactApp(source).map((file) => [file.path, bytes(file.data)]),
  });
}

function status(source: App, key: string): string | undefined {
  return coverageLedger(source, collectOutputs(source)).find((row) => row.name === `Profile.Attachment property ${key}`)?.status;
}

for (const row of DEFAULT_EQUIVALENCE) {
  const type = TYPE[row.widget]!;
  test(`${row.key} = ${row.value} on a ${row.widget} field generates the default output and is emitted`, () => {
    const withValue = dsApp(type, [`${row.key} = ${row.value}`]);
    const without = dsApp(type, []);
    assert.equal(generated(withValue), generated(without));
    const field = collectOutputs(withValue).model.forms[0]!.fields.find((f) => f.name === 'Attachment')!;
    assert.equal(field.widget, row.widget);
    assert.equal(field.accept, row.accept);
    assert.equal(status(withValue, row.key), 'emitted');
  });
}

test('a non-default value of a listed property stays a drop', () => {
  assert.equal(status(dsApp('image', ['source = public_url,file']), 'source'), 'dropped');
  assert.equal(status(dsApp('image', ['aspect ratio = square']), 'aspect ratio'), 'dropped');
  assert.equal(status(dsApp('image', ['camera = secondary']), 'camera'), 'dropped');
  assert.equal(status(dsApp('image', ['switch camera = false']), 'switch camera'), 'dropped');
  assert.equal(status(dsApp('image', ['show gallery = false']), 'show gallery'), 'dropped');
  assert.equal(status(dsApp('upload file', ['browse = local_drive, google_docs, zoho_docs']), 'browse'), 'dropped');
});

test('a listed value on a widget the row does not name stays a drop', () => {
  assert.equal(status(dsApp('upload file', ['source = file']), 'source'), 'dropped');
  assert.equal(status(dsApp('image', ['browse = local_drive']), 'browse'), 'dropped');
});

test('generated presentation that differs from the Creator value is not in the table', () => {
  const keys = DEFAULT_EQUIVALENCE.map((row) => row.key);
  assert.ok(!keys.includes('timedisplayoptions'));
  assert.ok(!keys.includes('toolbar'));
  const time = deriveIr(parse('application "Demo"\n{\n\tform Profile\n\t{\n\t\tWhen\n\t\t(\n\t\t\ttype = datetime\n\t\t\ttimedisplayoptions = "hh:mm:ss"\n\t\t)\n\t}\n}\n'));
  assert.equal(coverageLedger(time, collectOutputs(time)).find((row) => row.name === 'Profile.When property timedisplayoptions')?.status, 'dropped');
});
