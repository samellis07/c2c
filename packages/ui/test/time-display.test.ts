import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildModel } from '../src/index.js';

function createModel(fieldBlock: string) {
  const ir = deriveIr(
    parse(`application "TestApp"
{
  form Events
  {
${fieldBlock}
  }
}
`),
  );
  return buildModel(ir);
}

test('datetime field with timedisplayoptions hh:mm:ss sets timeStep 1 and showSeconds true without UI todo', () => {
  const model = createModel(`
    Scheduled_Time
    (
      type = datetime
      timedisplayoptions = "hh:mm:ss"
    )
  `);
  const field = model.forms[0]?.fields.find((f) => f.name === 'Scheduled_Time');
  assert.ok(field, 'Scheduled_Time field should exist');
  assert.equal(field.widget, 'datetime');
  assert.equal(field.timeStep, 1);
  assert.equal(field.showSeconds, true);

  const todo = model.todos.find((t) => t.name === 'Events.Scheduled_Time property timedisplayoptions');
  assert.equal(todo, undefined, 'should not emit a manual todo for datetime seconds');
});

test('datetime field with case-variant timedisplayoptions HH:mm:ss sets timeStep 1 and showSeconds true', () => {
  const model = createModel(`
    Start_Time
    (
      type = datetime
      timedisplayoptions = "HH:mm:ss"
    )
  `);
  const field = model.forms[0]?.fields.find((f) => f.name === 'Start_Time');
  assert.ok(field);
  assert.equal(field.timeStep, 1);
  assert.equal(field.showSeconds, true);
});

test('datetime field with timedisplayoptions hh:mm does not set timeStep or showSeconds', () => {
  const model = createModel(`
    Arrival_Time
    (
      type = datetime
      timedisplayoptions = "hh:mm"
    )
  `);
  const field = model.forms[0]?.fields.find((f) => f.name === 'Arrival_Time');
  assert.ok(field);
  assert.equal(field.timeStep, undefined);
  assert.equal(field.showSeconds, undefined);

  const todo = model.todos.find((t) => t.name === 'Events.Arrival_Time property timedisplayoptions');
  assert.equal(todo, undefined);
});

test('datetime field without timedisplayoptions does not set timeStep or showSeconds', () => {
  const model = createModel(`
    Created_At
    (
      type = datetime
    )
  `);
  const field = model.forms[0]?.fields.find((f) => f.name === 'Created_At');
  assert.ok(field);
  assert.equal(field.timeStep, undefined);
  assert.equal(field.showSeconds, undefined);
});

test('time field with timedisplayoptions hh:mm:ss leaves timeStep/showSeconds unset and records UI todo', () => {
  const model = createModel(`
    Shift_Start
    (
      type = time
      timedisplayoptions = "hh:mm:ss"
    )
  `);
  const field = model.forms[0]?.fields.find((f) => f.name === 'Shift_Start');
  assert.ok(field);
  assert.equal(field.widget, 'time');
  assert.equal(field.timeStep, undefined);
  assert.equal(field.showSeconds, undefined);

  const todo = model.todos.find((t) => t.name === 'Events.Shift_Start property timedisplayoptions');
  assert.ok(todo, 'expected a manual todo for time field with seconds');
  assert.match(todo.reason, /hh:mm:ss/);
});
