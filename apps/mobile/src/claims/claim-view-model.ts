// Reclamar una mascota — the words for every answer, and the shape of every ask.
//
// PURE, like every other view-model in this app: it owns the es-AR sentence for
// each state and the mapping from what somebody typed into a
// `PetClaimCommandInput`. Nothing here touches the network.
//
// THE VALIDATION IS THE SERVER'S OWN SCHEMA, imported and not re-stated — the
// rule `transfers-view-model.ts` and `turnos-view-model.ts` both follow. What
// lives here is the WORDS: the contract carries codes, the consumer owns its
// copy.
//
// NOTHING HERE MAY DECIDE WHETHER A CLAIM IS ALLOWED
// ---------------------------------------------------------------------------
// `canClaim` comes from the server on every lookup ack and this file reads it.
// It looks derivable — today it is exactly `variant === "free"` — and deriving
// it would be wrong for a reason that is not stylistic: "free" is an
// AUTHORIZATION rule owned by `submitFreeClaimForUser` (no active custody of ANY
// role, re-checked inside the claiming transaction under a row lock, plus three
// status gates), and a screen that computed the affordance itself would be
// keeping a second copy of that rule. On the most consequential act in this
// product, the flattering error is the dangerous one: a button drawn over an
// animal somebody else holds is an interface promising custody of a stranger's
// dog.
//
// WHAT THIS APP CANNOT DO, AND SAYS SO IN WORDS INSTEAD OF HIDING
// ---------------------------------------------------------------------------
// The web's wizard has a third step for `active_owner`: iniciar una disputa. It
// requires at least one evidence FILE — a rule the server enforces absolutely —
// and this app cannot attach one, because an image picker is a native module and
// that is an EAS build. So `activeOwnerBody` names the browser rather than
// leaving a dead end, and there is no `dispute` anything in this file. The day
// this app can carry bytes, the copy and the contract change together.

import type { PetClaimLookupAckV1, PetClaimVariantV1 } from "@dim/contract/api";
import type {
  PetClaimCommandInput,
  PetClaimCommandInputCode,
  PetClaimIdentifierKind,
} from "@dim/contract/input";
import { firstPetClaimCommandInputCode, petClaimCommandInputSchema } from "@dim/contract/input";
import { deepLinkUrl } from "@dim/contract/links";

/** The web wizard's own two labels for the radio pair. */
export function claimIdentifierKindLabel(kind: PetClaimIdentifierKind): string {
  switch (kind) {
    case "microchip":
      return "Microchip";
    case "tattoo":
      return "Tatuaje";
  }
}

/** What the field above the input says, which differs by kind on the web too. */
export function claimIdentifierFieldLabel(kind: PetClaimIdentifierKind): string {
  return kind === "microchip" ? "Número de microchip" : "Código del tatuaje";
}

/** The placeholder, copied from the web's own two. */
export function claimIdentifierPlaceholder(kind: PetClaimIdentifierKind): string {
  return kind === "microchip" ? "123456789012345" : "ABC-1234";
}

/**
 * Build and validate one command, using the CONTRACT'S schema.
 *
 * A success carries the PARSED input — trimmed by the schema — and not what was
 * typed, so a chip pasted with a trailing newline reaches the server clean and
 * the fifteen-digit rule is checked against the same value the server will see.
 */
export type ClaimCommandDraft =
  | { ok: true; input: PetClaimCommandInput }
  | { ok: false; code: PetClaimCommandInputCode | null };

export function buildClaimCommand(
  command: PetClaimCommandInput["command"],
  kind: PetClaimIdentifierKind,
  value: string,
): ClaimCommandDraft {
  const parsed = petClaimCommandInputSchema.safeParse({
    command,
    identifierKind: kind,
    identifierValue: value,
  });
  if (parsed.success) return { ok: true, input: parsed.data };
  return { ok: false, code: firstPetClaimCommandInputCode(parsed.error) };
}

/**
 * The es-AR sentence for a local input refusal.
 *
 * EXHAUSTIVE over `PetClaimCommandInputCode` with no `default`, so a code added
 * to the contract is a compile error here rather than a blank line under a
 * heading. `null` is the shape a parse failure the vocabulary does not cover
 * takes, and it gets a sentence too — silence is the one answer a form may not
 * give.
 */
export function claimInputMessage(code: PetClaimCommandInputCode | null): string {
  if (code === null) return "Revisá los datos: hay algo que no pudimos interpretar.";
  switch (code) {
    case "COMMAND_REQUIRED":
      // Unreachable from this screen — it names its own command — and it still
      // needs a sentence, because "unreachable" is a claim about today's code.
      return "No pudimos preparar el pedido. Volvé a intentar.";
    case "IDENTIFIER_KIND_REQUIRED":
      return "Elegí si vas a buscar por microchip o por tatuaje.";
    case "IDENTIFIER_REQUIRED":
      return "Escribí el número de microchip o el código del tatuaje.";
    case "MICROCHIP_MUST_BE_15_DIGITS":
      // The number, in words, because a person counting digits on a vet's
      // sticker needs to know what to count to.
      return "El microchip tiene que tener exactamente 15 dígitos.";
  }
}

/**
 * The heading for a lookup answer.
 *
 * `petName` IS `null` ONLY ON `not_found`, and the other four are typed as
 * `string | null` on the wire because the flat shape has one field for five
 * arms. The fallback here is a WORD and not an empty string: a heading that
 * silently loses the animal's name reads as a rendering bug rather than as a
 * missing value.
 */
export function claimVariantHeadline(ack: PetClaimLookupAckV1): string {
  const name = ack.petName ?? "La mascota";
  switch (ack.variant) {
    case "not_found":
      return "No encontramos una mascota con ese identificador.";
    case "free":
      return `Encontramos a ${name} y no tiene dueño/a registrado/a.`;
    case "active_owner":
      // The initials in parentheses when there are any, and NOTHING when there
      // are not — the web prints it exactly this way. `null` here does not mean
      // "no custody": a refugio holding an animal under `shelter_custody` has no
      // owner row and therefore no initials, and the variant is still this one.
      return ack.ownerInitials
        ? `${name} ya tiene dueño/a registrado/a (${ack.ownerInitials}).`
        : `${name} ya está bajo la custodia de otra persona u organización.`;
    case "lost":
      return `${name} está reportada como perdida.`;
    case "deceased":
      return `${name} figura como fallecida en miMAR.`;
  }
}

/** The explanatory line under the heading — what to do next, in each case. */
export function claimVariantBody(ack: PetClaimLookupAckV1): string {
  switch (ack.variant) {
    case "not_found":
      return "Si la mascota es tuya, registrala y le emitimos la credencial.";
    case "free":
      return "Podés reclamarla ahora: queda registrada a tu nombre y le emitimos la credencial.";
    case "active_owner":
      // THE ONE SENTENCE IN THIS FILE THAT NAMES A LIMIT OF THIS APP. The web
      // offers a disputa here; it needs a foto or a video as evidence and this
      // build cannot attach one. Saying where the flow continues is the
      // difference between a screen that is honest and a dead end.
      return "Si creés que es tuya podés iniciar una disputa, pero hace falta adjuntar una foto o un video como prueba y eso todavía se hace desde la web.";
    case "lost":
      return "Si la encontraste, avisale a quien la está buscando con un reporte de avistaje en lugar de reclamarla.";
    case "deceased":
      return "Si creés que es un error, escribinos: una mascota fallecida no se puede reclamar.";
  }
}

/**
 * The tone a variant should be drawn in.
 *
 * Mapped here rather than in the screen so the five arms are decided in one
 * place, and mapped onto `Callout`'s vocabulary rather than onto colours.
 */
export function claimVariantTone(variant: PetClaimVariantV1): "neutral" | "ok" | "warn" | "err" {
  switch (variant) {
    case "free":
      return "ok";
    case "active_owner":
    case "lost":
      return "warn";
    case "deceased":
      return "err";
    case "not_found":
      return "neutral";
  }
}

/**
 * The web page where a finder reports having seen a lost animal.
 *
 * AN `https` URL AND NOT A `mimar://` ONE, and `deepLinkAppUrl` would throw for
 * this destination anyway: `DEEP_LINK_MAP.credentialSighting` has `appPath:
 * null`, because there is no native sighting form and a custom scheme resolves
 * to nothing for everybody who has not installed this app. The path comes from
 * the same table the web builds its own links from, so a rename is a compile
 * error rather than a 404 nobody notices.
 */
export function claimSightingUrl(origin: string, petToken: string): string {
  return deepLinkUrl(origin, "credentialSighting", { publicToken: petToken });
}

/**
 * The web page where the disputa this app cannot run is started.
 *
 * THROUGH THE SHARED TABLE, LIKE `claimSightingUrl` ABOVE (T4-M6, 2026-09-22).
 * This used to interpolate `${origin}/mis-mascotas/reclamar` by hand — the one
 * function in this file that did not follow the rule its own neighbour states:
 * a rename of the web route is now a compile error here, not a link that goes
 * quietly 404 for whoever taps it.
 */
export function claimDisputeUrl(origin: string): string {
  return deepLinkUrl(origin, "claimDispute", {});
}

/**
 * What a scanned barcode contributes to the identifier field — or `null`.
 *
 * THE SCANNER AND THE KEYBOARD FEED ONE VALIDATION PATH. The camera seam's
 * contract (`chip-scanner-port.ts`) hands over the barcode's RAW string,
 * unparsed, and this function is the single place that decides whether that
 * string is a chip number. What it returns is set into the SAME field the
 * keyboard writes, so `buildClaimCommand` — the contract's schema — still runs
 * on it exactly as it runs on a typed value. A scanner that bypassed the field
 * would be a second door with its own validation, which is the drift this
 * function exists to prevent.
 *
 * WHAT IT ACCEPTS: exactly fifteen digits, after stripping the separators a
 * sticker's barcode may carry (spaces, hyphens, dots). ISO 11784 chip numbers
 * are fifteen digits, the contract's schema demands fifteen digits, and the
 * keyboard field caps at fifteen — so this is a transcription of the rule that
 * already exists on both ends, not a new one.
 *
 * WHAT IT REFUSES, WITH `null`: everything else. A vet's sticker carries more
 * than one barcode (lot numbers, product codes), and a camera pointed at the
 * wrong one must not fill the field with a value the person then has to notice
 * and delete — `null` keeps the field as it was, and the screen says what
 * happened in a sentence instead.
 */
export function chipCodeFromScan(raw: string): string | null {
  const digits = raw.replace(/[\s.-]/g, "");
  return /^\d{15}$/.test(digits) ? digits : null;
}

/**
 * The sentence for a scan that read SOMETHING, just not a chip number.
 *
 * It names the way forward that always works — the keyboard — because the
 * person most likely scanned one of the sticker's other barcodes, and "volvé a
 * intentar" alone would send them back to the same wrong code.
 */
export const SCAN_NOT_A_CHIP_MESSAGE =
  "El código escaneado no es un número de microchip. Probá con el otro código de la etiqueta, o escribilo a mano.";
