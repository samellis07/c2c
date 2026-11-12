#!/usr/bin/env node
/**
 * Writes packages/ui/tokens/c2c-tokens.css from the design tokens
 * (packages/ui/src/tokens.ts). Run through `npm run tokens:css`, which
 * builds first.
 */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const { tokensStylesheet } = await import(join(root, 'dist/ui/src/tokens.js'));
writeFileSync(join(root, 'packages/ui/tokens/c2c-tokens.css'), tokensStylesheet());
