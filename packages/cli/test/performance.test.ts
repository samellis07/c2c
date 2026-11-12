import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseFile } from '../../core/src/parse.js';
import { generate } from '../../deluge/src/generate.js';
import { planCli } from '../../deploy/src/offline-plan.js';
import type { Io } from '../../deploy/src/cli.js';
import { analyze, analyzeAsJson } from '../src/analyze.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const largest = path.join(root, 'fixtures/redistributable/freight-forwarding/Creator_app_source_code.ds');

function synthetic200(): string {
  const forms = Array.from({ length: 200 }, (_, i) => `form Form_${String(i + 1).padStart(3, '0')}\n{\n  Name\n  (\n    type = text\n  )\n  Amount\n  (\n    type = number\n  )\n}`).join('\n');
  return `application "Synthetic_200_Forms"\n{\n forms\n {\n${forms}\n }\n}\n`;
}

function filesDigest(dir: string): string {
  const hash = createHash('sha256');
  const visit = (at: string, prefix: string) => {
    for (const name of readdirSync(at).sort()) {
      const full = path.join(at, name);
      const relative = path.posix.join(prefix, name);
      let content: Buffer | undefined;
      try {
        content = readFileSync(full);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EISDIR') throw error;
      }
      if (content === undefined) visit(full, relative);
      else hash.update(relative).update('\0').update(content).update('\0');
    }
  };
  visit(dir, '');
  return hash.digest('hex');
}

const refuse = async (): Promise<never> => { throw new Error('unexpected network/process call in offline plan'); };
const io: Io = { stderr: () => undefined, stdout: () => undefined, env: {}, spawn: refuse, fetch: refuse };

test('generate, plan and analyze stay deterministic within large-app time and memory budgets', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'c2c-perf-large-app-'));
  const syntheticPath = path.join(temp, 'synthetic-200.ds');
  writeFileSync(syntheticPath, synthetic200());
  const started = performance.now();
  try {
    for (const target of [largest, syntheticPath]) {
      const app = parseFile(target).ir;
      const firstFiles = generate(app).files;
      const secondFiles = generate(app).files;
      assert.equal(createHash('sha256').update(JSON.stringify(firstFiles)).digest('hex'), createHash('sha256').update(JSON.stringify(secondFiles)).digest('hex'));

      const firstAnalysis = analyzeAsJson(analyze(app));
      const secondAnalysis = analyzeAsJson(analyze(app));
      assert.equal(firstAnalysis, secondAnalysis);

      const firstPlan = path.join(temp, `plan-${path.basename(target)}-a`);
      const secondPlan = path.join(temp, `plan-${path.basename(target)}-b`);
      assert.equal(await planCli([target, '--out', firstPlan, '--dc', 'in'], io), 0);
      assert.equal(await planCli([target, '--out', secondPlan, '--dc', 'in'], io), 0);
      assert.equal(filesDigest(firstPlan), filesDigest(secondPlan));
    }
    const elapsedMs = performance.now() - started;
    const peak = process.resourceUsage().maxRSS;
    const peakBytes = process.platform === 'darwin' ? peak : peak * 1024;
    assert.ok(elapsedMs < 180_000, `performance budget exceeded: ${Math.round(elapsedMs)}ms > 180000ms`);
    assert.ok(peakBytes < 2 * 1024 ** 3, `peak RSS budget exceeded: ${Math.round(peakBytes / 1024 / 1024)}MiB > 2048MiB`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
