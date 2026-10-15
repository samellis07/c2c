/**
 * The shell's meta Content-Security-Policy allows no inline script. The Slate
 * build keeps it in dist/index.html. `npm run dev` serves the Fast Refresh
 * preamble that @vitejs/plugin-react injects as an inline module script, so
 * the serve-only c2c plugin drops the meta from the dev HTML.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { TEMPLATE_DIR, generateReactApp, writeReactApp } from '../src/index.js';

const modules = join(TEMPLATE_DIR, 'node_modules');
const haveBuild = existsSync(join(modules, '.bin', 'vite'));
const skip = haveBuild ? false : 'template dependencies are not installed (npm ci --prefix packages/ui-react/template)';

const DS = 'application "Csp Probe"\n{\n\tform Orders\n\t{\n\t\tName\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t}\n}\n';
const CSP = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i;
const ORIGIN = 'https://c2c-widget-1001.development.catalystserverless.in';

function withApp(run: (out: string) => Promise<void>): Promise<void> {
  const out = mkdtempSync(join(tmpdir(), 'c2c-dev-csp-'));
  writeReactApp(out, generateReactApp(deriveIr(parse(DS)), { auth: false, apiBase: `${ORIGIN}/server/c2c_api` }));
  symlinkSync(modules, join(out, 'node_modules'), 'dir');
  return run(out).finally(() => rmSync(out, { recursive: true, force: true }));
}

test('the built index.html keeps the strict shell CSP', { skip }, async () => {
  await withApp(async (out) => {
    const source = CSP.exec(readFileSync(join(out, 'index.html'), 'utf8'))?.[1];
    assert.ok(source, 'the source shell carries the CSP meta');
    const build = spawnSync(join(modules, '.bin', 'vite'), ['build', '--logLevel', 'error'], { cwd: out, encoding: 'utf8' });
    assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
    const html = readFileSync(join(out, 'dist/index.html'), 'utf8');
    const built = CSP.exec(html)?.[1];
    assert.equal(built, source, 'the build copies the policy unchanged');
    assert.match(built!, /script-src 'self' https:\/\/static\.zohocdn\.com;/);
    assert.doesNotMatch(built!, /script-src[^;]*'unsafe-(inline|eval)'/);
    assert.match(built!, new RegExp(`connect-src 'self' ${ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};`));
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'the built shell has no inline script');
  });
});

test('the dev server HTML carries the Fast Refresh preamble and no CSP that would block it', { skip }, async () => {
  await withApp(async (out) => {
    const vite = (await import(pathToFileURL(join(modules, 'vite/dist/node/index.js')).href)) as {
      createServer(config: object): Promise<{ transformIndexHtml(url: string, html: string): Promise<string>; close(): Promise<void> }>;
    };
    const server = await vite.createServer({
      root: out,
      configFile: join(out, 'vite.config.ts'),
      logLevel: 'error',
      appType: 'custom',
      server: { middlewareMode: true, ws: false, watch: null },
    });
    try {
      const html = await server.transformIndexHtml('/', readFileSync(join(out, 'index.html'), 'utf8'));
      assert.match(html, /<script type="module">[^<]*injectIntoGlobalHook/, 'plugin-react injects its inline preamble');
      assert.doesNotMatch(html, /Content-Security-Policy/i, 'no meta CSP blocks the inline preamble in dev');
      assert.match(html, /name="referrer" content="same-origin"/);
    } finally {
      await server.close();
    }
  });
});
