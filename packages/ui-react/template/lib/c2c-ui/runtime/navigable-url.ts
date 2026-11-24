/** Dependency-free URL gate shared by every React navigation sink (kept free of React/router imports so tests and tools can load it alone). */
import type { AppWindow } from './api.js';

/** Shared gate for every openUrl/location navigation in the React client. */
export function navigableUrl(view: AppWindow | undefined, url: unknown): boolean {
  if (typeof url !== 'string' || !url || /[\u0000-\u0020\\]/.test(url) || url.startsWith('//')) return false;
  const flat = url.replace(/[\u0000-\u0020]+/g, '').toLowerCase();
  if (/^(javascript|data|vbscript|blob|file):/.test(flat)) return false;
  if (/^https?:/i.test(url) && !/^https?:\/\/[^/?#\\]+(?:[/?#]|$)/i.test(url)) return false;
  const base = typeof view?.location?.href === 'string' ? view.location.href : 'https://localhost/';
  let parsed: URL;
  try { parsed = new URL(url, base); } catch { return false; }
  const authority = /^https?:\/\/([^/?#\\]+)/i.exec(url)?.[1] ?? '';
  if (authority.includes('@') || parsed.username || parsed.password || !parsed.hostname) return false;
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}
