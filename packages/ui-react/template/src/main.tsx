/**
 * Entry module. Platform file: a regeneration does not rewrite it.
 * Exports boot(spec, document) for any harness, boots once for this page,
 * and registers the service worker in production builds.
 */
import { bootApp, type AppSpec } from '@c2c/ui';
import { model } from './generated/model';
import { routes } from './generated/routes';
import './generated/theme.css';
import customization from './custom';
import './custom/theme.css';

export function boot(spec: AppSpec = model, doc?: Document): void {
  bootApp(spec, doc ?? (typeof document === 'undefined' ? undefined : document), routes, customization);
}

boot(model);

if (import.meta.env.PROD && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
