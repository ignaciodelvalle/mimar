// What `POST /api/v1/pets/{publicToken}/reminders` answers.
//
// A BARE ACK, no envelope — the same split every command surface on `/api/v1`
// makes (see `PetMoveRecordedV1`, `ShareCommandAckV1`): a `payloadVersion` and
// a staleness window describe a READ a device may present as current, and an
// acknowledgement of something that just happened has neither.
//
// THERE IS NO `GET` HERE, and that is a decision rather than a gap, the same
// one `pet-move.ts` records for its own door: the list already exists, on
// `GET /api/v1/pets/{publicToken}` — `OwnerPetRemindersSection` — so a second
// read would be a route, a per-IP bucket and a payload version bought to
// re-send a list the client is already holding.

/**
 * `changed` ONLY APPEARS ON THE CANCEL HALF, and its absence on create is
 * deliberate rather than an oversight. `createVaccineReminder`'s own
 * idempotency guard (a double-submit of the identical vaccine + due date is a
 * no-op) means a create ack always names a REAL reminder — the caller's own,
 * whether freshly inserted or recognised as the existing one — so there is no
 * "nothing happened" case to report. Cancelling a reminder that is already
 * gone (a replay, or a second tap) is exactly that case, and the flag is what
 * lets a client distinguish "I closed it" from "it was already closed" without
 * either one reading as a failure.
 */
export type VaccineReminderCommandAckV1 =
  | {
      command: "create_vaccine_reminder";
      /** The reminder's row id — the caller's own, whether new or recognised. */
      reminderId: string;
    }
  | {
      command: "cancel_vaccine_reminder";
      reminderId: string;
      /** `false` when no row matched: a replay, or an id already cancelled. */
      changed: boolean;
    };
