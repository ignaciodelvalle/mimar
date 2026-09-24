"use client";

// CountUp — animates a formatted metric from zero to its value the first time
// it scrolls into view (PO landing feedback, Estado console). Snappy by design.
//
// Motion contract (mirrors RevealManager / StorySection): under
// prefers-reduced-motion the final value paints immediately and never animates.
// The value also renders in full on the server and for no-JS clients, so the
// console is always correct without hydration flicker — the reset-to-zero only
// happens in a layout effect on the client when motion is allowed and the tile
// is still below the fold.
//
// es-AR formatting is preserved: "1.982" (dot grouping), "72,4%" (comma
// decimal + suffix), "19/24" (animate the leading count, keep the "/24"). Only
// the leading numeric run animates; any prefix/suffix stays put.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

const DURATION_MS = 900;

type ParsedValue = {
  prefix: string;
  suffix: string;
  target: number;
  decimals: number;
};

function parseValue(raw: string): ParsedValue | null {
  const m = raw.match(/^(\D*)([\d.,]+)(.*)$/);
  if (!m) return null;
  const [, prefix, core, suffix] = m;

  let target: number;
  let decimals: number;
  if (core.includes(",")) {
    // es-AR: comma is the decimal separator, dot is thousands grouping.
    const decimalPart = core.split(",")[1] ?? "";
    decimals = decimalPart.length;
    target = Number.parseFloat(core.replace(/\./g, "").replace(",", "."));
  } else {
    // No comma: dots (if any) are thousands grouping → integer.
    decimals = 0;
    target = Number.parseInt(core.replace(/\./g, ""), 10);
  }

  if (Number.isNaN(target)) return null;
  return { prefix, suffix, target, decimals };
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function CountUp({ value }: { value: string }) {
  // useMemo keeps `parsed` referentially stable across renders (value never
  // changes for a given tile), so the effects below depend on it without
  // re-running or restarting the animation.
  const parsed = useMemo(() => parseValue(value), [value]);
  const ref = useRef<HTMLSpanElement>(null);
  // Initial render (SSR + hydration) shows the real value — correct for no-JS.
  const [display, setDisplay] = useState<string>(value);

  // Before first paint on the client: if we CAN animate and the tile isn't on
  // screen yet, drop to zero so the count-up starts clean (no final→0 flash).
  useLayoutEffect(() => {
    if (!parsed) return;
    if (prefersReducedMotion()) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const r = el.getBoundingClientRect();
    const inView = r.top < (window.innerHeight || 0) && r.bottom > 0;
    if (!inView) {
      setDisplay(format(0, parsed));
    }
  }, [parsed]);

  useEffect(() => {
    if (!parsed) return;
    if (prefersReducedMotion()) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    let raf = 0;
    let started = false;
    const run = () => {
      if (started) return;
      started = true;
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / DURATION_MS);
        const eased = 1 - (1 - t) ** 3; // easeOutCubic — quick, decelerating
        setDisplay(format(parsed.target * eased, parsed));
        if (t < 1) raf = requestAnimationFrame(tick);
        else setDisplay(value);
      };
      raf = requestAnimationFrame(tick);
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            run();
            io.disconnect();
          }
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);

    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [parsed, value]);

  return (
    <span ref={ref} className="tabular-nums">
      {display}
    </span>
  );
}

function format(n: number, { prefix, suffix, decimals }: ParsedValue): string {
  const num = new Intl.NumberFormat("es-AR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
  return `${prefix}${num}${suffix}`;
}
