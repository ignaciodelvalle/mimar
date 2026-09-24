// `GET /api/v1/pets/{publicToken}/shares` — the owner's COMPARTIR cockpit.
//
// THE FIFTH FACE. `/pets/{token}` is the owner's chrome, `/credential` is the
// public front, `/libreta` is the ledger, `/lost` is the search — and this is
// the one that answers "who else can see any of it right now". The web answers
// it in a single sheet (`MergedShareSheet`, `?sheet=compartir`, design ADR-7)
// that fuses the revocable share links with the Tier-2 public window; this is
// that sheet, as one read.
//
// THIS PAYLOAD CARRIES CREDENTIALS AND THEREFORE HAS RULES THE OTHERS DO NOT
// ---------------------------------------------------------------------------
// `LibretaShareV1.shareToken` is a BEARER SECRET. Whoever holds the string can
// read the animal's medical record until the link expires or is revoked, with no
// account and no further check — that is the entire point of the feature, and it
// is also the reason this payload is in a different privacy class from every
// sibling on this surface.
//
// The rule is the one `pet-event-detail.ts` already states for its signed
// attachment URLs, and it is repeated rather than referenced because a reader
// holding THIS file is the one who needs it:
//
//   DO NOT PERSIST THIS PAYLOAD. Not to a disk cache, not to a log line, not
//   into a crash report, not into an error message echoed back to a user. It
//   belongs in a screen's state and it dies with the screen.
//
// `apps/mobile` already draws exactly this line between its own two caches —
// `credential-cache.ts` stores the PUBLIC credential offline because a public
// page is public, and `LibretaScreen` deliberately caches nothing because the
// libreta is "a different privacy class". A share token is that class again,
// with a bearer secret on top.
//
// WHAT THIS DELIBERATELY DOES NOT CARRY
// ---------------------------------------------------------------------------
//   · THE SHARE URL, as a string. Only `shareToken`, from which a client builds
//     the url with `deepLinkUrl(origin, "libretaShare", { shareToken })` — the
//     same table the web builds its own link from. The ORIGIN is the client's,
//     because only the client knows which backend this build points at
//     (`apps/mobile/src/config/api.ts` says so at length about the QR). A server
//     that baked an origin into the payload would be guessing.
//   · REVOKED AND EXPIRED LINKS. The web's list is `getActiveLibretaShares`,
//     which filters `revoked_at IS NULL` and nothing else. Revoked rows are not
//     shown to anybody and this mirrors that; expired-but-unrevoked rows ARE
//     still listed, exactly as on the web, because an owner looking at a link
//     that stopped working yesterday needs to see that it stopped working.
//   · THE VIEWER LOG. Since migration 0167 there isn't one — `share_telemetry`
//     was dropped after a sweep found one writer and zero readers. The counters
//     below are all that ever existed.
//   · WHAT THE SHARED LIBRETA ACTUALLY SHOWS. That is `/libreta/compartir/
//     {shareToken}`, a public page. A payload that previewed it would be a
//     second implementation of that page's own filter.

import type { ShareCommand, Tier2Window } from "../input/share.ts";

export const PET_SHARES_PAYLOAD_VERSION = 1;

/**
 * ONE MINUTE — the same window `pet-lost.ts` takes, and for a related reason.
 *
 * It is NOT a licence to store the payload; see the header. It bounds how long a
 * client may keep presenting an ALREADY-RENDERED list as current before it must
 * re-ask, and one minute is short because the facts on this screen are exactly
 * the ones a person changes and then immediately wants to see changed: they
 * revoke a link because they no longer trust who holds it. A five-minute window
 * on that is five minutes of a screen saying a revoked link is still live.
 */
export const PET_SHARES_STALE_AFTER_MS = 60_000;

/**
 * One active libreta share link.
 *
 * EVERY ACTIVE LINK ON THE ANIMAL IS LISTED, not just the caller's own. That is
 * the web's list verbatim — `getActiveLibretaShares(petId)` filters on the pet
 * and on `revoked_at IS NULL`, with no creator predicate — and it means a
 * co-owner sees, and can copy, a link the other owner minted. Narrowing it here
 * would hide from a co-owner the existence of an exposure they are equally
 * responsible for, which is the wrong direction to be quiet in.
 */
export type LibretaShareV1 = {
  /**
   * The ROW id, which is what `revoke_libreta_share` takes.
   *
   * Not the token. See the note on the revoke command in `input/share.ts` for
   * why the credential must not be the handle for the operation that kills it.
   */
  id: string;
  /**
   * THE CREDENTIAL. A bearer secret over this animal's medical record — read
   * the header before doing anything with it, including logging it.
   */
  shareToken: string;
  /** The owner's own note about who this link is for. May be absent. */
  label: string | null;
  createdAt: string;
  /** When it stops resolving. `null` is "sin vencimiento" — it never does. */
  expiresAt: string | null;
  /**
   * Whether `expiresAt` is already in the past, decided by the SERVER'S clock.
   *
   * Carried rather than left to the client because a phone's clock can be wrong
   * by days, and the one thing worse than a screen that says a dead link is live
   * is a screen that says a live link is dead — an owner would mint a
   * replacement and leave the real one running.
   */
  expired: boolean;
  /**
   * Whether THIS caller may revoke THIS link.
   *
   * The one per-row capability, and it exists because revocation is
   * creator-or-admin (`revoke-libreta-share.ts:35`) while the LIST is every
   * current holder on the person path. A co-owner therefore sees links they
   * cannot revoke, and the web's own control offers the button anyway and
   * surfaces the refusal as an error message after the fact
   * (`SharesManager.tsx:306`). This flag lets a client say so BEFORE the tap
   * instead of after it. It is an affordance hint and NOT the rule — the rule is
   * in the writer, and a client that ignored this flag would still be refused.
   */
  canRevoke: boolean;
  /** How many times the link has been opened. Zero is the common case. */
  viewCount: number;
  /** When it was last opened, or `null` if it never has been. */
  lastViewedAt: string | null;
};

/**
 * The Tier-2 public window — medical detail on the animal's OWN public
 * credential, for anybody who scans the QR.
 *
 * A DIFFERENT MECHANISM FROM A SHARE LINK, and worth keeping distinct in a
 * client's head: a share link is a secret URL handed to one person, and this is
 * the public page temporarily showing more. Revoking one does nothing to the
 * other.
 */
export type Tier2StateV1 = {
  /**
   * Whether the window is open RIGHT NOW, by the server's clock.
   *
   * The web computes `tier2PublicPermanent || (activeUntil && activeUntil > now)`
   * (`SheetMounter.tsx:356`). Computed here for the same reason `expired` is: a
   * client comparing a timestamp against a wrong device clock would tell an
   * owner their animal's medical record is private when it is not.
   */
  isActive: boolean;
  /** `true` when the window is the permanent "siempre" one and has no expiry. */
  isPermanent: boolean;
  /**
   * When the bounded window closes. `null` when inactive AND when permanent —
   * the web nulls it in both cases (`SheetMounter.tsx:373`) so a client cannot
   * render "vence el ..." next to a window that never does.
   */
  activeUntil: string | null;
};

/**
 * WHAT THIS CALLER MAY DO, decided by the server.
 *
 * The four commands do NOT share one guard — three are `requireTitularAccess`
 * and revocation is creator-or-admin — so a client that derived these from
 * "am I the owner" would get the interesting one wrong. See `input/share.ts`.
 */
export type ShareCapabilitiesV1 = {
  /**
   * Titular-only, and additionally false when the animal already holds the
   * maximum number of active links. A client should say WHICH of the two it is;
   * `remainingShareSlots` is how it tells them apart.
   */
  canCreateLibretaShare: boolean;
  /**
   * Slots left before `MAX_ACTIVE_LIBRETA_SHARES` is reached. `0` with
   * `canCreateLibretaShare: false` is "revoke one first"; a positive number with
   * the same flag false is "you are not the titular".
   */
  remainingShareSlots: number;
  /**
   * Titular-only, and false for a DECEASED animal — `enableTier2Public` refuses
   * one outright (`enable-tier2-public.ts:23`), because the public credential of
   * a deceased animal is the in-memoriam page and medical detail has no purpose
   * there.
   */
  canEnableTier2: boolean;
  /**
   * Titular-only. NOT gated on the window being open: the web's revoke is
   * unconditional and idempotent — it clears both columns whatever they held —
   * and a client may safely offer it as a "make sure this is off" control.
   */
  canRevokeTier2: boolean;
};

export type PetSharesV1 = {
  payloadVersion: typeof PET_SHARES_PAYLOAD_VERSION;
  issuedAt: string;
  staleAfter: string;
  publicToken: string;
  petName: string;
  /**
   * Active links, newest first.
   *
   * EMPTY FOR AN ORG-PATH CALLER, and that is not the same as "this animal has
   * no links". `getActiveLibretaSharesAction` returns `shares: []` for any
   * caller whose `accessPath !== "owner"` (`libreta-share.ts:152`) rather than
   * refusing, so a shelter with custody sees an empty list. Mirrored exactly —
   * `capabilities` is where a client learns it is not being shown everything.
   */
  libretaShares: LibretaShareV1[];
  tier2: Tier2StateV1;
  capabilities: ShareCapabilitiesV1;
};

/**
 * What `POST /api/v1/pets/{publicToken}/shares` answers.
 *
 * A BARE PAYLOAD, no envelope — the same split every write on this surface
 * makes. A version and a staleness window describe a READ a device may present
 * as current; an acknowledgement of something that just happened has neither.
 *
 * IT IS DELIBERATELY NOT THE NEW STATE, for the reason `LostCommandAckV1` gives:
 * a client re-reads `GET .../shares` afterwards, because that read is the one
 * place the list, the window and the capability flags are computed together.
 *
 * THE ONE EXCEPTION IS `shareToken`, AND IT IS AN EXCEPTION ON PURPOSE. A newly
 * minted link is the single fact a client cannot get any other way at the moment
 * it needs it — the person is standing in front of the vet with the phone out —
 * and the web returns exactly this from `createLibretaShareAction`. It is
 * present ONLY for `create_libreta_share` and `null` for the other three.
 */
export type ShareCommandAckV1 = {
  /**
   * The command that ran, echoed.
   *
   * A client that fired one command has no doubt about which; a client REPLAYING
   * a request after a timeout does, and so does a log. It costs one string.
   */
  command: ShareCommand;
  /**
   * Whether anything actually changed.
   *
   * `false` IS A SUCCESS, and it is the interesting one. All four commands are
   * idempotent on the state and three of them can no-op: minting a link with the
   * same label and an equivalent expiry returns the EXISTING token rather than
   * burning a slot (`create-libreta-share.ts:85-90`), re-opening a Tier-2 window
   * that already ends within a minute of the requested one writes nothing
   * (`enable-tier2-public.ts:54`), and asking for permanent exposure that is
   * already permanent returns early (`:36`). A client that reported "listo" on
   * every 200 would be telling the truth; one that can distinguish a fresh write
   * from a recognised replay can tell a better one.
   */
  changed: boolean;
  /**
   * The token of the link just minted — `create_libreta_share` only, `null`
   * otherwise. A BEARER SECRET; the header's rules apply to it here too.
   *
   * On a recognised duplicate submit this is the EXISTING link's token, not a
   * new one. That is the web's behaviour and it is the useful one: the person
   * gets a working link either way.
   */
  shareToken: string | null;
  /**
   * The window that was opened — `enable_tier2` only, `null` otherwise. Echoed
   * for the same reason `command` is.
   */
  tier2Window: Tier2Window | null;
};
