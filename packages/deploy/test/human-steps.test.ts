import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildDeploy, checkGuards, formatHumanChecklist, humanChecklist } from '../src/index.js';
import { CUSTOMER_STEPS, formatCustomerSteps } from '../src/customer-steps.js';

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
  const printed = formatHumanChecklist({ slate: true, sendsMail: true });
  assert.match(printed, /^human checklist:\n1\. .*Start Exploring[\s\S]*2\. .*invite[\s\S]*3\. .*[Ss]ign in[\s\S]*4\. .*sender/);
});

test('the live-run guide quotes the canonical five customer steps inside its marked region', () => {
  const guide = readFileSync(join(process.cwd(), 'docs/user/live-runs-human-steps.md'), 'utf8');
  const region = guide.match(/<!-- c2c:human-steps:start -->\n([\s\S]*?)\n<!-- c2c:human-steps:end -->/);
  assert.ok(region, 'guide is missing the <!-- c2c:human-steps:start/end --> marked region');
  const lines = region![1]!.split('\n');
  assert.deepEqual(lines, CUSTOMER_STEPS.map((step, i) => `${i + 1}. ${step}`), 'marked region must list the canonical steps verbatim');
});

test('the live-run guide states the per-project conditions exactly as the code applies them', () => {
  const guide = readFileSync(join(process.cwd(), 'docs/user/live-runs-human-steps.md'), 'utf8');
  // provision.ts drops the mail step without a `mail-sender` plan step and the
  // Slate start once `slate-enable` is done/existing; deploy's humanChecklist
  // is conditional on slate, sendsMail and slateStarted.
  assert.match(guide, /mail-sender/);
  assert.match(guide, /slate-enable/);
  assert.match(guide, /`done` or `existing`/);
  assert.match(guide, /sendsMail|sends mail/);
  assert.match(guide, /slateStarted/);

  // `c2c deploy` stdout is formatCustomerSteps, not humanChecklist: derive the
  // emitted lines from the code and pin the guide's table to them.
  const emitted = (done: number) =>
    [...formatCustomerSteps(done).matchAll(/^ {2}(\d+)\. ([^:(\n]+)/gm)].map((m) => `${m[1]}. ${m[2]!.trim()}`);
  const freshDeploy = emitted(0); // slate && !slateStarted: all five steps, 1..5
  const rerunDeploy = emitted(1); // !slate || slateStarted: step 1 dropped, 2..5
  assert.equal(freshDeploy.length, 5);
  assert.equal(rerunDeploy.length, 4);
  assert.deepEqual(rerunDeploy.map((line) => line[0]), ['2', '3', '4', '5'], 'deploy keeps the original step numbers');
  for (const line of [...freshDeploy, ...rerunDeploy]) {
    assert.ok(guide.includes(`\`${line}\``), `guide must list the deploy-emitted step "${line}"`);
  }
  // Deploy stdout always prints the in-app check and the mail step (the mail
  // step carries its own parenthetical condition); the guide must say so.
  assert.ok(freshDeploy.some((line) => line.includes('Run the in-app check and paste its code')));
  assert.ok(rerunDeploy.some((line) => line.includes('Run the in-app check and paste its code')));
  assert.match(guide, /in-app check[\s\S]{0,200}always printed|always printed[\s\S]{0,200}in-app check/);

  // The report JSON's humanChecklist field is the other list: derive its
  // labels from humanChecklist() and check the guide quotes them — and that
  // it says the field does not include the in-app check step.
  const reportLabels = humanChecklist({ slate: true, sendsMail: true }).map((item) => item.split(/: | — /)[0]!);
  assert.deepEqual(reportLabels, [
    'Start Slate once',
    'Accept the admin invite',
    'Sign in to the app once at the Slate app URL',
    'Verify the sender email (the app sends mail)',
  ]);
  for (const label of reportLabels) assert.ok(guide.includes(label), `guide must quote the report label "${label}"`);
  assert.match(guide, /does not include the\s+in-app check step/);
});

test('the live-run guide keeps the exact Slate activation evidence', () => {
  const guide = readFileSync(join(process.cwd(), 'docs/user/live-runs-human-steps.md'), 'utf8');
  assert.match(guide, /`?200 \[\]`? app-list response only proves connectivity/, 'guide must keep the exact `200 []` evidence wording');
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
