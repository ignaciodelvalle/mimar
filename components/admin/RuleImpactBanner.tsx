"use client";

// Rule-impact preview banner for PPP business-rule forms (Item 22).
// Shows "esta regla afecta a ~N mascotas" before the user submits.
// Used by PppBreedListForm and PppWeightThresholdForm.

import { useCallback, useEffect, useRef, useState } from "react";

import { type RuleImpactPreviewInput, previewRuleImpact } from "@/app/actions/rule-impact-preview";

type Status = "idle" | "loading" | "done" | "error";

export type RuleImpactResult = {
  status: Status;
  count: number | null;
};

type Props = {
  input: RuleImpactPreviewInput | null;
  // C9: report the computed impact upward so a parent form can gate its save on
  // acknowledgement WITHOUT calling the preview a second time.
  onResult?: (result: RuleImpactResult) => void;
};

export function RuleImpactBanner({ input, onResult }: Props) {
  const [count, setCount] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const abortRef = useRef<AbortController | null>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const fetch = useCallback(async (previewInput: RuleImpactPreviewInput) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setStatus("loading");
    onResultRef.current?.({ status: "loading", count: null });
    try {
      const result = await previewRuleImpact(previewInput);
      if (!ac.signal.aborted) {
        setCount(result.affectedCount);
        setStatus("done");
        onResultRef.current?.({ status: "done", count: result.affectedCount });
      }
    } catch {
      if (!ac.signal.aborted) {
        setStatus("error");
        onResultRef.current?.({ status: "error", count: null });
      }
    }
  }, []);

  useEffect(() => {
    if (!input) {
      setStatus("idle");
      setCount(null);
      onResultRef.current?.({ status: "idle", count: null });
      return;
    }
    void fetch(input);
    return () => {
      abortRef.current?.abort();
    };
  }, [input, fetch]);

  if (status === "idle") return null;

  if (status === "loading") {
    return (
      <p className="text-md text-ln-op-mute italic" aria-live="polite" aria-busy="true">
        Calculando impacto…
      </p>
    );
  }

  if (status === "error") {
    // UX 3.6 (f): never render nothing — show a non-blocking fallback so the
    // operator knows the estimate is unavailable (submission stays allowed; the
    // preview is advisory, not a gate).
    return (
      <p className="text-md text-ln-op-mute" aria-live="polite">
        No se pudo calcular el impacto estimado. Podés continuar igual.
      </p>
    );
  }

  if (count === null) return null;

  if (count === 0) {
    return (
      <p className="text-md text-ln-op-mute" aria-live="polite">
        Esta regla no afecta a ninguna mascota actualmente no clasificada.
      </p>
    );
  }

  return (
    <p
      className="text-md rounded-[var(--radius-md)] border border-ln-op-warn-bd bg-ln-op-warn-bg px-4 py-3 text-ln-op-warn"
      aria-live="polite"
    >
      {/* El adjetivo concuerda con el sustantivo: con count === 1 decía
          "~1 mascota actualmente no clasificadAS". */}
      Esta regla afecta a ~{count.toLocaleString("es-AR")} {count === 1 ? "mascota" : "mascotas"}{" "}
      actualmente {count === 1 ? "no clasificada" : "no clasificadas"} como PPP.
    </p>
  );
}
