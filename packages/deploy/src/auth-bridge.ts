/**
 * functions/c2c_auth: the token bridge. Slate (*.onslate.*) serves no /baas
 * routes, so the Web SDK's generateAuthToken cannot run there — the served
 * /__catalyst/sdk/init.js leaves api_domain empty. The function host serves
 * /baas, init.js and hosted login as first party, so this Advanced I/O
 * function serves one static page that runs generateAuthToken on its own
 * origin and hands the token back to the Slate app in a URL fragment bound
 * to a state value the Slate page generated. Design:
 * harness research design-c2c-slate-auth-token-path.md (option d').
 */

import { CATALYST_WEB_SDK } from '../../ui/src/generate.js';
import { DC_ENDPOINTS, parseDc } from '../../core/src/dc.js';
import { slateHost } from '../../auth/src/slate-host.js';

export const AUTH_FUNCTION = 'c2c_auth';
export const AUTH_FUNCTION_DIR = `functions/${AUTH_FUNCTION}`;

export interface DeployFileLite {
  path: string;
  data: string | Buffer;
}

/**
 * The Slate origin the bridge redirects to, from --slate-domain or the
 * resumed slateUrl. Undefined when the deploy does not know it yet — the
 * function still deploys and answers 500 (never redirects) until the
 * C2C_SLATE_ORIGIN env is set on the console or a later deploy.
 */
export function slateOriginOf(slateDomain: string | undefined): string | undefined {
  const host = slateHost(slateDomain);
  return host ? `https://${host}` : undefined;
}

/** Portal auth domains init.js can name per DC (accounts.zohoportal.<ext>), plus the accounts endpoint itself. */
function connectSrc(dc: string): string {
  const endpoints = DC_ENDPOINTS[parseDc(dc)];
  const host = endpoints.accounts.replace(/^https:\/\/accounts\./, '');
  const tail = host.replace(/^zoho(cloud)?\./, '');
  const portals = new Set<string>([endpoints.accounts, `https://accounts.zohoportal.${tail}`]);
  return [...portals].join(' ');
}

/**
 * index.js source. Byte-stable: C2C_SLATE_ORIGIN comes from the function
 * environment at request time, so the same file deploys to every project.
 * The CSP connect-src list is baked per DC.
 */
function indexSource(connect: string): string {
  return `'use strict';
/**
 * c2c_auth: the Slate auth bridge. One route, GET /bridge[?state=&action=]:
 * serves a static page that runs the Catalyst Web SDK on this (function)
 * origin — where /__catalyst/sdk/init.js, /baas and hosted login are first
 * party — and returns the generateAuthToken token to the Slate app in a URL
 * fragment, bound to the state the Slate page generated. ?action=signout
 * signs the portal session out and returns to Slate instead.
 *
 * The page reflects only the validated state parameter and the configured
 * C2C_SLATE_ORIGIN env. A missing or invalid env answers 500 and never
 * redirects; a malformed state answers 400.
 */
const { randomBytes } = require('node:crypto');

const SDK = ${JSON.stringify(CATALYST_WEB_SDK)};
const CONNECT_SRC = ${JSON.stringify(connect)};
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The configured Slate origin, checked with the same rules --slate-domain uses. */
function slateOrigin() {
  const raw = String(process.env.C2C_SLATE_ORIGIN || '').trim();
  const match = /^https:\\/\\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i.exec(raw);
  if (!match || match[1].length > 253) return '';
  const host = match[1];
  if (!/\\.(?:[a-z]+|xn--[a-z0-9-]+)$/i.test(host)) return '';
  if (host.split('.').some((label) => /^0x[0-9a-f]*$/i.test(label) || /^[0-9]+$/.test(label))) return '';
  return 'https://' + host.toLowerCase();
}

function pageUrl(rawUrl) {
  try {
    return new URL(rawUrl || '/', 'http://function.invalid');
  } catch {
    return new URL('/', 'http://function.invalid');
  }
}

function html(nonce, state, slate, action) {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Signing in</title></head><body>' +
    '<p id="c2c-bridge-msg" role="status">Signing you in&#8230;</p>' +
    '<script nonce="' + nonce + '" src="' + SDK + '"></scr' + 'ipt>' +
    '<script nonce="' + nonce + '" src="/__catalyst/sdk/init.js"></scr' + 'ipt>' +
    '<script nonce="' + nonce + '">' +
    '(function(){' +
    'var slate=' + JSON.stringify(slate) + ',state=' + JSON.stringify(state) + ',action=' + JSON.stringify(action) + ';' +
    'var msg=document.getElementById("c2c-bridge-msg");' +
    'function fail(t){if(msg)msg.textContent=t;}' +
    'var auth=window.catalyst&&window.catalyst.auth;' +
    'if(!auth){fail("Sign-in is unavailable on this host.");return;}' +
    'if(action==="signout"){try{if(typeof auth.signOut==="function"){auth.signOut(slate+"/");return;}}catch(e){}location.replace(slate+"/");return;}' +
    'function marked(){try{var at=Number(sessionStorage.getItem("c2c.bridge.login-at"));return isFinite(at)&&at>0&&Date.now()-at<60000;}catch(e){return false;}}' +
    'var self=location.pathname+location.search;' +
    'Promise.resolve()' +
    '.then(function(){return typeof auth.isUserAuthenticated==="function"?auth.isUserAuthenticated():Promise.reject(new Error("no auth"));})' +
    '.catch(function(){' +
    'if(marked()){fail("Sign-in did not finish. Reload to try again, or ask the app administrator to check your access.");return Promise.reject("stop");}' +
    'try{sessionStorage.setItem("c2c.bridge.login-at",String(Date.now()));}catch(e){}' +
    'location.assign("/__catalyst/auth/login?service_url="+encodeURIComponent(self));' +
    'return Promise.reject("stop");})' +
    '.then(function(){return auth.generateAuthToken();})' +
    '.then(function(res){' +
    'var token=res&&res.access_token;' +
    'if(typeof token!=="string"||!token){fail("No sign-in token was issued.");return;}' +
    'try{sessionStorage.removeItem("c2c.bridge.login-at");}catch(e){}' +
    'location.replace(slate+"/#c2c_auth="+encodeURIComponent(token)+"&state="+encodeURIComponent(state));})' +
    '.catch(function(e){if(e!=="stop")fail("Sign-in could not finish. Reload to try again.");});' +
    '})();' +
    '</scr' + 'ipt></body></html>'
  );
}

module.exports = function c2cAuth(req, res) {
  try {
    if (String(req.method || 'GET').toUpperCase() !== 'GET') {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad request');
      return;
    }
    const url = pageUrl(req.url);
    let path = url.pathname;
    const prefix = '/server/${AUTH_FUNCTION}';
    if (path === prefix || path.startsWith(prefix + '/')) path = path.slice(prefix.length);
    if (path === '/execute' || path.startsWith('/execute/')) path = path.slice('/execute'.length);
    if (path !== '/bridge' && path !== '/bridge/') {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad request');
      return;
    }
    const action = url.searchParams.get('action') || '';
    const state = url.searchParams.get('state') || '';
    if (action !== 'signout' && !STATE_PATTERN.test(state)) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad request');
      return;
    }
    const slate = slateOrigin();
    if (!slate) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('c2c_auth is not configured: set C2C_SLATE_ORIGIN to the Slate app origin');
      return;
    }
    const nonce = randomBytes(16).toString('base64');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy':
        "default-src 'none'; script-src 'nonce-" + nonce + "' 'self' https://static.zohocdn.com; connect-src 'self' " + CONNECT_SRC + "; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(html(nonce, state, slate, action));
  } catch (err) {
    try {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bridge failed');
    } catch {
      /* the response is already gone */
    }
  }
};
`;
}

/**
 * The deployable functions/c2c_auth tree. catalyst-config.json carries
 * C2C_SLATE_ORIGIN when the deploy knows the Slate host (`catalyst deploy`
 * replaces the function env with this set, like c2c_api's env rule).
 */
export function authBridgeFiles(dc: string, slateOrigin: string | undefined): DeployFileLite[] {
  return [
    { path: `${AUTH_FUNCTION_DIR}/index.js`, data: indexSource(connectSrc(dc)) },
    {
      path: `${AUTH_FUNCTION_DIR}/catalyst-config.json`,
      data: `${JSON.stringify(
        {
          deployment: {
            name: AUTH_FUNCTION,
            stack: 'node20',
            type: 'advancedio',
            env_variables: slateOrigin ? { C2C_SLATE_ORIGIN: slateOrigin } : {},
          },
          execution: { main: 'index.js' },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: `${AUTH_FUNCTION_DIR}/package.json`,
      data: `${JSON.stringify({ name: AUTH_FUNCTION, version: '1.0.0', private: true, main: 'index.js', dependencies: {} }, null, 2)}\n`,
    },
  ];
}
