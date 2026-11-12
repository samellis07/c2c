import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translate } from '../src/translate.js';
import { zohoSlotLines } from '../src/generate.js';
import { unsupportedClientShims } from '../src/client-shim.js';
import { createRuntime, DRY_RUN_LOGIN_USER_PROFILE } from '../../shims/src/runtime.js';

const PROFILE_IF = `userPermission = thisapp.permissions.loginUserProfile();
if(zoho.loginuserid != zoho.adminuserid && userPermission != "Librarian")
{
  hide ISBN_Barcode;
}`;

test('a client condition on the caller profile runs in the browser, not as a todo', () => {
  const r = translate(PROFILE_IF, {});
  assert.deepEqual(r.todos, []);
  assert.match(r.client, /var userPermission = shim\.zoho\.loginUserProfile\(ctx\);/);
  assert.match(r.client, /op: "hide", targets: \["ISBN_Barcode"\]/);
  assert.doesNotMatch(r.client, /client-condition-uses-server|shim\.thisapp/);
  assert.deepEqual(unsupportedClientShims(r.client), []);
});

test('the caller profile is a prefetched identity slot', () => {
  const r = translate(PROFILE_IF, {});
  assert.match(zohoSlotLines(r.client), /slots\["zoho\.loginUserProfile"\] = shim\.zoho\.loginUserProfile\(ctx\);/);
  // `loginUser` alone does not match the profile read.
  assert.doesNotMatch(zohoSlotLines(r.client), /slots\["zoho\.loginUser"\]/);
});

test('other thisapp.permissions calls stay server tasks', () => {
  const r = translate('thisapp.permissions.assignUserInProfile(input.Email,"Employee");', {});
  assert.match(r.server, /shim\.thisapp\.call\(ctx, \["permissions","assignUserInProfile"\]/);
  const withArg = translate('p = thisapp.permissions.loginUserProfile(input.Email);\nif(p == "A")\n{\n  hide X;\n}', {});
  assert.doesNotMatch(withArg.client, /loginUserProfile\(ctx\)/);
});

test('the runtime answers the profile from the request principal only', () => {
  const runtime = createRuntime({ dryRun: true });
  const ctx = runtime.context({ principal: { profile: 'Librarian', userId: 'a@example.test' } });
  assert.equal(ctx.shim.zoho.loginUserProfile(ctx), 'Librarian');
  const anon = runtime.context({});
  assert.equal(anon.shim.zoho.loginUserProfile(anon), DRY_RUN_LOGIN_USER_PROFILE);
});
