/**
 * Skeleton — base shimmer atom for all loading placeholders.
 *
 * Uses CSS custom properties for theming:
 *   Operator surfaces: --color-ln-op-line / --color-ln-op-card
 *   Owner/public surfaces: --color-ln-line / --color-ln-card
 *
 * Accessibility:
 *   The outer region (aria-busy + role="status") is set by each composite
 *   skeleton component. This atom is a pure visual placeholder.
 *
 * Motion:
 *   prefers-reduced-motion → static placeholder, no animation.
 */

export type SkeletonProps = {
  /** Width (CSS value, e.g. "100%", "120px"). Defaults to "100%". */
  w?: string;
  /** Height (CSS value, e.g. "16px", "2rem"). Defaults to "1em". */
  h?: string;
  /** Border radius (CSS value). Defaults to "4px". */
  radius?: string;
  className?: string;
};

export function Skeleton({ w = "100%", h = "1em", radius = "4px", className = "" }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={["skeleton-shimmer block flex-shrink-0", className].filter(Boolean).join(" ")}
      style={{ width: w, height: h, borderRadius: radius, display: "block" }}
    />
  );
}
