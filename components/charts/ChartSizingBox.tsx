"use client";

import {
  type ComponentPropsWithoutRef,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";
import { ResponsiveContainer } from "recharts";

// B1 (red-team-admin #14/#15, completed in red-team-admin-2 P2.8): recharts'
// ResponsiveContainer measures its parent on first paint. Under the app's
// `ssr: false` dynamic chart wrappers, that first measurement is 0/-1 before
// layout settles, which logs "The width(-1) and height(-1) of chart should be
// greater than 0" and paints an empty SVG.
//
// A concrete inline HEIGHT alone (the first version of this box) silenced
// height(-1) but NOT width(-1): `width: "100%"` resolves against a parent that
// is itself 0-wide at that instant. The second version GATED the
// ResponsiveContainer — mounting it only once the box had measured a non-zero
// width (synchronously on mount, then via ResizeObserver).
//
// GATING WAS NOT ENOUGH (QA 2026-08-07 still measured the warning ×5 per /gob
// load, on a build that already carried the gate). The remaining source is
// ResponsiveContainer ITSELF: its `initialDimension` prop defaults to
// `{width: -1, height: -1}` (recharts/lib/component/responsiveContainerUtils.js)
// and that value seeds its state, so it renders the chart once with -1/-1
// before its own ResizeObserver fires. Gating the PARENT cannot prevent that —
// flipping the gate just mounts a fresh ResponsiveContainer that repeats its
// own -1 first pass.
//
// So we hand it the dimensions we already measured. The box knows both: the
// caller's concrete `height`, and the width the ResizeObserver just read.
// `initialDimension` makes that first pass valid instead of silencing its
// symptom. The gate stays — it is what guarantees we HAVE a real width to pass.
export function ChartSizingBox({
  height,
  children,
  className,
  ...rest
}: {
  /** Concrete pixel height — also applied as minHeight so the box never collapses. */
  height: number;
  /** A single recharts chart element (ResponsiveContainer's lone child). */
  children: ReactElement;
  className?: string;
} & Omit<ComponentPropsWithoutRef<"div">, "children" | "style" | "className">) {
  const ref = useRef<HTMLDivElement>(null);
  // The measured width doubles as the gate: `null` means "not measured yet".
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      // Only widen the gate on a real measurement; a transient 0 (parent
      // collapsed mid-layout) must not tear down an already-mounted chart.
      if (w > 0) setMeasuredWidth((prev) => (prev === w ? prev : w));
    };
    measure();
    // ResizeObserver is not globally present in the test env (jsdom); guard so
    // rendering this box in a unit test never throws. The synchronous measure
    // above already covers the common (already-laid-out) case.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      style={{ width: "100%", height, minHeight: height }}
      {...rest}
    >
      {measuredWidth !== null && (
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: measuredWidth, height }}
        >
          {children}
        </ResponsiveContainer>
      )}
    </div>
  );
}
