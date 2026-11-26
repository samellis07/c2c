/**
 * Live capture and recording behind a Creator image, video or audio field.
 * The camera or microphone is opened with getUserMedia, a photo is drawn from
 * a video frame, and a recording runs through MediaRecorder with a timer that
 * stops it at the declared duration. The result is handed to the caller as a
 * File; nothing is uploaded here. Without the API, or after a refusal, the
 * caller shows the message and the file chooser stays in use.
 */
import { UPLOAD_SOURCE_MAX_BYTES } from './record';

export const MEDIA_IMAGE_MAX_SIDE = 2048;
export const MEDIA_PEN_COLORS = ['#d32f2f', '#1565c0', '#212121'];

const RECORD_TYPES = {
  video: ['video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4'],
  audio: ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'],
};

export type MediaKind = 'image' | 'video' | 'audio';

export interface MediaHooks {
  /** A message for the user (empty clears it). */
  say(text: string): void;
  /** The camera or recorder is open (true) or closed (false). */
  active(on: boolean): void;
}

interface RecorderLike {
  state: string;
  mimeType: string;
  discard?: boolean;
  ondataavailable: ((event: { data?: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(slice?: number): void;
  stop(): void;
}
type RecorderClass = { new (stream: MediaStream, options?: { mimeType: string }): RecorderLike; isTypeSupported?: (type: string) => boolean };

export function unavailableText(kind: MediaKind): string {
  const needs = kind === 'video' ? 'a camera, a microphone' : kind === 'audio' ? 'a microphone' : 'a camera';
  return `${kind === 'image' ? 'The camera' : 'Recording'} is not available here (it needs ${needs}, a supported browser and HTTPS). Choose a file instead.`;
}

export function refusedText(kind: MediaKind): string {
  const device = kind === 'audio' ? 'Microphone' : kind === 'video' ? 'Camera or microphone' : 'Camera';
  return `${device} access was refused or none was found. Choose a file instead.`;
}

export function createMedia(
  win: Window,
  spec: { kind: MediaKind; camera: 'primary' | 'secondary'; recordSeconds: number },
  hooks: MediaHooks,
  video: () => HTMLVideoElement | null,
  deliver: (file: File) => void,
) {
  const { kind } = spec;
  let stream: MediaStream | null = null;
  let recorder: RecorderLike | null = null;
  let tick = 0;
  let stopTimer = 0;
  let session = 0;

  function release() {
    session += 1;
    if (tick) win.clearInterval(tick);
    if (stopTimer) win.clearTimeout(stopTimer);
    tick = 0;
    stopTimer = 0;
    const live = recorder;
    recorder = null;
    if (live) {
      live.discard = live.discard !== false;
      try {
        if (live.state !== 'inactive') live.stop();
      } catch {
        // already stopped
      }
    }
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = null;
    const el = video();
    if (el) el.srcObject = null;
    hooks.active(false);
  }

  async function openStream(): Promise<boolean> {
    if (stream) return false;
    const devices = win.navigator?.mediaDevices;
    const Recorder = (win as unknown as { MediaRecorder?: RecorderClass }).MediaRecorder;
    if (!devices || typeof devices.getUserMedia !== 'function' || (kind !== 'image' && typeof Recorder !== 'function')) {
      hooks.say(unavailableText(kind));
      return false;
    }
    const mine = ++session;
    let media: MediaStream;
    try {
      media = await devices.getUserMedia({
        video: kind === 'audio' ? false : { facingMode: spec.camera === 'secondary' ? 'user' : 'environment' },
        audio: kind !== 'image',
      });
    } catch {
      if (mine === session) hooks.say(refusedText(kind));
      return false;
    }
    if (mine !== session) {
      for (const track of media.getTracks()) track.stop();
      return false;
    }
    stream = media;
    const el = video();
    if (el && kind !== 'audio') {
      el.srcObject = media;
      try {
        const played = el.play();
        if (played && typeof played.catch === 'function') played.catch(() => {});
      } catch {
        // jsdom and some browsers refuse; frames are read either way
      }
    }
    hooks.active(true);
    return true;
  }

  function capture() {
    const el = video();
    if (!el) return;
    const width = el.videoWidth || 640;
    const height = el.videoHeight || 480;
    const scale = Math.min(1, MEDIA_IMAGE_MAX_SIDE / Math.max(width, height));
    const canvas = win.document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      hooks.say(unavailableText(kind));
      return;
    }
    ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) {
        hooks.say('The photo could not be captured. Choose a file instead.');
        return;
      }
      release();
      hooks.say('');
      deliver(new (win as unknown as typeof globalThis).File([blob], 'photo.jpg', { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.92);
  }

  async function record() {
    if (!(await openStream())) return;
    const Recorder = (win as unknown as { MediaRecorder: RecorderClass }).MediaRecorder;
    const types = RECORD_TYPES[kind as 'video' | 'audio'];
    const supported = typeof Recorder.isTypeSupported === 'function' ? types.find((t) => Recorder.isTypeSupported!(t)) : undefined;
    let rec: RecorderLike;
    try {
      rec = supported ? new Recorder(stream!, { mimeType: supported }) : new Recorder(stream!);
    } catch {
      release();
      hooks.say(unavailableText(kind));
      return;
    }
    recorder = rec;
    rec.discard = false;
    const chunks: Blob[] = [];
    let bytes = 0;
    rec.ondataavailable = (event) => {
      if (!event.data || !event.data.size) return;
      chunks.push(event.data);
      bytes += event.data.size;
      // A recording never outgrows what the upload accepts.
      if (bytes >= UPLOAD_SOURCE_MAX_BYTES && rec.state !== 'inactive') rec.stop();
    };
    rec.onstop = () => {
      const discarded = rec.discard === true;
      const mime = String(rec.mimeType || supported || '').split(';')[0] || (kind === 'video' ? 'video/webm' : 'audio/webm');
      if (recorder === rec) release();
      if (discarded) return;
      if (!chunks.length) {
        hooks.say('Nothing was recorded. Choose a file instead.');
        return;
      }
      hooks.say('');
      deliver(new (win as unknown as typeof globalThis).File(chunks, `recording.${mime.endsWith('mp4') ? 'mp4' : 'webm'}`, { type: mime }));
    };
    let left = spec.recordSeconds;
    hooks.say(`Recording… ${left}s left.`);
    tick = win.setInterval(() => {
      left -= 1;
      if (left > 0) hooks.say(`Recording… ${left}s left.`);
    }, 1000);
    // Auto-stop: the declared duration is a hard limit on the recording.
    stopTimer = win.setTimeout(() => {
      if (recorder === rec && rec.state !== 'inactive') rec.stop();
    }, spec.recordSeconds * 1000);
    rec.start(1000);
  }

  return {
    open: () => (kind === 'image' ? openStream().then(() => undefined) : record()),
    capture,
    /** End a running recording now and keep it. */
    finish() {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    },
    release,
  };
}

/** Draw a chosen photo into a bounded canvas; resolves null when the browser cannot decode it. */
export function loadCanvas(win: Window, file: File): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    const reader = new (win as unknown as typeof globalThis).FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const img = new (win as unknown as { Image: typeof Image }).Image();
      img.onerror = () => resolve(null);
      img.onload = () => {
        const scale = Math.min(1, MEDIA_IMAGE_MAX_SIDE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
        const canvas = win.document.createElement('canvas');
        canvas.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
        canvas.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas);
      };
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

/** The marked-up canvas as a PNG File named after the original: the stored annotation is always image/png, whatever the original type was. */
export function canvasToFile(win: Window, canvas: HTMLCanvasElement, original: File): Promise<File | null> {
  const type = 'image/png';
  const ext = 'png';
  const base = String(original.name || 'photo').replace(/\.[^.]*$/, '') || 'photo';
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob ? new (win as unknown as typeof globalThis).File([blob], `${base}-marked.${ext}`, { type }) : null), type);
  });
}
