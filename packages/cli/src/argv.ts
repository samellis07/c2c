/**
 * The argument contract of the live c2c commands (deploy, provision, smoke,
 * migrate-data, seed, doctor, rollback-export, cutover-checklist, proof,
 * iac-drift, ...): the flags each one accepts and whether a flag
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
  /** How many leading positionals the command takes (the app source; iac-drift's two templates). */
  positional: 'none' | 'optional' | 'required' | 'pair';
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

/**
 * Commands gated on a green, current, same-scope doctor.json in c2c.ts and the
 * flags required before doctorGateRefusal refuses with exit 5.
 */
export const DOCTOR_GATE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  provision: ['--confirm'],
  deploy: ['--confirm'],
  'migrate-data': ['--confirm'],
  users: ['--confirm'],
  smoke: ['--confirm'],
  'sync-delta': ['--confirm'],
  'rollback-export': ['--confirm'],
  'verify-behavior': ['--live', '--confirm'],
  edit: ['--apply', '--confirm'],
};

/** cutover-checklist and proof read the same options. */
const CUTOVER_FLAGS: Readonly<Record<string, Arity>> = {
  '--config': 'value',
  '--dc': 'value',
  '--org': 'value',
  '--project': 'value',
  '--projects': 'value',
  '--allow-empty': 'bool',
  '--out': 'value',
  '--rollback': 'value',
  '--rollback-export': 'value',
  '--rollback-manifest': 'value',
  '--since': 'value',
  '--smoke': 'value',
  '--source-backup': 'value',
  '--source-csv': 'value',
  '--source-json': 'value',
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
      '--async-on-success': 'bool',
      '--subset-shims': 'bool',
      '--backfill-shadows': 'bool',
      '--catalyst-base': 'value',
      '--confirm': 'bool',
      '--edits': 'value',
      '--function-env': 'value',
      '--previous': 'value',
      '--rename': 'value',
      '--mail': 'bool',
      '--mail-from': 'value',
      '--mail-sender-verified': 'bool',
      '--out': 'value',
      '--resume': 'bool',
      '--slate-domain': 'value',
      '--slate-name': 'value',
      '--source-backup': 'value',
      '--source-csv': 'value',
      '--source-json': 'value',
      '--triggers-wired': 'bool',
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
      '--narrow-existing-security': 'bool',
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
      '--users-state': 'value',
    },
  },
  users: {
    positional: 'optional',
    flags: {
      ...SCOPE,
      '--confirm': 'bool',
      '--dry-run': 'bool',
      '--ds': 'value',
      '--email': 'value',
      '--env': 'value',
      '--first-name': 'value',
      '--json': 'bool',
      '--last-name': 'value',
      '--out': 'value',
      '--role': 'value',
      '--role-ids': 'value',
      '--salt': 'value',
      '--slate-domain': 'value',
      '--social': 'value',
      '--source-backup': 'value',
      '--state': 'value',
      '--user-id': 'value',
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
  verify: {
    positional: 'none',
    flags: {
      '--allow-empty': 'bool',
      '--data-parity': 'bool',
      '--ds': 'value',
      '--json': 'bool',
      '--out': 'value',
      '--rows': 'value',
      '--source-backup': 'value',
      '--source-csv': 'value',
      '--source-json': 'value',
    },
  },
  'verify-behavior': {
    positional: 'required',
    flags: {
      '--app': 'value',
      '--config': 'value',
      '--dc': 'value',
      '--org': 'value',
      '--project': 'value',
      '--projects': 'value',
      '--auth-token': 'value',
      '--catalyst-base': 'value',
      '--confirm': 'bool',
      '--ds': 'value',
      '--env': 'value',
      '--goldens': 'value',
      '--live': 'bool',
      '--report': 'value',
      '--report-md': 'value',
      '--session-cookie': 'value',
      '--url': 'value',
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
  precheck: {
    positional: 'required',
    flags: {
      '--json': 'bool',
    },
  },
  'rollback-export': {
    positional: 'none',
    flags: {
      ...SCOPE,
      '--catalyst-base': 'value',
      '--confirm': 'bool',
      '--ds': 'value',
      '--env': 'value',
      '--out': 'value',
      '--rows': 'value',
    },
  },
  'cutover-checklist': { positional: 'required', flags: CUTOVER_FLAGS },
  proof: { positional: 'required', flags: CUTOVER_FLAGS },
  'iac-drift': { positional: 'pair', flags: {} },
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
  const most = spec.positional === 'pair' ? 2 : 1;
  if (spec.positional !== 'none' && positionals.length > most) problems.push(`unexpected argument ${positionals[most]}`);
  if (spec.positional === 'required' && (!positionals.length || args[0] !== positionals[0])) problems.push('the app source must come first');
  if (spec.positional === 'pair' && positionals.length < 2) problems.push('two template files are required');
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
    // --backfill-shadows returns before deploy reads the function env.
    if (cmd === 'deploy' && !rest.includes('--backfill-shadows')) readFunctionEnv(valueOf(rest, '--function-env'), rest.includes('--confirm'));
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
