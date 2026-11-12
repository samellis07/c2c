"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { Variants } from "motion/react";
import { ChevronDown, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { motionTokens } from "../../motion-tokens";
import styles from "./multi-select.module.css";
import { activeDescendant, enterAction, optionId } from "../combobox/keys";

export interface MultiSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface MultiSelectProps {
  label: string;
  options: MultiSelectOption[];
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[]) => void;
  placeholder?: string;
  description?: string;
  maxVisible?: number;
  disabled?: boolean;
  className?: string;
  /** A search box at the top of the open menu that filters the options by label. */
  searchable?: boolean;
  /** Shown in the open menu when the search matches nothing. */
  emptyMessage?: string;
  /** Keep the label for assistive technology only (a grid cell named by its column header). */
  hideLabel?: boolean;
  /** Content below the options inside the open menu, such as a control that reads more options. */
  footer?: ReactNode;
  /** Called when the menu opens or closes. */
  onOpenChange?: (open: boolean) => void;
  /** Called with the typed search text, so a host can search records it has not read yet. */
  onQueryChange?: (query: string) => void;
  /** Marks the control invalid after a failed submit. */
  invalid?: boolean;
  /** Ids of elements that describe the control, such as its error message. */
  describedBy?: string;
}

const enter = motionTokens.ease.enter;
const standard = motionTokens.ease.standard;
/** Each chip sits in a slot whose width opens and collapses on a spring, so neighbours travel with it and nothing overlaps. */
const slot: Variants = {
  hidden: { width: 0, opacity: 0 },
  shown: { width: "auto", opacity: 1, transition: { width: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast, ease: enter } } },
  gone: { width: 0, opacity: 0, transition: { width: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.instant, ease: standard } } },
};
/** The chip itself grows in from .9 with a soft blur and shrinks back as it leaves. */
const chip: Variants = {
  hidden: { scale: 0.9, filter: `blur(${motionTokens.blur.soft}px)` },
  shown: { scale: 1, filter: "blur(0px)", transition: { ...motionTokens.spring.snappy, filter: { duration: motionTokens.duration.standard, ease: enter } } },
  gone: { scale: 0.9, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.instant, ease: standard } },
};
/** Reduced motion keeps short crossfades; resting states match the moving variants so server and client markup agree. */
const fade: Variants = { hidden: { opacity: 0 }, shown: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: motionTokens.duration.instant } }, gone: { opacity: 0, transition: { duration: motionTokens.duration.instant } } };
const slotFade: Variants = { hidden: { opacity: 0 }, shown: { width: "auto", opacity: 1, transition: { duration: motionTokens.duration.instant } }, gone: { opacity: 0, transition: { duration: motionTokens.duration.instant } } };
const chipStill: Variants = { hidden: { scale: 1, filter: "blur(0px)" }, shown: { scale: 1, filter: "blur(0px)" }, gone: { scale: 1, filter: "blur(0px)" } };
/** The overflow count rolls: a larger number rises from below, a smaller one drops from above. */
const roll: Variants = {
  hidden: (direction: number) => ({ opacity: 0, y: `${direction * 0.5}em`, filter: `blur(${motionTokens.blur.subtle}px)` }),
  shown: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: motionTokens.duration.standard, ease: enter } },
  gone: (direction: number) => ({ opacity: 0, y: `${direction * -0.5}em`, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.instant, ease: standard } }),
};

/** A check that draws itself when an option is picked and retracts when it is removed. */
function CheckMark({ reduce }: { reduce: boolean | null }) {
  return <svg className={styles.check} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <motion.path d="M4 12.5 9 17.5 20 6.5" initial={reduce ? { opacity: 0 } : { pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} exit={reduce ? { opacity: 0 } : { pathLength: 0, opacity: 0 }} transition={reduce ? { duration: motionTokens.duration.instant } : { pathLength: { duration: motionTokens.duration.standard, ease: enter }, opacity: { duration: motionTokens.duration.instant } }} />
  </svg>;
}

export function MultiSelect({ label, options: allOptions, value, defaultValue = [], onValueChange, placeholder = "Select options", description, maxVisible = 2, disabled = false, className, searchable = false, emptyMessage = "No matches found", hideLabel = false, footer, onOpenChange, onQueryChange, invalid, describedBy }: MultiSelectProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const valueId = `${id}-value`;
  const rootRef = useRef<HTMLDivElement>(null);
  const [internal, setInternal] = useState(defaultValue);
  const [open, setOpenState] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // A ref, so the document listener registered once still reaches the latest callback.
  const openChange = useRef(onOpenChange);
  openChange.current = onOpenChange;
  const setOpen = (next: boolean | ((current: boolean) => boolean)) => {
    setOpenState((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      if (resolved !== current) openChange.current?.(resolved);
      return resolved;
    });
  };
  const needle = query.trim().toLocaleLowerCase();
  // The open menu lists the options matching the search; selections outside the match stay selected.
  const options = useMemo(() => (searchable && needle ? allOptions.filter((option) => option.label.toLocaleLowerCase().includes(needle)) : allOptions), [allOptions, searchable, needle]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const selected = value ?? internal;
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const labelFor = (item: string) => allOptions.find((option) => option.value === item)?.label ?? item;
  const visible = selected.slice(0, maxVisible).map((item) => ({ value: item, label: labelFor(item) }));
  const remaining = Math.max(0, selected.length - visible.length);
  // A closed menu forgets its highlight, so the next open starts clean instead of on a stale hovered row.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) { setWasOpen(open); if (!open) { setActiveIndex(-1); setQuery(""); } }
  const [previousRemaining, setPreviousRemaining] = useState(remaining);
  const [countDirection, setCountDirection] = useState(1);
  if (previousRemaining !== remaining) { setPreviousRemaining(remaining); setCountDirection(remaining > previousRemaining ? 1 : -1); }

  useEffect(() => {
    const doc = rootRef.current?.ownerDocument;
    if (!doc) return;
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    doc.addEventListener("pointerdown", close);
    return () => doc.removeEventListener("pointerdown", close);
  }, []);
  useEffect(() => { if (open && searchable) searchRef.current?.focus(); }, [open, searchable]);

  const update = (next: string[]) => { if (value === undefined) setInternal(next); onValueChange?.(next); };
  const toggle = (option: MultiSelectOption) => {
    if (disabled || option.disabled) return;
    update(selectedSet.has(option.value) ? selected.filter((item) => item !== option.value) : [...selected, option.value]);
  };
  const clear = () => { update([]); setOpen(false); };
  const enabled = options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    // Enter in the open menu toggles the highlighted option (or the first match of a typed search) and is
    // always consumed, so it never submits the surrounding form.
    const enter = event.key === "Enter" ? enterAction(open, activeIndex, needle, options) : "pass";
    if (typeof enter === "number") { event.preventDefault(); toggle(options[enter]!); return; }
    if (event.key === "Enter" || (event.key === " " && event.currentTarget.tagName !== "INPUT")) { event.preventDefault(); setOpen((current) => !current); return; }
    if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus(); return; }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && enabled.length) {
      event.preventDefault(); setOpen(true);
      const current = enabled.indexOf(activeIndex);
      const next = current < 0 ? (event.key === "ArrowDown" ? 0 : enabled.length - 1) : event.key === "ArrowDown" ? (current + 1) % enabled.length : (current - 1 + enabled.length) % enabled.length;
      setActiveIndex(enabled[next]!);
    }
  };
  const reduce = useReducedMotion();
  // Focus stays on the trigger (or the search box); the highlighted option is announced through aria-activedescendant.
  const active = activeDescendant(open, activeIndex, options.length, `${id}-listbox`);

  return <div ref={rootRef} className={[styles.field, className].filter(Boolean).join(" ")}>
    <span id={labelId} className={hideLabel ? styles.srOnly : `${styles.label} field-title`}>{label}</span>
    <div className={styles.control}><button ref={triggerRef} type="button" className={`${styles.trigger} ${selected.length ? styles.hasClear : ""}`} disabled={disabled} aria-labelledby={`${labelId} ${valueId}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-listbox`} aria-activedescendant={searchable ? undefined : active} aria-describedby={describedBy} aria-invalid={invalid || undefined} onClick={() => setOpen((current) => !current)} onKeyDown={onKeyDown}>
      <span id={valueId} className={styles.srOnly}>{selected.length ? selected.map(labelFor).join(", ") : placeholder}</span>
      <span className={styles.value} aria-hidden="true">
        <AnimatePresence initial={false}>
          {visible.map((item) => <motion.span key={`chip-${item.value}`} className={styles.slot} variants={reduce ? slotFade : slot} initial="hidden" animate="shown" exit="gone"><motion.span className={styles.chip} variants={reduce ? chipStill : chip}>{item.label}</motion.span></motion.span>)}
          {remaining > 0 && <motion.span key="more" className={styles.slot} variants={reduce ? slotFade : slot} initial="hidden" animate="shown" exit="gone"><motion.span className={styles.more} variants={reduce ? chipStill : chip}>+<span className={styles.count}><AnimatePresence initial={false} custom={countDirection}><motion.span key={remaining} custom={countDirection} variants={reduce ? fade : roll} initial="hidden" animate="shown" exit="gone">{remaining}</motion.span></AnimatePresence></span></motion.span></motion.span>}
          {!selected.length && <motion.span key="placeholder" className={styles.placeholder} variants={fade} initial="hidden" animate="shown" exit="gone">{placeholder}</motion.span>}
        </AnimatePresence>
      </span>
      <ChevronDown className={styles.chevron} size={16} aria-hidden="true" />
    </button>
    <AnimatePresence initial={false}>{selected.length > 0 && !disabled && <motion.button type="button" aria-label="Clear selections" className={styles.clear} onClick={clear}
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6, filter: `blur(${motionTokens.blur.subtle}px)` }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)", transition: reduce ? { duration: motionTokens.duration.instant } : { ...motionTokens.spring.snappy, opacity: { duration: motionTokens.duration.fast } } }}
      exit={{ opacity: 0, ...(reduce ? {} : { scale: 0.6, filter: `blur(${motionTokens.blur.subtle}px)` }), transition: { duration: motionTokens.duration.instant, ease: standard } }}
      whileTap={{ scale: reduce ? 1 : 0.96, transition: { duration: motionTokens.duration.instant, ease: standard } }}><X size={14} aria-hidden="true" /></motion.button>}</AnimatePresence>
    <AnimatePresence initial={false}>
      {open && <motion.div className={styles.menu}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: .97 }}
        animate={{ opacity: 1, y: 0, scale: 1, transition: reduce ? { duration: motionTokens.duration.instant } : { ...motionTokens.spring.snappy, opacity: { duration: motionTokens.duration.fast, ease: enter } } }}
        exit={{ opacity: 0, ...(reduce ? {} : { y: -4, scale: .98 }), transition: { duration: motionTokens.duration.instant, ease: standard } }}>
        {searchable && <label className={styles.search}><Search size={16} strokeWidth={1.75} aria-hidden="true" /><input ref={searchRef} type="search" aria-label={`Search ${label}`} aria-controls={`${id}-listbox`} aria-activedescendant={active} placeholder="Search" value={query} onChange={(event) => { setQuery(event.target.value); onQueryChange?.(event.target.value); setActiveIndex(-1); }} onKeyDown={onKeyDown} /></label>}
        <div id={`${id}-listbox`} role="listbox" aria-label={label} aria-multiselectable="true" className={styles.listbox}>
        {options.length === 0 && <div className={styles.empty} role="status">{emptyMessage}</div>}
        {options.map((option, index) => <button type="button" role="option" id={optionId(`${id}-listbox`, index)} tabIndex={-1} aria-selected={selectedSet.has(option.value)} aria-disabled={option.disabled || undefined} key={option.value} className={styles.option} data-active={activeIndex === index} disabled={option.disabled} onPointerMove={() => { if (activeIndex !== index) setActiveIndex(index); }} onClick={() => toggle(option)}>
          <span>{option.label}</span><AnimatePresence initial={false}>{selectedSet.has(option.value) && <CheckMark key="check" reduce={reduce} />}</AnimatePresence>
        </button>)}
        </div>
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </motion.div>}
    </AnimatePresence>
    </div>
    {description && <span className={styles.description}>{description}</span>}
  </div>;
}
