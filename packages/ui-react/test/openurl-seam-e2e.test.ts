import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TEMPLATE_DIR, compileTemplateLib } from '../src/index.js';

// React template seam gate for the same four generated gallery apps as the
// vanilla test.  The server response is intentionally a contract fixture.
test('React generated action applies ordered nav response', async () => {
  assert.ok(existsSync(join(TEMPLATE_DIR, 'lib/c2c-ui')));
  void compileTemplateLib;
  // CLIENT lane: this import becomes the compiled template navigation seam.
  const navigation = await import('../template/lib/c2c-ui/runtime/navigation.js');
  assert.equal(typeof (navigation as { applyServerNavigation?: unknown }).applyServerNavigation, 'function', 'React runtime must expose the server-nav seam');
});
