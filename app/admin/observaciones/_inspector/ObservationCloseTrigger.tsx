"use client";

// ObservationCloseTrigger — the client interaction wrapper for a list row's
// "Cerrar profesionalmente" action (inline-close convergence 2026-08-02).
//
// Twin of app/gob/maltrato/_components/WelfareRowLink.tsx: keeps the real
// `<a href="/admin/observaciones/[publicToken]">` (right-click "open in new
// tab", modifier clicks and the no-JS fallback all still land on the
// full-page close form — the detail route stays the deep-link fallback), but
// intercepts a plain left-click to SELECT the row into the inline inspector
// via shallow history (`?cerrar=<token>`), so the list Server Component
// never re-runs and filters/scroll survive.

import { usePathname, useSearchParams } from "next/navigation";

import { selectObservacion } from "./observation-inspector-nav";

export function ObservationCloseTrigger({ publicToken }: { publicToken: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selected = searchParams.get("cerrar") === publicToken;

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    // Respect modifier/middle clicks and right-click — let the browser open
    // the full page / new tab as usual.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    const params = new URLSearchParams(searchParams.toString());
    const currentHasCerrar = params.has("cerrar");
    params.set("cerrar", publicToken);
    selectObservacion(`${pathname}?${params.toString()}`, currentHasCerrar);
  }

  return (
    <a
      href={`/admin/observaciones/${publicToken}`}
      data-observacion-row={publicToken}
      aria-current={selected ? "true" : undefined}
      onClick={handleClick}
      className="text-sm font-semibold text-ln-op-azul no-underline underline-offset-4 hover:underline"
    >
      Cerrar profesionalmente →
    </a>
  );
}
