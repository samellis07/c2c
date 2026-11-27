/**
 * A profile, a blueprint stage or a blueprint transition named exactly __proto__ keys the generated access
 * policy and field rules; a map literal cannot carry that key, so the rule would be dropped silently (fail open).
 * It is refused like a form named __proto__: removed and counted on app.refusedNames.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../src/index.js';

const blueprint = (stage: string, transition: string): string => `application "Demo"
{
	form Item
	{
		Amount
		(
			type = number
		)
		Status
		(
			type = text
		)
	}
	workflow
	{
		form
		{
			Flow as "Flow"
			{
				type = blueprint
				form = Item
				start
				{
					start stage = ${stage}
				}
				stages
				{
					${stage}
					{
						displayname = "${stage}"
						mandatory fields = Amount
					}
				}
				transitions
				{
					${transition}
					{
						from stage = ${stage}
						to stage = Done
						during
						{
							mandatory fields = Amount
						}
					}
				}
			}
		}
	}
}
`;

const refusedKinds = (stage: string, transition: string): string[] =>
  (deriveIr(parse(blueprint(stage, transition))).refusedNames ?? []).map((item) => item.kind).sort();

test('a blueprint stage or transition named __proto__ is refused and counted; other names are untouched', () => {
  assert.deepEqual(refusedKinds('__proto__', 'Go'), ['blueprint stage']);
  assert.deepEqual(refusedKinds('Draft', '__proto__'), ['blueprint transition']);
  // The display-name spellings: with and without the quotes after parsing, on the stage and the transition.
  assert.deepEqual(refusedKinds('Draft', 'Go as "__proto__"'), ['blueprint transition']);
  assert.deepEqual(refusedKinds('Draft', 'Go as __proto__'), ['blueprint transition']);
  // The generated key of `Key as "Display"` is the quoted display name, so a __proto__ KEY with another display name keys nothing.
  assert.deepEqual(refusedKinds('Draft', '__proto__ as "Go"'), []);
  assert.deepEqual(refusedKinds('Draft', 'Go AS "__proto__"'), ['blueprint transition'], 'any letter case, as the generator reads it');
  assert.deepEqual(refusedKinds('Draft', 'Go as "x" as "__proto__"'), ['blueprint transition'], 'the last quoted display name keys the transition');
  assert.deepEqual(refusedKinds('Draft', 'Go as "__proto__"  '), ['blueprint transition']);
  // An escaped spelling decodes to the same key in the generator (unquote), so it is refused as well.
  assert.deepEqual(refusedKinds('Draft', 'Go as "\\u005f\\u005fproto__"'), ['blueprint transition']);
  assert.deepEqual(refusedKinds('Draft', 'Go as "_\\_proto__"'), ['blueprint transition']);
  assert.deepEqual(refusedKinds('Draft', '"__proto__"'), ['blueprint transition']);
  assert.deepEqual(refusedKinds('\\u005f_proto__', 'Go'), [], 'unquoted, an escape is not decoded and keys nothing');
  assert.deepEqual(refusedKinds('Draft', 'Go as "my__proto__"'), [], 'only the exact display name is refused');
  assert.deepEqual(refusedKinds('Draft', 'Go as "__proto__x"'), []);
  assert.deepEqual(refusedKinds('Draft', 'Go'), []);
  assert.deepEqual(refusedKinds('constructor', 'Go'), [], 'constructor is an ordinary name');
  assert.deepEqual(refusedKinds('Draft', 'prototype'), [], 'prototype is an ordinary name');
});

const withProfile = (name: string): string => `application "Demo"
{
	form Item
	{
		Qty
		(
			type = number
		)
	}
	share_settings
	{
		"${name}"
		{
			name = "${name}"
			type = Users_Permissions
			permissions = {Chat:false}
		}
		"Staff"
		{
			name = "Staff"
			type = Users_Permissions
			permissions = {Chat:false}
		}
	}
}
`;

test('a profile named __proto__ is refused and counted, the others stay', () => {
  const refused = deriveIr(parse(withProfile('__proto__')));
  assert.deepEqual((refused.refusedNames ?? []).map((item) => item.kind), ['profile']);
  assert.deepEqual(refused.profiles.map((profile) => profile.name), ['Staff']);
  const plain = deriveIr(parse(withProfile('constructor')));
  assert.equal(plain.refusedNames, undefined, 'constructor is an ordinary profile name');
  assert.deepEqual(plain.profiles.map((profile) => profile.name).sort(), ['Staff', 'constructor']);
});
