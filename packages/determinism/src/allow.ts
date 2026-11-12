/**
 * Allow-list for codegen the determinism gate must not edit.
 * Inline `determinism-allow:` comments are preferred. This list is only for
 * files an open pull request owns (dispatch.ts / translate.ts).
 */
export interface ExternalAllow {
  /** Repo-relative path, forward slashes. */
  file: string;
  /** Snippet that must appear at the finding. */
  snippet: string;
  kind: 'clock' | 'iteration' | 'locale';
  justification: string;
}

export const EXTERNAL_ALLOW: readonly ExternalAllow[] = [
  {
    file: 'packages/deluge/src/translate.ts',
    snippet: '[...new Set(',
    kind: 'iteration',
    // The spread dedupes `reads` in AST walk order
    // (source order). That order reaches emitBinding and stays deterministic.
    justification:
      'The Set spread dedupes reads in AST walk (source) order, which is deterministic.',
  },
  {
    file: 'packages/ui/src/client-runtime.js',
    snippet: 'place.forEach((at, field) => {',
    kind: 'iteration',
    // client-runtime.js is copied byte-for-byte into every generated app, so an
    // inline comment here would shift every committed runtime hash. `place`'s
    // insertion order mirrors the `phone` array's own order set just above, so
    // the forEach order is already deterministic source order.
    justification:
      "place's insertion order mirrors the phone array's order, so forEach order is deterministic source order.",
  },
];
