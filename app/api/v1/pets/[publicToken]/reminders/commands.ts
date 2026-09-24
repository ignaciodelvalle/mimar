// The two vaccine-reminder commands, behind
// `POST /api/v1/pets/{publicToken}/reminders`.
//
// CLOSES TWO ENTRIES IN `DECLARED_DIVERGENCES`
// (`scripts/check-owner-surface-parity.ts`): `write:createVaccineReminderAction
// →createVaccineReminder` and `write:deleteVaccineReminderAction→
// deleteVaccineReminder`. The app could already READ a pet's vaccine
// reminders (`OwnerPetRemindersSection`); it could neither schedule nor cancel
// one. This reaches the IDENTICAL use-cases the web's two actions reach —
// `createVaccineReminder` and `deleteVaccineReminder` under
// `src/modules/pets/application/reminders/` — which is what the parity fence
// joins on: a parallel implementation would not close either entry even if it
// worked.
//
// WHO MAY RUN EITHER COMMAND is the web's own door, read verbatim rather than
// narrowed. `createVaccineReminderAction` and `deleteVaccineReminderAction`
// (app/actions/reminders.ts) both guard with `requireOwnedPetByToken`, which
// resolves to `requirePetAccess` — EVERY current holder (owner, co-owner,
// foster or caretaker on the person path; any org member on the org path),
// with no capability probe and no alive-only gate. `resolvePetHolderAccess`
// IS that resolution on the bearer surface, so `access.kind !== "none"` is the
// whole guard: there is no narrower rule to restate.
//
// THE WRITE FOR `create_vaccine_reminder` GOES THROUGH FORMDATA ON PURPOSE.
// `createVaccineReminder` reads its fields out of a `FormData` because it was
// written for a `<form>`. Handing it one built from the JSON body is not a
// workaround — it is the same pattern `/shares`' `enableTier2` command already
// uses for the same reason: the SAME door both callers pass through is what
// keeps a phone and a browser scheduling the same vaccine from drifting into
// two notions of what counts as a duplicate.
//
// CANCEL IS IDEMPOTENT ON THE STATE, NOT ON AN `Idempotency-Key`. Deleting a
// reminder that is already gone — a replay, or a second tap — matches zero
// rows and answers 200 with `changed: false`, never a refusal. See
// `deleteVaccineReminder`'s own header: "a replayed cancel must answer the
// same way as the first."

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type PetHolderAccess, resolvePetHolderAccess } from "@/lib/infra/pet-access";
import { reportError } from "@/lib/infra/report-error";
import { createVaccineReminder } from "@/src/modules/pets/application/reminders/create-vaccine-reminder";
import { deleteVaccineReminder } from "@/src/modules/pets/application/reminders/delete-vaccine-reminder";
import type { VaccineReminderCommandAckV1 } from "@dim/contract/api";
import type { VaccineReminderCommandInput } from "@dim/contract/input";

/**
 * The pre-write read: the access query only.
 *
 * THE WRITES ARE DELIBERATELY OUTSIDE ANY BUDGET, for the reason every write
 * on this surface records: `withDbBudgetOrThrow` races a promise against a
 * timer and rejects, which does not abort a Postgres transaction. Wrapping a
 * write would produce a 503 for a mutation that then COMMITS.
 */
const RESOLVE_BUDGET_MS = 8_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** The 503 this endpoint answers for every degraded pre-write read. */
export function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

export type ReminderCommandContext = {
  publicToken: string;
  userId: string;
  input: VaccineReminderCommandInput;
};

/** Everything from the access guard to the command. */
export async function runVaccineReminderCommand(ctx: ReminderCommandContext) {
  let access: PetHolderAccess;
  try {
    access = await withDbBudgetOrThrow(
      resolvePetHolderAccess(ctx.publicToken, ctx.userId),
      RESOLVE_BUDGET_MS,
      "api-v1-reminders-access",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  // A pet this caller may not touch and a pet that does not exist answer
  // IDENTICALLY, as every other endpoint on this surface does. There is no
  // further guard: `requirePetAccess` (the web's own door) IS this resolution.
  if (access.kind === "none") return apiV1Error("not_found", 404);

  try {
    return ctx.input.command === "create_vaccine_reminder"
      ? await createReminder(ctx, ctx.input, access.pet.id)
      : await cancelReminder(ctx.input, access.pet.id);
  } catch (err) {
    reportError("api-v1-reminders", err, { userId: ctx.userId });
    return apiV1Error("reminder_failed", 500);
  }
}

async function createReminder(
  ctx: ReminderCommandContext,
  input: Extract<VaccineReminderCommandInput, { command: "create_vaccine_reminder" }>,
  petId: string,
) {
  const form = new FormData();
  form.set("vaccineName", input.vaccineName);
  form.set("dueAt", input.dueAt);
  if (input.description !== null) form.set("description", input.description);

  const result = await createVaccineReminder(
    ctx.userId,
    petId,
    ctx.publicToken,
    { error: null },
    form,
  );

  if (result.error !== null || result.reminderId === undefined) {
    // The use-case's message is its own prose, written for a web form. NOT
    // echoed — this surface answers with a code and nothing else, the same
    // rule `move`'s `write_failed` mapping applies.
    reportError("api-v1-reminders", new Error(result.error ?? "reminderId missing"), {
      userId: ctx.userId,
    });
    return apiV1Error("reminder_failed", 500);
  }

  const body: VaccineReminderCommandAckV1 = {
    command: "create_vaccine_reminder",
    reminderId: result.reminderId,
  };
  return apiV1Json(body, { status: 200 });
}

async function cancelReminder(
  input: Extract<VaccineReminderCommandInput, { command: "cancel_vaccine_reminder" }>,
  petId: string,
) {
  const result = await deleteVaccineReminder(petId, input.reminderId);

  const body: VaccineReminderCommandAckV1 = {
    command: "cancel_vaccine_reminder",
    reminderId: input.reminderId,
    changed: result.changed,
  };
  return apiV1Json(body, { status: 200 });
}
