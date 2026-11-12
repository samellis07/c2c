import { useEffect, useState, type RefObject } from "react";

/**
 * Local replacement for motion's useInView in the vendored charts. It observes
 * with the element's own window, and with no IntersectionObserver there (a
 * document booted under a test or scoring harness) the element counts as in
 * view, so the chart draws instead of throwing.
 */
export function useInView(ref: RefObject<Element | null>, { once = false, amount = 0 }: { once?: boolean; amount?: number } = {}): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || (once && inView)) return;
    const Observer = (node.ownerDocument.defaultView as (Window & typeof globalThis) | null)?.IntersectionObserver;
    if (typeof Observer !== "function") {
      setInView(true);
      return;
    }
    const observer = new Observer(([entry]) => {
      if (!entry) return;
      if (entry.isIntersecting) {
        setInView(true);
        if (once) observer.disconnect();
      } else if (!once) setInView(false);
    }, { threshold: amount });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, once, amount, inView]);
  return inView;
}
