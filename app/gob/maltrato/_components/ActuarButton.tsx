"use client";

// ActuarButton — the workqueue grammar's "actuar" affordance (C6c,
// plan-maestro-integridad.md §C6). Labeled with the row's PRIMARY next-step
// verb (primaryWelfareAction — triage → en curso → resolución), it selects
// the case into the inspector exactly like WelfareRowLink does, but ALSO
// marks `&panel=acciones` so the inspector opens straight on its "Acciones"
// tab instead of "Resumen" — cutting the extra tab click the grammar would
// otherwise cost on every row.
//
// This does NOT perform the mutation itself: triage/start/close all require
// a recorded motivo (≥10 chars, tier-2 ConfirmDialog-adjacent pattern — see
// TriageActions.tsx), which cannot be collapsed into a single click without
// dropping the audit-trail requirement. The button's job is to land the
// operator exactly where that motivo step already lives — one click instead
// of three (open row → click "Acciones" tab → click the verb).
//
// Rendered as a LINK, not a solid button (one-primary-per-screen review,
// 2026-08-06). The row already carries a solid-azul primary — "Tomar", the
// queue's own act of taking ownership. A second identical solid azul next to
// it made the card state two competing primaries and flattened the ranking,
// so this one keeps the operator ink/azul + arrow idiom of admin's "Cerrar
// profesionalmente →" trigger instead of a filled surface.
//
// A real anchor with href (not a clickable button element) — same no-JS-fallback rationale as
// WelfareRowLink: right-click/middle-click/new-tab still work, and a bare
// document load of this href still resolves correctly once the client
// hydrates (InspectorMounter reads `caso`+`panel` from the URL on mount).

import { usePathname, useSearchParams } from "next/navigation";

import { selectCaso } from "../_inspector/inspector-nav";

export function ActuarButton({
  casoParam,
  href,
  label,
}: {
  casoParam: string;
  href: string;
  label: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const params = new URLSearchParams(searchParams.toString());
    const currentHasCaso = params.has("caso");
    params.set("caso", casoParam);
    params.set("panel", "acciones");
    params.delete("mascota");
    selectCaso(`${pathname}?${params.toString()}`, currentHasCaso);
  }

  return (
    <a
      href={href}
      onClick={handleClick}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap px-0.5 py-1 text-xs font-semibold text-ln-op-azul no-underline underline-offset-4 transition-colors hover:underline"
    >
      {label} →
    </a>
  );
}
