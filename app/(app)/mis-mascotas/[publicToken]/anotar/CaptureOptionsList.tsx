// CaptureOptionsList — WP-7 full discoverability list of loggable events and
// owner flows, grouped by category, driven by ALL_CAPTURE_OPTIONS + the
// event-capture registry so it stays in sync automatically.
//
// Extracted from anotar/page.tsx (pet-document-redesign D1) so BOTH the
// standalone /anotar fallback page (ADR-5) AND SheetMounter's `?sheet=anotar`
// branch render the identical list — no duplicated category-grouping logic.
// No "use client" directive: it has no hooks/state, so it renders correctly
// from both a server page (anotar/page.tsx) and a client component
// (SheetMounter.tsx).

import Link from "next/link";

import { buildCaptureDeeplink } from "@/lib/events/event-capture-registry";
import { todayIsoInAr } from "@/lib/utils/format";
import { ALL_CAPTURE_OPTIONS, PREGNANCY_START_ROUTE } from "./handoff";

export function CaptureOptionsList({
  petPublicToken,
  showCheckinOption,
  showPregnancyStartOption,
}: {
  petPublicToken: string;
  /**
   * QA A9: the "Check-in post-adopción" entry renders only when the viewer is
   * the pet's registered adopter (isPetAdoptedByUser, resolved server-side by
   * the host page) — otherwise the target page 404s. Both hosts (anotar
   * fallback page and SheetMounter's ?sheet=anotar) must thread this.
   */
  showCheckinOption: boolean;
  /**
   * The second conditional row, and the same shape as the first: "Registrar
   * embarazo" renders only when `canStartPregnancy` says this animal can open
   * one — female, of a species with a known gestation, with none already in
   * progress. Resolved server-side by the host from the `pets` row it already
   * holds (no extra query), because this component is bundled into a client
   * component (SheetMounter) and the predicate reads the writer's table.
   *
   * Withheld rather than shown-and-refused: the destination enforces the same
   * three clauses and would answer with a blocked shell.
   */
  showPregnancyStartOption: boolean;
}) {
  const today = todayIsoInAr();

  const visibleOptions = ALL_CAPTURE_OPTIONS.filter((opt) => {
    if (opt.eventType === "post_adoption_checkin") return showCheckinOption;
    // By ROUTE and not by event type: the pregnancy row rides
    // `clinical_info_logged`, which another row already uses.
    if (opt.routeOverride === PREGNANCY_START_ROUTE) return showPregnancyStartOption;
    return true;
  });

  const optionsWithHref = visibleOptions.map((opt) => {
    let href: string;
    if (opt.routeOverride) {
      href = `/mis-mascotas/${petPublicToken}${opt.routeOverride}`;
    } else {
      href =
        buildCaptureDeeplink(opt.eventType, petPublicToken, { occurredAt: today }) ??
        `/mis-mascotas/${petPublicToken}`;
    }
    return { ...opt, href };
  });

  // Derived from the FILTERED set so a category emptied by the gate (e.g.
  // "Adopción" for a non-adopter) never renders a header with no rows.
  const categories = Array.from(new Set(visibleOptions.map((o) => o.category)));

  return (
    <div className="space-y-7">
      {categories.map((category) => {
        const items = optionsWithHref.filter((o) => o.category === category);
        return (
          <section key={category}>
            <h2 className="mb-2 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]">
              {category}
            </h2>
            <ul className="divide-y divide-[var(--color-ln-stripe)] overflow-hidden rounded-sm border border-[var(--color-ln-line-strong)]">
              {items.map((opt) => (
                <li key={`${opt.eventType}-${opt.routeOverride ?? ""}`}>
                  <Link
                    href={opt.href}
                    className="flex items-center justify-between px-3.5 py-2.5 text-md text-[var(--color-ln-ink)] transition-colors hover:bg-[var(--color-ln-stripe)]"
                  >
                    <span>{opt.label}</span>
                    <span className="text-sm text-[var(--color-ln-mute)]">→</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
