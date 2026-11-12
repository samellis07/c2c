import { flag } from './cli.js';

/** The directory both `c2c plan` and `c2c provision` use when --out is omitted. */
export const DEFAULT_PLAN_OUT = 'c2c-out';

/** Resolve the plan tree directory identically for its writer and consumer. */
export function resolvePlanOut(args: readonly string[]): string {
  return flag(args, '--out') ?? DEFAULT_PLAN_OUT;
}
