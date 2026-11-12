/**
 * Browser runtime sent with the app: the base script, then each script in
 * client/ in filename order. A new script is picked up by its name.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function clientRuntimeSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [here, join(here, '../../../packages/ui/src')];
  for (const root of candidates) {
    const base = join(root, 'client-runtime.js');
    if (!existsSync(base)) continue;
    const parts = [readFileSync(base, 'utf8')];
    const clientDir = join(root, 'client');
    if (existsSync(clientDir)) {
      const names = readdirSync(clientDir)
        .filter((name) => name.endsWith('.js'))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const name of names) parts.push(readFileSync(join(clientDir, name), 'utf8'));
    }
    return parts.join('\n');
  }
  throw new Error('client runtime missing');
}
