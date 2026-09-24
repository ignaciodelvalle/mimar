// Client-input contract for EDITAR —
// `POST /api/v1/pets/{publicToken}/profile`.
//
// THREE COMMANDS, ONE ENDPOINT, TWO DIFFERENT GUARDS. The read's contract
// (`@dim/contract/api`'s `pet-profile-edit.ts`) states the guards at length and
// this file does not restate them, because two copies of a rule is how the
// copies disagree. What matters here is that the split into COMMANDS is not
// cosmetic: one appends a bundled `pet_profile_updated` event to the spine, one
// moves four preference columns and appends nothing, and one — the species
// correction — appends its OWN `pet_profile_updated` on the FULL-LOCK path the
// identity edit refuses to touch. A single "save everything" command would have
// had to pick one guard and one event for all three.
//
// THE REFERENCE POINTS, named by SYMBOL and not by line: a line number in a
// comment is a fact about a file's length, and it rots on the next edit to
// anything above it. These names are greppable and do not.
//
//   editar identidad     `updatePetAction`                 src/modules/pets/actions.ts
//   contactos            `updateEmergencyContactsAction`   app/actions/profile.ts
//                        + `updateEmergencyContactsForPet` …/profile/update-emergency-contacts.ts
//   corregir especie     `correctPetSpeciesAction`         src/modules/pets/actions.ts
//                        + `correctPetSpecies`             …/profile/correct-species.ts
//
// WHAT THE SERVER STILL DECIDES AFTER THIS SCHEMA PASSES
// ---------------------------------------------------------------------------
//   · THE BREED. `resolveBreedForWrite` (lib/domain/breed-validation.ts) folds
//     and aliases the submitted label against the catalog for the PERSISTED
//     species and rejects anything that does not land in it — a dog may not be
//     saved as "Persa". A client picks from `breedsForSpecies` to avoid the
//     round trip; it does not decide.
//   · THE PPP FLAG. `potentially_dangerous_breed` is re-resolved against the
//     animal's jurisdiction on every write. It is legally load-bearing state and
//     no client input reaches it.
//   · WHETHER ANYTHING CHANGED. A no-op edit appends no event.
//
// WHY NO LENGTH CAP IN THIS SCHEMA REACHES `name`, `breed` OR `color`
// ---------------------------------------------------------------------------
// `pets.name` and `pets.color` are `text`, and `ln()` — the web's own form
// parser, the only writer either column has ever had — checks that the name is
// non-empty and nothing else. So values longer than any number this file could
// pick ALREADY EXIST in those columns, and a cap enforced by the schema would be
// applied to them on the way back OUT: `edit_identity` carries all three fields
// on every save, so an animal whose stored name runs to 120 characters could not
// have its COLOUR corrected either. The owner is locked out of their own record
// by a limit invented after their data — and locked out from the phone, where
// there is no second door.
//
// That failure has a name here already. QA A5 is the same shape one field over:
// `resolveBreedForWrite` accepts a submitted breed UNCHANGED when it equals the
// one stored on the animal, so a legacy off-catalog value survives an unrelated
// edit instead of being wiped by a picker that never offered it, and
// `breedChoicesFor` is that rule reaching the UI. `resolvePetIdentityLengths`
// below is the same rule again: the cap gates NEW values, and a value identical
// to the one already on the animal passes at any length.
//
// It therefore CANNOT live in `petProfileCommandInputSchema`. That schema is a
// function of the request alone and has never seen the row, so it cannot tell a
// 120-character name being carried over from a 120-character name being typed —
// which is the entire distinction. The gate is a separate function both sides
// call with the stored values: the server in `profile/commands.ts`, beside the
// breed gate it mirrors, and the client before the round trip.
//
// THE TWO CONTACT CAPS STAY IN THE SCHEMA, and the asymmetry is not an
// oversight. They are not narrowings this contract invented: they are the
// numbers `update-emergency-contacts.ts` already enforces (`nameField` ≤ 80,
// `phoneField` ≤ 40), so an over-long stored value cannot have come through the
// only writer those columns have, and if one somehow existed the WEB's sheet
// would refuse it identically. Mirroring a server cap is parity; inventing one
// over unbounded legacy data is the lockout above.

import { z } from "zod";

// From the leaf, NOT from `register-pet.ts`: that file imports this one's length
// caps, so importing it back from here closes a cycle — and both files build zod
// schemas at module-evaluation time, where a cycle turns the other side's
// constants into `undefined`. See `pet-species.ts`.
import { PET_SPECIES } from "./pet-species.ts";
import { isWritableName } from "./writable-name.ts";

/**
 * The longest a NEW pet name may be.
 *
 * NOT a cap on what the column may hold — see the header. It gates values a
 * person is typing now; whatever the animal already carries passes at any
 * length, through `resolvePetIdentityLengths`.
 */
export const PET_NAME_MAX = 80;

/** The longest a NEW colour description may be. Same rule as the name. */
export const PET_COLOR_MAX = 80;

/**
 * The server's own cap on a contact NAME, mirrored rather than invented —
 * `update-emergency-contacts.ts` rejects longer with "Máximo 80 caracteres".
 */
export const EMERGENCY_CONTACT_NAME_MAX = 80;

/**
 * The server's own cap on a contact PHONE. Forty, not eighty: the column holds a
 * dialable string, and the web's field agrees. Format is NEVER validated — the
 * writer says so out loud ("a soft client-side warning, never a server error"),
 * because a national registry that refused an unusual but real number would be
 * refusing the one call that matters during an emergency.
 */
export const EMERGENCY_CONTACT_PHONE_MAX = 40;

/**
 * The vocabulary a client shows a field message from.
 *
 * TWO OF THEM DO NOT COME FROM THE SCHEMA. `NAME_TOO_LONG` and `COLOR_TOO_LONG`
 * are `resolvePetIdentityLengths`' answers, because a length rule that
 * grandfathers the stored value cannot be a `.max()` on a schema that has never
 * seen the row. They are listed here anyway: the vocabulary belongs to the
 * COMMAND, not to whichever layer happens to detect the problem.
 */
export const PET_PROFILE_COMMAND_INPUT_CODES = [
  "COMMAND_REQUIRED",
  "NAME_REQUIRED",
  "NAME_INVALID",
  "NAME_TOO_LONG",
  "COLOR_TOO_LONG",
  "CONTACT_NAME_TOO_LONG",
  "CONTACT_PHONE_TOO_LONG",
  "SPECIES_INVALID",
] as const;
export type PetProfileCommandInputCode = (typeof PET_PROFILE_COMMAND_INPUT_CODES)[number];

/** A trimmed optional string; absent, blank and `null` all mean "not stated". */
const optionalBreed = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null));

/** Same shape as the breed, and capped by the same grandfather-aware gate. */
const optionalColor = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null));

/**
 * Edit the animal's identity.
 *
 * `name` IS REQUIRED because the column is `not null` and the credential is
 * addressed by it everywhere a person reads one. `breed` and `color` are
 * required KEYS with nullable values, not optional keys, for the reason
 * `createLibretaShare` makes about `expiresInDays`: an absent field would have
 * to mean either "leave it" or "clear it", the two are different acts, and a
 * contract that let a client ask for the ambiguity would have to invent an
 * answer. Posting `null` clears; posting the current value leaves it.
 */
const editIdentity = z.object({
  command: z.literal("edit_identity"),
  // NOT `.max(PET_NAME_MAX)`: the length rule needs the stored value to tell a
  // carried-over name from a typed one. `resolvePetIdentityLengths` is it.
  //
  // The SHAPE rule is different in kind and belongs here: a name made of
  // zero-width spaces is not a name at any length, there is nothing to
  // grandfather (no writer can have stored one — this and alta are the only two
  // doors, and both refuse it now), and a rename to `"​​"` would blank
  // the animal's credential (A2-alta-asentar-09).
  name: z
    .string({ error: "NAME_REQUIRED" })
    .trim()
    .min(1, { error: "NAME_REQUIRED" })
    .refine(isWritableName, { error: "NAME_INVALID" }),
  breed: optionalBreed,
  color: optionalColor,
});

/** What the animal already holds in the two capped free-text columns. */
export type StoredPetIdentityText = {
  name: string;
  color: string | null;
};

export type PetIdentityLengthResolution =
  | { ok: true }
  | { ok: false; code: "NAME_TOO_LONG" | "COLOR_TOO_LONG" };

/**
 * The length gate for `edit_identity`, applied to NEW VALUES ONLY.
 *
 * The grandfather rule, stated once: a submitted value identical to the one
 * already stored on the animal passes at any length. That is
 * `resolveBreedForWrite`'s own comparison (QA A5) applied to the two columns
 * that have a number instead of a catalog, and it is the whole reason this is a
 * function of the ROW and the request rather than a `.max()` on the schema.
 *
 * WHY THE ORDER OF THE TWO CHECKS IS FIXED: the first refusal wins, and it is
 * the name's, matching `firstPetProfileCommandInputCode` — one message, and the
 * one nearest the top of the form.
 *
 * Both sides call it. The client, holding the payload it pre-filled from, says
 * so before the round trip; the server, holding the row the guard read, enforces
 * it. Neither derives a rule of its own.
 */
export function resolvePetIdentityLengths(
  edit: { name: string; color: string | null },
  stored: StoredPetIdentityText,
): PetIdentityLengthResolution {
  if (exceedsCap(edit.name, PET_NAME_MAX, stored.name)) {
    return { ok: false, code: "NAME_TOO_LONG" };
  }
  if (exceedsCap(edit.color, PET_COLOR_MAX, stored.color)) {
    return { ok: false, code: "COLOR_TOO_LONG" };
  }
  return { ok: true };
}

/**
 * The longest this field may be RIGHT NOW, for a control that truncates.
 *
 * A `maxLength` fixed at the cap is not a milder version of the refusal above —
 * it is worse. React Native's `TextInput` truncates the VALUE it is handed, so a
 * 120-character stored name pre-filled into an input capped at 80 arrives on
 * screen already shortened, and the next save writes the shortened one. The
 * refusal locks an owner out; the truncation edits their animal's name without
 * being asked. Both halves need the same grandfather, so both take it from here.
 */
export function petIdentityFieldCap(cap: number, stored: string | null): number {
  const storedLength = stored?.trim().length ?? 0;
  return storedLength > cap ? storedLength : cap;
}

function exceedsCap(value: string | null, cap: number, stored: string | null): boolean {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length <= cap) return false;
  // Grandfathered: what the animal already has, posted back unchanged.
  return trimmed !== (stored?.trim() ?? "");
}

const contactName = z
  .string()
  .trim()
  .max(EMERGENCY_CONTACT_NAME_MAX, { error: "CONTACT_NAME_TOO_LONG" });

const contactPhone = z
  .string()
  .trim()
  .max(EMERGENCY_CONTACT_PHONE_MAX, { error: "CONTACT_PHONE_TOO_LONG" });

/**
 * Set this animal's emergency-contact OVERRIDE.
 *
 * ALL FOUR FIELDS ARE REQUIRED AND AN EMPTY STRING IS MEANINGFUL: it clears the
 * pet-level override so the account default shows through again. That is the
 * web sheet's own behaviour — it posts all four every time — and it is why the
 * fields are not optional: an omitted key would be indistinguishable from a
 * cleared one, and the writer would have to guess which of two different acts
 * the person meant.
 */
const setEmergencyContacts = z.object({
  command: z.literal("set_emergency_contacts"),
  preferredVetName: contactName,
  preferredVetPhone: contactPhone,
  emergencyContactName: contactName,
  emergencyContactPhone: contactPhone,
});

/**
 * Correct the animal's SPECIES — the FULL-LOCK path (PO decision #40).
 *
 * NOT A FIELD OF `edit_identity`, deliberately, and the read's contract says why
 * at length: species drives PPP/compliance, so the profile-edit writer omits the
 * column from its `SET` and a genuine correction goes through its own use-case
 * (`correctPetSpecies`), which appends its own `pet_profile_updated`, clears a
 * breed the new species' catalog does not carry, and re-resolves the PPP flag.
 * That is the web's `corregir-especie` sheet, and this command is the same
 * door.
 *
 * THE VOCABULARY IS THE CONTRACT'S OWN `PET_SPECIES`, so a client cannot post a
 * species this registry does not know; the use-case checks the same list again
 * behind the schema, for the web form that has no schema in front of it.
 *
 * POSTING THE SPECIES THE ANIMAL ALREADY HAS IS A SUCCESS WITH `changed: false`,
 * never a refusal — a correction's success invalidates its own precondition, so
 * a retry that lost its response must answer the way the first attempt did.
 */
const correctSpecies = z.object({
  command: z.literal("correct_species"),
  species: z.enum(PET_SPECIES, { error: "SPECIES_INVALID" }),
});

export const petProfileCommandInputSchema = z.discriminatedUnion("command", [
  editIdentity,
  setEmergencyContacts,
  correctSpecies,
]);

export type PetProfileCommandInput = z.infer<typeof petProfileCommandInputSchema>;
export type PetProfileCommand = PetProfileCommandInput["command"];

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Mirrors `firstShareCommandInputCode` — same shape, same reason.
 */
export function firstPetProfileCommandInputCode(
  error: z.ZodError<unknown>,
): PetProfileCommandInputCode | null {
  for (const issue of error.issues) {
    const code = issue.message;
    if ((PET_PROFILE_COMMAND_INPUT_CODES as readonly string[]).includes(code)) {
      return code as PetProfileCommandInputCode;
    }
  }
  for (const issue of error.issues) {
    if (issue.code === "invalid_union" || issue.path.length === 0 || issue.path[0] === "command") {
      return "COMMAND_REQUIRED";
    }
  }
  return null;
}
