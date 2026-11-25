/**
 * The browser scanner behind a Creator scan field. The camera is opened with
 * getUserMedia, frames are decoded by the browser's BarcodeDetector at a
 * bounded rate, and a decoded string is written into the field as typing
 * would (input and change events), never as markup. The camera API needs a
 * secure (HTTPS) origin; without the API, a detector or permission the
 * caller shows the message and the field stays a plain text input. Nothing
 * is uploaded: images and frames are decoded in the page.
 */
import type { ScannerSpec } from '../types';

export const SCAN_INTERVAL_MS = 250;
export const SCAN_VALUE_MAX = 4096;
export const SCAN_UNAVAILABLE = 'Scanning is not available here (it needs a camera, a supported browser and HTTPS). Type the value instead.';
export const SCAN_REFUSED = 'Camera access was refused or no camera was found. Type the value instead.';

interface DetectedCode {
  rawValue?: unknown;
}
interface Detector {
  detect(source: unknown): Promise<DetectedCode[]>;
}
interface DetectorClass {
  new (init?: { formats: string[] }): Detector;
  getSupportedFormats?: () => Promise<string[]>;
}

export interface ScanHooks {
  /** A message for the user (empty clears it). */
  say(text: string): void;
  /** The camera is open (true) or closed (false). */
  active(on: boolean, video: HTMLVideoElement | null): void;
}

/** Write a scanned string into the input exactly as typing would, so form handlers run. */
export function applyScanned(input: HTMLInputElement, raw: string): void {
  const win = input.ownerDocument.defaultView!;
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set;
  const text = raw.slice(0, SCAN_VALUE_MAX);
  if (setter) setter.call(input, text);
  else input.value = text;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
}

export function createScanner(input: HTMLInputElement, spec: ScannerSpec, hooks: ScanHooks, video: () => HTMLVideoElement | null, switchable: boolean) {
  const win = input.ownerDocument.defaultView as (Window & { BarcodeDetector?: DetectorClass; createImageBitmap?: (file: Blob) => Promise<ImageBitmap> }) | null;
  let facing: 'environment' | 'user' = spec.camera === 'secondary' ? 'user' : 'environment';
  let stream: MediaStream | null = null;
  let timer = 0;
  let session = 0;
  let detector: Detector | null = null;

  function stop() {
    session += 1;
    if (timer && win) win.clearTimeout(timer);
    timer = 0;
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = null;
    const el = video();
    if (el) el.srcObject = null;
    hooks.active(false, el);
  }

  async function makeDetector(): Promise<Detector | null> {
    if (detector) return detector;
    const Detector = win?.BarcodeDetector;
    if (typeof Detector !== 'function') return null;
    let formats = spec.formats;
    if (typeof Detector.getSupportedFormats === 'function') {
      try {
        const supported = await Detector.getSupportedFormats();
        formats = formats.length ? formats.filter((f) => supported.includes(f)) : supported;
        if (!formats.length) return null;
      } catch {
        // keep the declared formats
      }
    }
    try {
      detector = formats.length ? new Detector({ formats }) : new Detector();
    } catch {
      return null;
    }
    return detector;
  }

  const first = (found: DetectedCode[]) => (Array.isArray(found) ? found.find((item) => item && typeof item.rawValue === 'string' && item.rawValue !== '') : undefined);

  async function start() {
    if (stream || !win) return;
    const mine = ++session;
    const media = win.navigator?.mediaDevices;
    if (!media || typeof media.getUserMedia !== 'function' || typeof win.BarcodeDetector !== 'function') {
      hooks.say(SCAN_UNAVAILABLE);
      return;
    }
    const det = await makeDetector();
    if (mine !== session) return;
    if (!det) {
      hooks.say(SCAN_UNAVAILABLE);
      return;
    }
    let opened: MediaStream;
    try {
      opened = await media.getUserMedia({ video: { facingMode: facing }, audio: false });
    } catch {
      if (mine === session) hooks.say(SCAN_REFUSED);
      return;
    }
    if (mine !== session) {
      for (const track of opened.getTracks()) track.stop();
      return;
    }
    stream = opened;
    const el = video();
    if (el) {
      el.srcObject = opened;
      try {
        void el.play()?.catch(() => {});
      } catch {
        // frames are read either way
      }
    }
    hooks.active(true, el);
    hooks.say('Point the camera at the code.');
    const tick = async () => {
      timer = 0;
      if (mine !== session || !stream) return;
      if (!input.isConnected) {
        stop();
        return;
      }
      try {
        const hit = first(await det.detect(video()));
        if (mine !== session) return;
        if (hit) {
          stop();
          applyScanned(input, String(hit.rawValue));
          hooks.say('Scanned.');
          return;
        }
      } catch {
        // retried on the next tick
      }
      if (mine === session && stream) timer = win.setTimeout(tick, SCAN_INTERVAL_MS);
    };
    timer = win.setTimeout(tick, SCAN_INTERVAL_MS);
  }

  async function fromImage(file: Blob) {
    const det = await makeDetector();
    if (!det || !win?.createImageBitmap) {
      hooks.say(SCAN_UNAVAILABLE);
      return;
    }
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await win.createImageBitmap(file);
      const hit = first(await det.detect(bitmap));
      if (hit) {
        applyScanned(input, String(hit.rawValue));
        hooks.say('Scanned.');
      } else {
        hooks.say('No code was found in that image.');
      }
    } catch {
      hooks.say('That image could not be read. Type the value instead.');
    } finally {
      bitmap?.close?.();
    }
  }

  function switchCamera() {
    if (!switchable) return;
    facing = facing === 'environment' ? 'user' : 'environment';
    stop();
    void start();
  }

  return { start, stop, fromImage, switchCamera };
}
