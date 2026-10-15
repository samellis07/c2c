/**
 * Generated app tree for one Creator export.
 * The guard is synthetic and fixed so hashes do not follow a project registry file.
 * Last write wins, matching writeDeployTree.
 */
import { createHash } from 'node:crypto';
import { parseFileOrProject, type App } from '../../core/src/index.js';
import { toolchain, type Toolchain } from '../../core/src/toolchain.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../../deploy/src/guards.js';
import { withEdits } from '../../deploy/src/edit.js';
import { deployFiles, writeDeployTree, type DeployFile } from '../../deploy/src/plan.js';
import type { ProjectRegistry } from '../../deploy/src/registry.js';
import { generateReactApp } from '../../ui-react/src/generate.js';

export interface FileHash {
  path: string;
  sha256: string;
}

export interface Manifest {
  node: string;
  typescript: string;
  files: FileHash[];
}

/** Synthetic org stamped into hashed trees so catalyst.json bytes stay stable. Not an allow-list. */
const FIXTURE_ORG = '10000000000';
const FIXTURE_PROJECT_ID = '00000000000000000';
const FIXTURE_REGISTRY: ProjectRegistry = { org: FIXTURE_ORG, env: 'Development', projects: {}, dc: 'us' };

export function loadApp(target: string): App {
  return withEdits(parseFileOrProject(target).ir, target);
}

/**
 * The full generated tree for an app, as the deploy bundle writes it, under the
 * fixture guard, plus the React UI target under web/ (docs/react-target.md).
 */
export function treeFiles(target: string): readonly DeployFile[] {
  const app = loadApp(target);
  const guard: GuardOk = {
    org: FIXTURE_ORG,
    projectId: FIXTURE_PROJECT_ID,
    environment: ALLOWED_ENV,
    projectName: catalystProjectName(app.name || 'app'),
    dc: 'us',
    registry: FIXTURE_REGISTRY,
  };
  // deployFiles, not buildDeploy: tableCreatePlan throws on a foreign-key cycle
  // and that throw is not part of the written tree.
  const react = generateReactApp(app).map((file) => ({ path: `web/${file.path}`, data: file.data }));
  return [...deployFiles(app, guard, false).files, ...react];
}

/** Write the generated tree to disk, for the CI gate that hashes two clean runs. */
export function writeTree(target: string, out: string): void {
  writeDeployTree(out, treeFiles(target));
}

export function manifestFor(target: string, pin: Toolchain = toolchain()): Manifest {
  const bundle = treeFiles(target);
  const byPath = new Map<string, string>();
  for (const file of bundle) {
    const hash = createHash('sha256').update(file.data).digest('hex');
    const prev = byPath.get(file.path);
    if (prev !== undefined && prev !== hash) {
      throw new Error(`duplicate path with different bytes: ${file.path}`);
    }
    byPath.set(file.path, hash);
  }
  const files = [...byPath.entries()]
    .map(([path, sha256]) => ({ path, sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { node: pin.node, typescript: pin.typescript, files };
}

export function digestOf(manifest: Manifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

/**
 * The committed manifest form: one "<sha256>  <path>" line per generated file,
 * sorted by path, newline-terminated — the same canonical form as the vendor
 * MANIFEST.sha256 and the per-run listing the two-runs gate writes. Sorted
 * single-purpose lines keep a regenerated manifest readable in review and let
 * changes to unrelated generated files apply to disjoint lines.
 * The toolchain pins are not stored: they are already hashed inside the tree
 * as c2c-build.txt, and npm test asserts them against package.json.
 */
export function renderManifest(manifest: Manifest): string {
  return manifest.files.map((file) => `${file.sha256}  ${file.path}`).join('\n') + '\n';
}

/**
 * Parse a committed manifest back into its FileHash list. Strict on canonical
 * form so a regenerated file is byte-stable: newline-terminated, one
 * "<64-hex>  <path>" line per file, paths sorted, unique, relative and
 * non-escaping.
 */
export function parseManifestFiles(text: string): FileHash[] {
  if (!text.endsWith('\n')) throw new Error('manifest is not newline-terminated');
  const files: FileHash[] = [];
  let prev = '';
  for (const line of text.slice(0, -1).split('\n')) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`manifest line is not "<sha256>  <path>": ${line.slice(0, 80)}`);
    const path = match[2]!;
    if (path !== path.trim() || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
      throw new Error(`manifest lists a bad path: ${path}`);
    }
    if (prev !== '' && path <= prev) throw new Error(`manifest paths are not sorted and unique: ${path} follows ${prev}`);
    files.push({ path, sha256: match[1]! });
    prev = path;
  }
  if (files.length === 0) throw new Error('manifest lists no files');
  return files;
}

export function diffManifest(expected: Manifest, actual: Manifest): string[] {
  const lines: string[] = [];
  if (expected.node !== actual.node) lines.push(`node ${expected.node} -> ${actual.node}`);
  if (expected.typescript !== actual.typescript) lines.push(`typescript ${expected.typescript} -> ${actual.typescript}`);
  const left = new Map(expected.files.map((file) => [file.path, file.sha256]));
  const right = new Map(actual.files.map((file) => [file.path, file.sha256]));
  for (const [path, sha] of left) {
    if (!right.has(path)) lines.push(`removed ${path}`);
    else if (right.get(path) !== sha) lines.push(`changed ${path}`);
  }
  for (const path of right.keys()) if (!left.has(path)) lines.push(`added ${path}`);
  return lines;
}
