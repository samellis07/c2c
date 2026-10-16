import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveIr, parse } from '../../core/src/index.js';
import { freeIdentifiers } from '../../quality/src/scope.js';
import { allowedGlobals } from '../../quality/src/static.js';
import {
  MAIL_LOG_TABLE,
  MAIL_SENDER_EVIDENCE,
  MAIL_SENDER_RULE,
  buildDeploy,
  buildOfflinePlan,
  checkGuards,
  decideMail,
  deployCli,
  mailConfig,
  mailSenderPrecheck,
  mailModuleSource,
  mailSenderTag,
  maskMailAddress,
  readMailSenderEvidence,
  recipientsOf,
  writeDeployTree,
  writeMailSenderEvidence,
  type Io,
} from '../src/index.js';

const SECRET = '/tmp/cred-mail-test';
const OWNER = 'owner@example.com';

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
								to: "${OWNER}"
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

function appOf(source: string) {
  return deriveIr(parse(source));
}

function registryFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-mail-projects-'));
  const path = join(dir, 'projects.json');
  writeFileSync(path, JSON.stringify({ org: '10000000000', dc: 'in', env: 'Development', projects: { 'c2c-mailer': '1001', 'c2c-quiet': '1002' } }));
  return path;
}

function guardFor(name: string, projectId: string) {
  return checkGuards({
    org: '10000000000',
    projectId,
    appLink: name,
    credentialPath: SECRET,
    registry: JSON.parse(readFileSync(registryFile(), 'utf8')),
  });
}

function io(): { io: Io; out: () => string; err: () => string; spawned: string[][] } {
  let out = '';
  let err = '';
  const spawned: string[][] = [];
  return {
    io: {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      env: { X_ZC_CREDENTIAL_PATH: SECRET },
      spawn: async (_command, args) => {
        spawned.push(args);
        return { code: 0, stdout: '', stderr: '' };
      },
      fetch: async () => {
        throw new Error('network refused in this test');
      },
      rest: async () => {
        throw new Error('rest refused in this test');
      },
    },
    out: () => out,
    err: () => err,
    spawned,
  };
}

test('the allow-list covers cc and bcc, not just to', () => {
  assert.deepEqual(recipientsOf({ to: OWNER, cc: 'x@example.com', bcc: ['y@example.com'] }), [OWNER, 'x@example.com', 'y@example.com']);
  assert.deepEqual(recipientsOf({ to: `${OWNER}, z@example.com` }), [OWNER, 'z@example.com']);
  assert.equal(decideMail(mailConfig(true, [OWNER]), recipientsOf({ to: OWNER, cc: 'x@example.com' })).ok, false);
  assert.equal(decideMail(mailConfig(true, [OWNER]), recipientsOf({ to: OWNER })).ok, true);
});

test('precheck: an app that sends mail with no verified sender is a blocker when mail is on', () => {
  const app = appOf(MAIL_DS);
  const none = mailSenderPrecheck(app, mailConfig(true));
  assert.equal(none.length, 1);
  assert.equal(none[0].check, MAIL_SENDER_RULE);
  assert.equal(none[0].severity, 'blocker');
  assert.match(none[0].message, /no Catalyst Mail sender/);
  const unverified = mailSenderPrecheck(app, mailConfig(true, { from: OWNER }));
  assert.equal(unverified[0].severity, 'blocker');
  assert.ok(unverified[0].message.includes(`${maskMailAddress(OWNER)} is not marked verified`));
  // The sender address never leaks into a finding.
  assert.doesNotMatch(unverified[0].message, /owner@example\.com/);
  assert.deepEqual(mailSenderPrecheck(app, mailConfig(true, { from: OWNER, verified: true })), []);
  // Mail off: nothing is sent, so the gap is a warning, not a blocker.
  assert.equal(mailSenderPrecheck(app, mailConfig(false))[0].severity, 'warning');
  assert.deepEqual(mailSenderPrecheck(appOf(PLAIN_DS), mailConfig(true)), []);
});

test('deploy --confirm --mail refuses an unverified sender before any catalyst call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-mail-ds-'));
  const ds = join(dir, 'mailer.ds');
  // A live (--confirm) tree needs the app time zone, so the sender blocker is what refuses.
  writeFileSync(ds, MAIL_DS.replace('application "Mailer"\n{\n', 'application "Mailer"\n{\n\ttime zone = "Asia/Kolkata"\n'));
  const cap = io();
  const code = await deployCli([ds, '--project', '1001', '--org', '10000000000', '--projects', registryFile(), '--confirm', '--function-env', 'new', '--mail'], cap.io);
  assert.equal(code, 1);
  assert.deepEqual(cap.spawned, []);
  assert.match(cap.err(), new RegExp(`blocker ${MAIL_SENDER_RULE}`));
  const dry = io();
  assert.equal(await deployCli([ds, '--project', '1001', '--org', '10000000000', '--projects', registryFile(), '--mail'], dry.io), 0);
  assert.match(dry.out(), new RegExp(`precheck: blocker ${MAIL_SENDER_RULE}`));
  rmSync(dir, { recursive: true, force: true });
});

const MAILER_DS_LIVE = MAIL_DS.replace('application "Mailer"\n{\n', 'application "Mailer"\n{\n\ttime zone = "Asia/Kolkata"\n');

function liveMailSetup() {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-mail-ds-'));
  const ws = mkdtempSync(join(tmpdir(), 'c2c-mail-ws-'));
  const ds = join(dir, 'mailer.ds');
  writeFileSync(ds, MAILER_DS_LIVE);
  return {
    dir,
    ws,
    ds,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    },
  };
}

function mailRestIo(body: unknown) {
  const cap = io();
  const calls: string[] = [];
  cap.io.rest = async (call) => {
    calls.push(`${call.method} ${call.path}`);
    if (call.method === 'GET' && call.path === '/baas/v1/project/1001/email') return { status: 200, body };
    throw new Error('rest refused in this test');
  };
  return { cap, calls };
}

async function inWorkspace<T>(ws: string, run: () => Promise<T>): Promise<T> {
  const cwd = process.cwd();
  process.chdir(ws);
  try {
    return await run();
  } finally {
    process.chdir(cwd);
  }
}

test('a confirmed deploy marks the sender verified only from the live read-back, and records it', async () => {
  const { ds, ws, cleanup } = liveMailSetup();
  try {
    const { cap, calls } = mailRestIo({ data: [{ email_address: OWNER, status: 'PENDING' }] });
    const code = await inWorkspace(ws, () =>
      deployCli([ds, '--project', '1001', '--org', '10000000000', '--projects', registryFile(), '--confirm', '--function-env', 'new', '--mail', '--mail-from', OWNER], cap.io),
    );
    assert.equal(code, 1);
    // A PENDING read-back does not verify the sender.
    assert.match(cap.err(), new RegExp(`blocker ${MAIL_SENDER_RULE}`));
    assert.deepEqual(calls, ['GET /baas/v1/project/1001/email']);
    const evidence = readMailSenderEvidence(ws);
    assert.equal(evidence?.senders[mailSenderTag(OWNER)], 'PENDING');
    // The persisted record holds tags only — never the address.
    assert.doesNotMatch(readFileSync(join(ws, MAIL_SENDER_EVIDENCE), 'utf8'), /@/);
  } finally {
    cleanup();
  }
});

test('a VERIFIED read-back clears the sender blocker without the attestation flag', async () => {
  const { ds, ws, cleanup } = liveMailSetup();
  try {
    const { cap } = mailRestIo({ data: [{ email_address: OWNER, status: 'VERIFIED' }] });
    const code = await inWorkspace(ws, () =>
      deployCli([ds, '--project', '1001', '--org', '10000000000', '--projects', registryFile(), '--confirm', '--function-env', 'new', '--mail', '--mail-from', OWNER], cap.io),
    );
    // The mail blocker is gone; the run stops later, on the refused project read.
    assert.equal(code, 1);
    assert.doesNotMatch(cap.err(), new RegExp(`blocker ${MAIL_SENDER_RULE}`));
    assert.equal(readMailSenderEvidence(ws)?.senders[mailSenderTag(OWNER)], 'VERIFIED');
  } finally {
    cleanup();
  }
});

for (const [name, rest] of [
  ['throws', async () => { throw new Error('read-back refused in this test'); }],
  ['returns 403', async () => ({ status: 403, body: { status: 'failure', data: { message: 'forbidden' } } })],
  ['hits a network error', async () => { throw new TypeError('fetch failed'); }],
] as const) {
  test(`a confirmed deploy fails closed when the live read-back ${name}, even with a VERIFIED record on disk`, async () => {
    const { ds, ws, cleanup } = liveMailSetup();
    try {
      const recorded = { version: 1 as const, projectId: '1001', at: new Date().toISOString(), senders: { [mailSenderTag(OWNER)]: 'VERIFIED' } };
      writeMailSenderEvidence(ws, recorded);
      const cap = io();
      const calls: string[] = [];
      cap.io.rest = async (call) => {
        calls.push(`${call.method} ${call.path}`);
        return rest();
      };
      const code = await inWorkspace(ws, () =>
        deployCli([ds, '--project', '1001', '--org', '10000000000', '--projects', registryFile(), '--confirm', '--function-env', 'new', '--mail', '--mail-from', OWNER], cap.io),
      );
      assert.equal(code, 1);
      assert.deepEqual(calls, ['GET /baas/v1/project/1001/email']);
      assert.match(cap.err(), /warning mail-sender-readback: the live Catalyst mail sender read-back for project 1001 failed; the sender is treated as unverified/);
      assert.match(cap.err(), new RegExp(`blocker ${MAIL_SENDER_RULE}`));
      // The stale record is neither trusted nor overwritten.
      assert.deepEqual(readMailSenderEvidence(ws), recorded);
    } finally {
      cleanup();
    }
  });
}

test('a dry run ignores a persisted read-back from another project or naming no project', async () => {
  const { ds, ws, cleanup } = liveMailSetup();
  try {
    for (const projectId of ['2002', undefined]) {
      writeMailSenderEvidence(ws, { version: 1, ...(projectId ? { projectId } : {}), at: new Date().toISOString(), senders: { [mailSenderTag(OWNER)]: 'VERIFIED' } });
      const seen = io();
      assert.equal(
        await inWorkspace(ws, () => deployCli([ds, '--project', '1001', '--org', '10000000000', '--projects', registryFile(), '--mail', '--mail-from', OWNER], seen.io)),
        0,
      );
      assert.match(seen.out(), new RegExp(`precheck: blocker ${MAIL_SENDER_RULE}`), `record for project ${projectId ?? '(none)'}`);
    }
    // A record for a different sender does not verify this one either.
    writeMailSenderEvidence(ws, { version: 1, projectId: '1001', at: new Date().toISOString(), senders: { [mailSenderTag('other@example.com')]: 'VERIFIED' } });
    const other = io();
    assert.equal(
      await inWorkspace(ws, () => deployCli([ds, '--project', '1001', '--org', '10000000000', '--projects', registryFile(), '--mail', '--mail-from', OWNER], other.io)),
      0,
    );
    assert.match(other.out(), new RegExp(`precheck: blocker ${MAIL_SENDER_RULE}`));
  } finally {
    cleanup();
  }
});

test('a dry run consumes the persisted read-back: evidence verifies, the bare attestation does not', async () => {
  const { ds, ws, cleanup } = liveMailSetup();
  try {
    writeMailSenderEvidence(ws, { version: 1, projectId: '1001', at: new Date().toISOString(), senders: { [mailSenderTag(OWNER)]: 'VERIFIED' } });
    const seen = io();
    assert.equal(
      await inWorkspace(ws, () => deployCli([ds, '--project', '1001', '--org', '10000000000', '--projects', registryFile(), '--mail', '--mail-from', OWNER], seen.io)),
      0,
    );
    assert.doesNotMatch(seen.out(), new RegExp(`precheck: blocker ${MAIL_SENDER_RULE}`));
    assert.match(seen.out(), new RegExp(`mail from: ${OWNER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(verified\\)`));

    const attested = io();
    assert.equal(
      await inWorkspace(ws, () =>
        deployCli([ds, '--project', '1001', '--org', '10000000000', '--projects', registryFile(), '--mail', '--mail-from', OWNER, '--mail-sender-verified'], attested.io),
      ),
      1,
    );
    assert.match(attested.err(), /--mail-sender-verified is not taken as proof/);
  } finally {
    cleanup();
  }
});

test('a verified sender reaches the function env, the function config and the plan', () => {
  const bundle = buildDeploy(appOf(MAIL_DS), guardFor('Mailer', '1001'), true, false, undefined, undefined, { from: OWNER, verified: true }, undefined, [OWNER]);
  const byPath = new Map(bundle.files.map((file) => [file.path, String(file.data)]));
  const config = JSON.parse(byPath.get('functions/c2c_api/catalyst-config.json') ?? '{}');
  assert.equal(config.deployment.env_variables.C2C_MAIL_FROM, OWNER);
  const mail = JSON.parse(byPath.get('functions/c2c_api/c2c-mail.json') ?? '{}');
  assert.deepEqual(mail, { enabled: true, allowlist: [OWNER], from: OWNER, verifiedSenders: [OWNER] });
  assert.ok(bundle.plan.includes(`mail from: ${OWNER} (verified)`));
  assert.doesNotMatch(bundle.plan, /precheck: blocker/);
});

test('the kept console env (--function-env) and the verified sender (--mail-from) both reach env_variables', () => {
  const env = { C2C_OWNER_APPROVAL_TOKEN: 'tok', C2C_MAIL_FROM: 'old@example.test' };
  const envOf = (bundle: ReturnType<typeof buildDeploy>) => {
    const config = bundle.files.find((file) => file.path === 'functions/c2c_api/catalyst-config.json');
    return JSON.parse(String(config?.data ?? '{}')).deployment.env_variables;
  };
  const sent = buildDeploy(appOf(MAIL_DS), guardFor('Mailer', '1001'), true, false, undefined, env, { from: OWNER, verified: true }, undefined, [OWNER]);
  // A secret name reaches env_variables without its value; the deploy sets it on the live function over the env API.
  assert.deepEqual(envOf(sent), { C2C_DEPLOY_MODE: 'dry-run', C2C_MAIL_FROM: OWNER, C2C_OWNER_APPROVAL_TOKEN: '' });
  // No verified sender named: the console value is kept, not erased.
  const kept = buildDeploy(appOf(MAIL_DS), guardFor('Mailer', '1001'), true, false, undefined, env);
  assert.deepEqual(envOf(kept), { C2C_DEPLOY_MODE: 'dry-run', C2C_MAIL_FROM: 'old@example.test', C2C_OWNER_APPROVAL_TOKEN: '' });
});

test('the delivery log table is planned only for an app that sends mail with mail on', () => {
  const mailer = buildDeploy(appOf(MAIL_DS), guardFor('Mailer', '1001'), true);
  const log = mailer.tableSteps.find((step) => step.table === MAIL_LOG_TABLE);
  assert.ok(log);
  assert.deepEqual(
    log.columns.map((column) => `${column.column_name}:${column.data_type}`),
    ['sent_at:varchar', 'status:varchar', 'reason:text', 'from_email:varchar', 'to_email:text', 'subject:varchar'],
  );
  assert.match(mailer.plan, /create table c2c_mail_log if missing/);
  const quiet = buildDeploy(appOf(PLAIN_DS), guardFor('Quiet', '1002'), true);
  assert.equal(quiet.tableSteps.some((step) => step.table === MAIL_LOG_TABLE), false);
});

test('a mail-sending app deployed without --mail plans no delivery log table', () => {
  const off = buildDeploy(appOf(MAIL_DS), guardFor('Mailer', '1001'), false);
  assert.equal(off.tableSteps.some((step) => step.table === MAIL_LOG_TABLE), false);
  assert.doesNotMatch(off.plan, /c2c_mail_log/);
});

test('an app that sends no mail gets no delivery log table, and no function references it', () => {
  for (const enabled of [false, true]) {
    const quiet = buildDeploy(appOf(PLAIN_DS), guardFor('Quiet', '1002'), enabled);
    assert.equal(quiet.tableSteps.some((step) => step.table === MAIL_LOG_TABLE), false);
    assert.doesNotMatch(quiet.plan, /c2c_mail_log/);
    const functions = quiet.files.filter((file) => file.path.startsWith('functions/'));
    assert.ok(functions.length > 0);
    assert.equal(functions.some((file) => file.path.endsWith('/c2c-mail.mjs')), false);
    for (const file of functions) {
      const text = String(file.data);
      assert.equal(text.includes(MAIL_LOG_TABLE), false, `${file.path} names ${MAIL_LOG_TABLE}`);
      assert.equal(text.includes('c2cGuardedMail'), false, `${file.path} wires the mail module`);
    }
  }
});

test('generated handlers hand the request to the mail module', () => {
  const bundle = buildDeploy(appOf(MAIL_DS), guardFor('Mailer', '1001'), true);
  const handler = bundle.files.find((file) => String(file.data).includes('shim.mail.send('));
  assert.ok(handler);
  assert.match(String(handler.data), /mail: \(message\) => c2cGuardedMail\(message, typeof req === "undefined" \? undefined : req\)/);
  assert.match(String(handler.data), /mailGuarded: true/);
});

interface FakeCall {
  req: unknown;
  sendMail: Record<string, unknown>[];
  rows: { table: string; row: Record<string, unknown> }[];
}

async function loadModule(config: Record<string, unknown>, opts: { sendThrows?: boolean; sendError?: string; logThrows?: boolean } = {}) {
  const bundle = buildDeploy(appOf(MAIL_DS), guardFor('Mailer', '1001'), true, false, undefined, undefined, {}, undefined, [OWNER]);
  const out = mkdtempSync(join(tmpdir(), 'c2c-mail-mod-'));
  writeDeployTree(out, bundle.files);
  writeFileSync(join(out, 'functions/c2c_api/c2c-mail.json'), JSON.stringify(config));
  const mod = await import(`${pathToFileURL(join(out, 'functions/c2c_api/c2c-mail.mjs')).href}?t=${Math.random()}`);
  const calls: FakeCall = { req: null, sendMail: [], rows: [] };
  mod.setMailSdk((req: unknown) => {
    calls.req = req;
    return {
      email: () => ({
        sendMail: async (cfg: Record<string, unknown>) => {
          if (opts.sendThrows) throw new Error(opts.sendError ?? 'Invalid sender');
          calls.sendMail.push(cfg);
          return { from_email: cfg.from_email };
        },
      }),
      datastore: () => ({
        table: (table: string) => ({
          insertRow: async (row: Record<string, unknown>) => {
            if (opts.logThrows) throw new Error('no such table');
            calls.rows.push({ table, row });
            return { ROWID: '1', ...row };
          },
        }),
      }),
    };
  });
  return { mod, calls, cleanup: () => rmSync(out, { recursive: true, force: true }) };
}

const VERIFIED = { enabled: true, allowlist: [OWNER], from: OWNER, verifiedSenders: [OWNER] };
const MESSAGE = { from: OWNER, to: OWNER, subject: 'c2c-mail', message: '<b>hello</b>' };

test('live send: a verified, allow-listed message goes through email().sendMail() and is logged', async () => {
  const { mod, calls, cleanup } = await loadModule(VERIFIED);
  const req = { id: 'req-1' };
  const result = await mod.c2cGuardedMail(MESSAGE, req);
  assert.deepEqual(result, { performed: true, status: 'sent', reason: 'accepted by Catalyst Mail', logged: true });
  assert.equal(calls.req, req);
  assert.deepEqual(calls.sendMail, [{ from_email: OWNER, to_email: [OWNER], subject: 'c2c-mail', content: '<b>hello</b>', html_mode: true }]);
  assert.equal(calls.rows.length, 1);
  assert.equal(calls.rows[0].table, MAIL_LOG_TABLE);
  const { sent_at, ...row } = calls.rows[0].row;
  assert.match(String(sent_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(row, { status: 'sent', reason: 'accepted by Catalyst Mail', from_email: OWNER, to_email: OWNER, subject: 'c2c-mail' });
  cleanup();
});

test('live send: cc, bcc and reply to map to the Catalyst config', async () => {
  const { mod, calls, cleanup } = await loadModule(VERIFIED);
  await mod.c2cGuardedMail({ ...MESSAGE, cc: [OWNER], bcc: OWNER, 'reply to': OWNER }, {});
  assert.deepEqual(calls.sendMail[0], { from_email: OWNER, to_email: [OWNER], cc: [OWNER], bcc: [OWNER], reply_to: [OWNER], subject: 'c2c-mail', content: '<b>hello</b>', html_mode: true });
  cleanup();
});

test('live send: an unverified sender is refused, logged, and names the precheck rule — with the address masked', async () => {
  const { mod, calls, cleanup } = await loadModule({ ...VERIFIED, verifiedSenders: [] });
  const result = await mod.c2cGuardedMail(MESSAGE, {});
  assert.deepEqual(result, {
    performed: false,
    status: 'refused',
    code: MAIL_SENDER_RULE,
    reason: `the app sends mail and sender ${maskMailAddress(OWNER)} is not marked verified (precheck ${MAIL_SENDER_RULE})`,
    logged: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /owner@example\.com/);
  assert.deepEqual(calls.sendMail, []);
  assert.equal(calls.rows.length, 1);
  const { sent_at, ...row } = calls.rows[0].row;
  assert.match(String(sent_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  // A refused send never persists the full sender address.
  assert.deepEqual(row, {
    status: 'refused',
    reason: `the app sends mail and sender ${maskMailAddress(OWNER)} is not marked verified (precheck ${MAIL_SENDER_RULE})`,
    from_email: maskMailAddress(OWNER),
    to_email: OWNER,
    subject: 'c2c-mail',
  });
  cleanup();
});

test('live send: mail off, outside recipients and attachments are refused without a send', async () => {
  for (const [config, message, reason, rows] of [
    [{ ...VERIFIED, enabled: false }, MESSAGE, /^mail disabled$/, 0],
    [VERIFIED, { ...MESSAGE, cc: 'x@example.com' }, /^recipient not allowlisted$/, 1],
    [VERIFIED, { ...MESSAGE, attachments: [{ kind: 'file', file: null }] }, /attachments are not sent/, 1],
  ] as const) {
    const { mod, calls, cleanup } = await loadModule(config);
    const result = await mod.c2cGuardedMail(message, {});
    assert.equal(result.performed, false);
    assert.match(result.reason, reason);
    assert.deepEqual(calls.sendMail, []);
    // Mail off: the deploy created no delivery log table, so nothing is written to one.
    assert.equal(calls.rows.length, rows);
    assert.equal(result.logged, rows === 1);
    cleanup();
  }
});

test('live send: a sendMail error is a failed row, and a log failure is reported, not thrown', async () => {
  const failed = await loadModule(VERIFIED, { sendThrows: true });
  const errors: string[] = [];
  const origError = console.error;
  console.error = (msg: unknown) => errors.push(String(msg));
  let result;
  try {
    result = await failed.mod.c2cGuardedMail(MESSAGE, {});
  } finally {
    console.error = origError;
  }
  assert.deepEqual(result, { performed: false, status: 'failed', reason: 'The email could not be sent.', logged: true });
  assert.equal(failed.calls.rows[0].row.status, 'failed');
  assert.ok(errors.some((line) => line.includes('Invalid sender')));
  failed.cleanup();
  const unlogged = await loadModule(VERIFIED, { logThrows: true });
  const sent = await unlogged.mod.c2cGuardedMail(MESSAGE, {});
  assert.equal(sent.status, 'sent');
  assert.equal(sent.logged, false);
  assert.equal(sent.logError, 'no such table');
  unlogged.cleanup();
});

test('live send: provider error detail never reaches the caller — only the public reason', async () => {
  const { mod, cleanup } = await loadModule(VERIFIED, { sendThrows: true, sendError: 'SMTP 535 for owner@example.com key=s3cr3t-token' });
  const errors: string[] = [];
  const origError = console.error;
  console.error = (msg: unknown) => errors.push(String(msg));
  let result;
  try {
    result = await mod.c2cGuardedMail(MESSAGE, {});
  } finally {
    console.error = origError;
  }
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'The email could not be sent.');
  assert.doesNotMatch(JSON.stringify(result), /owner@example\.com|s3cr3t/);
  assert.ok(errors.some((line) => line.includes('owner@example.com') && line.includes('s3cr3t-token')));
  cleanup();
});

/** A mailer whose form carries a `print template` block and sends it `as inline`. */
const TEMPLATE_MAIL_DS = `/*
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
			print template
			{
				Receipt
				{
					content = {"layout":"1","orientation":"portrait","mainLayout":[{"elements":[{"type":"text","element":{"id":"e1","content":"<p>Receipt for \${Title}</p>"}},{"type":"fields","element":{"id":"e2","labelText":"Title","Label_Name":"Title"}}]}],"templateStyle":"text-align: left; width: 100%;"}
				}
			}
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
								to: "${OWNER}"
								subject: "c2c-mail"
								message: "hello"
								attachments: template:Receipt as inline
							];
						)
					}
				}
			}
		}
	}
}
`;

test('an app with an inline template attachment ships the print-template catalog next to c2c-mail', () => {
  const bundle = buildDeploy(appOf(TEMPLATE_MAIL_DS), guardFor('Mailer', '1001'), true);
  const catalogFile = bundle.files.find((file) => file.path === 'functions/c2c_api/c2c-print-templates.json');
  assert.ok(catalogFile, 'catalog ships beside c2c-mail.mjs');
  const catalog = JSON.parse(String(catalogFile.data));
  assert.equal(catalog.Item.Receipt.name, 'Receipt');
  assert.equal(catalog.Item.Receipt.elements.length, 2);
  const mailModule = bundle.files.find((file) => file.path.endsWith('/c2c-mail.mjs'));
  assert.match(String(mailModule?.data), /renderMailTemplate/);
  const handler = bundle.files.find((file) => String(file.data).includes('shim.mail.send('));
  assert.match(String(handler?.data), /rendered: "inline"/);
  // A mailer with no print layouts ships no catalog.
  const plain = buildDeploy(appOf(MAIL_DS), guardFor('Mailer', '1001'), true);
  assert.equal(plain.files.some((file) => file.path === 'functions/c2c_api/c2c-print-templates.json'), false);
});

test('live send: an inline template attachment renders into the body and sends', async () => {
  const bundle = buildDeploy(appOf(TEMPLATE_MAIL_DS), guardFor('Mailer', '1001'), true, false, undefined, undefined, {}, undefined, [OWNER]);
  const out = mkdtempSync(join(tmpdir(), 'c2c-mail-inline-'));
  writeDeployTree(out, bundle.files);
  writeFileSync(join(out, 'functions/c2c_api/c2c-mail.json'), JSON.stringify(VERIFIED));
  const mod = await import(`${pathToFileURL(join(out, 'functions/c2c_api/c2c-mail.mjs')).href}?t=${Math.random()}`);
  const calls: FakeCall = { req: null, sendMail: [], rows: [] };
  mod.setMailSdk((req: unknown) => {
    calls.req = req;
    return {
      email: () => ({
        sendMail: async (cfg: Record<string, unknown>) => {
          calls.sendMail.push(cfg);
          return { from_email: cfg.from_email };
        },
      }),
      datastore: () => ({
        table: (table: string) => ({
          insertRow: async (row: Record<string, unknown>) => {
            calls.rows.push({ table, row });
            return { ROWID: '1', ...row };
          },
        }),
      }),
    };
  });
  try {
    const message = {
      ...MESSAGE,
      attachments: [{ kind: 'template', name: 'Receipt', form: null, record: { Title: '<script>alert(1)</script>' }, format: 'inline', rendered: 'inline' }],
    };
    const result = await mod.c2cGuardedMail(message, {});
    assert.equal(result.status, 'sent');
    assert.equal(calls.sendMail.length, 1);
    const content = String(calls.sendMail[0]?.content);
    assert.match(content, /Receipt for/);
    // The record value is escaped; the script never reaches the body.
    assert.equal(content.includes('<script>'), false);
    assert.match(content, /&lt;script&gt;/);
    // The built-in summary name renders the record label:value list.
    const summary = await mod.c2cGuardedMail(
      { ...MESSAGE, attachments: [{ kind: 'template', name: '_default', form: null, record: { Title: 'T-9' }, format: 'inline', rendered: 'inline' }] },
      {},
    );
    assert.equal(summary.status, 'sent');
    assert.match(String(calls.sendMail[1]?.content), /T-9/);
    // A PDF descriptor without a `rendered` mark still refuses — only the
    // translated `as pdf` path carries it.
    const pdf = await mod.c2cGuardedMail(
      { ...MESSAGE, attachments: [{ kind: 'template', name: 'Receipt', form: null, record: {}, format: 'pdf' }] },
      {},
    );
    assert.equal(pdf.status, 'refused');
    assert.match(pdf.reason, /attachments are not sent/);
    // A view render stays refused.
    const view = await mod.c2cGuardedMail(
      { ...MESSAGE, attachments: [{ kind: 'view', name: 'All_Items', criteria: null, format: 'pdf' }] },
      {},
    );
    assert.equal(view.status, 'refused');
    assert.match(view.reason, /attachments are not sent/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

/** The same mailer, with the template attached `as pdf`. */
const PDF_MAIL_DS = TEMPLATE_MAIL_DS.replace('template:Receipt as inline', 'template:Receipt as pdf');

test('an app with a pdf template attachment ships the catalog and plans the SmartBrowz enable', () => {
  const bundle = buildDeploy(appOf(PDF_MAIL_DS), guardFor('Mailer', '1001'), true);
  assert.ok(bundle.files.some((file) => file.path === 'functions/c2c_api/c2c-print-templates.json'), 'catalog ships beside c2c-mail.mjs');
  const handler = bundle.files.find((file) => String(file.data).includes('rendered: "pdf"'));
  assert.ok(handler, 'a generated function carries the pdf descriptor');
  // The offline plan adds the SmartBrowz console enable only for this app:
  // a mailer without pdf attachments plans no new step.
  const steps = buildOfflinePlan(appOf(PDF_MAIL_DS), { dc: 'in', dcSource: '--dc', mail: false }).plan.steps;
  const step = steps.find((item) => item.id === 'smartbrowz-enable');
  assert.ok(step, 'pdf mail plans the SmartBrowz console enable');
  assert.equal(step.via, 'console');
  const plain = buildOfflinePlan(appOf(MAIL_DS), { dc: 'in', dcSource: '--dc', mail: false }).plan.steps;
  assert.equal(plain.some((item) => item.id === 'smartbrowz-enable'), false);
  const quiet = buildOfflinePlan(appOf(PLAIN_DS), { dc: 'in', dcSource: '--dc', mail: false }).plan.steps;
  assert.equal(quiet.some((item) => item.id === 'smartbrowz-enable'), false);
});

test('live send: a pdf template attachment converts through SmartBrowz and attaches', async () => {
  const bundle = buildDeploy(appOf(PDF_MAIL_DS), guardFor('Mailer', '1001'), true, false, undefined, undefined, {}, undefined, [OWNER]);
  const out = mkdtempSync(join(tmpdir(), 'c2c-mail-pdf-'));
  writeDeployTree(out, bundle.files);
  writeFileSync(join(out, 'functions/c2c_api/c2c-mail.json'), JSON.stringify(VERIFIED));
  const mod = await import(`${pathToFileURL(join(out, 'functions/c2c_api/c2c-mail.mjs')).href}?t=${Math.random()}`);
  const calls: FakeCall & { pdfs: { html: string; options: unknown }[] } = { req: null, sendMail: [], rows: [], pdfs: [] };
  mod.setMailSdk((req: unknown) => {
    calls.req = req;
    return {
      email: () => ({
        sendMail: async (cfg: Record<string, unknown>) => {
          calls.sendMail.push(cfg);
          return { from_email: cfg.from_email };
        },
      }),
      smartbrowz: () => ({
        convertToPdf: async (html: string, options: unknown) => {
          calls.pdfs.push({ html, options });
          return Buffer.from('%PDF-1.4 fake');
        },
      }),
      datastore: () => ({
        table: (table: string) => ({
          insertRow: async (row: Record<string, unknown>) => {
            calls.rows.push({ table, row });
            return { ROWID: '1', ...row };
          },
        }),
      }),
    };
  });
  try {
    const message = {
      ...MESSAGE,
      attachments: [{ kind: 'template', name: 'Receipt', form: null, record: { Title: 'T-7' }, format: 'pdf', rendered: 'pdf' }],
    };
    const result = await mod.c2cGuardedMail(message, {});
    assert.deepEqual(result, { performed: true, status: 'sent', reason: 'accepted by Catalyst Mail', logged: true });
    assert.equal(calls.pdfs.length, 1);
    assert.match(calls.pdfs[0].html, /T-7/);
    assert.deepEqual(calls.pdfs[0].options, { pdf_options: { format: 'A4' } });
    const attachments = calls.sendMail[0]?.attachments as { name: string; content: Buffer }[] | undefined;
    assert.equal(attachments?.length, 1);
    assert.equal(attachments?.[0]?.name, 'Receipt.pdf');
    assert.equal(attachments?.[0]?.content.toString('utf8'), '%PDF-1.4 fake');
    // The body holds the message text only — the pdf is an attachment, not inline.
    assert.equal(calls.sendMail[0]?.content, '<b>hello</b>');
    // A pdf descriptor naming a layout the catalog does not know still refuses.
    const unknown = await mod.c2cGuardedMail(
      { ...MESSAGE, attachments: [{ kind: 'template', name: 'Nope', form: null, record: {}, format: 'pdf', rendered: 'pdf' }] },
      {},
    );
    assert.equal(unknown.status, 'refused');
    assert.match(unknown.reason, /attachments are not sent/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('live send: a convertToPdf failure is a failed row, not a send', async () => {
  const bundle = buildDeploy(appOf(PDF_MAIL_DS), guardFor('Mailer', '1001'), true, false, undefined, undefined, {}, undefined, [OWNER]);
  const out = mkdtempSync(join(tmpdir(), 'c2c-mail-pdf-err-'));
  writeDeployTree(out, bundle.files);
  writeFileSync(join(out, 'functions/c2c_api/c2c-mail.json'), JSON.stringify(VERIFIED));
  const mod = await import(`${pathToFileURL(join(out, 'functions/c2c_api/c2c-mail.mjs')).href}?t=${Math.random()}`);
  const calls: FakeCall = { req: null, sendMail: [], rows: [] };
  mod.setMailSdk(() => ({
    email: () => ({
      sendMail: async (cfg: Record<string, unknown>) => {
        calls.sendMail.push(cfg);
        return { from_email: cfg.from_email };
      },
    }),
    smartbrowz: () => ({
      convertToPdf: async () => {
        throw new Error('SmartBrowz is not enabled for this project');
      },
    }),
    datastore: () => ({
      table: (table: string) => ({
        insertRow: async (row: Record<string, unknown>) => {
          calls.rows.push({ table, row });
          return { ROWID: '1', ...row };
        },
      }),
    }),
  }));
  try {
    const result = await mod.c2cGuardedMail(
      { ...MESSAGE, attachments: [{ kind: 'template', name: 'Receipt', form: null, record: { Title: 'T-7' }, format: 'pdf', rendered: 'pdf' }] },
      {},
    );
    assert.equal(result.performed, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'The email could not be sent.');
    assert.deepEqual(calls.sendMail, []);
    assert.equal(calls.rows[0]?.row.status, 'failed');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('live send: a convertToPdf wrapper return is a failed row, not a send', async () => {
  const bundle = buildDeploy(appOf(PDF_MAIL_DS), guardFor('Mailer', '1001'), true, false, undefined, undefined, {}, undefined, [OWNER]);
  const out = mkdtempSync(join(tmpdir(), 'c2c-mail-pdf-wrap-'));
  writeDeployTree(out, bundle.files);
  writeFileSync(join(out, 'functions/c2c_api/c2c-mail.json'), JSON.stringify(VERIFIED));
  const mod = await import(`${pathToFileURL(join(out, 'functions/c2c_api/c2c-mail.mjs')).href}?t=${Math.random()}`);
  const calls: FakeCall = { req: null, sendMail: [], rows: [] };
  mod.setMailSdk(() => ({
    email: () => ({
      sendMail: async (cfg: Record<string, unknown>) => {
        calls.sendMail.push(cfg);
        return { from_email: cfg.from_email };
      },
    }),
    smartbrowz: () => ({
      convertToPdf: async () => ({ unexpected: 'wrapper' }),
    }),
    datastore: () => ({
      table: (table: string) => ({
        insertRow: async (row: Record<string, unknown>) => {
          calls.rows.push({ table, row });
          return { ROWID: '1', ...row };
        },
      }),
    }),
  }));
  try {
    const result = await mod.c2cGuardedMail(
      { ...MESSAGE, attachments: [{ kind: 'template', name: 'Receipt', form: null, record: { Title: 'T-7' }, format: 'pdf', rendered: 'pdf' }] },
      {},
    );
    assert.equal(result.performed, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'The email could not be sent.');
    assert.deepEqual(calls.sendMail, []);
    assert.equal(calls.rows[0]?.row.status, 'failed');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('live send: convertToPdf returning non-PDF bytes is a failed row, not a send', async () => {
  const bundle = buildDeploy(appOf(PDF_MAIL_DS), guardFor('Mailer', '1001'), true, false, undefined, undefined, {}, undefined, [OWNER]);
  const out = mkdtempSync(join(tmpdir(), 'c2c-mail-pdf-nonpdf-'));
  writeDeployTree(out, bundle.files);
  writeFileSync(join(out, 'functions/c2c_api/c2c-mail.json'), JSON.stringify(VERIFIED));
  const mod = await import(`${pathToFileURL(join(out, 'functions/c2c_api/c2c-mail.mjs')).href}?t=${Math.random()}`);
  const calls: FakeCall = { req: null, sendMail: [], rows: [] };
  mod.setMailSdk(() => ({
    email: () => ({
      sendMail: async (cfg: Record<string, unknown>) => {
        calls.sendMail.push(cfg);
        return { from_email: cfg.from_email };
      },
    }),
    smartbrowz: () => ({
      convertToPdf: async () => Buffer.from('not a pdf document'),
    }),
    datastore: () => ({
      table: (table: string) => ({
        insertRow: async (row: Record<string, unknown>) => {
          calls.rows.push({ table, row });
          return { ROWID: '1', ...row };
        },
      }),
    }),
  }));
  try {
    const result = await mod.c2cGuardedMail(
      { ...MESSAGE, attachments: [{ kind: 'template', name: 'Receipt', form: null, record: { Title: 'T-7' }, format: 'pdf', rendered: 'pdf' }] },
      {},
    );
    assert.equal(result.performed, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'The email could not be sent.');
    assert.deepEqual(calls.sendMail, []);
    assert.equal(calls.rows[0]?.row.status, 'failed');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('live send: convertToPdf returning Uint8Array bytes starting with %PDF- attaches and sends', async () => {
  const bundle = buildDeploy(appOf(PDF_MAIL_DS), guardFor('Mailer', '1001'), true, false, undefined, undefined, {}, undefined, [OWNER]);
  const out = mkdtempSync(join(tmpdir(), 'c2c-mail-pdf-u8-'));
  writeDeployTree(out, bundle.files);
  writeFileSync(join(out, 'functions/c2c_api/c2c-mail.json'), JSON.stringify(VERIFIED));
  const mod = await import(`${pathToFileURL(join(out, 'functions/c2c_api/c2c-mail.mjs')).href}?t=${Math.random()}`);
  const calls: FakeCall & { pdfs: { html: string; options: unknown }[] } = { req: null, sendMail: [], rows: [], pdfs: [] };
  mod.setMailSdk((req: unknown) => {
    calls.req = req;
    return {
      email: () => ({
        sendMail: async (cfg: Record<string, unknown>) => {
          calls.sendMail.push(cfg);
          return { from_email: cfg.from_email };
        },
      }),
      smartbrowz: () => ({
        convertToPdf: async (html: string, options: unknown) => {
          calls.pdfs.push({ html, options });
          return new Uint8Array(Buffer.from('%PDF-1.7 uint8array bytes'));
        },
      }),
      datastore: () => ({
        table: (table: string) => ({
          insertRow: async (row: Record<string, unknown>) => {
            calls.rows.push({ table, row });
            return { ROWID: '1', ...row };
          },
        }),
      }),
    };
  });
  try {
    const message = {
      ...MESSAGE,
      attachments: [{ kind: 'template', name: 'Receipt', form: null, record: { Title: 'T-7' }, format: 'pdf', rendered: 'pdf' }],
    };
    const result = await mod.c2cGuardedMail(message, {});
    assert.deepEqual(result, { performed: true, status: 'sent', reason: 'accepted by Catalyst Mail', logged: true });
    assert.equal(calls.pdfs.length, 1);
    const attachments = calls.sendMail[0]?.attachments as { name: string; content: Buffer }[] | undefined;
    assert.equal(attachments?.length, 1);
    assert.equal(attachments?.[0]?.name, 'Receipt.pdf');
    assert.equal(Buffer.from(attachments?.[0]?.content).toString('utf8'), '%PDF-1.7 uint8array bytes');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

/** A schedule that sends mail, plus a form schedule so the sweeper module is emitted too. */
const JOB_MAIL_DS = `/*
 * Author       : synthetic
 * Generated on : 01-Jan-2025 12:00:00
 * Version      : 1.0
 */
application "Mailer"
{
	time zone = "Asia/Kolkata"
	forms
	{
		form Item
		{
			Title
			(
				type = text
				displayname = "Title"
			)
			Due_Date
			(
				type = date
				displayname = "Due Date"
			)
		}
	}
	workflow
	{
		schedule
		{
			Nightly as "Nightly"
			{
				type = schedule
				start = "2017-01-03 02:00:00"
				frequency = daily
				time zone = "Asia/Kolkata"
				on start
				{
					actions
					{
					on load
					(
						sendmail
						[
							from: zoho.adminuserid
							to: "${OWNER}"
							subject: "c2c-mail"
							message: "hello"
						];
						rows = zoho.crm.getRecords("Leads");
					)
					}
				}
			}
			Due_Reminder as "Due Reminder"
			{
				type = schedule
				form = Item
				start = before 1 days from Due_Date at "09:00:00"
				time zone = "Asia/Kolkata"
				on start
				{
					actions
					{
					on load
					(
						sendmail
						[
							from: zoho.adminuserid
							to: "${OWNER}"
							subject: "c2c-mail"
							message: "due"
						]
					)
					}
				}
			}
		}
	}
}
`;

test('a scheduled job passes the Catalyst job context into patched mail', async () => {
  const bundle = buildDeploy(appOf(JOB_MAIL_DS), guardFor('Mailer', '1001'), true, true, undefined, undefined, { from: OWNER, verified: true }, undefined, [OWNER]);
  const jobs = bundle.files.filter((file) => file.path.startsWith('functions/c2c_api/job/') && file.path.endsWith('.mjs'));
  assert.ok(jobs.length >= 2, 'custom job and sweeper');
  const free = jobs.flatMap((file) => freeIdentifiers(String(file.data), allowedGlobals('server', file.path)).map((item) => `${file.path}:${item.name}`));
  assert.deepEqual(free, []);

  const out = mkdtempSync(join(tmpdir(), 'c2c-job-mail-'));
  writeDeployTree(out, bundle.files);
  const deployPath = join(out, 'functions/c2c_api/c2c-deploy.json');
  const deploy = JSON.parse(readFileSync(deployPath, 'utf8')) as Record<string, unknown>;
  deploy.orgInternal = { mailRecipients: [OWNER] };
  writeFileSync(deployPath, `${JSON.stringify(deploy, null, 2)}\n`);
  const previousMailFrom = process.env.C2C_MAIL_FROM;
  const previousDatastore = (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
  process.env.C2C_MAIL_FROM = OWNER;
  const calls: FakeCall = { req: null, sendMail: [], rows: [] };
  try {
    const mail = await import(pathToFileURL(join(out, 'functions/c2c_api/c2c-mail.mjs')).href);
    mail.setMailSdk((req: unknown) => {
      calls.req = req;
      return {
        email: () => ({
          sendMail: async (cfg: Record<string, unknown>) => {
            calls.sendMail.push(cfg);
            return { from_email: cfg.from_email };
          },
        }),
        datastore: () => ({
          table: (table: string) => ({
            insertRow: async (row: Record<string, unknown>) => {
              calls.rows.push({ table, row });
              return { ROWID: '1', ...row };
            },
          }),
        }),
      };
    });
    (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = {};
    const job = (await import(pathToFileURL(join(out, 'functions/c2c_api/job/nightly.mjs')).href)) as {
      default: (jobRequest: unknown, context: unknown) => Promise<unknown>;
    };
    const context = { id: 'job-ctx', closeWithSuccess() {}, closeWithFailure() {} };
    let thrown: unknown = null;
    try {
      await job.default({}, context);
    } catch (err) {
      thrown = err;
    }
    assert.equal(calls.req, context, thrown instanceof Error ? thrown.message : 'job context was not handed to setMailSdk');
    assert.equal(calls.sendMail.length, 1);
    assert.equal(calls.sendMail[0]?.from_email, OWNER);
  } finally {
    if (previousMailFrom === undefined) delete process.env.C2C_MAIL_FROM;
    else process.env.C2C_MAIL_FROM = previousMailFrom;
    if (previousDatastore === undefined) delete (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
    else (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = previousDatastore;
    rmSync(out, { recursive: true, force: true });
  }
});

function invoke(handler: (req: unknown, res: unknown) => unknown, req: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let raw = '';
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(body: string) {
      raw = body;
    },
  };
  return Promise.resolve(handler(req, res)).then(() => ({ status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} }));
}

/** The live mailer with an Administrator share so a signed-in submit is writable. */
const SUBMIT_MAIL_DS = MAILER_DS_LIVE.replace(
  '\treports\n',
  `\tshare_settings
\t{
\t\t"Administrator"
\t\t{
\t\t\tname = "Administrator"
\t\t\ttype = Users_Permissions
\t\t\tdescription = "This profile will have all the permissions."
\t\t}
\t}
\treports
`,
);

test('a live submit whose on-success sendmail is refused still answers 2xx; a real write failure still errors', async () => {
  const bundle = buildDeploy(appOf(SUBMIT_MAIL_DS), guardFor('Mailer', '1001'), true, true, undefined, undefined, { from: OWNER, verified: true }, undefined, [OWNER]);
  const submit = bundle.files.find((file) => file.path.endsWith('/on-success.mjs') && String(file.data).includes('shim.mail.send('));
  assert.ok(submit, 'the mailer submit handler');
  assert.match(String(submit.data), /mailGuarded: true/);
  const out = mkdtempSync(join(tmpdir(), 'c2c-submit-mail-'));
  writeDeployTree(out, bundle.files);
  // No zohoConnections.orgInternal is configured: before mailGuarded, the
  // org-internal guard threw ZohoConnectionRefused out of the on-success
  // script AFTER the row committed and the submit answered 500 wrote:true.
  // The allowlist excludes the script's recipient, so c2cGuardedMail refuses.
  writeFileSync(join(out, 'functions/c2c_api/c2c-mail.json'), JSON.stringify({ ...VERIFIED, allowlist: ['allowed-only@example.com'] }));
  const calls: FakeCall = { req: null, sendMail: [], rows: [] };
  const mail = (await import(pathToFileURL(join(out, 'functions/c2c_api/c2c-mail.mjs')).href)) as {
    setMailSdk: (factory: (req: unknown) => unknown) => void;
  };
  mail.setMailSdk((req: unknown) => {
    calls.req = req;
    return {
      email: () => ({
        sendMail: async (cfg: Record<string, unknown>) => {
          calls.sendMail.push(cfg);
          return { from_email: cfg.from_email };
        },
      }),
      datastore: () => ({
        table: (table: string) => ({
          insertRow: async (row: Record<string, unknown>) => {
            calls.rows.push({ table, row });
            return { ROWID: '1', ...row };
          },
        }),
      }),
    };
  });
  const inserts: Record<string, unknown>[] = [];
  const previousMode = process.env.C2C_DEPLOY_MODE;
  const previousZone = process.env.C2C_APP_TIMEZONE;
  const previousMailFrom = process.env.C2C_MAIL_FROM;
  const previousStore = (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
  try {
    process.env.C2C_DEPLOY_MODE = 'live';
    process.env.C2C_APP_TIMEZONE = 'Asia/Kolkata';
    process.env.C2C_MAIL_FROM = OWNER;
    (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = {
      async insert(_form: string, rows: Record<string, unknown>[]) {
        inserts.push(...rows);
        return { data: rows.map((row, i) => ({ ROWID: String(42001 + i), ...row })) };
      },
      async query() {
        return [];
      },
    };
    const handler = (
      (await import(pathToFileURL(join(out, submit.path)).href)) as { default: (req: unknown, res: unknown) => unknown }
    ).default;
    const req = { user: { profile: 'Administrator', loginUser: OWNER }, body: { record: { Title: 'member' } } };
    const refused = await invoke(handler, req);
    assert.equal(refused.status, 200, JSON.stringify(refused.body));
    assert.equal(refused.body.wrote, true);
    assert.equal(inserts.length, 1);
    // Nothing was sent, and the refusal is not a silent drop: it is counted
    // as a row in the app's mail log the user can read back.
    assert.deepEqual(calls.sendMail, []);
    assert.equal(calls.rows.length, 1);
    assert.equal(calls.rows[0]?.table, MAIL_LOG_TABLE);
    assert.equal(calls.rows[0]?.row.status, 'refused');
    assert.match(String(calls.rows[0]?.row.reason), /allowlist/);
    assert.deepEqual(refused.body.mail, [{ status: 'refused', reason: String(calls.rows[0]?.row.reason), logged: true }]);

    // When logDelivery itself fails, the refusal note surfaces logged:false and
    // the failure is logged to server log (console.error), never swallowed.
    const loggedErrors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args.map(String).join(' '));
    };
    try {
      mail.setMailSdk(() => ({
        email: () => ({
          sendMail: async () => ({ from_email: OWNER }),
        }),
        datastore: () => ({
          table: () => ({
            insertRow: async () => {
              throw new Error('mail log table unavailable');
            },
          }),
        }),
      }));
      const logFailed = await invoke(handler, req);
      assert.equal(logFailed.status, 200, JSON.stringify(logFailed.body));
      assert.equal(logFailed.body.wrote, true);
      assert.deepEqual(logFailed.body.mail, [{ status: 'refused', reason: String(calls.rows[0]?.row.reason), logged: false }]);
      assert.ok(loggedErrors.some((line) => line.includes('c2c mail delivery log failed: mail log table unavailable')));
    } finally {
      console.error = origError;
    }

    // When mail is allowlisted, the submit reply note carries status sent.
    writeFileSync(join(out, 'functions/c2c_api/c2c-mail.json'), JSON.stringify({ ...VERIFIED, allowlist: [OWNER] }));
    calls.sendMail = [];
    calls.rows = [];
    mail.setMailSdk(() => ({
      email: () => ({
        sendMail: async (cfg: Record<string, unknown>) => {
          calls.sendMail.push(cfg);
          return { from_email: cfg.from_email };
        },
      }),
      datastore: () => ({
        table: (table: string) => ({
          insertRow: async (row: Record<string, unknown>) => {
            calls.rows.push({ table, row });
            return { ROWID: '1', ...row };
          },
        }),
      }),
    }));
    const sent = await invoke(handler, req);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.wrote, true);
    assert.equal(calls.sendMail.length, 1);
    assert.deepEqual(sent.body.mail, [{ status: 'sent', reason: 'accepted by Catalyst Mail', logged: true }]);

    // When mail is disabled, the submit reply note carries status skipped.
    writeFileSync(join(out, 'functions/c2c_api/c2c-mail.json'), JSON.stringify({ ...VERIFIED, enabled: false }));
    const skipped = await invoke(handler, req);
    assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
    assert.equal(skipped.body.wrote, true);
    assert.deepEqual(skipped.body.mail, [{ status: 'skipped', reason: 'mail disabled', logged: false }]);

    // A real store failure on the row write still reports an error.
    (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = {
      async insert() {
        throw new Error('datastore is down');
      },
      async query() {
        return [];
      },
    };
    const failed = await invoke(handler, req);
    assert.equal(failed.status, 500, JSON.stringify(failed.body));
    assert.equal(failed.body.wrote === true, false);
    assert.ok(failed.body.error);
  } finally {
    if (previousMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = previousMode;
    if (previousZone === undefined) delete process.env.C2C_APP_TIMEZONE;
    else process.env.C2C_APP_TIMEZONE = previousZone;
    if (previousMailFrom === undefined) delete process.env.C2C_MAIL_FROM;
    else process.env.C2C_MAIL_FROM = previousMailFrom;
    if (previousStore === undefined) delete (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
    else (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = previousStore;
    rmSync(out, { recursive: true, force: true });
  }
});

test('the mail module initializes the SDK at admin scope: App User holds no table grant for the mail log', () => {
  const source = mailModuleSource(['ops@example.test']);
  assert.match(source, /catalyst\.initialize\(req, \{ scope: "admin" \}\)/);
  assert.doesNotMatch(source, /initialize\(req\)/);
});
