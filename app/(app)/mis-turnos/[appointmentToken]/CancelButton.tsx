"use client";

// Owner-side cancellation trigger for /mis-turnos/[appointmentToken].
// Uses URL state (?sheet=cancelar-turno) instead of browser confirm().
//
// Opens via pushSheetUrl (native History API) instead of router.push —
// router-hot-path fix, see lib/ui/sheet-nav.ts.

import { buildSheetUrl } from "@/lib/ui/sheet-helpers";
import { pushSheetUrl } from "@/lib/ui/sheet-nav";
import { usePathname, useSearchParams } from "next/navigation";

export function CancelButton() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function handleClick() {
    const params = new URLSearchParams(searchParams.toString());
    pushSheetUrl(buildSheetUrl(pathname, params, "cancelar-turno"));
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="px-4 py-2 rounded-[var(--radius-pill)] border border-[var(--color-ln-seal)] text-[var(--color-ln-seal)] text-sm font-medium hover:bg-[var(--color-ln-err-050)] transition-colors"
    >
      Cancelar turno
    </button>
  );
}
