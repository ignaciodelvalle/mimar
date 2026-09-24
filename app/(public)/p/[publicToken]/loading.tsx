/**
 * loading.tsx — skeleton for /p/[publicToken] (public pet profile / credential).
 *
 * High-visibility mobile surface — marked "must be fast" (Track D).
 * Owner shares this URL from stickers, QR codes, collars, and lost-pet posts.
 * Lighthouse mobile performance budget applies to this route.
 *
 * DELIBERATELY WITHOUT `op-fade-in`. MOT-2 put that class on the other 164
 * route skeletons so a navigation stops hard-cutting into a placeholder; this
 * one is the exception the motion audit names by hand (§5.2, "anything in an
 * emergency flow"). This is the page a stranger who just found a scared animal
 * on the street opens on a phone, one-handed, under stress — the correct
 * amount of decoration there is zero, and the audit's own prescription for
 * this surface is to REMOVE motion, not add a nicer kind. If a later pass
 * wants consistency here, that is a product decision, not a cleanup.
 */

import { LnCardSkeleton } from "@/components/ui/LnCardSkeleton";
import { Skeleton } from "@/components/ui/Skeleton";

export default function PublicPetLoading() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando…"
      className="mx-auto max-w-xl px-5 py-7 pb-12 block"
    >
      <span className="sr-only">Cargando…</span>

      {/* Pet hero — photo + name + species */}
      <div className="flex flex-col items-center gap-3.5 mb-7">
        <Skeleton w="112px" h="112px" radius="50%" />
        <Skeleton w="48%" h="26px" radius="4px" />
        <Skeleton w="32%" h="14px" radius="3px" />
      </div>

      {/* Credential / info card placeholders */}
      <div className="flex flex-col gap-5">
        <LnCardSkeleton />
        <LnCardSkeleton />
      </div>
    </output>
  );
}
