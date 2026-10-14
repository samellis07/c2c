/**
 * The argument contract of the live c2c commands (deploy, provision, smoke,
 * migrate-data, seed, doctor): the flags each one accepts and whether a flag
 * takes a value. c2c.ts refuses an unknown flag or a value flag without its
 * value with exit 2 before dispatch, so a renamed or dropped flag is an error,
 * never silently ignored.
 *
 * argvProblems() adds each command's own offline argument checks (the same
 * functions the commands run), so a caller that builds c2c argv — a
 * script or a CI job — can validate it without a network call or a login.
 */
import { provisionArgsProblem, readFunctionEnv, seedMigrateArgsProblem, smokeArgsProblems, sourceCsvArgsProblem, statusArgsProblem } from '../../deploy/src/index.js';

type Arity = 'value' | 'bool';

interface CommandSpec {
  /** How many leading positionals the command takes (the app source). */
  positional: 'none' | 'optional' | 'required';
  flags: Readonly<Record<string, Arity>>;
}

/**
 * The project scope flags the doctor gate reads for every gated command
 * (deploy, provision, smoke, migrate-data); deploy, smoke and migrate-data
 * also read --env.
 */
const SCOPE: Readonly<Record<string, Arity>> = {
  '--app': 'value',
  '--config': 'value',
  '--dc': 'value',
  '--org': 'value',
  '--project': 'value',
  '--projects': 'value',
};

export const ARGV_SPEC: Readonly<Record<string, CommandSpec>> = {
  deploy: {
    positional: 'required',
    flags: {
      ...SCOPE,
      '--env': 'value',
      '--admin-email': 'value',
      '--admin-name': 'value',
      '--admin-role': 'value',
      '--admin-role-id': 'value',
      '--allow-empty': 'bool',
      '--api-base': 'value',
      '--backfill-shadows': 'bool',
      '--catalyst-base': 'value',
      '--confirm': 'bool',
      '--edits': 'value',
      '--function-env': 'value',
      '--mail': 'bool',
      '--mail-from': 'value',
      '--mail-sender-verified': 'bool',
      '--out': 'value',
      '--resume': 'bool',
      '--slate-domain': 'value',
      '--source-backup': 'value',
      '--source-csv': 'value',
      '--source-json': 'value',
      '--ui': 'value',
    },
  },
  provision: {
    positional: 'none',
    flags: {
      ...SCOPE,
      '--applied': 'bool',
      '--confirm': 'bool',
      '--domain': 'value',
      '--import': 'bool',
      '--name': 'value',
      '--next': 'bool',
      '--out': 'value',
      '--record': 'value',
      '--result': 'value',
      '--run': 'value',
      '--status': 'bool',
    },
  },
  smoke: {
    positional: 'optional',
    flags: {
      ...SCOPE,
      '--auth-token': 'value',
      '--browser-cdp': 'value',
      '--catalyst-base': 'value',
      '--cdp': 'bool',
      '--confirm': 'bool',
      '--ds': 'value',
      '--env': 'value',
      '--in-browser': 'bool',
      '--max-age': 'value',
      '--owner-session': 'bool',
      '--report': 'value',
      '--result': 'value',
      '--result-code': 'value',
      '--session-cookie': 'value',
      '--url': 'value',
    },
  },
  'migrate-data': {
    positional: 'none',
    flags: {
      ...SCOPE,
      '--allow-empty': 'bool',
      '--catalyst-base': 'value',
      '--checkpoint': 'value',
      '--confirm': 'bool',
      '--creator-base': 'value',
      '--dry-run': 'bool',
      '--ds': 'value',
      '--env': 'value',
      '--login-user': 'value',
      '--owner': 'value',
      '--report': 'value',
      '--seed': 'value',
      '--source-backup': 'value',
      '--source-csv': 'value',
      '--source-json': 'value',
    },
  },
  seed: {
    positional: 'required',
    flags: {
      '--creator-import': 'bool',
      '--json': 'bool',
      '--n': 'value',
      '--out': 'value',
      '--rows': 'value',
      '--seed': 'value',
    },
  },
  status: {
    positional: 'none',
    flags: {
      '--app': 'value',
      '--fake': 'bool',
      '--json': 'bool',
      '--org': 'value',
      '--project': 'value',
      '--table-budget': 'value',
    },
  },
  doctor: {
    positional: 'optional',
    flags: {
      '--app': 'value',
      '--config': 'value',
      '--creator-dc': 'value',
      '--creator-host': 'value',
      '--dc': 'value',
      '--json': 'bool',
      '--local': 'bool',
      '--mcp-begin': 'bool',
      '--mcp-observed': 'value',
      '--operator': 'bool',
      '--org': 'value',
      '--project': 'value',
      '--quiet': 'bool',
      '--record-mcp': 'value',
      '--source-csv': 'value',
      '--ui': 'value',
    },
  },
};

/**
 * Shape check against ARGV_SPEC: unknown flags, a value flag with no value,
 * a missing or extra positional. Empty for a command without a spec.
 */
export function argvShapeProblems(cmd: string, args: readonly string[]): string[] {
  const spec = ARGV_SPEC[cmd];
  if (!spec) return [];
  const problems: string[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const arity = spec.flags[arg];
    if (arity === undefined) {
      problems.push(`unknown flag ${arg}`);
      continue;
    }
    if (arity === 'value') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) problems.push(`${arg} needs a value`);
      else i += 1;
    }
  }
  if (spec.positional === 'none' && positionals.length) problems.push(`unexpected argument ${positionals[0]}`);
  if (spec.positional !== 'none' && positionals.length > 1) problems.push(`unexpected argument ${positionals[1]}`);
  if (spec.positional === 'required' && (!positionals.length || args[0] !== positionals[0])) problems.push('the app source must come first');
  return problems;
}

function valueOf(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  const value = at >= 0 ? args[at + 1] : undefined;
  return value === undefined || value.startsWith('--') ? undefined : value;
}

/** seed's own argument rules: the refusal message, or undefined. */
export function seedArgsProblem(args: readonly string[]): string | undefined {
  const n = valueOf(args, '--n');
  if (n !== undefined && (!Number.isInteger(Number(n)) || Number(n) < 0)) return 'c2c seed: --n must be a non-negative integer';
  if (!valueOf(args, '--out')) return 'c2c seed: --out directory is required';
  return undefined;
}

/**
 * Every offline problem with `c2c <cmd> <args>`: the shape check, then the
 * command's own argument rules. Reads no network and no login; deploy's
 * --function-env <file> is read as the command reads it.
 */
export function argvProblems(cmd: string, args: readonly string[]): string[] {
  if (!ARGV_SPEC[cmd]) return [`c2c has no ${cmd} command with an argument contract`];
  const problems = argvShapeProblems(cmd, args);
  const rest = args[0] !== undefined && !args[0].startsWith('--') ? args.slice(1) : args;
  const trimmed = (text: string | undefined) => text?.trim().split('\n')[0];
  try {
    if (cmd === 'deploy') readFunctionEnv(valueOf(rest, '--function-env'), rest.includes('--confirm'));
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  if (cmd === 'provision') {
    const problem = trimmed(provisionArgsProblem(args));
    if (problem) problems.push(problem);
  }
  if (cmd === 'smoke') {
    if (args[0]?.startsWith('--') !== false && !valueOf(rest, '--ds')) problems.push('smoke needs the app source');
    const found = smokeArgsProblems(rest);
    for (const problem of [found.session, found.cdp, found.url]) if (problem) problems.push(problem);
  }
  if (cmd === 'migrate-data' && (args.includes('--source-csv') || args.includes('--source-json'))) {
    const problem = sourceCsvArgsProblem(args);
    if (problem) problems.push(problem === 'usage' ? 'migrate-data --source-csv/--source-json needs the data dir and --ds' : problem);
  }
  if (cmd === 'migrate-data' && args.includes('--seed') && !args.includes('--source-csv') && !args.includes('--source-json')) {
    const problem = seedMigrateArgsProblem(args);
    if (problem) problems.push(problem === 'usage' ? 'migrate-data --seed needs the seed file and --ds or --app' : problem);
  }
  if (cmd === 'seed') {
    const problem = seedArgsProblem(rest);
    if (problem) problems.push(problem);
  }
  if (cmd === 'status') {
    const problem = trimmed(statusArgsProblem(args));
    if (problem) problems.push(problem);
  }
  return problems;
}
