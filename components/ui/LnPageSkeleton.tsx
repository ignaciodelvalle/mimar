/**
 * LnPageSkeleton — shared loading.tsx skeleton for citizen (`app/(app)/*`) list
 * pages.
 *
 * Generalizes the hand-rolled header+registry-rows shape already proven in
 * `app/(app)/mis-mascotas/loading.tsx` into a reusable primitive, so the other
 * citizen list segments identified by the Wave 2 state-coverage audit
 * (turnos, mis-turnos…) get a matching loading.tsx without re-deriving the
 * layout from scratch.
 *
 * Accessibility: owns the `<output aria-busy aria-label>` + SR-only
 * "Cargando…" wrapper, same contract as `OpDashboardSkeleton` and the existing
 * hand-rolled citizen loading.tsx files (enforced by `__tests__/skeleton.test.tsx`).
 *
 * Motion: `op-fade-in` (app/globals.css) so the skeleton ARRIVES instead of
 * replacing the outgoing page on one frame — MOT-2, motion audit 2026-08-04
 * Gap 2. This is the structural half of that fix: 30 of the 165 `loading.tsx`
 * files get it from here without being touched. Fading the skeleton is free;
 * fading the CONTENT it hands off to is not, and the audit forbids it (§5.7).
 */

import { Skeleton } from "@/components/ui/Skeleton";

export type LnPageSkeletonProps = {
  /** Number of list rows. Default 4. */
  rows?: number;
  /** Show a CTA-shaped skeleton button next to the title. Default false. */
  cta?: boolean;
  /** Show a circular avatar/photo-shaped placeholder per row. Default true. */
  avatar?: boolean;
  /** Outer container max-width (Tailwind class). Default "max-w-4xl". */
  maxWidth?: string;
};

const ROW_KEYS = ["a", "b", "c", "d", "e", "f"] as const;

export function LnPageSkeleton({
  rows = 4,
  cta = false,
  avatar = true,
  maxWidth = "max-w-4xl",
}: LnPageSkeletonProps) {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando…"
      className={`op-fade-in mx-auto ${maxWidth} px-8 py-7 pb-12 block`}
    >
      <span className="sr-only">Cargando…</span>

      {/* Header placeholder */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton w="220px" h="30px" radius="4px" />
          <Skeleton w="180px" h="14px" radius="3px" />
        </div>
        {cta && <Skeleton w="150px" h="38px" radius="3px" />}
      </div>

      {/* Registry rows placeholder */}
      <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)]">
        {ROW_KEYS.slice(0, rows).map((k) => (
          <div
            key={k}
            className="grid items-center gap-4 border-b border-[var(--color-ln-line-2)] px-5 py-3.5 last:border-b-0"
            style={{ gridTemplateColumns: avatar ? "72px 1fr auto" : "1fr auto" }}
          >
            {avatar && <Skeleton w="72px" h="72px" radius="50%" />}
            <div className="flex flex-col gap-2">
              <Skeleton w="45%" h="16px" radius="3px" />
              <Skeleton w="30%" h="12px" radius="3px" />
            </div>
            <Skeleton w="60px" h="12px" radius="3px" />
          </div>
        ))}
      </div>
    </output>
  );
}
