import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { notificationImportSpec, notificationModuleSource, patchNotification, sendsPush } from '../src/notification.js';

test('sendsPush detects the notification shim call', () => {
  assert.equal(sendsPush(['await shim.notification.send(ctx, { to: "a@b.c" })']), true);
  assert.equal(sendsPush(['await shim.mail.send(ctx, { to: "a@b.c" })']), false);
});

test('notificationImportSpec walks up to functions/c2c-notification.mjs', () => {
  assert.equal(notificationImportSpec('functions/aio/item/on-success.mjs'), '../../c2c-notification.mjs');
  assert.equal(notificationImportSpec('functions/c2c_api.mjs'), './c2c-notification.mjs');
});

test('patchNotification inserts its import before the first real import', () => {
  const source = `/**
 * body.import === true marks a bulk import write.
 */
import { readFileSync } from "node:fs";

export async function handler(req, res) {
  const runtime = createRuntime({
    dryRun: true,
  });
}
`;
  const patched = patchNotification(source, '../../c2c-notification.mjs');
  assert.doesNotMatch(patched, /body\.import \{ c2cGuardedNotification \}/);
  assert.match(patched, /^import \{ c2cGuardedNotification \} from "\.\.\/\.\.\/c2c-notification\.mjs";\nimport \{ readFileSync \} from "node:fs";/m);
  assert.match(patched, /notification: \(message\) => c2cGuardedNotification\(/);
});

test('the generated notification module sends through the SDK in 50-user batches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-notify-'));
  const path = join(dir, 'c2c-notification.mjs');
  writeFileSync(path, notificationModuleSource());
  const mod = (await import(pathToFileURL(path).href)) as {
    setNotificationSdk: (next: (req: unknown) => unknown) => unknown;
    c2cGuardedNotification: (message: unknown, req?: unknown) => Promise<Record<string, unknown>>;
    recipientsOf: (message: unknown) => string[];
    webPushPayload: (message: unknown) => string;
  };
  const batches: unknown[][] = [];
  mod.setNotificationSdk(() => ({
    pushNotification: () => ({
      web: () => ({
        sendNotification: async (_payload: string, users: unknown[]) => {
          batches.push(users);
        },
      }),
    }),
  }));
  const users = Array.from({ length: 51 }, (_, i) => `u${i}@example.test`);
  const outcome = await mod.c2cGuardedNotification({ to: users, title: 'T', message: 'm', view: 'Recent' }, {});
  assert.equal(outcome.status, 'sent');
  assert.equal(batches.length, 2);
  assert.equal(batches[0]!.length, 50);
  assert.deepEqual(batches[1], ['u50@example.test']);
  assert.deepEqual(mod.recipientsOf({ to: 'a@b.c, b@c.d' }), ['a@b.c', 'b@c.d']);
  assert.match(mod.webPushPayload({ title: 'T', message: 'm', view: 'Recent', recordid: '9' }), /#\/report\/Recent\/row\/9/);
});
