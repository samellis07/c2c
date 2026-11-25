import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildUi, type UiModel } from '../src/index.js';

function modelOf(extra: string, name = 'Barcode'): UiModel {
  const app = deriveIr(parse(`application "Demo"\n{\n\tform Item\n\t{\n\t\t${name}\n\t\t(\n\t\t\ttype = text\n${extra}\t\t)\n\t}\n}\n`));
  return buildUi(app).model;
}

async function runtime() {
  return (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    renderForm: (form: UiModel['forms'][number]) => string;
    attachScanners: (formEl: object) => void;
  };
}

interface Track {
  stopped: number;
}

interface Env {
  window: any;
  input: any;
  form: any;
  events: string[];
  tracks: Track[];
  requests: any[];
}

interface Options {
  detect?: (source: unknown) => Promise<{ rawValue: string }[]>;
  getUserMedia?: 'ok' | 'denied' | 'missing';
  detector?: boolean;
  supported?: string[];
}

const windows: { close(): void }[] = [];
after(() => {
  for (const w of windows) w.close();
});

async function mount(model: UiModel, options: Options = {}): Promise<Env> {
  const rt = await runtime();
  const html = rt.renderForm(model.forms[0]!);
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url: 'https://localhost/' });
  const window = dom.window as any;
  windows.push(window);
  window.HTMLMediaElement.prototype.play = async () => {};
  const tracks: Track[] = [];
  const requests: any[] = [];
  if (options.getUserMedia !== 'missing') {
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async (constraints: unknown) => {
          requests.push(constraints);
          if (options.getUserMedia === 'denied') throw new Error('NotAllowedError');
          const track: Track = { stopped: 0 };
          tracks.push(track);
          return { getTracks: () => [{ stop: () => (track.stopped += 1) }] };
        },
      },
    });
  }
  if (options.detector !== false) {
    window.BarcodeDetector = class {
      static async getSupportedFormats() {
        return options.supported ?? ['qr_code', 'code_128', 'ean_13'];
      }
      formats: string[];
      constructor(init?: { formats?: string[] }) {
        this.formats = init?.formats ?? [];
        requests.push({ detectorFormats: this.formats });
      }
      detect(source: unknown) {
        return (options.detect ?? (async () => []))(source);
      }
    };
  }
  window.createImageBitmap = async () => ({ close() {} });
  const form = window.document.querySelector('form');
  const input = window.document.querySelector('input[data-scan]');
  const events: string[] = [];
  for (const type of ['input', 'change']) input.addEventListener(type, () => events.push(type));
  rt.attachScanners(form);
  return { window, input, form, events, tracks, requests };
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const status = (env: Env) => env.window.document.querySelector('.scan-status').textContent as string;

test('a decoded code lands in the field and fires input and change like typing', async () => {
  const env = await mount(modelOf('\t\t\tqrcode = true\n\t\t\tbarcode = true\n\t\t\tcamera = primary\n'), { detect: async () => [{ rawValue: 'ISBN-9780' }] });
  env.window.document.querySelector('.scan-open').click();
  await until(() => env.input.value === 'ISBN-9780', 'decoded value');
  assert.deepEqual(env.events, ['input', 'change']);
  assert.deepEqual(env.requests[1], { video: { facingMode: 'environment' }, audio: false });
  await until(() => env.tracks[0]!.stopped === 1, 'stream stop after decode');
  assert.equal(status(env), 'Scanned.');
});

test('declared formats reach the detector, and secondary opens the front camera', async () => {
  const env = await mount(modelOf('\t\t\tqrcode = true\n\t\t\tcamera = secondary\n'), { detect: async () => [{ rawValue: 'x' }] });
  env.window.document.querySelector('.scan-open').click();
  await until(() => env.input.value === 'x', 'value');
  assert.deepEqual(env.requests[0], { detectorFormats: ['qr_code'] });
  assert.equal(env.requests[1].video.facingMode, 'user');
});

test('a refused camera permission leaves the text input with a visible message', async () => {
  const env = await mount(modelOf('\t\t\tbarcode = true\n\t\t\tcamera = primary\n'), { getUserMedia: 'denied' });
  env.window.document.querySelector('.scan-open').click();
  await until(() => status(env) !== '', 'message');
  assert.match(status(env), /refused/);
  assert.equal(env.input.value, '');
  assert.equal(env.input.disabled, false);
});

test('without getUserMedia or BarcodeDetector the field says so and stays typeable', async () => {
  for (const options of [{ getUserMedia: 'missing' as const }, { detector: false }]) {
    const env = await mount(modelOf('\t\t\tbarcode = true\n\t\t\tcamera = primary\n'), options);
    env.window.document.querySelector('.scan-open').click();
    await until(() => status(env) !== '', 'message');
    assert.match(status(env), /not available/);
    env.input.value = 'typed';
    assert.equal(env.input.value, 'typed');
  }
});

test('the gallery picker decodes a saved image with the same detector', async () => {
  const env = await mount(modelOf('\t\t\tbarcode = true\n\t\t\tcamera = primary\n\t\t\tshow gallery = true\n'), { detect: async () => [{ rawValue: 'FROM-PHOTO' }] });
  const picker = env.window.document.querySelector('input.scan-gallery');
  assert.equal(picker.getAttribute('accept'), 'image/*');
  Object.defineProperty(picker, 'files', { configurable: true, value: [new env.window.File(['x'], 'p.png', { type: 'image/png' })] });
  picker.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  await until(() => env.input.value === 'FROM-PHOTO', 'gallery decode');
  assert.deepEqual(env.events, ['input', 'change']);
  assert.equal(env.requests.some((r) => r.video), false, 'the camera is not opened for a gallery decode');
});

test('a gallery image with no code reports it', async () => {
  const env = await mount(modelOf('\t\t\tbarcode = true\n\t\t\tcamera = primary\n\t\t\tshow gallery = true\n'));
  const picker = env.window.document.querySelector('input.scan-gallery');
  Object.defineProperty(picker, 'files', { configurable: true, value: [new env.window.File(['x'], 'p.png', { type: 'image/png' })] });
  picker.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  await until(() => /No code/.test(status(env)), 'no-code message');
  assert.equal(env.input.value, '');
});

test('no gallery control unless the field declares show gallery', async () => {
  const env = await mount(modelOf('\t\t\tbarcode = true\n\t\t\tcamera = primary\n'));
  assert.equal(env.window.document.querySelector('input.scan-gallery'), null);
});

test('show onload starts scanning as the form opens', async () => {
  const env = await mount(modelOf('\t\t\tbarcode = true\n\t\t\tcamera = primary\n\t\t\tshow onload = true\n'));
  await until(() => env.tracks.length === 1, 'camera opened without a click');
  assert.equal(env.window.document.querySelector('.scan-close').hidden, false);
});

test('closing the scanner, hiding the page, and unmounting stop every track', async () => {
  const closeEnv = await mount(modelOf('\t\t\tbarcode = true\n\t\t\tcamera = primary\n'));
  closeEnv.window.document.querySelector('.scan-open').click();
  await until(() => closeEnv.tracks.length === 1, 'stream');
  closeEnv.window.document.querySelector('.scan-close').click();
  assert.equal(closeEnv.tracks[0]!.stopped, 1);

  const hideEnv = await mount(modelOf('\t\t\tbarcode = true\n\t\t\tcamera = primary\n'));
  hideEnv.window.document.querySelector('.scan-open').click();
  await until(() => hideEnv.tracks.length === 1, 'stream');
  hideEnv.window.dispatchEvent(new hideEnv.window.Event('pagehide'));
  assert.equal(hideEnv.tracks[0]!.stopped, 1);

  const removeEnv = await mount(modelOf('\t\t\tbarcode = true\n\t\t\tcamera = primary\n'));
  removeEnv.window.document.querySelector('.scan-open').click();
  await until(() => removeEnv.tracks.length === 1, 'stream');
  removeEnv.form.remove();
  await until(() => removeEnv.tracks[0]!.stopped === 1, 'stop after unmount');
});

test('a hostile decoded string stays text', async () => {
  const hostile = '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>';
  const env = await mount(modelOf('\t\t\tqrcode = true\n\t\t\tcamera = primary\n'), { detect: async () => [{ rawValue: hostile }] });
  env.window.document.querySelector('.scan-open').click();
  await until(() => env.input.value === hostile, 'value');
  assert.equal(env.window.document.querySelector('img'), null);
  assert.equal(env.window.document.querySelector('script'), null);
  assert.equal(env.window.pwned, undefined);
  assert.equal(status(env), 'Scanned.');
});

test('the scanner replaces the counted steps it implements and keeps the ones it cannot', () => {
  const ok = modelOf('\t\t\tbarcode = true\n\t\t\tcamera = primary\n\t\t\tshow gallery = true\n\t\t\tshow onload = true\n');
  assert.deepEqual(ok.todos.filter((t) => /camera|gallery|onload/.test(t.name)), []);
  assert.deepEqual(ok.forms[0]!.fields[0]!.scanner, { camera: 'primary', formats: ['code_128', 'code_39', 'code_93', 'codabar', 'ean_13', 'ean_8', 'itf', 'upc_a', 'upc_e'], gallery: true, onload: true });
  const odd = modelOf('\t\t\tbarcode = true\n\t\t\tcamera = external\n');
  assert.equal(odd.todos.filter((t) => /camera/.test(t.name)).length, 1);
});
