/**
 * Generated JavaScript modules for one app, from the same deploy tree
 * determinism hashes (fixed synthetic guard, last write wins).
 */
import type { App } from '../../core/src/index.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../../deploy/src/guards.js';
import { deployFiles } from '../../deploy/src/plan.js';
import type { ProjectRegistry } from '../../deploy/src/registry.js';

/** server: Catalyst function code. client: PWA handler. ui: Slate runtime, model, service worker. */
export type ModuleKind = 'server' | 'client' | 'ui';

export interface GeneratedModule {
  path: string;
  kind: ModuleKind;
  text: string;
  /** Byte copy of another listed module (Slate asset of a client handler). Checked once. */
  copyOf?: string;
}

/** Synthetic org stamped into hashed trees so catalyst.json bytes stay stable. Not an allow-list. */
const FIXTURE_ORG = '10000000000';
const FIXTURE_PROJECT_ID = '00000000000000000';
const FIXTURE_REGISTRY: ProjectRegistry = { org: FIXTURE_ORG, env: 'Development', projects: {}, dc: 'us' };

export function moduleKind(path: string): ModuleKind {
  if (path.startsWith('client/')) return 'client';
  if (path.startsWith('slate/')) return path.startsWith('slate/assets/handlers/') ? 'client' : 'ui';
  return 'server';
}

export interface GeneratedTree {
  /** Every written file, last write wins, sorted by path. */
  files: { path: string; data: string | Buffer }[];
  modules: GeneratedModule[];
}

export function generatedModules(app: App): GeneratedModule[] {
  return generatedTree(app).modules;
}

export function generatedTree(app: App): GeneratedTree {
  const guard: GuardOk = {
    org: FIXTURE_ORG,
    projectId: FIXTURE_PROJECT_ID,
    environment: ALLOWED_ENV,
    projectName: catalystProjectName(app.name || 'app'),
    dc: 'us',
    registry: FIXTURE_REGISTRY,
  };
  const written = new Map<string, string | Buffer>();
  for (const file of deployFiles(app, guard, false).files) written.set(file.path, file.data);
  const all = [...written.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const byPath = new Map<string, string>();
  for (const path of all) {
    if (!/\.m?js$/.test(path)) continue;
    const data = written.get(path)!;
    byPath.set(path, typeof data === 'string' ? data : data.toString('utf8'));
  }
  const paths = [...byPath.keys()];
  const firstByText = new Map<string, string>();
  const out: GeneratedModule[] = [];
  for (const path of paths) {
    const text = byPath.get(path)!;
    const kind = moduleKind(path);
    const mod: GeneratedModule = { path, kind, text };
    if (path.startsWith('slate/assets/handlers/')) {
      const orig = firstByText.get(text);
      if (orig) mod.copyOf = orig;
    } else if (kind === 'client' && !firstByText.has(text)) firstByText.set(text, path);
    out.push(mod);
  }
  return { files: all.map((path) => ({ path, data: written.get(path)! })), modules: out };
}
