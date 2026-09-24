// What makes a PPP attestation COUNT — T4-I1 / issue #753.
//
// THE QUESTION THIS ANSWERS
// ---------------------------------------------------------------------------
// `dangerous_breed_attested` says "this dog is inscribed in the official
// dangerous-breed registry". That claim has legal weight in both directions:
// believed wrongly it takes a dog out of the cohort an authority is watching
// (Ley CABA 4078 → APrA; Ley PBA 14.107 → Registro Provincial); disbelieved
// wrongly it burdens an owner who did everything the law asked. Until this
// module existed the claim was believed unconditionally — `derivePpp` stamped
// the card `ok` on the mere EXISTENCE of an event, and the /gob C7 metric
// counted the same bare existence.
//
// WHY THE H1 PROVENANCE GATE DOES NOT TRANSFER UNCHANGED
// ---------------------------------------------------------------------------
// Rabies, sterilization and microchip clear their obligation only on a
// professional/institutional signature, and that is right because only a
// matriculated vet can administer a dose or implant a chip — the owner is not
// competent to perform the act, so their word about it is a second-hand
// report.
//
// PPP INSCRIPTION IS THE OPPOSITE. The registries inscribe the PROPIETARIO,
// and the owner is the ONLY person who can perform the act: they file at APrA
// via TAD (or at a Delegación Municipal for 14.107), they hold the RC policy,
// they sit the course. Copying the H1 gate here would make the obligation
// unsatisfiable through the product — no vet signature exists to wait for, and
// DIM has no government writer for this type — so every PPP dog in the country
// would read "not al día" forever and C7 would be pinned at 0%. A number that
// cannot move is not a compliance signal; it is a broken gauge that happens to
// look strict.
//
// WHAT DISTINGUISHES A CLAIM FROM EVIDENCE, THEN
// ---------------------------------------------------------------------------
// The registry issues a NUMBER. Citing it is falsifiable — an authority reading
// `/gob` can take that number back to its own registry and check it, which is
// exactly what "the attestation has legal weight" is supposed to mean. Not
// citing it is a bare assertion that nothing can be checked against.
//
// So an attestation counts when EITHER:
//   (a) it cites a `registry_id` — the inscription number the registry gave the
//       owner, checkable at the source; or
//   (b) its provenance already clears the H1 gate — a govt actor or a verified
//       organization recorded it, i.e. an accountable institution put its name
//       on the claim. This arm is what a future funcionario-side writer or a
//       registry federation lands on, with no change here.
//
// An attestation with neither is not REFUSED — it is a true thing the owner
// wanted on the record, and refusing it would lose information. It is shown as
// DECLARADA, with a hint naming the number as what turns it into "al día".
//
// PO OVERRIDE POINT, stated so it is one line to move: if the product decides
// an owner's bare word should count (a defensible reading — the owner IS the
// lawful declarant), `attestationCountsAsCompliant` returns true whenever an
// attestation exists, and the SQL mirror drops its `registry_id` term. If it
// should be STRICTER (institutional only), arm (a) goes away on both sides.
//
// THE SQL MIRROR IS A SECOND COPY BY DESIGN. `/gob`'s C7 counts over millions
// of rows and cannot call a TS predicate per pet, so
// lib/analytics/compliance-metrics.ts carries the same rule as a SQL fragment.
// The duplication is fenced: __tests__/ppp-attestation-evidence.test.ts runs
// both over the same fixtures and asserts they agree. Change one, the test
// fails until you change the other.
//
// Keep this file dependency-free apart from the confidence model: the
// projection, the analytics layer and the fence all import it.

import { type ConfidenceInput, computeConfidence } from "@/lib/events/event-confidence";

/**
 * The fields of a `dangerous_breed_attested` row this rule reads.
 *
 * `payload` is `unknown` and not `Record<string, unknown>` so a
 * `ComplianceEvent` (whose payload is `unknown` — it crosses a projection
 * boundary and is narrowed at use) is assignable without a cast at every call
 * site. The narrowing happens ONCE, in `payloadOf` below, which is the only
 * place in this module that touches it.
 */
export type PppAttestationEvent = {
  authorRole?: string | null;
  authorVerified?: boolean | null;
  authorOrganizationId?: string | null;
  payload?: unknown;
};

function payloadOf(event: PppAttestationEvent): Record<string, unknown> {
  const raw = event.payload;
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

/**
 * Arm (a): the attestation cites the number the registry issued.
 *
 * A non-empty STRING, and the emptiness check is not pedantry — the web form
 * posts `registryId` as `String(...).trim() || null`, so a person who tabbed
 * through the field sends `null`, but an API caller may send `""` and a
 * whitespace-only value is the same bare assertion wearing a number's clothes.
 */
export function citesRegistryId(event: PppAttestationEvent): boolean {
  const raw = payloadOf(event).registry_id;
  return typeof raw === "string" && raw.trim().length > 0;
}

/**
 * Arm (b): an accountable institution put its name on the claim.
 *
 * The SAME two tiers `pet-compliance.ts::clearsObligation` accepts, read from
 * the shared confidence model rather than restated — a local copy of "which
 * tiers count" is how the PPP card and the rabies card drift into disagreeing
 * about what the word "verificada" means.
 *
 * THE PAYLOAD IS WITHHELD FROM THE MODEL, and that is the one deliberate
 * departure. `computeConfidence` opens with an A4 BUMPER: `confirmed_by_lab ===
 * true` returns `institutional_verified` for ANY author, owner included
 * (lib/events/event-confidence.ts). That bumper is right where it lives — a
 * positive lab result IS an independent third party confirming a DISEASE — and
 * wrong here, because the question this module asks is whether the animal is
 * INSCRIBED IN A REGISTRY, which no laboratory can attest to. Left in, an
 * attestation payload carrying a stray `confirmed_by_lab: true` would clear the
 * PPP obligation on nobody's authority.
 *
 * Passing `{}` therefore asks the shared model exactly the question it should
 * answer here — "who signed this?" — and nothing else. Every AUTHOR rule stays
 * shared; only the payload bumpers, which are about other event types'
 * evidence, are excluded. The SQL mirror has no `confirmed_by_lab` term for the
 * same reason, and ppp-attestation-evidence.test.ts pins the agreement.
 */
export function attestationIsInstitutional(event: PppAttestationEvent): boolean {
  const tier = computeConfidence({
    authorRole: event.authorRole ?? "",
    authorVerified: event.authorVerified ?? false,
    authorOrganizationId: event.authorOrganizationId ?? null,
    payload: {},
  } satisfies ConfidenceInput);
  return tier === "professional_verified" || tier === "institutional_verified";
}

/** The rule, as one predicate. See the header for why it has two arms. */
export function attestationCountsAsCompliant(event: PppAttestationEvent): boolean {
  return citesRegistryId(event) || attestationIsInstitutional(event);
}

/**
 * The es-AR nudge on a DECLARADA attestation: what turns it into "al día".
 *
 * Names the ARTIFACT (the number on the constancia) rather than telling the
 * person to go do the registration again — they say they already did, and a
 * hint that disbelieves them is the burden this whole module exists to avoid.
 */
export const PPP_DECLARED_HINT =
  "Agregá el número de inscripción que te dio el registro para que cuente como al día.";
