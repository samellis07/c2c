/**
 * A ZML `<image>` click action is never dropped silently. The HTML parser
 * reads `<image>` as `<img>` and the sanitizer keeps no `action`, and the
 * generated page has no client path that calls a Creator function, so every
 * action stays a counted manual step naming the function and the element.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { generateUi } from '../src/index.js';
import { zmlExecuteFunctionButtons, zmlImageActions } from '../src/htmlpage.js';
import { leaves } from '../src/pages.js';

const ADMIN = { name: 'Administrator', type: 'Users_Permissions', properties: [], modules: [], span: { start: 0, end: 0 } };

function appOf(body: string): App {
  const app = deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
  app.profiles.push(ADMIN);
  return app;
}

function page(zml: string): string {
  return `\tpages\n\t{\n\t\tpage Home\n\t\t{\n\t\t\tContent=${JSON.stringify(zml)}\n\t\t}\n\t}`;
}

function snippetPage(snippet: string): string {
  return page(`<zml><layout><row><column width='100%'><dsp id='hp1'><![CDATA[${snippet}]]></dsp></column></row></layout></zml>`);
}

const SNIPPET_TODO = 'Server-side Deluge snippet requires manual translation';
const IMAGE = `<image action='Function' functionName='notify_team' elementName='Bell' src='https://example.com/bell.png'>`;
const BUTTON = `<button action='ExecuteFunction' functionName='open_case' elementName='Open case'>`;

function buttonTodos(model: ReturnType<typeof generateUi>['model']) {
  return model.todos.filter((todo) => todo.reason.includes('<button>'));
}

function imageTodos(model: ReturnType<typeof generateUi>['model']) {
  return model.todos.filter((todo) => todo.name === 'Home.image');
}

function htmlOf(model: ReturnType<typeof generateUi>['model']): string {
  return leaves(model.pages[0].elements)
    .filter((el) => el.kind === 'html')
    .map((el) => el.html ?? '')
    .join('');
}

test('a static snippet image with a Function action is a counted manual step', () => {
  const { model } = generateUi(appOf(snippetPage(`<p>Alerts</p>${IMAGE}`)));
  const todos = imageTodos(model);
  assert.equal(todos.length, 1);
  assert.match(todos[0].reason, /"Bell" click action Function calling function notify_team is not generated/);
  assert.match(htmlOf(model), /<img src="https:\/\/example\.com\/bell\.png">/);
  assert.equal(model.pages[0].status, 'partial');
});

test('an empty server wrapper does not hide the image action', () => {
  const { model } = generateUi(appOf(snippetPage(`htmlpage hp1()\ncontent\n<%{%}>\n${IMAGE}`)));
  assert.deepEqual(
    model.todos.map((todo) => todo.reason.includes('notify_team')),
    [true],
  );
});

test('an image without an action is unchanged and adds no TODO', () => {
  const { model } = generateUi(appOf(snippetPage(`<p>Alerts</p><image src='https://example.com/bell.png'>`)));
  assert.deepEqual(model.todos, []);
  assert.match(htmlOf(model), /<img src="https:\/\/example\.com\/bell\.png">/);
  assert.equal(model.pages[0].status, 'generated');
});

test('islands the sanitizer drops keep the snippet manual and the image TODO names the reason', () => {
  const snippet = `htmlpage hp1(c)\ncontent\n<image action='Function' functionName='notify_team' bgColor='<%=input.c%>' successMsg='<%=input.c%>'>`;
  const { model } = generateUi(appOf(snippetPage(snippet)));
  assert.equal(model.todos.filter((todo) => todo.reason === SNIPPET_TODO).length, 1);
  const todos = imageTodos(model);
  assert.equal(todos.length, 1);
  assert.match(todos[0].reason, /calling function notify_team .*\(the snippet stays manual: island in an unsafe position\)$/);
});

test('an icon image with an action keeps the icon and counts the action', () => {
  const { model } = generateUi(appOf(page(`<zml><layout><row><column><image type='icon' value='bell' action='Function' functionName='ping'/></column></row></layout></zml>`)));
  const todos = imageTodos(model);
  assert.equal(todos.length, 1);
  assert.match(todos[0].reason, /"bell" click action Function calling function ping/);
  const icon = leaves(model.pages[0].elements).find((el) => el.icon === 'bell');
  assert.ok(icon);
});

test('an icon image without an action adds no TODO', () => {
  const { model } = generateUi(appOf(page(`<zml><layout><row><column><image type='icon' value='bell'/></column></row></layout></zml>`)));
  assert.deepEqual(model.todos, []);
});

test('image markup inside a Deluge island is not an image action', () => {
  assert.deepEqual(zmlImageActions(`<p><%= "<image action='Function'>" %></p>`), []);
  assert.deepEqual(zmlImageActions(`<IMAGE ACTION="OpenUrl" src="x.png"><image action=''>`), [{ action: 'OpenUrl', siteId: 'image-0', label: 'x.png' }]);
});

test('a plain non-island ExecuteFunction button is a counted manual step naming its function', () => {
  const { model } = generateUi(appOf(snippetPage(`<p>Actions</p>${BUTTON}`)));
  const todos = buttonTodos(model);
  assert.equal(todos.length, 1);
  assert.match(todos[0].reason, /<button> "Open case" click action ExecuteFunction calling function open_case is not generated/);
  assert.equal(model.pages[0].status, 'partial');
});

test('identical ExecuteFunction buttons each retain a stable source-site ID', () => {
  const button = `<button action='ExecuteFunction' functionName='save' elementName='Save'>`;
  const { model } = generateUi(appOf(snippetPage(`${button}${button}`)));
  const todos = buttonTodos(model);
  assert.equal(todos.length, 2);
  assert.deepEqual(todos.map((todo) => todo.siteId), ['button-0', `button-${button.length}`]);
});

test('ExecuteFunction buttons inside Deluge islands are not counted as literal markup', () => {
  assert.deepEqual(zmlExecuteFunctionButtons(`<p><%= "<button action='ExecuteFunction'>" %></p>`), []);
  assert.deepEqual(zmlExecuteFunctionButtons(`<BUTTON ACTION="ExecuteFunction" functionName="save" name="Save">`), [
    { action: 'ExecuteFunction', siteId: 'button-0', fn: 'save', label: 'Save', element: 'button' },
  ]);
});
