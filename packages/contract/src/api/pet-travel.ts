// What `POST /api/v1/pets/{publicToken}/travel` answers (viajes-fase-2, D4/D5).
//
// A BARE ACK, no envelope — the split every command surface on `/api/v1`
// makes (see `PetMoveRecordedV1`, `VaccineReminderCommandAckV1`): a
// `payloadVersion` and a staleness window describe a READ, and an
// acknowledgement of something that just happened has neither. The READ of the
// trips and the semáforo is `GET` on the same URL, added with the /viaje page.

/**
 * `replayed` is true when the `Idempotency-Key` resolved to a write that
 * already happened: nothing was appended, and `eventId` is the first write's.
 * A client that retried after a timeout reads it to know its first attempt
 * landed. `changed` on the cancel half says the same thing about STATE: a trip
 * already cancelled answers `changed: false`, never a refusal.
 */
export type PetTravelCommandAckV1 =
  | { command: "record_trip"; eventId: string; replayed: boolean }
  | { command: "record_cvi"; eventId: string; replayed: boolean }
  | { command: "cancel_trip"; tripEventId: string; changed: boolean };
