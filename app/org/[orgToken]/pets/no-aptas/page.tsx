import Link from "next/link";

import { OpCard, OpCardBody, OpCardHead, OpCrumbs, OpPill } from "@/components/ui/dashboard";
import { db, ownerships, pets } from "@/db";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { formatDateShort, speciesLabel } from "@/lib/utils/format";
import { and, desc, eq, isNull } from "drizzle-orm";

// This list was previously unbounded. Cap it and signal truncation (mirrors
// the intake queue cap — app/org/[orgToken]/intake/page.tsx) so a shelter
// with a large ineligible roster isn't silently shown a partial list with no
// notice. Ordered by most recently updated so the cap surfaces the freshest
// eligibility calls first.
const NO_APTAS_CAP = 100;

const REASON_LABELS: Record<string, string> = {
  medical_treatment: "Tratamiento médico en curso",
  behavioral_evaluation: "Evaluación de comportamiento",
  recovery: "Recuperación",
  quarantine: "Cuarentena",
  legal_hold: "Retención legal",
  age: "Edad",
  pending_intake_eval: "Evaluación de intake pendiente",
  other: "Otro",
};

export default async function PetsNoAptasPage({
  params,
}: {
  params: Promise<{ orgToken: string }>;
}) {
  const { orgToken } = await params;
  const { organization } = await requireOrgAccessByToken(orgToken);

  const rawRows = await db
    .select({ pet: pets })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(ownerships.ownerOrganizationId, organization.id),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
        eq(pets.adoptionEligible, false),
        // Art. 16: erasure soft-deletes the pet but not the ownership rows.
        isNull(pets.deletedAt),
      ),
    )
    .orderBy(desc(pets.updatedAt))
    .limit(NO_APTAS_CAP + 1);

  const truncated = rawRows.length > NO_APTAS_CAP;
  const rows = truncated ? rawRows.slice(0, NO_APTAS_CAP) : rawRows;

  // Group by reason.
  const byReason = new Map<string, typeof rows>();
  for (const row of rows) {
    const reason = row.pet.adoptionIneligibleReason ?? "other";
    const list = byReason.get(reason) ?? [];
    list.push(row);
    byReason.set(reason, list);
  }

  const now = new Date();

  return (
    <main className="min-h-screen bg-ln-op-page p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <header className="space-y-1">
          <OpCrumbs
            items={[
              { label: "Panel", href: `/org/${orgToken}` },
              { label: "Mascotas", href: `/org/${orgToken}/mascotas` },
              { label: "No aptas" },
            ]}
          />
          <h1 className="text-title font-semibold text-ln-op-ink">
            Mascotas no aptas para adopción
          </h1>
          <p className="text-md text-ln-op-ink-2">
            Animales en custodia marcados explícitamente como NO aptos para adopción. Resolvé el
            motivo desde el perfil del pet para volver a marcarlos como aptos.
          </p>
        </header>

        {truncated && (
          <p className="text-sm text-ln-op-mute">
            Mostrando las {NO_APTAS_CAP} mascotas actualizadas más recientemente. Hay más en el
            listado de mascotas de la organización.
          </p>
        )}

        {rows.length === 0 ? (
          <p className="text-md text-ln-op-mute py-6 text-center">
            No hay mascotas marcadas como no aptas.
          </p>
        ) : (
          Array.from(byReason.entries()).map(([reason, list]) => (
            <OpCard key={reason}>
              <OpCardHead title={REASON_LABELS[reason] ?? reason} />
              <OpCardBody>
                <ul className="space-y-2">
                  {list.map(({ pet }) => {
                    const until = pet.adoptionIneligibleUntil
                      ? new Date(pet.adoptionIneligibleUntil)
                      : null;
                    const reEvalDue = until ? until < now : false;
                    return (
                      <li
                        key={pet.id}
                        className="rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-stripe p-3 space-y-1"
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <Link
                            href={`/org/${orgToken}/mascotas/${pet.publicToken}/eligibility`}
                            className="text-md font-medium text-ln-op-ink hover:underline"
                          >
                            {pet.name}
                          </Link>
                          {reEvalDue && <OpPill tone="open">Re-evaluación vencida</OpPill>}
                        </div>
                        <p className="text-sm text-ln-op-mute">
                          {speciesLabel(pet.species)}
                          {pet.adoptionIneligibleReasonNotes &&
                            ` · ${pet.adoptionIneligibleReasonNotes}`}
                          {until && (
                            <>
                              {" · "}
                              <span>vence {formatDateShort(until)}</span>
                            </>
                          )}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              </OpCardBody>
            </OpCard>
          ))
        )}

        <footer className="pt-4 border-t border-ln-op-line">
          <Link
            href={`/org/${orgToken}/mascotas`}
            className="text-sm text-ln-op-mute underline hover:text-ln-op-ink"
          >
            ← Volver al listado
          </Link>
        </footer>
      </div>
    </main>
  );
}
