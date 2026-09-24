"use client";

import { useState, useTransition } from "react";

import { notifySaved } from "@/lib/ui/action-feedback";
import { setCoFosterAllowedAction } from "@/src/modules/foster/actions";

export function CoFosterToggle({
  fosterOwnershipId,
  initial,
}: {
  fosterOwnershipId: string;
  initial: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [current, setCurrent] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  function toggle(value: boolean) {
    setError(null);
    // Tier B optimistic toggle: local state is the source of truth for this
    // control; revert on error. No navigation — router.refresh() is banned
    // (silent-drop defect, see lib/ui/full-page-action-nav.ts) and nothing
    // else on the page derives from this flag.
    const previous = current;
    setCurrent(value);
    startTransition(async () => {
      const result = await setCoFosterAllowedAction({
        fosterOwnershipId,
        allowCoFoster: value,
      });
      if ("error" in result) {
        setCurrent(previous);
        setError(result.error);
      } else {
        // In-place toggle, no reload — the toast is the confirmation
        // (mutation-feedback convention, lib/ui/action-feedback.ts).
        notifySaved(value ? "Ahora permitís co-foster" : "Ya no permitís co-foster");
      }
    });
  }

  return (
    <div className="rounded-[var(--radius-sm)] bg-[var(--color-ln-stripe)] border border-[var(--color-ln-line)] p-3 text-sm">
      <p className="text-[var(--color-ln-ink)] mb-2">
        ¿Permitís que la organización asigne un co-foster a esta mascota?
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => toggle(true)}
          disabled={pending || current}
          className={`px-3 py-1 rounded-[var(--radius-pill)] text-xs transition-colors ${
            current
              ? "bg-[var(--color-ln-ok)] text-white"
              : "border border-[var(--color-ln-line-strong)] hover:bg-[var(--color-ln-stripe)]"
          } disabled:opacity-60`}
        >
          Permitir
        </button>
        <button
          type="button"
          onClick={() => toggle(false)}
          disabled={pending || !current}
          className={`px-3 py-1 rounded-[var(--radius-pill)] text-xs transition-colors ${
            !current
              ? "bg-[var(--color-ln-azul)] text-white"
              : "border border-[var(--color-ln-line-strong)] hover:bg-[var(--color-ln-stripe)]"
          } disabled:opacity-60`}
        >
          No permitir
        </button>
      </div>
      {error && <output className="block text-xs text-[var(--color-ln-err)] mt-2">{error}</output>}
    </div>
  );
}
