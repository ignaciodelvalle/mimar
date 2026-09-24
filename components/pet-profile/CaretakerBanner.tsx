// The titular's caretaker cockpit — one banner inside the pet profile's alert
// strip, next to lost / rabies / transit / cases / pregnancy.
//
// It answers one question at a time, in this order of urgency:
//   1. an arrangement LAPSED and nobody has told us where the animal is;
//   2. an arrangement is RUNNING;
//   3. an invitation is OUT and unanswered.
//
// (1) OUTRANKS (2) AND (3) BY CONSTRUCTION — `getCaretakerStateForPet` only
// fills `recentlyEnded` when nothing is active, so the ordering here is a
// statement of intent rather than a live tie-break.
//
// WHY (1) IS URGENT AT ALL. Expiry ends ACCESS. The cron reads a clock; it has
// no idea whether the dog is home. A cockpit that just dropped the banner would
// let the titular conclude the animal came back — the one wrong conclusion this
// feature must never encourage. So the notice stays up for a bounded window,
// says the period ended, and hands over the next move if it did not.
//
// A server component: no state, no handlers, and the page that mounts it is an
// RSC. Actions live one click away on /mis-mascotas/{token}/cuidado.

import Link from "next/link";

import { LnCallout } from "@/components/ui/DocElements";
import { formatDateShort } from "@/lib/utils/format";
import type { CaretakerState } from "@/src/modules/caretakers/application/get-caretaker-state-for-pet";
import {
  activeCaretakerSummary,
  ownerAutoEndNotice,
} from "@/src/modules/caretakers/domain/grant-copy";

type Props = {
  petName: string;
  petPublicToken: string;
  state: CaretakerState;
  /** Injected so the DD/MM year rule is testable at a pinned instant. */
  now?: Date;
};

export function CaretakerBanner({ petName, petPublicToken, state, now = new Date() }: Props) {
  const manageHref = `/mis-mascotas/${petPublicToken}/cuidado`;

  if (state.recentlyEnded) {
    return (
      <LnCallout tone="warn" title="El cuidado temporal terminó">
        <p className="m-0">
          {ownerAutoEndNotice({
            caretakerName: state.recentlyEnded.caretakerName,
            petName,
            endedAt: state.recentlyEnded.endsAt,
            now,
          })}
        </p>
        <p className="mt-2 mb-0">
          <Link href={manageHref}>Designar otro cuidador temporal</Link>
        </p>
      </LnCallout>
    );
  }

  if (state.active) {
    return (
      <LnCallout
        tone="azul"
        title={activeCaretakerSummary({
          caretakerName: state.active.caretakerName,
          endsAt: state.active.endsAt,
          now,
        })}
      >
        Puede cargar eventos y marcar perdido/encontrado. Seguís siendo el titular de {petName}.{" "}
        <Link href={manageHref}>Ver o finalizar el cuidado</Link>
      </LnCallout>
    );
  }

  if (state.pending) {
    return (
      <LnCallout tone="warn" title="Invitación de cuidado sin responder">
        {/* Two sentences rather than a semicolon: `lint/suspicious/
            noSuspiciousSemicolonInJsx` cannot tell Spanish punctuation from a
            refactor accident, and it is right to be suspicious. */}
        Invitaste a {state.pending.caretakerEmail} hasta el {formatDateShort(state.pending.endsAt)}.
        Todavía nadie tiene acceso a {petName}.{" "}
        <Link href={manageHref}>Ver o retirar la invitación</Link>
      </LnCallout>
    );
  }

  return null;
}
