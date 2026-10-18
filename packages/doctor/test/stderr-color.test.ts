import assert from 'node:assert/strict';
import { test } from 'node:test';
import { doctorSpawn } from '../src/index.js';

test('doctor child spawn suppresses Node color conflict warning', async () => {
  const result = await doctorSpawn(
    process.execPath,
    ['-e', "process.stdout.write(JSON.stringify({force:process.env.FORCE_COLOR,noColor:process.env.NO_COLOR}))"],
    { cwd: process.cwd(), env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: '1' } },
  );
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.doesNotMatch(result.stderr, /FORCE_COLOR|NO_COLOR|color/i);
});
