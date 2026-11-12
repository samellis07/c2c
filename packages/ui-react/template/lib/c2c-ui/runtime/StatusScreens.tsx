/**
 * What a screen shows when the API refuses it. A 403 becomes the one
 * access-denied screen: a screen calls the setter from useAccessDenied, the
 * next render throws AccessDenied, and the per-route ScreenBoundary renders
 * DeniedScreen in place of the screen (the menu stays). It offers no Retry,
 * since asking again cannot change the answer. failureText is the app's own
 * copy for 401, 403, 5xx and a dropped network: the server's text for these
 * is never shown.
 */
import { useCallback, useState } from 'react';
import { AccessDenied } from './api';

/** True for a thrown 403, whichever copy of the module created it. */
export function isAccessDenied(error: unknown): boolean {
  return error instanceof AccessDenied || (error instanceof Error && error.name === 'AccessDenied');
}

/** A setter that swaps the calling screen for the access-denied screen. */
export function useAccessDenied(): () => void {
  const [denied, setDenied] = useState(false);
  if (denied) throw new AccessDenied();
  return useCallback(() => setDenied(true), []);
}

/** The user-facing line for a failed call; empty for a status the screen words itself (a 4xx validation answer). */
export function failureText(status: number): string {
  if (status === 0) return 'The service could not be reached. Check your connection and try again.';
  if (status === 401) return 'Your session ended. Sign in again to continue; your entries are kept.';
  if (status === 403) return 'You do not have access to do that. Ask the app administrator for access.';
  if (status >= 500) return 'The service is unavailable right now. Try again in a moment.';
  return '';
}

/** A status worth a Retry button: the network or the service may come back; a refusal will not. */
export function retryable(status: number): boolean {
  return status === 0 || status >= 500;
}

export function DeniedScreen({ screen }: { screen: string }) {
  return (
    <section className="c2c-card c2c-denied" role="alert" data-access-denied="">
      <h1>You don't have access to {screen || 'this screen'}</h1>
      <p>Ask the app administrator for access.</p>
      <p>
        <a className="c2c-link" href="#/">
          Go to home
        </a>
      </p>
    </section>
  );
}
