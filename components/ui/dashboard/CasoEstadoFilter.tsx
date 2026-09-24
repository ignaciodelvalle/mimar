"use client";

// CasoEstadoFilter — the Estado (status) control shared by the casos queue
// twins (/gob/casos, /admin/casos).
//
// BUGFIX (opfilterbar-sweep-2026-07-21, "dishonest Todas"): Estado used to be
// an OpFilterBar `axis`. OpFilterBar ALWAYS injects its own leading blank
// option (`<option value="">{allLabel ?? "Todas"}</option>`) whose value
// clears the `status` param — i.e. it maps to the page's NO-STATUS-PARAM
// default. For casos that default is "Abiertos" (WS-PERF: the actionable
// open-case view), NOT "Todos". Casos' Estado axis also already carried an
// explicit `all` option with its OWN "Todos los estados" label. The result
// was two "Todos"-looking entries in the same <select>: the real one (value
// "all", genuinely clears the filter) and the injected blank (value "",
// silently reverts to Abiertos) — a dead control indistinguishable from the
// real one until you click it and nothing changes.
//
// FIX: Estado is no longer an `axis`. It renders in OpFilterBar's `children`
// slot as a plain 3-option <select> that owns the full Abiertos/Todos/
// Cerrados contract directly, committing through the SAME `serverNavCommit`
// primitive every other OpFilterBar control uses (full-document nav, immune
// to the Next 15.5.18 router-drop defect, engram #621/#622) and dropping the
// keyset `cursor` param itself (a status change invalidates the current
// page), mirroring `resetParamsOnChange={["cursor"]}` on the bar itself.
//
// Tradeoff (documented, not a regression): because Estado is no longer a
// registered `axis`, it does not get an active-filter chip and is not reset
// by "Limpiar todo" (both are axis-only mechanisms) — same precedent as the
// existing non-axis child control (VerifiedFilterCheckbox on
// /gob/vigilancia/brotes).
//
// Visual parity: caption + control classes are copy-pasted from OpFilterBar's
// own axis rendering (captionClasses / the axis <OpSelect> className) so this
// renders indistinguishably from a "real" axis control.
//
// ROOT-CAUSE FIX (R1, 2026-07-21): `parseCasoEstado`/`CasoEstado` used to be
// DEFINED in this file. Both /gob/casos and /admin/casos call
// `parseCasoEstado` from their server-side data-loading function — but every
// export of a "use client" module is a client reference, so calling it (not
// rendering it) from a Server Component crashed at runtime with "Attempted
// to call parseCasoEstado() from the server but parseCasoEstado is on the
// client" (invisible to tsc — a bundler-level constraint, not a type error).
// The pure parse/options now live in ./caso-estado (no "use client"); this
// file only re-exports the component.

import { useSearchParams } from "next/navigation";
import { useId } from "react";

import { OpSelect } from "@/components/ui/dashboard/OpField";
import { CASO_ESTADO_OPTIONS, type CasoEstado } from "@/components/ui/dashboard/caso-estado";
import { serverNavCommit } from "@/lib/ui/filter-commit";

export function CasoEstadoFilter({ value }: { value: CasoEstado }) {
  const searchParams = useSearchParams();
  const id = useId();

  return (
    <label htmlFor={id} className="flex w-full flex-col gap-1 sm:w-auto">
      <span className="text-sm font-medium text-ln-op-ink-2">Estado</span>
      <OpSelect
        id={id}
        className="min-h-11 w-full sm:w-auto sm:min-w-[9rem]"
        value={value}
        aria-label="Estado"
        onChange={(e) => {
          const next = e.target.value as CasoEstado;
          // "open" is the default — clear the param instead of writing it
          // explicitly, matching the existing "clean URL at default" convention.
          serverNavCommit(searchParams.toString())({ status: next === "open" ? null : next }, [
            "cursor",
          ]);
        }}
      >
        {CASO_ESTADO_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </OpSelect>
    </label>
  );
}
