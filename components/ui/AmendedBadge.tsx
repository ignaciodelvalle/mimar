// AmendedBadge — inline indicator for events that have been corrected.
//
// Renders a small "Corregido el {fecha}" chip. Expandable to show the original
// href (link to the event in /historial). Screen-reader-friendly.
//
// D2 (Wave 2 Item 15): the libreta view shows the CURRENT value derived from
// the projection; this badge signals that an amendment exists. The original
// event is always accessible at the provided `originalHref`.

import Link from "next/link";

import { Icon } from "@/components/Icon";
import { formatDateShort } from "@/lib/utils/format";

export type AmendedBadgeProps = {
  /** ISO date string or Date of when the amendment occurred. */
  amendedAt: Date | string;
  /** URL to the original (unamended) event in /historial or /eventos/[id]. */
  originalHref: string;
};

export function AmendedBadge({ amendedAt, originalHref }: AmendedBadgeProps) {
  return (
    <output
      className="inline-flex items-center gap-[5px] rounded-full border border-[var(--color-ln-warn)] bg-[var(--color-ln-warn-bg,var(--color-ln-stripe))] px-2 py-0.5 font-ln-mono text-xs text-[var(--color-ln-ink-2)]"
      aria-label={`Registro corregido el ${formatDateShort(amendedAt)}`}
    >
      <Icon name="editar" size={14} decorative />
      Corregido el {formatDateShort(amendedAt)}
      {" · "}
      <Link
        href={originalHref}
        // prefetch=false: same rationale as EventTimeline.tsx's row link —
        // this renders inside the always-mounted (possibly off-screen)
        // Libreta face, so eager prefetch of an archival detail page is
        // wasted connection-pool pressure that can starve a real in-flight
        // navigation (see EventTimeline.tsx for the full incident writeup).
        prefetch={false}
        className="underline hover:text-[var(--color-ln-azul)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ln-azul)]"
        aria-label="Ver registro original"
      >
        Ver original
      </Link>
    </output>
  );
}
