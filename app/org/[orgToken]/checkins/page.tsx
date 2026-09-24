// Post-adoption check-in dashboard for the org side. Lists check-ins
// recorded by adopters AND open reminders for pets that were adopted via
// the active organization. Gated on adoption.review capability (placeholder
// in the catalog since slice 1 — this page gives it its first job).
//
// Companion to the cron in app/api/cron/post-adoption-checkin/route.ts and
// the owner-side form at /mis-mascotas/[token]/eventos/nuevo/checkin.

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import Link from "next/link";

import { OpAccessDenied, OpCard, OpCardBody } from "@/components/ui/dashboard";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import { db, petEvents, pets, profiles, reminders } from "@/db";
import { loadWithTimeout } from "@/lib/analytics/analytics-load";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { formatDateTimeNumericAr } from "@/lib/utils/format";
import { requireCapability } from "@/src/modules/organizations/infrastructure/authz-resolver";

function formatDate(d: Date | string): string {
  return formatDateTimeNumericAr(d);
}

function daysFromNow(dueAt: Date | string, now: Date): number {
  const due = typeof dueAt === "string" ? new Date(dueAt) : dueAt;
  return Math.round((due.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}

// Both lists are recency-bounded; cap the fetch and signal truncation (audit
// #15) so a high-volume org isn't silently shown a partial list with no notice.
const CHECKIN_CAP = 30;

export default async function CheckinsPage({
  params,
}: {
  params: Promise<{ orgToken: string }>;
}) {
  const { orgToken } = await params;
  // Pre-validate membership. requireCapability below also checks, but we need
  // the organization.id to scope requireCapability to the right org.
  const { organization: orgFromToken } = await requireOrgAccessByToken(orgToken);
  // A page READ: a deactivated institutional account keeps it, per
  // lib/infra/auth-guards.ts:60-70 — reads stay open, writes stop.
  const auth = await requireCapability("adoption.review", orgFromToken.id, { access: "read" });
  if (auth.error !== null) {
    // Same panel, same words, now from one place — see OpAccessDenied for the
    // agenda/checkins divergence that made it a component (native QA batch 2, C3).
    return <OpAccessDenied reason={auth.error} orgToken={orgToken} />;
  }
  const { organization } = auth;

  // Pet IDs adopted via this org. The JSON cast on payload->>X is the
  // canonical way to filter on payload fields in Postgres; the adoption
  // event's previous_owner_organization_id was denormalized there at
  // adoption time precisely so this query stays simple (no ownerships
  // history scan).
  //
  // BOUNDED (2026-08-09 resilience pass), and DISTINCT in SQL. The predicate is
  // a JSON extraction on pet_events.payload, so it cannot use a plain index —
  // and it carried no LIMIT and no deadline, which made this the heaviest
  // unbounded await in the org portal. The dedup that was happening in JS
  // (`new Set`) now happens in Postgres, so a pet adopted out twice stops
  // costing a row on the wire.
  //
  // Deliberately NOT capped with a LIMIT: a cap here would silently drop
  // adoptions from the check-in list with nothing on screen to say so. A
  // deadline bounds the failure honestly; a LIMIT would hide it.
  const adoptedLoad = await loadWithTimeout(
    db
      .selectDistinct({ petId: petEvents.petId })
      .from(petEvents)
      // Art. 16: bound petIds to non-erased pets at the source — every list
      // below (check-ins, overdue reminders) renders the pet's name, and the
      // adopter's erasure soft-deletes the pet without touching these events.
      // Same filter countOverdueCheckins (org-dashboard.ts) applies, so the
      // shared badge and this page keep counting the same population.
      .innerJoin(pets, eq(pets.id, petEvents.petId))
      .where(
        and(
          eq(petEvents.eventType, "adoption_finalized"),
          sql`${petEvents.payload}->>'previous_owner_organization_id' = ${organization.id}`,
          isNull(pets.deletedAt),
        ),
      ),
  );
  if (!adoptedLoad.ok) {
    return (
      <div className="max-w-3xl space-y-8">
        <PageHeader orgName={organization.displayName} />
        <AnalyticsLoadFallback
          reason={adoptedLoad.reason}
          correlationId={adoptedLoad.id}
          retryHref={`/org/${orgToken}/checkins`}
        />
        <BackLink orgToken={orgToken} />
      </div>
    );
  }
  const petIds = adoptedLoad.value.map((r) => r.petId);

  // If nothing has been adopted out yet, there's nothing to dashboard. The
  // page still renders so the user has a stable entry point — the empty
  // state communicates "you'll see things here once you finalize adoptions".
  if (petIds.length === 0) {
    return (
      <div className="max-w-3xl space-y-8">
        <PageHeader orgName={organization.displayName} />
        <p className="text-md text-ln-op-mute">
          Todavía no hay adopciones registradas por esta organización. Cuando finalices una, los
          check-ins post-adopción del adoptante aparecerán acá.
        </p>
        <BackLink orgToken={orgToken} />
      </div>
    );
  }

  // Recent check-ins received from adopters. Joined to pets for the name +
  // public token (CTA target) and to profiles via recordedByUserId for the
  // adopter display name.
  // BOUNDED, and PARALLEL. These two lists share only `petIds`, which is
  // already resolved — running them one after the other only added latency,
  // and on a degraded DB it added it twice.
  const listsLoad = await loadWithTimeout(
    Promise.all([
      db
        .select({
          eventId: petEvents.id,
          petId: petEvents.petId,
          petName: pets.name,
          publicToken: pets.publicToken,
          occurredAt: petEvents.occurredAt,
          notes: sql<string | null>`${petEvents.payload}->>'notes'`,
          adopterName: profiles.displayName,
        })
        .from(petEvents)
        .innerJoin(pets, eq(pets.id, petEvents.petId))
        .leftJoin(profiles, eq(profiles.id, petEvents.recordedByUserId))
        .where(
          and(eq(petEvents.eventType, "post_adoption_checkin"), inArray(petEvents.petId, petIds)),
        )
        .orderBy(desc(petEvents.occurredAt))
        .limit(CHECKIN_CAP + 1),
      // Open reminders. Reminder.userId is the adopter; join to profiles gives
      // the display name. Split into overdue vs upcoming at render time.
      db
        .select({
          reminderId: reminders.id,
          petId: reminders.petId,
          petName: pets.name,
          publicToken: pets.publicToken,
          dueAt: reminders.dueAt,
          title: reminders.title,
          adopterName: profiles.displayName,
        })
        .from(reminders)
        .innerJoin(pets, eq(pets.id, reminders.petId))
        .leftJoin(profiles, eq(profiles.id, reminders.userId))
        .where(
          and(
            eq(reminders.reminderType, "post_adoption_checkin"),
            inArray(reminders.petId, petIds),
            isNull(reminders.completedAt),
          ),
        )
        .orderBy(asc(reminders.dueAt))
        .limit(CHECKIN_CAP + 1),
    ]),
  );
  if (!listsLoad.ok) {
    return (
      <div className="max-w-3xl space-y-8">
        <PageHeader orgName={organization.displayName} />
        <AnalyticsLoadFallback
          reason={listsLoad.reason}
          correlationId={listsLoad.id}
          retryHref={`/org/${orgToken}/checkins`}
        />
        <BackLink orgToken={orgToken} />
      </div>
    );
  }
  const [recentCheckins, openReminders] = listsLoad.value;

  const checkinsTruncated = recentCheckins.length > CHECKIN_CAP;
  const displayCheckins = checkinsTruncated ? recentCheckins.slice(0, CHECKIN_CAP) : recentCheckins;

  const remindersTruncated = openReminders.length > CHECKIN_CAP;
  const displayReminders = remindersTruncated ? openReminders.slice(0, CHECKIN_CAP) : openReminders;

  const now = new Date();
  const overdue = displayReminders.filter((r) => new Date(r.dueAt).getTime() < now.getTime());
  const upcoming = displayReminders.filter((r) => new Date(r.dueAt).getTime() >= now.getTime());

  return (
    <div className="max-w-3xl space-y-8">
      <PageHeader orgName={organization.displayName} />

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-ln-op-ink">
          Vencidos <span className="text-md font-normal text-ln-op-mute">({overdue.length})</span>
        </h2>
        {/* The 30-row cap is applied to the combined reminder set BEFORE the
            overdue/upcoming split, so a large overdue backlog can be truncated
            too — disclose it here, not only under "Próximos", or "Vencidos (N)"
            silently undercounts. */}
        {remindersTruncated && (
          <p className="text-sm text-ln-op-mute">
            Mostrando los primeros {CHECKIN_CAP} recordatorios por vencimiento; puede haber más
            vencidos sin listar.
          </p>
        )}
        {overdue.length === 0 ? (
          <p className="text-md text-ln-op-mute">
            Ningún check-in vencido. Si el adoptante se atrasa, va a aparecer acá.
          </p>
        ) : (
          <OpCard accent="danger">
            <OpCardBody className="p-0">
              <ul className="divide-y divide-ln-op-line">
                {overdue.map((row) => {
                  const days = -daysFromNow(row.dueAt, now);
                  return (
                    <li
                      key={row.reminderId}
                      className="px-4 py-3 flex items-start justify-between gap-3"
                    >
                      <div className="flex-1 min-w-0 space-y-1">
                        <p className="text-md font-medium text-ln-op-ink">
                          <Link
                            href={`/mis-mascotas/${row.publicToken}`}
                            className="text-ln-op-azul hover:underline no-underline"
                          >
                            {row.petName}
                          </Link>{" "}
                          — {row.title}
                        </p>
                        <p className="text-sm text-ln-op-mute">
                          Adoptante: {row.adopterName ?? "—"} · vencido hace {days}{" "}
                          {days === 1 ? "día" : "días"}
                        </p>
                      </div>
                      <span className="text-sm text-ln-op-danger shrink-0">Vencido</span>
                    </li>
                  );
                })}
              </ul>
            </OpCardBody>
          </OpCard>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-ln-op-ink">
          Próximos <span className="text-md font-normal text-ln-op-mute">({upcoming.length})</span>
        </h2>
        {remindersTruncated && (
          <p className="text-sm text-ln-op-mute">
            Mostrando los primeros {CHECKIN_CAP} recordatorios por vencimiento; puede haber más.
          </p>
        )}
        {upcoming.length === 0 ? (
          <p className="text-md text-ln-op-mute">No hay próximos check-ins en agenda.</p>
        ) : (
          <OpCard>
            <OpCardBody className="p-0">
              <ul className="divide-y divide-ln-op-line">
                {upcoming.map((row) => {
                  const days = daysFromNow(row.dueAt, now);
                  return (
                    <li
                      key={row.reminderId}
                      className="px-4 py-3 flex items-start justify-between gap-3"
                    >
                      <div className="flex-1 min-w-0 space-y-1">
                        <p className="text-md font-medium text-ln-op-ink">
                          <Link
                            href={`/mis-mascotas/${row.publicToken}`}
                            className="text-ln-op-azul hover:underline no-underline"
                          >
                            {row.petName}
                          </Link>{" "}
                          — {row.title}
                        </p>
                        <p className="text-sm text-ln-op-mute">
                          Adoptante: {row.adopterName ?? "—"} · en {days}{" "}
                          {days === 1 ? "día" : "días"} ({formatDate(row.dueAt)})
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </OpCardBody>
          </OpCard>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-ln-op-ink">
          Check-ins recibidos{" "}
          <span className="text-md font-normal text-ln-op-mute">
            ({checkinsTruncated ? `${CHECKIN_CAP}+` : displayCheckins.length})
          </span>
        </h2>
        {checkinsTruncated && (
          <p className="text-sm text-ln-op-mute">Mostrando los {CHECKIN_CAP} más recientes.</p>
        )}
        {displayCheckins.length === 0 ? (
          <p className="text-md text-ln-op-mute">Ningún check-in registrado todavía.</p>
        ) : (
          <OpCard>
            <OpCardBody className="p-0">
              <ul className="divide-y divide-ln-op-line">
                {displayCheckins.map((row) => (
                  <li key={row.eventId} className="px-4 py-3 space-y-1">
                    <p className="text-md font-medium text-ln-op-ink">
                      <Link
                        href={`/mis-mascotas/${row.publicToken}`}
                        className="text-ln-op-azul hover:underline no-underline"
                      >
                        {row.petName}
                      </Link>
                    </p>
                    <p className="text-sm text-ln-op-mute">
                      {row.adopterName ?? "Adoptante"} · {formatDate(row.occurredAt)}
                    </p>
                    {row.notes && (
                      <p className="text-sm italic text-ln-op-ink-2 pt-1">"{row.notes}"</p>
                    )}
                  </li>
                ))}
              </ul>
            </OpCardBody>
          </OpCard>
        )}
      </section>

      <BackLink orgToken={orgToken} />
    </div>
  );
}

function PageHeader({ orgName }: { orgName: string }) {
  return (
    <header className="space-y-2">
      <p className="text-sm uppercase tracking-wider text-ln-op-mute">Seguimiento · {orgName}</p>
      <h1 className="text-title font-semibold text-ln-op-ink">Check-ins post-adopción</h1>
      <p className="text-md text-ln-op-mute">
        Los adoptantes se autoreportan en las ventanas pactadas. Acá ves lo que llegó, lo que está
        por venir y lo que no llegó a tiempo.
      </p>
    </header>
  );
}

function BackLink({ orgToken }: { orgToken: string }) {
  return (
    <footer className="pt-4 border-t border-ln-op-line">
      <Link
        href={`/org/${orgToken}`}
        className="text-md text-ln-op-azul hover:underline no-underline"
      >
        ← Volver al panel
      </Link>
    </footer>
  );
}
