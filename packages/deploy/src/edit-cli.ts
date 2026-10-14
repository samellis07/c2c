/**
 * `c2c edit <file|dir> <op> ...`: one model edit, its plan diff, and (with
 * --apply) the edits log entry. Dry run by default. Offline: the diff is
 * computed from two generated plans and nothing is sent to Catalyst.
 *
 *   add-field <Form> <Field> --type <type> [--label <text>] [--required] [--unique] [--choices a,b] [--lookup <Form>[.<Field>]]
 *   rename-field <Form> <From> <To>
 *   remove-field <Form> <Field>                (--apply needs --confirm: the column is dropped)
 *   set-picklist <Form> <Field> --choices a,b
 *   add-report-column <Report> <Field> [--label <text>]
 *   add-role <Role> [--parent <Role>] [--description <text>]
 *
 * Common: [--dc <dc>] [--edits <file>] [--out <dir>] [--json] [--apply] [--confirm]
 */
import { LockedExportError } from '../../core/src/source.js';
import { flag, loadSource, type Io } from './cli.js';
import { deltaFiles, formatDelta, modelPlan, planDelta, writeDeltaTree } from './delta.js';
import { applyEdit, applyEdits, EditError, editsPathFor, readEdits, writeEdits, type EditOp } from './edit.js';
import { resolveDc } from './offline-plan.js';

const USAGE =
  'usage: c2c edit <file|dir> <op> ... [--dc <dc>] [--edits <file>] [--out <dir>] [--json] [--apply] [--confirm]\n' +
  '  add-field <Form> <Field> --type <type> [--label <text>] [--required] [--unique] [--choices a,b] [--lookup <Form>[.<Field>]]\n' +
  '  rename-field <Form> <From> <To>\n' +
  '  remove-field <Form> <Field>\n' +
  '  set-picklist <Form> <Field> --choices a,b\n' +
  '  add-report-column <Report> <Field> [--label <text>]\n' +
  '  add-role <Role> [--parent <Role>] [--description <text>]\n';

const VALUE_FLAGS = new Set(['--type', '--label', '--choices', '--choice', '--lookup', '--parent', '--description', '--dc', '--edits', '--out']);
const BOOL_FLAGS = new Set(['--required', '--unique', '--apply', '--confirm', '--json']);

const ARITY: Record<string, number> = {
  'add-field': 2,
  'rename-field': 3,
  'remove-field': 2,
  'set-picklist': 2,
  'add-report-column': 2,
  'add-role': 1,
};

function positionals(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith('--')) continue;
    out.push(arg);
  }
  return out;
}

function choicesFrom(args: readonly string[]): string[] | undefined {
  const list: string[] = [];
  let seen = false;
  args.forEach((arg, i) => {
    const value = args[i + 1];
    if (value === undefined) return;
    if (arg === '--choices') {
      seen = true;
      list.push(...value.split(','));
    } else if (arg === '--choice') {
      seen = true;
      list.push(value);
    }
  });
  return seen ? list.map((c) => c.trim()) : undefined;
}

/** Build one typed op from the command words. Usage errors are EditErrors with the usage line. */
export function opFromArgs(name: string, words: readonly string[], args: readonly string[]): EditOp {
  const label = flag(args, '--label');
  switch (name) {
    case 'add-field': {
      const type = flag(args, '--type') ?? (flag(args, '--lookup') !== undefined ? 'lookup' : undefined);
      if (!type) throw new EditError('add-field needs --type <type> (or --lookup <Form>)');
      const choices = choicesFrom(args);
      const lookup = flag(args, '--lookup');
      return {
        op: 'addField',
        form: words[0]!,
        field: words[1]!,
        type,
        ...(label !== undefined ? { label } : {}),
        ...(args.includes('--required') ? { required: true } : {}),
        ...(args.includes('--unique') ? { unique: true } : {}),
        ...(choices ? { choices } : {}),
        ...(lookup !== undefined ? { lookup } : {}),
      };
    }
    case 'rename-field':
      return { op: 'renameField', form: words[0]!, from: words[1]!, to: words[2]! };
    case 'remove-field':
      return { op: 'removeField', form: words[0]!, field: words[1]! };
    case 'set-picklist': {
      const choices = choicesFrom(args);
      if (!choices) throw new EditError('set-picklist needs --choices a,b,c');
      return { op: 'setPicklist', form: words[0]!, field: words[1]!, choices };
    }
    case 'add-report-column':
      return { op: 'addReportColumn', report: words[0]!, field: words[1]!, ...(label !== undefined ? { label } : {}) };
    case 'add-role': {
      const parent = flag(args, '--parent');
      const description = flag(args, '--description');
      return { op: 'addRole', role: words[0]!, ...(parent !== undefined ? { parent } : {}), ...(description !== undefined ? { description } : {}) };
    }
    default:
      throw new EditError(`unknown edit op "${name}"`);
  }
}

/**
 * Exit 0 when the diff is printed (and, with --apply, recorded), 1 when the
 * model refuses the edit or a drop lacks --confirm, 2 on usage and DC errors.
 */
export function editCli(args: readonly string[], io: Pick<Io, 'stdout' | 'stderr'>, cwd = process.cwd()): number {
  for (const arg of args) {
    if (arg.startsWith('--') && !VALUE_FLAGS.has(arg) && !BOOL_FLAGS.has(arg)) {
      io.stderr(`c2c edit: unknown option ${arg}\n${USAGE}`);
      return 2;
    }
  }
  const [target, name, ...words] = positionals(args);
  if (!target || !name || ARITY[name] === undefined || words.length !== ARITY[name]) {
    io.stderr(USAGE);
    return 2;
  }
  let dc: string;
  try {
    dc = resolveDc(args, cwd).dc;
  } catch (err) {
    io.stderr(`c2c edit: ${err instanceof Error ? err.message.replace(/^c2c plan: /, '') : 'data centre lookup failed'}\n`);
    return 2;
  }
  let op: EditOp;
  try {
    op = opFromArgs(name, words, args);
  } catch (err) {
    io.stderr(`c2c edit: ${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }
  const editsPath = flag(args, '--edits') ?? editsPathFor(target);
  try {
    const log = readEdits(editsPath);
    const source = loadSource(target);
    const before = applyEdits(source, log.edits);
    const after = applyEdit(before.app, op);
    const app = before.app.name || 'app';
    const oldPlan = modelPlan(before.app, dc);
    const newPlan = modelPlan(after.app, dc);
    const delta = planDelta(oldPlan, newPlan, { app, edits: [...log.edits, op], renames: after.renames });
    io.stdout(args.includes('--json') ? `${JSON.stringify(delta, null, 2)}\n` : formatDelta(delta));
    const out = flag(args, '--out');
    if (out) {
      writeDeltaTree(out, deltaFiles(delta, newPlan));
      io.stdout(`delta: ${out}/delta.md\n`);
    }
    if (!args.includes('--apply')) {
      io.stdout('dry run: nothing recorded. Pass --apply to add this edit to the model.\n');
      return 0;
    }
    if (delta.needsConfirm && !args.includes('--confirm')) {
      io.stderr('c2c edit: this edit drops data store columns or tables; pass --confirm with --apply to record it\n');
      return 1;
    }
    writeEdits(editsPath, { version: 1, edits: [...log.edits, op] });
    io.stdout(`recorded: edit ${log.edits.length + 1} in ${editsPath}\n`);
    return 0;
  } catch (err) {
    if (err instanceof EditError) {
      io.stderr(`c2c edit: refused: ${err.message}\n`);
      return 1;
    }
    if (err instanceof LockedExportError) {
      io.stderr(`c2c: ${err.message}\n`);
      return 2;
    }
    io.stderr(`c2c edit: ${err instanceof Error ? err.message : 'edit failed'}\n`);
    return 1;
  }
}
