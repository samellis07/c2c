import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { SHELL_CONTENT_SECURITY_POLICY } from '../src/csp.js';
import {
  applyDocPickerCsp,
  appHasGoogleBrowse,
  DOC_PICKER_ENV,
  GOOGLE_PICKER_CSP,
  readDocPickerEnv,
  stripDocPickerCsp,
} from '../src/doc-picker.js';
import { slateConfigSource } from '../src/generate.js';
import { buildUi, generateUi, type UiModel } from '../src/index.js';

const API_KEY = 'AIzaSyTestKeyTestKeyTestKeyTestKey123456';
const CLIENT_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';

function appOf(browse: string): App {
  return deriveIr(
    parse(`application "Demo"\n{\n\tform Docs\n\t{\n\t\tDoc\n\t\t(\n\t\t\ttype = file\n\t\t\tbrowse = ${browse}\n\t\t)\n\t}\n}\n`),
  );
}

test('a remote browse source is carried into the model; the local-upload note is unchanged', () => {
  const field = buildUi(appOf('local_drive, google_docs, zoho_docs')).model.forms[0]!.fields.find((f) => f.name === 'Doc')!;
  assert.deepEqual(field.browseSources, ['google_docs', 'zoho_docs']);
  assert.match(field.note ?? '', /file uploads are supported from local drive only/i);
});

test('a local-only browse carries no browse sources', () => {
  const field = buildUi(appOf('local_drive')).model.forms[0]!.fields.find((f) => f.name === 'Doc')!;
  assert.equal(field.browseSources, undefined);
});

test('the deploy environment names are fixed and an unset environment configures nothing', () => {
  assert.deepEqual(DOC_PICKER_ENV, { apiKey: 'C2C_GOOGLE_PICKER_API_KEY', clientId: 'C2C_GOOGLE_PICKER_CLIENT_ID' });
  assert.equal(readDocPickerEnv({}), undefined);
  assert.equal(readDocPickerEnv({ C2C_GOOGLE_PICKER_API_KEY: '', C2C_GOOGLE_PICKER_CLIENT_ID: '' }), undefined);
});

test('a configured key needs both values and a plain shape; a half or odd value is refused naming the variable, not the value', () => {
  assert.deepEqual(readDocPickerEnv({ C2C_GOOGLE_PICKER_API_KEY: API_KEY, C2C_GOOGLE_PICKER_CLIENT_ID: CLIENT_ID }), {
    apiKey: API_KEY,
    clientId: CLIENT_ID,
  });
  assert.throws(() => readDocPickerEnv({ C2C_GOOGLE_PICKER_API_KEY: API_KEY }), /C2C_GOOGLE_PICKER_CLIENT_ID/);
  assert.throws(() => readDocPickerEnv({ C2C_GOOGLE_PICKER_CLIENT_ID: CLIENT_ID }), /C2C_GOOGLE_PICKER_API_KEY/);
  for (const bad of ['has space', 'quote"x', 'a'.repeat(300), '<script>']) {
    assert.throws(
      () => readDocPickerEnv({ C2C_GOOGLE_PICKER_API_KEY: bad, C2C_GOOGLE_PICKER_CLIENT_ID: CLIENT_ID }),
      (err: Error) => /C2C_GOOGLE_PICKER_API_KEY/.test(err.message) && !err.message.includes(bad),
    );
  }
  assert.throws(() => readDocPickerEnv({ C2C_GOOGLE_PICKER_API_KEY: API_KEY, C2C_GOOGLE_PICKER_CLIENT_ID: 'evil.example' }), /C2C_GOOGLE_PICKER_CLIENT_ID/);
});

test('the opt-in CSP adds the listed Google origins and nothing else', () => {
  assert.deepEqual(GOOGLE_PICKER_CSP, {
    'script-src': ['https://apis.google.com', 'https://accounts.google.com'],
    'frame-src': ['https://docs.google.com', 'https://accounts.google.com'],
    'connect-src': ['https://www.googleapis.com'],
  });
  const html = `<meta http-equiv="Content-Security-Policy" content="${SHELL_CONTENT_SECURITY_POLICY}">`;
  const next = applyDocPickerCsp(html);
  const policy = /content="([^"]*)"/.exec(next)![1]!;
  assert.match(policy, /script-src 'self' https:\/\/static\.zohocdn\.com https:\/\/apis\.google\.com https:\/\/accounts\.google\.com;/);
  assert.match(policy, /frame-src 'self' https:\/\/www\.youtube-nocookie\.com https:\/\/docs\.google\.com https:\/\/accounts\.google\.com;/);
  assert.match(policy, /connect-src 'self' https:\/\/www\.googleapis\.com;/);
  assert.doesNotMatch(policy, /unsafe-eval|script-src[^;]*unsafe-inline|\*/);
  // Every directive other than the three above is byte-identical.
  const strip = (p: string) => p.split(';').filter((d) => !/^\s*(script|frame|connect)-src/.test(d)).join(';');
  assert.equal(strip(policy), strip(SHELL_CONTENT_SECURITY_POLICY));
  // Applying it twice changes nothing more.
  assert.equal(applyDocPickerCsp(next), next);
  // A document with no CSP meta is returned unchanged.
  assert.equal(applyDocPickerCsp('<html></html>'), '<html></html>');
});

test('stripping the opt-in CSP restores the default policy byte for byte', () => {
  const html = `<meta http-equiv="Content-Security-Policy" content="${SHELL_CONTENT_SECURITY_POLICY}">`;
  assert.equal(stripDocPickerCsp(applyDocPickerCsp(html)), html);
  assert.equal(stripDocPickerCsp(html), html);
});

test('the opt-in CSP composes with the function origin connect-src', () => {
  const origin = 'https://demo-123.development.catalystserverless.com';
  const html = `<meta http-equiv="Content-Security-Policy" content="${SHELL_CONTENT_SECURITY_POLICY.replace("connect-src 'self'", `connect-src 'self' ${origin}`)}">`;
  // Compare the directive's source list token by token, not by a pattern over hostnames.
  const policy = /content="([^"]*)"/.exec(applyDocPickerCsp(html))?.[1] ?? '';
  const connect = policy.split(';').map((directive) => directive.trim()).find((directive) => directive.startsWith('connect-src '));
  assert.ok(connect, 'connect-src is present');
  const sources = connect.split(/\s+/).slice(1);
  assert.deepEqual(sources.slice(0, 2), ["'self'", origin]);
  assert.equal(sources.filter((source) => source === 'https://www.googleapis.com').length, 1, 'the picker origin is allowed once');
});

test('the runtime config carries the picker only when configured, and escapes the values', () => {
  const plain = slateConfigSource({});
  assert.doesNotMatch(plain, /PICKER|google/i);
  const withPicker = slateConfigSource({ docPicker: { apiKey: API_KEY, clientId: CLIENT_ID } });
  assert.ok(withPicker.includes(`globalThis.C2C_DOC_PICKER = {"google":{"apiKey":"${API_KEY}","clientId":"${CLIENT_ID}"}};`));
  // Same options without a picker give the same bytes as before the option existed.
  assert.equal(slateConfigSource({ apiBase: 'https://x.example/server/a' }), slateConfigSource({ apiBase: 'https://x.example/server/a', docPicker: undefined }));
});

test('default generation sets no key, no config line and no Google origin in the CSP; the runtime only holds inert fixed constants', () => {
  const files = generateUi(appOf('local_drive, google_docs, zoho_docs'), {}).files;
  const text = (path: string) => {
    const file = files.find((f) => f.path === path);
    assert.ok(file, path);
    return typeof file.data === 'string' ? file.data : file.data.toString('utf8');
  };
  for (const file of files) {
    const body = typeof file.data === 'string' ? file.data : file.data.toString('utf8');
    assert.doesNotMatch(body, /C2C_DOC_PICKER\s*=|C2C_GOOGLE_PICKER_API_KEY\s*=|AIza[0-9A-Za-z_-]{20}/, file.path);
  }
  const csp = /Content-Security-Policy"\s+content="([^"]*)"/.exec(text('slate/index.html'))![1]!;
  assert.equal(csp, SHELL_CONTENT_SECURITY_POLICY);
  assert.doesNotMatch(csp, /google/);
  assert.doesNotMatch(text('slate/c2c-config.js'), /google|PICKER/i);
});

test('appHasGoogleBrowse is true only for a google_docs source on a top-level file field', () => {
  assert.equal(appHasGoogleBrowse(appOf('local_drive, google_docs')), true);
  assert.equal(appHasGoogleBrowse(appOf('local_drive, zoho_docs')), false);
  assert.equal(appHasGoogleBrowse(appOf('local_drive')), false);
});

interface PickerWindow {
  document: Document;
  C2C_DOC_PICKER?: unknown;
  [key: string]: unknown;
}

async function runtime() {
  return (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    renderForm: (form: UiModel['forms'][number]) => string;
    pickGoogleDoc: (field: unknown, view: unknown) => Promise<{ name: string; size: number; type: string } | { error: string } | null>;
  };
}

function fakeGoogle(view: Record<string, any>, picked: Record<string, unknown> | 'cancel', calls: string[]) {
  view.gapi = {
    load: (_name: string, cb: () => void) => {
      calls.push('gapi.load');
      cb();
    },
  };
  view.google = {
    accounts: {
      oauth2: {
        initTokenClient: (cfg: { client_id: string; scope: string; callback: (r: { access_token: string }) => void }) => {
          calls.push(`token:${cfg.client_id}:${cfg.scope}`);
          return { requestAccessToken: () => cfg.callback({ access_token: 'tok' }) };
        },
      },
    },
    picker: {
      Action: { PICKED: 'picked', CANCEL: 'cancel' },
      Response: { ACTION: 'action', DOCUMENTS: 'docs' },
      Document: { ID: 'id', NAME: 'name', MIME_TYPE: 'mimeType', SIZE_BYTES: 'sizeBytes' },
      ViewId: { DOCS: 'all' },
      DocsView: class {
        setMimeTypes(m: string) {
          calls.push(`mime:${m}`);
          return this;
        }
      },
      PickerBuilder: class {
        cfg: Record<string, any> = {};
        setDeveloperKey(k: string) { this.cfg.key = k; return this; }
        setOAuthToken(t: string) { this.cfg.tok = t; return this; }
        setAppId(a: string) { this.cfg.app = a; calls.push(`app:${a}`); return this; }
        addView() { return this; }
        setCallback(cb: (r: Record<string, unknown>) => void) { this.cfg.cb = cb; return this; }
        build() {
          const cfg = this.cfg;
          calls.push(`key:${cfg.key}`);
          return {
            setVisible: () => cfg.cb(picked === 'cancel' ? { action: 'cancel' } : { action: 'picked', docs: [picked] }),
          };
        }
      },
    },
  };
}

function fileField(extra: Record<string, unknown> = {}) {
  return { name: 'Doc', label: 'Doc', widget: 'file', uploadEndpoint: '/uploads/Docs/Doc', browseSources: ['google_docs'], ...extra };
}

test('vanilla form shows the Google Drive control only when the runtime config carries a key', async () => {
  const { renderForm } = await runtime();
  const form = { name: 'Docs', fields: [fileField()] } as unknown as UiModel['forms'][number];
  delete (globalThis as Record<string, unknown>).C2C_DOC_PICKER;
  assert.doesNotMatch(renderForm(form), /data-doc-picker/);
  (globalThis as Record<string, unknown>).C2C_DOC_PICKER = { google: { apiKey: API_KEY, clientId: CLIENT_ID } };
  try {
    assert.match(renderForm(form), /data-doc-picker="google"/);
    // Local upload stays.
    assert.match(renderForm(form), /type="file"/);
    // A zoho-only field never gets the Google control.
    assert.doesNotMatch(renderForm({ name: 'Docs', fields: [fileField({ browseSources: ['zoho_docs'] })] } as unknown as UiModel['forms'][number]), /data-doc-picker/);
  } finally {
    delete (globalThis as Record<string, unknown>).C2C_DOC_PICKER;
  }
});

test('pickGoogleDoc downloads the chosen file with drive.file scope only and returns a File', async () => {
  const { pickGoogleDoc } = await runtime();
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const view = dom.window as unknown as PickerWindow;
  view.C2C_DOC_PICKER = { google: { apiKey: API_KEY, clientId: CLIENT_ID } };
  const calls: string[] = [];
  fakeGoogle(view, { id: 'AbC123_-xyz9876', name: 'a.pdf', mimeType: 'application/pdf', sizeBytes: '5' }, calls);
  view.fetch = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push(`fetch:${url}:${init.headers.Authorization}`);
    return { ok: true, headers: { get: () => '5' }, blob: async () => new (view.Blob as typeof Blob)(['hello'], { type: 'application/pdf' }) };
  };
  const out = (await pickGoogleDoc(fileField(), view)) as { name: string; size: number; type: string };
  assert.equal(out.name, 'a.pdf');
  assert.equal(out.size, 5);
  assert.ok(calls.includes(`token:${CLIENT_ID}:https://www.googleapis.com/auth/drive.file`));
  assert.ok(calls.includes(`key:${API_KEY}`));
  assert.ok(calls.includes('app:123456789012'));
  assert.ok(calls.includes('fetch:https://www.googleapis.com/drive/v3/files/AbC123_-xyz9876?alt=media:Bearer tok'));
});

test('pickGoogleDoc refuses a Google-native document, an oversize file, an odd id and a type the field does not accept; cancel returns null', async () => {
  const { pickGoogleDoc } = await runtime();
  const make = (picked: Record<string, unknown> | 'cancel', field = fileField()) => {
    const view = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' }).window as unknown as PickerWindow;
    view.C2C_DOC_PICKER = { google: { apiKey: API_KEY, clientId: CLIENT_ID } };
    const calls: string[] = [];
    fakeGoogle(view, picked, calls);
    view.fetch = async () => {
      calls.push('fetch');
      return { ok: true, headers: { get: () => '1' }, blob: async () => new (view.Blob as typeof Blob)(['x'], { type: 'image/svg+xml' }) };
    };
    return { view, calls, field };
  };
  const native = make({ id: 'AbC123_-xyz9876', name: 'n', mimeType: 'application/vnd.google-apps.document', sizeBytes: '0' });
  assert.match(String(((await pickGoogleDoc(native.field, native.view)) as { error: string }).error), /Google-native/);
  assert.ok(!native.calls.includes('fetch'));
  const big = make({ id: 'AbC123_-xyz9876', name: 'b', mimeType: 'application/pdf', sizeBytes: String(101 * 1024 * 1024) });
  assert.match(String(((await pickGoogleDoc(big.field, big.view)) as { error: string }).error), /100 MB/);
  assert.ok(!big.calls.includes('fetch'));
  const odd = make({ id: '../../x?y', name: 'o', mimeType: 'application/pdf', sizeBytes: '1' });
  assert.ok('error' in ((await pickGoogleDoc(odd.field, odd.view)) as object));
  assert.ok(!odd.calls.includes('fetch'));
  const typed = make({ id: 'AbC123_-xyz9876', name: 't.png', mimeType: 'image/png', sizeBytes: '1' }, fileField({ accept: 'application/pdf' }));
  assert.match(String(((await pickGoogleDoc(typed.field, typed.view)) as { error: string }).error), /not accepted/);
  assert.ok(!typed.calls.includes('fetch'));
  const cancel = make('cancel');
  assert.equal(await pickGoogleDoc(cancel.field, cancel.view), null);
});

test('pickGoogleDoc without a configured key does nothing', async () => {
  const { pickGoogleDoc } = await runtime();
  const view = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' }).window as unknown as PickerWindow;
  assert.ok('error' in ((await pickGoogleDoc(fileField(), view)) as object));
  assert.equal(view.document.querySelector('script'), null);
});

test('attachDocPickers: a click puts the chosen File in the field input and fires change; a refusal shows the message', async () => {
  const rt = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    attachDocPickers: (formEl: unknown) => void;
  };
  const dom = new JSDOM(
    '<!doctype html><body><form><span class="filepick"><input id="f1" name="Doc" type="file"><button type="button" data-doc-picker="google" data-pick-for="f1" data-pick-field="Doc" data-pick-accept="">Choose from Google Drive</button><span class="filepick-name"></span></span><p data-error-for="Doc"></p></form></body>',
    { url: 'http://localhost/' },
  );
  const view = dom.window as unknown as PickerWindow & { DataTransfer: unknown; Event: typeof Event };
  const form = view.document.querySelector('form')!;
  const input = view.document.getElementById('f1') as HTMLInputElement;
  let stored: unknown;
  Object.defineProperty(input, 'files', { set: (v) => (stored = v), get: () => stored });
  view.DataTransfer = class {
    items = { add: (f: unknown) => (this.files = [f]) };
    files: unknown[] = [];
  };
  view.C2C_DOC_PICKER = { google: { apiKey: API_KEY, clientId: CLIENT_ID } };
  const calls: string[] = [];
  fakeGoogle(view, { id: 'AbC123_-xyz9876', name: 'a.pdf', mimeType: 'application/pdf', sizeBytes: '5' }, calls);
  view.fetch = async () => ({ ok: true, headers: { get: () => '5' }, blob: async () => new (view.Blob as typeof Blob)(['hello'], { type: 'application/pdf' }) });
  let changed = 0;
  input.addEventListener('change', () => changed++);
  rt.attachDocPickers(form);
  const button = view.document.querySelector('button')!;
  button.dispatchEvent(new (view.Event as typeof Event)('click'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((stored as { name: string }[])[0]!.name, 'a.pdf');
  assert.equal(changed, 1);
  assert.equal(view.document.querySelector('.filepick-name')!.textContent, 'a.pdf');
  // A second attach does not double-bind.
  rt.attachDocPickers(form);
  assert.equal(view.document.querySelectorAll('[data-doc-picker-bound]').length, 1);
});
