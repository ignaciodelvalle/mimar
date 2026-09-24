// The wire shape of `GET /api/v1/pets/{publicToken}/libreta` — the pet's
// consolidated health record.
//
// TYPES ONLY plus three frozen literals, like every other file in this entry
// point. There is no request body, so there is no sibling in
// `@dim/contract/input`.
//
// WHICH FACE THIS IS
// ---------------------------------------------------------------------------
// The web profile is a CARD WITH TWO FACES: "Credencial · frente" and
// "Libreta · dorso" (DocumentChrome's own band labels). `/pets/{token}` is the
// owner's chrome around that card — the alert strip, the compliance stamp, the
// arrangements — and `/pets/{token}/credential` is the front. THIS is the back:
// the ledger of asientos, what is coming due, and the vaccination summary.
// Three reads, three surfaces, none of them a superset of another.
//
// EVERY ENTRY IS ALREADY CORRECTED, AND SAYS SO. Amendments are folded exactly
// as the web folds them (`overlayAmendments`): a corrected asiento carries its
// CORRECTED values, and `amendedAt` is the marker that says a correction
// happened. The original is never rendered as if it were current, and it is
// never dropped either — the `event_amended` row is itself an entry in this
// timeline, because a correction is an event.
//
// NO RAW PAYLOAD CROSSES. Every fact on an entry comes from the per-type
// whitelist the web's asiento projection applies (H3) — internal ids, hashes
// and `matched_chip_number` are structurally unreachable, not filtered. The one
// identifier that DOES cross is `eventId`, for the same reason `reminderId`
// crosses on the owner face: an entry the owner can OPEN and CORRECT is a row a
// client cannot offer if it cannot name it.
//
// AND NO SIGNED URL CROSSES. An entry reports whether it carries an attachment
// and nothing more. Minting a signed URL is equivalent to handing out the file
// (`lib/infra/storage.ts` says so in those words), and a timeline hands out up
// to 250 of them into a payload a device holds — so the URLs live on
// `GET /pets/{token}/events/{eventId}`, one screen, one file, with an explicit
// expiry.

import type { PetSex } from "../input/intake.ts";
import type { OwnerPetDetailViewerRole } from "./owner-pet-detail.ts";
import type { CredentialSection } from "./public-credential.ts";

/**
 * Bumped when a field changes meaning or leaves. A client compares this against
 * the version it was built for BEFORE trusting any field.
 */
export const PET_LIBRETA_PAYLOAD_VERSION = 1;

/**
 * How long a client may present a cached copy as current.
 *
 * The same five minutes as the credential, `me/pets` and the owner face. A
 * libreta moves slower than any of them — an asiento is a historical fact — but
 * the FUTURE ledger does not: a reminder falls due, a turno is confirmed. What
 * matters is that the number is IMPORTED rather than re-decided on the client.
 */
export const PET_LIBRETA_STALE_AFTER_MS = 5 * 60_000;

/**
 * The most-recent asientos a single read hands a client.
 *
 * It is the web's own window (`PAST_EVENTS_WINDOW` in the libreta reader), not a
 * second number invented for this transport: both surfaces read through the
 * same use-case, and two different caps would be two different answers to "how
 * much of my animal's history am I looking at".
 *
 * NOT PAGINATED, and that is a measurement rather than an omission. On the
 * seeded registry the widest pet carries 54 events, p95 is 8, and the mean is
 * 3.6 — two orders of magnitude under this window. `truncated` on the timeline
 * section is what keeps the cap honest for the pet that one day exceeds it, and
 * the day a real p99 approaches 250 is the day this grows a keyset cursor.
 */
export const PET_LIBRETA_TIMELINE_WINDOW = 250;

// ---------------------------------------------------------------------------
// Identity — the ledger's masthead
// ---------------------------------------------------------------------------

/**
 * What the web prints across the top of the libreta face: the name, the token,
 * and the species/sex line.
 *
 * NO MICROCHIP NUMBER, deliberately, and the web face does not print one
 * either — the number is read by the loader for the export path and never
 * reaches this masthead. The owner face made the same call about `canonicalIds`
 * for the same reason: a payload a device caches to disk carries what the face
 * SHOWS.
 */
export type LibretaIdentitySection = {
  name: string;
  species: string;
  sex: PetSex | null;
  publicToken: string;
};

// ---------------------------------------------------------------------------
// Vaccination summary — the badges above the ledger
// ---------------------------------------------------------------------------

/**
 * One core vaccine's lifecycle, in the vocabulary the domain computes.
 *
 * `missing` and `unconfirmed` are SEPARATE and must stay that way on the wire:
 * `missing` says "never given", `unconfirmed` says "we cannot tell" — the
 * animal carries a dose whose free-text name the catalog could not resolve.
 * Collapsing them is what once let the libreta report a matrícula-signed dose
 * as absent (PO decision 2026-07-28).
 */
export type LibretaVaccineV1 = {
  vaccineName: string;
  status: "active" | "due_soon" | "expired" | "missing" | "unconfirmed";
  lastDoseAt: string | null;
  nextDueAt: string | null;
};

export type LibretaVaccinationSection = {
  active: number;
  dueSoon: number;
  expired: number;
  missing: number;
  unconfirmed: number;
  /**
   * DISTINCT vaccines on file whose name is not in the species catalog. They
   * do not move the core-vaccine verdict, and they must stay visible anyway —
   * a dose nobody can classify is still a dose somebody gave the animal.
   */
  otherCount: number;
  perVaccine: LibretaVaccineV1[];
};

// ---------------------------------------------------------------------------
// The future ledger — PRÓXIMO
// ---------------------------------------------------------------------------

/**
 * One upcoming item: a reminder, a confirmed appointment, or a pending
 * medication dose, merged into one ascending-by-`dueAt` list server-side.
 *
 * THE MERGE IS NOT THE CLIENT'S JOB. Three sources with three different
 * urgency rules resolve into one ordered ledger in the same helper the web
 * uses; a client that re-merged them would have forked a product decision whose
 * reasons it cannot see.
 *
 * `reminderId` is present only on rows the owner can ACT on (a reminder, a
 * medication dose) — the same "an actionable row a client cannot name is a row
 * it cannot offer" rule the owner face applies. The web's per-row hrefs do NOT
 * cross: a URL into `/mis-mascotas/...` is a web address, not a fact.
 */
export type LibretaUpcomingItemV1 = {
  id: string;
  kind: "reminder" | "appointment" | "medication";
  label: string;
  dueAt: string;
  reminderId: string | null;
};

export type LibretaUpcomingSection = { items: LibretaUpcomingItemV1[] };

// ---------------------------------------------------------------------------
// The timeline — ASIENTOS
// ---------------------------------------------------------------------------

/** One key/value row inside an asiento. */
export type LibretaFactV1 = {
  /** es-AR label, e.g. "Aplicada", "Vence", "Laboratorio". */
  key: string;
  value: string;
  /**
   * True when `value` is a PLACEHOLDER for data the record does not carry
   * ("Sin dato", "No adjunto") rather than a value. A client renders it faint;
   * a client that cannot tell them apart prints a missing lot number as if
   * somebody had written one.
   */
  missing: boolean;
  /** Render in the monospaced face — codes, chip numbers, tokens. */
  mono: boolean;
};

/**
 * Who signed an asiento, and whether that signature is verification.
 *
 * `verified` is the TIER, not the wording: a named professional the owner only
 * CITED is `verified: false` with a label that says so. Naming a vet is a
 * claim; only their signature is verification, and the two must read as
 * unmistakably different.
 */
export type LibretaProvenanceV1 = {
  verified: boolean;
  label: string;
};

/**
 * One asiento, already projected.
 *
 * `kind` / `title` / `facts` are composed SERVER-SIDE, out of the same
 * whitelisted per-type templates the web renders, for the reason the owner face
 * composed `breedLine` server-side: a second implementation of "what does a
 * deworming record say" is one more than this product can keep in agreement,
 * and this one carries the privacy whitelist inside it.
 *
 * `whenRelative` / `whenAbsolute` are composed here too, and that is not
 * laziness. Both are ARGENTINE-CALENDAR facts (`calendarDaysAgoInAr`, and an
 * AR-pinned absolute date): a phone travelling with its owner must not renumber
 * an animal's dates, and "hace 2 días" computed against a device clock in
 * another zone is exactly that bug. `occurredAt` travels as well, for a client
 * that needs to sort or group.
 */
export type LibretaEntryV1 = {
  /**
   * The spine row id. The ONE internal identifier on this payload, and it earns
   * it: it addresses `GET /pets/{token}/events/{eventId}` and the amend
   * endpoint. Not a pet id, not a case id, not an ownership row id.
   */
  eventId: string;
  /** From `@dim/contract/events` — the shared vocabulary, so a client may switch on it. */
  eventType: string;
  /** Mono uppercase eyebrow, e.g. "Vacuna · obligatoria". */
  kind: string;
  /** Record title, e.g. "Antirrábica". */
  title: string;
  occurredAt: string;
  whenRelative: string;
  whenAbsolute: string;
  facts: LibretaFactV1[];
  /** The handwritten note an asiento carries, rendered full-width. */
  note: string | null;
  provenance: LibretaProvenanceV1;
  /**
   * The amber line under an asiento that is waiting on something — a
   * self-declared dose with no professional signature, or one that names a vet
   * who has not confirmed it yet. `null` when nothing is pending.
   */
  warning: string | null;
  /**
   * When a LATER amendment corrected this record. The values above are ALREADY
   * the corrected ones; this is the marker that says so, and it is what a
   * client renders as "Corregido el …". Never null-as-in-unknown: null means
   * this record was never corrected.
   */
  amendedAt: string | null;
  /**
   * Whether this record carries a file. NOT a URL — see the header. A client
   * that wants the file opens the event detail, which mints one with an expiry.
   */
  hasAttachment: boolean;
  /**
   * Whether THIS viewer may correct THIS record: the amendable-type allowlist
   * AND the viewer's own capability AND the record's authorship (PO decision
   * 3B: an owner corrects only what they wrote, never what a professional
   * signed), resolved server-side and folded into one boolean so a client
   * cannot get the conjunction subtly wrong. The authorship half reads the
   * row's own author only; the event detail's `amend` also reads the
   * correction chain and is the exact answer.
   */
  canAmend: boolean;
};

export type LibretaTimelineSection = {
  /** Descending by `occurredAt` — newest asiento first, as the web renders it. */
  entries: LibretaEntryV1[];
  /** How many entries this read returned. */
  total: number;
  /**
   * True when older asientos exist beyond `PET_LIBRETA_TIMELINE_WINDOW`.
   * DERIVED by the server against the probe row, never assumed: a client must
   * not have to know the cap to tell a complete ledger from a capped one.
   */
  truncated: boolean;
};

// ---------------------------------------------------------------------------
// The viewer
// ---------------------------------------------------------------------------

/**
 * Who is reading, and what this face lets them do.
 *
 * `canAmend` mirrors the WEB PAGE'S AFFORDANCE, which is narrower than the
 * server action's own guard, and the difference is stated rather than smoothed
 * over: `amendEventAction` admits any current holder plus an org member who
 * holds `event.write`, while the event detail page only ever renders the
 * "Corregir registro" button for the person path (`accessPath === "owner"`).
 * This flag is the affordance, not the gate — the endpoint enforces the full
 * server rule, and a client that hides the button on `false` behaves exactly
 * like the web.
 *
 * It also clamps on a DECEASED animal, which the web's button does not: the
 * server refuses every new event on a deceased pet, so a button that is always
 * refused is a control that cannot do anything, which is a lie with the shape
 * of a control.
 */
export type LibretaViewer = {
  role: OwnerPetDetailViewerRole;
  isTitular: boolean;
  canAmend: boolean;
};

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/**
 * `GET /api/v1/pets/{publicToken}/libreta` — HTTP 200.
 *
 * Every section is wrapped in `CredentialSection`: `unavailable` means the
 * server could not load it, NOT that it is empty. An empty ledger is
 * `{status:"ok", data:{entries:[], total:0, truncated:false}}` and a client
 * prints "sin asientos", which is a fact about the animal. `unavailable` prints
 * "no pudimos leer esto", which is a fact about the read. A nullable field
 * cannot tell a client which sentence to use.
 *
 * The envelope fields are TOP LEVEL per the read rules — version and freshness
 * must be checkable without descending into a section that may itself be
 * unavailable.
 */
export type PetLibretaV1 = {
  payloadVersion: typeof PET_LIBRETA_PAYLOAD_VERSION;
  issuedAt: string;
  staleAfter: string;
  publicToken: string;
  viewer: LibretaViewer;
  identity: CredentialSection<LibretaIdentitySection>;
  vaccination: CredentialSection<LibretaVaccinationSection>;
  upcoming: CredentialSection<LibretaUpcomingSection>;
  timeline: CredentialSection<LibretaTimelineSection>;
};
