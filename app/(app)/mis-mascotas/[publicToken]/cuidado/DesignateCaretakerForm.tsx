"use client";

// The titular designates a temporary caretaker.
//
// WHAT THIS FORM IS RESPONSIBLE FOR, beyond collecting three fields:
//
//   1. Never offering a period the domain will refuse. The end-date picker's
//      `min`/`max` come from `caretakerEndDateBounds`, the SAME helper
//      `validateDesignation` is boundary-tested against. Client validation
//      here is a courtesy, not a control — the action re-validates — but a
//      courtesy that disagrees with the rule is worse than none.
//   2. Saying out loud what is being handed over. The invitee will be shown
//      the scope on `/cuidado/{token}`; the person GRANTING it has at least as
//      much right to read it before they send the invitation.
//   3. Saying out loud what is NOT being handed over. The asymmetry is the
//      product (PO decision 3): the titular keeps everything, including the
//      power to end the arrangement unilaterally and instantly.
//
// Contract N3: the action returns, this component renders LnSuccessScreen. No
// redirect(), no router.refresh().

import { useState, useTransition } from "react";

import { LnButton } from "@/components/ui/Button";
import { LnField, LnInput, LnTextarea } from "@/components/ui/Field";
import { LnSuccessScreen } from "@/components/ui/SuccessScreen";
import { designateCaretakerAction } from "@/src/modules/caretakers/actions";
import {
  CARETAKER_SCOPE_ALLOWED,
  CARETAKER_SCOPE_DENIED,
} from "@/src/modules/caretakers/domain/grant-copy";
import {
  MAX_GRANT_DURATION_DAYS,
  caretakerEndDateBounds,
} from "@/src/modules/caretakers/domain/grant-rules";

type Props = {
  petPublicToken: string;
  petName: string;
  /** Today's ARGENTINE calendar day, resolved server-side (todayIsoInAr). */
  todayIso: string;
};

export function DesignateCaretakerForm({ petPublicToken, petName, todayIso }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const [inviteeEmail, setInviteeEmail] = useState("");
  const [startsAt, setStartsAt] = useState(todayIso);
  const [endsAt, setEndsAt] = useState("");
  const [note, setNote] = useState("");

  const bounds = caretakerEndDateBounds(startsAt);

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await designateCaretakerAction({
        petPublicToken,
        inviteeEmail: inviteeEmail.trim(),
        startsAt,
        endsAt,
        note: note.trim() || null,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSentTo(inviteeEmail.trim());
    });
  }

  if (sentTo) {
    return (
      <LnSuccessScreen
        title="Invitación enviada"
        description={`Le avisamos a ${sentTo}. Hasta que acepte no cambia nada: ${petName} sigue siendo solo tuya y podés retirar la invitación cuando quieras.`}
        next={[
          { label: `Volver a ${petName}`, href: `/mis-mascotas/${petPublicToken}` },
          { label: "Ver mis mascotas", href: "/mis-mascotas", variant: "secondary" },
        ]}
      />
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <LnField label="Correo de la persona" required>
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            aria-describedby={describedBy}
            invalid={invalid}
            type="email"
            required
            autoComplete="email"
            value={inviteeEmail}
            onChange={(e) => setInviteeEmail(e.target.value)}
            placeholder="nombre@correo.com"
          />
        )}
      </LnField>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <LnField label="Desde" required>
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              type="date"
              required
              min={todayIso}
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          )}
        </LnField>

        <LnField
          label="Hasta"
          required
          hint={`El período máximo de cuidado es de ${MAX_GRANT_DURATION_DAYS} días.`}
        >
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              type="date"
              required
              min={bounds.minIso ?? undefined}
              max={bounds.maxIso ?? undefined}
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
            />
          )}
        </LnField>
      </div>

      <LnField label="Nota para quien cuida" optional>
        {({ id, describedBy }) => (
          <LnTextarea
            id={id}
            aria-describedby={describedBy}
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Rutina, medicación, lo que necesite saber"
          />
        )}
      </LnField>

      <section
        aria-labelledby="cg-grant-scope-h"
        className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-4 py-3.5"
      >
        <h2
          id="cg-grant-scope-h"
          className="m-0 mb-2 font-ln-serif text-md font-semibold text-[var(--color-ln-ink)]"
        >
          Qué va a poder hacer
        </h2>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          <li className="text-md leading-snug text-[var(--color-ln-ink-2)]">
            {CARETAKER_SCOPE_ALLOWED}
          </li>
          <li className="text-md leading-snug text-[var(--color-ln-ink-2)]">
            {CARETAKER_SCOPE_DENIED}
          </li>
        </ul>
        <p className="mt-2 mb-0 text-sm leading-snug text-[var(--color-ln-mute)]">
          Seguís siendo el titular de {petName}. Podés finalizar el cuidado cuando quieras, sin
          pedir permiso.
        </p>
      </section>

      {error && <output className="block text-sm text-[var(--color-ln-err)]">{error}</output>}

      <div className="flex flex-wrap gap-2">
        <LnButton type="submit" variant="primary" disabled={pending}>
          {pending ? "Enviando…" : "Invitar como cuidador/a"}
        </LnButton>
        <LnButton href={`/mis-mascotas/${petPublicToken}`} variant="ghost">
          Volver
        </LnButton>
      </div>
    </form>
  );
}
