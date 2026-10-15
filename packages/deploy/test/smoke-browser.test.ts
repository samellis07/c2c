/**
 * `c2c smoke --in-browser`: the CLI attaches to a browser over the DevTools
 * protocol, opens <app url>#/admin/smoke, polls the page state until the run
 * reaches a terminal state, and prints the result lines plus the JSON block.
 * It reads DOM state only — never cookies, storage, or tokens.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cdpBrowser, runBrowserSmoke, type SmokeBrowser } from '../src/browser.js';
import { smokeCli, type Io } from '../src/cli.js';

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


/** A scripted page: each evaluate() call is matched by expression fragment. `redirectTo` reports another origin on every poll. */
function fakeBrowser(script: { states: string[]; lines?: string[]; json?: unknown; redirectTo?: string }): SmokeBrowser & { opened: string[]; closed: boolean } {
  const opened: string[] = [];
  const stateQueue = [...script.states];
  let pageOrigin = '';
  const box = {
    opened,
    closed: false,
    async open(url: string) {
      opened.push(url);
      pageOrigin = new URL(url).origin;
      return {
        async evaluate(expression: string) {
          if (expression.includes('location.origin')) return script.redirectTo ?? pageOrigin;
          if (expression.includes('data-smoke-state')) return stateQueue.length > 1 ? stateQueue.shift() : stateQueue[0];
          if (expression.includes('c2c-smoke-json')) return script.json === undefined ? '' : JSON.stringify(script.json);
          if (expression.includes('data-smoke-steps')) return script.lines ?? [];
          return '';
        },
        async close() {
          box.closed = true;
        },
      };
    },
  };
  return box as SmokeBrowser & { opened: string[]; closed: boolean };
}

const RESULT_JSON = { version: 'c2c-smoke/1', ok: true, created: 1, deleted: 1, left: 0, exercised: 2, steps: [{ label: 'submit Item', ok: true, detail: '200 wrote 123' }] };

test('runBrowserSmoke polls the page to a terminal state and returns lines + json', async () => {
  const browser = fakeBrowser({
    states: ['running', 'running', 'done'],
    lines: ['submit Item: 200 wrote 123', 'created 1, deleted 1, left 0'],
    json: RESULT_JSON,
  });
  const seen: string[] = [];
  const result = await runBrowserSmoke({
    browser,
    appUrl: 'http://127.0.0.1:9999/app',
    timeoutMs: 60000,
    sleep: async () => {},
    log: (line) => seen.push(line),
  });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'passed');
  assert.deepEqual(result.lines, ['submit Item: 200 wrote 123', 'created 1, deleted 1, left 0']);
  assert.deepEqual(result.json, RESULT_JSON);
  assert.deepEqual(browser.opened, ['http://127.0.0.1:9999/app#/admin/smoke']);
  assert.equal(browser.closed, true);
});

test('runBrowserSmoke fails cleanly on denied and unavailable', async () => {
  const denied = await runBrowserSmoke({
    browser: fakeBrowser({ states: ['denied'], lines: ['admin smoke: 403 denied'], json: undefined }),
    appUrl: 'https://app.example.test',
    timeoutMs: 60000,
    sleep: async () => {},
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.state, 'denied');
  assert.equal(denied.json, undefined);
  const unavailable = await runBrowserSmoke({
    browser: fakeBrowser({ states: ['unavailable'], lines: [], json: undefined }),
    appUrl: 'https://app.example.test',
    timeoutMs: 60000,
    sleep: async () => {},
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.state, 'failed');
});

test('runBrowserSmoke answers denied: off-origin on a redirect, forged markers and all', async () => {
  const browser = fakeBrowser({
    states: ['done'],
    redirectTo: 'https://evil.example.test',
    lines: ['forged step'],
    json: RESULT_JSON,
  });
  const result = await runBrowserSmoke({
    browser,
    appUrl: 'https://app.example.test',
    timeoutMs: 3000,
    sleep: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'denied');
  assert.ok(result.lines.some((line) => /denied: off-origin/.test(line)), JSON.stringify(result.lines));
  assert.equal(result.json, undefined);
});

test('runBrowserSmoke does not pass a done marker without a consistent JSON block', async () => {
  const missing = await runBrowserSmoke({
    browser: fakeBrowser({ states: ['done'], lines: ['forged'], json: undefined }),
    appUrl: 'https://app.example.test',
    timeoutMs: 60000,
    sleep: async () => {},
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.state, 'failed');
  assert.ok(missing.lines.some((line) => /no c2c-smoke\/1 JSON block/.test(line)));
  const vacuous = await runBrowserSmoke({
    browser: fakeBrowser({ states: ['done'], lines: [], json: { ...RESULT_JSON, exercised: 0 } }),
    appUrl: 'https://app.example.test',
    timeoutMs: 60000,
    sleep: async () => {},
  });
  assert.equal(vacuous.ok, false);
  assert.ok(vacuous.lines.some((line) => /exercised nothing/.test(line)));
});

test('runBrowserSmoke times out waiting for a terminal state', async () => {
  let waited = 0;
  const result = await runBrowserSmoke({
    browser: fakeBrowser({ states: ['running'], lines: [] }),
    appUrl: 'https://app.example.test',
    timeoutMs: 3000,
    sleep: async (ms) => {
      waited += ms;
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.lines.some((line) => /timed out/.test(line)));
});

/** Minimal WS frame encode (server→client is unmasked). */
function wsFrame(payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8');
  const len = data.length;
  if (len < 126) return Buffer.concat([Buffer.from([0x81, len]), data]);
  if (len < 65536) {
    const head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
    return Buffer.concat([head, data]);
  }
  const head = Buffer.alloc(10);
  head[0] = 0x81;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(len), 2);
  return Buffer.concat([head, data]);
}

/** Unmask + reassemble one client→server frame; returns undefined until a whole frame arrived. */
function readWsFrame(buffer: Buffer): { opcode: number; payload: Buffer; rest: Buffer } | undefined {
  if (buffer.length < 2) return undefined;
  const opcode = buffer[0]! & 0x0f;
  const masked = !!(buffer[1]! & 0x80);
  let len = buffer[1]! & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buffer.length < 4) return undefined;
    len = buffer.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buffer.length < 10) return undefined;
    len = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buffer.length < offset + maskLen + len) return undefined;
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  const payload = Buffer.from(buffer.subarray(offset + maskLen, offset + maskLen + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
  return { opcode, payload, rest: buffer.subarray(offset + maskLen + len) };
}

/** An in-process DevTools stand-in: /json/version plus the Runtime.evaluate probes. */
async function fakeCdp(script: { states: string[]; lines: string[]; json: unknown; opened: string[] }): Promise<{ endpoint: string; close(): Promise<void> }> {
  const states = [...script.states];
  let pageOrigin = '';
  const server: Server = createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}/devtools/browser/fake` }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const key = String(req.headers['sec-websocket-key'] ?? '');
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let buffer: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = readWsFrame(buffer);
        if (!frame) break;
        buffer = frame.rest;
        if (frame.opcode === 8) {
          socket.end();
          return;
        }
        if (frame.opcode === 9) {
          socket.write(Buffer.concat([Buffer.from([0x8a, frame.payload.length]), frame.payload]));
          continue;
        }
        if (frame.opcode !== 1) continue;
        const message = JSON.parse(frame.payload.toString('utf8')) as { id: number; method: string; sessionId?: string; params?: { url?: string; expression?: string } };
        let result: unknown = {};
        if (message.method === 'Target.createTarget') {
          const url = String(message.params?.url ?? '');
          script.opened.push(url);
          pageOrigin = new URL(url).origin;
          result = { targetId: 'target-1' };
        } else if (message.method === 'Target.attachToTarget') {
          result = { sessionId: 'session-1' };
        } else if (message.method === 'Runtime.evaluate') {
          const expr = String(message.params?.expression ?? '');
          let value: unknown = '';
          if (expr.includes('location.origin')) value = pageOrigin;
          else if (expr.includes('data-smoke-state')) value = states.length > 1 ? states.shift() : states[0];
          else if (expr.includes('c2c-smoke-json')) value = script.json === undefined ? '' : JSON.stringify(script.json);
          else if (expr.includes('data-smoke-steps')) value = script.lines;
          result = { result: { value } };
        } else if (message.method === 'Target.closeTarget') {
          result = { success: true };
        }
        socket.write(wsFrame(JSON.stringify({ id: message.id, result })));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

test('cdpBrowser refuses a webSocketDebuggerUrl that is not ws on the checked loopback port', async () => {
  for (const ws of [
    'ws://probe-nonloopback.invalid:8443/devtools/browser/x',
    'ws://127.0.0.1:1/devtools/browser/x',
    'http://127.0.0.1:9222/devtools/browser/x',
    'not-a-url',
  ]) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: ws }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      // The check runs before any DNS answer or dial, so the failure names the
      // guard — not ENOTFOUND or ECONNREFUSED.
      await assert.rejects(
        () => cdpBrowser(`http://127.0.0.1:${port}`).open('http://127.0.0.1:8080/app#/admin/smoke'),
        /loopback|ws or wss|not a URL|checked endpoint's port/,
        `websocket url ${ws}`,
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
  }
});

test('cdpBrowser refuses a webSocketDebuggerUrl that carries credentials', async () => {
  // The websocket handshake has no way to send userinfo; a credentialed URL
  // is refused before any dial, on the checked endpoint's own port.
  let upgrades = 0;
  let server: Server;
  server = createServer((_req, res) => {
    const port = (server.address() as { port: number }).port;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://user:pass@127.0.0.1:${port}/devtools/browser/x` }));
  });
  server.on('upgrade', (_req: IncomingMessage, socket: Duplex) => {
    upgrades += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(
      () => cdpBrowser(`http://127.0.0.1:${port}`).open('http://127.0.0.1:8080/app#/admin/smoke'),
      /credentials/,
    );
    assert.equal(upgrades, 0, 'the websocket was never dialed');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test('cdpBrowser speaks real DevTools framing over a loopback websocket', async () => {
  const opened: string[] = [];
  const cdp = await fakeCdp({
    states: ['done'],
    lines: ['submit Item: 200 wrote 123'],
    json: RESULT_JSON,
    opened,
  });
  try {
    const result = await runBrowserSmoke({
      browser: cdpBrowser(cdp.endpoint),
      appUrl: 'http://127.0.0.1:8080/app/',
      timeoutMs: 10000,
      sleep: async () => {},
    });
    assert.equal(result.ok, true);
    assert.deepEqual(opened, ['http://127.0.0.1:8080/app#/admin/smoke']);
    assert.deepEqual(result.json, RESULT_JSON);
  } finally {
    await cdp.close();
  }
});

function dsDir(deployReport?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-browser-cli-'));
  writeFileSync(join(dir, 'widget.ds'), DS);
  if (deployReport) writeFileSync(join(dir, 'c2c-deploy-report.json'), `${JSON.stringify(deployReport)}\n`);
  return dir;
}

function capture(env: NodeJS.ProcessEnv = {}): { io: Io; stdout: () => string; stderr: () => string } {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: (text: string) => {
        out += text;
      },
      stderr: (text: string) => {
        err += text;
      },
      env,
      cliDc: () => 'in',
      cliOrg: () => '10000000000',
      listProjects: async () => [] as readonly { name: string; id: string }[],
      spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
      fetch: async () => new Response('{}', { status: 404 }),
      rest: async () => ({ status: 200, body: {} }),
      accessToken: async () => 'token',
    } as Io,
    stdout: () => out,
    stderr: () => err,
  };
}

test('smoke --in-browser --confirm drives the page and prints the JSON result', async () => {
  const dir = dsDir({ slate: { appUrl: 'http://127.0.0.1:8080/app' } });
  try {
    const browser = fakeBrowser({
      states: ['done'],
      lines: ['submit Item: 200 wrote 123', 'created 1, deleted 1, left 0'],
      json: RESULT_JSON,
    });
    const cap = capture();
    const code = await smokeCli(
      [join(dir, 'widget.ds'), '--org', '10000000000', '--project', '1001', '--dc', 'in', '--url', 'http://127.0.0.1:8080/app', '--confirm', '--in-browser', '--cdp'],
      cap.io,
      { browser },
    );
    assert.equal(code, 0, `stdout:\n${cap.stdout()}\nstderr:\n${cap.stderr()}`);
    assert.match(cap.stdout(), /submit Item: 200 wrote 123/);
    assert.match(cap.stdout(), /created 1, deleted 1, left 0/);
    assert.match(cap.stdout(), /"version": "c2c-smoke\/1"/);
    assert.deepEqual(browser.opened, ['http://127.0.0.1:8080/app#/admin/smoke']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke --in-browser refuses an app credential flag and reports a dead browser', async () => {
  const dir = dsDir({ slate: { appUrl: 'http://127.0.0.1:8080/app' } });
  try {
    const withToken = capture();
    const code1 = await smokeCli(
      [join(dir, 'widget.ds'), '--org', '10000000000', '--project', '1001', '--dc', 'in', '--url', 'http://127.0.0.1:8080/app', '--confirm', '--in-browser', '--cdp', '--auth-token', 'abc'],
      withToken.io,
      { browser: fakeBrowser({ states: ['done'] }) },
    );
    assert.equal(code1, 2);
    assert.match(withToken.stderr(), /session|auth|token/i);

    // A dead CDP endpoint fails with connection guidance, not a stack.
    const dead = capture();
    const code2 = await smokeCli(
      [join(dir, 'widget.ds'), '--org', '10000000000', '--project', '1001', '--dc', 'in', '--url', 'http://127.0.0.1:8080/app', '--confirm', '--in-browser', '--cdp', '--browser-cdp', 'http://127.0.0.1:1'],
      dead.io,
    );
    assert.equal(code2, 1);
    assert.match(dead.stderr(), /could not reach the browser over CDP/);
    // The fallback is the step that needs no browser automation.
    assert.match(dead.stdout(), /open http:\/\/127\.0\.0\.1:8080\/app#\/admin\/smoke in your own browser/);
    assert.doesNotMatch(dead.stdout() + dead.stderr(), /remote-debugging/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke --in-browser plan mode prints the plan and never opens a browser', async () => {
  const dir = dsDir();
  try {
    const browser = fakeBrowser({ states: ['done'] });
    const cap = capture();
    const code = await smokeCli([join(dir, 'widget.ds'), '--org', '10000000000', '--project', '1001', '--dc', 'in', '--in-browser', '--cdp'], cap.io, { browser });
    assert.equal(code, 0, cap.stderr());
    assert.match(cap.stdout(), /c2c smoke plan v2/);
    assert.match(cap.stdout(), /in-browser/);
    assert.equal(browser.opened.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * An owner-session page: answers location.origin, runs each in-page fetch
 * against a scripted function, and records every expression it was asked to
 * evaluate so a test can prove nothing read the session.
 */
function ownerPage(opts: { origin: string; probeStatus?: number; probeBody?: string; reply?: (req: { url: string; method: string; headers: Record<string, string>; body?: string; credentials?: string }) => { status: number; body: unknown } }) {
  const expressions: string[] = [];
  const requests: { url: string; method: string; headers: Record<string, string>; body?: string; credentials?: string }[] = [];
  const box = {
    opened: [] as string[],
    expressions,
    requests,
    closed: false,
    async open(url: string) {
      box.opened.push(url);
      return {
        async evaluate(expression: string) {
          expressions.push(expression);
          if (expression.includes('location.origin')) return opts.origin;
          return '';
        },
        async evaluateAsync(expression: string) {
          expressions.push(expression);
          const m = /fetch\(("(?:[^"\\]|\\.)*"),(\{.*\})\);return/.exec(expression);
          assert.ok(m, `unexpected page expression: ${expression}`);
          const req = { url: JSON.parse(m[1]!) as string, ...(JSON.parse(m[2]!) as { method: string; headers: Record<string, string>; body?: string; credentials?: string }) };
          requests.push(req);
          if (req.url.endsWith('/admin/smoke')) return { status: opts.probeStatus ?? 200, body: opts.probeBody ?? '{"ok":true,"mode":"Development","forms":1}' };
          const out = opts.reply ? opts.reply(req) : { status: 200, body: {} };
          return { status: out.status, body: JSON.stringify(out.body) };
        },
        async close() {
          box.closed = true;
        },
      };
    },
  };
  return box;
}

const FN_URL = 'https://widget-10000000000.development.example.test/server/c2c_api';
const OWNER_ARGS = (dir: string, report: string) => [join(dir, 'widget.ds'), '--org', '10000000000', '--project', '1001', '--dc', 'in', '--url', FN_URL, '--confirm', '--owner-session', '--cdp', '--report', report];

function ownerCapture() {
  const cap = capture({ X_ZC_CREDENTIAL_PATH: '/nonexistent/credential.json' });
  const io = cap.io as Io & { rest: unknown; fetch: unknown };
  const adminCalls: string[] = [];
  io.rest = async () => ({ status: 200, body: { data: { id: '1001', org_id: '10000000000' } } });
  io.fetch = async (url: string) => {
    adminCalls.push(url);
    return new Response(JSON.stringify({ status: 'success', data: [] }), { status: 200 });
  };
  return { ...cap, adminCalls };
}

test('smoke --owner-session sends every function call from inside the page and never reads the session', async () => {
  const dir = dsDir({ functions: { apiBase: FN_URL } });
  try {
    const browser = ownerPage({ origin: new URL(FN_URL).origin, reply: () => ({ status: 200, body: { data: { ROWID: '123' } } }) });
    const cap = ownerCapture();
    const report = join(dir, 'out', 'smoke.json');
    const code = await smokeCli(OWNER_ARGS(dir, report), cap.io, { browser, sleep: async () => {} });
    assert.ok(code === 0 || code === 1, `stdout:\n${cap.stdout()}\nstderr:\n${cap.stderr()}`);
    assert.deepEqual(browser.opened, [`${FN_URL}/`]);
    assert.ok(browser.requests.length >= 2, `the probe and at least one smoke call ran in the page\n${cap.stdout()}\n${cap.stderr()}`);
    for (const req of browser.requests) {
      assert.equal(new URL(req.url).origin, new URL(FN_URL).origin, 'only function calls run in the page');
      assert.equal(req.credentials, 'include', 'the browser attaches its own session');
      for (const name of Object.keys(req.headers)) assert.ok(!/^(cookie|authorization)$/i.test(name), `no ${name} header is sent from the CLI`);
    }
    // No expression touches cookies, storage, or credential state.
    for (const expr of browser.expressions) {
      assert.doesNotMatch(expr, /cookie|localStorage|sessionStorage|indexedDB|getCookies|Storage\.|Network\./i, expr);
    }
    assert.ok(cap.adminCalls.every((url) => new URL(url).origin !== new URL(FN_URL).origin), 'no function call bypassed the page');
    assert.match(cap.stdout(), /session bootstrap: the browser session carries the calls/);
    const written = JSON.parse(readFileSync(report, 'utf8')) as { version: string; session: string; ok: boolean; lines: string[] };
    assert.equal(written.version, 'c2c-smoke-report/1');
    assert.equal(written.session, 'owner');
    assert.equal(written.ok, code === 0);
    assert.doesNotMatch(JSON.stringify(written) + cap.stdout() + cap.stderr(), /\btoken\b.*:|Bearer|Zoho-oauthtoken|cookie [^:]/i);
    assert.equal(browser.closed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke --owner-session: not signed in is a blocker (exit 4, c2c-blocker line, report), never a fail', async () => {
  const dir = dsDir({ functions: { apiBase: FN_URL } });
  try {
    for (const browser of [
      ownerPage({ origin: new URL(FN_URL).origin, probeStatus: 401 }),
      // A sign-in redirect leaves the function origin.
      ownerPage({ origin: 'https://accounts.example.test' }),
    ]) {
      const cap = ownerCapture();
      const report = join(dir, 'blocked.json');
      const code = await smokeCli(OWNER_ARGS(dir, report), cap.io, { browser, sleep: async () => {} });
      assert.equal(code, 4, cap.stdout() + cap.stderr());
      assert.match(cap.stdout(), new RegExp(`^c2c-blocker: not-signed-in ${FN_URL.replace(/[.]/g, '\\.')}$`, 'm'));
      const written = JSON.parse(readFileSync(report, 'utf8')) as { ok: boolean; blocker: string };
      assert.equal(written.ok, false);
      assert.equal(written.blocker, `not-signed-in ${FN_URL}`);
      assert.equal(browser.closed, true);
    }
    // --owner-session with an app credential, or with --in-browser, is refused.
    const both = capture();
    assert.equal(await smokeCli([...OWNER_ARGS(dir, join(dir, 'x.json')), '--in-browser', '--cdp'], both.io, { browser: ownerPage({ origin: '' }) }), 2);
    const token = capture();
    assert.equal(await smokeCli([...OWNER_ARGS(dir, join(dir, 'x.json')), '--auth-token', 'abc'], token.io, { browser: ownerPage({ origin: '' }) }), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke --in-browser: a denied page is the not-signed-in blocker with a report; a finished run writes its report', async () => {
  const dir = dsDir({ slate: { appUrl: 'http://127.0.0.1:8080/app' } });
  try {
    const denied = capture();
    const report = join(dir, 'r', 'smoke.json');
    const args = [join(dir, 'widget.ds'), '--org', '10000000000', '--project', '1001', '--dc', 'in', '--url', 'http://127.0.0.1:8080/app', '--confirm', '--in-browser', '--cdp', '--report', report];
    assert.equal(await smokeCli(args, denied.io, { browser: fakeBrowser({ states: ['denied'] }) }), 4);
    assert.match(denied.stdout(), /^c2c-blocker: not-signed-in http:\/\/127\.0\.0\.1:8080\/app$/m);
    assert.equal((JSON.parse(readFileSync(report, 'utf8')) as { blocker: string }).blocker, 'not-signed-in http://127.0.0.1:8080/app');
    const done = capture();
    assert.equal(await smokeCli(args, done.io, { browser: fakeBrowser({ states: ['done'], lines: ['created 1, deleted 1, left 0'], json: RESULT_JSON }) }), 0);
    const written = JSON.parse(readFileSync(report, 'utf8')) as { ok: boolean; session: string; result: { version: string } };
    assert.equal(written.ok, true);
    assert.equal(written.session, 'app-user');
    assert.equal(written.result.version, 'c2c-smoke/1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke --in-browser binds --url to the deploy report app origin', async () => {
  const dir = dsDir();
  try {
    writeFileSync(join(dir, 'c2c-deploy-report.json'), `${JSON.stringify({ slate: { appUrl: 'https://deployed.example.test/app' } }, null, 2)}\n`);
    const browser = fakeBrowser({ states: ['done'], json: RESULT_JSON });
    // A --url on another origin is refused before the browser ever opens.
    const off = capture();
    const code1 = await smokeCli(
      [join(dir, 'widget.ds'), '--org', '10000000000', '--project', '1001', '--dc', 'in', '--url', 'https://other.example.test/app', '--confirm', '--in-browser', '--cdp'],
      off.io,
      { browser },
    );
    assert.equal(code1, 2);
    assert.match(off.stderr(), /app origin|does not match/i);
    assert.equal(browser.opened.length, 0);
    // Same origin as the report (any path on it) runs.
    const on = capture();
    const code2 = await smokeCli(
      [join(dir, 'widget.ds'), '--org', '10000000000', '--project', '1001', '--dc', 'in', '--url', 'https://deployed.example.test/elsewhere', '--confirm', '--in-browser', '--cdp'],
      on.io,
      { browser },
    );
    assert.equal(code2, 0, `stdout:\n${on.stdout()}\nstderr:\n${on.stderr()}`);
    assert.deepEqual(browser.opened, ['https://deployed.example.test/elsewhere#/admin/smoke']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke --owner-session: a 200 sign-in page reply to the status probe is the not-signed-in blocker, never a pass', async () => {
  const dir = dsDir({ functions: { apiBase: FN_URL } });
  try {
    for (const [label, probeBody] of [
      ['an HTML sign-in page', '<html><title>Sign in</title></html>'],
      ['JSON that is not the documented status shape', '{"ok":true}'],
    ] as const) {
      const browser = ownerPage({
        origin: new URL(FN_URL).origin,
        probeBody,
        // The endpoints would answer writes — only the probe guards this.
        reply: () => ({ status: 200, body: { wrote: true, values: { ROWID: '42' } } }),
      });
      const cap = ownerCapture();
      const report = join(dir, 'blocked.json');
      const code = await smokeCli(OWNER_ARGS(dir, report), cap.io, { browser, sleep: async () => {} });
      assert.equal(code, 4, `${label}\nstdout:\n${cap.stdout()}\nstderr:\n${cap.stderr()}`);
      assert.match(cap.stdout(), new RegExp(`^c2c-blocker: not-signed-in ${FN_URL.replace(/[.]/g, '\\.')}$`, 'm'), label);
      const written = JSON.parse(readFileSync(report, 'utf8')) as { ok: boolean; blocker: string };
      assert.equal(written.ok, false, label);
      assert.equal(written.blocker, `not-signed-in ${FN_URL}`, label);
      assert.equal(browser.closed, true, label);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke --owner-session: the documented status shape lets the run continue past the probe', async () => {
  const dir = dsDir({ functions: { apiBase: FN_URL } });
  try {
    const browser = ownerPage({
      origin: new URL(FN_URL).origin,
      reply: () => ({ status: 200, body: { wrote: true, values: { ROWID: '42' } } }),
    });
    const cap = ownerCapture();
    const code = await smokeCli(OWNER_ARGS(dir, join(dir, 'smoke.json')), cap.io, { browser, sleep: async () => {} });
    assert.notEqual(code, 4, `stdout:\n${cap.stdout()}\nstderr:\n${cap.stderr()}`);
    assert.ok(browser.requests.length >= 2, 'the probe plus real smoke calls ran');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke --owner-session: a 401 probe says the app domain needs a registered-user sign-in', async () => {
  const dir = dsDir({ functions: { apiBase: FN_URL } });
  try {
    // The probe tab holds no app session, so /admin/smoke answers 401 and the
    // blocker names the app-domain sign-in a person must do themselves.
    const browser = ownerPage({ origin: new URL(FN_URL).origin, probeStatus: 401, probeBody: '' });
    const cap = ownerCapture();
    const report = join(dir, 'blocked.json');
    const code = await smokeCli(OWNER_ARGS(dir, report), cap.io, { browser, sleep: async () => {} });
    assert.equal(code, 4, `stdout:\n${cap.stdout()}\nstderr:\n${cap.stderr()}`);
    assert.deepEqual(browser.opened, [`${FN_URL}/`]);
    assert.match(cap.stdout(), /^c2c-blocker: not-signed-in /m);
    assert.match(cap.stdout(), /not signed in on the app domain/);
    assert.match(cap.stdout(), /sign in at the app's own sign-in page on that domain as a user registered on the project/);
    assert.match(cap.stdout(), /a console sign-in is not an app session/);
    const written = JSON.parse(readFileSync(report, 'utf8')) as { blocker: string; lines: string[] };
    assert.equal(written.blocker, `not-signed-in ${FN_URL}`);
    assert.match(written.lines.join('\n'), /app domain/);
    assert.equal(browser.closed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke --owner-session: a CDP endpoint advertising an off-loopback websocket is refused before dialing', async () => {
  const dir = dsDir({ functions: { apiBase: FN_URL } });
  const srv = createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://203.0.113.9:9223/devtools/browser/evil' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try {
    const port = (srv.address() as { port: number }).port;
    const cap = ownerCapture();
    const code = await smokeCli(
      [...OWNER_ARGS(dir, join(dir, 'x.json')), '--browser-cdp', `http://127.0.0.1:${port}`],
      cap.io,
      { sleep: async () => {} },
    );
    assert.equal(code, 1, `stdout:\n${cap.stdout()}\nstderr:\n${cap.stderr()}`);
    assert.match(cap.stderr(), /loopback|websocket|devtools/i);
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke --in-browser drops a --url fragment before mounting the smoke route', async () => {
  const dir = dsDir({ slate: { appUrl: 'http://127.0.0.1:8080/app' } });
  try {
    // A trailing #fragment would otherwise eat the appended #/admin/smoke.
    const browser = fakeBrowser({ states: ['done'], json: RESULT_JSON });
    const cap = capture();
    const code = await smokeCli(
      [join(dir, 'widget.ds'), '--org', '10000000000', '--project', '1001', '--dc', 'in', '--url', 'http://127.0.0.1:8080/app#frag', '--confirm', '--in-browser', '--cdp'],
      cap.io,
      { browser },
    );
    assert.equal(code, 0, `stdout:\n${cap.stdout()}\nstderr:\n${cap.stderr()}`);
    assert.deepEqual(browser.opened, ['http://127.0.0.1:8080/app#/admin/smoke']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeSmoke: a browserSession still has to prove the session — a 200 non-JSON status reply stops the run', async () => {
  const { executeSmoke } = await import('../src/smoke.js');
  const res = await executeSmoke([{ kind: 'session', label: 'session' }], {
    fetch: async () => new Response('<html><title>Sign in</title></html>', { status: 200 }),
    base: FN_URL,
    auth: {},
    dc: 'in',
    catalystBase: 'https://api.example.test',
    browserSession: true,
  });
  assert.equal(res.ok, false);
  assert.equal(res.notSignedIn, true);
});

test('smoke --in-browser refuses a deploy report that carries no slate.appUrl', async () => {
  const dir = dsDir();
  try {
    // A found report without slate.appUrl cannot bind --url; proceeding would
    // silently unbind the app origin check.
    writeFileSync(join(dir, 'c2c-deploy-report.json'), `${JSON.stringify({ functions: { c2c_api: { url: 'https://example.test/server/c2c_api' } } }, null, 2)}\n`);
    const browser = fakeBrowser({ states: ['done'], json: RESULT_JSON });
    const cap = capture();
    const code = await smokeCli(
      [join(dir, 'widget.ds'), '--org', '10000000000', '--project', '1001', '--dc', 'in', '--url', 'https://deployed.example.test/app', '--confirm', '--in-browser', '--cdp'],
      cap.io,
      { browser },
    );
    assert.equal(code, 2, `stdout:\n${cap.stdout()}\nstderr:\n${cap.stderr()}`);
    assert.match(cap.stderr(), /slate\.appUrl/);
    assert.equal(browser.opened.length, 0, 'the browser never opens');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** An admin REST that proves project 1001 and answers the Slate app list with `apps`. */
function projectRest(apps: { id: string; name: string; domain?: string }[] | number) {
  const calls: string[] = [];
  const rest = async (call: { method: string; path: string }) => {
    calls.push(`${call.method} ${call.path}`);
    if (call.method === 'GET' && call.path === '/baas/v1/project/1001') return { status: 200, body: { data: { id: '1001', org_id: '10000000000' } } };
    if (call.method === 'GET' && call.path === '/slate/v1/project/1001/app') {
      if (typeof apps === 'number') return { status: apps, body: {} };
      return { status: 200, body: { data: apps } };
    }
    return { status: 404, body: {} };
  };
  return { rest, calls };
}

test('smoke --in-browser with no deploy report binds --url through the project Slate read', async () => {
  const dir = dsDir();
  try {
    // The project's Slate app list answers its served domain: a --url on that
    // origin runs, a --url on any other origin is refused before the browser
    // ever opens.
    const cap = capture();
    const proof = projectRest([{ id: '9', name: 'c2c-widget', domain: 'deployed.example.test' }]);
    cap.io.rest = proof.rest;
    const off = fakeBrowser({ states: ['done'], json: RESULT_JSON });
    const code1 = await smokeCli(
      [join(dir, 'widget.ds'), '--org', '10000000000', '--project', '1001', '--dc', 'in', '--url', 'https://other.example.test/app', '--confirm', '--in-browser', '--cdp'],
      cap.io,
      { browser: off },
    );
    assert.equal(code1, 2, `stdout:\n${cap.stdout()}\nstderr:\n${cap.stderr()}`);
    assert.match(cap.stderr(), /does not match|origin/i);
    assert.equal(off.opened.length, 0, 'the browser never opens');
    const on = capture();
    on.io.rest = proof.rest;
    const browser = fakeBrowser({ states: ['done'], json: RESULT_JSON });
    const code2 = await smokeCli(
      [join(dir, 'widget.ds'), '--org', '10000000000', '--project', '1001', '--dc', 'in', '--url', 'https://deployed.example.test/app', '--confirm', '--in-browser', '--cdp'],
      on.io,
      { browser },
    );
    assert.equal(code2, 0, `stdout:\n${on.stdout()}\nstderr:\n${on.stderr()}`);
    assert.deepEqual(browser.opened, ['https://deployed.example.test/app#/admin/smoke']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke --in-browser with no deploy report and an unreadable Slate URL refuses --url — never an arbitrary app', async () => {
  const dir = dsDir();
  try {
    for (const rest of [projectRest([]).rest, projectRest(503).rest, capture().io.rest]) {
      const cap = capture();
      cap.io.rest = rest;
      const browser = fakeBrowser({ states: ['done'], json: RESULT_JSON });
      const code = await smokeCli(
        [join(dir, 'widget.ds'), '--org', '10000000000', '--project', '1001', '--dc', 'in', '--url', 'https://other.example.test/app', '--confirm', '--in-browser', '--cdp'],
        cap.io,
        { browser },
      );
      assert.equal(code, 2, `stdout:\n${cap.stdout()}\nstderr:\n${cap.stderr()}`);
      assert.match(cap.stderr(), /cannot bind|bind|--url/i);
      assert.equal(browser.opened.length, 0, 'the browser never opens');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke --owner-session binds --url to the deploy report function origin — a foreign function is refused before any request', async () => {
  const FOREIGN = 'https://theirs-2.development.example.test/server/c2c_api';
  const dir = dsDir({ functions: { apiBase: FN_URL } });
  try {
    const browser = ownerPage({ origin: new URL(FOREIGN).origin });
    const cap = ownerCapture();
    const restCalls: string[] = [];
    const inner = cap.io.rest as (call: { method: string; path: string }) => Promise<{ status: number; body: unknown }>;
    cap.io.rest = async (call) => {
      restCalls.push(`${call.method} ${call.path}`);
      return inner(call);
    };
    const code = await smokeCli(
      [join(dir, 'widget.ds'), '--org', '10000000000', '--project', '1001', '--dc', 'in', '--url', FOREIGN, '--confirm', '--owner-session', '--cdp'],
      cap.io,
      { browser, sleep: async () => {} },
    );
    assert.equal(code, 2, `stdout:\n${cap.stdout()}\nstderr:\n${cap.stderr()}`);
    assert.match(cap.stderr(), /does not match|origin/i);
    assert.equal(browser.opened.length, 0, 'the browser never opens');
    assert.equal(browser.requests.length, 0, 'nothing is sent to the foreign function');
    assert.equal(restCalls.length, 0, 'the refusal runs before even the project read');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke --owner-session with no deploy report refuses --url — it cannot prove the function is this project', async () => {
  const dir = dsDir();
  try {
    const browser = ownerPage({ origin: new URL(FN_URL).origin });
    const cap = ownerCapture();
    const code = await smokeCli(OWNER_ARGS(dir, join(dir, 'x.json')), cap.io, { browser, sleep: async () => {} });
    assert.equal(code, 2, `stdout:\n${cap.stdout()}\nstderr:\n${cap.stderr()}`);
    assert.match(cap.stderr(), /cannot bind|deploy report|--url/i);
    assert.equal(browser.opened.length, 0, 'the browser never opens');
    assert.equal(browser.requests.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke --owner-session: a report whose apiBase is relative binds --url to the served app origin', async () => {
  // A deploy with apiBase '/server/c2c_api' serves the function on the app's own
  // domain; the report records only slate.appUrl, which is then the binding.
  const APP_URL = 'https://deployed.example.test/app';
  const dir = dsDir({ slate: { appUrl: APP_URL } });
  try {
    const appOrigin = new URL(APP_URL).origin;
    const browser = ownerPage({ origin: appOrigin, reply: () => ({ status: 200, body: { data: { ROWID: '123' } } }) });
    const cap = ownerCapture();
    const url = `${appOrigin}/server/c2c_api`;
    const code = await smokeCli(
      [join(dir, 'widget.ds'), '--org', '10000000000', '--project', '1001', '--dc', 'in', '--url', url, '--confirm', '--owner-session', '--cdp'],
      cap.io,
      { browser, sleep: async () => {} },
    );
    assert.notEqual(code, 2, `stdout:\n${cap.stdout()}\nstderr:\n${cap.stderr()}`);
    assert.ok(browser.opened.length > 0, 'the bound run opens the function origin');
    const off = ownerPage({ origin: new URL(FN_URL).origin });
    const cap2 = ownerCapture();
    const code2 = await smokeCli(
      [join(dir, 'widget.ds'), '--org', '10000000000', '--project', '1001', '--dc', 'in', '--url', FN_URL, '--confirm', '--owner-session', '--cdp'],
      cap2.io,
      { browser: off, sleep: async () => {} },
    );
    assert.equal(code2, 2, `stdout:\n${cap2.stdout()}\nstderr:\n${cap2.stderr()}`);
    assert.equal(off.opened.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke --owner-session refuses a deploy report that binds neither apiBase nor app origin', async () => {
  const dir = dsDir({ functions: { c2c_api: { url: FN_URL } } });
  try {
    const browser = ownerPage({ origin: new URL(FN_URL).origin });
    const cap = ownerCapture();
    const code = await smokeCli(OWNER_ARGS(dir, join(dir, 'x.json')), cap.io, { browser, sleep: async () => {} });
    assert.equal(code, 2, `stdout:\n${cap.stdout()}\nstderr:\n${cap.stderr()}`);
    assert.equal(browser.opened.length, 0, 'the browser never opens');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
