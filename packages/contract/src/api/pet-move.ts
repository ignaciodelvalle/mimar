// What `POST /api/v1/pets/{publicToken}/move` answers — MUDANZA.
//
// A BARE ACK, no envelope, the split every write on this surface makes: a
// `payloadVersion` and a staleness window describe a READ a device may present
// as current, and an acknowledgement of something that just happened has
// neither. There is no GET here at all, and that absence is a decision rather
// than a gap — see below.
//
// THERE IS NO `GET /pets/{token}/move`, AND NOTHING IS MISSING
// ---------------------------------------------------------------------------
// The form needs two things to draw itself: where the animal is now, and what
// destinations exist. It already has both. `GET /api/v1/pets/{publicToken}`
// carries the animal's current jurisdiction — it is on the credential face —
// and `GET /api/v1/localities` is the same public typeahead the alta form
// spends. A third read would be a route, a per-IP bucket and a payload version
// bought to re-send two fields the client is holding.
//
// It also has no CAPABILITIES block, and that IS the asymmetry worth naming.
// `pets/{token}/profile` carries two booleans so a client never draws a control
// the write would refuse; this door has one command with one guard, and the
// answer to "may I" is the same shape as the answer to "did it work" — a 403.
// What a client must NOT do is derive the answer instead: the guard is
// `requireTitularAccess`'s rule (every holder except a caretaker, org path
// included), and a screen that hid the button for a `foster` would be inventing
// a narrowing the web does not have.

/**
 * The animal's jurisdiction AS STORED, after canonicalization.
 *
 * IT IS NOT WHAT THE CLIENT POSTED AND A CLIENT MUST RENDER THIS ONE. The
 * destination is resolved against the INDEC catalog in `strict` mode before it
 * is written, so `provinceCode: "AR-B"` comes back as `province: "Buenos
 * Aires"` and a locality picked by name comes back in the catalog's spelling.
 * A screen that echoed the request would be telling somebody their animal is
 * registered somewhere it is not — the same class of lie as a form reporting a
 * save it did not make.
 *
 * Both fields are the values written to `pets.jurisdiction_province` and
 * `pets.jurisdiction_locality`, which is what every `resolveBusinessRule` call
 * site reads.
 */
export type PetMoveJurisdictionV1 = {
  province: string;
  locality: string;
};

/**
 * What the move door answers on success.
 *
 * `eventId` IS THE `movement_recorded` ROW and it is on the wire for one
 * reason: the move IS an entry in the animal's libreta, and a client that has
 * just recorded one should be able to open it (`GET /pets/{token}/events/
 * {eventId}`) rather than re-reading the whole ledger to find what it just
 * wrote. It is NOT a capability — the event detail door runs its own guard.
 *
 * THERE IS NO `changed` FLAG, unlike `PetProfileEditAckV1`, and the difference
 * is the writer's rather than this file's taste. An identity edit is a VALUE, so
 * saving the same name twice is a no-op the writer recognises and reports.
 * A move is an EVENT: the schema refuses a destination equal to the origin
 * outright (`move_same_locality`, 409) instead of absorbing it, so there is no
 * success case in which nothing changed. A `changed: true` that is always true
 * is a field that teaches a client to stop reading it.
 */
export type PetMoveRecordedV1 = {
  command: "record_move";
  eventId: string;
  jurisdiction: PetMoveJurisdictionV1;
};
