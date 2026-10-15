/**
 * Sign-in by default. When public/c2c-config.js loads the Catalyst Web SDK
 * (the generated default), the app renders only for a signed-in user; with no
 * session it shows Catalyst's embedded sign-in in #c2c-login. With no SDK (a
 * local preview) the app renders directly and the API decides access.
 *
 * After boot the session can still end. The api wrapper retries a 401 once
 * and then fires the session-expired event; SessionExpiredPrompt answers it
 * with a "Your session ended" dialog whose button goes to Catalyst's hosted
 * sign-in and back to the same page. The open form has saved its draft by
 * then and restores it on return.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../arc/components/button/button';
import { bridgeRedirect, goToSignIn, hasBridgeToken, SESSION_EXPIRED_EVENT, type SessionExpiredDetail } from './api';
import { useEnv } from './env';

/**
 * The page the sign-in frame returns to. Only a same-origin path survives:
 * a protocol-relative value (//host, /\host), an encoded slash or backslash,
 * a control character, or a value that keeps changing under repeated decoding
 * falls back to "/".
 */
export function serviceUrl(location: Location): string {
  const path = String(location.pathname);
  if (/%(?:2f|5c|0[0-9a-f]|1[0-9a-f])/i.test(path)) return '/';
  const candidate = `/${path.replace(/^[\\/]+/, '')}${location.hash || ''}`;
  let decoded = candidate;
  try {
    for (let i = 0; i <= 3; i++) {
      if (/^[\\/]{2}/.test(decoded) || /[\u0000-\u001f\u007f]/.test(decoded)) return '/';
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      if (i === 3) return '/';
      decoded = next;
    }
  } catch {
    return '/';
  }
  try {
    return new URL(candidate, location.origin).origin === location.origin ? candidate : '/';
  } catch {
    return '/';
  }
}

type AuthState = 'none' | 'checking' | 'signed-in' | 'signed-out';

export function AuthGate({ children }: { children: ReactNode }) {
  const { view } = useEnv();
  const auth = view.catalyst?.auth;
  // Bridge mode (deployed app): a token the c2c_auth bridge returned, or a top-
  // level trip to fetch one. The Slate origin has no /baas, so there is no SDK
  // sign-in here — the check is "do we hold a token", and a 401 re-trips once.
  const bridging = typeof view.C2C_AUTH_BRIDGE === 'string' && view.C2C_AUTH_BRIDGE.length > 0;
  const [state, setState] = useState<AuthState>(bridging ? 'checking' : auth && typeof auth.isUserAuthenticated === 'function' ? 'checking' : 'none');
  const [frameMissing, setFrameMissing] = useState(false);

  useEffect(() => {
    if (!bridging || state !== 'checking') return;
    if (hasBridgeToken(view)) {
      setState('signed-in');
      return;
    }
    // No token: one top-level bridge trip (loop-guarded inside). A refused
    // trip — the tab just came back without a token — shows the sign-in card.
    setState(bridgeRedirect(view) ? 'checking' : 'signed-out');
  }, [bridging, state, view]);

  useEffect(() => {
    if (state !== 'checking' || !auth?.isUserAuthenticated) return;
    let live = true;
    auth.isUserAuthenticated().then(
      () => live && setState('signed-in'),
      () => live && setState('signed-out'),
    );
    return () => {
      live = false;
    };
  }, [auth, state]);

  useEffect(() => {
    if (state !== 'signed-out' || typeof auth?.signIn !== 'function') return;
    try {
      auth.signIn('c2c-login', { service_url: serviceUrl(view.location) });
    } catch {
      // The frame check below reports the box that never appeared.
    }
    const wait = typeof view.C2C_LOGIN_WAIT_MS === 'number' ? view.C2C_LOGIN_WAIT_MS : 3000;
    const timer = view.setTimeout(() => {
      if (!view.document.querySelector('#c2c-login iframe')) setFrameMissing(true);
    }, wait);
    return () => view.clearTimeout(timer);
  }, [auth, state, view]);

  if (state === 'none' || state === 'signed-in') return <>{children}</>;
  if (state === 'checking') return <p className="c2c-auth-status" role="status">Checking your sign-in…</p>;
  if (bridging) {
    // The automatic trip was refused by the loop guard (the tab already came
    // back once without a token). The button is a deliberate second try.
    return (
      <section className="c2c-login-card" aria-labelledby="c2c-login-title">
        <h1 id="c2c-login-title">Sign in to continue.</h1>
        <Button type="button" variant="primary" onClick={() => bridgeRedirect(view, true)}>
          Sign in
        </Button>
      </section>
    );
  }
  return (
    <section className="c2c-login-card" aria-labelledby="c2c-login-title">
      <h1 id="c2c-login-title">Sign in to continue.</h1>
      <div id="c2c-login" />
      <p className="c2c-login-hint">
        If the sign-in box stays blank, iFrame is off for this host — the app administrator can enable it under Authentication &gt; Whitelisting &gt; this host &gt; Edit &gt; iFrame on, then reload.
      </p>
      {frameMissing ? (
        <p role="alert">The sign-in box did not load. Reload the page, or ask the app administrator to check the authorized domains.</p>
      ) : null}
    </section>
  );
}

/**
 * The "Your session ended" dialog. It cancels the session-expired event so the
 * wrapper does not navigate on its own, and the user leaves for sign-in only
 * from the button. When the tab is already back from a sign-in that did not
 * help (for example a user with no app role), the copy says so instead of
 * sending the user round again unprompted.
 */
export function SessionExpiredPrompt() {
  const { view } = useEnv();
  const [expired, setExpired] = useState<SessionExpiredDetail | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onExpired = (event: Event) => {
      const detail = (event as CustomEvent<SessionExpiredDetail>).detail;
      if (!detail || typeof detail.login !== 'string') return;
      event.preventDefault();
      setExpired(detail);
    };
    view.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => view.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [view]);

  useEffect(() => {
    if (expired) buttonRef.current?.focus();
  }, [expired]);

  if (!expired) return null;
  return (
    <div className="c2c-modal-backdrop">
      <section className="c2c-modal" role="alertdialog" aria-modal="true" aria-labelledby="c2c-session-title" aria-describedby="c2c-session-body" data-session-expired="">
        <h2 id="c2c-session-title">Your session ended</h2>
        <p id="c2c-session-body">
          {expired.looping
            ? 'Sign-in did not complete. Access was not restored. Your entries are kept on this page; ask the app administrator to check your app role.'
            : 'Sign in again to continue. Your entries are kept.'}
        </p>
        <Button
          ref={buttonRef}
          type="button"
          variant="primary"
          onClick={() => {
            // Bridge mode has no hosted-login page on Slate: the bridge is the way back in.
            if (typeof view.C2C_AUTH_BRIDGE === 'string' && view.C2C_AUTH_BRIDGE) bridgeRedirect(view, true);
            else goToSignIn(view, expired.login);
          }}
        >
          Sign in again
        </Button>
      </section>
    </div>
  );
}
