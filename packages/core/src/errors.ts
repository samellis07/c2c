/**
 * User-facing CLI errors carry one stable code (C2C-<AREA>-<NNN>) from
 * plugin/references/error-index.md. `coded()` renders the only error shape
 * the binaries print: the message (with its existing `c2c …:` prefix), the
 * code once, an optional hint line, and one pointer at the index. Logs,
 * warnings, retry lines and command output go through the plain stderr
 * channel and are never coded.
 */
export class C2cError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly exitCode: number | undefined;

  constructor(code: string, message: string, opts: { hint?: string; exitCode?: number } = {}) {
    super(message);
    this.name = 'C2cError';
    this.code = code;
    this.hint = opts.hint;
    this.exitCode = opts.exitCode;
  }
}

/** The one renderer: message, ` [<code>]`, optional hint, one index pointer. */
export function coded(code: string, message: string, hint?: string): string {
  const lines = [`${message.trimEnd()} [${code}]`];
  if (hint !== undefined) lines.push(hint.trimEnd());
  lines.push(`See plugin/references/error-index.md#${code.toLowerCase()}`);
  return `${lines.join('\n')}\n`;
}

export function codedError(err: C2cError): string {
  return coded(err.code, err.message, err.hint);
}

/** Print one coded error through the caller's stderr channel. */
export function printError(stderr: (text: string) => void, code: string, message: string, hint?: string): void {
  stderr(coded(code, message, hint));
}

/**
 * Print a caught error once: a C2cError keeps the code it was thrown with;
 * anything else is an unexpected failure and gets the caller's family code.
 */
export function printCaught(stderr: (text: string) => void, err: unknown, code: string, prefix = 'c2c'): number {
  if (err instanceof C2cError) {
    stderr(codedError(err));
    return err.exitCode ?? 1;
  }
  stderr(coded(code, `${prefix}: ${err instanceof Error ? err.message : String(err)}`));
  return 1;
}
