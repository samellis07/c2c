import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi, type UiModel } from '../src/index.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function model(type: string, extra: string): UiModel {
  return buildUi(appOf(`\tform Clip\n\t{\n\t\tMedia\n\t\t(\n\t\t\ttype = ${type}\n${extra}\t\t)\n\t}\n`)).model;
}

async function runtime(): Promise<Any> {
  return import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href);
}

interface Fakes {
  stopped: number;
  streams: Any[];
  constraints: Any[];
  recorders: Any[];
}

/** A window with fake camera, recorder, DataTransfer and canvas, since jsdom has none. */
function world(html: string, opts: { refuse?: boolean; noMedia?: boolean } = {}): { win: Any; fakes: Fakes } {
  const dom = new JSDOM(`<!doctype html><body><form>${html}</form></body>`, { url: 'http://localhost/' });
  const win = dom.window as Any;
  const fakes: Fakes = { stopped: 0, streams: [], constraints: [], recorders: [] };
  if (!opts.noMedia) {
    Object.defineProperty(win.navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async (c: Any) => {
          fakes.constraints.push(c);
          if (opts.refuse) throw new Error('NotAllowedError');
          const stream = { getTracks: () => [{ stop: () => { fakes.stopped += 1; } }] };
          fakes.streams.push(stream);
          return stream;
        },
      },
    });
    win.MediaRecorder = class {
      static isTypeSupported = () => true;
      state = 'inactive';
      mimeType = 'video/webm';
      ondataavailable: Any = null;
      onstop: Any = null;
      constructor() { fakes.recorders.push(this); }
      start() { this.state = 'recording'; }
      stop() {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        this.ondataavailable?.({ data: new win.Blob(['abc']) });
        this.onstop?.();
      }
    };
  }
  win.DataTransfer = class {
    files: Any[] = [];
    items = { add: (f: Any) => { this.files.push(f); } };
  };
  Object.defineProperty(win.HTMLInputElement.prototype, 'files', {
    configurable: true,
    get() { return this._files ?? []; },
    set(v: Any) { this._files = v; },
  });
  win.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} });
  win.HTMLCanvasElement.prototype.toBlob = function toBlob(cb: Any, type: string) { cb(new win.Blob(['px'], { type })); };
  win.HTMLMediaElement.prototype.play = () => Promise.resolve();
  return { win, fakes };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function mount(m: UiModel, w: ReturnType<typeof world>) {
  const rt = await runtime();
  w.win.document.querySelector('form').innerHTML = rt.renderForm(m.forms[0]);
  rt.attachMediaTools(w.win.document.querySelector('form'));
  return w.win.document;
}

test('video duration: Record opens the camera and the recording stops by itself at the limit', async () => {
  const m = model('video', '\t\t\tduration=30\n');
  const w = world('');
  const doc = await mount(m, w);
  assert.equal(doc.querySelector('[data-media-seconds]')?.getAttribute('data-media-seconds'), '30');
  const timers: Array<{ fn: () => void; ms: number }> = [];
  w.win.setTimeout = (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; };
  doc.querySelector('.media-open').click();
  await flush();
  assert.deepEqual(w.fakes.constraints[0], { video: { facingMode: 'environment' }, audio: true });
  assert.equal(w.fakes.recorders.length, 1);
  const limit = timers.find((t) => t.ms === 30000);
  assert.ok(limit, 'auto-stop timer set for 30 s');
  limit!.fn();
  const input = doc.querySelector('input[type="file"]');
  assert.equal(input.files.length, 1);
  assert.match(input.files[0].name, /^recording\.webm$/);
  assert.equal(w.fakes.stopped, 1, 'camera tracks released');
});

test('audio duration: Record audio asks for the microphone only', async () => {
  const m = model('audio', '\t\t\tduration=10\n');
  const w = world('');
  const doc = await mount(m, w);
  doc.querySelector('.media-open').click();
  await flush();
  assert.deepEqual(w.fakes.constraints[0], { video: false, audio: true });
});

test('camera = secondary opens the front lens; permission failure keeps the file chooser and says so', async () => {
  const m = model('image', '\t\t\tcamera = secondary\n');
  const refused = world('', { refuse: true });
  const doc = await mount(m, refused);
  doc.querySelector('.media-open').click();
  await flush();
  assert.deepEqual(refused.fakes.constraints[0], { video: { facingMode: 'user' }, audio: false });
  assert.match(doc.querySelector('.media-status').textContent, /Camera access was refused or none was found\. Choose a file instead\./);
  assert.ok(doc.querySelector('input[type="file"]'), 'file chooser still present');
});

test('no mediaDevices API degrades to a message, never throws', async () => {
  const m = model('video', '\t\t\tduration=5\n');
  const w = world('', { noMedia: true });
  const doc = await mount(m, w);
  doc.querySelector('.media-open').click();
  await flush();
  assert.match(doc.querySelector('.media-status').textContent, /not available here .* Choose a file instead\./);
});

test('show onload opens the camera when the form opens', async () => {
  const m = model('image', '\t\t\tshow onload = true\n');
  const w = world('');
  const doc = await mount(m, w);
  await flush();
  assert.equal(w.fakes.constraints.length, 1);
  assert.equal(doc.querySelector('.media-act').hidden, false);
});

test('show onload with a refused camera leaves the form usable', async () => {
  const m = model('image', '\t\t\tshow onload = true\n');
  const w = world('', { refuse: true });
  const doc = await mount(m, w);
  await flush();
  assert.match(doc.querySelector('.media-status').textContent, /Choose a file instead/);
});

test('annotation: a chosen photo opens the editor and the marked-up file replaces it', async () => {
  const m = model('image', '\t\t\tannotation = true\n');
  const w = world('');
  const win = w.win;
  win.Image = class { naturalWidth = 40; naturalHeight = 20; onload: Any; onerror: Any; set src(_v: string) { setTimeout(() => this.onload?.(), 0); } };
  const doc = await mount(m, w);
  const input = doc.querySelector('input[type="file"]');
  input.files = [new win.File(['x'], 'pic.png', { type: 'image/png' })];
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const canvas = doc.querySelector('.media-canvas');
  assert.ok(canvas, 'editor canvas shown');
  doc.querySelector('.media-done').click();
  assert.equal(input.files.length, 1);
  assert.equal(input.files[0].name, 'pic-marked.png');
  assert.equal(doc.querySelector('.media-canvas'), null, 'editor closed; no loop');
});

test('annotation: Keep original leaves the chosen file untouched', async () => {
  const m = model('image', '\t\t\tannotation = true\n');
  const w = world('');
  const win = w.win;
  win.Image = class { naturalWidth = 4; naturalHeight = 4; onload: Any; onerror: Any; set src(_v: string) { setTimeout(() => this.onload?.(), 0); } };
  const doc = await mount(m, w);
  const input = doc.querySelector('input[type="file"]');
  const original = new win.File(['x'], 'pic.png', { type: 'image/png' });
  input.files = [original];
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  doc.querySelector('.media-cancel').click();
  assert.equal(input.files[0], original);
});

test('a plain image field renders byte-identical markup (no media wrapper)', async () => {
  const rt = await runtime();
  const html = rt.renderForm(model('image', '\t\t\tcamera = primary\n\t\t\tannotation = false\n').forms[0]);
  assert.ok(!html.includes('media-field'));
});
