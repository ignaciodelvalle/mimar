// PendingSignaturesCard — owner-declared chip/esterilización events waiting
// on a professional signature (#3, #43 keystone extension). Server Component:
// read-only, no client state. Each row links into the SAME AtenderCaptureMounter
// surface (?evento=chip|esterilizacion) with the declared values prefilled —
// the actual sign-off is a normal atender form submit, no separate mechanism.
//
// The href MUST carry `confirmEventId` (RA-2 F1). It is the only channel by
// which the declared row's id reaches atenderMicrochipAction /
// atenderSterilizationAction: AtenderCaptureMounter reads it from the query
// string and binds it as a server-action argument, and the actions call
// rejectIfAlreadySigned only when it is present. Without it the duplicate-
// signature guard — the last line of defence when a post-action navigation is
// dropped — is dead code on every user path. `item.id` used as a React key
// ONLY is exactly the shape of that defect; PendingSignaturesCard.test.tsx
// pins the id all the way from this href into the bound action argument.

import Link from "next/link";

import { OpCard, OpCardBody, OpCardHead } from "@/components/ui/dashboard";

import type { PendingDeclaredEvent } from "../atender-declared-events";

const EVENTO_BY_TYPE: Record<PendingDeclaredEvent["eventType"], string> = {
  microchip_implanted: "chip",
  sterilization_performed: "esterilizacion",
};

export function PendingSignaturesCard({
  orgToken,
  publicToken,
  pending,
  /** RA-2 F2: only a validated matrícula produces a SIGNATURE. Without one the
   * submission is an `org_registered` record, so the CTA must not promise a
   * signature the signer cannot give — the card will still be here afterwards. */
  signerMatriculaVerified,
}: {
  orgToken: string;
  publicToken: string;
  pending: PendingDeclaredEvent[];
  signerMatriculaVerified: boolean;
}) {
  if (pending.length === 0) return null;

  const ctaLabel = signerMatriculaVerified ? "Confirmar y firmar →" : "Confirmar y registrar →";

  return (
    <OpCard>
      <OpCardHead title="Declarado por el dueño · pendiente de firma" />
      <OpCardBody>
        {!signerMatriculaVerified && (
          <p className="mb-2 text-sm text-ln-op-ink-2">
            Podés dejar el registro a nombre de la organización, pero la firma seguirá pendiente
            hasta que lo confirme alguien con matrícula validada.
          </p>
        )}
        <ul className="space-y-2">
          {pending.map((item) => {
            const params = new URLSearchParams({
              evento: EVENTO_BY_TYPE[item.eventType],
              confirmEventId: item.id,
              ...item.prefill,
            });
            return (
              <li
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-ln-op-line px-3 py-2"
              >
                <span className="text-sm text-ln-op-ink">{item.summary}</span>
                <Link
                  href={`/org/${orgToken}/atender/${publicToken}?${params.toString()}`}
                  className="text-sm font-semibold text-ln-op-azul no-underline hover:underline"
                >
                  {ctaLabel}
                </Link>
              </li>
            );
          })}
        </ul>
      </OpCardBody>
    </OpCard>
  );
}
