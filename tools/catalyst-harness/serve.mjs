#!/usr/bin/env node
/**
 * Offline Catalyst harness for a `c2c deploy --out <dir>` tree. 127.0.0.1 only.
 *
 *   node tools/catalyst-harness/serve.mjs --dir <deploy-out> [--port 4173] [--live]
 *
 * It loads functions/c2c_api the way Catalyst runs an Advanced I/O function:
 * catalyst-config.json's env_variables go into process.env, execution.main is
 * required, and every /server/c2c_api/... request is passed to that export as
 * (req, res). require('zcatalyst-sdk-node') resolves to fake-zcatalyst-sdk-node.cjs
 * (in-memory Data Store and ZCQL subset); nothing is written into the tree.
 * --live sets C2C_DEPLOY_MODE=live, the value a confirmed deploy writes.
 *
 * Slate files are served from slate/. The harness serves its own c2c-config.js
 * (same-origin API base, no Catalyst Web SDK) and stands in for Catalyst
 * Authentication: loading a page sets a session cookie for one App Administrator
 * user. A request without that cookie has no current user (401).
 *
 * It also stands in for the admin-scope Data Store REST surface a smoke run's
 * read-back and cleanup use: POST /baas/v1/project/<id>/query answers the fake
 * SDK's ZCQL subset (SELECT * … plus DELETE FROM … → {"DELETED_ROWS_COUNT":n}).
 *
 * GET /__state dumps tables and SDK calls. GET /__exit stops the server.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const dir = resolve(opt('--dir', '.'));
const port = Number(opt('--port', '4173'));
const pidFile = opt('--pid-file', '');
const here = dirname(fileURLToPath(import.meta.url));
const fakeSdk = join(here, 'fake-zcatalyst-sdk-node.cjs');

const fnDir = join(dir, 'functions/c2c_api');
const config = JSON.parse(readFileSync(join(fnDir, 'catalyst-config.json'), 'utf8'));
for (const [key, value] of Object.entries(config.deployment.env_variables || {})) process.env[key] = String(value);
if (args.includes('--live')) process.env.C2C_DEPLOY_MODE = 'live';
const functionName = config.deployment.name;

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveFake(request, ...rest) {
  if (request === 'zcatalyst-sdk-node') return fakeSdk;
  return originalResolve.call(this, request, ...rest);
};
const require = createRequire(import.meta.url);
const sdk = require(fakeSdk);
const entry = require(join(fnDir, config.execution.main));

const SESSION = 'harness-admin';
sdk.setSession(SESSION, { user_id: '1001', email_id: 'admin@example.test', role_details: { role_name: 'App Administrator' } });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const path = url.pathname;
  if (path === '/__exit') {
    res.end('bye\n');
    setTimeout(() => process.exit(0), 50);
    return;
  }
  if (path === '/__state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(sdk.state(), null, 2));
    return;
  }
  if (/^\/baas\/v1\/project\/\d+\/query$/.test(path) && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      const data = await sdk.executeZCQLQuery(String(JSON.parse(raw || '{}').query ?? ''));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', data }));
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'failure', error: String(err && err.message) }));
    }
    return;
  }
  if (path === `/server/${functionName}` || path.startsWith(`/server/${functionName}/`)) {
    try {
      await entry(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'entry threw', message: String(err && err.message) }));
      }
    }
    return;
  }
  if (path === '/c2c-config.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(`globalThis.C2C_API_BASE = ${JSON.stringify(`/server/${functionName}`)};\n`);
    return;
  }
  const rel = path === '/' ? 'index.html' : normalize(decodeURIComponent(path)).replace(/^[/\\]+/, '');
  const file = join(dir, 'slate', rel);
  if (!file.startsWith(join(dir, 'slate')) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const headers = { 'content-type': TYPES[extname(file)] || 'application/octet-stream' };
  if (rel === 'index.html') headers['set-cookie'] = `c2c-harness-session=${SESSION}; Path=/; HttpOnly; SameSite=Lax`;
  res.writeHead(200, headers);
  res.end(readFileSync(file));
});

server.listen(port, '127.0.0.1', () => {
  if (pidFile) writeFileSync(pidFile, `${process.pid}\n`);
  process.stdout.write(`c2c catalyst harness pid ${process.pid} on http://127.0.0.1:${port} (mode ${process.env.C2C_DEPLOY_MODE || 'from c2c-deploy.json'})\n`);
});
