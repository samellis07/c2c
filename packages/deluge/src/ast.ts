/** Deluge AST. Offsets are into the script string passed to `parse`, not the .ds file. */

export interface Span {
  start: number;
  end: number;
}

export interface Param {
  key: string;
  value: Expr;
  span: Span;
}

export type Stmt =
  | { kind: 'block'; body: Stmt[]; span: Span }
  | { kind: 'if'; test: Expr; then: Stmt; elifs: { test: Expr; body: Stmt }[]; else?: Stmt; span: Span }
  | { kind: 'forEach'; index?: string; /** `for each index i in l`: the loop variable holds the 0-based index, not the element. */ iteratesIndex?: boolean; name: string; collection: Expr; body: Stmt; span: Span }
  | { kind: 'while'; test: Expr; body: Stmt; span: Span }
  | { kind: 'try'; body: Stmt; catchName?: string; catchBody?: Stmt; span: Span }
  | { kind: 'return'; value?: Expr; span: Span }
  | { kind: 'break'; span: Span }
  | { kind: 'continue'; span: Span }
  | { kind: 'info'; value: Expr; span: Span }
  | { kind: 'alert'; value: Expr; span: Span }
  | { kind: 'cancelSubmit'; span: Span }
  | { kind: 'cancelDelete'; span: Span }
  | { kind: 'successMessage'; value: Expr; span: Span }
  | { kind: 'reload'; span: Span }
  | { kind: 'openUrl'; args: Expr[]; span: Span }
  | { kind: 'ui'; action: 'show' | 'hide' | 'enable' | 'disable' | 'clear'; targets: Expr[]; span: Span }
  | { kind: 'deleteFrom'; target: Expr; span: Span }
  | { kind: 'update'; target: Expr; entries: Param[]; span: Span }
  | { kind: 'assign'; declType?: string; op: string; target: Expr; value: Expr; span: Span }
  | { kind: 'expr'; expr: Expr; span: Span }
  | { kind: 'fn'; retType?: string; name: string; params: { type?: string; name: string }[]; body: Stmt; span: Span }
  | { kind: 'unknown'; text: string; reason: string; span: Span };

/**
 * One item in a sendmail `attachments:` spec.
 * https://www.zoho.com/deluge/help/misc-statements/send-mail.html
 * - `file:` an invoked/uploaded file (`value`)
 * - `view:` / `report:` a report render (`name`, optional `criteria`, `format`)
 * - `template:` a record template (`name`; custom functions add `form` + `record`)
 */
export interface MailAttachment {
  type: 'file' | 'view' | 'report' | 'template';
  value?: Expr;
  name?: string;
  criteria?: Expr | null;
  form?: string | null;
  record?: Expr | null;
  format?: string | null;
  span: Span;
}

export type Expr =
  | { kind: 'number'; text: string; span: Span }
  | { kind: 'string'; value: string; span: Span }
  | { kind: 'date'; value: string; span: Span }
  | { kind: 'name'; name: string; span: Span }
  | { kind: 'list'; elements: Expr[]; span: Span }
  | { kind: 'map'; entries: { key: Expr; value: Expr }[]; span: Span }
  | { kind: 'unary'; op: string; expr: Expr; span: Span }
  | { kind: 'binary'; op: string; left: Expr; right: Expr; span: Span }
  | { kind: 'member'; object: Expr; property: string; span: Span }
  | { kind: 'call'; callee: Expr; args: Expr[]; typeArgs?: string[]; span: Span }
  | { kind: 'index'; object: Expr; index: Expr; span: Span }
  | { kind: 'criteria'; object: Expr; criteria: Expr; sort?: { field: string; dir?: string; fields?: { field: string; dir?: string }[] }; range?: { from: Expr; to: Expr }; span: Span }
  | { kind: 'insert'; form: Expr; entries: Param[]; span: Span }
  | { kind: 'invokeurl'; entries: Param[]; span: Span }
  | { kind: 'sendmail'; entries: Param[]; span: Span }
  | { kind: 'pushnotification'; entries: Param[]; span: Span }
  | { kind: 'mailAttachments'; items: MailAttachment[]; span: Span }
  | { kind: 'colonCall'; object: Expr; path: string[]; args: Expr[]; span: Span }
  | { kind: 'paren'; expr: Expr; span: Span }
  | { kind: 'ifExpr'; test: Expr; then: Expr; else?: Expr; span: Span }
  | { kind: 'relative'; spec: string; span: Span }
  | { kind: 'unknown'; text: string; reason: string; span: Span };

export interface Script {
  body: Stmt[];
  span: Span;
}

export function stmtSpan(s: Stmt): Span {
  return s.span;
}
