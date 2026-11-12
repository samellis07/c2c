import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi, type UiModel } from '../src/index.js';

const require = createRequire(import.meta.url);
const { implForWrapper } = require('jsdom/lib/jsdom/living/generated/utils.js') as {
  implForWrapper(value: object): { push(item: unknown): number };
};

interface FileLike {
  name: string;
  size: number;
  type: string;
}

interface ElementLike {
  value: string;
  files?: object;
  getAttribute(name: string): string | null;
  querySelector(selector: string): ElementLike | null;
  dispatchEvent(event: unknown): void;
  click(): void;
}

interface DomWindow {
  document: {
    querySelector(selector: string): ElementLike | null;
    body: ElementLike;
  };
  File: new (bits: unknown[], name: string, options?: { type?: string }) => FileLike;
  Event: new (type: string, options?: { bubbles?: boolean }) => unknown;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

function dom(html: string): DomWindow {
  return new JSDOM(`<!doctype html><body>${html}</body>`, { url: 'http://localhost/' }).window as unknown as DomWindow;
}

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function imageApp(extra: string): UiModel {
  return buildUi(appOf(`\tform Profile\n\t{\n\t\tPhoto\n\t\t(\n\t\t\ttype = image\n${extra}\t\t)\n\t}\n`)).model;
}

async function runtime() {
  return (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    renderForm: (form: UiModel['forms'][number]) => string;
    attachCapturePreviews: (formEl: object) => void;
    capturePreviewCount: () => number;
  };
}

/** A model+todo pair for one image field carrying `preview duration = <value>`. */
function previewField(value: string) {
  const model = imageApp(`\t\t\tpreview duration = ${value}\n`);
  const field = model.forms[0]!.fields[0]!;
  const todo = model.todos.find((t) => t.name === 'Profile.Photo property preview duration');
  return { model, field, todo };
}

/** Replace the view's URL object with a tracked object-URL implementation. */
function trackUrls(view: object) {
  const live = new Set<string>();
  let seq = 0;
  (view as { URL: object }).URL = {
    createObjectURL: () => {
      const url = `blob:mock-${seq++}`;
      live.add(url);
      return url;
    },
    revokeObjectURL: (url: string) => {
      live.delete(url);
    },
  };
  return live;
}

interface TrackedTimer {
  handler: () => void;
  delay: number;
  fired: boolean;
}

interface TrackedTimers {
  list: TrackedTimer[];
  pending(): number;
  fire(timer: TrackedTimer): void;
}

/** Replace the view's timers with a capture list; fire each handler by hand. */
function trackTimers(view: DomWindow): TrackedTimers {
  const list: TrackedTimer[] = [];
  const pending = new Map<number, TrackedTimer>();
  const ids = new Map<TrackedTimer, number>();
  let next = 1;
  view.setTimeout = ((handler: () => void, delay?: number) => {
    const timer: TrackedTimer = { handler, delay: Number(delay), fired: false };
    list.push(timer);
    const id = next++;
    pending.set(id, timer);
    ids.set(timer, id);
    return id;
  }) as unknown as typeof setTimeout;
  view.clearTimeout = ((id: number) => {
    pending.delete(id);
  }) as typeof clearTimeout;
  return {
    list,
    pending: () => pending.size,
    fire: (timer) => {
      timer.fired = true;
      pending.delete(ids.get(timer) ?? -1);
      timer.handler();
    },
  };
}

type ObserverCallback = (records: unknown[], observer: unknown) => void;
interface ObserverLike {
  observe(target: unknown, options: object): void;
  disconnect(): void;
}

/** Count MutationObserver construction/disconnection through a wrapped class. */
function countObservers(view: object): { made: number; live: number } {
  const win = view as { MutationObserver: new (callback: ObserverCallback) => ObserverLike };
  const Native = win.MutationObserver;
  const state = { made: 0, live: 0 };
  win.MutationObserver = class extends Native {
    private counted = true;
    constructor(callback: ObserverCallback) {
      super(callback);
      state.made += 1;
      state.live += 1;
    }
    override disconnect() {
      if (this.counted) {
        this.counted = false;
        state.live -= 1;
      }
      super.disconnect();
    }
  };
  return state;
}

function pick(view: DomWindow, name = 'Photo'): ElementLike {
  const input = view.document.querySelector(`input[name="${name}"]`)!;
  const file = new view.File(['x'], 'shot.png', { type: 'image/png' });
  implForWrapper(input.files!).push(implForWrapper(file));
  input.dispatchEvent(new view.Event('change', { bubbles: true }));
  return input;
}

/** Let queued MutationObserver callbacks run. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('an image field with a non-zero preview duration renders the data attribute on every pick control', async () => {
  const model = imageApp('\t\t\tsource = file,camera\n\t\t\tpreview duration = 3\n');
  const photo = model.forms[0]!.fields[0]!;
  assert.equal(photo.previewDuration, 3);
  const rt = await runtime();
  const html = rt.renderForm(model.forms[0]!);
  assert.match(html, /name="Photo" type="file"[^>]*data-preview-duration="3"/);
  assert.match(html, /name="Photo__camera" type="file"[^>]*capture[^>]*data-preview-duration="3"/);
});

test('preview duration = 0 renders no data attribute', async () => {
  const model = imageApp('\t\t\tpreview duration = 0\n');
  const rt = await runtime();
  const html = rt.renderForm(model.forms[0]!);
  assert.doesNotMatch(html, /data-preview-duration/);
});

test('picking a file shows a preview with a Retake control, which auto-dismisses after the configured delay', async () => {
  const model = imageApp('\t\t\tpreview duration = 3\n');
  const rt = await runtime();
  const view = dom(rt.renderForm(model.forms[0]!));
  rt.attachCapturePreviews(view.document.body);

  const input = view.document.querySelector('input[name="Photo"]')!;
  const nativeSetTimeout = view.setTimeout.bind(view);
  const scheduled: Array<{ handler: () => void; delay: number }> = [];
  view.setTimeout = ((handler: () => void, delay?: number) => {
    scheduled.push({ handler, delay: Number(delay) });
    return nativeSetTimeout(() => {}, 0);
  }) as typeof setTimeout;

  const file = new view.File(['x'], 'shot.png', { type: 'image/png' });
  implForWrapper(input.files!).push(implForWrapper(file));
  input.dispatchEvent(new view.Event('change', { bubbles: true }));

  const nameEl = view.document.querySelector('.filepick-name')!;
  assert.ok(nameEl.querySelector('img.capture-preview'), 'a preview thumbnail is shown');
  const retake = nameEl.querySelector('button.capture-retake');
  assert.ok(retake, 'a Retake control is shown');

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]!.delay, 3000, "the auto-dismiss timer uses the field's preview duration in seconds");
  scheduled[0]!.handler();
  assert.equal(nameEl.querySelector('button.capture-retake'), null, 'the preview auto-confirms: Retake is gone after the timer fires');
  assert.ok(nameEl.querySelector('img.capture-preview'), 'the thumbnail itself stays — only the Retake option is dismissed');
});

test('clicking Retake before the timer fires clears the pick and lets the user choose again', async () => {
  const model = imageApp('\t\t\tpreview duration = 5\n');
  const rt = await runtime();
  const view = dom(rt.renderForm(model.forms[0]!));
  rt.attachCapturePreviews(view.document.body);

  const input = view.document.querySelector('input[name="Photo"]')!;
  const file = new view.File(['x'], 'shot.png', { type: 'image/png' });
  implForWrapper(input.files!).push(implForWrapper(file));
  input.dispatchEvent(new view.Event('change', { bubbles: true }));

  const nameEl = view.document.querySelector('.filepick-name')!;
  const retake = nameEl.querySelector('button.capture-retake');
  assert.ok(retake, 'a Retake control is shown');
  retake!.click();

  assert.equal(input.value, '', 'retaking clears the previous pick');
  assert.equal(nameEl.querySelector('img.capture-preview'), null, 'the preview is cleared on retake');
  assert.equal(nameEl.querySelector('button.capture-retake'), null, 'the Retake control is cleared along with the preview');
});

test('a non-positive or unparsable preview duration is a counted manual item naming the field and raw value', async () => {
  for (const value of ['-3', '""', 'abc', 'NaN', '"<img src=x onerror=alert(1)>"', 'Infinity']) {
    const { field, todo } = previewField(value);
    assert.equal(field.previewDuration, undefined, `${value} never reaches the generated field`);
    assert.ok(todo, `${value} is recorded as a manual item`);
    const raw = value.replace(/^"|"$/g, '');
    assert.ok(
      todo!.reason.includes('preview duration = ' + raw) && todo!.reason.includes('Photo'),
      `the manual item names the field and the raw value, got: ${todo!.reason}`,
    );
  }
});

test('a hostile preview duration never reaches generated HTML, style, or data attributes', async () => {
  const { model, todo } = previewField('"><img src=x onerror=alert(1)>');
  assert.ok(todo, 'the hostile value is a counted manual item');
  const rt = await runtime();
  const html = rt.renderForm(model.forms[0]!);
  assert.doesNotMatch(html, /data-preview-duration/);
  assert.ok(!html.includes('<img src=x'), 'the hostile markup is not injected');
  assert.ok(!html.includes('onerror'), 'no hostile handler reaches the HTML');
});

test('preview duration = 0 generates the same field as no property and counts as emitted', async () => {
  const rt = await runtime();
  const withZero = imageApp('\t\t\tpreview duration = 0\n');
  const without = imageApp('');
  assert.equal(withZero.forms[0]!.fields[0]!.previewDuration, undefined);
  assert.equal(withZero.todos.some((t) => t.name === 'Profile.Photo property preview duration'), false, 'no manual item for the Creator default');
  assert.equal(rt.renderForm(withZero.forms[0]!), rt.renderForm(without.forms[0]!), 'duration 0 output equals the field without the property');
  const { coverageLedger, collectOutputs } = await import('../../quality/src/no-silent-drop.js');
  const app = appOf('\tform Profile\n\t{\n\t\tPhoto\n\t\t(\n\t\t\ttype = image\n\t\t\tpreview duration = 0\n\t\t)\n\t}\n');
  const row = coverageLedger(app, collectOutputs(app)).find((r) => r.name === 'Profile.Photo property preview duration');
  assert.equal(row?.status, 'emitted', 'the property is counted as emitted, not a silent drop');
});

test('preview duration clamps at the 60-second cap: 59/60/61/huge', async () => {
  assert.equal(previewField('59').field.previewDuration, 59);
  const at60 = previewField('60');
  assert.equal(at60.field.previewDuration, 60);
  assert.equal(at60.todo, undefined, '60 needs no manual item — it is not clamped');
  for (const value of ['61', '3600', '999999999']) {
    const { field, todo } = previewField(value);
    assert.equal(field.previewDuration, 60, `${value} clamps to the cap`);
    assert.ok(todo, `${value} records the clamp as a counted manual item`);
    assert.ok(todo!.reason.includes(`preview duration = ${value}`), 'the note names the raw value');
    assert.ok(todo!.reason.includes('60'), 'the note states the applied cap');
  }
  const rt = await runtime();
  const html = rt.renderForm(previewField('61').model.forms[0]!);
  assert.match(html, /data-preview-duration="60"/, 'the rendered attribute is the clamped value');
});

test('a fractional preview duration carries through as-is', () => {
  const { field, todo } = previewField('2.5');
  assert.equal(field.previewDuration, 2.5);
  assert.equal(todo, undefined, 'a valid fractional value needs no manual item');
});

test('video and audio duration settings remain manual items', () => {
  for (const type of ['video', 'audio']) {
    const model = buildUi(appOf(`\tform Profile\n\t{\n\t\tClip\n\t\t(\n\t\t\ttype = ${type}\n\t\t\tduration = 30\n\t\t)\n\t}\n`)).model;
    const todo = model.todos.find((t) => t.name === 'Profile.Clip property duration');
    assert.ok(todo, `${type} duration is a counted manual item`);
    assert.ok(todo!.reason.includes('duration = 30'));
    assert.equal(model.forms[0]!.fields[0]!.previewDuration, undefined, `${type} duration does not become a preview timer`);
  }
});

test('auto-dismiss revokes the object URL and removes the input from the preview registry', async () => {
  const model = imageApp('\t\t\tpreview duration = 3\n');
  const rt = await runtime();
  const view = dom(rt.renderForm(model.forms[0]!));
  const liveUrls = trackUrls(view);
  const timers = trackTimers(view);
  rt.attachCapturePreviews(view.document.querySelector('form')!);
  pick(view);

  assert.equal(rt.capturePreviewCount(), 1, 'the input is registered while its preview is live');
  assert.equal(liveUrls.size, 1, 'one object URL is live');
  assert.equal(timers.pending(), 1, 'one auto-dismiss timer is pending');

  timers.fire(timers.list[0]!);
  assert.equal(rt.capturePreviewCount(), 0, 'auto-dismiss removes the input from the registry');
  assert.equal(liveUrls.size, 0, 'auto-dismiss revokes the object URL');
  assert.equal(timers.pending(), 0, 'no timer remains pending');
});

test('capturing a second file tears down the first preview', async () => {
  const model = imageApp('\t\t\tpreview duration = 3\n');
  const rt = await runtime();
  const view = dom(rt.renderForm(model.forms[0]!));
  const liveUrls = trackUrls(view);
  const timers = trackTimers(view);
  rt.attachCapturePreviews(view.document.querySelector('form')!);
  const input = pick(view);
  assert.equal(liveUrls.size, 1);

  const second = new view.File(['y'], 'shot2.png', { type: 'image/png' });
  implForWrapper(input.files!).push(implForWrapper(second));
  input.dispatchEvent(new view.Event('change', { bubbles: true }));

  assert.equal(liveUrls.size, 1, 'the first object URL was revoked; only the second is live');
  assert.equal(rt.capturePreviewCount(), 1, 'still one registered input');
  assert.equal(timers.pending(), 1, 'the first timer was cleared and replaced');

  timers.fire(timers.list[timers.list.length - 1]!);
  assert.equal(rt.capturePreviewCount(), 0);
  assert.equal(liveUrls.size, 0);
  assert.equal(timers.pending(), 0);
});

test('a form reset tears down a live preview', async () => {
  const model = imageApp('\t\t\tpreview duration = 3\n');
  const rt = await runtime();
  const view = dom(rt.renderForm(model.forms[0]!));
  const liveUrls = trackUrls(view);
  const timers = trackTimers(view);
  const form = view.document.querySelector('form')!;
  rt.attachCapturePreviews(form);
  pick(view);
  assert.equal(rt.capturePreviewCount(), 1);

  form.dispatchEvent(new view.Event('reset'));
  assert.equal(rt.capturePreviewCount(), 0, 'reset removes the input from the registry');
  assert.equal(liveUrls.size, 0, 'reset revokes the object URL');
  assert.equal(timers.pending(), 0, 'reset clears the timer');
});

test('removing a preview-bound input tears down its preview', async () => {
  const model = imageApp('\t\t\tpreview duration = 3\n');
  const rt = await runtime();
  const view = dom(rt.renderForm(model.forms[0]!));
  const liveUrls = trackUrls(view);
  const timers = trackTimers(view);
  rt.attachCapturePreviews(view.document.querySelector('form')!);
  const input = pick(view);
  assert.equal(rt.capturePreviewCount(), 1);

  (input as unknown as { remove(): void }).remove();
  await flush();
  assert.equal(rt.capturePreviewCount(), 0, 'detaching the input removes it from the registry');
  assert.equal(liveUrls.size, 0, 'detaching the input revokes the object URL');
  assert.equal(timers.pending(), 0, 'detaching the input clears the timer');
});

test('a route change that removes the form disconnects the preview observer', async () => {
  const model = imageApp('\t\t\tpreview duration = 3\n');
  const rt = await runtime();
  const view = dom('<main id="main"></main>');
  const observers = countObservers(view);
  const liveUrls = trackUrls(view);
  const timers = trackTimers(view);
  const main = view.document.querySelector('main')!;

  (main as unknown as { innerHTML: string }).innerHTML = rt.renderForm(model.forms[0]!);
  const form = view.document.querySelector('form')!;
  rt.attachCapturePreviews(form);
  pick(view);
  assert.equal(observers.live, 1, 'one observer watches the document');
  assert.equal(rt.capturePreviewCount(), 1);

  // Route change: the router replaces the whole screen, form included.
  (main as unknown as { innerHTML: string }).innerHTML = '<p>other route</p>';
  await flush();
  assert.equal(rt.capturePreviewCount(), 0, 'the preview registry is empty after the route change');
  assert.equal(liveUrls.size, 0, 'the object URL is revoked');
  assert.equal(timers.pending(), 0, 'the timer is cleared');
  assert.equal(observers.live, 0, 'no observer outlives its form');
});

test('pagehide tears down every preview and disconnects the observer', async () => {
  const model = imageApp('\t\t\tpreview duration = 3\n');
  const rt = await runtime();
  const view = dom(rt.renderForm(model.forms[0]!));
  const observers = countObservers(view);
  const liveUrls = trackUrls(view);
  const timers = trackTimers(view);
  rt.attachCapturePreviews(view.document.querySelector('form')!);
  pick(view);
  assert.equal(rt.capturePreviewCount(), 1);

  (view as unknown as { dispatchEvent(e: unknown): void }).dispatchEvent(new view.Event('pagehide'));
  assert.equal(rt.capturePreviewCount(), 0, 'pagehide empties the registry');
  assert.equal(liveUrls.size, 0, 'pagehide revokes the object URL');
  assert.equal(timers.pending(), 0, 'pagehide clears the timer');
  assert.equal(observers.live, 0, 'pagehide disconnects the observer');
});

test('preview observers do not accumulate across 100 route mounts', async () => {
  const model = imageApp('\t\t\tpreview duration = 3\n');
  const rt = await runtime();
  const view = dom('<main id="main"></main>');
  const observers = countObservers(view);
  const main = view.document.querySelector('main')! as unknown as { innerHTML: string };

  for (let i = 0; i < 100; i++) {
    // Each mount re-renders the screen, discarding the previous form.
    main.innerHTML = rt.renderForm(model.forms[0]!);
    const form = view.document.querySelector('form')!;
    rt.attachCapturePreviews(form);
    await flush();
  }
  assert.equal(observers.live, 1, 'only the live screen keeps an observer after 100 mounts');
  assert.ok(observers.made <= 2, `observers are reused, not stacked (made ${observers.made})`);
});

test('100 capture-and-dismiss cycles leave no URLs, registry entries, or timers', async () => {
  const model = imageApp('\t\t\tpreview duration = 3\n');
  const rt = await runtime();
  const view = dom(rt.renderForm(model.forms[0]!));
  const liveUrls = trackUrls(view);
  const timers = trackTimers(view);
  rt.attachCapturePreviews(view.document.querySelector('form')!);
  const input = view.document.querySelector('input[name="Photo"]')!;

  for (let i = 0; i < 100; i++) {
    const file = new view.File(['x'], `shot${i}.png`, { type: 'image/png' });
    implForWrapper(input.files!).push(implForWrapper(file));
    input.dispatchEvent(new view.Event('change', { bubbles: true }));
    const timer = timers.list[timers.list.length - 1]!;
    timers.fire(timer);
    assert.equal(rt.capturePreviewCount(), 0, `cycle ${i} leaves the registry empty`);
    assert.equal(liveUrls.size, 0, `cycle ${i} leaves no live object URL`);
    assert.equal(timers.pending(), 0, `cycle ${i} leaves no pending timer`);
  }
});
