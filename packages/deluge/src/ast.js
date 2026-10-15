/** Deluge AST. Offsets are into the script string passed to `parse`, not the .ds file. */
export function stmtSpan(s) {
    return s.span;
}
