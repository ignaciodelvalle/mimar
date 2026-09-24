import { VetPersonalChannelHint } from "@/components/pet-profile/VetPersonalChannelHint";
import { LnSheetCard, LnSheetWrap } from "@/components/ui/Sheet";
import { db, reminders } from "@/db";
import { requireOwnedPetByToken } from "@/lib/infra/pets";
import { isUuid } from "@/lib/utils/uuid";
import { createVaccinationAction } from "@/src/modules/events/actions-medical";
import { and, eq, isNull } from "drizzle-orm";
import { VaccinationForm } from "./VaccinationForm";

export default async function NewVaccinationPage({
  params,
  searchParams,
}: {
  params: Promise<{
    publicToken: string;
    vaccineName?: string;
    occurredAt?: string;
    notes?: string;
  }>;
  searchParams: Promise<{
    reminderId?: string;
    vaccineName?: string;
    occurredAt?: string;
    notes?: string;
    autoconfirm?: string;
  }>;
}) {
  const { publicToken } = await params;
  const sp = await searchParams;
  const session = await requireOwnedPetByToken(publicToken);
  const { pet, user, accessPath } = session;

  // If routed from a pending reminder, pre-fill the vaccine name from
  // its title. This is the original prefill path (kept intact).
  let initialVaccineName: string | undefined = sp.vaccineName ?? undefined;
  let validReminderId: string | undefined;
  // Guard the uuid column comparison: reminderId arrives from a query string
  // (notification CTAs, reminder actions, hand-typed URLs). A non-uuid value
  // hits Postgres 22P02 and crashes the RSC — a garbage/stale ?reminderId=
  // must degrade to "no prefill", not a 500 (same class as lib/utils/uuid's
  // other call sites).
  if (isUuid(sp.reminderId)) {
    const [reminder] = await db
      .select()
      .from(reminders)
      .where(
        and(
          eq(reminders.id, sp.reminderId),
          eq(reminders.petId, pet.id),
          isNull(reminders.completedAt),
        ),
      )
      .limit(1);
    if (reminder) {
      // Reminder title wins over URL slot when both are present.
      initialVaccineName = reminder.title;
      validReminderId = reminder.id;
    }
  }

  // Captura-rápida URL-prefill slots (event-capture-registry).
  const defaults = {
    occurredAt: sp.occurredAt ?? null,
    notes: sp.notes ?? null,
  };

  const boundAction = createVaccinationAction.bind(null, pet.publicToken);

  return (
    <LnSheetWrap>
      <LnSheetCard>
        {/* #757 — said BEFORE the submit, where the surprise happens. */}
        <VetPersonalChannelHint userId={user.id} accessPath={accessPath} />
        <VaccinationForm
          action={boundAction}
          species={pet.species}
          initialVaccineName={initialVaccineName}
          sourceReminderId={validReminderId}
          defaults={defaults}
          autoConfirm={sp.autoconfirm === "1"}
        />
      </LnSheetCard>
    </LnSheetWrap>
  );
}
