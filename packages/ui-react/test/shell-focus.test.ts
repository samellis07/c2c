import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { TEMPLATE_DIR } from '../src/index.js';

// Keyboard focus stays visible: a shell rule that removes the outline from a
// text field nested in a styled box must let the box show focus instead.

const SHELL_CSS = join(TEMPLATE_DIR, 'lib/c2c-ui/styles/shell.css');

function rules(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of src.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) out.push({ selector: match[1]!.trim(), body: match[2]! });
  return out;
}

test('a nested text field without an outline has a focus-within rule on its box', () => {
  const all = rules(readFileSync(SHELL_CSS, 'utf8'));
  const missing: string[] = [];
  for (const rule of all) {
    if (!/outline:\s*(none|0)\b/.test(rule.body)) continue;
    for (const selector of rule.selector.split(',').map((s) => s.trim())) {
      const nested = /^(.+?)\s+(input|textarea|select)$/.exec(selector);
      if (!nested) continue;
      const box = nested[1]!;
      const shown = all.some((r) => r.selector.split(',').some((s) => s.trim() === `${box}:focus-within`) && /border-color|outline|box-shadow/.test(r.body));
      if (!shown) missing.push(selector);
    }
  }
  assert.deepEqual(missing, []);
});
