/**
 * Catalyst Mail for sendmail.
 *
 * Two switches must both be on before a message is sent: the function runs live
 * (c2c-deploy.json mode, so the runtime calls the mail adapter at all) and deploy
 * ran with --mail. Recipients come from c2c-deploy.json `mail.testRecipients`
 * (default empty, which sends to nobody). Every recipient (to, cc, bcc) must be
 * on that list, and the sender must be a verified Catalyst Mail sender. Every
 * call the function receives, sent or not, writes one row to the delivery log
 * table. The table exists only then: deploy creates it for an app that sends
 * mail and was deployed with --mail, and with mail off nothing is written to it.
 *
 * Sender verification is observed live, never asserted: the owner verifies the
 * sender in the Catalyst console (Mail > Email Configuration, or a DKIM/SPF
 * domain) and a confirmed deploy reads the state back (GET /email, the same
 * list List_All_Emails_Configuration answers), persisting it under
 * c2c-out/.c2c/. --mail-sender-verified and c2c-deploy.json `mail.verified`
 * record the owner's attestation only. Precheck rule `mail-sender-unverified`
 * blocks a confirmed --mail deploy until the read-back reports VERIFIED.
 * Catalyst documents both "throws" and "accepted but never delivered" for an
 * unverified sender, so c2c refuses before the call.
 * https://docs.catalyst.zoho.com/en/cloud-scale/help/mail/introduction/
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { App } from '../../core/src/ir.js';
import { generate as generateDeluge } from '../../deluge/src/generate.js';
import type { RestFn, TableCreateStep } from './tables.js';

export interface MailConfig {
  enabled: boolean;
  allowlist: readonly string[];
  /** Catalyst Mail sender for zoho.adminuserid mail (C2C_MAIL_FROM). Null until the owner names one. */
  from: string | null;
  /** Senders a live Catalyst read-back reported VERIFIED (attestations never enter this list). */
  verifiedSenders: readonly string[];
}

export interface MailDecision {
  ok: boolean;
  reason: string;
}

export interface MailSender {
  from?: string;
  /** True only when the caller holds read-back evidence that the sender is VERIFIED — never the bare attestation. */
  verified?: boolean;
}

/** Precheck rule id for an app that sends mail without a verified Catalyst Mail sender. */
export const MAIL_SENDER_RULE = 'mail-sender-unverified';

/**
 * A sender address as findings and logs may carry it: first letter and
 * domain only (`s***@example.com`). Findings get pasted into chats and the
 * delivery log is a Data Store table — the full address never prints.
 */
export function maskMailAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return address ? '***' : '';
  return `${address[0]}***${address.slice(at)}`;
}

/** Canonical failure detail shared by precheck and generated runtime. */
export function mailSenderFailure(from: string | null | undefined): string {
  return from ? `the app sends mail and sender ${maskMailAddress(from)} is not marked verified` : 'the app sends mail and no Catalyst Mail sender is set';
}
/** Delivery log: one row per sendmail the live function receives. */
export const MAIL_LOG_TABLE = 'c2c_mail_log';
const MAIL_DOC = 'https://docs.catalyst.zoho.com/en/cloud-scale/help/mail/introduction/';

function isRecipientList(value: MailSender | readonly string[]): value is readonly string[] {
  return Array.isArray(value);
}

/**
 * Allow-list is `mail.testRecipients` (default empty). The second argument is
 * either that list or a sender attestation; when it is a sender, the third
 * argument is the recipient list.
 */
export function mailConfig(
  enabled: boolean,
  senderOrRecipients: MailSender | readonly string[] = {},
  testRecipients?: readonly string[],
): MailConfig {
  const fromList = isRecipientList(senderOrRecipients) ? senderOrRecipients : testRecipients ?? [];
  const sender: MailSender = isRecipientList(senderOrRecipients) ? {} : senderOrRecipients;
  const from = sender.from?.trim() || null;
  return { enabled, allowlist: [...fromList], from, verifiedSenders: from && sender.verified ? [from] : [] };
}

export function decideMail(config: Pick<MailConfig, 'enabled' | 'allowlist'> | undefined, recipients: readonly string[]): MailDecision {
  if (!config || config.enabled !== true) return { ok: false, reason: 'mail disabled' };
  const allow = config.allowlist;
  if (allow.length === 0) return { ok: false, reason: 'no test recipients configured' };
  if (recipients.length === 0) return { ok: false, reason: 'no recipient' };
  for (const recipient of recipients) {
    if (!allow.includes(recipient)) return { ok: false, reason: 'recipient not allowlisted' };
  }
  return { ok: true, reason: 'allowlisted' };
}

function addressList(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return list.flatMap((item) => String(item).split(/[,;]/)).map((item) => item.trim()).filter((item) => item.length > 0);
}

/** Every destination of a message: to (or recipients/recipient), cc and bcc. */
export function recipientsOf(message: unknown): string[] {
  if (!message || typeof message !== 'object') return [];
  const record = message as Record<string, unknown>;
  return [...addressList(record.to ?? record.recipients ?? record.recipient), ...addressList(record.cc), ...addressList(record.bcc)];
}

export interface MailFinding {
  check: typeof MAIL_SENDER_RULE;
  severity: 'blocker' | 'warning';
  message: string;
  fix: string;
  see: string;
}

/** True when a generated function calls the mail shim. */
export function sendsMail(sources: readonly string[]): boolean {
  return sources.some((source) => source.includes('shim.mail.send('));
}

function appSendsMail(app: App): boolean {
  return sendsMail(generateDeluge(app).files.map((file) => file.source));
}

/**
 * Sender precheck for an app that sends mail. With --mail on, a missing or
 * unverified sender is a blocker: a confirmed deploy refuses. With mail off,
 * nothing is sent, so it is a warning.
 */
export function mailSenderPrecheck(app: App, config: MailConfig): MailFinding[] {
  if (!appSendsMail(app)) return [];
  const severity = config.enabled ? 'blocker' : 'warning';
  const fix = 'Verify the sender in the Catalyst console (Mail → Email Configuration); a deploy --confirm reads the state back live — mail.verified only records the attestation.';
  if (!config.from) {
    return [{ check: MAIL_SENDER_RULE, severity, message: mailSenderFailure(config.from), fix, see: MAIL_DOC }];
  }
  if (!config.verifiedSenders.includes(config.from)) {
    return [{ check: MAIL_SENDER_RULE, severity, message: mailSenderFailure(config.from), fix, see: MAIL_DOC }];
  }
  return [];
}

export function formatMailFindings(findings: readonly MailFinding[]): string[] {
  return findings.map((finding) => `precheck: ${finding.severity} ${finding.check}: ${finding.message}. ${finding.fix} ${finding.see}`);
}

// ---------- live sender read-back and its persisted evidence ----------
//
// `mail.verified` in c2c-deploy.json (and --mail-sender-verified) is only the
// operator's attestation. A sender counts as verified when the live Catalyst
// read-back — GET /baas/v1/project/<id>/email, the same list
// List_All_Emails_Configuration answers — reports it VERIFIED. A confirmed
// deploy refreshes the record below; dry-runs and the doctor consume it.

/** A one-way tag for a sender address: the address itself never lands in evidence. */
export function mailSenderTag(address: string): string {
  return `sha256:${createHash('sha256').update(address.trim().toLowerCase()).digest('hex').slice(0, 16)}`;
}

export const MAIL_SENDER_EVIDENCE = join('c2c-out', '.c2c', 'mail-sender.json');

/** The recorded read-back: sender tag → the status Catalyst last reported. */
export interface MailSenderEvidence {
  version: 1;
  /** The project the read-back ran against. */
  projectId?: string;
  /** When the read-back ran. */
  at: string;
  senders: Record<string, string>;
}

export function readMailSenderEvidence(workspace: string): MailSenderEvidence | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(workspace, MAIL_SENDER_EVIDENCE), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || typeof record.at !== 'string' || !record.senders || typeof record.senders !== 'object' || Array.isArray(record.senders)) return undefined;
    const senders: Record<string, string> = {};
    for (const [tag, status] of Object.entries(record.senders as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (typeof status === 'string') senders[tag] = status;
    }
    return { version: 1, ...(typeof record.projectId === 'string' ? { projectId: record.projectId } : {}), at: record.at, senders };
  } catch {
    return undefined;
  }
}

export function writeMailSenderEvidence(workspace: string, evidence: MailSenderEvidence): void {
  const path = join(workspace, MAIL_SENDER_EVIDENCE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
}

/**
 * The recorded read-back when it belongs to `projectId`; a record observed
 * against another project, or one that names no project, is ignored.
 */
export function mailSenderEvidenceFor(evidence: MailSenderEvidence | undefined, projectId: string): MailSenderEvidence | undefined {
  return evidence?.projectId === projectId ? evidence : undefined;
}

/** True when the recorded read-back lists `address` VERIFIED. */
export function mailSenderEvidenceVerified(evidence: MailSenderEvidence | undefined, address: string): boolean {
  return evidence?.senders[mailSenderTag(address)]?.toUpperCase() === 'VERIFIED';
}

/**
 * The address/status rows of a GET /baas/v1/project/<id>/email read-back (or
 * the equivalent List_All_Emails_Configuration result): a bare list or the
 * entries under a `data`-style field.
 */
export function mailSenderStatusEntries(body: unknown): { address: string; status: string }[] {
  let list: unknown = body;
  if (list && typeof list === 'object' && !Array.isArray(list)) {
    const record = list as Record<string, unknown>;
    for (const key of ['data', 'emails', 'email_configurations', 'result', 'items']) {
      if (Array.isArray(record[key])) {
        list = record[key];
        break;
      }
    }
  }
  if (!Array.isArray(list)) return [];
  const out: { address: string; status: string }[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const rawAddress = entry.email_address ?? entry.email ?? entry.address ?? entry.from_email;
    const rawStatus = entry.status ?? entry.verification_status;
    if (typeof rawAddress !== 'string' || !rawAddress.trim() || typeof rawStatus !== 'string' || !rawStatus.trim()) continue;
    out.push({ address: rawAddress.trim(), status: rawStatus.trim() });
  }
  return out;
}

/**
 * Read the project's mail sender states live (one GET, nothing else) and
 * persist the observed statuses keyed by sender tag. Returns the evidence
 * record, or undefined when the read could not run or was refused.
 */
export async function observeMailSenders(rest: RestFn, projectId: string, workspace: string): Promise<MailSenderEvidence | undefined> {
  let result;
  try {
    result = await rest({ method: 'GET', path: `/baas/v1/project/${projectId}/email` });
  } catch {
    return undefined;
  }
  if (result.status < 200 || result.status >= 300) return undefined;
  const senders: Record<string, string> = {};
  for (const entry of mailSenderStatusEntries(result.body)) senders[mailSenderTag(entry.address)] = entry.status.toUpperCase();
  const evidence: MailSenderEvidence = { version: 1, projectId, at: new Date().toISOString(), senders }; // determinism-allow: wall-clock timestamp of the live read-back, not generated bytes
  writeMailSenderEvidence(workspace, evidence);
  return evidence;
}

/** Data Store table for the delivery log. Planned only when the app sends mail and mail is on. */
export function mailLogTableStep(): TableCreateStep {
  const column = (column_name: string, data_type: 'varchar' | 'text', mandatory = false) => ({
    table: MAIL_LOG_TABLE,
    column_name,
    data_type,
    ...(data_type === 'varchar' ? { max_length: 255 } : {}),
    is_unique: false,
    is_mandatory: mandatory,
  });
  return {
    table: MAIL_LOG_TABLE,
    form: MAIL_LOG_TABLE,
    nosql: false,
    columns: [
      column('sent_at', 'varchar', true),
      column('status', 'varchar', true),
      column('reason', 'text'),
      column('from_email', 'varchar'),
      column('to_email', 'text'),
      column('subject', 'varchar'),
    ],
  };
}

/**
 * Self-contained function module. It reads ./c2c-mail.json next to it.
 * setMailSdk installs a stand-in for zcatalyst-sdk-node (tests); it receives
 * the request and returns an app with email() and datastore().
 */
export function mailModuleSource(allowlist: readonly string[] = []): string {
  const allow = JSON.stringify([...allowlist]);
  return `import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMailTemplate } from "creator-to-catalyst/shims";

export const MAIL_ALLOWLIST = ${allow};
export const MAIL_LOG_TABLE = ${JSON.stringify(MAIL_LOG_TABLE)};
export const MAIL_SENDER_RULE = ${JSON.stringify(MAIL_SENDER_RULE)};

let installed = null;

export function setMailSdk(next) {
  installed = typeof next === "function" ? next : null;
  return installed;
}

async function catalystApp(req) {
  if (installed) return installed(req);
  const sdk = await import("zcatalyst-sdk-node");
  const catalyst = sdk.default || sdk;
  return catalyst.initialize(req);
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "c2c-mail.json"), "utf8"));
  } catch (err) {
    return null;
  }
}

function readTemplates() {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "c2c-print-templates.json"), "utf8"));
  } catch (err) {
    return null;
  }
}

export function decideMail(config, recipients) {
  if (!config || config.enabled !== true) return { ok: false, reason: "mail disabled" };
  const allow = Array.isArray(config.allowlist) ? config.allowlist : [];
  if (allow.length === 0) return { ok: false, reason: "no test recipients configured" };
  if (JSON.stringify(allow) !== JSON.stringify(MAIL_ALLOWLIST)) return { ok: false, reason: "allowlist is not the deploy allowlist" };
  if (!recipients.length) return { ok: false, reason: "no recipient" };
  for (const recipient of recipients) {
    if (!MAIL_ALLOWLIST.includes(recipient)) return { ok: false, reason: "recipient not allowlisted" };
  }
  return { ok: true, reason: "allowlisted" };
}

function addressList(raw) {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return list.flatMap((item) => String(item).split(/[,;]/)).map((item) => item.trim()).filter((item) => item.length > 0);
}

export function recipientsOf(message) {
  if (!message || typeof message !== "object") return [];
  return [...addressList(message.to ?? message.recipients ?? message.recipient), ...addressList(message.cc), ...addressList(message.bcc)];
}

function senderOf(message) {
  return message && message.from !== undefined && message.from !== null ? String(message.from).trim() : "";
}

// First letter and domain only: refusal reasons are returned to the caller
// and rows are written to the delivery log table, so the full sender address
// never prints or persists for a refused send.
function maskSender(address) {
  const text = String(address ?? "");
  const at = text.lastIndexOf("@");
  return at > 0 ? text[0] + "***" + text.slice(at) : text ? "***" : "";
}

// 'template: ... as inline' descriptors render into the body here and leave
// the attachment list; 'template: ... as pdf' renders the same layout and is
// converted to a PDF attachment below. Everything left over still refuses.
function renderInlineAttachments(message) {
  const raw = message ? message.attachments : undefined;
  const attachments = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === "" ? [] : [raw];
  const leftover = [];
  let body = message && message.message !== undefined && message.message !== null ? String(message.message) : "";
  const catalog = readTemplates();
  for (const item of attachments) {
    if (item && item.kind === "template" && item.rendered === "inline") {
      const html = renderMailTemplate(catalog, item);
      if (html !== null && html !== undefined) {
        body = body + html;
        continue;
      }
    }
    leftover.push(item);
  }
  return { message: { ...(message || {}), message: body }, leftover, catalog };
}

// A 'template: ... as pdf' descriptor renders its layout to HTML here; the
// conversion through SmartBrowz happens at send time in attempt(). A
// descriptor whose layout name resolves to nothing stays a leftover and
// keeps the refusal.
function pdfAttachments(catalog, items) {
  const pending = [];
  const leftover = [];
  for (const item of items) {
    if (item && item.kind === "template" && item.rendered === "pdf") {
      const html = renderMailTemplate(catalog, item);
      if (html !== null && html !== undefined) {
        pending.push({ name: String(item.name ?? "") || "template", html });
        continue;
      }
    }
    leftover.push(item);
  }
  return { pending, leftover };
}

function ensurePdfBytes(raw, name) {
  const isBytes = Buffer.isBuffer(raw) || raw instanceof Uint8Array;
  if (!isBytes) {
    throw new Error(\`SmartBrowz convertToPdf for \${name} did not return PDF bytes (expected Buffer or Uint8Array)\`);
  }
  const isPdf = raw.length >= 5 && raw[0] === 0x25 && raw[1] === 0x50 && raw[2] === 0x44 && raw[3] === 0x46 && raw[4] === 0x2d;
  if (!isPdf) {
    throw new Error(\`SmartBrowz convertToPdf for \${name} did not return valid PDF content (must start with %PDF-)\`);
  }
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
}

/** Deluge sendmail keys -> Catalyst email().sendMail() config. The message body is HTML. */
export function catalystMail(message, attachments) {
  const config = { from_email: senderOf(message), to_email: addressList(message.to ?? message.recipients ?? message.recipient) };
  const cc = addressList(message.cc);
  const bcc = addressList(message.bcc);
  const replyTo = addressList(message["reply to"] ?? message.reply_to);
  if (cc.length) config.cc = cc;
  if (bcc.length) config.bcc = bcc;
  if (replyTo.length) config.reply_to = replyTo;
  config.subject = message.subject === undefined || message.subject === null ? "" : String(message.subject);
  config.content = message.message === undefined || message.message === null ? "" : String(message.message);
  config.html_mode = true;
  if (attachments && attachments.length) config.attachments = attachments;
  return config;
}

function clip(value, max) {
  const text = value === undefined || value === null ? "" : String(value);
  return text.length > max ? text.slice(0, max) : text;
}

async function logDelivery(req, message, outcome, config) {
  // Mail off: deploy created no delivery log table, so there is nothing to write.
  if (!config || config.enabled !== true) return { logged: false };
  try {
    const app = await catalystApp(req);
    await app.datastore().table(MAIL_LOG_TABLE).insertRow({
      sent_at: new Date().toISOString(),
      status: outcome.status,
      reason: clip(outcome.reason, 10000),
      from_email: outcome.status === "refused" ? maskSender(senderOf(message)) : clip(senderOf(message), 255),
      to_email: clip(recipientsOf(message).join(", "), 10000),
      subject: clip(message && message.subject, 255),
    });
    return { logged: true };
  } catch (err) {
    return { logged: false, logError: err && err.message ? err.message : String(err) };
  }
}

async function attempt(message, req, config) {
  const decision = decideMail(config, recipientsOf(message));
  if (!decision.ok) return { performed: false, status: "refused", reason: decision.reason };
  const from = senderOf(message);
  const verified = config && Array.isArray(config.verifiedSenders) ? config.verifiedSenders : [];
  if (!from || !verified.includes(from)) {
    const failure = from ? \`the app sends mail and sender \${maskSender(from)} is not marked verified\` : "the app sends mail and no Catalyst Mail sender is set";
    return { performed: false, status: "refused", code: MAIL_SENDER_RULE, reason: \`\${failure} (precheck \${MAIL_SENDER_RULE})\` };
  }
  const rendered = renderInlineAttachments(message);
  const pdf = pdfAttachments(rendered.catalog, rendered.leftover);
  if (pdf.leftover.length) return { performed: false, status: "refused", reason: "attachments are not sent in this stage" };
  try {
    const app = await catalystApp(req);
    // pdf_options is an allow-list — unknown keys answer INVALID_INPUT, and
    // landscape takes the strings "true"/"false" — so only the page format
    // is set. convertToPdf returns the PDF bytes, passed through as content.
    const attachments = [];
    for (const item of pdf.pending) {
      const raw = await app.smartbrowz().convertToPdf(item.html, { pdf_options: { format: "A4" } });
      const content = ensurePdfBytes(raw, item.name);
      attachments.push({ name: item.name + ".pdf", content });
    }
    await app.email().sendMail(catalystMail(rendered.message, attachments));
    return { performed: true, status: "sent", reason: "accepted by Catalyst Mail" };
  } catch (err) {
    return { performed: false, status: "failed", reason: err && err.message ? err.message : String(err) };
  }
}

export async function c2cGuardedMail(message, req) {
  const config = readConfig();
  const outcome = await attempt(message, req, config);
  return { ...outcome, ...(await logDelivery(req, message, outcome, config)) };
}
`;
}

export function patchMail(source: string, importSpec: string): string {
  if (!source.includes('createRuntime(') || source.includes('c2cGuardedMail')) return source;
  const patched = source.replaceAll('createRuntime({', 'createRuntime({ mail: (message) => c2cGuardedMail(message, typeof req === "undefined" ? undefined : req), mailGuarded: true, ');
  const line = `import { c2cGuardedMail } from ${JSON.stringify(importSpec)};\n`;
  const at = patched.indexOf('import ');
  if (at < 0) return line + patched;
  return `${patched.slice(0, at)}${line}${patched.slice(at)}`;
}

export function mailImportSpec(fromFile: string): string {
  const fromDir = fromFile.split('/').slice(0, -1).join('/') || '.';
  const target = 'functions/c2c-mail.mjs';
  const fromParts = fromDir.split('/').filter(Boolean);
  const toParts = target.split('/');
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i += 1;
  const up = fromParts.length - i;
  const rel = `${up === 0 ? '.' : Array(up).fill('..').join('/')}/${toParts.slice(i).join('/')}`;
  return rel.startsWith('.') ? rel : `./${rel}`;
}
