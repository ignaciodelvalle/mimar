// QueueFilterChips — the Denuncias·Triage work-queue selector, demoted from a
// second row of TABS to a single line of filter chips (UI review M5, 2026-08-06).
//
// WHY: /gob/denuncias stacked TWO tab systems on top of each other — the
// pipeline STAGE tabs (Moderación / Triage, which really are views: different
// data, different columns, different work) and, right under them, six queue
// "tabs" (urgentes / sin asignar / mías / todas / atrasadas / sin verificar).
// The second row was never a set of views. Every one of those queues renders
// the SAME list of the SAME entity through a different WHERE clause — they are
// saved FILTERS. Giving them tab chrome told the operator "these are six places
// to be", and it made the two rows compete for the same visual rank, so the
// stage you were in read no louder than the filter you had picked.
//
// Chips instead: mutually exclusive (one queue at a time, same as before), one
// line, visually lighter than the stage tabs above them.
//
// LINKS, not buttons: the queue lives in the URL (?queue=), so every chip has a
// real address. That buys middle-click / open-in-new-tab / copy-link for free,
// and — the load-bearing part on this surface — a plain `<a>` is a FULL
// DOCUMENT navigation, the one mechanism proven immune to the Next 15.5.18
// router-drop defect that forced UrlTabs to call window.location.assign in the
// first place (see components/ui/UrlTabs.tsx's design note). This component is
// therefore a Server Component: no "use client", no useSearchParams, no
// Suspense boundary needed.
//
// Selected semantics: `aria-current="page"` — these chips ARE addresses, and
// role="tab"/aria-selected would be a lie now that there is no tablist and no
// tabpanel to control.

import { pluralizeEs } from "@/lib/utils/format";

/**
 * Visual idiom copied (deliberately, not shared) from OpFilterBar's own
 * active-filter chips: rounded-full, ln-op-line border on ln-op-stripe,
 * text-xs, min-h-8. It cannot be IMPORTED from there — OpFilterBar is a
 * "use client" module, and every export of one is a client reference, so
 * pulling a bare string out of it from a Server Component fails at runtime
 * (the same trap documented in CasoEstadoFilter.tsx). Keep the two in sync by
 * eye; they are three tokens and a radius.
 */
const CHIP_BASE =
  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium min-h-8 " +
  "transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-op-azul";
const CHIP_INACTIVE =
  "border-ln-op-line bg-ln-op-stripe text-ln-op-ink hover:border-ln-op-mute hover:bg-ln-op-card";
const CHIP_ACTIVE = "border-ln-op-azul bg-ln-op-blue-bg text-ln-op-azul font-semibold";

const COUNT_BASE = "rounded-full px-1.5 py-px font-ln-mono text-xs leading-none";
const COUNT_INACTIVE = "bg-ln-op-card text-ln-op-mute";
const COUNT_ACTIVE = "bg-ln-op-azul text-white";

export type QueueChipItem = {
  /** The ?queue= value this chip selects. */
  value: string;
  label: string;
  /** Absolute href that selects this queue, filters preserved. */
  href: string;
  /**
   * Counter shown inside the chip. Present ONLY for queues whose count the
   * page ALREADY computes — never a reason to add a query. A chip without a
   * counter is honest; a chip with a counter that cost an extra COUNT(*) per
   * render is not.
   */
  count?: number;
  /** Singular noun for the counter's accessible name ("12 denuncias"). */
  countNoun?: string;
};

export type QueueFilterChipsProps = {
  items: QueueChipItem[];
  /** The currently selected ?queue= value. */
  activeValue: string;
  /** Accessible name for the chip row (it is a navigation landmark). */
  ariaLabel: string;
  className?: string;
};

export function QueueFilterChips({
  items,
  activeValue,
  ariaLabel,
  className = "",
}: QueueFilterChipsProps) {
  return (
    <nav aria-label={ariaLabel} className={`flex flex-wrap gap-1.5 ${className}`.trim()}>
      {items.map((item) => {
        const isActive = item.value === activeValue;
        return (
          <a
            key={item.value}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={`${CHIP_BASE} ${isActive ? CHIP_ACTIVE : CHIP_INACTIVE}`}
          >
            {item.label}
            {item.count !== undefined && (
              <>
                {/* The bare number would be read as part of the chip's name
                    ("Sin asignar 12"); the sr-only twin says what the 12
                    counts. An `aria-label` on the number span itself is NOT
                    the way to do it: name-from-author is only guaranteed for
                    elements with a role that supports naming, and a bare
                    <span> is role-less — browsers may drop the label entirely
                    and leave AT with the bare digits again. */}
                <span
                  aria-hidden="true"
                  className={`${COUNT_BASE} ${isActive ? COUNT_ACTIVE : COUNT_INACTIVE}`}
                >
                  {item.count}
                </span>
                <span className="sr-only">
                  {`${item.count} ${pluralizeEs(item.count, item.countNoun ?? "denuncia")}`}
                </span>
              </>
            )}
          </a>
        );
      })}
    </nav>
  );
}
