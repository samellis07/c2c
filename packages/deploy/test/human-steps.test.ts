import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildDeploy, checkGuards, formatHumanChecklist, humanChecklist } from '../src/index.js';

const MAIL_DS = `/*
 * Author       : synthetic
 * Generated on : 01-Jan-2025 12:00:00
 * Version      : 1.0
 */
application "Mailer"
{
	forms
	{
		form Item
		{
			Title
			(
				type = text
				displayname = "Title"
			)
		}
	}
	reports
	{
		list All_Items
		{
			displayName = "All Items"
			show all rows from Item
			(
				Title as "Title"
			)
		}
	}
	workflow
	{
		form
		{
			On_Add as "On add"
			{
				type = form
				form = Item
				on add
				{
					actions
					{
						on success
						(
							sendmail
							[
								from: zoho.adminuserid
								to: "owner@example.com"
								subject: "c2c-mail"
								message: "hello"
							];
						)
					}
				}
			}
		}
	}
}
`;

const PLAIN_DS = MAIL_DS.replace(/sendmail[\s\S]*?\];/, 'info "no mail";').replace('"Mailer"', '"Quiet"');

function guardFor(name: string, projectId: string) {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-human-steps-'));
  try {
    const path = join(dir, 'projects.json');
    writeFileSync(path, JSON.stringify({ org: '10000000000', dc: 'in', env: 'Development', projects: { 'c2c-mailer': '1001', 'c2c-quiet': '1002' } }));
    return checkGuards({
      org: '10000000000',
      projectId,
      appLink: name,
      credentialPath: join(dir, 'cred'),
      registry: JSON.parse(readFileSync(path, 'utf8')),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the checklist is one numbered list: slate start, admin invite, sign in, sender verify', () => {
  const items = humanChecklist({ slate: true, sendsMail: true });
  assert.equal(items.length, 4);
  assert.match(items[0]!, /Slate.*Start Exploring/);
  assert.match(items[1]!, /invite/i);
  assert.match(items[2]!, /[Ss]ign in/);
  assert.match(items[3]!, /sender/i);
  assert.match(items[3]!, /mail.from/);
  assert.match(items[3]!, /verification code|code sent/);
  const printed = formatHumanChecklist({ slate: true, sendsMail: true });
  assert.match(printed, /^human checklist:\n1\. .*Start Exploring[\s\S]*2\. .*invite[\s\S]*3\. .*[Ss]ign in[\s\S]*4\. .*sender/);
});

test('the start item names exactly the services the app uses, in the shared sentence', () => {
  const INVITE = 'Accept the admin invite: open the invite mail sent to the admin address and set the password.';
  const SIGN_IN = 'Sign in to the app once at the Slate app URL — the first sign-in finishes activating the login.';
  const STRATUS = 'Stratus — in the Catalyst console open the project → Cloud Scale → Stratus → Start Exploring';
  const SMARTBROWZ = 'SmartBrowz — in the Catalyst console open the project → SmartBrowz → Start Exploring';
  const SLATE = 'Slate — in the Catalyst console open the project → Slate → Start Exploring';
  assert.equal(
    formatHumanChecklist({ slate: true, sendsMail: false }),
    `human checklist:\n1. Start services: ${SLATE}\n2. ${INVITE}\n3. ${SIGN_IN}\n`,
  );
  assert.equal(
    formatHumanChecklist({ slate: false, files: true, sendsMail: false }),
    `human checklist:\n1. Start services: ${STRATUS}\n2. ${INVITE}\n`,
  );
  assert.equal(
    formatHumanChecklist({ slate: false, pdf: true, sendsMail: false }),
    `human checklist:\n1. Start services: ${SMARTBROWZ}\n2. ${INVITE}\n`,
  );
  assert.equal(
    formatHumanChecklist({ slate: true, files: true, pdf: true, sendsMail: false }),
    `human checklist:\n1. Start services: ${STRATUS}; ${SMARTBROWZ}; ${SLATE}\n2. ${INVITE}\n3. ${SIGN_IN}\n`,
  );
  // An app that uses none of the three: no start item at all.
  assert.equal(formatHumanChecklist({ slate: false, files: false, pdf: false, sendsMail: false }), `human checklist:\n1. ${INVITE}\n`);
  // A service verified started drops out; the others stay.
  assert.equal(
    formatHumanChecklist({ slate: true, files: true, pdf: true, sendsMail: false, started: ['stratus', 'smartbrowz'] }),
    `human checklist:\n1. Start services: ${SLATE}\n2. ${INVITE}\n3. ${SIGN_IN}\n`,
  );
  // Every service in use and every optional item still fits in five.
  assert.equal(
    humanChecklist({ slate: true, files: true, pdf: true, sendsMail: true, connectionSecretKeys: ['A_SECRET'] }).length,
    5,
  );
});

test('a re-run after Slate started drops the Slate start and keeps numbering contiguous', () => {
  const items = humanChecklist({ slate: true, sendsMail: true, slateStarted: true });
  assert.equal(items.length, 3);
  assert.ok(!items.some((item) => /Start Exploring/i.test(item)));
  assert.match(items[0]!, /invite/i);
  assert.match(items[1]!, /[Ss]ign in/);
  assert.match(items[2]!, /sender/i);
  const printed = formatHumanChecklist({ slate: true, sendsMail: true, slateStarted: true });
  assert.match(printed, /^human checklist:\n1\. .*invite[\s\S]*2\. .*[Ss]ign in[\s\S]*3\. .*sender/);
  assert.equal(printed.includes('Start Exploring'), false);
});

test('a re-run after Slate started on an app without mail lists two items', () => {
  const items = humanChecklist({ slate: true, sendsMail: false, slateStarted: true });
  assert.equal(items.length, 2);
  assert.ok(!items.some((item) => /Start Exploring/i.test(item)));
});

test('the sender step appears only when the app sends mail', () => {
  const without = humanChecklist({ slate: true, sendsMail: false });
  assert.equal(without.length, 3);
  assert.ok(!without.some((item) => /sender/i.test(item)));
});

test('an app with no Slate client and no mail lists only the admin invite', () => {
  assert.deepEqual(humanChecklist({ slate: false, sendsMail: false }).map((item) => /invite/i.test(item)), [true]);
});

test('the connection-secret item fills ~/.c2c/<app>-function-env.json, copied from the autofilled <out>/function-env.json', () => {
  const one = humanChecklist({ slate: false, sendsMail: false, connectionSecretKeys: ['MY_STRIPE_CLIENT_SECRET'] });
  const item = one.find((i) => /function-env/i.test(i))!;
  assert.match(item, /~\/\.c2c\/<app>-function-env\.json/, 'item must point at the file deploy --function-env reads');
  assert.match(item, /<out>\/function-env\.json/, 'item must name the autofilled source file');
  assert.match(item, /MY_STRIPE_CLIENT_SECRET/, 'item must name the key');
  const many = humanChecklist({ slate: false, sendsMail: false, connectionSecretKeys: ['A_SECRET', 'B_TOKEN'] });
  const manyItem = many.find((i) => /function-env/i.test(i))!;
  assert.match(manyItem, /secrets \(A_SECRET, B_TOKEN\)/);
});

test('sendsMail is detected from the plan: a sendmail workflow flags true, a plain app false', () => {
  const mailer = buildDeploy(deriveIr(parse(MAIL_DS)), guardFor('Mailer', '1001'), true);
  const quiet = buildDeploy(deriveIr(parse(PLAIN_DS)), guardFor('Quiet', '1002'), true);
  assert.equal(mailer.sendsMail, true);
  assert.equal(quiet.sendsMail, false);
});
