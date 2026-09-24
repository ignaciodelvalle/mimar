// GobOnboardingChecklist — guided first-run checklist for the /gob home.
// T4-O3 (docs/plans/gob-onboarding-scoping.md, dim-interno).
//
// Mirrors components/OrgSetupChecklist.tsx (the org-side precedent this
// feature's scoping doc cites as "the state-derived checklist idiom to
// follow"): rendered as an OpCard, auto-hides once every step is done, each
// step shows done (✓) or pending with a CTA link — adapted for /gob's
// absolute routes (no orgToken to prefix hrefs with) and for a step that
// legitimately has no CTA (G1 — see lib/infra/gob-onboarding-checklist.ts).
//
// A11y: same <fieldset>+<legend> wrapper, <ul>/<li> list, aria-label
// progress, icon+text done indicator (never color alone). Focus managed by
// the parent (app/gob/page.tsx passes autoFocusFirst unconditionally while the
// card renders — same call OrgSetupChecklist's own caller makes).

import Link from "next/link";

import { Icon } from "@/components/Icon";
import { OpCard, OpCardBody, OpCardHead } from "@/components/ui/dashboard";
import type { GobOnboardingStep } from "@/lib/infra/gob-onboarding-checklist";
import { pluralizeEs } from "@/lib/utils/format";

// Pending indicator: a simple open circle rendered via Tailwind border classes.
// Using a <span> avoids adding a new icon name to the Icon component for a
// single usage (same call as OrgSetupChecklist's PendingDot).
function PendingDot() {
  return (
    <span
      aria-hidden
      className="inline-block h-2 w-2 rounded-full border border-ln-op-line-2 bg-transparent"
    />
  );
}

type Props = {
  steps: GobOnboardingStep[];
  /** When true, the autoFocus attribute is set on the first pending step's CTA. */
  autoFocusFirst?: boolean;
};

export function GobOnboardingChecklist({ steps, autoFocusFirst = false }: Props) {
  const doneCount = steps.filter((s) => s.done).length;
  const total = steps.length;
  const stepsNoun = pluralizeEs(total, "paso");

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
            Progreso de configuración: {doneCount} de {total} {stepsNoun} completados
          </legend>
          <ul
            // pluralizeEs called INLINE (not via the stepsNoun above) —
            // lint:plural exempts a line only when the literal call is on it.
            aria-label={`${doneCount} de ${total} ${pluralizeEs(total, "paso")} completados`}
            className="divide-y divide-ln-op-line-2"
          >
            {steps.map((step, idx) => {
              // A step with no href/cta (G1) has nowhere to send focus — it
              // must never be the autoFocus target, same discipline as
              // OrgSetupChecklist's waitingOn:"mimar" exclusion.
              const isFirstPending =
                !step.done &&
                step.href !== null &&
                step.cta !== null &&
                autoFocusFirst &&
                idx === steps.findIndex((s) => !s.done && s.href !== null && s.cta !== null);

              return (
                <li
                  key={step.key}
                  className="flex items-start gap-3 px-4 py-3"
                  aria-current={isFirstPending ? "step" : undefined}
                >
                  {/* Done/pending icon — icon+text, never color alone (a11y). */}
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

                  {/* CTA — only when the step is pending AND has somewhere to
                      send the operator. A step with no destination (G1) shows
                      no button — a link here would be the dead end
                      org-setup-checklist.ts's header note warns against. */}
                  {!step.done && step.href !== null && step.cta !== null && (
                    <Link
                      href={step.href}
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
                </li>
              );
            })}
          </ul>
        </fieldset>
      </OpCardBody>
    </OpCard>
  );
}
