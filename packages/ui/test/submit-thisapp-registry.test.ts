/**
 * The submit stub runs the form's on-validate and on-success modules on its
 * own runtime. When one of them calls a `thisapp` function, the stub's
 * runtime must carry the same registry the module's own route has: without
 * it the call was a silent placeholder on /submit, so an on-success failure
 * never reached the caller as the post-commit warning (Creator answers the
 * save with code 3000 and the script error).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildUi } from '../src/index.js';

const tab = (n: number) => '\t'.repeat(n);

function source(script: string): string {
  return `application "Demo"
{
${tab(1)}form Staff
${tab(1)}{
${tab(2)}Email
${tab(2)}(
${tab(3)}type = email
${tab(2)})
${tab(1)}}
${tab(1)}form Note
${tab(1)}{
${tab(2)}Text
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(1)}}
${tab(1)}workflow
${tab(1)}{
${tab(1)}form
${tab(1)}{
${tab(2)}Invite as "Invite"
${tab(2)}{
${tab(3)}type = form
${tab(3)}form = Staff
${tab(3)}record event = on add
${tab(3)}on success
${tab(3)}{
${tab(4)}actions
${tab(4)}{
${tab(5)}custom deluge script
${tab(5)}(
${tab(6)}${script}
${tab(5)})
${tab(4)}}
${tab(3)}}
${tab(2)}}
${tab(1)}}
${tab(1)}}
}
`;
}

function submitSource(script: string, form: string): string {
  const built = buildUi(deriveIr(parse(source(script))));
  const path = `functions/aio/${form}/submit.mjs`;
  const file = built.files.find((item) => item.path === path);
  assert.ok(file, `${path} generated`);
  return String(file.data);
}

test('a submit whose on-success calls thisapp carries the function registry', () => {
  const text = submitSource('var = thisapp.permissions.assignUserInProfile(input.Email,"Employee");', 'staff');
  assert.match(text, /^const successAdd = \["\.\/on-success\.mjs"\];$/m);
  assert.match(text, /^import \{ functions \} from "\.\.\/\.\.\/thisapp\.mjs";$/m);
  assert.match(text, /^\s+access,\n\s+functions,$/m);
});

test('a submit whose scripts never call thisapp is unchanged', () => {
  const staff = submitSource('info input.Email;', 'staff');
  assert.doesNotMatch(staff, /thisapp\.mjs/);
  assert.doesNotMatch(staff, /^\s+functions,$/m);
  // A form with no scripts at all, in an app where another form calls thisapp.
  const note = submitSource('var = thisapp.permissions.assignUserInProfile(input.Email,"Employee");', 'note');
  assert.doesNotMatch(note, /thisapp\.mjs/);
});
