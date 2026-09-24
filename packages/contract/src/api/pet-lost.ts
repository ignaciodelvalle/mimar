// `GET /api/v1/pets/{publicToken}/lost` — the owner's LOST-MODE cockpit.
//
// THE FOURTH FACE, and the one that only exists some of the time. `/pets/{token}`
// is the owner's chrome, `/credential` is the public front, `/libreta` is the
// ledger — and none of the three answers the question a person asks at two in
// the morning: is the search still open, who has seen the animal, and what am I
// publishing about myself while it runs. The web answers it across a page
// (`/mis-mascotas/{token}/perdida`) and a block on the profile
// (`LostCaseBlock`); this is those two, as one read.
//
// IT IS ALSO THE READ THAT EXPLAINS THE WRITES. Every affordance the web renders
// conditionally — mark lost, update the last-seen point, mark found, reactivate a
// stale search, flip a disclosure toggle — depends on `pets.status`, on whether a
// `lost_pet_episode` case is open, and on WHO is asking. A client that recomputed
// those conditions would be re-deriving a product decision from three facts it
// holds by accident. They are computed here, once, and reported as booleans.
//
// WHAT THIS DELIBERATELY DOES NOT CARRY
// ---------------------------------------------------------------------------
//   · THE POSTER. `/mis-mascotas/{token}/cartel` is a React Server Component
//     that resolves the TITULAR's first name and phone with its OWN
//     `role = 'owner'` query — deliberately narrower than the guard on the page,
//     so a caretaker's phone can never print on a flyer — filters them through
//     the disclosure preferences, and embeds a QR generated server-side by the
//     `qrcode` package. There is no JSON for any of it. A native client that
//     rebuilt the poster would be re-implementing that privacy filter from
//     scratch, which is exactly the kind of second copy this package exists to
//     prevent. It needs an endpoint of its own before it can cross.
//   · SIGNED URLS for the photos a finder attached. Same rule as the libreta:
//     minting a URL is equivalent to handing out the file. `hasPhoto` reports
//     that one exists; fetching it is a different endpoint's job.
//   · THE PUBLIC CREDENTIAL'S OWN VIEW of this episode. What a stranger sees is
//     `/p/{token}`, and the disclosure preferences below are precisely the
//     filter between the two. This payload reports the SETTINGS, never the
//     resulting public page — a client that rendered "this is what finders see"
//     from these booleans would be a second implementation of that filter.

import type { DisclosureKey, LostCommand } from "../input/lost-mode.ts";

export const PET_LOST_PAYLOAD_VERSION = 1;

/**
 * ONE MINUTE, the shortest window on this surface.
 *
 * Every other read here is measured in five minutes or an hour, because an
 * animal's species and vaccination history do not change while a person looks
 * at them. A lost episode's feed does: a scan of the QR, a sighting from a
 * stranger, a finder saying they have the animal in their kitchen. A five-minute
 * staleness window on THAT is five minutes of an owner not being told.
 */
export const PET_LOST_STALE_AFTER_MS = 60_000;

/** The animal's own status. The spine's `pet_status` enum, unchanged. */
export type LostPetStatus = "active" | "lost" | "deceased";

/**
 * The open `lost_pet_episode`, when there is one.
 *
 * `null` DOES NOT MEAN "not lost". An episode is auto-closed by the stale-case
 * cron after inactivity while `pets.status` deliberately stays `lost` — an
 * automatic sweep must never declare an animal found. `status: "lost"` with
 * `episode: null` is exactly that state, and `canReactivateSearch` is how a
 * client offers the way out of it.
 */
export type LostEpisodeV1 = {
  /** Human-readable case code, e.g. `"LOS-00042"`. */
  publicCode: string;
  /** When the search opened. The web calls this "perdida desde". */
  openedAt: string;
  /**
   * Where the animal was last seen, in words.
   *
   * The ORIGINAL `status_changed` location, OVERLAID by the latest
   * owner-authored update that carried an address. The overlay is the reader's
   * and is applied atomically with the coordinates and the timestamp below —
   * never mixed across two events — so this triple always describes ONE report.
   */
  placeName: string | null;
  /** The owner's own note from the moment the episode opened. */
  ownerNote: string | null;
  /** When the location above was reported — not when the episode opened. */
  lastSeenAt: string;
  /**
   * The last-seen pin, as NUMBERS.
   *
   * The reader hands these back as Postgres numeric strings; a payload that
   * passed them through as strings would make every client parse them, and one
   * of them would forget.
   */
  lastSeenLat: number | null;
  lastSeenLng: number | null;
  jurisdictionLocality: string | null;
  /** Sightings logged since the episode opened. */
  sightingsCount: number;
};

/**
 * One row of the lost-mode feed — the unified stream the web's `LostScanFeed`
 * renders.
 *
 * THREE KINDS AND THEY ARE NOT INTERCHANGEABLE. A scan is the QR being read by
 * somebody, anywhere. A sighting is a person saying they SAW the animal. A
 * finder is a person saying they HAVE it — the one that ends the search, and the
 * reason the web sorts it to the top rather than letting it scroll away under
 * nine scans.
 *
 * TWO OF THE THREE HAVE AN AUTHOR AND THE THIRD DOES NOT, which is what decides
 * where a "Reportar" affordance may appear. A `sighting` and a `finder` are
 * WRITTEN BY AN ANONYMOUS MEMBER OF THE PUBLIC — somebody who scanned a QR in
 * the street and typed into a form — and carry no user id, because there is no
 * account behind them. That is exactly why `report_content` reports an ITEM and
 * why there is no "block this person": there is nobody to block. A `scan` is a
 * machine reading a code; it has no text and nobody wrote it, so a client must
 * not offer to report one and the server refuses if it tries.
 *
 * A REPORTED ITEM IS SIMPLY ABSENT FROM THIS LIST. Nothing here says "hidden"
 * and nothing carries a moderation state, because the row is not modified — a
 * `content_reported` event names it and every read subtracts the named ids. A
 * client therefore has nothing to render for it and nothing to reconcile: the
 * item was there, the person reported it, the next read does not contain it.
 */
export type LostFeedItemV1 =
  | {
      kind: "scan";
      id: string;
      at: string;
      /** Scans grouped into this row. A burst is one row, not twelve. */
      count: number;
      localityLabel: string | null;
    }
  | {
      kind: "sighting";
      id: string;
      at: string;
      description: string | null;
      localityLabel: string | null;
      lat: number | null;
      lng: number | null;
      /**
       * A phone or an email the reporter chose to leave FOR THE OWNER. Carried
       * because the web shows the owner exactly this; withholding it here would
       * make the app the one surface where a lead cannot be followed.
       */
      finderContact: string | null;
      /** A photo exists. The file itself is not on this payload — see the header. */
      hasPhoto: boolean;
    }
  | {
      kind: "finder";
      id: string;
      at: string;
      finderName: string;
      finderContact: string | null;
      /** `bien` | `herida` | `asustada` | `necesita_vet_urgente`, as reported. */
      petCondition: string | null;
      localityLabel: string | null;
      message: string | null;
      /** How long they can keep the animal: a date label, or "indefinido". */
      availabilityLabel: string | null;
      hasPhoto: boolean;
    };

export type LostFeedSectionV1 = {
  items: LostFeedItemV1[];
  /** The list is capped. `true` means older rows exist and are not here. */
  truncated: boolean;
  totalScans: number;
  totalSightings: number;
};

/**
 * What the PUBLIC credential is allowed to show while this animal is lost.
 *
 * SETTINGS, NOT THE RESULT. Each flag gates one field on `/p/{token}` — the
 * owner's first name, their phone, their email, the last-known point, whether
 * the finder-in-possession form is offered at all, and the caretaker's own
 * contact. A separate rule the client cannot see also suppresses all of it when
 * the animal is in a custody dispute, which is why a client must never render
 * "this is what a finder sees" from these booleans.
 */
export type LostDisclosureV1 = {
  discloseFirstNameWhenLost: boolean;
  disclosePhoneWhenLost: boolean;
  discloseEmailWhenLost: boolean;
  discloseLastLocationWhenLost: boolean;
  allowFinderFormWhenLost: boolean;
  /** KEY 1 of the two-key caretaker-contact model. Titular-only to change. */
  discloseCaretakerContactWhenLost: boolean;
};

/**
 * WHAT THIS CALLER MAY DO, decided by the server.
 *
 * Every one of these is a condition the web evaluates across a page guard, a
 * status check and a case lookup. A client that recomputed them from `status`
 * and `episode` would get four of the five right and the fifth — reactivation,
 * which is refused on the ORG path even though the same guard admits an org
 * member everywhere else — silently wrong.
 */
export type LostCapabilitiesV1 = {
  canMarkLost: boolean;
  canReportLastSeen: boolean;
  canMarkFound: boolean;
  canReactivateSearch: boolean;
  /**
   * May this caller report a feed message (A4-custodia-13)?
   *
   * THE SECOND FLAG THE ORG PATH ALONE DECIDES, and it is refused for the same
   * reason `canReactivateSearch` is — the route's guard refuses `report_content`
   * and `reactivate_search` together, in one condition, because both are levers
   * an organization holding `shelter_custody` could point at the owner during a
   * custody dispute: a report makes a finder's "tengo a tu perro, llamame"
   * disappear from the OWNER's feed, silently and with no un-report.
   *
   * A CLIENT CANNOT DERIVE IT. Nothing in `status`, `episode` or the feed row
   * says which path the caller came through, so `feedItemReportable` — which is
   * the ROW's half of the answer (a `scan` has no author and nothing to report)
   * — was the app's whole test, and the control was drawn for an org reader the
   * server then refused with titular-only copy.
   *
   * ITS TWIN IS ROW-SHAPED AND STAYS IN THE CLIENT. Whether THIS row can be
   * reported is the kind and nothing else; whether THIS CALLER may report is
   * here. Two different questions, and only one of them needs the server.
   */
  canReportContent: boolean;
  /**
   * The preference keys this caller may flip. A caretaker gets five of the six;
   * the titular gets all six. Rendering a toggle outside this list is offering a
   * control that answers 403.
   */
  editableDisclosureKeys: DisclosureKey[];
};

export type PetLostV1 = {
  payloadVersion: typeof PET_LOST_PAYLOAD_VERSION;
  issuedAt: string;
  staleAfter: string;
  publicToken: string;
  petName: string;
  /**
   * `male` | `female` | `null`, carried for ONE reason: "perdido" and "perdida"
   * are different words, and es-AR copy that says "perdido/a" on every screen
   * reads like a form rather than like somebody talking about your dog. The web
   * makes the same call in `lostLabel`.
   */
  petSex: string | null;
  status: LostPetStatus;
  episode: LostEpisodeV1 | null;
  disclosure: LostDisclosureV1;
  capabilities: LostCapabilitiesV1;
  feed: LostFeedSectionV1;
};

/**
 * What `POST /api/v1/pets/{publicToken}/lost` answers.
 *
 * A BARE PAYLOAD, no envelope — the same split every write on this surface
 * makes. A version and a staleness window describe a READ a device may cache;
 * an acknowledgement of something that just happened has neither.
 *
 * IT IS DELIBERATELY NOT THE NEW STATE. A client re-reads
 * `GET .../lost` after a command, because that read is the one place the
 * episode, the feed, the preferences and the capability flags are computed
 * together — and a write that returned half of them would be a second,
 * thinner source for the same four facts, drifting the first time one of them
 * grew a field.
 */
export type LostCommandAckV1 = {
  /**
   * The command that ran, echoed.
   *
   * A client that fired one command has no doubt about which; a client
   * REPLAYING a request after a timeout does, and so does a log. It costs one
   * string.
   */
  command: LostCommand;
  /** The animal's status AFTER the command. */
  status: LostPetStatus;
  /**
   * DID THIS CALL CHANGE ANYTHING?
   *
   * `false` means the state was already what the caller asked for, and the two
   * mechanisms behind that are worth naming because they are not the same:
   *
   *   · The THREE state commands read it from their own writers, which all knew
   *     and used to drop it at the boundary — `setPetFound` answers
   *     `alreadyActive`, `reactivateLostSearch` answers `alreadyOpen`, and the
   *     disclosure writer no-ops when the value already matches.
   *   · `report_last_seen` reads it from `insertEventIdempotent`'s `wasNoop`:
   *     the append resolved to the event a previous attempt with the SAME
   *     `Idempotency-Key` had already written.
   *
   * `mark_lost` is the one that never answers `false` — it REFUSES an animal
   * already lost rather than succeeding quietly, because a person who pressed
   * that button believes they just started something.
   *
   * A client should use it for its words, not for its control flow: "listo" and
   * "ya estaba así" are different sentences, and telling somebody they just did
   * something they did not is how an interface teaches people to distrust it.
   */
  changed: boolean;
};
