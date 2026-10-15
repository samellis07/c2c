/**
 * The app frame. Desktop: a section menu (#nav) beside the screen. Phone
 * (< 768 px): the menu hides and a bottom tab bar (#tabbar) shows up to five
 * destinations; with more than five, the fifth tab is More and opens a sheet
 * (#more-sheet) with the rest. Escape or a link closes the sheet. The ids and
 * data attributes are the shell contract the UI scorer and the smoke plan read.
 * The screen renders inside a ScreenBoundary keyed by the full route, so a
 * screen that throws shows its own error state, the menu keeps working, and
 * the next route starts with a fresh boundary. A 403 inside the screen shows
 * the access-denied screen there; an ended session shows the sign-in prompt
 * over the whole frame.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Ellipsis, FileText, LayoutDashboard, ListChecks, Table } from 'lucide-react';
import type { NavItem, NavSection } from '../types';
import { useEnv } from '../runtime/env';
import { useRoute } from '../runtime/router';
import { bridgeSignOut } from '../runtime/api';
import { SessionExpiredPrompt } from '../runtime/auth';
import { ScreenBoundary } from './ScreenBoundary';

const MAX_TABS = 5;

function ItemIcon({ kind }: { kind: NavItem['kind'] }) {
  const Icon = kind === 'form' ? FileText : kind === 'report' ? Table : kind === 'flow' ? ListChecks : LayoutDashboard;
  return <Icon className="c2c-icon" size={18} strokeWidth={1.75} aria-hidden="true" />;
}

export interface AppShellProps {
  title: string;
  sections: NavSection[];
  /** `form/<name>`, `report/<name>` or `page/<name>` of the open screen. */
  current: string;
  children: ReactNode;
}

export function AppShell({ title, sections, current, children }: AppShellProps) {
  const { doc, view } = useEnv();
  const route = useRoute(view);
  const items = sections.flatMap((section) => section.items);
  const overflow = items.length > MAX_TABS;
  const tabs = overflow ? items.slice(0, MAX_TABS - 1) : items;
  const rest = overflow ? items.slice(MAX_TABS - 1) : [];
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const moreRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const isCurrent = (item: NavItem) => `${item.kind}/${item.name}` === current;
  const screen = items.find(isCurrent)?.label ?? current;
  const boundaryKey = `${current}|${route.name === 'form' ? route.edit ?? '' : route.name === 'report' ? route.row ?? '' : ''}`;

  // The sheet answers synchronously: a click or Escape leaves the DOM in its final state.
  const setSheet = (next: boolean) => {
    flushSync(() => setOpen(next));
    if (next) sheetRef.current?.querySelector<HTMLElement>('a[href]')?.focus();
    else moreRef.current?.focus();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && openRef.current) setSheet(false);
    };
    doc.addEventListener('keydown', onKey);
    return () => doc.removeEventListener('keydown', onKey);
  }, [doc]);

  return (
    <div className="c2c-app">
      <header className="c2c-topbar">
        <span id="app-title">{title}</span>
        {typeof view.C2C_AUTH_BRIDGE === 'string' && view.C2C_AUTH_BRIDGE ? (
          <button type="button" className="c2c-signout" onClick={() => bridgeSignOut(view)}>
            Sign out
          </button>
        ) : null}
      </header>
      <nav id="nav" aria-label="Main menu">
        {sections.map((section) => (
          <div className="c2c-nav-section" key={section.label}>
            <h2 className="c2c-nav-heading">{section.label}</h2>
            <ul>
              {section.items.map((item) => (
                <li key={`${item.kind}/${item.name}`}>
                  <a href={item.href} aria-current={isCurrent(item) ? 'page' : undefined}>
                    <ItemIcon kind={item.kind} />
                    <span>{item.label}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <main id="main" tabIndex={-1}>
        <ScreenBoundary key={boundaryKey} screen={screen} route={current}>
          {children}
        </ScreenBoundary>
      </main>
      <nav id="tabbar" aria-label="Tabs">
        {tabs.map((item) => (
          <a key={`${item.kind}/${item.name}`} href={item.href} aria-current={isCurrent(item) ? 'page' : undefined}>
            <ItemIcon kind={item.kind} />
            <span>{item.label}</span>
          </a>
        ))}
        {overflow ? (
          <button
            ref={moreRef}
            type="button"
            data-more=""
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls="more-sheet"
            onClick={() => setSheet(!openRef.current)}
          >
            <Ellipsis className="c2c-icon" size={18} strokeWidth={1.75} aria-hidden="true" />
            <span>More</span>
          </button>
        ) : null}
      </nav>
      {overflow ? (
        <div id="more-sheet" ref={sheetRef} role="dialog" aria-modal="true" aria-label="More" hidden={!open}>
          <ul>
            {rest.map((item) => (
              <li key={`${item.kind}/${item.name}`}>
                <a href={item.href} aria-current={isCurrent(item) ? 'page' : undefined} onClick={() => setSheet(false)}>
                  <ItemIcon kind={item.kind} />
                  <span>{item.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <SessionExpiredPrompt />
    </div>
  );
}
