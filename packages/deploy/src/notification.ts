/**
 * Catalyst web push for Deluge `pushnotification`.
 *
 * The generated function ships this module only when a handler calls
 * `shim.notification.send`. Live send uses the Node SDK
 * `pushNotification().web().sendNotification` when present, else REST
 * `POST /baas/v1/project/{id}/project-user/notify`. Recipients batch at 50.
 * Console enable and client enrollment (`enableNotification`) are outside
 * this module: the human checklist names the console, and the Slate client
 * enrolls after sign-in when the app spec has `sendsPush`.
 * https://docs.catalyst.zoho.com/en/cloud-scale/help/push-notifications/
 */
import { generate as generateDeluge } from '../../deluge/src/generate.js';
import type { App } from '../../core/src/ir.js';

/** True when a generated function calls the notification shim. */
export function sendsPush(sources: readonly string[]): boolean {
  return sources.some((source) => source.includes('shim.notification.send('));
}

function appSendsPush(app: App): boolean {
  return sendsPush(generateDeluge(app).files.map((file) => file.source));
}

/** True when the app's generated functions send a push notification. */
export function appSendsPushNotification(app: App): boolean {
  return appSendsPush(app);
}

export function notificationImportSpec(fromFile: string): string {
  const fromDir = fromFile.split('/').slice(0, -1).join('/') || '.';
  const target = 'functions/c2c-notification.mjs';
  const fromParts = fromDir.split('/').filter(Boolean);
  const toParts = target.split('/');
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i += 1;
  const up = fromParts.length - i;
  const rel = `${up === 0 ? '.' : Array(up).fill('..').join('/')}/${toParts.slice(i).join('/')}`;
  return rel.startsWith('.') ? rel : `./${rel}`;
}

export function patchNotification(source: string, importSpec: string): string {
  if (!source.includes('createRuntime(') || source.includes('c2cGuardedNotification')) return source;
  const patched = source.replaceAll(
    'createRuntime({',
    'createRuntime({ notification: (message) => c2cGuardedNotification(message, typeof req === "undefined" ? undefined : req), ',
  );
  const line = `import { c2cGuardedNotification } from ${JSON.stringify(importSpec)};\n`;
  const match = /^import /m.exec(patched);
  if (!match) return line + patched;
  const at = match.index;
  return `${patched.slice(0, at)}${line}${patched.slice(at)}`;
}

/**
 * Self-contained function module. setNotificationSdk installs a stand-in for
 * zcatalyst-sdk-node (tests); it receives the request and returns an app that
 * may expose `pushNotification().web().sendNotification`.
 */
export function notificationModuleSource(): string {
  return `let installed = null;

export function setNotificationSdk(next) {
  installed = typeof next === "function" ? next : null;
  return installed;
}

async function catalystApp(req) {
  if (installed) return installed(req);
  const sdk = await import("zcatalyst-sdk-node");
  const catalyst = sdk.default || sdk;
  return catalyst.initialize(req, { scope: "admin" });
}

function addressList(raw) {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return list.flatMap((item) => String(item).split(/[,;]/)).map((item) => item.trim()).filter((item) => item.length > 0);
}

export function recipientsOf(message) {
  if (!message || typeof message !== "object") return [];
  return addressList(message.to ?? message.recipients ?? message.recipient);
}

function textOf(value) {
  return value === undefined || value === null ? "" : String(value);
}

export function webPushPayload(message) {
  const title = textOf(message && message.title);
  const body = textOf(message && message.message);
  const view = textOf(message && message.view);
  const recordId = textOf(
    message && (message.recordid ?? message["record id"] ?? message.recordID ?? message.recordId),
  );
  const payload = { title, message: body };
  if (view) {
    payload.view = view;
    payload.url = recordId ? "#/report/" + encodeURIComponent(view) + "/row/" + encodeURIComponent(recordId) : "#/report/" + encodeURIComponent(view);
  }
  return JSON.stringify(payload);
}

function batches(users, size) {
  const out = [];
  for (let i = 0; i < users.length; i += size) out.push(users.slice(i, i + size));
  return out;
}

async function sendWithSdk(app, payload, users) {
  if (typeof app.pushNotification !== "function") return false;
  const web = app.pushNotification().web();
  if (!web || typeof web.sendNotification !== "function") return false;
  for (const batch of batches(users, 50)) await web.sendNotification(payload, batch);
  return true;
}

async function sendWithRest(app, req, payload, users) {
  const projectId =
    (app && (app.projectId || app.project_id || (app.config && (app.config.projectId || app.config.project_id)))) ||
    process.env.CATALYST_PROJECT_ID ||
    process.env.X_ZOHO_CATALYST_PROJECT_ID;
  if (!projectId) throw new Error("Catalyst web push has no project id");
  const host =
    (req && req.headers && (req.headers.host || req.headers.Host)) ||
    process.env.X_ZOHO_CATALYST_HOST ||
    "";
  const path = "/baas/v1/project/" + encodeURIComponent(String(projectId)) + "/project-user/notify";
  if (typeof app.request === "function") {
    for (const batch of batches(users, 50)) {
      await app.request({ method: "POST", path, body: { message: payload, recipients: batch } });
    }
    return;
  }
  if (!host) throw new Error("Catalyst web push REST fallback needs a host");
  const cookie = req && req.headers && (req.headers.cookie || req.headers.Cookie);
  for (const batch of batches(users, 50)) {
    const reply = await fetch("https://" + host + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: String(cookie) } : {}),
      },
      body: JSON.stringify({ message: payload, recipients: batch }),
    });
    if (!reply.ok) throw new Error("Catalyst web push REST " + reply.status);
  }
}

async function attempt(message, req) {
  const users = recipientsOf(message);
  if (!users.length) return { performed: false, status: "refused", reason: "no recipient" };
  const payload = webPushPayload(message);
  try {
    const app = await catalystApp(req);
    if (await sendWithSdk(app, payload, users)) {
      return { performed: true, status: "sent", reason: "accepted by Catalyst web push" };
    }
    await sendWithRest(app, req, payload, users);
    return { performed: true, status: "sent", reason: "accepted by Catalyst web push" };
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    console.error("c2c notification send failed: " + detail);
    return { performed: false, status: "failed", reason: "The notification could not be sent." };
  }
}

export async function c2cGuardedNotification(message, req) {
  return attempt(message, req);
}
`;
}
