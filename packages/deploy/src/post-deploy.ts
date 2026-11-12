/**
 * Post-deploy steps a human must do in the Catalyst console.
 * Data Store, Functions, Slate, and Authentication show created resources immediately.
 * A fresh project may still need a first-use enable for Job Scheduling, Stratus, or Signals.
 */
import { API_FUNCTION } from './function-dir.js';
import type { DeployCommand } from './plan.js';
import { backfillCommand } from './shadows.js';
import type { TableDiff } from './tables.js';

/** Console service names, in the order the steps list them. */
export const CONSOLE_SERVICES = ['Data Store', 'Functions', 'Web Client Hosting (Slate)', 'Authentication', 'Cron', 'Cache', 'Stratus', 'API Gateway', 'AppSail'] as const;
export type ConsoleService = (typeof CONSOLE_SERVICES)[number];

/** `catalyst deploy --only <target>` targets → console service. */
const DEPLOY_TARGETS: Readonly<Record<string, ConsoleService>> = {
  functions: 'Functions',
  client: 'Web Client Hosting (Slate)',
  slate: 'Web Client Hosting (Slate)',
  cron: 'Cron',
  apig: 'API Gateway',
  appsail: 'AppSail',
};

export interface PostDeployStep {
  /**
   * configure: console settings the deploy cannot make;
   * backfill: shadow columns added to tables that already had rows; resume: re-run after a failure.
   */
  kind: 'configure' | 'backfill' | 'resume';
  projectId: string;
  services: ConsoleService[];
  text: string;
}

/** Services a run touched: Data Store when tables or columns were created, plus each CLI deploy target. */
export function servicesTouched(input: {
  createdTables?: readonly string[];
  createdColumns?: readonly string[];
  commands?: readonly Pick<DeployCommand, 'argv'>[];
  /** Services created by other paths (cache segments, Stratus buckets, …). */
  extra?: readonly ConsoleService[];
  /** The Slate client signs users in with Catalyst Authentication, so deploying it or the function touches Authentication. */
  auth?: boolean;
}): ConsoleService[] {
  const hit = new Set<ConsoleService>(input.extra ?? []);
  if ((input.createdTables?.length ?? 0) > 0 || (input.createdColumns?.length ?? 0) > 0) hit.add('Data Store');
  for (const { argv } of input.commands ?? []) {
    if (argv.includes('slate:link')) hit.add('Web Client Hosting (Slate)');
    const deploy = argv.indexOf('deploy');
    if (deploy < 0) continue;
    const only = argv.indexOf('--only');
    const targets = only >= 0 ? (argv[only + 1] ?? '').split(',') : [argv[deploy + 1] ?? ''];
    for (const target of targets) {
      // functions:c2c_api names one function of the functions target.
      const service = DEPLOY_TARGETS[target.trim().split(':')[0] ?? ''];
      if (service) hit.add(service);
    }
  }
  if (input.auth && (hit.has('Functions') || hit.has('Web Client Hosting (Slate)'))) hit.add('Authentication');
  return CONSOLE_SERVICES.filter((service) => hit.has(service));
}

/**
 * The Authentication settings when Authentication was touched (docs/deploy-functions.md),
 * then a resume step after a failed run. None when nothing was created.
 */
export function postDeploySteps(
  projectId: string,
  services: readonly ConsoleService[],
  opts: { resume?: boolean; shadowsOnExistingRows?: TableDiff['shadowsOnExistingRows']; org?: string } = {},
): PostDeployStep[] {
  if (!services.length) return [];
  const steps: PostDeployStep[] = [];
  const configure = (service: ConsoleService, text: string): void => {
    steps.push({ kind: 'configure', projectId, services: [service], text });
  };
  if (services.includes('Authentication')) {
    // The enable and CORS writes go through the admin REST API on --confirm; the CLI
    // token cannot read auth config or the domain list back, so the console step is a confirm.
    configure('Authentication', 'Authentication: deploy POSTs /authentication/enable (hosted + embedded, public signup off) and /cors-domain (Slate host, CORS on, iFrame on — the embedded sign-in frame needs it) — the CLI token cannot read them back, so confirm them in the console.');
    // The CLI holds the security.rules.Update scope but ships no command for
    // it, so the rule stays a console step with the exact location. Listing
    // functions does not expose the rule — the deploy cannot verify it.
    if (services.includes('Functions'))
      configure('Functions', `Serverless > Security Rules JSON: ${API_FUNCTION} '.*' authentication = required (List_All_Functions cannot verify it)`);
    configure('Authentication', `Users: on a fresh project (no app users yet, GET /role refused for the CLI token) the first admin is added with console Add User — deploy prints the exact values (Role, Platform = Web, Component = Slate + the app, Deployment = default, Redirect URL = the Slate app URL); with --admin-role-id or a role-readable token deploy sends POST /project-user instead. Either way deploy verifies the admin through GET /project-user once they accept the invite and sign in.`);
    if (services.includes('Web Client Hosting (Slate)')) {
      configure(
        'Web Client Hosting (Slate)',
        'Sign-in check: open the Slate app URL — the sign-in box must show the Catalyst sign-in page, not the app itself or a blank box. A blank box means iFrame is off for the host: Authentication > Whitelisting > the Slate host > Edit > iFrame on, then reload.',
      );
    }
  }
  const stale = opts.shadowsOnExistingRows ?? [];
  if (stale.length) {
    const named = stale.map((item) => `${item.table}.${item.shadow} (${item.rows === undefined ? 'row count unknown' : `${item.rows} rows`})`).join(', ');
    steps.push({
      kind: 'backfill',
      projectId,
      services: ['Data Store'],
      text: `Data Store: shadow columns were added to tables that already have rows: ${named}. Those rows have a NULL shadow, so every decimal criteria on them reads them all and checks the varchar. Run: ${backfillCommand(projectId, opts.org)}`,
    });
  }
  if (opts.resume) steps.push({ kind: 'resume', projectId, services: [], text: 'then re-run this command with --resume; finished steps are skipped.' });
  return steps;
}

export function formatPostDeploySteps(steps: readonly PostDeployStep[], ran: boolean): string {
  const head = ran ? 'post-deploy (console):' : 'post-deploy (console, after --confirm):';
  return `${[head, ...(steps.length ? steps.map((step) => `- ${step.text}`) : ['- none'])].join('\n')}\n`;
}
