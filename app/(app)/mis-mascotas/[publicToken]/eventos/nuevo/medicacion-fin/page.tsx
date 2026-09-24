import { LnSheetCard, LnSheetWrap } from "@/components/ui/Sheet";
import { db, petEvents } from "@/db";
import { requireOwnedPetByToken } from "@/lib/infra/pets";
import { formatDate } from "@/lib/utils/format";
import { createMedicationEndAction } from "@/src/modules/events/actions-medical";
import { and, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { MedicationEndForm } from "./MedicationEndForm";

export default async function NewMedicationEndPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicToken: string }>;
  searchParams: Promise<{ occurredAt?: string; notes?: string }>;
}) {
  const { publicToken } = await params;
  const sp = await searchParams;
  // Captura-rápida URL-prefill slots (event-capture-registry).
  const defaults = {
    occurredAt: sp.occurredAt ?? null,
    notes: sp.notes ?? null,
  };
  const session = await requireOwnedPetByToken(publicToken);
  const { pet } = session;

  // Fetch all medication events for this pet in one query, then compute open
  // ones in app code (simpler than a SQL anti-join for v1).
  const medicationEvents = await db
    .select({
      id: petEvents.id,
      eventType: petEvents.eventType,
      occurredAt: petEvents.occurredAt,
      payload: petEvents.payload,
    })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, pet.id),
        inArray(petEvents.eventType, ["medication_started", "medication_stopped"]),
      ),
    );

  // Collect the IDs of started events that have been stopped.
  const stoppedIds = new Set<string>();
  for (const event of medicationEvents) {
    if (event.eventType === "medication_stopped") {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const ref = payload.medication_started_event_id;
      if (typeof ref === "string" && ref) stoppedIds.add(ref);
    }
  }

  // An open medication is a started event with no matching stopped event.
  const openMedications = medicationEvents
    .filter((e) => e.eventType === "medication_started" && !stoppedIds.has(e.id))
    .map((e) => {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      const drugName = typeof payload.drug_name === "string" ? payload.drug_name : "Medicamento";
      return {
        id: e.id,
        drugName,
        startedDate: formatDate(e.occurredAt),
      };
    });

  const boundAction = createMedicationEndAction.bind(null, pet.publicToken);

  if (openMedications.length === 0) {
    return (
      <LnSheetWrap>
        <LnSheetCard>
          <div className="px-[18px] py-6 space-y-[10px]">
            <p className="text-md text-[var(--color-ln-mute)]">
              No hay medicaciones abiertas para {pet.name}.
            </p>
            <Link
              href={`/mis-mascotas/${pet.publicToken}`}
              className="inline-block font-ln-mono text-sm text-[var(--color-ln-azul)] underline underline-offset-2"
            >
              ← Volver al perfil
            </Link>
          </div>
        </LnSheetCard>
      </LnSheetWrap>
    );
  }

  return (
    <LnSheetWrap>
      <LnSheetCard>
        <MedicationEndForm
          action={boundAction}
          openMedications={openMedications}
          defaults={defaults}
        />
      </LnSheetCard>
    </LnSheetWrap>
  );
}
