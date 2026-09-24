// OrgSetupChecklist — guided first-run checklist for newly created orgs.
// Wave 3 Item 19.
//
// Spec: dim-interno:docs/superpowers-private/specs/archive/2026-06-18-wave3-org-ops-handoff.md (Item 19)
//
// Rendered as an OpCard in the org panel. Auto-hides when all steps complete.
// Each step shows done (✓) or pending state with a CTA link.
// A11y: <fieldset>+<legend> wrapper, <ul>/<li> list, aria-label progress.
// Focus managed by the parent (page.tsx focuses the first pending step via autoFocus).

import Link from "next/link";

import { Icon } from "@/components/Icon";
import { OpCard, OpCardBody, OpCardHead } from "@/components/ui/dashboard";
import type { SetupStep } from "@/lib/infra/org-setup-checklist";

// Pending indicator: a simple open circle rendered via Tailwind border classes.
// Using a <span> avoids adding a new icon name to the Icon component for a
// single usage.
function PendingDot() {
  return (
    <span
      aria-hidden
      className="inline-block h-2 w-2 rounded-full border border-ln-op-line-2 bg-transparent"
    />
  );
}

type Props = {
  steps: SetupStep[];
  orgToken: string;
  /** When true, the autoFocus attribute is set on the first pending step's CTA. */
  autoFocusFirst?: boolean;
};

export function OrgSetupChecklist({ steps, orgToken, autoFocusFirst = false }: Props) {
  // The counter measures what the ORG can finish. Including the
  // waitingOn:"mimar" row would make the denominator unreachable — the same
  // lie the row itself used to tell, moved into the progress indicator.
  const actionable = steps.filter((s) => s.waitingOn === "org");
  const doneCount = actionable.filter((s) => s.done).length;
  const total = actionable.length;

  return (
    <OpCard accent={doneCount === total ? undefined : "warn"}>
      <OpCardHead
        title="Primeros pasos"
        actions={
          <span className="text-sm text-ln-op-mute font-normal" aria-hidden>
            {doneCount} / {total}
          </span>
        }
      />
      <OpCardBody className="p-0">
        {/* fieldset + legend for semantically grouped form-like checklist. */}
        <fieldset className="border-0 p-0 m-0">
          <legend className="sr-only">
            Progreso de configuración: {doneCount} de {total} pasos completados
          </legend>
          <ul
            aria-label={`${doneCount} de ${total} pasos completados`}
            className="divide-y divide-ln-op-line-2"
          >
            {steps.map((step, idx) => {
              // Only steps the ORG can act on are focus targets — a
              // waitingOn:"mimar" row has no CTA to focus, and autoFocus on a
              // row without a link is a focus trap for keyboard users.
              const isFirstPending =
                !step.done &&
                step.waitingOn === "org" &&
                autoFocusFirst &&
                idx === steps.findIndex((s) => !s.done && s.waitingOn === "org");

              return (
                <li
                  key={step.key}
                  className="flex items-start gap-3 px-4 py-3"
                  aria-current={isFirstPending ? "step" : undefined}
                >
                  {/* Done/pending icon — icon+text, never color alone (a11y Item 11 pattern). */}
                  <span
                    className={[
                      "mt-0.5 shrink-0 flex h-5 w-5 items-center justify-center rounded-full",
                      step.done
                        ? "bg-ln-op-ok text-white"
                        : "border border-ln-op-line-2 bg-ln-op-stripe",
                    ].join(" ")}
                    aria-hidden
                  >
                    {step.done ? <Icon name="check-circle" size={12} decorative /> : <PendingDot />}
                  </span>

                  {/* Step content */}
                  <div className="flex-1 min-w-0 space-y-1">
                    <p
                      className={[
                        "text-md font-semibold",
                        step.done ? "text-ln-op-mute line-through" : "text-ln-op-ink",
                      ].join(" ")}
                    >
                      {step.label}
                      {step.done && <span className="sr-only">(completado)</span>}
                    </p>
                    {!step.done && <p className="text-sm text-ln-op-mute">{step.hint}</p>}
                  </div>

                  {/* CTA — only when the step is pending AND the org can act
                      on it. A waitingOn:"mimar" step gets a status tag
                      instead: it is information, not a task, and a button
                      here would be the dead end this row used to be. */}
                  {!step.done && step.href !== null && step.cta !== null && (
                    <Link
                      href={`/org/${orgToken}/${step.href}`}
                      className={[
                        "shrink-0 rounded-[var(--radius-sm)] border border-ln-op-azul px-3 py-1",
                        "text-sm font-semibold text-ln-op-azul no-underline",
                        "hover:bg-ln-op-azul hover:text-white transition-colors",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ln-op-azul",
                      ].join(" ")}
                      autoFocus={isFirstPending}
                    >
                      {step.cta}
                    </Link>
                  )}
                  {/* The miMAR row is tagged in BOTH states, not just while
                      pending. Once approved it used to render exactly like an
                      org step — so a reader counted five ticks against a
                      counter reading "4 / 5" and had no way to tell which row
                      was outside the denominator. The tag is what makes the
                      excluded row identifiable. */}
                  {step.waitingOn === "mimar" && (
                    <span
                      className={[
                        "shrink-0 rounded-[var(--radius-sm)] border border-ln-op-line-2 px-3 py-1",
                        "text-sm font-semibold text-ln-op-mute",
                      ].join(" ")}
                    >
                      {step.done ? "Verificada por miMAR" : "En revisión de miMAR"}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </fieldset>
      </OpCardBody>
    </OpCard>
  );
}
