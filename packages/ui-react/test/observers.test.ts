/**
 * The generated app boots into whatever document it is handed — including a
 * jsdom document under a scoring or test harness. jsdom ships no
 * ResizeObserver or IntersectionObserver, and a field control that constructs
 * one (the choice widgets' measuring code) then throws during render and the
 * whole app unmounts. ensureObservers installs never-firing stand-ins on the
 * boot document's own realm, only where the realm lacks them.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';
import { TEMPLATE_DIR } from '../src/index.js';

interface Observers {
  ensureObservers(view: object): void;
}

async function load(): Promise<{ dir: string; runtime: Observers }> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-observers-'));
  const source = readFileSync(join(TEMPLATE_DIR, 'lib/c2c-ui/runtime/observers.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: 'observers.ts',
  }).outputText;
  writeFileSync(join(dir, 'observers.mjs'), js);
  return { dir, runtime: (await import(pathToFileURL(join(dir, 'observers.mjs')).href)) as Observers };
}

test('a realm without layout observers gains never-firing stand-ins', async () => {
  const { dir, runtime } = await load();
  try {
    const view = {} as Record<string, any>;
    runtime.ensureObservers(view);
    for (const name of ['ResizeObserver', 'IntersectionObserver']) {
      assert.equal(typeof view[name], 'function', `${name} installed`);
      const observer = new view[name](() => {});
      observer.observe({});
      observer.unobserve({});
      observer.disconnect();
      assert.deepEqual(observer.takeRecords(), []);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a realm with real observers keeps them', async () => {
  const { dir, runtime } = await load();
  try {
    class Native {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const view = { ResizeObserver: Native, IntersectionObserver: Native } as Record<string, any>;
    runtime.ensureObservers(view);
    assert.equal(view.ResizeObserver, Native);
    assert.equal(view.IntersectionObserver, Native);
    // One missing observer is patched alone.
    const partial = { ResizeObserver: Native } as Record<string, any>;
    runtime.ensureObservers(partial);
    assert.equal(partial.ResizeObserver, Native);
    assert.equal(typeof partial.IntersectionObserver, 'function');
    assert.notEqual(partial.IntersectionObserver, Native);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
