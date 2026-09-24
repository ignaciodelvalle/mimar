// Titular-only effects — the machine-checkable subject of the deny-list fence.
//
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// Since custodia-temporal, an active ownership row no longer implies "this
// caller may do anything to this pet". A `caretaker` row is a bounded, scoped
// grant: medical events, notes, photos, lost/found — yes; transferring the
// animal, publishing it for adoption, moving its jurisdiction, minting a public
// share link or editing its identity — no.
//
// The property worth machine-checking is NOT "these seven call sites are
// gated". A list of seven proves nothing about a default-ALLOW rule: the eighth
// writer, written next month in a module that does not exist yet, is exactly
// the one that will not be on it. So the fence keys on the EFFECT — the closed
// set of database outcomes a titular-only action produces — and this file is
// the single declaration of that set, imported by:
//
//   - scripts/check-titular-gate.ts   (the CI fence, app layer)
//   - db/migrations/*                 (the SQL mirror, RLS layer — a SECOND
//                                      copy by design; the duplication is
//                                      fenced by a db-project equality test)
//
// Keep this file dependency-free apart from the EventType type: the fence
// script, the application code and the tests all import it, and a runtime
// dependency on the database client would drag the whole suite into the serial
// `db` vitest project.

import type { EventType } from "@dim/contract/events";

export type TitularOnlyDenyListRow = {
  /** Stable id, referenced by tests and by the RLS migration's comments. */
  readonly id: string;
  readonly summary: string;
  /**
   * The enforcement signals this row is caught by. EVERY entry must be a member
   * of one of the three constants below — the coverage self-test checks it, so
   * emptying a constant to turn a red build green breaks the deny-list instead
   * of silently shrinking the fence's subject.
   */
  readonly signals: readonly string[];
  /**
   * Non-null when the row is knowingly UNENFORCED for now, with the reason and
   * the commit that closes it. A row may have no signals only if it says so out
   * loud — "covered" by silence is the exact failure this file exists to avoid.
   */
  readonly pending: string | null;
};

/**
 * The seven titular-only outcomes, as committed in the spec
 * (`sdd/custodia-temporal/spec` → "Deny-list fence"). This array is NOT what
 * the fence scans — it is the anti-emptying anchor.
 */
export const TITULAR_ONLY_DENY_LIST: readonly TitularOnlyDenyListRow[] = [
  {
    id: "transfer-initiation",
    summary: "Initiating or resolving a change of titularidad.",
    // NOTE, verified rather than assumed: initiatePetTransferAction was ALREADY
    // titular-safe before this change — TransfersRepository.findActiveOwnerOwnership
    // filters role='owner', so a caretaker never passes it. The signals below are
    // the second layer, for a future writer that does not repeat that care.
    signals: ["custody_transfer_proposed", "custody_transferred", "custody_transfer_cancelled"],
    pending: null,
  },
  {
    id: "adoption-eligibility-publishing",
    summary: "Flagging a pet as available for adoption.",
    // Org-only when this row was written (requireCapabilityForOrgToken, where
    // holderRole is null by construction), so the comment used to say there was
    // "no person-path writer to gate, only a future one". rehome-by-titular IS
    // that writer: the titular's withdraw clears adoptionListedAt from a person
    // session. The two listing columns are gated together because the catalog
    // predicate is a CONJUNCTION (`adoption_listed_at IS NOT NULL AND
    // adoption_listing_paused_at IS NULL`) — gating only the first would leave a
    // person-path writer able to CLEAR the pause and re-publish a listing the
    // org paused. Gating one half of a conjunction is not gating it.
    signals: [
      "adoption_eligibility_set",
      "adoptionEligible",
      "adoptionListedAt",
      "adoptionListingPausedAt",
    ],
    pending: null,
  },
  {
    id: "jurisdiction-change",
    summary: "Moving the pet between provinces/localities.",
    signals: ["jurisdictionCountry", "jurisdictionProvince", "jurisdictionLocality", "localityId"],
    pending: null,
  },
  {
    id: "caretaker-sub-designation",
    summary: "A caretaker designating another caretaker.",
    // CLOSED by C5 (the caretakers module). The one legitimate writer of this
    // event type is NOT the titular — it is the invitee accepting their own
    // invitation, who by definition holds no ownership row on the pet yet. That
    // writer is exempted by an inner-writer suffix
    // (CaretakersRepository.insertAcceptGrantForToken), which is the escape
    // hatch the fence provides, with the justification written where the code
    // is rather than in an allowlist entry nobody re-reads.
    signals: ["caretaker_designated"],
    pending: null,
  },
  {
    id: "tier2-public-toggle",
    summary: "Opening the Tier-2 public window on the credential.",
    signals: ["tier2PublicEnabledUntil", "tier2PublicPermanent"],
    pending: null,
  },
  {
    id: "libreta-share-minting",
    summary: "Minting a libreta share token (a public, bearer-readable link).",
    signals: ["libretaShareTokens"],
    pending: null,
  },
  {
    id: "ppp-attestation",
    summary: "Attesting the pet's inscription in an official dangerous-breed registry.",
    // T4-I1 / #753. The PPP registries (Ley CABA 4078 → APrA; Ley PBA 14.107 →
    // Registro Provincial) inscribe the PROPIETARIO, not whoever happens to be
    // holding the animal this month: the owner files the form, the owner holds
    // the RC policy, the owner sits the course, and the number that comes back
    // is the owner's. A caretaker asserting that inscription happened is
    // asserting a legal fact about somebody else, permanently, in an
    // append-only ledger — and the assertion is exactly the one that takes a
    // dog OUT of the visibly-non-compliant cohort an authority is looking at.
    // Nothing legitimate is lost: the titular files it, and an org holding the
    // animal reaches it on the org path, which this gate does not touch.
    //
    // WHAT ENFORCES THIS ROW — and it is NOT the fence, which is why the
    // sentence is here rather than left to be assumed. Measured 2026-09-22:
    // with the titular check deleted from `createDangerousBreedAttestationAction`,
    // `scripts/check-titular-gate.ts` still reported clean. Its `directEffects`
    // scan needs `.insert(`, the identifier `petEvents` and the event-type
    // literal in ONE function body; this writer spreads those across the
    // action, the use-case and `EventsRepository.insertEvent`. That is the
    // "regex over file-local bodies" residual the fence's own header states,
    // reached here by repository indirection. The RLS mirror is not the
    // backstop either — 0212 dropped the `pet_events` INSERT policy that read
    // `titular_only_event_types()`, so migration 0243 keeps the second copy
    // honest for the day a policy wants it back and enforces nothing today.
    //
    // The enforcement is therefore explicit and tested at both doors:
    //   - web:     src/modules/events/actions.ts (isTitularHolder +
    //              requireTitularAccess), asserted by
    //              src/modules/events/application/identity/auth-parity.test.ts
    //   - /api/v1: checkWriteGuard in
    //              app/api/v1/pets/[publicToken]/events/writers.ts, asserted by
    //              __tests__/api-v1-record-event-route.test.ts
    //   - page:    the atestar-raza-peligrosa route gates on
    //              requireTitularAccess so the control is never drawn.
    // The signal below is still correct — the type IS titular-only — but a
    // reader must not infer the fence catches a new writer of it. One that
    // inserts into `petEvents` in its own body WOULD be caught.
    signals: ["dangerous_breed_attested"],
    pending: null,
  },
  {
    id: "identity-field-edits",
    summary: "Editing name, species, breed or date of birth.",
    // Pet DELETION belongs to this row rather than a row of its own: DIM has no
    // pet-deletion path today (no pets.deleted_at, no delete action), so a
    // separate row would document a fence over nothing.
    signals: ["name", "species", "breed", "dateOfBirth"],
    pending: null,
  },
] as const;

/**
 * Event types only a titular may write.
 *
 * DELIBERATE EXCLUSIONS, so the next reader does not have to re-derive them:
 *   - `movement_recorded` carries a `sub_kind` discriminator with three faces
 *     (jurisdiction_changed | cvi_issued | transport_recorded) and only the
 *     first is titular-only. The column rule catches exactly that face; naming
 *     the event type would deny a caretaker from recording a trip.
 *   - `adoption_finalized` / `ownership_claimed` are shelter-side and
 *     claimant-side facts respectively. Neither is reachable from a caretaker's
 *     ownership row, and both are read (queried) far more often than written,
 *     which would make the regex noisy for no security gain.
 *   - `death_recorded` is EXPLICITLY allowed to a caretaker (spec: "Allowed
 *     caretaker actions"), with a mandatory titular notification instead.
 *   - `caretaker_ended` is NOT here, and the asymmetry with its sibling is
 *     deliberate: a caretaker withdrawing from their OWN arrangement is
 *     legitimate, and the expiry cron writes it with no acting user at all.
 *     Denying it would break both. Only the DESIGNATION is titular-only.
 *
 * ADDING ONE HERE HAS A SQL COUNTERPART. `public.titular_only_event_types()`
 * (migration 0190, amended by 0191) is a second copy of this array, and
 * __tests__/caretaker-rls-hardening.test.ts asserts the two are equal. Editing
 * this list without a migration turns that test red — on purpose.
 */
export const TITULAR_ONLY_EVENT_TYPES: readonly EventType[] = [
  "custody_transfer_proposed",
  "custody_transferred",
  "custody_transfer_cancelled",
  "adoption_eligibility_set",
  // custodia-temporal C5: a caretaker must not name a sub-caretaker. The one
  // legitimate non-titular writer (the invitee accepting) is exempted by an
  // inner-writer suffix, not by leaving the type out of this list.
  "caretaker_designated",
  // rehome-by-titular: BOTH halves, unlike the caretaker pair above. The
  // asymmetry there rests on two facts that do not hold here — a caretaker
  // legitimately ends their own arrangement, and a cron writes the end with no
  // acting user. No caretaker is party to a sponsorship and there is no cron,
  // so the only person-path writer of either type is the titular themselves.
  // Gating both denies a caretaker forging sponsorship consent (a permanent lie
  // in an append-only ledger) at zero cost to any legitimate writer.
  // SQL counterpart: migration 0194.
  "rehome_sponsorship_started",
  "rehome_sponsorship_ended",
  // T4-I1 / #753: the PPP attestation. Deny-list row `ppp-attestation` carries
  // the reasoning; what belongs HERE is why the list is the right instrument.
  // The alternative considered was leaving emission open and letting the
  // compliance card discount a caretaker's word on provenance alone. That
  // discounts it on the READ side only: the row is still in the spine forever,
  // still says "inscripta", and every future reader that does not re-derive
  // provenance believes it. A legal attestation nobody was entitled to make is
  // better refused at the write than annotated at the read — and the two are
  // not alternatives here, since derivePpp gained the provenance gate in the
  // same change.
  // SQL counterpart: migration 0243.
  "dangerous_breed_attested",
] as const;

/**
 * Drizzle column keys on `pets` that only a titular may write. Named in the
 * Drizzle (camelCase) spelling because that is what the fence scans; the SQL
 * mirror in the RLS migration uses the snake_case column names.
 */
export const TITULAR_ONLY_PET_COLUMNS: readonly string[] = [
  // Jurisdiction (deny-list row 3)
  "jurisdictionCountry",
  "jurisdictionProvince",
  "jurisdictionLocality",
  "localityId",
  // Tier-2 public window (row 5)
  "tier2PublicEnabledUntil",
  "tier2PublicPermanent",
  // Adoption eligibility + listing shelf (row 2). Both listing columns, not
  // just the first: the catalog predicate ANDs them, so gating one leaves the
  // other as a way to put a pet back on the shelf. No SQL mirror is needed —
  // only the event-type array is duplicated into RLS, and the `pets` UPDATE
  // policy is row-level and already denies a caretaker every column on the row.
  "adoptionEligible",
  "adoptionListedAt",
  "adoptionListingPausedAt",
  // Identity (row 7)
  "name",
  "species",
  "breed",
  "dateOfBirth",
] as const;

/** Tables whose INSERT is a titular-only effect in itself. */
export const TITULAR_ONLY_INSERT_TABLES: readonly string[] = ["libretaShareTokens"] as const;

const TITULAR_ONLY_EVENT_TYPE_SET: ReadonlySet<string> = new Set(TITULAR_ONLY_EVENT_TYPES);

export function isTitularOnlyEventType(value: string): boolean {
  return TITULAR_ONLY_EVENT_TYPE_SET.has(value);
}
