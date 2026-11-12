import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface EmittedFile {
  path: string;
  source: string;
}

/** Load a generated module with every emitted file at its real relative path. */
export async function loadGeneratedModule(
  files: readonly EmittedFile[],
  entry: string,
): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-generated-module-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of files) {
    const dest = join(dir, ...file.path.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.source);
  }
  try {
    return (await import(pathToFileURL(join(dir, ...entry.split('/'))).href)) as Record<string, unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
