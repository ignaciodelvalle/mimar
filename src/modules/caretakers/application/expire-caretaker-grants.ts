// The daily caretaker sweep. Three passes, in an order that is a requirement.
//
// Auth: none. System-initiated; the route gates on CRON_SECRET.
//
// PASS ORDER
//   1. `pending` invitations older than the 7-day window → `expired`.
//      NO SPINE EVENT. An unanswered invitation never became an arrangement,
//      and writing `caretaker_ended{outcome:'expired'}` for it would put an
//      arrangement that never happened into an append-only log.
//   2. `accepted` grants past `ends_at` → `ended` + `caretaker_ended` + close
//      the ownership row, ONE TRANSACTION PER GRANT.
//   3. T-3 reminders, idempotent through the stored `reminder_sent_at` witness.
//
// WHY 2 BEFORE 3, since this is the thing most likely to be "tidied" later: a
// grant whose `ends_at` falls TODAY is inside both scans. If the reminder ran
// first, the caretaker would be asked to renew a window that pass 2 closes
// seconds afterwards. The `endedThisRun` set below is the belt to the ordering's
// braces — it makes the guarantee hold even against a repository whose reminder
// scan is sloppy about the boundary.
//
// PER-ROW, NOT PER-BATCH. A batch-wide transaction lets one bad grant roll back
// every good one and holds `ownerships` locks for the length of the sweep.
// Failures are counted and the loop continues, the expirePetTransfers shape.

import { GRANT_INVITATION_EXPIRY_DAYS, GRANT_REMINDER_LEAD_DAYS } from "../domain/types";
import type { CaretakersRepositoryPort, GrantRow } from "./ports";
import type { NewNotification, UseCaseResult } from "./types";

type Deps = {
  repo: CaretakersRepositoryPort;
  /** Injected. NEVER `new Date()` in here — the T-3 boundary is a test subject. */
  now: () => Date;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type ExpireCaretakerGrantsStats = {
  invitationsExpired: number;
  grantsEnded: number;
  remindersSent: number;
  errors: number;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function expireCaretakerGrants(
  deps: Deps,
  opts?: { limit?: number },
): Promise<UseCaseResult<ExpireCaretakerGrantsStats>> {
  const { repo, transaction } = deps;
  const now = deps.now();
  const limit = opts?.limit;

  const notifications: NewNotification[] = [];
  const stats: ExpireCaretakerGrantsStats = {
    invitationsExpired: 0,
    grantsEnded: 0,
    remindersSent: 0,
    errors: 0,
  };

  // A pet summary is needed for copy in two passes; cache per run so a sweep of
  // 500 grants on 500 pets does not re-read the same rows.
  const petCache = new Map<string, { name: string; publicToken: string } | null>();
  async function petFor(petId: string) {
    if (!petCache.has(petId)) petCache.set(petId, await repo.findPetSummaryById(petId));
    return petCache.get(petId) ?? null;
  }

  const ctx: PassContext = { repo, transaction, now, limit, stats, notifications, petFor };

  // THE ORDER. Three awaited calls, deliberately not a loop over an array of
  // passes: a reader must be able to see, in one glance, that 2 comes before 3.
  await expireStaleInvitations(ctx);
  const endedThisRun = await endExpiredGrants(ctx);
  await sendEndingSoonReminders(ctx, endedThisRun);

  return { ok: true, value: stats, notifications };
}

type PassContext = {
  repo: CaretakersRepositoryPort;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
  now: Date;
  limit: number | undefined;
  stats: ExpireCaretakerGrantsStats;
  notifications: NewNotification[];
  petFor: (petId: string) => Promise<{ name: string; publicToken: string } | null>;
};

/** Pass 1 — unanswered invitations. NO spine event. */
async function expireStaleInvitations(ctx: PassContext): Promise<void> {
  const { repo, now, stats, notifications, petFor } = ctx;
  const cutoff = new Date(now.getTime() - GRANT_INVITATION_EXPIRY_DAYS * MS_PER_DAY);

  for (const grant of await repo.findExpirableInvitations(cutoff, ctx.limit)) {
    try {
      const updated = await repo.updateGrantStatus({
        grantId: grant.id,
        status: "expired",
        expectedStatus: "pending",
        respondedAt: now,
        now,
      });
      // Zero rows means an accept, a reject or a cancel landed between the scan
      // and this UPDATE. Skip silently: no notification, no count.
      if (updated === 0) continue;

      stats.invitationsExpired += 1;

      const pet = await petFor(grant.petId);
      notifications.push({
        userId: grant.grantedByUserId,
        notificationType: "caretaker_invitation_expired",
        // NO RUN DATE IN THE KEY. An invitation expires once, and the sweep
        // runs daily: a date bucket would let a re-scan of the same row emit a
        // second "nadie respondió" tomorrow. Stable across: every pass of this
        // cron over this grant. Distinct across: other grants — a later
        // invitation that also goes unanswered is a new grant id.
        dedupeKey: `caretaker:invitation_expired:${grant.id}:${grant.grantedByUserId}`,
        severity: "info",
        title: `Nadie respondió la invitación para cuidar a ${pet?.name ?? "tu mascota"}`,
        body: "La invitación venció sin respuesta. Podés invitar de nuevo cuando quieras.",
        ctaLabel: "Ver mascota",
        ctaUrl: pet ? `/mis-mascotas/${pet.publicToken}` : "/mis-mascotas",
        relatedPetId: grant.petId,
        category: "custody",
      });
    } catch (err) {
      stats.errors += 1;
      console.error("[caretakers/expire] pass 1 row failed", grant.id, err);
    }
  }
}

/**
 * Pass 2 — arrangements past `ends_at`. BEFORE pass 3. See the file header.
 *
 * Returns the ids it closed, so pass 3 can refuse to nudge them.
 */
async function endExpiredGrants(ctx: PassContext): Promise<Set<string>> {
  const { repo, transaction, now, stats, notifications, petFor } = ctx;
  const endedThisRun = new Set<string>();

  for (const grant of await repo.findExpirableGrants(now, ctx.limit)) {
    try {
      await transaction(async (tx) => {
        const locked = await repo.findGrantByIdForUpdate(grant.id, tx);
        if (!locked || locked.status !== "accepted") {
          throw new SkipRow(grant.id);
        }
        await repo.insertEndGrant(
          {
            grantId: grant.id,
            petId: grant.petId,
            ownershipId: grant.ownershipId,
            outcome: "expired",
            endsAt: grant.endsAt,
            // No human ended this one. Recording an actor would attribute a
            // clock to a person.
            actorUserId: null,
            now,
          },
          tx,
        );
      });

      endedThisRun.add(grant.id);
      stats.grantsEnded += 1;
      notifications.push(...endNotifications(grant, await petFor(grant.petId)));
    } catch (err) {
      if (err instanceof SkipRow) continue;
      stats.errors += 1;
      console.error("[caretakers/expire] pass 2 row failed", grant.id, err);
    }
  }

  return endedThisRun;
}

/** Pass 3 — the T-3 nudge. Idempotent through the stored witness. */
async function sendEndingSoonReminders(ctx: PassContext, endedThisRun: Set<string>): Promise<void> {
  const { repo, now, stats, notifications, petFor } = ctx;
  const windowEnd = new Date(now.getTime() + GRANT_REMINDER_LEAD_DAYS * MS_PER_DAY);

  for (const grant of await repo.findGrantsNeedingReminder(now, windowEnd, ctx.limit)) {
    // Belt to the ordering's braces: never nudge a grant this very run closed.
    if (endedThisRun.has(grant.id)) continue;
    try {
      // The witness IS the idempotency. A zero-row result means a concurrent
      // (or re-run) sweep already stamped it, so nothing is sent.
      const stamped = await repo.markReminderSent(grant.id, now);
      if (stamped === 0) continue;

      stats.remindersSent += 1;
      notifications.push(...reminderNotifications(grant, await petFor(grant.petId)));
    } catch (err) {
      stats.errors += 1;
      console.error("[caretakers/expire] pass 3 row failed", grant.id, err);
    }
  }
}

function reminderNotifications(
  grant: GrantRow,
  pet: { name: string; publicToken: string } | null,
): NewNotification[] {
  const petName = pet?.name ?? "tu mascota";
  const body = `Renová o dejá que termine el ${formatArDate(grant.endsAt)}.`;
  const title = `¿Seguís cuidando a ${petName}?`;

  const out: NewNotification[] = [
    {
      userId: grant.grantedByUserId,
      notificationType: "caretaker_grant_ending_soon",
      // NO RUN DATE IN THE KEY, on purpose. The T-3 nudge fires once per grant
      // and is already gated by the stored `reminder_sent_at` witness; a date
      // bucket would defeat that witness the moment a grant sat in the window
      // across two sweeps. Stable across: every sweep, for the life of this
      // grant. Distinct across: grants, and the two recipients below — the
      // titular and the caretaker each need their own nudge.
      dedupeKey: `caretaker:grant_ending_soon:${grant.id}:${grant.grantedByUserId}`,
      severity: "info",
      title,
      body,
      ctaLabel: "Ver mascota",
      ctaUrl: pet ? `/mis-mascotas/${pet.publicToken}` : "/mis-mascotas",
      relatedPetId: grant.petId,
      category: "custody",
    },
  ];

  if (grant.caretakerUserId) {
    out.push({
      userId: grant.caretakerUserId,
      notificationType: "caretaker_grant_ending_soon",
      // The caretaker's copy. Same family, different recipient — that suffix is
      // the only thing stopping this insert from collapsing into the titular's.
      dedupeKey: `caretaker:grant_ending_soon:${grant.id}:${grant.caretakerUserId}`,
      severity: "info",
      title,
      body,
      ctaLabel: "Ver mis mascotas",
      ctaUrl: "/mis-mascotas",
      relatedPetId: grant.petId,
      category: "custody",
    });
  }

  return out;
}

/** Internal signal: the row moved under us. Not an error, not a count. */
class SkipRow extends Error {
  constructor(grantId: string) {
    super(`caretaker grant ${grantId} was resolved by another writer`);
    this.name = "SkipRow";
  }
}

/**
 * The auto-end copy, for both parties.
 *
 * "expired" MUST NOT read as "the animal came back". The arrangement ended; who
 * physically has the animal is an open question the titular has to act on, and
 * a notification that closes it for them is the system asserting a fact nobody
 * recorded.
 */
function endNotifications(
  grant: GrantRow,
  pet: { name: string; publicToken: string } | null,
): NewNotification[] {
  const petName = pet?.name ?? "tu mascota";
  const endsAtLabel = formatArDate(grant.endsAt);

  const out: NewNotification[] = [
    {
      userId: grant.grantedByUserId,
      notificationType: "caretaker_grant_ended",
      // DELIBERATELY THE SAME KEY end-caretaker-grant.ts emits for the manual
      // path. A grant ends exactly once — both writers gate on `accepted` under
      // a row lock, so whichever loses emits nothing — and if a manual revoke
      // and this sweep ever both got as far as a payload, the titular should
      // read "el cuidado terminó" ONCE, not twice in two wordings. No run date:
      // the sweep re-scanning tomorrow must not re-announce it.
      dedupeKey: `caretaker:grant_ended:${grant.id}:${grant.grantedByUserId}`,
      severity: "warning",
      title: `El cuidado temporal de ${petName} terminó`,
      body: `El período terminó el ${endsAtLabel}. Si ${petName} sigue con esa persona, coordiná la devolución o iniciá un reclamo.`,
      ctaLabel: "Ver mascota",
      ctaUrl: pet ? `/mis-mascotas/${pet.publicToken}` : "/mis-mascotas",
      relatedPetId: grant.petId,
      category: "custody",
    },
  ];

  if (grant.caretakerUserId) {
    out.push({
      userId: grant.caretakerUserId,
      notificationType: "caretaker_grant_ended",
      // The caretaker's copy — recipient suffix keeps it distinct from the
      // titular's, and matches the manual path's key for the same person.
      dedupeKey: `caretaker:grant_ended:${grant.id}:${grant.caretakerUserId}`,
      severity: "info",
      title: `Tu período de cuidado de ${petName} terminó`,
      body: `Terminó el ${endsAtLabel}. Ya no tenés acceso para cargar eventos. Si ${petName} sigue con vos, coordiná la devolución con el titular.`,
      ctaLabel: "Ver mis mascotas",
      ctaUrl: "/mis-mascotas",
      relatedPetId: grant.petId,
      category: "custody",
    });
  }

  return out;
}

function formatArDate(date: Date): string {
  return date.toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Argentina/Buenos_Aires",
  });
}
