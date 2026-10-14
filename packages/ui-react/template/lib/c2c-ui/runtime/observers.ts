/**
 * Layout observers a browser always ships. A host that boots the app into a
 * document of another realm (a test or scoring harness, a non-browser shell)
 * can lack them; a bare `new ResizeObserver()` inside a field control then
 * throws during render and unmounts the whole app. A never-firing observer
 * keeps those screens rendering: the callbacks only refine measurements.
 */
export function ensureObservers(view: object): void {
  const globals = view as Record<string, unknown>;
  for (const name of ['ResizeObserver', 'IntersectionObserver'] as const) {
    if (typeof globals[name] !== 'function') {
      globals[name] = class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
        takeRecords(): unknown[] {
          return [];
        }
      };
    }
  }
}
