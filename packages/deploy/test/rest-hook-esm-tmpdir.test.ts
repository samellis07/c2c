/**
 * The REST/token hooks are written under os.tmpdir(). When TMPDIR (or any
 * parent) holds a package.json with "type":"module", Node loads a .js hook
 * as ESM, `require` fails, and the child dies before writing a result line.
 * The hooks are .cjs files so their module type never depends on the
 * environment, and a child that prints no result line reports its exit code
 * and first stderr line — never "refused the path".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { catalystRestCall, readCliAccessToken } from '../src/rest.js';

const ORG = '10000000000';
const PROJECT = '10000000000315013';
const TOKEN = 'c2c-fake-token-7d3a9f2e';

const FAKE_API = `'use strict';
class FakeAPI {
  constructor() {}
  async get() { return { statusCode: 200, body: { data: { id: process.env.C2C_FAKE_PROJECT } } }; }
}
module.exports = { default: FakeAPI };
`;

const FAKE_CREDENTIAL = `'use strict';
module.exports = { default: {
  getAccessToken: async () => process.env.C2C_FAKE_TOKEN || '',
  init: () => ({ accessToken: process.env.C2C_FAKE_TOKEN || null }),
} };
`;

const FAKE_CONFIG_STORE = `'use strict';
module.exports = { default: { get: (key, fallback) => (key === 'in.credential' ? 'stored-credential' : fallback) } };
`;

const FAKE_DC = `'use strict';
module.exports = { getActiveDC: () => 'in' };
`;

/** A fake catalyst install: <dir>/bin/catalyst + lib beside it. */
function fakeCatalyst(binSource: string, dir: string): NodeJS.ProcessEnv {
  writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}');
  const binDir = join(dir, 'bin');
  for (const sub of ['internal', 'authentication', 'util_modules']) mkdirSync(join(binDir, sub), { recursive: true });
  const bin = join(binDir, 'catalyst');
  writeFileSync(bin, binSource);
  chmodSync(bin, 0o755);
  writeFileSync(join(binDir, 'internal', 'api.js'), FAKE_API);
  writeFileSync(join(binDir, 'authentication', 'credential.js'), FAKE_CREDENTIAL);
  writeFileSync(join(binDir, 'util_modules', 'config-store.js'), FAKE_CONFIG_STORE);
  writeFileSync(join(binDir, 'util_modules', 'dc.js'), FAKE_DC);
  return {
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
    C2C_FAKE_TOKEN: TOKEN,
    C2C_FAKE_PROJECT: PROJECT,
  };
}

/**
 * Run `fn` with process-level TMPDIR pointing at a directory that contains
 * {"type":"module"}: mkdtempSync reads os.tmpdir() in this process, so the
 * hook file lands under the ESM package.json.
 */
async function withEsmTmpdir<T>(fn: (esmTmp: string) => Promise<T>): Promise<T> {
  const esmTmp = mkdtempSync(join(tmpdir(), 'c2c-esm-tmpdir-'));
  writeFileSync(join(esmTmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = esmTmp;
  try {
    return await fn(esmTmp);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
}

test('the REST hook runs under an ESM TMPDIR', async () => {
  // The fake install stays outside the ESM dir: only the hook file must land in it.
  const env = fakeCatalyst(`'use strict';\n`, mkdtempSync(join(tmpdir(), 'c2c-fake-')));
  await withEsmTmpdir(async () => {
    const res = await catalystRestCall(env, ORG, PROJECT, { method: 'GET', path: `/baas/v1/project/${PROJECT}` });
    assert.deepEqual(res, { status: 200, body: { data: { id: PROJECT } } });
  });
});

test('the token hook runs under an ESM TMPDIR', async () => {
  const env = fakeCatalyst(`'use strict';\n`, mkdtempSync(join(tmpdir(), 'c2c-fake-')));
  await withEsmTmpdir(async () => {
    assert.equal(await readCliAccessToken(env, ORG, PROJECT), TOKEN);
  });
});

test('a REST child that prints no result line reports how it died and its first stderr line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-rest-fail-'));
  const env = fakeCatalyst(
    `'use strict';\nrequire('fs').writeSync(2, 'catalyst exploded\\n');\nprocess.kill(process.pid, 'SIGKILL');\n`,
    dir,
  );
  await assert.rejects(
    catalystRestCall(env, ORG, PROJECT, { method: 'GET', path: `/baas/v1/project/${PROJECT}` }),
    (err: Error) => {
      assert.match(err.message, /SIGKILL/);
      assert.match(err.message, /catalyst exploded/);
      assert.ok(!/refused the path/.test(err.message), `misleading error: ${err.message}`);
      return true;
    },
  );
});

test('a token child that prints nothing reports its exit code and first stderr line', async () => {
  const env = fakeCatalyst(
    `'use strict';\nrequire('fs').writeSync(2, '\\nno credential store\\nsecond line\\n');\nprocess.kill(process.pid, 'SIGKILL');\n`,
    mkdtempSync(join(tmpdir(), 'c2c-token-fail-')),
  );
  await assert.rejects(readCliAccessToken(env, ORG, PROJECT), (err: Error) => {
    assert.match(err.message, /killed by SIGKILL: no credential store\)$/);
    return true;
  });
});

test('child stderr secrets (Zoho OAuth token, Bearer header, refresh_token JSON, hex/base64 runs, env dumps) never leak into REST or token errors', async () => {
  const zohoToken = '1000.a1b2c3d4e5f60718293a4b5c6d7e8f90.9f8e7d6c5b4a39281706f5e4d3c2b1a0';
  const zohoHeaderToken = '1000.zohoheadersecret9876543210abcdef';
  const bearerToken = 'bearer-planted-secret-987654321';
  const refreshToken = 'rt-planted-secret-654321';
  const accessToken = 'at-planted-secret-111222';
  const clientSecret = 'cs-planted-secret-333444';
  const plantedToken = 'c2c-fake-token-PLANTED-123456';
  const hexRun = 'deadbeef0123456789abcdef01234567';
  const b64Run = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=';

  const stderrLines = [
    `catalyst auth failed: Zoho-oauthtoken ${zohoHeaderToken} raw ${zohoToken} Authorization: Bearer ${bearerToken} {"refresh_token":"${refreshToken}","access_token":"${accessToken}","client_secret":"${clientSecret}"} ?access_token=${accessToken}&client_secret=${clientSecret} ${plantedToken} ${hexRun} ${b64Run}`,
    `planted-only: ${plantedToken}`,
  ];

  for (const line of stderrLines) {
    const env = fakeCatalyst(
      `'use strict';\nrequire('fs').writeSync(2, ${JSON.stringify(line + '\n')});\nprocess.kill(process.pid, 'SIGKILL');\n`,
      mkdtempSync(join(tmpdir(), 'c2c-redact-stderr-')),
    );
    for (const call of [
      () => catalystRestCall(env, ORG, PROJECT, { method: 'GET', path: `/baas/v1/project/${PROJECT}` }),
      () => readCliAccessToken(env, ORG, PROJECT),
    ]) {
      await assert.rejects(call, (err: Error) => {
        for (const canary of [
          zohoToken,
          zohoHeaderToken,
          bearerToken,
          refreshToken,
          accessToken,
          clientSecret,
          plantedToken,
          'PLANTED',
          hexRun,
          b64Run,
        ]) {
          assert.ok(!err.message.includes(canary), `stderr secret leaked (${canary}): ${err.message}`);
        }
        return true;
      });
    }
  }
});

test('every credential-named key syntax and value length is redacted in REST and token errors', async () => {
  const keys = [
    'secret', 'token', 'password', 'passwd', 'pwd', 'credential', 'credentials',
    'auth', 'authorization', 'api_key', 'api-key', 'apikey', 'session', 'cookie',
    'private_key', 'private-key', 'signature',
  ];
  const forms = [
    (key: string, value: string) => `${key}=${value}`,
    (key: string, value: string) => `https://example.test/path?${key}=${value}`,
    (key: string, value: string) => `${key}: ${value}`,
    (key: string, value: string) => `{"${key}": "${value}"}`,
    (key: string, value: string) => `${key}='${value}'`,
  ];
  for (const key of keys) {
    for (const [formIndex, form] of forms.entries()) {
      for (const long of [false, true]) {
        const canary = `short-${key.replace(/\W/g, '')}-${formIndex}`;
        const value = long ? `${canary}-${'L'.repeat(600)}` : canary;
        const line = `credential diagnostic: ${form(key, value)}`;
        const env = fakeCatalyst(
          `'use strict';\nrequire('fs').writeSync(2, ${JSON.stringify(line + '\\n')});\nprocess.kill(process.pid, 'SIGKILL');\n`,
          mkdtempSync(join(tmpdir(), 'c2c-key-redact-')),
        );
        for (const call of [
          () => catalystRestCall(env, ORG, PROJECT, { method: 'GET', path: `/baas/v1/project/${PROJECT}` }),
          () => readCliAccessToken(env, ORG, PROJECT),
        ]) {
          await assert.rejects(call, (err: Error) => {
            assert.ok(!err.message.includes(canary), `${key} form ${formIndex} leaked ${long ? 'long' : 'short'} value: ${err.message}`);
            return true;
          });
        }
      }
    }
  }
});

test('env dumps in child stderr are skipped while a benign line is preserved and long excerpts are capped', async () => {
  const envSecret = 'env-dump-canary-secret-999';
  const env = fakeCatalyst(
    `'use strict';\nrequire('fs').writeSync(2, 'C2C_FAKE_TOKEN=${envSecret}\\n{"PATH":"/usr/bin","C2C_SECRET":"${envSecret}"}\\ncatalyst gateway unreachable\\n');\nprocess.kill(process.pid, 'SIGKILL');\n`,
    mkdtempSync(join(tmpdir(), 'c2c-env-dump-')),
  );
  for (const call of [
    () => catalystRestCall(env, ORG, PROJECT, { method: 'GET', path: `/baas/v1/project/${PROJECT}` }),
    () => readCliAccessToken(env, ORG, PROJECT),
  ]) {
    await assert.rejects(call, (err: Error) => {
      assert.ok(!err.message.includes(envSecret), `env dump leaked: ${err.message}`);
      assert.ok(!err.message.includes('C2C_FAKE_TOKEN'), `env key leaked: ${err.message}`);
      assert.match(err.message, /catalyst gateway unreachable/);
      return true;
    });
  }

  const longBenign = `benign error prefix ${'x'.repeat(500)}`;
  const longEnv = fakeCatalyst(
    `'use strict';\nrequire('fs').writeSync(2, ${JSON.stringify(longBenign + '\n')});\nprocess.kill(process.pid, 'SIGKILL');\n`,
    mkdtempSync(join(tmpdir(), 'c2c-long-stderr-')),
  );
  await assert.rejects(readCliAccessToken(longEnv, ORG, PROJECT), (err: Error) => {
    assert.match(err.message, /benign error prefix/);
    assert.ok(err.message.length <= 260, `stderr excerpt was not capped: length ${err.message.length}`);
    return true;
  });
});

test('percent-encoded keys (single, double %2563, uppercase hex, malformed %), escaped quotes in JSON values, and nested JSON objects never leak in REST or token errors', async () => {
  const cases: { line: string; canaries: string[]; preserved?: RegExp }[] = [
    {
      line: 'credential diagnostic: %63redential=CANARY-URLENCODED-KEY',
      canaries: ['CANARY-URLENCODED-KEY'],
    },
    {
      line: 'credential diagnostic: {"password":"part\\"CANARY-JSON-ESCAPED-QUOTE"}',
      canaries: ['CANARY-JSON-ESCAPED-QUOTE', 'part"'],
    },
    {
      line: 'credential diagnostic: {"password":"part\\\\"CANARY-JSON-ESCAPED-QUOTE"}',
      canaries: ['CANARY-JSON-ESCAPED-QUOTE'],
    },
    {
      line: 'credential diagnostic: %2563redential=CANARY-DOUBLE-ENCODED-KEY',
      canaries: ['CANARY-DOUBLE-ENCODED-KEY'],
    },
    {
      line: 'credential diagnostic: %25%36%33redential=CANARY-SPLIT-DOUBLE-ENCODED',
      canaries: ['CANARY-SPLIT-DOUBLE-ENCODED'],
    },
    {
      line: 'credential diagnostic: %43REDENTIAL=CANARY-UPPER-HEX-KEY&%2543redential=CANARY-DOUBLE-UPPER-HEX',
      canaries: ['CANARY-UPPER-HEX-KEY', 'CANARY-DOUBLE-UPPER-HEX'],
    },
    {
      line: 'credential diagnostic: %ZZ%63redential=CANARY-MALFORMED-PERCENT%ZZ%',
      canaries: ['CANARY-MALFORMED-PERCENT'],
    },
    {
      line: 'credential diagnostic: {"outer":{"inner":{"password":"part\\"CANARY-NESTED-JSON","%63redential":"CANARY-NESTED-PCT","%2563redential":"CANARY-NESTED-DBL"},"credential":{"leaf":"CANARY-SECRET-SUBTREE"},"status_code":404}}',
      canaries: ['CANARY-NESTED-JSON', 'CANARY-NESTED-PCT', 'CANARY-NESTED-DBL', 'CANARY-SECRET-SUBTREE'],
      preserved: /"status_code":404/,
    },
    {
      line: 'HTTP 401 GET /baas/v1/project/123: error_code=INVALID_TOKEN %65rror_code=INVALID_INPUT password="part\\"CANARY-KV-ESCAPED"',
      canaries: ['CANARY-KV-ESCAPED'],
      preserved: /HTTP 401 GET \/baas\/v1\/project\/123: error_code=INVALID_TOKEN error_code=INVALID_INPUT/,
    },
  ];

  for (const { line, canaries, preserved } of cases) {
    const env = fakeCatalyst(
      `'use strict';\nrequire('fs').writeSync(2, ${JSON.stringify(line + '\n')});\nprocess.kill(process.pid, 'SIGKILL');\n`,
      mkdtempSync(join(tmpdir(), 'c2c-r3-redact-')),
    );
    for (const call of [
      () => catalystRestCall(env, ORG, PROJECT, { method: 'GET', path: `/baas/v1/project/${PROJECT}` }),
      () => readCliAccessToken(env, ORG, PROJECT),
    ]) {
      await assert.rejects(call, (err: Error) => {
        for (const canary of canaries) {
          assert.ok(!err.message.includes(canary), `stderr secret leaked (${canary}) for line ${line}: ${err.message}`);
        }
        if (preserved) assert.match(err.message, preserved);
        return true;
      });
    }
  }
});

