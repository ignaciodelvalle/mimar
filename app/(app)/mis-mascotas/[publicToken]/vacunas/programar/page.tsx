// Programar vacuna — Libreta Nacional redesign.
// Presentation only; ScheduleVaccineForm and server action unchanged.

import Link from "next/link";

import { createVaccineReminderAction } from "@/app/actions/reminders";
import { requireOwnedPetByToken } from "@/lib/infra/pets";
import { ScheduleVaccineForm } from "./ScheduleVaccineForm";

export default async function ScheduleVaccinePage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  const session = await requireOwnedPetByToken(publicToken);
  const { pet } = session;

  const boundAction = createVaccineReminderAction.bind(null, pet.publicToken);

  return (
    <div className="mx-auto max-w-md px-8 py-7 pb-12">
      {/* Back */}
      <Link
        href={`/mis-mascotas/${pet.publicToken}`}
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← {pet.name}
      </Link>

      {/* Header */}
      <div className="mb-6">
        <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
          Programar vacuna
        </h1>
        <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
          Anotá la próxima vacuna de {pet.name} para no olvidártela. Vas a verla en "Próximas
          vacunas" hasta que la marques como aplicada.
        </p>
      </div>

      <ScheduleVaccineForm action={boundAction} species={pet.species} />

      {/* Secondary CTA */}
      <div className="mt-7 border-t border-[var(--color-ln-line-2)] pt-5">
        <p className="font-ln-mono text-sm text-[var(--color-ln-mute)]">
          ¿Preferís ir directo a una clínica o campaña?
        </p>
        <Link
          href="/turnos/buscar?service_kind=vaccination_rabies"
          className="mt-1 inline-block font-ln-mono text-sm text-[var(--color-ln-azul)] no-underline hover:underline"
        >
          Buscar turno con veterinario en mi zona →
        </Link>
      </div>
    </div>
  );
}
