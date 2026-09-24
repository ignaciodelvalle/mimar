"use client";

// Client wrapper for the "solo verificados" filter checkbox on the brotes page,
// now living inside OpFilterBar's `children` slot instead of a hand-rolled
// hidden-input <form>. That form only preserved `period`/`signalId` on toggle
// — silently dropping province/locality (and any future param) whenever the
// operator had a jurisdiction narrowed. Committing through the SAME
// `serverNavCommit` primitive OpFilterBar's own axes/period/jurisdiction
// controls use fixes that: it snapshots the CURRENT full searchParams, so
// every other active filter survives a toggle. No surrounding <form> is
// required anymore.
//
// Uses OpCheckbox (op-tier tokens) — this control is 100% operator surface
// (/gob/vigilancia/brotes); migrated off LnCheckbox as part of the OpCheckbox
// follow-up (consistency/op-skin-followups, 2026-07-19).
import { useSearchParams } from "next/navigation";

import { OpCheckbox } from "@/components/ui/dashboard/OpField";
import { serverNavCommit } from "@/lib/ui/filter-commit";

export function VerifiedFilterCheckbox({ defaultChecked }: { defaultChecked: boolean }) {
  const searchParams = useSearchParams();

  return (
    <OpCheckbox
      name="soloVerificados"
      value="1"
      defaultChecked={defaultChecked}
      onChange={(e) => {
        serverNavCommit(searchParams.toString())({
          soloVerificados: e.currentTarget.checked ? "1" : null,
        });
      }}
    >
      Solo verificados institucionalmente
    </OpCheckbox>
  );
}
