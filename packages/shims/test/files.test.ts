import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FileReferenceError,
  catalystFileStore,
  cleanFileName,
  creatorFileName,
  creatorFilePath,
  isStoredFileKey,
  keyBelongsTo,
  migratedObjectKey,
  signDownload,
  signUpload,
  storeFileKeys,
  uploadObjectKey,
  type FileStore,
} from '../src/index.js';

const HASH = 'a'.repeat(64);

function recordingStore(): FileStore & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    async signedUrl(key, action, options) {
      calls.push([key, action, options]);
      return `https://bucket-development.zohostratus.in/_signed/${key}?sig=1`;
    },
  };
}

test('upload and migrated keys are deterministic and safe', () => {
  assert.equal(uploadObjectKey('Order', 'Photo', HASH.toUpperCase(), 'my pic (1).PNG'), `uploads/Order/Photo/${HASH}/my-pic-1-.PNG`);
  assert.equal(cleanFileName('../../etc/passwd'), 'passwd');
  assert.equal(cleanFileName('...'), 'file');
  assert.equal(cleanFileName(''), 'file');
  assert.equal(cleanFileName('x'.repeat(200)).length, 80);
  assert.throws(() => uploadObjectKey('Order', 'Photo', 'nothex', 'a'), FileReferenceError);
  assert.throws(() => uploadObjectKey('Order/..', 'Photo', HASH, 'a'), FileReferenceError);
  const value = '/api/v2.1/acme/app/report/All_Orders/4400000000000000123/Photo/download?filepath=1700000000_cat%20pic.jpg';
  assert.equal(creatorFileName(value), '1700000000_cat pic.jpg');
  assert.equal(creatorFilePath(value), '1700000000_cat%20pic.jpg');
  assert.equal(creatorFileName('/api/v2.1/acme/app/report/R/1/Photo/download'), '');
  assert.equal(creatorFileName('scan.pdf'), 'scan.pdf');
  assert.equal(migratedObjectKey('Order', 'Photo', '4400000000000000123', value), 'migrated/Order/Photo/4400000000000000123/1700000000_cat-pic.jpg');
  assert.equal(migratedObjectKey('Order', 'Photo', '1', ''), null);
  assert.equal(migratedObjectKey('Order', 'Photo', '1', null), null);
  assert.equal(migratedObjectKey('Order', 'Photo', '1', '/x/download'), 'migrated/Order/Photo/1/file');
  assert.throws(() => migratedObjectKey('Order', 'Photo', '1', { url: 'x' }), FileReferenceError);
});

test('keyBelongsTo accepts only this form and field and refuses traversal and dry-run keys', () => {
  assert.equal(keyBelongsTo('Order', 'Photo', `uploads/Order/Photo/${HASH}/a.png`), true);
  assert.equal(keyBelongsTo('Order', 'Photo', 'migrated/Order/Photo/12/a.png'), true);
  assert.equal(keyBelongsTo('Order', 'Photo', `uploads/Order/Scan/${HASH}/a.png`), false);
  assert.equal(keyBelongsTo('Order', 'Photo', `uploads/Other/Photo/${HASH}/a.png`), false);
  assert.equal(keyBelongsTo('Order', 'Photo', 'dry-run/Order/Photo/a.png'), false);
  assert.equal(keyBelongsTo('Order', 'Photo', `uploads/Order/Photo/${HASH}/../x`), false);
  assert.equal(keyBelongsTo('Order', 'Photo', { key: 'x' }), false);
});

test('isStoredFileKey accepts the same upload and migrated shapes for any form and field', () => {
  const upload = `uploads/Order/Photo/${HASH}/a.png`;
  const migrated = 'migrated/Order/Photo/12/a.png';
  assert.equal(isStoredFileKey(upload), true);
  assert.equal(isStoredFileKey(migrated), true);
  assert.equal(isStoredFileKey(`uploads/Other/Scan/${HASH}/a.png`), true);
  assert.equal(keyBelongsTo('Order', 'Photo', `uploads/Other/Scan/${HASH}/a.png`), false);
  assert.equal(isStoredFileKey(''), false);
  assert.equal(isStoredFileKey(null), false);
  assert.equal(isStoredFileKey('dry-run/Order/Photo/a.png'), false);
  assert.equal(isStoredFileKey(`uploads/Order/Photo/${HASH}/../x`), false);
  assert.equal(isStoredFileKey({ key: upload }), false);
});

test('signUpload signs a PUT with the Content-Type the browser must send; signDownload signs a GET only for owned keys', async () => {
  const store = recordingStore();
  const up = await signUpload(store, 'Order', 'Photo', { sha256: HASH, filename: 'a.png', contentType: 'image/PNG' });
  assert.deepEqual(up.reference, { key: `uploads/Order/Photo/${HASH}/a.png` });
  assert.deepEqual(up.upload.headers, { 'Content-Type': 'image/png' });
  assert.equal(up.upload.method, 'PUT');
  assert.deepEqual(store.calls[0], [up.reference.key, 'PUT', { expiresIn: 600, contentType: 'image/png' }]);
  await assert.rejects(signUpload(store, 'Order', 'Photo', { sha256: HASH, contentType: 'not a type' }), FileReferenceError);
  const down = await signDownload(store, 'Order', 'Photo', 'migrated/Order/Photo/12/a.png');
  assert.equal(down.key, 'migrated/Order/Photo/12/a.png');
  assert.deepEqual(store.calls[1], ['migrated/Order/Photo/12/a.png', 'GET', { expiresIn: 600 }]);
  await assert.rejects(signDownload(store, 'Order', 'Photo', 'migrated/Other/Photo/12/a.png'), FileReferenceError);
  assert.equal(store.calls.length, 2);
});

test('storeFileKeys stores the key string and refuses a key from another form or field', () => {
  const key = `uploads/Order/Photo/${HASH}/a.png`;
  const record: Record<string, unknown> = { Photo: { key }, Scan: null, Name: 'x' };
  assert.equal(storeFileKeys('Order', record, ['Photo', 'Scan', 'Missing']), record);
  assert.deepEqual(record, { Photo: key, Scan: null, Name: 'x' });
  assert.throws(() => storeFileKeys('Order', { Scan: { key } }, ['Scan']), FileReferenceError);
  assert.throws(() => storeFileKeys('Order', { Photo: { key: 'dry-run/Order/Photo/a.png' } }, ['Photo']), FileReferenceError);
});

test('catalystFileStore calls generatePreSignedUrl on the named bucket and returns the signature', async () => {
  const seen: unknown[] = [];
  const app = {
    stratus: () => ({
      bucket: (name: string) => ({
        generatePreSignedUrl: async (key: string, action: string, options?: { expiryIn?: number }) => {
          seen.push([name, key, action, options]);
          return { signature: 'https://signed' };
        },
      }),
    }),
  };
  const store = catalystFileStore(app, 'c2c-files');
  assert.equal(await store.signedUrl('k', 'GET', { expiresIn: 60 }), 'https://signed');
  assert.deepEqual(seen, [['c2c-files', 'k', 'GET', { expiryIn: 60 }]]);
  assert.throws(() => catalystFileStore(app, ''), /bucket name/);
  const empty = catalystFileStore({ stratus: () => ({ bucket: () => ({ generatePreSignedUrl: async () => ({}) }) }) }, 'b');
  await assert.rejects(empty.signedUrl('k', 'PUT', { expiresIn: 60 }), /did not return a signed URL/);
});
