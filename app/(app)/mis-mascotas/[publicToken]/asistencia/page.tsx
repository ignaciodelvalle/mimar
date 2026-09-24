// Perro de asistencia — Libreta Nacional redesign.
// Presentation only; ServiceDogForm and data fetching unchanged.

import Link from "next/link";
import { notFound } from "next/navigation";

import { LnCard, LnCardBody, LnCardHead } from "@/components/ui/Card";
import { LnCallout } from "@/components/ui/DocElements";
import { type Pet, db, ownerships, petServiceDog, pets } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { speciesLabel } from "@/lib/utils/format";
import { and, eq, isNull } from "drizzle-orm";
import { ServiceDogForm } from "./ServiceDogForm";

const ROLE_LABELS: Record<string, string> = {
  shelter_custody: "custodia temporal (tránsito)",
  foster: "tránsito formal",
  co_owner: "co-dueño",
  caretaker: "cuidador",
};

function FriendlyOwnerOnlyPage({ pet, role }: { pet: Pet; role: string }) {
  const roleLabel = ROLE_LABELS[role] ?? role;
  return (
    <div className="mx-auto max-w-2xl px-8 py-7 pb-12">
      <Link
        href={`/mis-mascotas/${pet.publicToken}`}
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← Volver al perfil
      </Link>
      <h1 className="m-0 mb-4 font-ln-serif text-2xl font-semibold text-[var(--color-ln-ink)]">
        Perro de asistencia · {pet.name}
      </h1>
      <LnCallout
        tone="warn"
        title="La credencial de asistencia se registra solo bajo dueño legal permanente."
      >
        Tu vínculo actual con <strong>{pet.name}</strong> es de <strong>{roleLabel}</strong>. Para
        registrar al animal como de asistencia, primero debe completarse la transferencia legal de
        custodia.
      </LnCallout>
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  en_entrenamiento: "En entrenamiento",
  pendiente_verificacion: "Pendiente de verificación",
  vigente: "Vigente",
  vencida: "Vencida",
  revocada: "Revocada",
};

function statusBadgeClass(status: string): string {
  switch (status) {
    case "vigente":
      return "border-[var(--color-ln-ok-100)] bg-[var(--color-ln-ok-050)] text-[var(--color-ln-ok)]";
    case "pendiente_verificacion":
      return "border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-050)] text-[var(--color-ln-warn)]";
    case "vencida":
    case "revocada":
      return "border-[var(--color-ln-err-100)] bg-[var(--color-ln-err-050)] text-[var(--color-ln-err)]";
    default:
      return "border-[var(--color-ln-line-strong)] bg-[var(--color-ln-stripe)] text-[var(--color-ln-mute)]";
  }
}

export default async function AsistenciaPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  const { user } = await requireUserOrRedirect();

  const [accessRow] = await db
    .select({ pet: pets, role: ownerships.role })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(pets.publicToken, publicToken),
        // Art. 16 (Ley 25.326): an erased pet reads as never registered. This
        // page resolves access INLINE (not through resolvePetHolderAccess), and
        // the erasure only soft-deletes the role='owner' pet — a co-owner or
        // foster keeps a live ownership row, so without this term a non-owner
        // holder would still land on FriendlyOwnerOnlyPage naming the erased pet.
        isNull(pets.deletedAt),
        eq(ownerships.ownerUserId, user.id),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);
  if (!accessRow) notFound();
  if (accessRow.role !== "owner") {
    return <FriendlyOwnerOnlyPage pet={accessRow.pet} role={accessRow.role} />;
  }
  const pet = accessRow.pet;

  const [serviceDog] = await db
    .select()
    .from(petServiceDog)
    .where(eq(petServiceDog.petId, pet.id))
    .limit(1);

  return (
    <div className="mx-auto max-w-2xl px-8 py-7 pb-12">
      {/* Back */}
      <Link
        href={`/mis-mascotas/${publicToken}`}
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← {pet.name}
      </Link>

      {/* Header */}
      <div className="mb-6">
        <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.01em] text-[var(--color-ln-ink)]">
          Perro de asistencia · {pet.name}
        </h1>
        <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
          Marco legal: <strong>Ley 26.858</strong> (acceso, deambulación y permanencia) ·
          Reglamentación: Decreto 792/2019 · Registro: <strong>RUPGA</strong> (ANDIS, Res.
          2588/2022).
        </p>
      </div>

      <div className="flex flex-col gap-5">
        {pet.species !== "dog" && (
          <LnCallout tone="warn">
            Ley 26.858 reconoce este derecho de acceso solo para perros. Esta sección no aplica a{" "}
            <strong>{speciesLabel(pet.species).toLowerCase()}</strong>.
          </LnCallout>
        )}

        {serviceDog && (
          <LnCard>
            <LnCardHead title="Estado de la credencial" />
            <LnCardBody>
              <div className="flex items-center justify-between gap-3">
                <p className="text-md text-[var(--color-ln-ink-2)]">
                  {serviceDog.inService ? "En servicio activo." : "Retirado del servicio."}{" "}
                  Visibilidad pública:{" "}
                  <strong>
                    {serviceDog.publicVisibility === "full_banner" ? "activada" : "solo privado"}
                  </strong>
                  .
                </p>
                <span
                  className={`flex-shrink-0 inline-flex items-center rounded-[var(--radius-xs)] border px-2 py-0.5 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] ${statusBadgeClass(serviceDog.credentialStatus)}`}
                >
                  {STATUS_LABELS[serviceDog.credentialStatus] ?? serviceDog.credentialStatus}
                </span>
              </div>
              {serviceDog.credentialStatus === "revocada" && serviceDog.revocationReason && (
                <p className="mt-2 text-md text-[var(--color-ln-err)]">
                  Motivo de revocación: {serviceDog.revocationReason}
                </p>
              )}
              {serviceDog.credentialStatus === "pendiente_verificacion" && (
                <p className="mt-2 text-md leading-relaxed text-[var(--color-ln-warn)]">
                  Reportado a RUPGA (ANDIS) — pendiente de sincronización y validación por la
                  autoridad. La credencial no puede presentarse como vigente hasta que ANDIS la
                  valide.
                </p>
              )}
              {serviceDog.credentialStatus === "en_entrenamiento" && (
                <p className="mt-2 text-md leading-relaxed text-[var(--color-ln-ink-2)]">
                  En entrenamiento. Una vez finalizado, enviá la solicitud de verificación para que
                  RUPGA (ANDIS) valide la credencial.
                </p>
              )}
              {serviceDog.credentialStatus === "vigente" && (
                <div className="mt-2">
                  <p className="text-md text-[var(--color-ln-ok)]">
                    Tu banner público está activo cuando elegís mostrarlo. Lo podés presentar en la
                    puerta de un local, transporte o servicio público.
                  </p>
                  <Link
                    href={`/mis-mascotas/${publicToken}/asistencia/presentar`}
                    className="mt-1.5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-ok)] no-underline hover:underline"
                  >
                    Presentar credencial →
                  </Link>
                </div>
              )}
            </LnCardBody>
          </LnCard>
        )}

        <LnCallout tone="azul" title="Sobre tu privacidad (Ley 25.326)">
          Registrar a tu perro como de asistencia revela información sobre tu discapacidad, que es
          un dato sensible bajo el Art. 7 de la Ley de Protección de Datos Personales. Por eso el
          banner público arranca apagado y tenés que activarlo vos. Solo se muestra cuando tu
          credencial está vigente y elegís hacerlo visible.
        </LnCallout>

        {pet.species === "dog" && (
          <ServiceDogForm petPublicToken={publicToken} initial={serviceDog ?? null} />
        )}
      </div>
    </div>
  );
}
