"use client";

// AlertSubscriptionForm — create a new threshold alert subscription.
// Used inside /gob/suscripciones (and its /admin/suscripciones thin wrapper)
// to configure metric breach alerts. Formerly embedded in /admin/programa and
// /gob/programa — moved with the panel promotion, 2026-07-21.
// Accessible: all inputs have visible labels; select elements use native <select>.

import { useRef, useState, useTransition } from "react";

import { createAlertSubscriptionAction } from "@/app/actions/alert-subscriptions";
import { OpInput, OpSelect } from "@/components/ui/dashboard/OpField";
// Import the const arrays from the SCHEMA module, NOT "@/db" (the barrel that
// also exports the postgres client) — this is a client component, and "@/db"
// would pull the Node `net`/`tls` driver into the client bundle.
import { ALERT_DIRECTIONS, ALERT_METRIC_KEYS } from "@/db/schema";
import { KPI_CATALOG } from "@/lib/metrics/kpi-catalog";
import { notifySaved } from "@/lib/ui/action-feedback";

// ---------------------------------------------------------------------------
// es-AR labels for metric keys and directions
// ---------------------------------------------------------------------------

const METRIC_LABELS: Record<(typeof ALERT_METRIC_KEYS)[number], string> = {
  active_zoonosis: KPI_CATALOG.active_zoonosis_signals.label,
  eno_sla_ontime_pct: "SLA ENO en tiempo (%)",
  queue_oldest_days: "Días sin atender (solicitud más antigua)",
  sterilization_coverage_pct: "Cobertura de esterilización (%)",
  microchip_penetration_pct: "Penetración de microchip (%)",
  open_welfare_reports: "Denuncias de maltrato abiertas",
};

const DIRECTION_LABELS: Record<(typeof ALERT_DIRECTIONS)[number], string> = {
  above: "Encima de",
  below: "Debajo de",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Status = "idle" | "submitting" | "success" | "error";

type Props = {
  /** Called after a successful creation so the parent can re-fetch. */
  onCreated?: () => void;
};

export function AlertSubscriptionForm({ onCreated }: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);

    startTransition(async () => {
      setStatus("submitting");
      setErrorMsg(null);
      const result = await createAlertSubscriptionAction(data);
      if ("error" in result) {
        setStatus("error");
        setErrorMsg(result.error);
      } else {
        setStatus("success");
        formRef.current?.reset();
        onCreated?.();
        notifySaved("Suscripción creada");
      }
    });
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      aria-label="Crear suscripción de alerta"
      className="space-y-4"
    >
      {/* Metric key */}
      <div className="flex flex-col gap-1">
        <label htmlFor="alert-metric-key" className="text-sm font-semibold text-ln-op-ink">
          Métrica
        </label>
        <OpSelect
          id="alert-metric-key"
          name="metricKey"
          required
          className="h-11"
          aria-required="true"
        >
          <option value="">Seleccioná una métrica…</option>
          {ALERT_METRIC_KEYS.map((key) => (
            <option key={key} value={key}>
              {METRIC_LABELS[key]}
            </option>
          ))}
        </OpSelect>
      </div>

      {/* Direction */}
      <div className="flex flex-col gap-1">
        <label htmlFor="alert-direction" className="text-sm font-semibold text-ln-op-ink">
          Dirección
        </label>
        <OpSelect
          id="alert-direction"
          name="direction"
          required
          className="h-11"
          aria-required="true"
        >
          <option value="">Seleccioná…</option>
          {ALERT_DIRECTIONS.map((d) => (
            <option key={d} value={d}>
              {DIRECTION_LABELS[d]}
            </option>
          ))}
        </OpSelect>
      </div>

      {/* Threshold */}
      <div className="flex flex-col gap-1">
        <label htmlFor="alert-threshold" className="text-sm font-semibold text-ln-op-ink">
          Umbral
        </label>
        <OpInput
          id="alert-threshold"
          name="threshold"
          type="number"
          step="any"
          required
          placeholder="Ej.: 10"
          className="h-11"
          aria-required="true"
        />
      </div>

      {/* Jurisdiction province (optional) */}
      <div className="flex flex-col gap-1">
        <label
          htmlFor="alert-jurisdiction-province"
          className="text-sm font-semibold text-ln-op-ink"
        >
          Provincia (opcional)
          <span className="ml-1 font-normal text-ln-op-mute">
            — dejá vacío para cobertura nacional
          </span>
        </label>
        <OpInput
          id="alert-jurisdiction-province"
          name="jurisdictionProvince"
          type="text"
          placeholder="Ej.: Buenos Aires"
          className="h-11"
        />
        <p className="text-sm text-ln-op-mute">
          Nota: "Días sin atender" siempre es global, independientemente de la provincia.
        </p>
      </div>

      {/* Label (optional) */}
      <div className="flex flex-col gap-1">
        <label htmlFor="alert-label" className="text-sm font-semibold text-ln-op-ink">
          Etiqueta (opcional)
        </label>
        <OpInput
          id="alert-label"
          name="label"
          type="text"
          maxLength={120}
          placeholder="Ej.: Zoonosis CABA crítica"
          className="h-11"
        />
      </div>

      {/* Submit */}
      <button
        type="submit"
        disabled={isPending}
        className="h-11 w-full rounded-[var(--radius-md)] bg-ln-op-azul px-4 text-md font-semibold text-white hover:opacity-90 disabled:opacity-50"
        aria-busy={isPending}
      >
        {isPending ? "Guardando…" : "Crear suscripción"}
      </button>

      {/* Feedback */}
      {status === "success" && (
        <output className="block text-md text-ln-op-ok" aria-live="polite">
          Suscripción creada correctamente.
        </output>
      )}
      {status === "error" && errorMsg && (
        <p className="text-md text-ln-op-danger" role="alert" aria-live="assertive">
          {errorMsg}
        </p>
      )}
    </form>
  );
}
