/**
 * Every pull request runs the test suite and the determinism gate.
 *
 * GitHub names a matrix job "<job id> (<matrix value>)" when the job sets
 * no `name:`. Those strings are the check-run names a merge waits on.
 * The Deluge language tests live in this repository (`dist/deluge/test`)
 * and run in the same job. There is no separate package workflow.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REQUIRED = ['test (20.20.1)', 'test (22)', 'gates'];

function topBlocks(text) {
  const blocks = new Map();
  let key = null;
  let buf = [];
  const flush = () => {
    if (key) blocks.set(key, buf);
  };
  for (const line of text.split('\n')) {
    if (key === null) {
      const first = /^([A-Za-z0-9_-]+):/.exec(line);
      if (first) {
        key = first[1];
        buf = [];
      }
      continue;
    }
    if (/^[A-Za-z0-9_-]+:/.test(line)) {
      flush();
      key = line.slice(0, line.indexOf(':'));
      buf = [];
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

function jobsFrom(block) {
  const jobs = new Map();
  let id = null;
  let buf = [];
  const flush = () => {
    if (id) jobs.set(id, buf);
  };
  for (const line of block) {
    const start = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (start) {
      flush();
      id = start[1];
      buf = [];
      continue;
    }
    if (id) buf.push(line);
  }
  flush();
  return jobs;
}

function jobTitle(lines) {
  for (const line of lines) {
    if (/^ {4}steps:/.test(line)) break;
    const named = /^ {4}name:\s*(.+?)\s*$/.exec(line);
    if (named) return named[1].replace(/^['"]|['"]$/g, '');
  }
  return null;
}

function nodeMatrix(lines) {
  for (const line of lines) {
    const listed = /node-version:\s*\[([^\]]+)\]/.exec(line);
    if (!listed) continue;
    return listed[1].split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, ''));
  }
  return [];
}

function checkNames(id, lines) {
  const title = jobTitle(lines) || id;
  const matrix = nodeMatrix(lines);
  if (matrix.length === 0) return [title];
  return matrix.map((value) => `${title} (${value})`);
}

function runBodies(lines) {
  const runs = [];
  for (let i = 0; i < lines.length; i++) {
    const one = /^ {8}run: ([^|].*)$/.exec(lines[i]);
    if (one) {
      runs.push(one[1].trim());
      continue;
    }
    if (!/^ {8}run: \|$/.test(lines[i])) continue;
    const chunk = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^ {8}\S/.test(lines[j]) || /^ {6}- /.test(lines[j]) || /^ {4}\S/.test(lines[j])) break;
      chunk.push(lines[j]);
    }
    runs.push(chunk.join('\n'));
  }
  return runs;
}

function triggers(block) {
  return block
    .map((line) => /^ {2}([A-Za-z0-9_-]+):/.exec(line))
    .filter(Boolean)
    .map((match) => match[1]);
}

test('pull requests run the suite and the determinism gate under stable check names', () => {
  const ci = readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8');
  const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const listed = readFileSync(path.join(repo, 'scripts/test-files.txt'), 'utf8');
  const blocks = topBlocks(ci);
  const jobs = jobsFrom(blocks.get('jobs') || []);

  assert.equal(pkg.scripts.check, 'npm test && bash tools/determinism-gate.sh');
  assert.match(pkg.scripts.test, /scripts\/run-tests\.mjs --list scripts\/test-files\.txt/);
  assert.match(listed, /^dist\/deluge\/test$/m);

  assert.deepEqual(triggers(blocks.get('on')), ['pull_request', 'push', 'workflow_dispatch']);

  const testJob = jobs.get('test');
  const gatesJob = jobs.get('gates');
  assert.ok(testJob, 'ci.yml has a test job');
  assert.ok(gatesJob, 'ci.yml has a gates job');
  assert.equal(jobTitle(testJob), null);
  assert.equal(jobTitle(gatesJob), null);
  assert.deepEqual([...checkNames('test', testJob), ...checkNames('gates', gatesJob)], REQUIRED);
  assert.match(ci, /Required check-run names: test \(20\.20\.1\), test \(22\), gates\./);

  const runs = runBodies(testJob).join('\n');
  assert.match(runs, /^npm run check$/m);
  assert.match(runs, /^npm run determinism:check$/m);
  assert.equal(/C2C_FIXTURES_DIR/.test(testJob.join('\n')), false);
  assert.equal(/C2C_GALLERY_DIR/.test(testJob.join('\n')), false);
});
