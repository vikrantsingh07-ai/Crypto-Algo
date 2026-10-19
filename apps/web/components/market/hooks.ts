'use client';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/** Measured content width of an element (0 until mounted, so server and first client render agree). */
export function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      setWidth((prev) => (Math.abs(prev - w) >= 1 ? w : prev));
    };
    read();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', read);
      return () => window.removeEventListener('resize', read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** true when the user asked the OS for less motion */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);
  return reduced;
}

/** Re-render once a second while `active` (for "updated 12s ago" labels); returns the current time, or 0 before mount. */
export function useNow(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [active, everyMs]);
  return active ? now : 0;
}

/**
 * Briefly adds `upClass` / `downClass` to the element when `value` rises / falls. Pure DOM class work (no state, no extra
 * render); restarts the CSS animation on rapid changes by forcing a reflow of this one element.
 */
export function useChangeFlash<T extends HTMLElement>(value: number | null, upClass: string, downClass: string, disabled: boolean): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const prev = useRef<number | null>(null);
  useEffect(() => {
    const p = prev.current;
    prev.current = value;
    const el = ref.current;
    if (!el || disabled || value === null || p === null || value === p) return;
    el.classList.remove(upClass, downClass);
    void el.offsetWidth;
    el.classList.add(value > p ? upClass : downClass);
  }, [value, upClass, downClass, disabled]);
  return ref;
}
