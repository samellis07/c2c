import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi, type UiModel } from '../src/index.js';

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function fieldApp(type: string, extra: string): UiModel {
  return buildUi(appOf(`\tform Clip\n\t{\n\t\tMedia\n\t\t(\n\t\t\ttype = ${type}\n${extra}\t\t)\n\t}\n`)).model;
}

const mediaTodos = (model: UiModel) => model.todos.filter((t) => t.area === 'field');

test('video duration is generated as a recording limit, not a counted todo', () => {
  const model = fieldApp('video', '\t\t\tduration=30\n');
  assert.deepEqual(mediaTodos(model), []);
  assert.equal(model.forms[0]!.fields[0]!.media?.recordSeconds, 30);
});

test('video duration that is not a positive whole number stays a counted todo', () => {
  for (const bad of ['0', 'abc', '-5', '90000']) {
    const model = fieldApp('video', `\t\t\tduration=${bad}\n`);
    assert.equal(mediaTodos(model).length, 1, bad);
    assert.equal(model.forms[0]!.fields[0]!.media?.recordSeconds, undefined, bad);
  }
});

test('image annotation = true is generated as a markup step', () => {
  const model = fieldApp('image', '\t\t\tannotation = true\n');
  assert.deepEqual(mediaTodos(model), []);
  assert.equal(model.forms[0]!.fields[0]!.media?.annotate, true);
});

test('image show onload = true is generated as an open-on-load camera', () => {
  const model = fieldApp('image', '\t\t\tshow onload = true\n');
  assert.deepEqual(mediaTodos(model), []);
  assert.equal(model.forms[0]!.fields[0]!.media?.onload, true);
});

test('image camera = secondary selects the front lens when a media feature is declared', () => {
  const model = fieldApp('image', '\t\t\tcamera = secondary\n\t\t\tannotation = true\n');
  assert.equal(model.forms[0]!.fields[0]!.media?.camera, 'secondary');
});

test('a plain image field gets no media block (generated output unchanged)', () => {
  const model = fieldApp('image', '\t\t\tcamera = primary\n\t\t\tannotation = false\n\t\t\tpreview duration = 0\n');
  assert.equal(model.forms[0]!.fields[0]!.media, undefined);
  assert.deepEqual(mediaTodos(model), []);
});
