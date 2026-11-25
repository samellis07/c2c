/**
 * The client half of the report custom action navigation protocol
 * (docs/report-action-navigation.md): a dispatched action's HTTP reply may
 * carry `{ nav: { kind: 'navigate', url, target } }` instead of performing
 * the navigation server-side. This module is the ONLY place that acts on
 * it, and it never does so without checking `navOk` first — the server's
 * classification (packages/deluge/src/generate.ts) is what decides whether
 * to send a `nav` at all, but this file never assumes that decision was
 * correct.
 *
 * `navOk` hand-keeps the same rule as `navigationAllowed` in
 * packages/ui/src/url-policy.ts (the split that file's own docs describe
 * between `safeUrl` and the vanilla client's `c2cUrlOk` in
 * client-runtime.js): a same-app hash route or relative path is always
 * allowed; an `https:` host must be on this app's own allowlist; a denied
 * scheme (`javascript:`, `data:`, `vbscript:`, `file:`), a protocol-relative
 * `//host/...` open redirect, plain `http:`, or an unlisted https host is
 * refused. The generator currently never classifies an https target as
 * navigable (a per-app allowlist built from literal URLs in the .ds would
 * have to trust the very openUrl call it is judging), so `allowedHosts` is
 * always empty in practice today; the check stays in place for when a
 * trustworthy allowlist source exists.
 */
import type { AppWindow } from './api.js';
import { navigate as navigateHash } from './router.js';
import { navigableUrl } from './navigable-url.js';

export { navigableUrl };

export type ActionNavInstruction =
  | {
      kind: 'navigate';
      url: string;
      target?: 'same' | 'new';
    }
  /** Creator's `openUrl("#Script:page.refresh")` (or `page.reload`): the current page loads again. */
  | { kind: 'reload' }
  /** `#Script:dialog.close`: the popup this form was opened in closes. */
  | { kind: 'closeDialog' }
  /** `#Script:page.close`: this page closes, or goes back when it was not opened by a script. */
  | { kind: 'closePage' }
  /** `#Script:page.parent.refresh`: the page that opened this one (or this page, with no opener) loads again. */
  | { kind: 'refreshParent' };

/** This app's own hash route or a single-leading-slash relative path — never `//host/...`, a protocol-relative open redirect wearing a relative path's clothes. */
function isSameAppTarget(url: string): boolean {
  if (url.startsWith('#')) return true;
  return url.startsWith('/') && !url.startsWith('//');
}

/** The lowercase hostname of a well-formed `https://host/...` prefix, or undefined for anything else. Userinfo (`user:pass@host`) is part of the authority, not the host: this reads the text AFTER the last `@`. */
function httpsHost(url: string): string | undefined {
  const m = /^https:\/\/([^/?#\\]+)/i.exec(url);
  if (!m) return undefined;
  const authority = m[1]!;
  const at = authority.lastIndexOf('@');
  const host = (at >= 0 ? authority.slice(at + 1) : authority).split(':')[0]!.toLowerCase();
  return host || undefined;
}

export function navOk(url: unknown, allowedHosts: readonly string[]): boolean {
  const raw = String(url ?? '');
  if (!raw || /[\u0000-\u0020\\]/.test(raw)) return false;
  const flat = raw.replace(/[\u0000- ]+/g, '').toLowerCase();
  if (flat.startsWith('javascript:') || flat.startsWith('data:') || flat.startsWith('vbscript:') || flat.startsWith('blob:') || flat.startsWith('file:') || flat.startsWith('//') || flat.startsWith('#script:')) return false;
  if (isSameAppTarget(raw)) return !/[\u0000- \\]/.test(raw);
  const host = httpsHost(raw);
  if (!host || !allowedHosts.includes(host)) return false;
  const authority = /^https:\/\/([^/?#\\]+)/i.exec(raw)?.[1] ?? '';
  // Credentials in the authority still reach the browser: refuse them even when the host is allow-listed.
  return !authority.includes('@');
}

/** The window that opened this one, while it is still open. */
function openerOf(view: AppWindow): Window | undefined {
  const opener = view.opener as Window | null | undefined;
  return opener && !opener.closed ? opener : undefined;
}

/**
 * The three page commands Creator's `#Script:` targets stand for. A generated
 * app opens a Creator popup form as its own route (in a new tab when opened
 * with `popup window`), so the popup is that tab: `dialog.close` closes it
 * and does nothing in the main window, where no dialog is open.
 */
function performPageCommand(kind: 'closeDialog' | 'closePage' | 'refreshParent', view: AppWindow): void {
  try {
    if (kind === 'closeDialog') {
      if (openerOf(view)) view.close();
    } else if (kind === 'closePage') {
      if (openerOf(view)) view.close();
      else if (view.history.length > 1) view.history.back();
    } else {
      (openerOf(view) ?? view).location.reload();
    }
  } catch {
    // A parent that moved to another origin cannot be reloaded from here.
  }
}

/**
 * Performs a server-returned navigate instruction after checking it against
 * `navOk`, or does nothing if it fails that check. A `#` hash route uses the
 * hash router so the app's own route state stays consistent; a plain
 * relative path or an allowlisted https host uses the window directly
 * (`view.location.href`), since neither is a hash the SPA router parses.
 * `target: 'new'` always opens with `noopener,noreferrer` — the opened tab
 * never gets a handle back to this page.
 */
export function performActionNav(nav: ActionNavInstruction | undefined, allowedHosts: readonly string[], view: AppWindow): void {
  if (nav?.kind === 'reload') {
    view.location.reload();
    return;
  }
  if (nav?.kind === 'closeDialog' || nav?.kind === 'closePage' || nav?.kind === 'refreshParent') {
    performPageCommand(nav.kind, view);
    return;
  }
  if (!nav || nav.kind !== 'navigate' || !navOk(nav.url, allowedHosts)) return;
  if (nav.target === 'new') {
    view.open(nav.url, '_blank', 'noopener,noreferrer');
    return;
  }
  if (nav.url.startsWith('#')) navigateHash(view, nav.url);
  else view.location.href = nav.url;
}
