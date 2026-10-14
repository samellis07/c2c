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
