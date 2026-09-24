import Link from "next/link";

export type CrumbItem = {
  label: string;
  href?: string;
  /** Renders the label in font-ln-mono font-bold (for doc codes like req_4Kx9). */
  mono?: boolean;
};

type Props = {
  items: CrumbItem[];
};

const ChevronRight = () => (
  <svg
    width={8}
    height={8}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
    className="flex-shrink-0"
  >
    <path
      d="M9 18l6-6-6-6"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * Topbar breadcrumb strip.
 *
 * - Intermediate items: linked (if href provided), muted color.
 * - Last item: bold, ink color. Mono items use font-ln-mono.
 */
export function OpCrumbs({ items }: Props) {
  return (
    // min-w-0 + overflow-hidden + flex-nowrap keep the strip on ONE line inside
    // the topbar (D1): the current-page crumb truncates with an ellipsis instead
    // of wrapping the topbar onto a second row at ≥1280px.
    <nav aria-label="Ruta de navegación" className="min-w-0">
      <ol className="flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden text-sm text-ln-op-mute">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          const textClass = isLast
            ? item.mono
              ? "font-ln-mono font-bold text-ln-op-ink"
              : "font-semibold text-ln-op-ink"
            : "text-ln-op-mute";

          return (
            <li
              key={`${item.label}-${i}`}
              className={[
                "flex items-center gap-1.5",
                // Intermediate crumbs hold their width; the last (current page)
                // crumb is the one allowed to shrink + truncate.
                isLast ? "min-w-0" : "flex-shrink-0",
              ].join(" ")}
            >
              {i > 0 && <ChevronRight />}
              {isLast || !item.href ? (
                <span className={`${textClass} ${isLast ? "truncate" : "whitespace-nowrap"}`}>
                  {item.label}
                </span>
              ) : (
                <Link
                  href={item.href}
                  className={`whitespace-nowrap no-underline hover:text-ln-op-ink ${textClass}`}
                >
                  {item.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
