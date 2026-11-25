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

export interface ActionNavInstruction {
  kind: 'navigate';
  url: string;
  target?: 'same' | 'new';
}

export interface OpenUrlInstruction { url: string; window: string }
export interface OpenUrlEffects {
  refresh?: () => void;
  closeDialog?: () => void;
  closePage?: () => void;
  refreshParent?: () => void;
}

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
  if (flat.startsWith('javascript:') || flat.startsWith('data:') || flat.startsWith('vbscript:') || flat.startsWith('blob:') || flat.startsWith('file:') || flat.startsWith('//')) return false;
  if (isSameAppTarget(raw)) return !/[\u0000- \\]/.test(raw);
  const host = httpsHost(raw);
  if (!host || !allowedHosts.includes(host)) return false;
  const authority = /^https:\/\/([^/?#\\]+)/i.exec(raw)?.[1] ?? '';
  return !authority.startsWith('@');
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
  if (!nav || nav.kind !== 'navigate' || !navOk(nav.url, allowedHosts)) return;
  if (nav.target === 'new') {
    view.open(nav.url, '_blank', 'noopener,noreferrer');
    return;
  }
  if (nav.url.startsWith('#')) navigateHash(view, nav.url);
  else view.location.href = nav.url;
}

/** Applies Creator openUrl results in execution order. Pseudo-URLs are UI commands, never browser URLs. */
export function applyOpenUrlNav(nav: readonly OpenUrlInstruction[] | undefined, allowedHosts: readonly string[], view: AppWindow, effects: OpenUrlEffects = {}): void {
  if (!Array.isArray(nav)) return;
  for (const item of nav) {
    if (!item || typeof item.url !== 'string') continue;
    if (item.url.startsWith('#Script:')) {
      switch (item.url.slice('#Script:'.length).toLowerCase()) {
        case 'page.refresh':
        case 'page.reload': effects.refresh?.(); break;
        case 'dialog.close': effects.closeDialog?.(); break;
        case 'page.close': effects.closePage?.(); break;
        case 'page.parent.refresh': effects.refreshParent?.(); break;
        default: break;
      }
      continue;
    }
    performActionNav({ kind: 'navigate', url: item.url, target: /^(new|popup) window$/i.test(item.window) ? 'new' : 'same' }, allowedHosts, view);
  }
}
