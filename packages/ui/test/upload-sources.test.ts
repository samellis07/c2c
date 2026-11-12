import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { MAX_FILE_BYTES } from '../../shims/src/index.js';
import { buildUi, stampUploadCap, type UiModel } from '../src/index.js';

const require = createRequire(import.meta.url);
const { implForWrapper } = require('jsdom/lib/jsdom/living/generated/utils.js') as {
  implForWrapper(value: object): { push(item: unknown): number };
};

interface FileLike {
  name: string;
  size: number;
  type: string;
}

interface DomWindow {
  document: {
    querySelector(selector: string): { files?: object; value?: string } | null;
    body: { innerHTML: string };
  };
  File: new (bits: unknown[], name: string, options?: { type?: string }) => FileLike;
  Blob: new (bits: unknown[], options?: { type?: string }) => object;
  fetch?: (url: string) => Promise<object>;
}

function dom(html: string): DomWindow {
  return new JSDOM(`<!doctype html><body>${html}</body>`, { url: 'http://localhost/' }).window as unknown as DomWindow;
}

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function imageApp(sourceLine: string, required = false): UiModel {
  return buildUi(
    appOf(`\tform Profile\n\t{\n\t\t${required ? 'must have ' : ''}Photo\n\t\t(\n\t\t\ttype = image\n${sourceLine}\t\t)\n\t}\n`),
  ).model;
}

async function runtime() {
  return (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    renderForm: (form: UiModel['forms'][number]) => string;
    validateForm: (form: UiModel['forms'][number], values: Record<string, unknown>) => Record<string, string>;
    submitRecord: (
      formEl: unknown,
      form: UiModel['forms'][number],
      upload: (field: unknown, file: FileLike) => Promise<unknown>,
    ) => Promise<Record<string, unknown>>;
    UPLOAD_SOURCE_MAX_BYTES: number;
  };
}

test('the source property is carried into the model and draws its controls', async () => {
  const model = imageApp('\t\t\tsource = public_url,file,camera\n');
  const photo = model.forms[0]!.fields[0]!;
  assert.deepEqual(photo.uploadSources, ['public_url', 'file', 'camera']);
  const rt = await runtime();
  const html = rt.renderForm(model.forms[0]!);
  assert.match(html, /name="Photo" type="file"/);
  assert.match(html, /name="Photo__camera" type="file"[^>]*capture/);
  assert.match(html, /name="Photo__url" type="url"/);
});

test('a source list of file only draws only the file input; public_url only draws no file input', async () => {
  const rt = await runtime();
  const fileOnly = rt.renderForm(imageApp('\t\t\tsource = file\n').forms[0]!);
  assert.match(fileOnly, /name="Photo" type="file"/);
  assert.doesNotMatch(fileOnly, /Photo__camera/);
  assert.doesNotMatch(fileOnly, /Photo__url/);
  const urlOnly = rt.renderForm(imageApp('\t\t\tsource = public_url\n').forms[0]!);
  assert.doesNotMatch(urlOnly, /name="Photo" type="file"/);
  assert.match(urlOnly, /name="Photo__url" type="url"/);
  // A required multi-source field keeps native required off each control; the
  // form check in validateForm enforces it across the sources.
  const multi = rt.renderForm(imageApp('\t\t\tsource = file,camera\n', true).forms[0]!);
  assert.doesNotMatch(multi, /type="file"[^>]*required/);
});

test('submit uploads a camera capture under __camera and a fetched file under __url', async () => {
  const rt = await runtime();
  const form = imageApp('\t\t\tsource = public_url,file,camera\n').forms[0]!;
  const html = rt.renderForm(form);

  const view = dom(html);
  const formEl = view.document.querySelector('form') ?? view.document.body;
  const cameraInput = view.document.querySelector('input[name="Photo__camera"]')!;
  const shot = new view.File(['cam'], 'shot.png', { type: 'image/png' });
  implForWrapper(cameraInput.files!).push(implForWrapper(shot));
  const sent: string[] = [];
  const record = await rt.submitRecord(formEl, form, async (_field, file) => {
    sent.push(file.name);
    return { key: `k/${file.name}` };
  });
  assert.deepEqual(record.Photo, { key: 'k/shot.png' });
  assert.deepEqual(sent, ['shot.png']);

  const view2 = dom(html);
  const formEl2 = view2.document.querySelector('form') ?? view2.document.body;
  view2.document.querySelector('input[name="Photo__url"]')!.value = 'https://cdn.example.com/pic.png';
  view2.fetch = async (url: string) => {
    assert.equal(url, 'https://cdn.example.com/pic.png');
    return { ok: true, headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'image/png' : null) }, blob: async () => new view2.Blob(['img'], { type: 'image/png' }) };
  };
  const record2 = await rt.submitRecord(formEl2, form, async (_field, file) => {
    sent.push(file.name);
    return { key: `k/${file.name}` };
  });
  assert.deepEqual(record2.Photo, { key: 'k/pic.png' });
  assert.deepEqual(sent, ['shot.png', 'pic.png']);

  const view3 = dom(html);
  const formEl3 = view3.document.querySelector('form') ?? view3.document.body;
  view3.document.querySelector('input[name="Photo__url"]')!.value = 'javascript:alert(1)';
  await assert.rejects(rt.submitRecord(formEl3, form, async () => ({ key: 'never' })));
});

test('a public_url response that is oversized, non-image, or untyped never reaches the upload', async () => {
  const rt = await runtime();
  const form = imageApp('\t\t\tsource = public_url,file\n').forms[0]!;
  const html = rt.renderForm(form);
  const headers = (map: Record<string, string>) => ({ get: (name: string) => map[name.toLowerCase()] ?? null });
  const cap = rt.UPLOAD_SOURCE_MAX_BYTES;
  const cases: Array<[string, object]> = [
    ['oversized', { ok: true, headers: headers({ 'content-type': 'image/png', 'content-length': String(cap + 1) }), blob: async () => ({ size: 4, type: 'image/png' }) }],
    ['html', { ok: true, headers: headers({ 'content-type': 'text/html' }), blob: async () => ({ size: 4, type: 'text/html' }) }],
    ['opaque', { ok: true, headers: headers({ 'content-type': 'application/octet-stream' }), blob: async () => ({ size: 4, type: 'application/octet-stream' }) }],
    ['untyped', { ok: true, headers: headers({}), blob: async () => ({ size: 4, type: '' }) }],
    ['redirected-to-html', { ok: true, redirected: true, headers: headers({ 'content-type': 'text/html' }), blob: async () => ({ size: 4, type: 'text/html' }) }],
    ['read-past-cap', { ok: true, headers: headers({ 'content-type': 'image/png' }), blob: async () => ({ size: cap + 1, type: 'image/png' }) }],
    ['svg', { ok: true, headers: headers({ 'content-type': 'image/svg+xml' }), blob: async () => ({ size: 4, type: 'image/svg+xml' }) }],
    ['svg-xml-suffix', { ok: true, headers: headers({ 'content-type': 'image/svg+xml; charset=utf-8' }), blob: async () => ({ size: 4, type: 'image/svg+xml' }) }],
  ];
  for (const [name, res] of cases) {
    const view = dom(html);
    const formEl = view.document.querySelector('form') ?? view.document.body;
    view.document.querySelector('input[name="Photo__url"]')!.value = 'https://cdn.example.com/pic.png';
    view.fetch = async () => res;
    let uploads = 0;
    await assert.rejects(
      rt.submitRecord(formEl, form, async () => {
        uploads += 1;
        return { key: 'never' };
      }),
      name,
    );
    assert.equal(uploads, 0, name);
  }
  // A refused network read (CORS) fails the same way.
  const view = dom(html);
  const formEl = view.document.querySelector('form') ?? view.document.body;
  view.document.querySelector('input[name="Photo__url"]')!.value = 'https://cdn.example.com/pic.png';
  view.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  let uploads = 0;
  await assert.rejects(
    rt.submitRecord(formEl, form, async () => {
      uploads += 1;
      return { key: 'never' };
    }),
  );
  assert.equal(uploads, 0);
});

test('a streamed body stops at the first chunk past the cap and cancels the reader', async () => {
  const rt = await runtime();
  const form = imageApp('\t\t\tsource = public_url\n').forms[0]!;
  const view = dom(rt.renderForm(form));
  const formEl = view.document.querySelector('form') ?? view.document.body;
  view.document.querySelector('input[name="Photo__url"]')!.value = 'https://cdn.example.com/pic.png';
  const cap = rt.UPLOAD_SOURCE_MAX_BYTES;
  // No Content-Length: the cumulative read check must catch it. Two 60 MiB
  // chunks cross 100 MiB on the second read; the reader is cancelled then.
  const chunks = [{ byteLength: 60 * 1024 * 1024 }, { byteLength: 60 * 1024 * 1024 }];
  let reads = 0;
  let cancelled = false;
  view.fetch = async () => ({
    ok: true,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'image/png' : null) },
    body: {
      getReader: () => ({
        read: async () => (reads < chunks.length ? { done: false, value: chunks[reads++] } : { done: true, value: undefined }),
        cancel: async () => {
          cancelled = true;
        },
      }),
    },
  });
  let uploads = 0;
  await assert.rejects(
    rt.submitRecord(formEl, form, async () => {
      uploads += 1;
      return { key: 'never' };
    }),
    /larger than/,
  );
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
  assert.equal(uploads, 0);
  assert.equal(cap, MAX_FILE_BYTES);
});

test('the shipped runtime takes its upload cap from the shim definition', async () => {
  // Mutation guard: a drift between packages/shims MAX_FILE_BYTES and the
  // runtime constant fails here, and the emitted bundle is re-stamped from
  // the shim at generate time so a shipped app cannot carry a second cap.
  const { clientRuntimeSource } = await import('../src/index.js');
  assert.match(clientRuntimeSource(), new RegExp(`export const UPLOAD_SOURCE_MAX_BYTES = ${MAX_FILE_BYTES};`));
  const rt = await runtime();
  assert.equal(rt.UPLOAD_SOURCE_MAX_BYTES, MAX_FILE_BYTES);
});

test('stampUploadCap fails closed when the upload cap declaration is missing or duplicated', () => {
  assert.throws(
    () => stampUploadCap('export const OTHER = 1;', 'client-runtime.js'),
    /Expected exactly one UPLOAD_SOURCE_MAX_BYTES declaration in client-runtime\.js, found 0/,
  );
  assert.throws(
    () =>
      stampUploadCap(
        'export const UPLOAD_SOURCE_MAX_BYTES = 1;\nexport const UPLOAD_SOURCE_MAX_BYTES = 2;',
        'client-runtime.js',
      ),
    /Expected exactly one UPLOAD_SOURCE_MAX_BYTES declaration in client-runtime\.js, found 2/,
  );
  const stamped = stampUploadCap('export const UPLOAD_SOURCE_MAX_BYTES = 100 * 1024 * 1024;', 'client-runtime.js');
  assert.equal(stamped, `export const UPLOAD_SOURCE_MAX_BYTES = ${MAX_FILE_BYTES};`);
});

test('a picked file over the cap, or an SVG pick for an image field, is refused like a fetched source', async () => {
  const rt = await runtime();
  const form = imageApp('\t\t\tsource = file,public_url\n').forms[0]!;
  const html = rt.renderForm(form);
  const cap = rt.UPLOAD_SOURCE_MAX_BYTES;
  // A File-typed value whose size lies past the cap without holding the bytes.
  const sizedGlobal = (size: number, name: string, type: string): FileLike => {
    const file = Object.create(File.prototype) as FileLike;
    Object.defineProperties(file, { size: { value: size }, name: { value: name }, type: { value: type } });
    return file;
  };
  const picked = (view: DomWindow, size: number, name: string, type: string): object => {
    const impl = implForWrapper(new view.File(['x'], name, { type })) as unknown as { size: number };
    Object.defineProperty(impl, 'size', { value: size });
    return impl as object;
  };
  for (const [name, size, fileName, type] of [
    ['too-big', cap + 1, 'big.png', 'image/png'],
    ['svg', 4, 'icon.svg', 'image/svg+xml'],
  ] as Array<[string, number, string, string]>) {
    const view = dom(html);
    const formEl = view.document.querySelector('form') ?? view.document.body;
    const input = view.document.querySelector('input[name="Photo"]')!;
    implForWrapper(input.files!).push(picked(view, size, fileName, type));
    assert.ok(rt.validateForm(form, { Photo: sizedGlobal(size, fileName, type) }).Photo, name);
    let uploads = 0;
    const err = await rt
      .submitRecord(formEl, form, async () => {
        uploads += 1;
        return { key: 'never' };
      })
      .then(
        () => null,
        (e: unknown) => e as { fieldName?: string },
      );
    assert.equal(err?.fieldName, 'Photo', name);
    assert.equal(uploads, 0, name);
  }
  // A non-image field still accepts an SVG file pick as a plain attachment.
  const docForm = buildUi(appOf('\tform Doc\n\t{\n\t\tAttachment\n\t\t(\n\t\t\ttype = file upload\n\t\t\tsource = file\n\t\t)\n\t}\n')).model.forms[0]!;
  const docView = dom(rt.renderForm(docForm));
  const docInput = docView.document.querySelector('input[name="Attachment"]')!;
  implForWrapper(docInput.files!).push(implForWrapper(new docView.File(['<svg/>'], 'icon.svg', { type: 'image/svg+xml' })));
  const sent: string[] = [];
  await rt.submitRecord(docView.document.querySelector('form') ?? docView.document.body, docForm, async (_f, f) => {
    sent.push(f.name);
    return { key: `k/${f.name}` };
  });
  assert.deepEqual(sent, ['icon.svg']);
});

test('a fetched source error names the field so the form can flag it', async () => {
  const rt = await runtime();
  const form = imageApp('\t\t\tsource = public_url\n').forms[0]!;
  const view = dom(rt.renderForm(form));
  const formEl = view.document.querySelector('form') ?? view.document.body;
  view.document.querySelector('input[name="Photo__url"]')!.value = 'https://cdn.example.com/pic.png';
  view.fetch = async () => ({ ok: true, headers: { get: () => 'text/html' }, blob: async () => ({ size: 4, type: 'text/html' }) });
  const err = await rt.submitRecord(formEl, form, async () => ({ key: 'never' })).then(
    () => null,
    (e: unknown) => e as { fieldName?: string },
  );
  assert.equal(err?.fieldName, 'Photo');
});

test('validateForm accepts a camera pick or a public URL for a required source field', async () => {
  const rt = await runtime();
  const form = imageApp('\t\t\tsource = public_url,file,camera\n', true).forms[0]!;
  assert.equal(rt.validateForm(form, { Photo__url: 'https://a.example/b.png' }).Photo, undefined);
  assert.match(rt.validateForm(form, { Photo__url: 'ftp://a.example/b.png' }).Photo ?? '', /http\(s\) URL/);
  assert.match(rt.validateForm(form, {}).Photo ?? '', /required/);
  const shot = new File(['x'], 'c.png', { type: 'image/png' });
  assert.equal(rt.validateForm(form, { Photo__camera: shot }).Photo, undefined);
});
