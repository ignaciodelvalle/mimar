"use client";

// TomarButton — the workqueue grammar's ONE-CLICK "tomar" affordance (C6c,
// plan-maestro-integridad.md §C6). Rendered as a flex SIBLING of
// WelfareRowLink (never nested inside its anchor — an interactive control
// nested inside another anchor is invalid HTML and breaks screen-reader
// semantics), so a row shows: click anywhere → opens the inspector (Resumen
// tab); click "Tomar" → self-assigns without leaving the list.
//
// Reuses assignWelfareToMeAction (src/modules/welfare/actions.ts) — the SAME
// use-case AssignmentActions.tsx already calls from the detail page's
// "Asignármela" button. No parallel assignment path.
//
// Feedback: this is a LIST-membership-changing action — a self-assign moves
// the row out of the "Sin asignar" queue and off the "Sin asignar" KPI, so an
// in-place optimistic toast would leave a stale row sitting in a queue it no
// longer belongs to. Per the Wave-3 mutation-feedback convention
// (lib/ui/action-feedback.ts §1: "for actions that legitimately navigate, or
// where the SSR page must re-render to stay truthful"), this uses
// navigateAfterActionSuccess — the SAME reload TriageActions.tsx already uses
// for triage/start/close, which move rows across queues for the same reason.

import { useState, useTransition } from "react";

import { OpButton } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { assignWelfareToMeAction } from "@/src/modules/welfare/actions";

export function TomarButton({ reportId }: { reportId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    // This button sits next to (not inside) the row's <a> — stopPropagation
    // is defense-in-depth in case a future refactor nests it back in.
    e.stopPropagation();
    setError(null);
    startTransition(async () => {
      const result = await assignWelfareToMeAction(reportId);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      navigateAfterActionSuccess(window.location.href);
    });
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <OpButton
        type="button"
        size="sm"
        variant="primary"
        onClick={handleClick}
        disabled={pending}
        aria-label="Tomar esta denuncia — asignármela"
      >
        {pending ? "Tomando..." : "Tomar"}
      </OpButton>
      {error && (
        <p role="alert" className="max-w-[140px] text-right text-xs text-ln-op-danger">
          {error}
        </p>
      )}
    </div>
  );
}
