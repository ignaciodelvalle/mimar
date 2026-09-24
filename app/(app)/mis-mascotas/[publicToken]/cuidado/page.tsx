// `/mis-mascotas/{token}/cuidado` — the titular's caretaker surface.
//
// ONE ROUTE, THREE STATES, because they are the same decision at different
// moments: "who is looking after this animal, and until when?"
//   - nothing open   → the designation form
//   - invitation out → who was invited, and the lever to withdraw it
//   - arrangement on → who has access, until when, and "finalizar ahora"
//
// GATED BY requireTitularAccess, NOT requirePetAccess. This is deny-list row
// `caretaker-sub-designation`: a caretaker holds a Path-1 ownership row and
// would sail through requirePetAccess. The actions behind the form enforce the
// same gate, so this is the belt to that suspenders — but it is the half that
// stops a caretaker from ever SEEING the control, which is the difference
// between a boundary and a wall you discover by walking into it.
//
// A denied caretaker gets a SENTENCE, not a 404. requireTitularAccess returns
// the structural reason `not-titular` for exactly this: pretending the pet does
// not exist to somebody who is legitimately caring for it is a lie the UI
// cannot recover from.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { LnCallout } from "@/components/ui/DocElements";
import { requireTitularAccess } from "@/lib/infra/pet-access";
import { formatDateShort, todayIsoInAr } from "@/lib/utils/format";
import { getCaretakerStateForPet } from "@/src/modules/caretakers/application/get-caretaker-state-for-pet";
import { activeCaretakerSummary } from "@/src/modules/caretakers/domain/grant-copy";
import { CaretakersRepository } from "@/src/modules/caretakers/infrastructure/caretakers-repository";

import { CaretakerGrantControls } from "./CaretakerGrantControls";
import { DesignateCaretakerForm } from "./DesignateCaretakerForm";

export default async function PetCaretakerPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;

  const access = await requireTitularAccess(publicToken);
  if (!access.ok) {
    if (access.reason === "no-session") {
      redirect(
        `/iniciar-sesion?returnTo=${encodeURIComponent(`/mis-mascotas/${publicToken}/cuidado`)}`,
      );
    }
    if (access.reason === "not-titular") {
      return (
        <div className="mx-auto max-w-md px-8 py-7 pb-12">
          <LnCallout tone="warn" title="Solo el titular puede designar un cuidador">
            {access.error} Podés seguir cargando eventos, notas y marcar perdido/encontrado.
          </LnCallout>
          <Link
            href={`/mis-mascotas/${publicToken}`}
            className="mt-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
          >
            Volver a la libreta
          </Link>
        </div>
      );
    }
    notFound();
  }

  const { pet } = access;
  const now = new Date();
  const state = await getCaretakerStateForPet(pet.id, {
    repo: CaretakersRepository,
    now: () => now,
  });

  return (
    <div className="mx-auto max-w-md px-8 py-7 pb-12">
      <Link
        href={`/mis-mascotas/${pet.publicToken}`}
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← {pet.name}
      </Link>

      <h1 className="m-0 mb-1.5 font-ln-serif text-2xl font-semibold leading-tight tracking-[-0.01em] text-[var(--color-ln-ink)]">
        Cuidador temporal de {pet.name}
      </h1>
      <p className="mt-0 mb-6 text-md text-[var(--color-ln-mute)]">
        Alguien de confianza puede cargar lo que le pase a {pet.name} mientras la cuida. No es una
        transferencia y no cambia de dueño.
      </p>

      {state.active ? (
        <div className="space-y-5">
          <LnCallout
            tone="azul"
            title={activeCaretakerSummary({
              caretakerName: state.active.caretakerName,
              endsAt: state.active.endsAt,
              now,
            })}
          >
            Desde el {formatDateShort(state.active.startsAt)}. Si no lo finalizás antes, el cuidado
            termina solo en esa fecha y {state.active.caretakerName} pierde el acceso.
          </LnCallout>
          <CaretakerGrantControls
            petPublicToken={pet.publicToken}
            petName={pet.name}
            grantToken={state.active.grantPublicToken}
            caretakerLabel={state.active.caretakerName}
            kind="active"
          />
        </div>
      ) : state.pending ? (
        <div className="space-y-5">
          <LnCallout tone="warn" title="Invitación enviada, sin responder">
            Invitaste a {state.pending.caretakerEmail} a cuidar a {pet.name} hasta el{" "}
            {formatDateShort(state.pending.endsAt)}. Todavía no aceptó, así que nadie tiene acceso.
          </LnCallout>
          <CaretakerGrantControls
            petPublicToken={pet.publicToken}
            petName={pet.name}
            grantToken={state.pending.grantPublicToken}
            caretakerLabel={state.pending.caretakerEmail}
            kind="pending"
          />
        </div>
      ) : (
        <DesignateCaretakerForm
          petPublicToken={pet.publicToken}
          petName={pet.name}
          todayIso={todayIsoInAr(now)}
        />
      )}
    </div>
  );
}
