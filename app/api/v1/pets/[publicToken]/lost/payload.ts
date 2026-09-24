// The projection from the lost-mode reads onto their wire shape.
//
// It lives beside the route for the reason the libreta's `payload.ts` gives: the
// readers answer "what is happening with this search", and this answers "what
// may a client hold, and in what form". The web page consumes the same readers
// and none of this, which is the proof they are separable.
//
// WHAT THIS DELIBERATELY DROPS, and why each one is a decision:
//
//   · `photoUrl` — the signed URL for a photo a finder attached. `readLostData`
//     mints one per row for the web page; this endpoint calls the two underlying
//     readers directly and never signs, because minting a URL is equivalent to
//     handing out the file and a 200-row feed would hand out 200. `hasPhoto`
//     reports that one exists.
//   · `photoStoragePath` — the private storage key itself. A client holds no
//     credential that could use it, and a payload carrying it would leak the
//     shape of the bucket for nothing.
//   · The relative-time strings the web computes for display. Instants go on the
//     wire; how long ago that was is arithmetic that belongs where the clock is.
//
// COORDINATES BECOME NUMBERS HERE. Drizzle returns `numeric` as a string and
// every reader in this repo passes them through that way. A wire that did the
// same would make every client parse them, and one of them would forget.

import type { ScanFeedItem } from "@/components/pet-profile/LostScanFeed";
import { apiV1Envelope } from "@/lib/infra/api-v1";
import type { LostEpisode } from "@/lib/infra/lost-mode";
import { LOST_SCAN_FEED_CAP } from "@/lib/infra/lost-mode";
import type {
  LostCapabilitiesV1,
  LostDisclosureV1,
  LostEpisodeV1,
  LostFeedItemV1,
  LostFeedSectionV1,
  LostPetStatus,
  PetLostV1,
} from "@dim/contract/api";
import { PET_LOST_PAYLOAD_VERSION, PET_LOST_STALE_AFTER_MS } from "@dim/contract/api";
import { DISCLOSURE_KEYS, TITULAR_ONLY_DISCLOSURE_KEYS } from "@dim/contract/input";

/** The `pets` columns this projection reads. */
export type LostPetRow = {
  publicToken: string;
  name: string;
  sex: string | null;
  status: string;
  discloseFirstNameWhenLost: boolean;
  disclosePhoneWhenLost: boolean;
  discloseEmailWhenLost: boolean;
  discloseLastLocationWhenLost: boolean;
  allowFinderFormWhenLost: boolean;
  discloseCaretakerContactWhenLost: boolean;
};

export type BuildPetLostInput = {
  pet: LostPetRow;
  episode: LostEpisode | null;
  scans: ScanFeedItem[];
  /** `"owner"` on the person path, `"org"` on the org-mediated one. */
  accessPath: "owner" | "org";
  /** The person-path ownership role, or `null` on the org path. */
  holderRole: string | null;
  now: Date;
};

/** `"12.34"` → `12.34`, and anything unparseable → `null`. */
function toNumber(value: string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toEpisode(episode: LostEpisode): LostEpisodeV1 {
  return {
    publicCode: episode.publicCode,
    openedAt: episode.openedAt.toISOString(),
    placeName: episode.placeName,
    ownerNote: episode.ownerNote,
    lastSeenAt: episode.lastSeenAt.toISOString(),
    lastSeenLat: toNumber(episode.lastSeenLat),
    lastSeenLng: toNumber(episode.lastSeenLng),
    jurisdictionLocality: episode.jurisdictionLocality,
    sightingsCount: episode.sightingsCount,
  };
}

/**
 * One feed row, with the file dropped and its PRESENCE kept.
 *
 * The exhaustive switch is the point: `ScanFeedItem` is a union of three, and a
 * fourth added to the reader would stop this compiling rather than silently fall
 * out of the payload.
 */
function toFeedItem(item: ScanFeedItem): LostFeedItemV1 {
  switch (item.kind) {
    case "scan":
      return {
        kind: "scan",
        id: item.id,
        at: item.at.toISOString(),
        count: item.count,
        localityLabel: item.localityLabel,
      };
    case "finder":
      return {
        kind: "finder",
        id: item.id,
        at: item.at.toISOString(),
        finderName: item.finderName,
        finderContact: item.finderContact,
        petCondition: item.petCondition,
        localityLabel: item.localityLabel,
        message: item.message,
        availabilityLabel: item.availabilityLabel,
        hasPhoto: Boolean(item.photoStoragePath),
      };
    case "sighting":
      return {
        kind: "sighting",
        id: item.id,
        at: item.at.toISOString(),
        description: item.description,
        localityLabel: item.localityLabel,
        lat: toNumber(item.lat),
        lng: toNumber(item.lng),
        finderContact: item.finderContact ?? null,
        hasPhoto: Boolean(item.photoStoragePath),
      };
  }
}

function toFeed(scans: ScanFeedItem[], episode: LostEpisode | null): LostFeedSectionV1 {
  return {
    items: scans.map(toFeedItem),
    // The reader caps at `LOST_SCAN_FEED_CAP` and its own docblock says callers
    // must surface the truncation. A list that shows some of what exists and
    // does not say so is the same dishonesty as an empty state over a failed
    // read.
    truncated: scans.length >= LOST_SCAN_FEED_CAP,
    // ROWS, not the summed burst counts — the same figure the web's own
    // `scanCount` computes, so the two surfaces cannot report different numbers
    // for one episode.
    totalScans: scans.filter((s) => s.kind === "scan").length,
    totalSightings: episode?.sightingsCount ?? 0,
  };
}

function toDisclosure(pet: LostPetRow): LostDisclosureV1 {
  return {
    discloseFirstNameWhenLost: pet.discloseFirstNameWhenLost,
    disclosePhoneWhenLost: pet.disclosePhoneWhenLost,
    discloseEmailWhenLost: pet.discloseEmailWhenLost,
    discloseLastLocationWhenLost: pet.discloseLastLocationWhenLost,
    allowFinderFormWhenLost: pet.allowFinderFormWhenLost,
    discloseCaretakerContactWhenLost: pet.discloseCaretakerContactWhenLost,
  };
}

/**
 * WHAT THIS CALLER MAY DO — the five conditions the web evaluates across a page
 * guard, a status check and a case lookup, decided once.
 *
 * The one a client would get wrong on its own is `canReactivateSearch`: it is
 * refused on the ORG path even though the same `requirePetAccess` admits an org
 * member everywhere else on this surface, and nothing in `status` or `episode`
 * hints at that.
 */
function toCapabilities(input: BuildPetLostInput): LostCapabilitiesV1 {
  const { pet, episode, accessPath, holderRole } = input;
  const deceased = pet.status === "deceased";
  const lost = pet.status === "lost";
  const isCaretaker = accessPath === "owner" && holderRole === "caretaker";

  return {
    canMarkLost: !deceased && !lost,
    // An open episode is required, and a stale `lost` with none is exactly the
    // state `canReactivateSearch` answers instead.
    canReportLastSeen: lost && episode !== null,
    canMarkFound: !deceased && lost,
    canReactivateSearch: lost && episode === null && accessPath === "owner",
    // A4-custodia-13. `commands.ts` refuses `report_content` and
    // `reactivate_search` in ONE condition — `access.kind === "org"` — so the
    // two flags carry the same access clause here, and a change to that guard
    // that touched only one of them would leave this file visibly asymmetric.
    // No status clause: reporting a message is about the FEED, which an org
    // reader can see whether or not the animal is currently lost.
    canReportContent: accessPath === "owner",
    // A caretaker gets five of the six. The list is an AFFORDANCE hint — the
    // rule is the server's guard, and a client that ignored this would be
    // refused with `lost_forbidden` rather than obeyed.
    editableDisclosureKeys: DISCLOSURE_KEYS.filter(
      (key) => !(isCaretaker && (TITULAR_ONLY_DISCLOSURE_KEYS as readonly string[]).includes(key)),
    ),
  };
}

export function buildPetLostV1(input: BuildPetLostInput): PetLostV1 {
  const { pet, episode, scans, now } = input;

  return {
    ...apiV1Envelope({
      payloadVersion: PET_LOST_PAYLOAD_VERSION,
      issuedAt: now,
      staleAfterMs: PET_LOST_STALE_AFTER_MS,
    }),
    publicToken: pet.publicToken,
    petName: pet.name,
    petSex: pet.sex,
    status: pet.status as LostPetStatus,
    episode: episode ? toEpisode(episode) : null,
    disclosure: toDisclosure(pet),
    capabilities: toCapabilities(input),
    feed: toFeed(scans, episode),
  };
}
