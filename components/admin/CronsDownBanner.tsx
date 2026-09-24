// CronsDownBanner — a single operator-facing banner shown on /admin and
// /admin/sistema when ANY background job's most recent run failed
// (operator-trust T3).
//
// WHY: an operator does not need — and should not be alarmed by — curl/Vercel
// internals. The headline states the impact in plain es-AR and the action
/// (write to OPERATOR_HELP_EMAIL — the same mailbox the rail's "¿Necesitás
// ayuda?" names, pilot T1-P5; it used to say "avisá a soporte" and name no
// channel at all); the technical identifiers (the failing cron names) live
// under a collapsed "Detalle técnico" disclosure.
//
// Honest in both environments: locally a failure is usually vitest polluting
// the shared cron_runs table, while in prod cron_runs only receives rows from
// real Vercel cron executions — so a failed latest status there is a genuine
// incident. The banner mirrors telemetry either way (see fetchFailedCronNames).
//
// PRESENTATIONAL / server component. It renders nothing when the fleet is
// healthy, so callers can mount it unconditionally.

import { Icon } from "@/components/Icon";
import { cronDisplayLabel } from "@/lib/infra/cron-registry";
import { OPERATOR_HELP_EMAIL, mailtoHref } from "@/lib/ui/contact";

export function CronsDownBanner({
  failedCronNames,
  /** When false, the "Ver detalle" link to /admin/sistema is hidden (already there). */
  showSistemaLink = true,
}: {
  failedCronNames: string[];
  showSistemaLink?: boolean;
}) {
  if (failedCronNames.length === 0) return null;

  return (
    <div
      role="alert"
      className={[
        "flex flex-col gap-2 rounded-[var(--radius-md)]",
        "border border-ln-op-danger-bd border-l-[4px] border-l-ln-op-danger",
        "bg-ln-op-danger-bg px-4 py-3",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <b className="text-sm font-bold text-ln-op-danger">
          Procesos automáticos caídos {"·"} escribinos a{" "}
          <a
            href={mailtoHref(OPERATOR_HELP_EMAIL, {
              subject: "miMAR — procesos automáticos caídos",
              body: `Procesos que figuran caídos: ${failedCronNames.join(", ")}`,
            })}
            className="underline underline-offset-2"
          >
            {OPERATOR_HELP_EMAIL}
          </a>
        </b>
        {showSistemaLink && (
          // Plain <a> (not next/link) — operator-trust T2: a soft <Link> on this
          // dense dashboard can silently drop under the Next 15.5 client-router
          // defect. A real anchor hard-navigates so the click always lands.
          <a
            href="/admin/sistema"
            className="inline-flex items-center gap-1 text-sm font-semibold text-ln-op-danger underline underline-offset-2"
          >
            Ver detalle
            <Icon name="chevron-right" size="sm" decorative />
          </a>
        )}
      </div>
      <p className="text-sm text-ln-op-danger opacity-85">
        {failedCronNames.length === 1
          ? `Un proceso automático no está corriendo. Escribinos a ${OPERATOR_HELP_EMAIL} para que lo revisemos; algunas tareas del sistema pueden estar demoradas.`
          : `${failedCronNames.length} procesos automáticos no están corriendo. Escribinos a ${OPERATOR_HELP_EMAIL} para que los revisemos; algunas tareas del sistema pueden estar demoradas.`}
      </p>
      <details className="text-sm text-ln-op-danger opacity-85">
        <summary className="cursor-pointer select-none font-medium">Detalle técnico</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
          {failedCronNames.map((name) => (
            // es-AR label for the operator; the raw snake_case key rides `title`
            // for support/debugging without putting English-looking text on screen.
            <li key={name} title={name}>
              {cronDisplayLabel(name)}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
