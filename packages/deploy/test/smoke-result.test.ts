/**
 * The default smoke path for a user with no browser automation: `c2c smoke
 * --confirm` prints one step (open <app url>#/admin/smoke in your own browser,
 * signed in as the owner, and copy the c2c-smoke/1 block), and `c2c smoke
 * --result <file|->` verifies that block. No path asks for or accepts a token
 * or cookie; the DevTools-protocol driver runs only with --cdp.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import type { SmokeBrowser } from '../src/browser.js';
import { smokeCli, type Io } from '../src/cli.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../src/guards.js';
import { deployFiles } from '../src/plan.js';
import { emptyRegistry } from '../src/registry.js';
import { decodeSmokeCode, encodeSmokeCode, SMOKE_CODE_PREFIX } from '../src/smoke-code.js';

const DS = `application "Widget"
{
	time zone = "Asia/Kolkata"
	share_settings
	{
		"Administrator"
		{
			name = "Administrator"
			type = Users_Permissions
			description = "This profile will have all the permissions."
		}
	}
	form Item
	{
		must have Item_Name
		(
			type = text
		)
	}
}
`;

const ORG = '10000000000';
const PROJECT = '1001';
const APP_URL = 'https://widget-app.example.test/app/';
const PAGE = 'https://widget-app.example.test/app#/admin/smoke';
const ASKS_FOR_SECRET = /--auth-token|--session-cookie|remote-debugging|copy (?:a|the|your) (?:token|cookie)|paste (?:a|the|your) (?:token|cookie)/i;

function workspace(report: Record<string, unknown> | null = { projectId: PROJECT, slate: { appUrl: APP_URL } }): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-smoke-result-'));
  writeFileSync(join(dir, 'widget.ds'), DS);
  if (report) writeFileSync(join(dir, 'c2c-deploy-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return dir;
}

function capture(stdin = ''): { io: Io; stdout: () => string; stderr: () => string; fetched: string[] } {
  let out = '';
  let err = '';
  const fetched: string[] = [];
  return {
    io: {
      stdout: (text: string) => {
        out += text;
      },
      stderr: (text: string) => {
        err += text;
      },
      env: {},
      cliDc: () => 'in',
      cliOrg: () => ORG,
      listProjects: async () => [] as readonly { name: string; id: string }[],
      spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
      fetch: async (url: string) => {
        fetched.push(url);
        return new Response('{}', { status: 404 });
      },
      rest: async () => ({ status: 200, body: {} }),
      accessToken: async () => 'cli-token',
      stdin: () => stdin,
    } as Io,
    stdout: () => out,
    stderr: () => err,
    fetched,
  };
}

function untouchedBrowser(): SmokeBrowser & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    async open(url: string) {
      opened.push(url);
      throw new Error('the default path must not drive a browser');
    },
  };
}

const ARGS = (dir: string, ...extra: string[]) => [join(dir, 'widget.ds'), '--org', ORG, '--project', PROJECT, '--dc', 'in', ...extra];

test('smoke --confirm with no browser automation prints the one guided step with the deploy report URL', async () => {
  for (const mode of [[], ['--in-browser', '--url', APP_URL], ['--owner-session', '--url', 'https://widget-1.example.test/server/c2c_api']]) {
    const dir = workspace();
    try {
      const browser = untouchedBrowser();
      const cap = capture();
      const report = join(dir, 'smoke-report.json');
      const code = await smokeCli(ARGS(dir, '--confirm', '--report', report, ...mode), cap.io, { browser });
      assert.equal(code, 4, `${mode.join(' ')}\n${cap.stdout()}\n${cap.stderr()}`);
      const out = cap.stdout();
      assert.ok(out.includes(`open ${PAGE} in your own browser, signed in to the app as the project owner`), out);
      assert.match(out, /press Copy beside the result code it shows and paste the code back here \(your AI chat checks it with c2c smoke --result-code <code>\)/);
      assert.match(out, /save the c2c-smoke\/1 block it shows as smoke-result\.txt and run: c2c smoke .*widget\.ds --result smoke-result\.txt/);
      assert.match(out, new RegExp(`^c2c-blocker: smoke-page ${PAGE.replace(/[.#/]/g, '\\$&')}$`, 'm'));
      assert.equal(out.split('\n').filter((line) => line.startsWith('  open ')).length, 1, 'one step');
      assert.doesNotMatch(out + cap.stderr(), ASKS_FOR_SECRET);
      assert.deepEqual(browser.opened, [], 'no browser is driven');
      assert.deepEqual(cap.fetched, [], 'nothing is called');
      const written = JSON.parse(readFileSync(report, 'utf8')) as { ok: boolean; blocker: string };
      assert.equal(written.ok, false);
      assert.equal(written.blocker, `smoke-page ${PAGE}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('smoke usage never offers a browser drive or a credential flag — the guided page is the whole interface', async () => {
  const cap = capture();
  assert.equal(await smokeCli([], cap.io), 2);
  assert.match(cap.stderr(), /^usage: c2c smoke/);
  assert.doesNotMatch(cap.stderr(), /cdp|devtools|remote-debugging|--in-browser|--owner-session|--auth-token|--session-cookie/i);
});

test('smoke --confirm with no deploy report still gives the step, naming where the app URL comes from', async () => {
  const dir = workspace(null);
  try {
    const cap = capture();
    const code = await smokeCli(ARGS(dir, '--confirm'), cap.io, { browser: untouchedBrowser() });
    assert.equal(code, 4, cap.stderr());
    assert.match(cap.stdout(), /open your deployed app's URL followed by #\/admin\/smoke/);
    assert.match(cap.stdout(), /^c2c-blocker: smoke-page$/m);
    assert.doesNotMatch(cap.stdout() + cap.stderr(), ASKS_FOR_SECRET);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the page's block, sealed by the generated runtime itself ----------------

const app = deriveIr(parse(DS));
const guard: GuardOk = { org: ORG, projectId: PROJECT, environment: ALLOWED_ENV, projectName: catalystProjectName('Widget'), dc: 'in', registry: emptyRegistry() };
const files = deployFiles(app, guard, false, { mode: 'live' }).files;
const configText = String(files.find((file) => file.path === 'slate/c2c-config.js')?.data ?? '');

type Seal = (block: Record<string, unknown>, bind: Record<string, unknown>) => Promise<Record<string, unknown>>;
type PageCode = (block: unknown, plan: unknown) => Promise<string>;
let sealCache: Seal | undefined;
let pageCodeCache: PageCode | undefined;
async function seal(): Promise<Seal> {
  if (sealCache) return sealCache;
  const dir = mkdtempSync(join(tmpdir(), 'c2c-smoke-runtime-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  for (const file of files.filter((entry) => entry.path.startsWith('slate/assets/'))) {
    mkdirSync(dirname(join(dir, file.path)), { recursive: true });
    writeFileSync(join(dir, file.path), String(file.data));
  }
  const runtime = files.find((file) => /slate\/assets\/runtime\.[0-9a-f]{10}\.js$/.test(file.path));
  assert.ok(runtime, 'the deploy ships the page runtime');
  const full = join(dir, runtime.path);
  const mod = (await import(pathToFileURL(full).href)) as { sealSmokeBlock: Seal; smokeResultCode: PageCode };
  sealCache = mod.sealSmokeBlock;
  pageCodeCache = mod.smokeResultCode;
  return sealCache;
}

/** The result code the deployed page's own runtime shows for a block, run on the embedded plan. */
async function pageCode(block: unknown, plan: unknown = embeddedPlan()): Promise<string> {
  await seal();
  return await pageCodeCache!(block, plan);
}

function embeddedPlan(): unknown {
  const match = /globalThis\.C2C_SMOKE_PLAN = (.*);\n/.exec(configText);
  assert.ok(match, 'the deploy embeds the smoke plan');
  return JSON.parse(match[1]!) as unknown;
}

const RUN = {
  version: 'c2c-smoke/1',
  ok: true,
  created: 1,
  deleted: 1,
  left: 0,
  exercised: 4,
  steps: [
    { label: 'session bootstrap', ok: true, detail: 'signed in' },
    { label: 'submit Item', ok: true, detail: '200 wrote 123' },
    { label: 'read-back Item', ok: true, detail: 'row 123 present' },
    { label: 'delete Item', ok: true, detail: 'row 123 deleted (verified gone)' },
  ],
};

async function block(over: { run?: Record<string, unknown>; bind?: Record<string, unknown> } = {}): Promise<Record<string, unknown>> {
  const sealer = await seal();
  return await sealer(over.run ?? RUN, {
    origin: new URL(APP_URL).origin,
    app: 'Widget',
    project: /C2C_SMOKE_PROJECT = "([0-9]+)"/.exec(configText)?.[1],
    plan: embeddedPlan(),
    at: new Date().toISOString(),
    ...over.bind,
  });
}

async function verify(dir: string, text: string, ...extra: string[]) {
  const path = join(dir, 'pasted.txt');
  writeFileSync(path, text);
  const cap = capture();
  const report = join(dir, 'out', 'smoke-report.json');
  const code = await smokeCli([join(dir, 'widget.ds'), '--result', path, '--report', report, ...extra], cap.io);
  return { code, cap, report };
}

test('smoke --result accepts the block the deployed page printed and writes the smoke report', async () => {
  const dir = workspace();
  try {
    const sealed = await block();
    assert.equal(sealed.project, PROJECT, 'the deploy embeds the project the page stamps');
    // Pasted as the page shows it, with whatever the user's selection picked up around it.
    const { code, cap, report } = await verify(dir, `Smoke run\nDone — every check passed.\n${JSON.stringify(sealed, null, 2)}\n`);
    assert.equal(code, 0, `stdout:\n${cap.stdout()}\nstderr:\n${cap.stderr()}`);
    assert.match(cap.stdout(), /submit Item: 200 wrote 123/);
    assert.match(cap.stdout(), /result: verified — every step passed on https:\/\/widget-app\.example\.test for project 1001/);
    assert.deepEqual(cap.fetched, [], 'verifying makes no call');
    const written = JSON.parse(readFileSync(report, 'utf8')) as { version: string; ok: boolean; session: string; lines: string[]; result: Record<string, unknown> };
    assert.equal(written.version, 'c2c-smoke-report/1');
    assert.equal(written.ok, true);
    assert.equal(written.session, 'app-user');
    assert.deepEqual(written.result, sealed);
    assert.doesNotMatch(cap.stdout() + cap.stderr(), ASKS_FOR_SECRET);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke --result reads the block from stdin with -', async () => {
  const dir = workspace();
  try {
    const cap = capture(JSON.stringify(await block()));
    const code = await smokeCli([join(dir, 'widget.ds'), '--result', '-'], cap.io);
    assert.equal(code, 0, cap.stderr());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke --result refuses foreign-origin, wrong-project, other-plan, stale, tampered and failed-step blocks', async () => {
  const dir = workspace();
  try {
    const tampered = await block();
    tampered.steps = [...(RUN.steps as unknown[]).slice(0, 1), { label: 'submit Item', ok: true, detail: '200 wrote 999' }, ...(RUN.steps as unknown[]).slice(2)];
    const cut = await block();
    delete cut.digest;
    const failedRun = { ...RUN, ok: false, steps: [...RUN.steps.slice(0, 1), { label: 'submit Item', ok: false, detail: '403 refused' }, ...RUN.steps.slice(2)] };
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['foreign origin', await block({ bind: { origin: 'https://someone-else.example.test' } }), /ran on https:\/\/someone-else\.example\.test, not this deploy's app https:\/\/widget-app\.example\.test/],
      ['wrong project', await block({ bind: { project: '2002' } }), /names project 2002, not this deploy's project 1001/],
      ['no project', await block({ bind: { project: '' } }), /names no project/],
      ['other app', await block({ bind: { app: 'Other' } }), /names app "Other"/],
      ['other plan', await block({ bind: { plan: [{ kind: 'session', label: 'session bootstrap' }] } }), /different smoke plan/],
      ['stale', await block({ bind: { at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() } }), /stale/],
      ['future', await block({ bind: { at: new Date(Date.now() + 60 * 60_000).toISOString() } }), /in the future/],
      ['tampered', tampered, /does not match its digest/],
      ['no digest', cut, /no digest/],
      ['failed step', await block({ run: failedRun }), /1 step\(s\) did not pass: submit Item/],
      ['wrong version', await block({ run: { ...RUN, version: 'c2c-smoke/0' } }), /not version c2c-smoke\/1/],
      ['extra field', await block({ run: { ...RUN, note: 'x' } }), /fields the page never prints: note/],
    ];
    for (const [name, sealed, reason] of cases) {
      const { code, cap, report } = await verify(dir, JSON.stringify(sealed));
      assert.equal(code, 1, `${name}: ${cap.stdout()}\n${cap.stderr()}`);
      assert.match(cap.stderr(), reason, `${name}: ${cap.stderr()}`);
      assert.match(cap.stdout(), /^state: failed$/m, name);
      const written = JSON.parse(readFileSync(report, 'utf8')) as { ok: boolean };
      assert.equal(written.ok, false, name);
    }
    // The freshness window is the user's to widen.
    const old = await block({ bind: { at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() } });
    assert.equal((await verify(dir, JSON.stringify(old), '--max-age', '180')).code, 0);
    // Not a block at all.
    assert.equal((await verify(dir, 'Smoke run\nNot signed in.')).code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke --result never takes a token or cookie', async () => {
  const dir = workspace();
  try {
    // A pasted block carrying a credential-shaped field is refused and never echoed.
    const withSecret = { ...(await block()), sessionToken: 'zz-DO-NOT-ECHO' };
    const { code, cap, report } = await verify(dir, JSON.stringify(withSecret));
    assert.equal(code, 1);
    assert.match(cap.stderr(), /credential-shaped field/);
    assert.ok(!(cap.stdout() + cap.stderr() + readFileSync(report, 'utf8')).includes('zz-DO-NOT-ECHO'));
    // Credential and browser flags are refused outright.
    for (const extra of [['--auth-token', 'abc'], ['--session-cookie', 'a=b'], ['--in-browser'], ['--cdp']]) {
      const path = join(dir, 'ok.json');
      writeFileSync(path, JSON.stringify(await block()));
      const refused = capture();
      assert.equal(await smokeCli([join(dir, 'widget.ds'), '--result', path, ...extra], refused.io), 2, extra.join(' '));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke --result binds to the deploy report, else --url and --project', async () => {
  const bare = workspace(null);
  try {
    const sealed = JSON.stringify(await block());
    const missing = await verify(bare, sealed);
    assert.equal(missing.code, 2);
    assert.match(missing.cap.stderr(), /no c2c-deploy-report\.json.*--url <app-url>/);
    assert.equal((await verify(bare, sealed, '--url', APP_URL, '--project', PROJECT)).code, 0);
    assert.equal((await verify(bare, sealed, '--url', 'https://someone-else.example.test/', '--project', PROJECT)).code, 1);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
  const dir = workspace();
  try {
    // A --url or --project that disagrees with the report is refused before the block is read.
    assert.equal((await verify(dir, '{}', '--url', 'https://someone-else.example.test/')).code, 2);
    assert.equal((await verify(dir, '{}', '--project', '2002')).code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the result code: the same block, packed for a paste into the AI chat ----

test('result code: the page packs the whole block and c2c unpacks it byte-for-byte', async () => {
  const plan = embeddedPlan();
  const sealed = await block();
  const code = await pageCode(sealed);
  assert.match(code, /^c2cs1k[A-Za-z0-9_-]+$/, 'copy-safe: one URL-safe token, compact and deflated');
  const unpacked = decodeSmokeCode(code, plan);
  assert.ok(unpacked.ok, unpacked.ok ? '' : unpacked.reason);
  assert.deepEqual(JSON.parse(unpacked.json), sealed, 'round-trip == block');
  // The Node encoder agrees with the page; the plain form (a browser without
  // CompressionStream) and the whole-block fallback round-trip too.
  assert.equal(encodeSmokeCode(sealed, { plan }), code);
  const plain = encodeSmokeCode(sealed, { plan, deflate: false });
  assert.match(plain, /^c2cs1c[A-Za-z0-9_-]+$/);
  const failed = await block({ run: { ...RUN, ok: false, steps: [{ label: 'session bootstrap', ok: false, detail: 'failed — offline' }] } });
  const tampered = { ...sealed, created: 9 };
  for (const [name, value, text, shape] of [
    ['plain', sealed, plain, /^c2cs1c/],
    ['failed run', failed, encodeSmokeCode(failed, { plan }), /^c2cs1k/],
    ['no plan strings', sealed, encodeSmokeCode(sealed), /^c2cs1k/],
    ['tampered, whole block', tampered, encodeSmokeCode(tampered, { plan }), /^c2cs1z/],
    ['whole block, plain', tampered, encodeSmokeCode(tampered, { deflate: false }), /^c2cs1j/],
  ] as const) {
    assert.match(text, shape, name);
    const again = decodeSmokeCode(text, plan);
    assert.ok(again.ok, `${name}: ${again.ok ? '' : again.reason}`);
    assert.deepEqual(JSON.parse(again.json), value, name);
  }
  assert.ok(code.length < plain.length, `deflated ${code.length} < plain ${plain.length}`);
  // The code's plan strings are this source's: under another plan it does not unpack.
  const other = decodeSmokeCode(code, [{ kind: 'session', label: 'session bootstrap' }]);
  assert.equal(other.ok, false);
  assert.match(other.ok ? '' : other.reason, /different smoke plan/);
});

test('result code: a mistyped, cut-short or foreign code is refused with a reason, never a crash', async () => {
  const code = await pageCode(await block());
  const flip = (text: string, at: number) => `${text.slice(0, at)}${text[at] === 'A' ? 'B' : 'A'}${text.slice(at + 1)}`;
  const cases: [string, string, RegExp][] = [
    ['one char mistyped', flip(code, 20), /mistyped or cut short/],
    ['check mistyped', flip(code, code.length - 2), /mistyped or cut short/],
    ['last char dropped', code.slice(0, -1), /mistyped or cut short/],
    ['half the code', code.slice(0, Math.floor(code.length / 2)), /mistyped or cut short/],
    ['just the prefix', SMOKE_CODE_PREFIX, /cut short/],
    ['empty', '', /does not start with c2cs1/],
    ['other prefix', `x${code.slice(1)}`, /does not start with c2cs1/],
    ['bad characters', `${code.slice(0, 10)}+/${code.slice(12)}`, /characters a result code never has/],
  ];
  for (const [name, bad, reason] of cases) {
    const out = decodeSmokeCode(bad);
    assert.equal(out.ok, false, name);
    assert.match(out.ok ? '' : out.reason, reason, name);
  }
  // Every single-character edit and every truncation is refused without throwing.
  for (let at = 0; at < code.length; at++) {
    assert.equal(decodeSmokeCode(flip(code, at)).ok, false, `flip at ${at}`);
    assert.equal(decodeSmokeCode(code.slice(0, at)).ok, false, `cut at ${at}`);
  }
  // A well-formed check over a payload that is not a block, or one that
  // unpacks past any block's size, is refused too.
  const forge = (mode: string, payload: Buffer) => {
    const body = `${SMOKE_CODE_PREFIX}${mode}${payload.toString('base64url')}`;
    return `${body}${createHash('sha256').update(body).digest().subarray(0, 4).toString('base64url')}`;
  };
  const garbage = decodeSmokeCode(forge('z', Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x01])));
  assert.equal(garbage.ok, false);
  assert.match(garbage.ok ? '' : garbage.reason, /does not unpack/);
  const bomb = decodeSmokeCode(forge('z', deflateRawSync(Buffer.alloc(4 * 1024 * 1024, 0x20))));
  assert.equal(bomb.ok, false);
  assert.match(bomb.ok ? '' : bomb.reason, /does not unpack|more than a c2c-smoke\/1 block/);
  const otherMode = decodeSmokeCode(forge('q', Buffer.from('{}')));
  assert.equal(otherMode.ok, false);
  assert.match(otherMode.ok ? '' : otherMode.reason, /format letter "q"/);
});

test('smoke --result-code verifies the pasted code with the same checks as --result', async () => {
  const dir = workspace();
  try {
    const sealed = await block();
    const code = await pageCode(sealed);
    const report = join(dir, 'out', 'smoke-report.json');
    const cap = capture();
    assert.equal(await smokeCli([join(dir, 'widget.ds'), '--result-code', code, '--report', report], cap.io), 0, cap.stderr());
    assert.match(cap.stdout(), /submit Item: 200 wrote 123/);
    assert.match(cap.stdout(), /result: verified — every step passed on https:\/\/widget-app\.example\.test for project 1001/);
    assert.deepEqual(cap.fetched, [], 'verifying makes no call');
    assert.deepEqual((JSON.parse(readFileSync(report, 'utf8')) as { result: unknown }).result, sealed);

    // From stdin, wrapped by a chat window, or in the file --result reads.
    const piped = capture(`${code.slice(0, 40)}\n${code.slice(40)}\n`);
    assert.equal(await smokeCli([join(dir, 'widget.ds'), '--result-code', '-'], piped.io), 0, piped.stderr());
    assert.equal((await verify(dir, `Here is my code: ${code}`)).code, 0);

    // The verifier behind the code is the --result verifier: a code for a
    // foreign, stale or failed block is refused for the same reason.
    const failedRun = { ...RUN, ok: false, steps: [...RUN.steps.slice(0, 1), { label: 'submit Item', ok: false, detail: '403 refused' }, ...RUN.steps.slice(2)] };
    for (const [over, reason] of [
      [{ bind: { origin: 'https://someone-else.example.test' } }, /not this deploy's app/],
      [{ bind: { at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() } }, /stale/],
      [{ run: failedRun }, /1 step\(s\) did not pass: submit Item/],
      [{ bind: { plan: [{ kind: 'session', label: 'session bootstrap' }] } }, /different smoke plan/],
    ] as const) {
      const refused = capture();
      const bound = (over as { bind?: { plan?: unknown } }).bind?.plan;
      assert.equal(await smokeCli([join(dir, 'widget.ds'), '--result-code', await pageCode(await block(over), bound)], refused.io), 1);
      assert.match(refused.stderr(), reason);
    }
    // A mistyped or cut-short code exits 1 with the reason and a failed report.
    const cut = capture();
    assert.equal(await smokeCli([join(dir, 'widget.ds'), '--result-code', code.slice(0, -3), '--report', report], cut.io), 1);
    assert.match(cut.stderr(), /c2c: refused: the result code is mistyped or cut short/);
    assert.match(cut.stdout(), /^state: failed$/m);
    assert.equal((JSON.parse(readFileSync(report, 'utf8')) as { ok: boolean }).ok, false);
    // Usage errors.
    const both = capture();
    assert.equal(await smokeCli([join(dir, 'widget.ds'), '--result-code', code, '--result', 'x.txt'], both.io), 2);
    const bare = capture();
    assert.equal(await smokeCli([join(dir, 'widget.ds'), '--result-code'], bare.io), 2);
    assert.match(bare.stderr(), /--result-code needs the code/);
    const usage = capture();
    await smokeCli([], usage.io);
    assert.match(usage.stderr(), /c2c smoke <file\|dir> --result-code <code\|->/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
