/**
 * Render-error boundaries. Without one, a screen that throws while it renders
 * unmounts the whole React root, and every later route paints nothing.
 *
 * ScreenBoundary wraps the open screen inside the shell: the nav stays alive,
 * the screen shows an accessible "could not be shown" state with a Retry
 * button, and navigating away (the shell keys it by route) starts fresh.
 * AppBoundary wraps the whole app as a last resort, for an error outside any
 * screen (the shell, the sign-in gate, a customization's nav transform).
 *
 * Each caught error is logged to the console once: the screen, the error's
 * name and its stack frames. The message is left out, since it can quote
 * record values. The state carries a `.fidelity-note` line, the marker the
 * migrated app uses for anything it could not show.
 *
 * An AccessDenied (a 403, see runtime/StatusScreens) is not a crash: the
 * boundary shows the access-denied screen, logs nothing and offers no Retry.
 */
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '../arc/components/button/button';
import { DeniedScreen, isAccessDenied } from '../runtime/StatusScreens';

const logged = new WeakSet<object>();

/** The boundaries that report their own errors; the root's onCaughtError skips them. */
const ours = new WeakSet<object>();

/** One console line per error, with no message text (it can carry record data). */
export function reportRenderError(screen: string, error: unknown, componentStack?: string | null): void {
  const key = typeof error === 'object' && error !== null ? error : null;
  if (key) {
    if (logged.has(key)) return;
    logged.add(key);
  }
  const name = error instanceof Error ? error.name : typeof error;
  const frames = error instanceof Error ? String(error.stack ?? '').split('\n').filter((line) => /^\s+at\s|@/.test(line)) : [];
  const where = screen ? `the screen "${screen}"` : 'the app';
  console.error(`c2c-ui: ${where} could not be shown (${name}).\n${[...frames, String(componentStack ?? '').trim()].filter(Boolean).join('\n')}`);
}

/**
 * React root options: an error a ScreenBoundary or AppBoundary caught is
 * already reported; any other caught or uncaught error is reported once here.
 */
export const rootErrorOptions = {
  onCaughtError(error: unknown, info: { componentStack?: string | null; errorBoundary?: unknown }): void {
    if (isAccessDenied(error)) return;
    if (info.errorBoundary && ours.has(info.errorBoundary as object)) return;
    reportRenderError('', error, info.componentStack);
  },
  onUncaughtError(error: unknown, info: { componentStack?: string | null }): void {
    reportRenderError('', error, info.componentStack);
  },
};

interface BoundaryProps {
  /** The screen's label, shown in the state and the log line; empty for the app boundary. */
  screen: string;
  /** The screen's route key, for `data-screen-error`. */
  route?: string;
  children: ReactNode;
}

interface BoundaryState {
  failed: boolean;
  /** The screen answered 403: the access-denied screen, not the crash card. */
  denied: boolean;
  /** Bumped by Retry so the children re-mount, not just re-render. */
  attempt: number;
}

class RenderBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false, denied: false, attempt: 0 };

  constructor(props: BoundaryProps) {
    super(props);
    ours.add(this);
  }

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { failed: true, denied: isAccessDenied(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (isAccessDenied(error)) return;
    reportRenderError(this.props.screen, error, info.componentStack);
  }

  private retry = (): void => {
    this.setState((state) => ({ failed: false, denied: false, attempt: state.attempt + 1 }));
  };

  render(): ReactNode {
    const { screen, route, children } = this.props;
    if (!this.state.failed) return <Fragment key={this.state.attempt}>{children}</Fragment>;
    const app = !screen;
    if (this.state.denied) return <DeniedScreen screen={app ? '' : screen} />;
    return (
      <section className="c2c-card c2c-render-error" role="alert" data-screen-error={app ? 'app' : route ?? screen}>
        <h1>{app ? 'This app could not be shown' : 'This screen could not be shown'}</h1>
        <p>
          {app
            ? 'Something went wrong while the app was drawing. Try again, or reload the page.'
            : `"${screen}" hit an error while it was drawing. The rest of the app still works: choose another screen from the menu, or try again.`}
        </p>
        <p className="fidelity-note">Not shown: {app ? 'the app' : screen}</p>
        <Button type="button" variant="primary" onClick={this.retry}>
          Retry
        </Button>
      </section>
    );
  }
}

/** The per-screen boundary; key it by route so navigation resets it. */
export function ScreenBoundary({ screen, route, children }: BoundaryProps) {
  return (
    <RenderBoundary screen={screen || route || 'Screen'} route={route}>
      {children}
    </RenderBoundary>
  );
}

/** The last-resort boundary around the whole app. */
export function AppBoundary({ children }: { children: ReactNode }) {
  return <RenderBoundary screen="">{children}</RenderBoundary>;
}
