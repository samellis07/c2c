/**
 * Exit codes the c2c CLI returns. docs/guide/06-troubleshooting.md documents
 * each one for customers; tests/plugin/exit-codes-parity.test.mjs fails when
 * the two disagree.
 */

/** precheck exit codes: input errors never share a code with "has blockers". */
export const PRECHECK_EXIT = { clean: 0, blockers: 1, missing: 3, unparsable: 4 } as const;

/** Exit codes shared by the other commands. */
export const CLI_EXIT = {
  /** The export file for parse, analyze, plan and the other IR commands was not found. */
  inputMissing: 1,
  /** The export is a locked Marketplace install (not a convertible .ds). */
  lockedExport: 2,
  /** fill-todos refused a fill. */
  fillTodoRefused: 2,
  /** cutover-checklist/cutover-proof input not found, or iac-drift could not read or parse a template. */
  inputUnreadable: 3,
} as const;
