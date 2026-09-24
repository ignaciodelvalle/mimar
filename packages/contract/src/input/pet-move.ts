// Client-input contract for MUDANZA —
// `POST /api/v1/pets/{publicToken}/move`.
//
// ONE COMMAND, AND THE UNION IS NOT DECORATION
// ---------------------------------------------------------------------------
// `recordMovementWriter` (src/modules/pets/application/movement/record-movement.ts)
// takes THREE `sub_kind`s — `jurisdiction_changed`, `transport_recorded` and
// `cvi_issued` — and this door exposes exactly ONE of them. The other two are
// the web's `/mis-mascotas/{token}/viaje` screen, which is a different act with
// a different form (an international trip and its veterinary certificate), and
// nothing native was built for it.
//
// So the input is a one-member discriminated union, the shape `subject-rights.ts`
// uses for the same reason: the second member is a WIDENING and not a migration,
// and `__tests__` says the union has one member today so that adding the travel
// command is a deliberate edit rather than a discovery.
//
// WHY IT IS NOT ON `pets/{publicToken}/profile`
// ---------------------------------------------------------------------------
// Because the profile door refuses it, in writing. `@dim/contract/api`'s
// `pet-profile-edit.ts` lists jurisdiction under "WHAT IS NOT HERE, AND WHY EACH
// ONE IS ABSENT RATHER THAN FORGOTTEN": it is FULL-LOCK (PO decision #40),
// `PetsRepository.updatePetProfile` omits the three columns from its `SET`, and
// each locked column "has its own event-governed correction path
// (`correctPetSpeciesAction`, `recordMoveAction`). An 'editar' endpoint that
// accepted them would be a second, ungoverned door onto legally load-bearing
// state." This is that correction path, on the bearer surface.
//
// WHAT IS LOAD-BEARING ABOUT IT, said once so a client author knows what they
// are posting: `pets.jurisdiction_country/province/locality` is what every
// `resolveBusinessRule` call site keys off (locality → province → country
// fallback), so a move re-decides the animal's domestic compliance cards, the
// PPP gate, and which authority answers for it. That is why the destination is
// canonicalized against the INDEC catalog in STRICT mode at the edge and again,
// defensively, inside the writer.
//
// WHAT THE SERVER STILL DECIDES AFTER THIS SCHEMA PASSES
// ---------------------------------------------------------------------------
//   · WHETHER THE PAIR EXISTS. `normalizeLocationForWrite(…, { locality:
//     "strict" })` resolves (province, locality) against the catalog and REFUSES
//     an off-catalog pair. A client picks from `GET /api/v1/localities` to avoid
//     the round trip; it does not decide.
//   · THE CANONICAL SPELLING. What comes back in the ack is what was stored, and
//     it may differ from what was posted — see `PetMoveRecordedV1`.
//   · WHETHER IT IS A MOVE AT ALL. A destination equal to the animal's current
//     locality is refused by the event schema as a no-op, and this contract does
//     NOT try to pre-empt that: the client would have to hold the pet's current
//     jurisdiction and compare it the same way, which is a second copy of a rule
//     that already exists on the server.
//   · THE COUNTRY. There is no field for it. `recordMoveAction` hardcodes
//     `to_country: "AR"` and so does this door — a move OUT of Argentina is an
//     emigration, not a change of the animal's Argentine jurisdiction, and the
//     web has no field for it either.

import { z } from "zod";

/**
 * The longest a free-text reason may be.
 *
 * INVENTED HERE, and that is a narrowing this contract is allowed to make where
 * `pet-profile-edit.ts` was not: `movement_recorded`'s `reason` is a NEW field
 * on every request — no animal is carrying a stored value that a cap could lock
 * an owner out of correcting. Two hundred is a sentence about why somebody
 * moved, not a document.
 */
export const MOVE_REASON_MAX = 200;

/**
 * The vocabulary a client shows a field message from.
 *
 * `DESTINATION_REQUIRED` covers BOTH halves of the destination on purpose. The
 * two arrive together from one control — `LocalityPicker` writes `provinceCode`
 * and `localityName` in the same `onSelect` and clears both in the same tap — so
 * a message naming one of them would point at a field the person cannot see.
 */
export const PET_MOVE_COMMAND_INPUT_CODES = [
  "COMMAND_REQUIRED",
  "DESTINATION_REQUIRED",
  "REASON_TOO_LONG",
] as const;
export type PetMoveCommandInputCode = (typeof PET_MOVE_COMMAND_INPUT_CODES)[number];

/** A trimmed optional string; absent, blank and `null` all mean "not stated". */
const optionalReason = z
  .string()
  .trim()
  .max(MOVE_REASON_MAX, { error: "REASON_TOO_LONG" })
  .nullish()
  .transform((v) => (v ? v : null));

/**
 * Register a change of the animal's Argentine jurisdiction.
 *
 * `provinceCode` AND `localityName` ARE BOTH REQUIRED AND NEITHER MAY BE BLANK.
 * The web's action refuses a blank locality with "Seleccioná la localidad de
 * destino." before it reaches the normalizer, and a blank PROVINCE would reach
 * `canonicalProvinceNameForStorage("")` — which returns null, which makes the
 * strict branch fall through WITHOUT canonicalizing at all. That fall-through is
 * the one shape this schema exists to make unreachable: an uncanonicalized pair
 * written into the columns every jurisdiction-keyed read consults.
 *
 * `reason` is a REQUIRED KEY with a nullable value, not an optional key — the
 * rule `createLibretaShare` states for `expiresInDays` and `edit_identity` for
 * `breed`: an absent field would have to mean either "no reason" or "keep the
 * previous one", the two are different acts, and there is no previous one to
 * keep here anyway. Posting `null` is "no dijo por qué".
 */
const recordMove = z.object({
  command: z.literal("record_move"),
  provinceCode: z
    .string({ error: "DESTINATION_REQUIRED" })
    .trim()
    .min(1, { error: "DESTINATION_REQUIRED" }),
  localityName: z
    .string({ error: "DESTINATION_REQUIRED" })
    .trim()
    .min(1, { error: "DESTINATION_REQUIRED" }),
  /**
   * INDEC's own id for the destination row the person TAPPED
   * (`LocalityV1.indecId`). Optional; the server prefers it and falls back to
   * the (province, name) pair.
   *
   * SAME DEFECT AS ALTA'S, ONE ACT LATER (A2-alta-asentar-03, merged with
   * A4-custodia-05), and the defect is WITHIN one province — the first version
   * of this note described a cross-province mix-up that cannot happen, since the
   * server resolves the province first and the locality lookup is scoped to it
   * (corrected by L2-5). What the name-only lookup really does is settle a
   * homonym with `.orderBy(departmentName).limit(1)`, and the catalogue carries
   * 68 (province, name) collisions — four "San Pedro"s in Santiago del Estero
   * alone. Tap the second San Pedro of the list and the animal is filed under
   * the first: a different department, a different responding authority, and a
   * correcting move that USED to come back `move_same_locality` because the two
   * rows compared equal on their names. Sending the id is what makes both the
   * filing and the correction land on the row the person chose.
   */
  localityIndecId: z
    .string()
    .trim()
    .nullish()
    .transform((v) => (v ? v : null)),
  reason: optionalReason,
});

export const petMoveCommandInputSchema = z.discriminatedUnion("command", [recordMove]);

export type PetMoveCommandInput = z.infer<typeof petMoveCommandInputSchema>;
export type PetMoveCommand = PetMoveCommandInput["command"];

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Mirrors `firstPetProfileCommandInputCode` — same shape, same reason.
 */
export function firstPetMoveCommandInputCode(
  error: z.ZodError<unknown>,
): PetMoveCommandInputCode | null {
  for (const issue of error.issues) {
    const code = issue.message;
    if ((PET_MOVE_COMMAND_INPUT_CODES as readonly string[]).includes(code)) {
      return code as PetMoveCommandInputCode;
    }
  }
  for (const issue of error.issues) {
    if (issue.code === "invalid_union" || issue.path.length === 0 || issue.path[0] === "command") {
      return "COMMAND_REQUIRED";
    }
  }
  return null;
}
